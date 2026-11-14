'use strict';
/*
 * Tab Relay MV3 service worker.
 *  - pushes the full tab state on tab/window events (debounced) and every PUSH_MS
 *  - polls the command queue every POLL_MS, executes open/close/capture commands and acks them
 *    (capture = chrome.pageCapture.saveAsMHTML, uploaded to the server as an offline copy)
 * A chrome.alarms tick (every 30 s) restarts the loop if Chrome has suspended the worker.
 */

const POLL_MS = 3000;
const PUSH_MS = 10000;
const DEBOUNCE_MS = 1000;
const FETCH_TIMEOUT_MS = 8000;
const UPLOAD_TIMEOUT_MS = 300000;
const ALARM = 'tab-relay-tick';

// ---------- config / identity ----------

async function getConfig() {
  const { config = {} } = await chrome.storage.local.get('config');
  return {
    serverUrl: (config.serverUrl || '').replace(/\/+$/, ''),
    token: config.token || '',
    machine: config.machine || '',
    profileLabel: config.profileLabel || '',
  };
}

// One shared promise per service-worker instance: concurrent callers (poll loop, debounced push,
// options "sync now") all get the same id. Without it, two callers on first run could both see
// "no id yet" and each generate one, creating duplicate clients on the server.
let clientIdPromise = null;
function getClientId() {
  if (!clientIdPromise) {
    clientIdPromise = (async () => {
      const { clientId } = await chrome.storage.local.get('clientId');
      if (clientId) return clientId;
      const id = crypto.randomUUID();
      await chrome.storage.local.set({ clientId: id });
      return id;
    })().catch((e) => {
      clientIdPromise = null;   // let the next call retry
      throw e;
    });
  }
  return clientIdPromise;
}

async function getProfile(cfg) {
  let email = '';
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    email = info?.email || '';
  } catch (e) { /* identity unavailable */ }
  return { email, label: cfg.profileLabel || '' };
}

async function setStatus(patch) {
  const { status = {} } = await chrome.storage.local.get('status');
  await chrome.storage.local.set({ status: { ...status, ...patch } });
}

// ---------- HTTP ----------

async function request(cfg, method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.serverUrl + path, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const configured = (cfg) => !!(cfg.serverUrl && cfg.token);

// ---------- state push ----------

async function collectState(cfg) {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal', 'popup'] });
  return {
    machine: cfg.machine || 'unnamed',
    profile: await getProfile(cfg),
    userAgent: navigator.userAgent,
    windows: wins.map((w) => ({
      id: w.id,
      focused: w.focused,
      incognito: w.incognito,
      type: w.type,
      tabs: (w.tabs || []).map((t) => ({
        id: t.id,
        index: t.index,
        url: t.url || t.pendingUrl || '',
        title: t.title || '',
        favIconUrl: t.favIconUrl || '',
        pinned: t.pinned,
        active: t.active,
      })),
    })),
  };
}

let lastPush = 0;
let pushing = null;
let pushAgain = false;

async function pushState() {
  if (pushing) {
    // A push is in flight with possibly stale data: queue one more after it.
    pushAgain = true;
    return pushing;
  }
  pushAgain = false;
  pushing = (async () => {
    const cfg = await getConfig();
    if (!configured(cfg)) return { ok: false, error: 'not configured' };
    try {
      const clientId = await getClientId();
      const r = await request(cfg, 'POST', `/api/clients/${encodeURIComponent(clientId)}/state`, await collectState(cfg));
      lastPush = Date.now();
      await setStatus({ lastPush, lastError: '', tabs: r.tabs });
      return { ok: true, tabs: r.tabs };
    } catch (e) {
      await setStatus({ lastError: `push: ${e.message}`, lastErrorAt: Date.now() });
      return { ok: false, error: e.message };
    }
  })();
  try {
    return await pushing;
  } finally {
    pushing = null;
    if (pushAgain) schedulePush();
  }
}

let debounceTimer = null;
function schedulePush() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(pushState, DEBOUNCE_MS);
}

// ---------- commands ----------

async function rememberDone(id) {
  const { doneCmds = [] } = await chrome.storage.session.get('doneCmds');
  doneCmds.push(id);
  await chrome.storage.session.set({ doneCmds: doneCmds.slice(-200) });
}
async function alreadyDone(id) {
  const { doneCmds = [] } = await chrome.storage.session.get('doneCmds');
  return doneCmds.includes(id);
}

async function targetWindow(newWindow) {
  if (!newWindow) {
    try {
      const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (w && !w.incognito) return { windowId: w.id };
    } catch (e) { /* no window */ }
  }
  return null;
}

async function openGroup(items, newWindow, errors) {
  let opened = 0;
  let win = await targetWindow(newWindow);
  for (const it of items) {
    try {
      if (!win) {
        const w = await chrome.windows.create({ url: it.url, focused: true });
        win = { windowId: w.id };
        if (it.pinned && w.tabs?.[0]) await chrome.tabs.update(w.tabs[0].id, { pinned: true });
      } else {
        await chrome.tabs.create({ windowId: win.windowId, url: it.url, pinned: !!it.pinned, active: false });
      }
      opened++;
    } catch (e) {
      errors.push({ url: it.url, error: e.message });
    }
  }
  if (win && !newWindow) chrome.windows.update(win.windowId, { focused: true }).catch(() => {});
  return opened;
}

// payload: {tabs:[{url,pinned}], newWindow, windows?: [[{url,pinned}], ...]}
// `windows` (only with newWindow) keeps the source window layout: one new window per group.
async function execOpen(payload) {
  const errors = [];
  const groups = payload.newWindow && Array.isArray(payload.windows) && payload.windows.length
    ? payload.windows : [payload.tabs || []];
  let opened = 0;
  for (const g of groups) opened += await openGroup(g, !!payload.newWindow, errors);
  return { ok: errors.length === 0, result: { opened, errors } };
}

// Keep the service worker alive during long operations (uploads); extension API calls reset its idle timer.
async function withKeepAlive(fn) {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try { return await fn(); } finally { clearInterval(t); }
}

// Discarded / not-yet-loaded tabs can't be captured: reload and wait for them to finish loading.
async function ensureLoaded(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.discarded && tab.status !== 'unloaded') return tab;
  await new Promise((resolve) => {
    const timer = setTimeout(done, 30000);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(id, info) { if (id === tabId && info.status === 'complete') done(); }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId).catch(done);
  });
  return chrome.tabs.get(tabId);
}

function saveAsMHTML(tabId) {
  return new Promise((resolve, reject) => {
    chrome.pageCapture.saveAsMHTML({ tabId }, (blob) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!blob) reject(new Error('capture returned nothing'));
      else resolve(blob);
    });
  });
}

async function uploadCapture(cfg, clientId, cmdId, tab, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const q = new URLSearchParams({ tabId: tab.id, commandId: cmdId });
    const res = await fetch(`${cfg.serverUrl}/api/clients/${encodeURIComponent(clientId)}/offline?${q}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'multipart/related',
        'x-tab-url': encodeURIComponent((tab.url || '').slice(0, 4000)),
        'x-tab-title': encodeURIComponent((tab.title || '').slice(0, 500)),
      },
      body,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// payload: {tabIds:[...], archiveMap?}. Captures each tab as MHTML and uploads it.
async function execCapture(cmd, cfg, clientId) {
  const saved = [];
  const errors = [];
  await withKeepAlive(async () => {
    for (const tabId of cmd.payload.tabIds || []) {
      try {
        const tab = await ensureLoaded(tabId);
        let r;
        for (let attempt = 1; ; attempt++) {   // retry transient capture/network errors
          try {
            // The capture Blob is backed by a temporary file that can disappear before fetch streams
            // it ("Failed to fetch"), so copy it into memory right away.
            const data = await (await saveAsMHTML(tabId)).arrayBuffer();
            r = await uploadCapture(cfg, clientId, cmd.id, tab, data);
            break;
          } catch (e) {
            if (attempt >= 3 || /^HTTP 4/.test(e.message)) throw e;
            await new Promise((res) => setTimeout(res, attempt * 1500));
          }
        }
        saved.push({ tabId, id: r.id, size: r.size });
      } catch (e) {
        errors.push({ tabId, error: e.message });
      }
    }
  });
  return { ok: errors.length === 0, result: { saved, errors } };
}

async function execClose(payload) {
  const ids = [];
  const missing = [];
  for (const id of payload.tabIds || []) {
    try { await chrome.tabs.get(id); ids.push(id); } catch (e) { missing.push(id); }
  }
  if (ids.length) await chrome.tabs.remove(ids);
  return { ok: true, result: { closed: ids.length, missing } };
}

let polling = false;
async function pollCommands() {
  if (polling) return;
  polling = true;
  try {
    const cfg = await getConfig();
    if (!configured(cfg)) return;
    const clientId = await getClientId();
    let data;
    try {
      data = await request(cfg, 'GET', `/api/clients/${encodeURIComponent(clientId)}/commands`);
    } catch (e) {
      await setStatus({ lastError: `poll: ${e.message}`, lastErrorAt: Date.now() });
      return;
    }
    let changed = false;
    for (const cmd of data.commands || []) {
      let outcome;
      if (await alreadyDone(cmd.id)) {
        outcome = { ok: true, result: { duplicate: true } };   // ack got lost last time; don't re-run
      } else {
        try {
          if (cmd.type === 'open') outcome = await execOpen(cmd.payload);
          else if (cmd.type === 'close') outcome = await execClose(cmd.payload);
          else if (cmd.type === 'capture') outcome = await execCapture(cmd, cfg, clientId);
          else outcome = { ok: false, result: `unknown command type ${cmd.type}` };
        } catch (e) {
          outcome = { ok: false, result: e.message };
        }
        await rememberDone(cmd.id);
        changed = true;
      }
      try {
        await request(cfg, 'POST', `/api/commands/${cmd.id}/ack`,
          outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.result });
      } catch (e) {
        await setStatus({ lastError: `ack: ${e.message}`, lastErrorAt: Date.now() });
      }
    }
    if (changed) schedulePush();
  } finally {
    polling = false;
  }
}

// ---------- main loop ----------

let loopTimer = null;
let loopStarted = false;
async function tick() {
  clearTimeout(loopTimer);
  try {
    await pollCommands();
    if (Date.now() - lastPush >= PUSH_MS) await pushState();
  } finally {
    loopTimer = setTimeout(tick, POLL_MS);
  }
}
function ensureLoop() {
  // Set synchronously: loopTimer is only assigned after the first tick's awaits, so checking it
  // would let onInstalled/onStartup/alarm/top-level calls start several loops at once.
  if (loopStarted) return;
  loopStarted = true;
  tick();
}

async function setup() {
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  ensureLoop();
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await setup();
  const cfg = await getConfig();
  if (details.reason === 'install' && !configured(cfg)) chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(setup);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) ensureLoop(); });

for (const ev of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onMoved, chrome.tabs.onActivated,
  chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.tabs.onReplaced,
  chrome.windows.onCreated, chrome.windows.onRemoved]) {
  ev.addListener(() => { schedulePush(); ensureLoop(); });
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if ('url' in info || 'title' in info || 'favIconUrl' in info || 'pinned' in info || info.status === 'complete') schedulePush();
  ensureLoop();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.config) { lastPush = 0; schedulePush(); }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'sync-now') {
    pushState().then(sendResponse);
    pollCommands();
    return true;
  }
  return false;
});

// Toolbar button opens the web UI (token passed in the URL fragment, never sent to the server as a URL).
chrome.action.onClicked.addListener(async () => {
  const cfg = await getConfig();
  if (!configured(cfg)) return chrome.runtime.openOptionsPage();
  chrome.tabs.create({ url: `${cfg.serverUrl}/#token=${encodeURIComponent(cfg.token)}` });
});

ensureLoop();

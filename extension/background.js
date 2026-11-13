'use strict';
/*
 * Tab Relay MV3 service worker.
 *  - pushes the full tab state on tab/window events (debounced) and every PUSH_MS
 *  - polls the command queue every POLL_MS, executes open/close commands and acks them
 * A chrome.alarms tick (every 30 s) restarts the loop if Chrome has suspended the worker.
 */

const POLL_MS = 3000;
const PUSH_MS = 10000;
const DEBOUNCE_MS = 1000;
const FETCH_TIMEOUT_MS = 8000;
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

async function getClientId() {
  const { clientId } = await chrome.storage.local.get('clientId');
  if (clientId) return clientId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ clientId: id });
  return id;
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

async function execOpen(payload) {
  const items = payload.tabs || [];
  const errors = [];
  let opened = 0;
  let win = await targetWindow(payload.newWindow);
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
  if (win && payload.newWindow === false) chrome.windows.update(win.windowId, { focused: true }).catch(() => {});
  return { ok: errors.length === 0, result: { opened, errors } };
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
  if (!loopTimer) tick();
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

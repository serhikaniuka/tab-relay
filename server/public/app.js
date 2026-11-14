'use strict';
/* Tab Relay web UI — vanilla JS, no build step. */

const $ = (sel) => document.querySelector(sel);
const REFRESH_MS = 4000;

const state = {
  token: new URLSearchParams(location.hash.slice(1)).get('token') || localStorage.getItem('tabRelayToken') || '',
  tree: null,
  archive: [],
  offline: { items: [], totalSize: 0 },
  snapshots: [],
  commands: [],
  // Two independent selections: live tabs ("clientId:tabId") and archive items (id as string).
  sel: { live: new Set(), archive: new Set() },
  collapsed: new Set(JSON.parse(localStorage.getItem('tabRelayCollapsed') || '[]')),
  openSnaps: new Set(),
  filter: '',
  dragging: false,
};

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function day(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function profileText(email, label) {
  const who = email || 'not signed in';
  return label && label !== email ? `${who} (${label})` : who;
}
function profileName(c) { return profileText(c.profile.email, c.profile.label); }
function clientName(c) { return `${c.machine} — ${profileName(c)}`; }
function clientById(id) { return state.tree?.clients.find((c) => c.id === id); }
function plural(n, w) { return `${n} ${w}${n === 1 ? '' : 's'}`; }
function flash(text, isError = false) {
  const d = el('div', { class: isError ? 'error' : '' }, text);
  $('#msg').append(d);
  setTimeout(() => d.remove(), isError ? 8000 : 4000);
}
const offlineUrl = (id, kind = 'view') => `/api/offline/${id}/${kind}?token=${encodeURIComponent(state.token)}`;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${state.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { showLogin('Invalid token.'); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- login ----------
function showLogin(err = '') {
  $('#login').hidden = false;
  $('#app').hidden = true;
  $('#login-error').textContent = err;
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.token = $('#token-input').value.trim();
  try {
    await api('GET', '/api/tree');
    localStorage.setItem('tabRelayToken', state.token);
    $('#login').hidden = true;
    $('#app').hidden = false;
    refresh();
  } catch (err) {
    if (err.message !== 'unauthorized') showLogin(err.message);
  }
});
$('#logout').addEventListener('click', () => {
  localStorage.removeItem('tabRelayToken');
  state.token = '';
  showLogin();
});

// ---------- data ----------
let refreshing = false;
async function refresh() {
  if (refreshing || !state.token || state.dragging) return;
  refreshing = true;
  try {
    const [tree, archive, offline, snaps, cmds] = await Promise.all([
      api('GET', '/api/tree'), api('GET', '/api/archive'), api('GET', '/api/offline'),
      api('GET', '/api/snapshots'), api('GET', '/api/commands?limit=15'),
    ]);
    if (state.dragging) return;   // don't rebuild the DOM under an active drag
    Object.assign(state, { tree, archive: archive.items, offline, snapshots: snaps.snapshots, commands: cmds.commands });
    $('#login').hidden = true;
    $('#app').hidden = false;
    pruneSelection();
    render();
    $('#status').textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    if (err.message !== 'unauthorized') $('#status').textContent = `error: ${err.message}`;
  } finally {
    refreshing = false;
  }
}

function pruneSelection() {
  const live = new Set();
  for (const c of state.tree?.clients || []) for (const w of c.windows) for (const t of w.tabs) live.add(`${c.id}:${t.id}`);
  for (const k of state.sel.live) if (!live.has(k)) state.sel.live.delete(k);
  const arch = new Set(state.archive.map((a) => String(a.id)));
  for (const k of state.sel.archive) if (!arch.has(k)) state.sel.archive.delete(k);
}
function refsFromKeys(keys) {
  return keys.map((k) => {
    const i = k.lastIndexOf(':');
    return { clientId: k.slice(0, i), tabId: Number(k.slice(i + 1)) };
  });
}
function matchesFilter(t) {
  if (!state.filter) return true;
  const f = state.filter.toLowerCase();
  return (t.title || '').toLowerCase().includes(f) || (t.url || '').toLowerCase().includes(f);
}
function offlineByUrl() {
  const m = new Map();
  for (const o of state.offline.items) if (!m.has(o.url)) m.set(o.url, o);   // newest first
  return m;
}

// ---------- actions (shared by toolbar, per-node buttons and drag & drop) ----------
const target = () => $('#target').value;
const targetLabel = (id = target()) => { const c = clientById(id); return c ? clientName(c) : '?'; };
const newWindow = () => $('#new-window').checked;

async function run(fn, okText, clear) {
  try {
    await fn();
    flash(okText);
    if (clear) clear.clear();
    await refresh();
  } catch (e) { flash(e.message, true); }
}

const act = {
  open(keys, to = target()) {
    if (!to) return flash('Choose a target first', true);
    return run(() => api('POST', '/api/actions/open', { tabs: refsFromKeys(keys), targetClientId: to, newWindow: newWindow() }),
      `Opening ${plural(keys.length, 'tab')} on ${targetLabel(to)}`, state.sel.live);
  },
  move(keys, to = target()) {
    if (!to) return flash('Choose a target first', true);
    return run(() => api('POST', '/api/actions/move', { tabs: refsFromKeys(keys), targetClientId: to, newWindow: newWindow() }),
      `Moving ${plural(keys.length, 'tab')} to ${targetLabel(to)} (sources close once they are open)`, state.sel.live);
  },
  archive(keys, offline = false) {
    return run(() => api('POST', '/api/actions/archive', { tabs: refsFromKeys(keys), offline }),
      `Archiving ${plural(keys.length, 'tab')}${offline ? ' (saving offline copies first)' : ''}`, state.sel.live);
  },
  offline(keys) {
    return run(() => api('POST', '/api/actions/offline', { tabs: refsFromKeys(keys) }),
      `Saving ${plural(keys.length, 'tab')} for offline reading`, state.sel.live);
  },
  del(keys) {
    if (!confirm(`Close and remove ${plural(keys.length, 'tab')}? They will NOT be archived.`)) return;
    return run(() => api('POST', '/api/actions/close', { tabs: refsFromKeys(keys) }),
      `Closing ${plural(keys.length, 'tab')}`, state.sel.live);
  },
  snapshot(keys) {
    const name = prompt('Snapshot name:', `Snapshot ${new Date().toLocaleString()}`);
    if (name === null) return;
    return run(() => api('POST', '/api/snapshots', { tabs: refsFromKeys(keys), name }),
      `Saved snapshot "${name}" (${plural(keys.length, 'tab')})`, state.sel.live);
  },
  restore(ids, to = target()) {
    if (!to) return flash('Choose a target first', true);
    return run(() => api('POST', '/api/archive/restore', { ids: ids.map(Number), targetClientId: to, newWindow: true }),
      `Restoring ${plural(ids.length, 'archived tab')} on ${targetLabel(to)}`, state.sel.archive);
  },
  purge(ids) {
    if (!confirm(`Permanently delete ${plural(ids.length, 'archived tab')} (and their offline copies)?`)) return;
    return run(() => api('POST', '/api/archive/delete', { ids: ids.map(Number) }),
      `Deleted ${plural(ids.length, 'archived tab')}`, state.sel.archive);
  },
};

// Hover buttons for a live node / archive node.
function liveActions(keys) {
  if (!keys.length) return [];
  return [
    el('button', { class: 'mini', title: 'Move to the target client', onclick: () => act.move(keys) }, 'Move'),
    el('button', { class: 'mini', title: 'Archive (close on source, keep on server)', onclick: () => act.archive(keys) }, 'Archive'),
    el('button', { class: 'mini', title: 'Archive and save offline copies', onclick: () => act.archive(keys, true) }, 'Archive+offline'),
    el('button', { class: 'mini', title: 'Save offline copies (MHTML)', onclick: () => act.offline(keys) }, 'Offline'),
    el('button', { class: 'mini danger', title: 'Close and remove (no archive)', onclick: () => act.del(keys) }, 'Delete'),
  ];
}
function archiveActions(ids) {
  return [
    el('button', { class: 'mini', title: 'Restore on the target client', onclick: () => act.restore(ids) }, 'Restore'),
    el('button', { class: 'mini danger', title: 'Delete permanently', onclick: () => act.purge(ids) }, 'Delete'),
  ];
}

// ---------- drag & drop ----------
// Dragging a node carries its tabs; dragging a selected tab carries the whole selection.
function makeDraggable(row, kind, keysFn) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    const keys = keysFn();
    if (!keys.length) return e.preventDefault();
    state.dragging = true;
    e.dataTransfer.setData('application/x-tab-relay', JSON.stringify({ kind, keys }));
    e.dataTransfer.effectAllowed = 'copyMove';
    document.body.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    state.dragging = false;
    document.body.classList.remove('dragging');
  });
}
function makeDropTarget(row, clientId) {
  row.classList.add('drop-target');
  row.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-tab-relay')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? 'copy' : 'move';
    row.classList.add('drop-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-over'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drop-over');
    state.dragging = false;
    document.body.classList.remove('dragging');
    let data;
    try { data = JSON.parse(e.dataTransfer.getData('application/x-tab-relay')); } catch (err) { return; }
    if (data.kind === 'archive') act.restore(data.keys, clientId);
    else if (e.ctrlKey || e.altKey) act.open(data.keys, clientId);
    else act.move(data.keys, clientId);
  });
}

// ---------- rendering ----------
function render() {
  renderTargets();
  renderTree();
  renderSnapshots();
  renderOffline();
  renderCommands();
  updateSelectionUi();
}

// A group node; `keys` are the selection keys (in selection set `set`) underneath it.
function groupNode({ key, cls, content, children, keys, set, actions = [], drag, dropClient }) {
  const node = el('div', { class: `node ${cls}${state.collapsed.has(key) ? ' collapsed' : ''}` });
  const cb = el('input', { type: 'checkbox' });
  cb.dataset.keys = JSON.stringify(keys);
  cb.dataset.set = set;
  cb.addEventListener('change', () => {
    for (const k of keys) cb.checked ? state.sel[set].add(k) : state.sel[set].delete(k);
    updateSelectionUi();
  });
  const toggle = () => {
    node.classList.toggle('collapsed');
    node.classList.contains('collapsed') ? state.collapsed.add(key) : state.collapsed.delete(key);
    localStorage.setItem('tabRelayCollapsed', JSON.stringify([...state.collapsed]));
  };
  const row = el('div', { class: 'row' }, el('span', { class: 'twisty', onclick: toggle }), cb, content,
    actions.length ? el('span', { class: 'actions' }, actions) : null);
  row.querySelector('.label')?.addEventListener('click', toggle);
  if (drag && keys.length) makeDraggable(row, set, () => keys);
  if (dropClient) makeDropTarget(row, dropClient);
  node.append(row, el('div', { class: 'children' }, children));
  node.dataset.key = key;
  return node;
}

function leafNode({ key, set, cls, content, actions, title }) {
  const cb = el('input', { type: 'checkbox', 'data-leaf': key, 'data-set': set });
  cb.checked = state.sel[set].has(key);
  cb.addEventListener('change', () => {
    cb.checked ? state.sel[set].add(key) : state.sel[set].delete(key);
    updateSelectionUi();
  });
  const row = el('div', { class: 'row', title }, el('span', { class: 'twisty' }), cb, content,
    el('span', { class: 'actions' }, actions));
  row.querySelector('.label')?.addEventListener('click', () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });
  makeDraggable(row, set, () => (state.sel[set].has(key) ? [...state.sel[set]] : [key]));
  return el('div', { class: `node leaf ${cls}` }, row);
}

function favicon(url) {
  return url && /^(https?:|data:image\/)/.test(url)
    ? el('img', { class: 'fav', src: url, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => { e.target.replaceWith(el('span', { class: 'fav blank' })); } })
    : el('span', { class: 'fav blank' });
}
function urlSpan(url) {
  const safe = /^(https?|ftp|file):/i.test(url) ? url : null;
  return el('span', { class: 'url' }, safe ? el('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, url) : url);
}
function offlineBadge(o) {
  return el('a', { class: 'badge offline', href: offlineUrl(o.id), target: '_blank', rel: 'noopener',
    title: `Open the saved copy (${bytes(o.size)})` }, `offline ${bytes(o.size)}`);
}

const CLOSING_TEXT = { move: 'moving…', archive: 'archiving…', delete: 'closing…', close: 'closing…' };

function renderTree() {
  const root = $('#tree');
  root.textContent = '';
  root.append(renderLive(), renderArchive());
}

function renderLive() {
  const frag = document.createDocumentFragment();
  const clients = state.tree?.clients || [];
  if (!clients.length) {
    frag.append(el('div', { class: 'empty muted' },
      'No clients yet. Install the extension in Chrome, set the server URL and token in its options, and it will appear here.'));
    return frag;
  }
  const now = state.tree.now;
  const offMap = offlineByUrl();
  const machines = new Map();
  for (const c of clients) {
    if (!machines.has(c.machine)) machines.set(c.machine, []);
    machines.get(c.machine).push(c);
  }

  for (const [machine, mclients] of machines) {
    const mKeys = [];
    const profileNodes = mclients.map((c) => {
      const pKeys = [];
      const winNodes = c.windows.map((w, wi) => {
        const tabs = w.tabs.filter(matchesFilter);
        const wKeys = tabs.map((t) => `${c.id}:${t.id}`);
        pKeys.push(...wKeys);
        const n = groupNode({
          key: `w:${c.id}:${w.id}`, cls: 'window', set: 'live', keys: wKeys, drag: true,
          content: [
            el('span', { class: 'label' }, `Window ${wi + 1}`),
            el('span', { class: 'badge' }, plural(tabs.length, 'tab')),
            w.focused ? el('span', { class: 'badge' }, 'focused') : null,
            w.incognito ? el('span', { class: 'badge' }, 'incognito') : null,
          ],
          children: tabs.map((t) => liveTab(c, t, offMap.get(t.url))),
          actions: liveActions(wKeys),
        });
        if (!tabs.length && state.filter) n.classList.add('hidden-by-filter');
        return n;
      });
      mKeys.push(...pKeys);
      const tabCount = c.windows.reduce((n, w) => n + w.tabs.length, 0);
      return groupNode({
        key: `p:${c.id}`, cls: 'profile', set: 'live', keys: pKeys, drag: true, dropClient: c.id,
        content: [
          el('span', { class: `dot${c.online ? ' on' : ''}`, title: c.online ? 'online' : 'offline' }),
          el('span', { class: 'label', title: `client id ${c.id}\nDrop tabs here to move them to this profile (hold Ctrl to copy)` }, profileName(c)),
          el('span', { class: 'badge' }, `${c.windows.length} win · ${tabCount} tabs`),
          el('span', { class: 'muted small' }, c.online ? 'online' : `offline · seen ${ago(now - c.lastSeen)}`),
          c.online ? null : el('button', {
            class: 'mini danger', title: 'Remove this offline client (e.g. a stale duplicate) from the server',
            onclick: () => removeClient(c, tabCount),
          }, 'Remove'),
        ],
        children: winNodes,
        actions: liveActions(pKeys),
      });
    });
    const anyOnline = mclients.some((c) => c.online);
    frag.append(groupNode({
      key: `m:${machine}`, cls: 'machine', set: 'live', keys: mKeys, drag: true,
      // A machine with a single profile is also a drop target for that profile.
      dropClient: mclients.length === 1 ? mclients[0].id : null,
      content: [
        el('span', { class: `dot${anyOnline ? ' on' : ''}` }),
        el('span', { class: 'label' }, machine),
        el('span', { class: 'badge' }, plural(mclients.length, 'profile')),
      ],
      children: profileNodes,
      actions: liveActions(mKeys),
    }));
  }
  return frag;
}

function liveTab(c, t, off) {
  const key = `${c.id}:${t.id}`;
  return leafNode({
    key, set: 'live', cls: `tab${t.active ? ' active' : ''}${t.closing ? ' closing' : ''}`,
    title: `${t.title}\n${t.url}\nfrom ${clientName(c)}`,
    content: [
      favicon(t.favIconUrl),
      el('span', { class: 'label title' }, t.title || t.url || '(untitled)'),
      t.pinned ? el('span', { class: 'badge' }, 'pinned') : null,
      t.closing ? el('span', { class: 'badge warn' }, CLOSING_TEXT[t.closing] || 'closing…') : null,
      off ? offlineBadge(off) : null,
      urlSpan(t.url),
    ],
    actions: liveActions([key]),
  });
}

// Archive: machine -> profile -> date -> items
function renderArchive() {
  const items = state.archive.filter(matchesFilter);
  const tree = new Map();
  for (const a of items) {
    const m = a.source.machine || '?';
    const p = `${a.source.email}\u0000${a.source.label}`;
    const d = day(a.archivedAt);
    if (!tree.has(m)) tree.set(m, new Map());
    const pm = tree.get(m);
    if (!pm.has(p)) pm.set(p, new Map());
    const dm = pm.get(p);
    if (!dm.has(d)) dm.set(d, []);
    dm.get(d).push(a);
  }
  const allKeys = items.map((a) => String(a.id));
  const machineNodes = [...tree].map(([machine, pm]) => {
    const mKeys = [];
    const pNodes = [...pm].map(([p, dm]) => {
      const [email, label] = p.split('\u0000');
      const pKeys = [];
      const dNodes = [...dm].map(([d, list]) => {
        const dKeys = list.map((a) => String(a.id));
        pKeys.push(...dKeys);
        return groupNode({
          key: `ad:${machine}:${p}:${d}`, cls: 'date', set: 'archive', keys: dKeys, drag: true,
          content: [el('span', { class: 'label' }, d), el('span', { class: 'badge' }, plural(list.length, 'tab'))],
          children: list.map(archiveTab),
          actions: archiveActions(dKeys),
        });
      });
      mKeys.push(...pKeys);
      return groupNode({
        key: `ap:${machine}:${p}`, cls: 'profile', set: 'archive', keys: pKeys, drag: true,
        content: [el('span', { class: 'label' }, profileText(email, label)), el('span', { class: 'badge' }, plural(pKeys.length, 'tab'))],
        children: dNodes,
        actions: archiveActions(pKeys),
      });
    });
    return groupNode({
      key: `am:${machine}`, cls: 'machine', set: 'archive', keys: mKeys, drag: true,
      content: [el('span', { class: 'label' }, machine), el('span', { class: 'badge' }, plural(mKeys.length, 'tab'))],
      children: pNodes,
      actions: archiveActions(mKeys),
    });
  });
  return groupNode({
    key: 'archive', cls: 'archive-root', set: 'archive', keys: allKeys,
    content: [
      el('span', { class: 'label' }, 'Archive'),
      el('span', { class: 'badge' }, plural(state.archive.length, 'tab')),
      state.archive.length ? null : el('span', { class: 'muted small' }, 'archived tabs appear here'),
    ],
    children: machineNodes,
    actions: allKeys.length ? archiveActions(allKeys) : [],
  });
}

function archiveTab(a) {
  const key = String(a.id);
  return leafNode({
    key, set: 'archive', cls: 'tab archived',
    title: `${a.title}\n${a.url}\nfrom ${a.source.machine} — ${profileText(a.source.email, a.source.label)}\narchived ${new Date(a.archivedAt).toLocaleString()}`,
    content: [
      favicon(a.favIconUrl),
      el('span', { class: 'label title' }, a.title || a.url || '(untitled)'),
      a.pinned ? el('span', { class: 'badge' }, 'pinned') : null,
      a.offline ? offlineBadge(a.offline) : null,
      a.offline ? el('a', { class: 'badge', href: offlineUrl(a.offline.id, 'download'), title: 'Download .mhtml' }, '⬇') : null,
      el('span', { class: 'muted small' }, new Date(a.archivedAt).toLocaleTimeString()),
      urlSpan(a.url),
    ],
    actions: archiveActions([key]),
  });
}

function updateSelectionUi() {
  // Sync group checkboxes (checked / indeterminate) with their selection set.
  for (const cb of document.querySelectorAll('#tree input[data-keys]')) {
    const keys = JSON.parse(cb.dataset.keys);
    const set = state.sel[cb.dataset.set];
    const n = keys.filter((k) => set.has(k)).length;
    cb.checked = keys.length > 0 && n === keys.length;
    cb.indeterminate = n > 0 && n < keys.length;
    cb.disabled = keys.length === 0;
  }
  for (const cb of document.querySelectorAll('#tree input[data-leaf]')) cb.checked = state.sel[cb.dataset.set].has(cb.dataset.leaf);
  const n = state.sel.live.size;
  const a = state.sel.archive.size;
  const hasTarget = !!target();
  $('#sel-count').textContent = `${plural(n, 'tab')} selected`;
  for (const id of ['#btn-open', '#btn-move']) $(id).disabled = !n || !hasTarget;
  for (const id of ['#btn-archive', '#btn-archive-offline', '#btn-offline', '#btn-close', '#btn-snapshot']) $(id).disabled = !n;
  $('#archive-bar').hidden = !a;
  $('#asel-count').textContent = `${plural(a, 'archived tab')} selected`;
  $('#btn-restore').disabled = !a || !hasTarget;
  $('#btn-purge').disabled = !a;
}

function targetOptions(select) {
  const prev = select.value || localStorage.getItem('tabRelayTarget') || '';
  select.textContent = '';
  for (const c of state.tree?.clients || []) {
    select.append(el('option', { value: c.id }, `${c.online ? '●' : '○'} ${clientName(c)}`));
  }
  if ([...select.options].some((o) => o.value === prev)) select.value = prev;
}
function renderTargets() { targetOptions($('#target')); }
$('#target').addEventListener('change', () => { localStorage.setItem('tabRelayTarget', target()); updateSelectionUi(); });

function renderSnapshots() {
  const box = $('#snapshots');
  box.textContent = '';
  if (!state.snapshots.length) { box.textContent = 'No snapshots yet.'; return; }
  for (const s of state.snapshots) {
    const sel = el('select', { title: 'Restore target' });
    targetOptions(sel);
    const list = el('ul', { hidden: !state.openSnaps.has(s.id) }, s.tabs.map((t) =>
      el('li', { title: `${t.url}\nfrom ${t.source?.machine} — ${t.source?.email || 'not signed in'}` }, t.title || t.url)));
    box.append(el('div', { class: 'item' },
      el('div', { class: 'head' },
        el('span', { class: 'name', title: 'Show tabs', onclick: () => {
          list.hidden = !list.hidden;
          list.hidden ? state.openSnaps.delete(s.id) : state.openSnaps.add(s.id);
        } }, s.name),
        el('span', { class: 'badge' }, `${s.tabs.length}`),
        el('button', { class: 'link danger', title: 'Delete snapshot', onclick: async () => {
          if (!confirm(`Delete snapshot "${s.name}"?`)) return;
          await api('DELETE', `/api/snapshots/${s.id}`).catch((e) => flash(e.message, true));
          refresh();
        } }, '✕')),
      el('div', { class: 'muted small' }, new Date(s.createdAt).toLocaleString()),
      el('div', { class: 'head', style: 'margin-top:4px' }, sel,
        el('button', { onclick: () => {
          if (!sel.value) return;
          run(() => api('POST', `/api/snapshots/${s.id}/restore`, { targetClientId: sel.value, newWindow: true }),
            `Restoring "${s.name}" (${plural(s.tabs.length, 'tab')}) on ${targetLabel(sel.value)}`);
        } }, 'Restore')),
      list));
  }
}

function renderOffline() {
  const box = $('#offline');
  const { items, totalSize } = state.offline;
  $('#offline-total').textContent = items.length ? `${items.length} · ${bytes(totalSize)}` : '';
  box.textContent = '';
  if (!items.length) { box.textContent = 'No offline copies yet.'; return; }
  for (const o of items.filter(matchesFilter)) {
    box.append(el('div', { class: 'item', title: `${o.url}\nfrom ${o.source.machine} — ${profileText(o.source.email, o.source.label)}` },
      el('div', { class: 'head' },
        favicon(o.favIconUrl),
        el('a', { class: 'name', href: offlineUrl(o.id), target: '_blank', rel: 'noopener' }, o.title || o.url),
        el('a', { class: 'link small', href: offlineUrl(o.id, 'raw'), target: '_blank', rel: 'noopener', title: 'The archive as multipart/related (Chrome saves it; open the file to view)' }, 'mhtml'),
        el('a', { class: 'link', href: offlineUrl(o.id, 'download'), title: 'Download .mhtml' }, '⬇'),
        el('button', { class: 'link danger', title: 'Delete this offline copy', onclick: async () => {
          if (!confirm(`Delete the offline copy of "${o.title || o.url}"?`)) return;
          await api('DELETE', `/api/offline/${o.id}`).catch((e) => flash(e.message, true));
          refresh();
        } }, '✕')),
      el('div', { class: 'muted small' }, `${bytes(o.size)} · ${o.source.machine} · ${new Date(o.createdAt).toLocaleString()}`)));
  }
}

function renderCommands() {
  const box = $('#commands');
  box.textContent = '';
  if (!state.commands.length) { box.textContent = 'None yet.'; return; }
  for (const c of state.commands) {
    const n = c.type === 'open' ? c.payload.tabs?.length : c.payload.tabIds?.length;
    const what = c.type === 'close' && c.payload.reason && c.payload.reason !== 'close' ? `close (${c.payload.reason})` : c.type;
    box.append(el('div', { class: 'cmd', title: c.result ? JSON.stringify(c.result) : '' },
      el('span', { class: `st-${c.status}` }, c.status),
      el('span', {}, `${what} ${n} on ${c.client.machine || '?'} (${c.client.email || 'not signed in'})`),
      el('span', { class: 'muted', style: 'margin-left:auto' }, new Date(c.createdAt).toLocaleTimeString())));
  }
}

// ---------- clients ----------
const KEEP_NOTE = 'Its archived tabs and offline copies are kept. If the extension connects again with this id, it re-appears.';

async function removeClient(c, tabCount) {
  if (!confirm(`Remove ${clientName(c)} (client ${c.id.slice(0, 8)}…, ${plural(tabCount, 'tab')}, last seen ${new Date(c.lastSeen).toLocaleString()})?\n\n${KEEP_NOTE}`)) return;
  try {
    const r = await api('DELETE', `/api/clients/${encodeURIComponent(c.id)}`);
    flash(`Removed ${clientName(c)} (${plural(r.removed.tabs, 'tab')}${r.removed.cancelledDependents ? `, ${plural(r.removed.cancelledDependents, 'dependent command')} cancelled` : ''})`);
    state.sel.live.clear();
    refresh();
  } catch (e) { flash(e.message, true); }
}

$('#btn-prune').addEventListener('click', async () => {
  const days = prompt('Remove every OFFLINE client not seen for at least this many days (0 = all offline clients):', '7');
  if (days === null) return;
  const n = Number(days);
  if (!Number.isFinite(n) || n < 0) return flash('Enter a number of days ≥ 0', true);
  const victims = (state.tree?.clients || []).filter((c) => !c.online && state.tree.now - c.lastSeen >= n * 86_400_000);
  if (!victims.length) return flash(`No offline clients older than ${n} day(s)`);
  if (!confirm(`Remove ${plural(victims.length, 'offline client')}?\n\n${victims.map(clientName).join('\n')}\n\n${KEEP_NOTE}`)) return;
  try {
    const r = await api('POST', '/api/clients/prune', { olderThanDays: n });
    flash(`Removed ${plural(r.removed.length, 'client')}`);
    refresh();
  } catch (e) { flash(e.message, true); }
});

// ---------- toolbar ----------
const liveSel = () => [...state.sel.live];
const archSel = () => [...state.sel.archive];
$('#btn-open').addEventListener('click', () => act.open(liveSel()));
$('#btn-move').addEventListener('click', () => act.move(liveSel()));
$('#btn-archive').addEventListener('click', () => act.archive(liveSel()));
$('#btn-archive-offline').addEventListener('click', () => act.archive(liveSel(), true));
$('#btn-offline').addEventListener('click', () => act.offline(liveSel()));
$('#btn-close').addEventListener('click', () => act.del(liveSel()));
$('#btn-snapshot').addEventListener('click', () => act.snapshot(liveSel()));
$('#btn-restore').addEventListener('click', () => act.restore(archSel()));
$('#btn-purge').addEventListener('click', () => act.purge(archSel()));
$('#btn-clear').addEventListener('click', () => { state.sel.live.clear(); state.sel.archive.clear(); updateSelectionUi(); });

$('#filter').addEventListener('input', (e) => { state.filter = e.target.value.trim(); renderTree(); renderOffline(); updateSelectionUi(); });
$('#btn-expand').addEventListener('click', () => {
  state.collapsed.clear();
  localStorage.setItem('tabRelayCollapsed', '[]');
  renderTree(); updateSelectionUi();
});
$('#btn-collapse').addEventListener('click', () => {
  for (const n of document.querySelectorAll('#tree .node:not(.leaf)')) {
    if (!n.classList.contains('machine') && !n.classList.contains('archive-root')) state.collapsed.add(n.dataset.key);
  }
  localStorage.setItem('tabRelayCollapsed', JSON.stringify([...state.collapsed]));
  renderTree(); updateSelectionUi();
});

// ---------- boot ----------
if (state.token) {
  localStorage.setItem('tabRelayToken', state.token);
  if (location.hash) history.replaceState(null, '', location.pathname);
  refresh();
} else {
  showLogin();
}
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

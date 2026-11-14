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
  view: localStorage.getItem('tabRelayView') === 'tree' ? 'tree' : 'table',
  flat: localStorage.getItem('tabRelayFlat') === '1',
  sort: (() => {
    try {
      const v = JSON.parse(localStorage.getItem('tabRelaySort'));
      if (v && ['none', 'url', 'title', 'desc', 'date'].includes(v.key) && (v.dir === 1 || v.dir === -1)) return v;
    } catch (e) { /* default */ }
    return { key: 'none', dir: 1 };
  })(),
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
  return (t.title || '').toLowerCase().includes(f) || (t.url || '').toLowerCase().includes(f)
    || (t.description || '').toLowerCase().includes(f);
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

// Runs an action, reports success/failure, deselects the affected keys (not the whole
// selection, so a per-row action keeps the user's other checkboxes) and refreshes.
// Resolves to true on success.
async function run(fn, okText, set, keys) {
  try {
    await fn();
    flash(okText);
    if (set) for (const k of keys) set.delete(k);
    await refresh();
    return true;
  } catch (e) {
    flash(e.message, true);
    return false;
  }
}

// "3 tabs" for bulk actions, the tab's title for a single row.
function whatTabs(keys, noun = 'tab') {
  if (keys.length !== 1) return plural(keys.length, noun);
  let title = '';
  if (noun === 'tab') {
    const i = keys[0].lastIndexOf(':');
    const c = clientById(keys[0].slice(0, i));
    const id = Number(keys[0].slice(i + 1));
    for (const w of c?.windows || []) for (const t of w.tabs) if (t.id === id) title = t.title || t.url;
  } else {
    const a = state.archive.find((x) => String(x.id) === keys[0]);
    title = a ? a.title || a.url : '';
  }
  return title ? `"${title.length > 60 ? `${title.slice(0, 57)}…` : title}"` : plural(1, noun);
}

const act = {
  open(keys, to = target()) {
    if (!to) return flash('Choose a target first', true);
    return run(() => api('POST', '/api/actions/open', { tabs: refsFromKeys(keys), targetClientId: to, newWindow: newWindow() }),
      `Opening ${whatTabs(keys)} on ${targetLabel(to)}`, state.sel.live, keys);
  },
  move(keys, to = target()) {
    if (!to) return flash('Choose a target first', true);
    return run(() => api('POST', '/api/actions/move', { tabs: refsFromKeys(keys), targetClientId: to, newWindow: newWindow() }),
      `Moving ${whatTabs(keys)} to ${targetLabel(to)} (sources close once they are open)`, state.sel.live, keys);
  },
  archive(keys, offline = false) {
    return run(() => api('POST', '/api/actions/archive', { tabs: refsFromKeys(keys), offline }),
      `Archiving ${whatTabs(keys)}${offline ? ' (saving offline copies first)' : ''}`, state.sel.live, keys);
  },
  offline(keys) {
    return run(() => api('POST', '/api/actions/offline', { tabs: refsFromKeys(keys) }),
      `Saving ${whatTabs(keys)} for offline reading`, state.sel.live, keys);
  },
  del(keys) {
    if (!confirm(`Close and remove ${whatTabs(keys)}? ${keys.length === 1 ? 'It' : 'They'} will NOT be archived.`)) return;
    return run(() => api('POST', '/api/actions/close', { tabs: refsFromKeys(keys) }),
      `Closing ${whatTabs(keys)}`, state.sel.live, keys);
  },
  snapshot(keys) {
    const name = prompt('Snapshot name:', `Snapshot ${new Date().toLocaleString()}`);
    if (name === null) return;
    return run(() => api('POST', '/api/snapshots', { tabs: refsFromKeys(keys), name }),
      `Saved snapshot "${name}" (${plural(keys.length, 'tab')})`, state.sel.live, keys);
  },
  restore(ids, to = target()) {
    if (!to) return flash('Choose a target first', true);
    return run(() => api('POST', '/api/archive/restore', { ids: ids.map(Number), targetClientId: to, newWindow: true }),
      `Restoring ${whatTabs(ids, 'archived tab')} on ${targetLabel(to)}`, state.sel.archive, ids);
  },
  purge(ids) {
    if (!confirm(`Permanently delete ${whatTabs(ids, 'archived tab')} (and ${ids.length === 1 ? 'its offline copy' : 'their offline copies'})?`)) return;
    return run(() => api('POST', '/api/archive/delete', { ids: ids.map(Number) }),
      `Deleted ${whatTabs(ids, 'archived tab')}`, state.sel.archive, ids);
  },
};

// ---------- per-row buttons (table view) ----------
// Feather-style line icons (static markup).
const ICONS = {
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  save: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  saved: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 9 10.5 12.5 17 6"/>',
  archive: '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
  restore: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  spinner: '<path d="M12 2a10 10 0 1 0 10 10" />',
};
function icon(name) {
  const span = document.createElement('span');
  span.className = 'ico';
  span.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return span;
}

// A compact icon button; while its action runs it shows a spinner and is disabled.
function rowButton({ name, ico, title, cls = '', disabled = false, onclick }) {
  const b = el('button', { type: 'button', class: `rb ${cls}`, title, 'aria-label': title, 'data-action': name, disabled }, icon(ico));
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (b.disabled) return;
    b.disabled = true;
    b.classList.add('busy');
    b.replaceChildren(icon('spinner'));
    try { await onclick(); } finally {
      // The table is usually re-rendered by the refresh; restore the button if it wasn't.
      if (b.isConnected) { b.disabled = false; b.classList.remove('busy'); b.replaceChildren(icon(ico)); }
    }
  });
  return b;
}

const canCapture = (url) => /^https?:\/\//i.test(url || '') && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);

function liveRowButtons(key, t, off) {
  const busy = !!t.closing;   // already being moved / archived / closed
  let save;
  if (t.capturing) {
    save = { ico: 'spinner', cls: 'busy', disabled: true, title: 'Saving an offline copy…' };
  } else if (!canCapture(t.url)) {
    save = { ico: 'save', disabled: true, title: "Save offline: not possible for this page (only http/https pages can be captured)" };
  } else if (off) {
    save = { ico: 'saved', cls: 'done', title: `Saved offline (${bytes(off.size)}, ${new Date(off.createdAt).toLocaleString()}). Click to save a fresh copy` };
  } else {
    save = { ico: 'save', title: 'Save offline' };
  }
  return [
    rowButton({ name: 'delete', ico: 'trash', cls: 'danger', disabled: busy, title: 'Delete (close the tab, no archive)', onclick: () => act.del([key]) }),
    rowButton({ name: 'offline', ...save, disabled: save.disabled || busy, onclick: () => act.offline([key]) }),
    rowButton({ name: 'archive', ico: 'archive', disabled: busy, title: 'Archive (close the tab, keep it in the Archive)', onclick: () => act.archive([key]) }),
  ];
}

function archiveRowButtons(key) {
  return [
    rowButton({ name: 'purge', ico: 'trash', cls: 'danger', title: 'Delete permanently (with its offline copy)', onclick: () => act.purge([key]) }),
    rowButton({ name: 'restore', ico: 'restore', title: 'Restore (open on the target client, remove from the Archive)', onclick: () => act.restore([key]) }),
  ];
}

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

// The live tabs and the archive are built as one model (groups → leaves) that two renderers
// consume: the table (default) and the original tree. Group: {type:'group', key, cls, set, keys,
// content, actions, drag, dropClient, children, hidden}. Leaf: {type:'leaf', key, set, cls, tip,
// fav, url, title, badges, description, archivedAt, actions}.
const groupNode = (o) => ({ type: 'group', actions: [], ...o });
const leafNode = (o) => ({ type: 'leaf', ...o });

function groupCheckbox(keys, set) {
  const cb = el('input', { type: 'checkbox' });
  cb.dataset.keys = JSON.stringify(keys);
  cb.dataset.set = set;
  cb.addEventListener('change', () => {
    for (const k of keys) cb.checked ? state.sel[set].add(k) : state.sel[set].delete(k);
    updateSelectionUi();
  });
  return cb;
}
function leafCheckbox(key, set) {
  const cb = el('input', { type: 'checkbox', 'data-leaf': key, 'data-set': set });
  cb.checked = state.sel[set].has(key);
  cb.addEventListener('change', () => {
    cb.checked ? state.sel[set].add(key) : state.sel[set].delete(key);
    updateSelectionUi();
  });
  return cb;
}
function toggleCollapsed(key) {
  state.collapsed.has(key) ? state.collapsed.delete(key) : state.collapsed.add(key);
  localStorage.setItem('tabRelayCollapsed', JSON.stringify([...state.collapsed]));
}
const leafDragKeys = (n) => () => (state.sel[n.set].has(n.key) ? [...state.sel[n.set]] : [n.key]);

// ---- tree renderer ----
function treeNode(n) {
  if (n.type === 'leaf') {
    const cb = leafCheckbox(n.key, n.set);
    const row = el('div', { class: 'row', title: n.tip }, el('span', { class: 'twisty' }), cb,
      favicon(n.fav),
      el('span', { class: 'label title' }, n.title),
      n.badges,
      n.archivedAt ? el('span', { class: 'muted small' }, new Date(n.archivedAt).toLocaleTimeString()) : null,
      urlSpan(n.url),
      el('span', { class: 'actions' }, n.actions));
    row.querySelector('.label').addEventListener('click', () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });
    makeDraggable(row, n.set, leafDragKeys(n));
    return el('div', { class: `node leaf ${n.cls}` }, row);
  }
  const node = el('div', { class: `node ${n.cls}${state.collapsed.has(n.key) ? ' collapsed' : ''}${n.hidden ? ' hidden-by-filter' : ''}` });
  const toggle = () => { toggleCollapsed(n.key); node.classList.toggle('collapsed'); };
  const row = el('div', { class: 'row' }, el('span', { class: 'twisty', onclick: toggle }), groupCheckbox(n.keys, n.set), n.content,
    n.actions.length ? el('span', { class: 'actions' }, n.actions) : null);
  row.querySelector('.label')?.addEventListener('click', toggle);
  if (n.drag && n.keys.length) makeDraggable(row, n.set, () => n.keys);
  if (n.dropClient) makeDropTarget(row, n.dropClient);
  node.append(row, el('div', { class: 'children' }, n.children.map(treeNode)));
  node.dataset.key = n.key;
  return node;
}

// ---- table renderer ----
// Long URLs are shortened in the middle; the full URL is in the tooltip.
function shortUrl(url) {
  let s = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  try { s = decodeURI(s); } catch (e) { /* keep encoded */ }
  if (s.endsWith('/') && s.indexOf('/') === s.length - 1) s = s.slice(0, -1);
  return s.length > 52 ? `${s.slice(0, 34)}…${s.slice(-16)}` : s;
}
function urlCell(url, fav) {
  const safe = /^(https?|ftp|file):/i.test(url) ? url : null;
  const text = url ? shortUrl(url) : '—';
  return el('td', { class: 'c-url', title: url },
    favicon(fav),
    safe ? el('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, text) : el('span', {}, text));
}

// Layout: group header rows are indented INDENT px per level; a tab row's checkbox sits where its
// parent's children start, so tabs line up under their window (or date, in the archive).
const PAD = 12;
const INDENT = 20;
const TWISTY = 22;   // twisty width + gap in group rows
const leafPad = (depth) => PAD + depth * INDENT + (depth ? TWISTY : 0);

function tableRows(n, depth, cols, out, flat, archive = false) {
  if (n.type === 'leaf') {
    const cb = leafCheckbox(n.key, n.set);
    const tr = el('tr', { class: `leaf ${n.cls}`, title: n.tip, 'data-key': n.key },
      el('td', { class: 'c-cb', style: `padding-left:${leafPad(depth)}px` }, cb),
      el('td', { class: 'c-act' }, el('div', { class: 'row-btns' }, n.rowActions)),
      urlCell(n.url, n.fav),
      el('td', { class: 'c-title' }, el('div', { class: 'clamp' }, el('span', { class: 'label' }, n.title), n.badges,
        flat && n.src ? el('span', { class: 'badge src', title: `from ${n.src}` }, n.src) : null)),
      el('td', { class: `c-desc${n.description ? '' : ' none'}`, title: n.description || 'No description known' },
        el('div', { class: 'clamp' }, n.description || '—'),
        n.hoverActions?.length ? el('span', { class: 'actions' }, n.hoverActions) : null),
      archive ? el('td', { class: 'c-date' }, n.archivedAt ? new Date(n.archivedAt).toLocaleString() : '') : null);
    tr.querySelector('.label').addEventListener('click', () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });
    makeDraggable(tr, n.set, leafDragKeys(n));
    out.push(tr);
    return;
  }
  if (n.hidden) return;
  const collapsed = state.collapsed.has(n.key);
  const toggle = () => { toggleCollapsed(n.key); renderTree(); updateSelectionUi(); };
  const cell = el('td', { colspan: cols, style: `padding-left:${PAD + depth * INDENT}px` },
    el('div', { class: 'grp-line' },
      el('span', { class: 'twisty', onclick: toggle }), groupCheckbox(n.keys, n.set), n.content,
      n.actions.length ? el('span', { class: 'actions' }, n.actions) : null));
  const tr = el('tr', { class: `grp lvl-${depth} ${n.cls}${collapsed ? ' collapsed' : ''}`, 'data-key': n.key }, cell);
  tr.querySelector('.label')?.addEventListener('click', toggle);
  if (n.drag && n.keys.length) makeDraggable(tr, n.set, () => n.keys);
  if (n.dropClient) makeDropTarget(tr, n.dropClient);
  out.push(tr);
  if (!collapsed) for (const c of n.children) tableRows(c, depth + 1, cols, out, flat, archive);
}

// ---- sorting ----
// state.sort = {key: 'none'|'url'|'title'|'desc'|'date', dir: 1|-1}. Sorting reorders tabs inside
// their group (window / archive date); in flat mode it orders all tabs. Ties keep browser order.
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const cmp = (x, y) => collator.compare(x || '', y || '');
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ''); } catch (e) { return url || ''; }
}
const SORTS = {
  url: { label: 'URL', fn: (a, b) => cmp(hostOf(a.url), hostOf(b.url)) || cmp(a.url, b.url) },
  title: { label: 'Title', fn: (a, b) => cmp(a.sortTitle, b.sortTitle), field: 'sortTitle' },
  desc: { label: 'Description', fn: (a, b) => cmp(a.description, b.description), field: 'description' },
  date: { label: 'Archived', fn: (a, b) => (a.archivedAt || 0) - (b.archivedAt || 0) },
};
function sortLeaves(leaves) {
  const { key, dir } = state.sort;
  const s = SORTS[key];
  if (!s) return leaves;
  return leaves.slice().sort((a, b) => {
    if (s.field) {   // rows without a title/description go last in both directions
      const ea = !a[s.field];
      const eb = !b[s.field];
      if (ea !== eb) return ea ? 1 : -1;
    }
    return dir * s.fn(a, b);
  });
}
function setSort(key) {
  const cur = state.sort;
  // Click cycle per column: ascending → descending → original browser order.
  state.sort = cur.key !== key ? { key, dir: 1 } : cur.dir === 1 ? { key, dir: -1 } : { key: 'none', dir: 1 };
  localStorage.setItem('tabRelaySort', JSON.stringify(state.sort));
  renderTree();
  updateSelectionUi();
}
function sortHeader(key, extraClass = '') {
  const active = state.sort.key === key;
  const arrow = active ? (state.sort.dir === 1 ? '▲' : '▼') : '↕';
  const next = !active ? 'ascending' : state.sort.dir === 1 ? 'descending' : 'original order';
  return el('th', {
    class: `sortable${active ? ' sorted' : ''} ${extraClass}`, tabindex: '0', role: 'button',
    'aria-sort': active ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none',
    title: `Sort by ${SORTS[key].label.toLowerCase()}${key === 'url' ? ' (site, then full URL)' : ''}: click for ${next}`,
    onclick: () => setSort(key),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSort(key); } },
  }, SORTS[key].label, el('span', { class: 'arrow' }, arrow));
}

function collectLeaves(nodes, out = []) {
  for (const n of nodes) {
    if (n.type === 'leaf') out.push(n);
    else if (!n.hidden) collectLeaves(n.children, out);
  }
  return out;
}

function tableOf(nodes, { archive = false, flat = false } = {}) {
  const cols = archive ? 6 : 5;
  const rows = [];
  if (flat) {
    for (const leaf of sortLeaves(collectLeaves(nodes))) tableRows(leaf, 0, cols, rows, true, archive);
  } else {
    for (const n of nodes) tableRows(n, 0, cols, rows, false, archive);
  }
  const leafDepth = flat ? 0 : archive ? 4 : 3;
  const allKeys = collectLeaves(nodes).map((l) => l.key);
  const set = archive ? 'archive' : 'live';
  if (!rows.length && flat) {
    rows.push(el('tr', { class: 'empty-row' }, el('td', { colspan: cols, class: 'muted' }, archive ? 'Archive is empty.' : 'No tabs.')));
  }
  return el('table', { class: `tt${archive ? ' archive' : ''}${flat ? ' flat' : ''}` },
    el('colgroup', {},
      el('col', { class: 'w-cb', style: `width:${leafPad(leafDepth) + 16 + PAD}px` }),
      el('col', { class: `w-act${archive ? ' two' : ''}` }),
      el('col', { class: 'w-url' }), el('col', { class: 'w-title' }), el('col', { class: 'w-desc' }),
      archive ? el('col', { class: 'w-date' }) : null),
    el('thead', {}, el('tr', {},
      el('th', { class: 'c-cb', style: `padding-left:${leafPad(leafDepth)}px`, title: `Select all ${archive ? 'archived' : 'live'} tabs in this table` },
        allKeys.length ? groupCheckbox(allKeys, set) : null),
      el('th', { class: 'c-act', title: archive ? 'Row actions: Delete permanently, Restore' : 'Row actions: Delete, Save offline, Archive' }),
      sortHeader('url'), sortHeader('title'), sortHeader('desc'),
      archive ? sortHeader('date', 'c-date') : null)),
    el('tbody', {}, rows));
}

// Flat mode has no profile rows to drop onto: offer each client as a drop chip instead.
function dropStrip() {
  const clients = state.tree?.clients || [];
  if (!clients.length) return '';
  return el('div', { class: 'drop-strip' },
    el('span', { class: 'muted small' }, 'Drop tabs on a profile to move them (Ctrl = copy):'),
    clients.map((c) => {
      const chip = el('span', { class: 'chip', title: `client ${c.id}` },
        el('span', { class: `dot${c.online ? ' on' : ''}` }), clientName(c));
      makeDropTarget(chip, c.id);
      return chip;
    }));
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
  root.classList.toggle('table-view', state.view === 'table');
  const live = liveModel();
  const archive = archiveModel();
  const empty = live.length ? null : el('div', { class: 'empty muted' },
    'No clients yet. Install the extension in Chrome, set the server URL and token in its options, and it will appear here.');
  if (state.view === 'tree') {
    root.append(empty || '', ...live.map(treeNode), treeNode(archive));
  } else if (state.flat) {
    root.append(dropStrip(), empty || tableOf(live, { flat: true }), tableOf([archive], { archive: true, flat: true }));
  } else {
    root.append(empty || tableOf(live), tableOf([archive], { archive: true }));
  }
  $('#btn-view').textContent = state.view === 'tree' ? 'Table view' : 'Tree view';
  $('#flat-label').hidden = state.view === 'tree';
  $('#flat').checked = state.flat;
}

function liveModel() {
  const clients = state.tree?.clients || [];
  const now = state.tree?.now;
  const offMap = offlineByUrl();
  const machines = new Map();
  for (const c of clients) {
    if (!machines.has(c.machine)) machines.set(c.machine, []);
    machines.get(c.machine).push(c);
  }
  const out = [];
  for (const [machine, mclients] of machines) {
    const mKeys = [];
    const profileNodes = mclients.map((c) => {
      const pKeys = [];
      const winNodes = c.windows.map((w, wi) => {
        const tabs = w.tabs.filter(matchesFilter);
        const wKeys = tabs.map((t) => `${c.id}:${t.id}`);
        pKeys.push(...wKeys);
        return groupNode({
          key: `w:${c.id}:${w.id}`, cls: 'window', set: 'live', keys: wKeys, drag: true,
          hidden: !tabs.length && !!state.filter,
          content: [
            el('span', { class: 'label' }, `Window ${wi + 1}`),
            el('span', { class: 'badge' }, plural(tabs.length, 'tab')),
            w.focused ? el('span', { class: 'badge' }, 'focused') : null,
            w.incognito ? el('span', { class: 'badge' }, 'incognito') : null,
          ],
          children: sortLeaves(tabs.map((t) => liveTab(c, t, offMap.get(t.url)))),
          actions: liveActions(wKeys),
        });
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
    out.push(groupNode({
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
  return out;
}

function liveTab(c, t, off) {
  const key = `${c.id}:${t.id}`;
  return leafNode({
    key, set: 'live', cls: `tab${t.active ? ' active' : ''}${t.closing ? ' closing' : ''}`,
    tip: `${t.title}\n${t.url}${t.description ? `\n\n${t.description}` : ''}\n\nfrom ${clientName(c)}`,
    fav: t.favIconUrl, url: t.url, title: t.title || t.url || '(untitled)', description: t.description,
    sortTitle: t.title, src: clientName(c),
    rowActions: liveRowButtons(key, t, off),
    // In the table, Delete / Save offline / Archive are row buttons; the hover menu keeps the rest.
    hoverActions: [
      el('button', { class: 'mini', title: 'Move to the target client', onclick: () => act.move([key]) }, 'Move'),
      el('button', { class: 'mini', title: 'Archive and save an offline copy', onclick: () => act.archive([key], true) }, 'Archive+offline'),
    ],
    badges: [
      t.pinned ? el('span', { class: 'badge' }, 'pinned') : null,
      t.closing ? el('span', { class: 'badge warn' }, CLOSING_TEXT[t.closing] || 'closing…') : null,
      t.capturing ? el('span', { class: 'badge warn' }, 'saving offline…') : null,
      off ? offlineBadge(off) : null,
    ],
    actions: liveActions([key]),
  });
}

// Archive: machine -> profile -> date -> items
function archiveModel() {
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
          children: sortLeaves(list.map(archiveTab)),
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
    tip: `${a.title}\n${a.url}${a.description ? `\n\n${a.description}` : ''}\n\nfrom ${a.source.machine} — ${profileText(a.source.email, a.source.label)}\narchived ${new Date(a.archivedAt).toLocaleString()}`,
    fav: a.favIconUrl, url: a.url, title: a.title || a.url || '(untitled)', description: a.description, archivedAt: a.archivedAt,
    sortTitle: a.title, src: `${a.source.machine} — ${profileText(a.source.email, a.source.label)}`,
    rowActions: archiveRowButtons(key),
    hoverActions: [],
    badges: [
      a.pinned ? el('span', { class: 'badge' }, 'pinned') : null,
      a.offline ? offlineBadge(a.offline) : null,
      a.offline ? el('a', { class: 'badge', href: offlineUrl(a.offline.id, 'download'), title: 'Download .mhtml' }, '⬇') : null,
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
  for (const n of document.querySelectorAll('#tree .node:not(.leaf), #tree tr.grp')) {
    if (!n.classList.contains('machine') && !n.classList.contains('archive-root')) state.collapsed.add(n.dataset.key);
  }
  localStorage.setItem('tabRelayCollapsed', JSON.stringify([...state.collapsed]));
  renderTree(); updateSelectionUi();
});

$('#btn-view').addEventListener('click', () => {
  state.view = state.view === 'tree' ? 'table' : 'tree';
  localStorage.setItem('tabRelayView', state.view);
  renderTree(); updateSelectionUi();
});

$('#flat').addEventListener('change', (e) => {
  state.flat = e.target.checked;
  localStorage.setItem('tabRelayFlat', state.flat ? '1' : '0');
  renderTree(); updateSelectionUi();
});

// Keep the sticky table header just below the (variable-height) sticky toolbar.
new ResizeObserver(() => document.documentElement.style.setProperty('--toolbar-h', `${$('#toolbar').offsetHeight}px`)).observe($('#toolbar'));

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

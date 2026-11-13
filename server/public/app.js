'use strict';
/* Tab Relay web UI — vanilla JS, no build step. */

const $ = (sel) => document.querySelector(sel);
const REFRESH_MS = 4000;

const state = {
  token: localStorage.getItem('tabRelayToken') || new URLSearchParams(location.hash.slice(1)).get('token') || '',
  tree: null,
  snapshots: [],
  commands: [],
  selected: new Set(),                 // "clientId:tabId"
  collapsed: new Set(JSON.parse(localStorage.getItem('tabRelayCollapsed') || '[]')),
  openSnaps: new Set(),
  filter: '',
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
function profileName(c) {
  const who = c.profile.email || 'not signed in';
  return c.profile.label && c.profile.label !== c.profile.email ? `${who} (${c.profile.label})` : who;
}
function clientName(c) { return `${c.machine} — ${profileName(c)}`; }
function flash(text, isError = false) {
  const d = el('div', { class: isError ? 'error' : '' }, text);
  $('#msg').append(d);
  setTimeout(() => d.remove(), isError ? 8000 : 4000);
}

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
  if (refreshing || !state.token) return;
  refreshing = true;
  try {
    const [tree, snaps, cmds] = await Promise.all([
      api('GET', '/api/tree'), api('GET', '/api/snapshots'), api('GET', '/api/commands?limit=15'),
    ]);
    state.tree = tree;
    state.snapshots = snaps.snapshots;
    state.commands = cmds.commands;
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

function allTabs() {
  const out = [];
  for (const c of state.tree?.clients || []) for (const w of c.windows) for (const t of w.tabs) out.push({ c, w, t });
  return out;
}
function pruneSelection() {
  const live = new Set(allTabs().map(({ c, t }) => `${c.id}:${t.id}`));
  for (const k of state.selected) if (!live.has(k)) state.selected.delete(k);
}
function selectedRefs() {
  return [...state.selected].map((k) => {
    const i = k.lastIndexOf(':');
    return { clientId: k.slice(0, i), tabId: Number(k.slice(i + 1)) };
  });
}
function matchesFilter(t) {
  if (!state.filter) return true;
  const f = state.filter.toLowerCase();
  return t.title.toLowerCase().includes(f) || t.url.toLowerCase().includes(f);
}

// ---------- rendering ----------
function render() {
  renderTree();
  renderTargets();
  renderSnapshots();
  renderCommands();
  updateSelectionUi();
}

// A group node; `keys` are the tab-selection keys underneath it.
function groupNode(key, cls, rowContent, children, keys) {
  const node = el('div', { class: `node ${cls}${state.collapsed.has(key) ? ' collapsed' : ''}` });
  const cb = el('input', { type: 'checkbox' });
  cb.dataset.keys = JSON.stringify(keys);
  cb.addEventListener('change', () => {
    for (const k of keys) cb.checked ? state.selected.add(k) : state.selected.delete(k);
    updateSelectionUi();
  });
  const toggle = () => {
    node.classList.toggle('collapsed');
    node.classList.contains('collapsed') ? state.collapsed.add(key) : state.collapsed.delete(key);
    localStorage.setItem('tabRelayCollapsed', JSON.stringify([...state.collapsed]));
  };
  const row = el('div', { class: 'row' }, el('span', { class: 'twisty', onclick: toggle }), cb);
  for (const part of rowContent) row.append(part);
  row.querySelector('.label')?.addEventListener('click', toggle);
  node.append(row, el('div', { class: 'children' }, children));
  node.dataset.key = key;
  return node;
}

function renderTree() {
  const root = $('#tree');
  root.textContent = '';
  const clients = state.tree?.clients || [];
  if (!clients.length) {
    root.append(el('div', { class: 'empty muted' },
      'No clients yet. Install the extension in Chrome, set the server URL and token in its options, and it will appear here.'));
    return;
  }
  const now = state.tree.now;
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
        const tabNodes = tabs.map((t) => tabNode(c, t));
        const n = groupNode(`w:${c.id}:${w.id}`, 'window', [
          el('span', { class: 'label' }, `Window ${wi + 1}`),
          el('span', { class: 'badge' }, `${tabs.length} tab${tabs.length === 1 ? '' : 's'}`),
          w.focused ? el('span', { class: 'badge' }, 'focused') : null,
          w.incognito ? el('span', { class: 'badge' }, 'incognito') : null,
        ].filter(Boolean), tabNodes, wKeys);
        if (!tabs.length && state.filter) n.classList.add('hidden-by-filter');
        return n;
      });
      mKeys.push(...pKeys);
      const tabCount = c.windows.reduce((n, w) => n + w.tabs.length, 0);
      return groupNode(`p:${c.id}`, 'profile', [
        el('span', { class: `dot${c.online ? ' on' : ''}`, title: c.online ? 'online' : 'offline' }),
        el('span', { class: 'label', title: `client id ${c.id}` }, profileName(c)),
        el('span', { class: 'badge' }, `${c.windows.length} win · ${tabCount} tabs`),
        el('span', { class: 'muted', style: 'font-size:12px' }, c.online ? 'online' : `offline · seen ${ago(now - c.lastSeen)}`),
        c.online ? null : el('button', {
          class: 'link', title: 'Remove this client from the server',
          onclick: async () => {
            if (!confirm(`Forget ${clientName(c)}? It will re-appear if the extension connects again.`)) return;
            await api('DELETE', `/api/clients/${encodeURIComponent(c.id)}`).catch((e) => flash(e.message, true));
            refresh();
          },
        }, 'forget'),
      ].filter(Boolean), winNodes, pKeys);
    });
    const anyOnline = mclients.some((c) => c.online);
    root.append(groupNode(`m:${machine}`, 'machine', [
      el('span', { class: `dot${anyOnline ? ' on' : ''}` }),
      el('span', { class: 'label' }, machine),
      el('span', { class: 'badge' }, `${mclients.length} profile${mclients.length === 1 ? '' : 's'}`),
    ], profileNodes, mKeys));
  }
}

function tabNode(c, t) {
  const key = `${c.id}:${t.id}`;
  const cb = el('input', { type: 'checkbox', 'data-tab': key });
  cb.checked = state.selected.has(key);
  cb.addEventListener('change', () => {
    cb.checked ? state.selected.add(key) : state.selected.delete(key);
    updateSelectionUi();
  });
  const fav = t.favIconUrl && /^(https?:|data:image\/)/.test(t.favIconUrl)
    ? el('img', { class: 'fav', src: t.favIconUrl, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => { e.target.replaceWith(el('span', { class: 'fav blank' })); } })
    : el('span', { class: 'fav blank' });
  const safeHref = /^(https?|ftp|file):/i.test(t.url) ? t.url : null;
  return el('div', { class: `node leaf tab${t.active ? ' active' : ''}` },
    el('div', { class: 'row', title: `${t.title}\n${t.url}\nfrom ${clientName(c)}` },
      el('span', { class: 'twisty' }), cb, fav,
      el('span', { class: 'label title', onclick: () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); } }, t.title || t.url || '(untitled)'),
      t.pinned ? el('span', { class: 'badge' }, 'pinned') : null,
      el('span', { class: 'url' }, safeHref ? el('a', { href: safeHref, target: '_blank', rel: 'noopener noreferrer' }, t.url) : t.url)));
}

function updateSelectionUi() {
  // Sync group checkboxes (checked / indeterminate) with the selection.
  for (const cb of document.querySelectorAll('#tree input[data-keys]')) {
    const keys = JSON.parse(cb.dataset.keys);
    const n = keys.filter((k) => state.selected.has(k)).length;
    cb.checked = keys.length > 0 && n === keys.length;
    cb.indeterminate = n > 0 && n < keys.length;
    cb.disabled = keys.length === 0;
  }
  for (const cb of document.querySelectorAll('#tree input[data-tab]')) cb.checked = state.selected.has(cb.dataset.tab);
  const n = state.selected.size;
  $('#sel-count').textContent = `${n} selected`;
  const hasTarget = !!$('#target').value;
  $('#btn-open').disabled = !n || !hasTarget;
  $('#btn-move').disabled = !n || !hasTarget;
  $('#btn-close').disabled = !n;
  $('#btn-snapshot').disabled = !n;
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
$('#target').addEventListener('change', () => { localStorage.setItem('tabRelayTarget', $('#target').value); updateSelectionUi(); });

function renderSnapshots() {
  const box = $('#snapshots');
  box.textContent = '';
  if (!state.snapshots.length) { box.textContent = 'No snapshots yet.'; return; }
  for (const s of state.snapshots) {
    const sel = el('select', { title: 'Restore target' });
    targetOptions(sel);
    const open = state.openSnaps.has(s.id);
    const list = el('ul', { hidden: !open }, s.tabs.map((t) =>
      el('li', { title: `${t.url}\nfrom ${t.source?.machine} — ${t.source?.email || 'not signed in'}` }, t.title || t.url)));
    box.append(el('div', { class: 'snap' },
      el('div', { class: 'head' },
        el('span', { class: 'name', title: 'Show tabs', onclick: () => {
          list.hidden = !list.hidden;
          list.hidden ? state.openSnaps.delete(s.id) : state.openSnaps.add(s.id);
        } }, `${s.name}`),
        el('span', { class: 'badge' }, `${s.tabs.length}`),
        el('button', { class: 'link danger', title: 'Delete snapshot', onclick: async () => {
          if (!confirm(`Delete snapshot "${s.name}"?`)) return;
          await api('DELETE', `/api/snapshots/${s.id}`).catch((e) => flash(e.message, true));
          refresh();
        } }, '✕')),
      el('div', { class: 'muted', style: 'font-size:12px' }, new Date(s.createdAt).toLocaleString()),
      el('div', { class: 'head', style: 'margin-top:4px' }, sel,
        el('button', { onclick: async () => {
          if (!sel.value) return;
          try {
            await api('POST', `/api/snapshots/${s.id}/restore`, { targetClientId: sel.value, newWindow: true });
            flash(`Restoring "${s.name}" (${s.tabs.length} tabs) on ${sel.options[sel.selectedIndex].text.slice(2)}`);
            refresh();
          } catch (e) { flash(e.message, true); }
        } }, 'Restore')),
      list));
  }
}

function renderCommands() {
  const box = $('#commands');
  box.textContent = '';
  if (!state.commands.length) { box.textContent = 'None yet.'; return; }
  for (const c of state.commands) {
    const n = c.type === 'open' ? c.payload.tabs?.length : c.payload.tabIds?.length;
    box.append(el('div', { class: 'cmd', title: c.result ? JSON.stringify(c.result) : '' },
      el('span', { class: `st-${c.status}` }, c.status),
      el('span', {}, `${c.type} ${n} on ${c.client.machine || '?'} (${c.client.email || 'not signed in'})`),
      el('span', { class: 'muted', style: 'margin-left:auto' }, new Date(c.createdAt).toLocaleTimeString())));
  }
}

// ---------- actions ----------
function targetText() { const s = $('#target'); return s.options[s.selectedIndex]?.text.slice(2) || ''; }

async function doAction(fn, okText) {
  try {
    await fn();
    flash(okText);
    state.selected.clear();
    await refresh();
  } catch (e) { flash(e.message, true); }
}

$('#btn-open').addEventListener('click', () => {
  const tabs = selectedRefs();
  doAction(() => api('POST', '/api/actions/open', { tabs, targetClientId: $('#target').value, newWindow: $('#new-window').checked }),
    `Opening ${tabs.length} tab(s) on ${targetText()}`);
});
$('#btn-move').addEventListener('click', () => {
  const tabs = selectedRefs();
  doAction(() => api('POST', '/api/actions/move', { tabs, targetClientId: $('#target').value, newWindow: $('#new-window').checked }),
    `Moving ${tabs.length} tab(s) to ${targetText()} (sources close after they open)`);
});
$('#btn-close').addEventListener('click', () => {
  const tabs = selectedRefs();
  if (!confirm(`Close ${tabs.length} tab(s) on their source machines?`)) return;
  doAction(() => api('POST', '/api/actions/close', { tabs }), `Closing ${tabs.length} tab(s)`);
});
$('#btn-snapshot').addEventListener('click', () => {
  const tabs = selectedRefs();
  const name = prompt('Snapshot name:', `Snapshot ${new Date().toLocaleString()}`);
  if (name === null) return;
  doAction(() => api('POST', '/api/snapshots', { tabs, name }), `Saved snapshot "${name}" (${tabs.length} tabs)`);
});
$('#filter').addEventListener('input', (e) => { state.filter = e.target.value.trim(); renderTree(); updateSelectionUi(); });
$('#btn-expand').addEventListener('click', () => {
  state.collapsed.clear();
  localStorage.setItem('tabRelayCollapsed', '[]');
  renderTree(); updateSelectionUi();
});
$('#btn-collapse').addEventListener('click', () => {
  for (const n of document.querySelectorAll('#tree .node:not(.leaf)')) {
    if (!n.classList.contains('machine')) state.collapsed.add(n.dataset.key);
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

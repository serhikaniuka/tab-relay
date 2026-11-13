'use strict';

const $ = (id) => document.getElementById(id);
const FIELDS = ['serverUrl', 'token', 'machine', 'profileLabel'];

async function load() {
  const { config = {}, clientId, status = {} } = await chrome.storage.local.get(['config', 'clientId', 'status']);
  for (const f of FIELDS) $(f).value = config[f] || '';
  $('clientId').textContent = clientId || '(created on first sync)';
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    $('account').textContent = info.email || 'not signed in';
  } catch (e) {
    $('account').textContent = `unavailable (${e.message})`;
  }
  showStatus(status);
}

function showStatus(s) {
  $('lastPush').textContent = s.lastPush ? `${new Date(s.lastPush).toLocaleString()} (${s.tabs ?? '?'} tabs)` : 'never';
  const errNewer = s.lastError && (!s.lastPush || (s.lastErrorAt || 0) > s.lastPush);
  $('lastError').textContent = errNewer ? `${s.lastError} (${new Date(s.lastErrorAt).toLocaleTimeString()})` : '—';
  $('lastError').className = errNewer ? 'err' : '';
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const config = {};
  for (const f of FIELDS) config[f] = $(f).value.trim();
  config.serverUrl = config.serverUrl.replace(/\/+$/, '');
  const result = $('result');

  // Host permission for the server origin (avoids CORS/private-network issues). Must run in the click handler.
  let origin;
  try { origin = new URL(config.serverUrl).origin + '/*'; } catch (err) {
    result.className = 'err'; result.textContent = 'Invalid server URL'; return;
  }
  try { await chrome.permissions.request({ origins: [origin] }); } catch (err) { /* fall back to CORS */ }

  await chrome.storage.local.set({ config });
  result.className = ''; result.textContent = 'Saved. Syncing…';
  const r = await chrome.runtime.sendMessage({ type: 'sync-now' });
  if (r?.ok) { result.className = 'ok'; result.textContent = `Connected. Sent ${r.tabs} tabs.`; }
  else { result.className = 'err'; result.textContent = `Saved, but sync failed: ${r?.error || 'no response'}`; }
  load();
});

$('openUi').addEventListener('click', async () => {
  const { config = {} } = await chrome.storage.local.get('config');
  if (!config.serverUrl) return;
  chrome.tabs.create({ url: `${config.serverUrl.replace(/\/+$/, '')}/#token=${encodeURIComponent(config.token || '')}` });
});

chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.status) showStatus(ch.status.newValue || {}); });
load();

'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createApp, REDELIVER_MS } = require('../src/app');

const TOKEN = 'test-token';
let server, base, offlineDir, clock = 1_700_000_000_000;
const MAX_OFFLINE = 64 * 1024;

before(async () => {
  offlineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-relay-test-'));
  const app = createApp({ db: openDb(':memory:'), token: TOKEN, now: () => clock, offlineDir, maxOfflineBytes: MAX_OFFLINE, metaFetch: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(offlineDir, { recursive: true, force: true });
});

async function api(method, path, body, token = TOKEN) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

function state(machine, email, tabs) {
  return {
    machine,
    profile: { email, label: email ? 'Person 1' : 'Default' },
    windows: [{ id: 1, focused: true, tabs: tabs.map((t, i) => ({ id: 100 + i, index: i, ...t })) }],
  };
}

test('serves the web UI and health without auth', async () => {
  const ui = await api('GET', '/', undefined, null);
  assert.equal(ui.status, 200);
  assert.match(ui.body, /Tab Relay/);
  assert.equal((await api('GET', '/api/health', undefined, null)).status, 200);
});

test('rejects API calls without a valid token', async () => {
  assert.equal((await api('GET', '/api/tree', undefined, null)).status, 401);
  assert.equal((await api('GET', '/api/tree', undefined, 'wrong')).status, 401);
});

test('state push builds the tree', async () => {
  let r = await api('POST', '/api/clients/mac-1/state', state('MacBook', 'me@gmail.com', [
    { url: 'https://example.com/a', title: 'A', pinned: true, active: true },
    { url: 'https://example.com/b', title: 'B' },
  ]));
  assert.equal(r.status, 200);
  assert.equal(r.body.tabs, 2);
  r = await api('POST', '/api/clients/dev-1/state', state('devbox', '', [{ url: 'https://example.org/', title: 'Org' }]));
  assert.equal(r.status, 200);

  r = await api('GET', '/api/tree');
  assert.equal(r.status, 200);
  const mac = r.body.clients.find((c) => c.id === 'mac-1');
  assert.equal(mac.machine, 'MacBook');
  assert.equal(mac.profile.email, 'me@gmail.com');
  assert.equal(mac.profile.signedIn, true);
  assert.equal(mac.online, true);
  assert.equal(mac.windows.length, 1);
  assert.deepEqual(mac.windows[0].tabs.map((t) => t.title), ['A', 'B']);
  assert.equal(mac.windows[0].tabs[0].pinned, true);
  const dev = r.body.clients.find((c) => c.id === 'dev-1');
  assert.equal(dev.profile.signedIn, false);
});

test('state push replaces previous tabs', async () => {
  await api('POST', '/api/clients/tmp/state', state('tmp', '', [{ url: 'https://x/1' }, { url: 'https://x/2' }]));
  await api('POST', '/api/clients/tmp/state', state('tmp', '', [{ url: 'https://x/3' }]));
  const r = await api('GET', '/api/tree');
  const c = r.body.clients.find((x) => x.id === 'tmp');
  assert.deepEqual(c.windows[0].tabs.map((t) => t.url), ['https://x/3']);
  assert.equal((await api('DELETE', '/api/clients/tmp')).status, 200);
  assert.ok(!(await api('GET', '/api/tree')).body.clients.some((x) => x.id === 'tmp'));
});

test('clients go offline after 30s without contact', async () => {
  clock += 31_000;
  let r = await api('GET', '/api/tree');
  assert.ok(r.body.clients.every((c) => !c.online));
  await api('GET', '/api/clients/mac-1/commands'); // polling counts as contact
  r = await api('GET', '/api/tree');
  assert.equal(r.body.clients.find((c) => c.id === 'mac-1').online, true);
  await api('POST', '/api/clients/dev-1/state', state('devbox', '', [{ url: 'https://example.org/', title: 'Org' }]));
});

test('open command is delivered once, re-delivered if unacked, and acked', async () => {
  let r = await api('POST', '/api/actions/open', {
    targetClientId: 'dev-1', newWindow: true, tabs: [{ clientId: 'mac-1', tabId: 100 }],
  });
  assert.equal(r.status, 201);
  const [id] = r.body.commands;

  r = await api('GET', '/api/clients/dev-1/commands');
  assert.equal(r.body.commands.length, 1);
  assert.equal(r.body.commands[0].type, 'open');
  assert.deepEqual(r.body.commands[0].payload, { tabs: [{ url: 'https://example.com/a', pinned: true }], newWindow: true });

  r = await api('GET', '/api/clients/dev-1/commands');
  assert.equal(r.body.commands.length, 0, 'not re-sent immediately');

  clock += REDELIVER_MS + 1;
  r = await api('GET', '/api/clients/dev-1/commands');
  assert.equal(r.body.commands.length, 1, 're-sent after timeout');

  assert.equal((await api('POST', `/api/commands/${id}/ack`, { ok: true, result: { opened: 1 } })).status, 200);
  clock += REDELIVER_MS + 1;
  r = await api('GET', '/api/clients/dev-1/commands');
  assert.equal(r.body.commands.length, 0);

  r = await api('GET', '/api/commands');
  const cmd = r.body.commands.find((c) => c.id === id);
  assert.equal(cmd.status, 'done');
  assert.deepEqual(cmd.result, { opened: 1 });
});

test('close action groups by source client', async () => {
  const r = await api('POST', '/api/actions/close', {
    tabs: [{ clientId: 'mac-1', tabId: 101 }, { clientId: 'dev-1', tabId: 100 }, { clientId: 'mac-1', tabId: 999 }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.commands.length, 2);
  const mac = (await api('GET', '/api/clients/mac-1/commands')).body.commands;
  assert.deepEqual(mac.map((c) => c.payload), [{ tabIds: [101], reason: 'delete' }]);
  const dev = (await api('GET', '/api/clients/dev-1/commands')).body.commands;
  assert.deepEqual(dev.map((c) => c.payload), [{ tabIds: [100], reason: 'delete' }]);
  for (const c of [...mac, ...dev]) await api('POST', `/api/commands/${c.id}/ack`, { ok: true });
});

test('move closes the source only after the open succeeds', async () => {
  let r = await api('POST', '/api/actions/move', {
    targetClientId: 'dev-1', tabs: [{ clientId: 'mac-1', tabId: 100 }, { clientId: 'mac-1', tabId: 101 }],
  });
  assert.equal(r.status, 201);
  const [openId, closeId] = r.body.commands;

  assert.equal((await api('GET', '/api/clients/mac-1/commands')).body.commands.length, 0, 'close waits for open');
  const dev = (await api('GET', '/api/clients/dev-1/commands')).body.commands;
  assert.equal(dev[0].id, openId);
  assert.equal(dev[0].payload.tabs.length, 2);
  await api('POST', `/api/commands/${openId}/ack`, { ok: true });

  const mac = (await api('GET', '/api/clients/mac-1/commands')).body.commands;
  assert.equal(mac.length, 1);
  assert.equal(mac[0].id, closeId);
  assert.deepEqual(mac[0].payload.tabIds, [100, 101]);
  await api('POST', `/api/commands/${closeId}/ack`, { ok: true });
});

test('failed open cancels the dependent close', async () => {
  const r = await api('POST', '/api/actions/move', { targetClientId: 'dev-1', tabs: [{ clientId: 'mac-1', tabId: 100 }] });
  const [openId, closeId] = r.body.commands;
  await api('GET', '/api/clients/dev-1/commands');
  await api('POST', `/api/commands/${openId}/ack`, { ok: false, error: 'boom' });
  assert.equal((await api('GET', '/api/clients/mac-1/commands')).body.commands.length, 0);
  const cmds = (await api('GET', '/api/commands')).body.commands;
  assert.equal(cmds.find((c) => c.id === closeId).status, 'cancelled');
  assert.equal(cmds.find((c) => c.id === openId).status, 'failed');
});

test('generic command endpoint validates input', async () => {
  assert.equal((await api('POST', '/api/commands', { clientId: 'nope', type: 'open', urls: ['https://a'] })).status, 404);
  assert.equal((await api('POST', '/api/commands', { clientId: 'dev-1', type: 'bogus' })).status, 400);
  assert.equal((await api('POST', '/api/commands', { clientId: 'dev-1', type: 'open', urls: [] })).status, 400);
  assert.equal((await api('POST', '/api/commands', { clientId: 'dev-1', type: 'close', tabIds: [] })).status, 400);
  const r = await api('POST', '/api/commands', { clientId: 'dev-1', type: 'open', urls: ['https://a.example/'] });
  assert.equal(r.status, 201);
  const cmds = (await api('GET', '/api/clients/dev-1/commands')).body.commands;
  assert.deepEqual(cmds[0].payload, { tabs: [{ url: 'https://a.example/', pinned: false }], newWindow: false });
  await api('POST', `/api/commands/${cmds[0].id}/ack`, { ok: true });
});

test('snapshots: save, list, restore, delete', async () => {
  let r = await api('POST', '/api/snapshots', {
    name: 'Work', tabs: [{ clientId: 'mac-1', tabId: 100 }, { clientId: 'dev-1', tabId: 100 }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.count, 2);
  const sid = r.body.id;

  r = await api('GET', '/api/snapshots');
  const snap = r.body.snapshots.find((s) => s.id === sid);
  assert.equal(snap.name, 'Work');
  assert.equal(snap.tabs[0].source.machine, 'MacBook');
  assert.equal(snap.tabs[1].source.machine, 'devbox');

  r = await api('POST', `/api/snapshots/${sid}/restore`, { targetClientId: 'mac-1' });
  assert.equal(r.status, 201);
  const cmds = (await api('GET', '/api/clients/mac-1/commands')).body.commands;
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].payload.newWindow, true);
  assert.deepEqual(cmds[0].payload.tabs.map((t) => t.url), ['https://example.com/a', 'https://example.org/']);

  assert.equal((await api('DELETE', `/api/snapshots/${sid}`)).status, 200);
  assert.equal((await api('DELETE', `/api/snapshots/${sid}`)).status, 404);
  assert.equal((await api('POST', '/api/snapshots', { tabs: [{ clientId: 'x', tabId: 1 }] })).status, 404);
});

// ---------- phase 2: move layout, closing markers, archive, offline ----------

// Shaped like Chrome's pageCapture output: QP-encoded root HTML, a cid: stylesheet and a base64 image.
const MHTML = [
  'From: <Saved by Blink>',
  'Snapshot-Content-Location: https://example.com/a',
  'Subject: Hello',
  'MIME-Version: 1.0',
  'Content-Type: multipart/related;',
  '\ttype="text/html";',
  '\tboundary="----B--"',
  '',
  '',
  '------B--',
  'Content-Type: text/html',
  'Content-ID: <frame-1@mhtml.blink>',
  'Content-Transfer-Encoding: quoted-printable',
  'Content-Location: https://example.com/a',
  '',
  '<html><head><meta charset=3D"utf-8"><link rel=3D"stylesheet" href=3D"cid:css-1@mhtml.b=',
  'link"></head><body><h1>Hello offline =C3=BC</h1><img src=3D"https://example.com/i.png?a=3D1&amp;b=3D2"><a href=3D"/next">next</a></body></html>',
  '------B--',
  'Content-Type: text/css',
  'Content-Transfer-Encoding: quoted-printable',
  'Content-Location: cid:css-1@mhtml.blink',
  '',
  'h1 { background: url("https://example.com/i.png?a=3D1&b=3D2"); }',
  '------B--',
  'Content-Type: image/png',
  'Content-Transfer-Encoding: base64',
  'Content-Location: https://example.com/i.png?a=1&b=2',
  '',
  Buffer.from('PNGDATA').toString('base64'),
  '------B----',
  '',
].join('\r\n');

async function upload(clientId, query, body = MHTML, headers = {}) {
  const res = await fetch(`${base}/api/clients/${clientId}/offline?${new URLSearchParams(query)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'multipart/related', ...headers },
    body,
  });
  return { status: res.status, body: await res.json() };
}

async function drain(clientId, ok = true) {
  const cmds = (await api('GET', `/api/clients/${clientId}/commands`)).body.commands;
  for (const c of cmds) await api('POST', `/api/commands/${c.id}/ack`, { ok });
  return cmds;
}

test('two-window client: move with newWindow keeps the window layout', async () => {
  await api('POST', '/api/clients/lap-1/state', {
    machine: 'Laptop', profile: { email: 'work@corp.com', label: 'Work' },
    windows: [
      { id: 7, tabs: [{ id: 1, index: 0, url: 'https://w7/1' }, { id: 2, index: 1, url: 'https://w7/2' }] },
      { id: 8, tabs: [{ id: 3, index: 0, url: 'https://w8/1' }] },
    ],
  });
  const tabs = [1, 2, 3].map((tabId) => ({ clientId: 'lap-1', tabId }));
  const r = await api('POST', '/api/actions/move', { targetClientId: 'dev-1', newWindow: true, tabs });
  const [openId, closeId] = r.body.commands;

  // Tree marks the source tabs as being moved.
  const lap = (await api('GET', '/api/tree')).body.clients.find((c) => c.id === 'lap-1');
  assert.deepEqual(lap.windows.flatMap((w) => w.tabs.map((t) => t.closing)), ['move', 'move', 'move']);

  const [open] = await drain('dev-1');
  assert.equal(open.id, openId);
  assert.deepEqual(open.payload.windows.map((w) => w.map((t) => t.url)), [['https://w7/1', 'https://w7/2'], ['https://w8/1']]);
  const [close] = await drain('lap-1');
  assert.equal(close.id, closeId);
  assert.deepEqual(close.payload, { tabIds: [1, 2, 3], reason: 'move' });
});

test('archive without offline: items stored, source closed', async () => {
  const r = await api('POST', '/api/actions/archive', { tabs: [{ clientId: 'lap-1', tabId: 1 }, { clientId: 'lap-1', tabId: 3 }] });
  assert.equal(r.status, 201);
  assert.equal(r.body.archived.length, 2);
  assert.equal(r.body.commands.length, 1);

  const items = (await api('GET', '/api/archive')).body.items;
  const mine = items.filter((a) => r.body.archived.includes(a.id));
  assert.deepEqual(mine.map((a) => a.url).sort(), ['https://w7/1', 'https://w8/1']);
  assert.equal(mine[0].source.machine, 'Laptop');
  assert.equal(mine[0].source.email, 'work@corp.com');
  assert.equal(mine[0].offline, null);
  assert.equal(mine[0].archivedAt, clock);

  const cmds = await drain('lap-1');
  assert.deepEqual(cmds.map((c) => [c.type, c.payload.reason]), [['close', 'archive']]);
});

test('archive + offline: capture first, upload links the copy, close follows even if capture failed', async () => {
  const r = await api('POST', '/api/actions/archive', { offline: true, tabs: [{ clientId: 'lap-1', tabId: 2 }, { clientId: 'lap-1', tabId: 3 }] });
  const [captureId, closeId] = r.body.commands;
  const [aid2, aid3] = r.body.archived;

  let cmds = (await api('GET', '/api/clients/lap-1/commands')).body.commands;
  assert.deepEqual(cmds.map((c) => c.id), [captureId], 'close waits for the capture');
  assert.equal(cmds[0].type, 'capture');
  assert.deepEqual(cmds[0].payload.tabIds, [2, 3]);
  assert.equal(cmds[0].payload.archiveMap[2], aid2);

  const up = await upload('lap-1', { tabId: 2, commandId: captureId }, MHTML,
    { 'x-tab-url': encodeURIComponent('https://w7/2?q=ü'), 'x-tab-title': encodeURIComponent('Заголовок') });
  assert.equal(up.status, 201);
  assert.equal(up.body.size, Buffer.byteLength(MHTML));

  // Tab 3 could not be captured: the capture is acked as failed, the close still runs ('finish' dependency).
  await api('POST', `/api/commands/${captureId}/ack`, { ok: false, error: 'cannot capture' });
  cmds = (await api('GET', '/api/clients/lap-1/commands')).body.commands;
  assert.deepEqual(cmds.map((c) => c.id), [closeId]);
  await api('POST', `/api/commands/${closeId}/ack`, { ok: true });

  const items = (await api('GET', '/api/archive')).body.items;
  const a2 = items.find((a) => a.id === aid2);
  const a3 = items.find((a) => a.id === aid3);
  assert.deepEqual(a2.offline, { id: up.body.id, size: Buffer.byteLength(MHTML) });
  assert.equal(a3.offline, null);

  const off = (await api('GET', '/api/offline')).body;
  const copy = off.items.find((o) => o.id === up.body.id);
  assert.equal(copy.url, 'https://w7/2?q=ü');
  assert.equal(copy.title, 'Заголовок');
  assert.equal(copy.source.machine, 'Laptop');
  assert.equal(off.totalSize, Buffer.byteLength(MHTML));
});

test('archive restore: grouped by source window, removed from archive after a successful open', async () => {
  const items = (await api('GET', '/api/archive')).body.items;
  const ids = items.map((a) => a.id);
  assert.equal(ids.length, 4);

  // remove:false keeps the items
  let r = await api('POST', '/api/archive/restore', { ids: [ids[0]], targetClientId: 'dev-1', remove: false });
  await drain('dev-1');
  assert.equal((await api('GET', '/api/archive')).body.items.length, 4);

  r = await api('POST', '/api/archive/restore', { ids, targetClientId: 'dev-1' });
  assert.equal(r.status, 201);
  const [open] = (await api('GET', '/api/clients/dev-1/commands')).body.commands;
  assert.equal(open.payload.newWindow, true);
  assert.equal(open.payload.tabs.length, 4);
  assert.ok(open.payload.windows.length >= 2, 'one new window per source window/batch');
  assert.equal((await api('GET', '/api/archive')).body.items.length, 4, 'kept until the open is acked');
  await api('POST', `/api/commands/${open.id}/ack`, { ok: true });
  assert.equal((await api('GET', '/api/archive')).body.items.length, 0);
  // The offline copy survives a restore.
  assert.equal((await api('GET', '/api/offline')).body.items.length, 1);

  assert.equal((await api('POST', '/api/archive/restore', { ids: [999], targetClientId: 'dev-1' })).status, 404);
  assert.equal((await api('POST', '/api/archive/restore', { ids, targetClientId: 'nope' })).status, 404);
});

test('offline view/raw/download: token via header or query param only on those routes', async () => {
  const { id } = (await api('GET', '/api/offline')).body.items[0];

  let res = await fetch(`${base}/api/offline/${id}/view`);
  assert.equal(res.status, 401);
  res = await fetch(`${base}/api/offline/${id}/view?token=wrong`);
  assert.equal(res.status, 401);

  // Raw archive as multipart/related.
  res = await fetch(`${base}/api/offline/${id}/raw?token=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^multipart\/related/);
  assert.equal(await res.text(), MHTML);

  // Rendered view: unpacked HTML, sandboxed, references rewritten to parts of the same copy.
  res = await fetch(`${base}/api/offline/${id}/view?token=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'none'/);
  const html = await res.text();
  assert.match(html, /<h1>Hello offline ü<\/h1>/);
  assert.match(html, /<base href="https:\/\/example.com\/a">/);
  const res1 = `${base}/api/offline/${id}/res/1?token=${TOKEN}`;
  const res2 = `${base}/api/offline/${id}/res/2?token=${TOKEN}`;
  assert.ok(html.includes(`href="${res1}"`), 'stylesheet cid: rewritten');
  assert.ok(html.includes(`src="${res2}"`), 'image URL (&amp;-escaped in HTML) rewritten');
  assert.ok(html.includes('href="/next"'), 'ordinary links untouched');

  res = await fetch(res1);
  assert.match(res.headers.get('content-type'), /^text\/css/);
  assert.equal(await res.text(), `h1 { background: url("${res2}"); }`);
  res = await fetch(res2);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(await res.text(), 'PNGDATA');
  assert.equal((await fetch(`${base}/api/offline/${id}/res/99?token=${TOKEN}`)).status, 404);

  res = await fetch(`${base}/api/offline/${id}/download?token=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename=.*\.mhtml/);

  // The query token is not accepted elsewhere.
  assert.equal((await fetch(`${base}/api/tree?token=${TOKEN}`)).status, 401);
  assert.equal((await fetch(`${base}/api/offline?token=${TOKEN}`)).status, 401);
  assert.equal((await fetch(`${base}/api/offline/9999/view?token=${TOKEN}`)).status, 404);
});

test('offline view falls back to the raw file when it is not a parseable archive', async () => {
  const up = await upload('mac-1', { tabId: 101 }, 'just some bytes');
  const res = await fetch(`${base}/api/offline/${up.body.id}/view?token=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^multipart\/related/);
  assert.equal((await api('DELETE', `/api/offline/${up.body.id}`)).status, 200);
});

test('save offline action, size limit, and deleting copies', async () => {
  const r = await api('POST', '/api/actions/offline', { tabs: [{ clientId: 'mac-1', tabId: 100 }, { clientId: 'dev-1', tabId: 100 }] });
  assert.equal(r.status, 201);
  assert.equal(r.body.commands.length, 2);
  const [cap] = (await api('GET', '/api/clients/mac-1/commands')).body.commands;
  assert.deepEqual([cap.type, cap.payload.tabIds], ['capture', [100]]);

  // Without URL headers the server falls back to the stored tab's url/title.
  const up = await upload('mac-1', { tabId: 100, commandId: cap.id });
  assert.equal(up.status, 201);
  await api('POST', `/api/commands/${cap.id}/ack`, { ok: true });
  await drain('dev-1');
  let off = (await api('GET', '/api/offline')).body;
  const copy = off.items.find((o) => o.id === up.body.id);
  assert.equal(copy.url, 'https://example.com/a');
  assert.equal(copy.title, 'A');
  assert.equal(fs.readdirSync(offlineDir).filter((f) => f.endsWith('.mhtml')).length, 2);

  assert.equal((await upload('mac-1', { tabId: 100 }, 'x'.repeat(MAX_OFFLINE + 1))).status, 413);
  assert.equal((await upload('mac-1', { tabId: 100 }, '')).status, 400);
  assert.equal((await upload('nope', { tabId: 1 })).status, 404);
  assert.deepEqual(fs.readdirSync(offlineDir).filter((f) => !f.endsWith('.mhtml')), [], 'no leftover partial files');

  assert.equal((await api('DELETE', `/api/offline/${up.body.id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/offline/${up.body.id}`)).status, 404);
  off = (await api('GET', '/api/offline')).body;
  assert.equal(off.items.length, 1);
  assert.equal(fs.readdirSync(offlineDir).filter((f) => f.endsWith('.mhtml')).length, 1);
});

test('archive delete removes items and their offline copies', async () => {
  await api('POST', '/api/clients/lap-1/state', {
    machine: 'Laptop', profile: { email: 'work@corp.com', label: 'Work' },
    windows: [{ id: 9, tabs: [{ id: 20, index: 0, url: 'https://keep/1', title: 'K' }] }],
  });
  const r = await api('POST', '/api/actions/archive', { offline: true, tabs: [{ clientId: 'lap-1', tabId: 20 }] });
  const up = await upload('lap-1', { tabId: 20, commandId: r.body.commands[0] });
  await drain('lap-1');
  await drain('lap-1');
  const before = fs.readdirSync(offlineDir).length;

  const del = await api('POST', '/api/archive/delete', { ids: r.body.archived });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, 1);
  assert.equal((await api('GET', '/api/archive')).body.items.length, 0);
  assert.ok(!(await api('GET', '/api/offline')).body.items.some((o) => o.id === up.body.id));
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(fs.readdirSync(offlineDir).length, before - 1);
  assert.equal((await api('POST', '/api/archive/delete', { ids: [] })).status, 400);
});

// ---------- phase 3: duplicate / stale clients ----------

test('duplicate clients for one profile are kept as-is on push (no heuristic auto-dedupe)', async () => {
  const st = (id) => api('POST', `/api/clients/${id}/state`, {
    machine: 'devbox', profile: { email: '', label: 'personal' },
    windows: [{ id: 1, tabs: [{ id: 1, index: 0, url: 'https://dup/1' }] }],
  });
  await st('dup-stale');
  clock += 1000;
  await st('dup-live');
  clock += 60_000;
  await st('dup-live');
  const clients = (await api('GET', '/api/tree')).body.clients.filter((c) => c.machine === 'devbox' && c.profile.label === 'personal');
  assert.deepEqual(clients.map((c) => [c.id, c.online]).sort(), [['dup-live', true], ['dup-stale', false]]);
});

test('DELETE /api/clients/:id removes the client, its tabs and commands; keeps archive and offline copies', async () => {
  // dup-stale gets: a tab, an archive item + offline copy, a pending command, and is the
  // dependency of another client's pending command (move: close on dup-live waits for open on dup-stale).
  await api('POST', '/api/clients/dup-stale/state', {
    machine: 'devbox', profile: { email: '', label: 'personal' },
    windows: [{ id: 1, tabs: [{ id: 1, index: 0, url: 'https://dup/1' }, { id: 2, index: 1, url: 'https://dup/2' }] }],
  });
  const arch = await api('POST', '/api/actions/archive', { offline: true, tabs: [{ clientId: 'dup-stale', tabId: 2 }] });
  const up = await upload('dup-stale', { tabId: 2, commandId: arch.body.commands[0] });
  assert.equal(up.status, 201);
  const move = await api('POST', '/api/actions/move', { targetClientId: 'dup-stale', tabs: [{ clientId: 'dup-live', tabId: 1 }] });
  const [, dependentClose] = move.body.commands;

  const r = await api('DELETE', '/api/clients/dup-stale');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.removed, { windows: 1, tabs: 2, commands: 3, cancelledDependents: 1 });

  const tree = (await api('GET', '/api/tree')).body.clients;
  assert.ok(!tree.some((c) => c.id === 'dup-stale'));
  assert.ok(tree.some((c) => c.id === 'dup-live'), 'the other client is untouched');

  // The dependent close on dup-live is cancelled, not left dangling or delivered.
  const cmds = (await api('GET', '/api/commands?limit=50')).body.commands;
  assert.ok(!cmds.some((c) => c.clientId === 'dup-stale'));
  const dep = cmds.find((c) => c.id === dependentClose);
  assert.equal(dep.status, 'cancelled');
  assert.equal(dep.dependsOn, null);
  assert.equal((await api('GET', '/api/clients/dup-live/commands')).body.commands.length, 0);

  // Archive item and offline copy survive with their source info.
  const item = (await api('GET', '/api/archive')).body.items.find((a) => a.id === arch.body.archived[0]);
  assert.equal(item.source.clientId, 'dup-stale');
  assert.equal(item.source.machine, 'devbox');
  assert.equal(item.offline.id, up.body.id);
  const copy = (await api('GET', '/api/offline')).body.items.find((o) => o.id === up.body.id);
  assert.equal(copy.source.machine, 'devbox');
  assert.equal((await fetch(`${base}/api/offline/${up.body.id}/raw?token=${TOKEN}`)).status, 200);

  assert.equal((await api('DELETE', '/api/clients/dup-stale')).status, 404);
  assert.equal((await api('DELETE', '/api/clients/dup-stale', undefined, null)).status, 401);
  // A removed client that comes back simply re-registers.
  await api('POST', '/api/clients/dup-stale/state', { machine: 'devbox', windows: [] });
  assert.equal((await api('DELETE', '/api/clients/dup-stale')).status, 200);
});

test('POST /api/clients/prune removes only offline clients older than N days', async () => {
  await api('POST', '/api/clients/old-1/state', { machine: 'old', windows: [{ id: 1, tabs: [{ id: 1, url: 'https://old/' }] }] });
  clock += 3 * 86_400_000;
  await api('POST', '/api/clients/fresh-1/state', { machine: 'fresh', windows: [] });
  clock += 60_000;   // fresh-1 is now offline too, but only for a minute

  assert.equal((await api('POST', '/api/clients/prune', { olderThanDays: -1 })).status, 400);
  assert.equal((await api('POST', '/api/clients/prune', {})).status, 400);

  let r = await api('POST', '/api/clients/prune', { olderThanDays: 2 });
  assert.equal(r.status, 200);
  const removed = r.body.removed.map((c) => c.id);
  assert.ok(removed.includes('old-1'));
  assert.ok(!removed.includes('fresh-1'));
  assert.equal(r.body.removed.find((c) => c.id === 'old-1').tabs, 1);

  await api('POST', '/api/clients/live-1/state', { machine: 'live', windows: [] });
  r = await api('POST', '/api/clients/prune', { olderThanDays: 0 });   // every offline client
  assert.deepEqual(r.body.removed.map((c) => c.id), ['fresh-1']);
  assert.deepEqual((await api('GET', '/api/tree')).body.clients.map((c) => c.id), ['live-1']);
});

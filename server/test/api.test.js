'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, REDELIVER_MS } = require('../src/app');

const TOKEN = 'test-token';
let server, base, clock = 1_700_000_000_000;

before(async () => {
  const app = createApp({ db: openDb(':memory:'), token: TOKEN, now: () => clock });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

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
  assert.deepEqual(mac.map((c) => c.payload), [{ tabIds: [101] }]);
  const dev = (await api('GET', '/api/clients/dev-1/commands')).body.commands;
  assert.deepEqual(dev.map((c) => c.payload), [{ tabIds: [100] }]);
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

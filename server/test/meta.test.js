'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { extractDescription, clampDescription, isPrivateAddress, fetchDescription, MetaFetcher } = require('../src/meta');

// ---------- local test website ----------
const LONG = 'Tab Relay moves Chrome tabs between machines and keeps an archive of them on a small LAN server.';
const pages = {
  '/meta': '<html><head><meta content="Plain &amp; simple: the &quot;meta&quot; description." name="Description"><meta property="og:description" content="og loses"></head><body><p>' + LONG + '</p></body></html>',
  '/og': '<head><meta property="og:description" content=\'From Open Graph.\'></head>',
  '/twitter': '<head><meta name="twitter:description" content="From Twitter card."></head>',
  '/para': '<body><nav><p>Menu menu menu menu menu menu menu menu menu menu</p></nav><script>var p = "<p>not this one, it is inside a script tag</p>";</script><p>Too short.</p><p>' + LONG + ' <b>Bold</b> &mdash; done.</p></body>',
  '/none': '<body><p>short</p></body>',
};

let site, siteUrl;
function startSite() {
  site = http.createServer((req, res) => {
    const u = req.url;
    if (pages[u]) { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(pages[u]); }
    if (u === '/cp1251') {
      res.setHeader('content-type', 'text/html; charset=windows-1251');
      // "Опис сторінки" in windows-1251
      return res.end(Buffer.from([0x3c, 0x6d, 0x65, 0x74, 0x61, 0x20, 0x6e, 0x61, 0x6d, 0x65, 0x3d, 0x64, 0x65, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x69, 0x6f, 0x6e, 0x20, 0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74, 0x3d, 0x22,
        0xce, 0xef, 0xe8, 0xf1, 0x20, 0xf1, 0xf2, 0xee, 0xf0, 0xb3, 0xed, 0xea, 0xe8, 0x22, 0x3e]));
    }
    if (u === '/redirect') { res.writeHead(302, { location: '/og' }); return res.end(); }
    if (u === '/loop') { res.writeHead(301, { location: '/loop' }); return res.end(); }
    if (u === '/to-ftp') { res.writeHead(302, { location: 'ftp://example.com/x' }); return res.end(); }
    if (u === '/image') { res.setHeader('content-type', 'image/png'); return res.end('PNG'); }
    if (u === '/slow') { setTimeout(() => { res.setHeader('content-type', 'text/html'); res.end(pages['/og']); }, 2000); return; }
    if (u === '/endless') {
      // Description up front, then a body that never ends: the fetch must stop at the size cap.
      res.setHeader('content-type', 'text/html');
      res.write('<head><meta name="description" content="Head of an endless page."></head><body>');
      const t = setInterval(() => { if (!res.write('x'.repeat(16384))) {} }, 1);
      res.on('close', () => clearInterval(t));
      return;
    }
    res.statusCode = 404;
    res.end('nope');
  });
  return new Promise((r) => site.listen(0, '127.0.0.1', () => { siteUrl = `http://127.0.0.1:${site.address().port}`; r(); }));
}

before(startSite);
after(() => { site.closeAllConnections?.(); site.close(); });

// ---------- extraction ----------

test('extractDescription: meta, og, twitter, paragraph fallback, none', () => {
  assert.equal(extractDescription(pages['/meta']), 'Plain & simple: the "meta" description.');
  assert.equal(extractDescription(pages['/og']), 'From Open Graph.');
  assert.equal(extractDescription(pages['/twitter']), 'From Twitter card.');
  assert.equal(extractDescription(pages['/para']), `${LONG} Bold — done.`);
  assert.equal(extractDescription(pages['/none']), '');
  assert.equal(extractDescription('<p>Made by <a href="/g">Google</a>. It was launched in <b>2008</b> (for <i>Windows</i>), fast.</p>'),
    'Made by Google. It was launched in 2008 (for Windows), fast.');
  assert.equal(extractDescription('<meta name="description" content="   ">'), '');
  assert.equal(extractDescription(''), '');
});

test('clampDescription: ~200 chars, word boundary, ellipsis', () => {
  const s = 'word '.repeat(100);
  const c = clampDescription(s);
  assert.ok(c.length <= 200);
  assert.ok(c.endsWith('word…'));
  assert.equal(clampDescription('  a \n b  '), 'a b');
  assert.equal(extractDescription(`<meta name="description" content="${'x'.repeat(500)}">`).length, 200);
});

test('isPrivateAddress', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.103', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
    '::ffff:7f00:1', '::ffff:c0a8:167', 'not-an-ip']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

// ---------- guarded fetch ----------

test('fetchDescription refuses private/loopback hosts by default', async () => {
  await assert.rejects(fetchDescription(`${siteUrl}/meta`), /blocked/);
  await assert.rejects(fetchDescription(`http://localhost:${site.address().port}/meta`), /blocked/);
  await assert.rejects(fetchDescription(`http://[::1]:${site.address().port}/meta`), /blocked/);
  await assert.rejects(fetchDescription(`http://2130706433:${site.address().port}/meta`), /blocked/);   // 127.0.0.1 as a number
  await assert.rejects(fetchDescription('http://192.168.1.103:8787/'), /blocked/);
  await assert.rejects(fetchDescription('file:///etc/passwd'), /only http/);
  await assert.rejects(fetchDescription('ftp://example.com/'), /only http/);
});

test('fetchDescription (private allowed for the local test site): parse, redirects, errors, limits', async () => {
  const opts = { allowPrivate: true };
  assert.equal(await fetchDescription(`${siteUrl}/meta`, opts), 'Plain & simple: the "meta" description.');
  assert.equal(await fetchDescription(`${siteUrl}/redirect`, opts), 'From Open Graph.');
  assert.equal(await fetchDescription(`${siteUrl}/para`, opts), `${LONG} Bold — done.`);
  assert.equal(await fetchDescription(`${siteUrl}/cp1251`, opts), 'Опис сторінки');
  assert.equal(await fetchDescription(`${siteUrl}/none`, opts), '');
  await assert.rejects(fetchDescription(`${siteUrl}/missing`, opts), /HTTP 404/);
  await assert.rejects(fetchDescription(`${siteUrl}/image`, opts), /not html/);
  await assert.rejects(fetchDescription(`${siteUrl}/loop`, opts), /too many redirects/);
  await assert.rejects(fetchDescription(`${siteUrl}/to-ftp`, opts), /only http/);

  let t = Date.now();
  await assert.rejects(fetchDescription(`${siteUrl}/slow`, { ...opts, timeoutMs: 300 }), /timeout/);
  assert.ok(Date.now() - t < 1500, 'deadline enforced');

  t = Date.now();
  assert.equal(await fetchDescription(`${siteUrl}/endless`, { ...opts, maxBytes: 64 * 1024 }), 'Head of an endless page.');
  assert.ok(Date.now() - t < 3000, 'stops reading at the size cap');
});

test('MetaFetcher: per-host rate limit, concurrency, bounded queue, stillMissing re-check', async () => {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const stored = new Map();
  const f = new MetaFetcher({
    delayMs: 0, perHostIntervalMs: 150, concurrency: 2, maxQueue: 5,
    fetchImpl: async (url) => {
      calls.push({ url, t: Date.now() });
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      if (url.includes('fail')) throw new Error('boom');
      return `desc of ${url}`;
    },
    store: (url, d, err) => stored.set(url, { d, err }),
    stillMissing: (url) => !url.includes('skip'),
  });
  for (const u of ['http://a/1', 'http://a/2', 'http://a/3', 'http://b/fail', 'http://b/skip']) assert.equal(f.enqueue(u), true);
  assert.equal(f.enqueue('http://c/over-limit'), false, 'queue bounded');
  assert.equal(f.enqueue('http://a/1'), false, 'no duplicates');
  assert.equal(f.enqueue('chrome://settings'), false, 'non-http ignored');
  await f.idle();

  const aTimes = calls.filter((c) => c.url.startsWith('http://a/')).map((c) => c.t);
  assert.equal(aTimes.length, 3);
  for (let i = 1; i < aTimes.length; i++) assert.ok(aTimes[i] - aTimes[i - 1] >= 140, `host spacing ${aTimes[i] - aTimes[i - 1]}`);
  assert.ok(maxInFlight <= 2);
  assert.ok(!calls.some((c) => c.url.includes('skip')), 'already described URLs are not fetched');
  assert.deepEqual(stored.get('http://a/2'), { d: 'desc of http://a/2', err: null });
  assert.deepEqual(stored.get('http://b/fail'), { d: '', err: 'boom' });
});

// ---------- through the API (page_meta) ----------

const TOKEN = 't';
async function withApp(metaFetch, fn) {
  const offlineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-relay-meta-'));
  const app = createApp({ db: openDb(':memory:'), token: TOKEN, offlineDir, metaFetch });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(typeof body === 'string' ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(api, app.locals.metaFetcher); } finally {
    app.locals.metaFetcher?.stop();
    server.close();
    fs.rmSync(offlineDir, { recursive: true, force: true });
  }
}

const push = (api, tabs) => api('POST', '/api/clients/c1/state', {
  machine: 'm', windows: [{ id: 1, tabs: tabs.map((t, i) => ({ id: i + 1, index: i, title: 'T', ...t })) }],
});

test('page_meta: extension descriptions stored per URL, fetch fallback for the rest, archive keeps them', async () => {
  await withApp({ allowPrivate: true, delayMs: 0, perHostIntervalMs: 0 }, async (api, fetcher) => {
    await push(api, [
      { url: `${siteUrl}/meta`, description: '  From the live   page.  ' },   // the extension read it
      { url: `${siteUrl}/og` },                                            // e.g. a discarded tab
      { url: `${siteUrl}/missing` },
      { url: 'chrome://settings/' },
    ]);
    await fetcher.idle();

    let m = (await api('GET', `/api/meta?url=${encodeURIComponent(`${siteUrl}/meta`)}`)).body;
    assert.deepEqual([m.description, m.source], ['From the live page.', 'page']);
    m = (await api('GET', `/api/meta?url=${encodeURIComponent(`${siteUrl}/og`)}`)).body;
    assert.deepEqual([m.description, m.source], ['From Open Graph.', 'fetch']);
    m = (await api('GET', `/api/meta?url=${encodeURIComponent(`${siteUrl}/missing`)}`)).body;
    assert.equal(m.description, '');
    assert.equal(m.fetchError, 'HTTP 404');
    assert.equal((await api('GET', `/api/meta?url=${encodeURIComponent('chrome://settings/')}`)).status, 404, 'non-http never fetched');
    assert.equal((await api('GET', '/api/meta')).status, 400);

    let tabs = (await api('GET', '/api/tree')).body.clients[0].windows[0].tabs;
    assert.deepEqual(tabs.map((t) => t.description), ['From the live page.', 'From Open Graph.', '', '']);

    // A failed fetch isn't retried on the next push (retry window), a described URL isn't refetched.
    await push(api, [{ url: `${siteUrl}/missing` }, { url: `${siteUrl}/og` }]);
    assert.equal(fetcher.pending.size, 0);

    // A later description from the live page replaces a fetched one; a fetch never replaces a page one.
    await push(api, [{ url: `${siteUrl}/og`, description: 'Fresh from the page.' }, { url: `${siteUrl}/meta` }]);
    await fetcher.idle();
    tabs = (await api('GET', '/api/tree')).body.clients[0].windows[0].tabs;
    assert.deepEqual(tabs.map((t) => t.description), ['Fresh from the page.', 'From the live page.']);

    // Archived tabs keep their description after the tab is gone.
    const arch = await api('POST', '/api/actions/archive', { tabs: [{ clientId: 'c1', tabId: 1 }, { clientId: 'c1', tabId: 2 }] });
    assert.equal(arch.status, 201);
    await push(api, []);
    const items = (await api('GET', '/api/archive')).body.items;
    assert.deepEqual(items.map((a) => a.description).sort(), ['Fresh from the page.', 'From the live page.']);
  });
});

test('page_meta: the default fetcher refuses LAN/loopback URLs', async () => {
  await withApp({ delayMs: 0, perHostIntervalMs: 0 }, async (api, fetcher) => {
    await push(api, [{ url: `${siteUrl}/meta` }]);
    await fetcher.idle();
    const m = (await api('GET', `/api/meta?url=${encodeURIComponent(`${siteUrl}/meta`)}`)).body;
    assert.equal(m.description, '');
    assert.match(m.fetchError, /blocked/);
  });
});

test('page_meta: an uploaded MHTML capture provides a description when there is none', async () => {
  await withApp(false, async (api) => {
    await push(api, [{ url: 'https://example.org/article' }, { url: 'https://example.org/described', description: 'Kept.' }]);
    const mhtml = (url, html) => ['From: <Saved by Blink>', `Snapshot-Content-Location: ${url}`,
      'Content-Type: multipart/related; type="text/html"; boundary="B"', '', '--B', 'Content-Type: text/html',
      'Content-Transfer-Encoding: quoted-printable', `Content-Location: ${url}`, '', html, '--B--', ''].join('\r\n');
    const up = (tabId, url, html) => api('POST', `/api/clients/c1/offline?tabId=${tabId}`, mhtml(url, html),
      { 'content-type': 'multipart/related', 'x-tab-url': encodeURIComponent(url) });
    assert.equal((await up(1, 'https://example.org/article', '<meta name=3D"description" content=3D"Captured description.">')).status, 201);
    assert.equal((await up(2, 'https://example.org/described', '<meta name=3D"description" content=3D"Not used.">')).status, 201);
    const tabs = (await api('GET', '/api/tree')).body.clients[0].windows[0].tabs;
    assert.deepEqual(tabs.map((t) => t.description), ['Captured description.', 'Kept.']);
    const off = (await api('GET', '/api/offline')).body.items;
    assert.deepEqual(off.map((o) => o.description).sort(), ['Captured description.', 'Kept.']);
    const m = (await api('GET', `/api/meta?url=${encodeURIComponent('https://example.org/article')}`)).body;
    assert.equal(m.source, 'mhtml');
  });
});

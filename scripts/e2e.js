const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
// End-to-end check: real Chromium + the unpacked extension + a throwaway server.
// Needs playwright-core and a Playwright Chromium build; not part of `npm test`:
//   npm i --no-save playwright-core && npx playwright-core install chromium
//   CHROME=/path/to/chromium node scripts/e2e.js
const path = require('path');
const os = require('os');
const REPO = path.resolve(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-relay-e2e-'));
const PORT = 8799, TOKEN = 'e2e-token', BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, p, b) => (await fetch(BASE + p, { method: m, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: b && JSON.stringify(b) })).json();
async function until(fn, what, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(300); } throw new Error('timeout: ' + what); }

(async () => {
  const srv = spawn('node', [REPO + '/server/src/index.js'], { env: { ...process.env, PORT, HOST: '127.0.0.1', TAB_RELAY_TOKEN: TOKEN, TAB_RELAY_DB: path.join(WORK, 'db.sqlite'), TAB_RELAY_ENV: path.join(WORK, '.env') }, stdio: 'inherit' });
  await sleep(800);
  const ud = path.join(WORK, 'profile');
  const ctx = await chromium.launchPersistentContext(ud, {
    executablePath: process.env.CHROME || undefined,
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${REPO}/extension`, `--load-extension=${REPO}/extension`],
  });
  try {
    let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    console.log('service worker:', sw.url());
    await sw.evaluate((c) => chrome.storage.local.set({ config: c }), { serverUrl: BASE, token: TOKEN, machine: 'e2e-machine', profileLabel: 'Test' });
    const p = await ctx.newPage(); await p.goto(BASE + '/api/health');
    const client = await until(async () => (await api('GET', '/api/tree')).clients.find((c) => c.windows.some((w) => w.tabs.some((t) => t.url.includes('/api/health')))), 'state push');
    console.log('client pushed:', client.machine, JSON.stringify(client.profile), client.windows.map((w) => w.tabs.map((t) => t.url)));

    const open = await api('POST', '/api/commands', { clientId: client.id, type: 'open', urls: [BASE + '/?opened=1', BASE + '/?opened=2'], newWindow: true });
    const cmd = await until(async () => (await api('GET', '/api/commands')).commands.find((c) => c.id === open.id && c.status !== 'pending' && c.status !== 'delivered'), 'open ack');
    console.log('open command:', cmd.status, JSON.stringify(cmd.result));
    if (process.env.DEBUG) console.log('TREE', JSON.stringify((await api('GET', '/api/tree')).clients[0].windows.map(w=>w.tabs.map(t=>t.url))));
    if (process.env.DEBUG) console.log('SWTABS', JSON.stringify(await sw.evaluate(async()=>(await chrome.windows.getAll({populate:true})).map(w=>[w.type,w.tabs.map(t=>t.url+'|'+t.pendingUrl)]))));
    if (process.env.DEBUG) console.log('STATUS', JSON.stringify(await sw.evaluate(()=>chrome.storage.local.get('status'))));
    const opened = await until(async () => { const c = (await api('GET', '/api/tree')).clients[0]; const ts = c.windows.flatMap((w) => w.tabs).filter((t) => t.url.includes('opened=')); return ts.length === 2 && ts; }, 'opened tabs in tree');
    console.log('windows now:', (await api('GET', '/api/tree')).clients[0].windows.length);

    const cl = await api('POST', '/api/actions/close', { tabs: opened.map((t) => ({ clientId: client.id, tabId: t.id })) });
    await until(async () => (await api('GET', '/api/commands')).commands.find((c) => c.id === cl.commands[0] && c.status === 'done'), 'close ack');
    await until(async () => !(await api('GET', '/api/tree')).clients[0].windows.flatMap((w) => w.tabs).some((t) => t.url.includes('opened=')), 'tabs closed');
    console.log('close: ok, browser pages:', ctx.pages().map((x) => x.url()));

    // web UI
    const ui = await ctx.newPage(); await ui.setViewportSize({ width: 1300, height: 800 });
    await ui.goto(BASE + '/#token=' + TOKEN);
    await ui.waitForSelector('.tab');
    await ui.click('.machine > .row input[type=checkbox]');
    console.log('UI selected:', await ui.textContent('#sel-count'));
    await ui.screenshot({ path: path.join(WORK, 'ui.png') });
    console.log('E2E OK, screenshot:', path.join(WORK, 'ui.png'));
  } finally {
    await ctx.close(); srv.kill(); fs.rmSync(path.join(WORK, 'profile'), { recursive: true, force: true });
  }
})().catch((e) => { console.error('E2E FAIL', e); process.exit(1); });

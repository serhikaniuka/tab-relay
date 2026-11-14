// End-to-end check: two real Chromium profiles with the unpacked extension (two clients),
// a throwaway Tab Relay server and a tiny test website.
// Needs playwright-core and a Chromium build; not part of `npm test`:
//   npm i --no-save playwright-core && npx playwright-core install chromium
//   CHROME=/path/to/chromium node scripts/e2e.js
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-relay-e2e-'));
const PORT = 8799, SITE_PORT = 8798, TOKEN = 'e2e-token';
const BASE = `http://127.0.0.1:${PORT}`, SITE = `http://127.0.0.1:${SITE_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, p, b) => (await fetch(BASE + p, { method: m, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: b && JSON.stringify(b) })).json();
async function until(fn, what, ms = 25000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(300); }
  const cmds = await api('GET', '/api/commands?limit=5').catch(() => ({}));
  console.error('recent commands:', JSON.stringify(cmds.commands?.map((c) => [c.type, c.status, c.result])));
  throw new Error('timeout: ' + what);
}
const tree = async () => (await api('GET', '/api/tree')).clients;
const tabsOf = async (machine) => ((await tree()).find((c) => c.machine === machine)?.windows || []).flatMap((w) => w.tabs);
const step = (s) => console.log('✓', s);

// Test website: /one and /two, with a red <h1> so rendering of the saved copy can be checked.
const site = http.createServer((req, res) => {
  const name = req.url.replace(/\W/g, '') || 'root';
  res.setHeader('content-type', 'text/html; charset=utf-8');
  // /one and /two have a meta description; /three only paragraphs (extension falls back to the first one).
  const meta = name === 'three' ? '' : `<meta name="description" content="Description of page ${name} &amp; more.">`;
  res.end(`<!doctype html><title>Page ${name}</title>${meta}<style>h1{color:rgb(200,0,0)}</style><h1 id="h">Hello offline ${name}</h1><p>${'lorem ipsum '.repeat(200)}</p>`);
});

async function browser(name) {
  const ctx = await chromium.launchPersistentContext(path.join(WORK, `profile-${name}`), {
    executablePath: process.env.CHROME || undefined,
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--headless=new', `--disable-extensions-except=${REPO}/extension`, `--load-extension=${REPO}/extension`],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  await sw.evaluate((c) => chrome.storage.local.set({ config: c }),
    { serverUrl: BASE, token: TOKEN, machine: name, profileLabel: `${name}-prof` });
  return ctx;
}

(async () => {
  await new Promise((r) => site.listen(SITE_PORT, '127.0.0.1', r));
  const srv = spawn('node', [REPO + '/server/src/index.js'], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', TAB_RELAY_TOKEN: TOKEN, TAB_RELAY_DB: path.join(WORK, 'db.sqlite'),
      TAB_RELAY_ENV: path.join(WORK, '.env'), TAB_RELAY_OFFLINE_DIR: path.join(WORK, 'offline') },
    stdio: 'inherit',
  });
  await sleep(800);
  const A = await browser('alpha');
  const B = await browser('beta');
  try {
    for (const p of ['one', 'two', 'three']) await (await A.newPage()).goto(`${SITE}/${p}`);
    await until(async () => (await tabsOf('alpha')).filter((t) => t.url.startsWith(SITE)).length === 3, 'alpha tabs pushed');
    await until(async () => (await tree()).some((c) => c.machine === 'beta'), 'beta pushed');
    const alpha = (await tree()).find((c) => c.machine === 'alpha');
    const beta = (await tree()).find((c) => c.machine === 'beta');
    const tab = async (p) => (await tabsOf('alpha')).find((t) => t.url === `${SITE}/${p}`);
    await sleep(4000);   // let first-run pushes/polls settle, then check no duplicate client appeared
    const all = await tree();
    if (all.length !== 2) throw new Error(`expected exactly 2 clients (one per profile), got ${all.length}: ${all.map((c) => c.machine + ':' + c.id)}`);
    step('two clients pushed their tabs, exactly one client id per profile');

    // Descriptions read from the live pages by the extension (chrome.scripting).
    const descOf = async (p) => (await tab(p))?.description;
    await until(async () => (await descOf('one')) === 'Description of page one & more.' && (await descOf('three'))?.startsWith('lorem ipsum'), 'descriptions pushed');
    const d3 = await descOf('three');
    if (d3.length > 200) throw new Error('description not clamped: ' + d3.length);
    step(`descriptions from the extension: "${await descOf('one')}" / "${d3.slice(0, 30)}…" (${d3.length} chars)`);

    // 1. Save offline
    await api('POST', '/api/actions/offline', { tabs: [{ clientId: alpha.id, tabId: (await tab('one')).id }] });
    const copy = await until(async () => (await api('GET', '/api/offline')).items.find((o) => o.url === `${SITE}/one`), 'offline copy uploaded');
    const viewRes = await fetch(`${BASE}/api/offline/${copy.id}/raw?token=${TOKEN}`);
    const body = await viewRes.text();
    if (!/multipart\/related/.test(viewRes.headers.get('content-type')) || !body.includes('Hello offline one')) throw new Error('bad MHTML');
    step(`offline copy saved: "${copy.title}", ${copy.size} bytes, served as ${viewRes.headers.get('content-type')}`);

    // 2. Archive + save offline
    await api('POST', '/api/actions/archive', { offline: true, tabs: [{ clientId: alpha.id, tabId: (await tab('two')).id }] });
    const arch = await until(async () => (await api('GET', '/api/archive')).items.find((a) => a.url === `${SITE}/two` && a.offline), 'archive item with offline copy');
    await until(async () => !(await tab('two')), 'archived tab closed on alpha');
    step(`archived with offline copy (${arch.offline.size} bytes) and closed on the source`);

    // 3. Web UI: drag a tab from alpha onto beta's profile node => move
    const ui = await B.newPage();
    await ui.goto(`${BASE}/#token=${TOKEN}`);
    await ui.waitForSelector('table.tt:not(.archive) tr.leaf');
    // The table shows URL, title and description columns.
    const row1 = ui.locator('table.tt:not(.archive) tr.leaf', { hasText: 'Page one' }).first();
    const cells = await Promise.all(['td.c-url', 'td.c-title', 'td.c-desc'].map((c) => row1.locator(c).innerText()));
    if (!cells[0].includes('127.0.0.1:8798/one') || !cells[1].includes('Page one') || !cells[2].includes('Description of page one'))
      throw new Error('table cells: ' + JSON.stringify(cells));
    const order = await row1.locator('td').evaluateAll((tds) => tds.map((td) => td.className.split(' ')[0]));
    if (JSON.stringify(order) !== '["c-cb","c-act","c-url","c-title","c-desc"]') throw new Error('column order: ' + order);
    step(`table row: ${JSON.stringify(cells.map((c) => c.split('\n')[0]))}, columns ${order.join(' | ')}`);
    await ui.locator('table.tt:not(.archive) tr.leaf', { hasText: 'Page three' }).first()
      .dragTo(ui.locator('table.tt:not(.archive) tr.grp.profile', { hasText: 'beta-prof' }));
    await until(async () => (await tabsOf('beta')).some((t) => t.url === `${SITE}/three`), 'moved tab opened on beta');
    await until(async () => !(await tab('three')), 'moved tab closed on alpha');
    step('drag & drop move alpha → beta');

    // Sorting + flat list
    const LIVE = 'table.tt:not(.archive)';
    const coll = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
    const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./i, ''); } catch (e) { return u; } };
    const byUrl = (a, b) => coll.compare(hostOf(a), hostOf(b)) || coll.compare(a, b);
    const urls = async () => ui.locator(`${LIVE} tr.leaf td.c-url`).evaluateAll((tds) => tds.map((td) => td.title));
    await ui.reload();
    await ui.waitForSelector(`${LIVE} tr.leaf`);
    const grouped = await urls();
    await ui.check('#flat');
    await ui.waitForSelector(`${LIVE}.flat`);
    if (await ui.locator(`${LIVE} tr.grp`).count()) throw new Error('flat list still has group rows');
    if (await ui.locator('.drop-strip .chip').count() !== 2) throw new Error('flat list: expected 2 drop chips');
    const original = await urls();
    await ui.click(`${LIVE} th.sortable:has-text("URL")`);
    const asc = await urls();
    if (JSON.stringify(asc) !== JSON.stringify([...original].sort(byUrl))) throw new Error('URL asc: ' + asc);
    if ((await ui.textContent(`${LIVE} th.sorted`)).trim() !== 'URL▲') throw new Error('arrow');
    await ui.click(`${LIVE} th.sortable:has-text("URL")`);
    const desc = await urls();
    if (JSON.stringify(desc) !== JSON.stringify([...original].sort((a, b) => -byUrl(a, b)))) throw new Error('URL desc: ' + desc);
    await ui.reload();   // remembered in localStorage
    await ui.waitForSelector(`${LIVE}.flat th.sorted`);
    if ((await ui.textContent(`${LIVE} th.sorted`)).trim() !== 'URL▼' || JSON.stringify(await urls()) !== JSON.stringify(desc)) throw new Error('sort not remembered');
    await ui.click(`${LIVE} th.sortable:has-text("URL")`);   // third click: original order
    if (JSON.stringify(await urls()) !== JSON.stringify(original) || await ui.locator(`${LIVE} th.sorted`).count()) throw new Error('reset to original order');
    await ui.uncheck('#flat');
    // Grouped + sorted: groups stay, tabs sorted within each window.
    await ui.click(`${LIVE} th.sortable:has-text("Title")`);
    await ui.waitForSelector(`${LIVE} tr.grp.window`);
    const winTitles = await ui.locator(`${LIVE} tbody tr`).evaluateAll((trs) => {
      const out = []; let cur = null;
      for (const tr of trs) {
        if (tr.classList.contains('window')) out.push(cur = []);
        else if (tr.classList.contains('leaf') && cur) cur.push(tr.querySelector('td.c-title .label').textContent);
      }
      return out;
    });
    for (const w of winTitles) if (JSON.stringify(w) !== JSON.stringify([...w].sort(coll.compare))) throw new Error('title sort within window: ' + w);
    await ui.screenshot({ path: path.join(WORK, 'ui-sorted.png'), fullPage: true });
    await ui.click(`${LIVE} th.sortable:has-text("Title")`);
    await ui.click(`${LIVE} th.sortable:has-text("Title")`);
    if (JSON.stringify(await urls()) !== JSON.stringify(grouped)) throw new Error('grouped original order not restored');
    step(`sorting: flat URL ▲/▼/original over ${original.length} tabs, remembered after reload; title sort within ${winTitles.length} windows`);

    // 4. UI shows the archive section and offline badges
    await ui.reload();
    await ui.waitForSelector('table.tt.archive tr.leaf');
    const archiveText = await ui.textContent('table.tt.archive');
    if (!archiveText.includes('Description of page two')) throw new Error('archived tab lost its description');
    if (!archiveText.includes('alpha') || !archiveText.includes('Page two')) throw new Error('archive not rendered: ' + archiveText);
    const badges = await ui.locator('.badge.offline').count();
    await ui.screenshot({ path: path.join(WORK, 'ui.png'), fullPage: true });
    // The old tree view is one click away and still works.
    await ui.click('#btn-view');
    await ui.waitForSelector('#tree .node.leaf');
    await ui.screenshot({ path: path.join(WORK, 'ui-tree.png') });
    await ui.click('#btn-view');
    await ui.waitForSelector('table.tt tr.leaf');
    step(`UI: archive section rendered, ${badges} offline badges`);

    // 5. Site goes away; saved copies still render in the browser
    await new Promise((r) => site.close(r));
    site.closeAllConnections?.();
    const view = await B.newPage();
    await view.goto(`${BASE}/api/offline/${arch.offline.id}/view?token=${TOKEN}`);
    const h1 = await view.locator('h1').textContent();
    const color = await view.locator('h1').evaluate((e) => getComputedStyle(e).color);
    if (h1 !== 'Hello offline two') throw new Error('offline view did not render: ' + h1);
    if (color !== 'rgb(200, 0, 0)') throw new Error('captured CSS not applied: ' + color);
    await view.screenshot({ path: path.join(WORK, 'offline-view.png') });
    step(`offline copy renders with the site down: <h1> "${h1}" (${color})`);

    // 6. Restore from the archive via the UI button onto alpha
    await ui.bringToFront();
    await ui.reload();
    await ui.waitForSelector('table.tt.archive tr.leaf');
    await ui.selectOption('#target', alpha.id);
    await ui.locator('table.tt.archive tr.grp.archive-root input[type=checkbox]').check();
    await ui.click('#btn-restore');
    await until(async () => (await tabsOf('alpha')).some((t) => t.url === `${SITE}/two`), 'restored on alpha');
    await until(async () => (await api('GET', '/api/archive')).items.length === 0, 'archive emptied');
    step('restore from archive via UI');

    // 7. Delete (close without archive) via the UI, with confirmation
    ui.once('dialog', (d) => d.accept());
    await ui.reload();
    await ui.waitForSelector('table.tt:not(.archive) tr.leaf');
    await ui.locator('table.tt:not(.archive) tr.leaf', { hasText: 'Page two' }).first().locator('input').check();
    await ui.click('#btn-close');
    await until(async () => !(await tab('two')), 'deleted tab closed');
    if ((await api('GET', '/api/archive')).items.length) throw new Error('delete must not archive');
    step('delete closes the tab without archiving');

    // 7b. Per-row buttons: Save offline / Archive / Delete on live rows; Restore / Delete on archived rows.
    {
      const LIVE = 'table.tt:not(.archive)';
      if (!site.listening) await new Promise((r) => site.listen(SITE_PORT, '127.0.0.1', r));   // step 5 took it down
      for (const p of ['four', 'five']) await (await A.newPage()).goto(`${SITE}/${p}`);
      await until(async () => (await tab('four')) && (await tab('five')), 'pages four/five pushed');
      await ui.reload();
      const row = (title) => ui.locator(`${LIVE} tr.leaf`, { hasText: title }).first();
      await row('Page four').waitFor();
      const btn = (title, action) => row(title).locator(`button[data-action="${action}"]`);
      // Another row stays selected through per-row actions.
      await row('Page five').locator('input[type=checkbox]').check();
      if ((await ui.textContent('#sel-count')).trim() !== '1 tab selected') throw new Error('selection');
      // Non-http tabs can't be captured: their Save offline button is disabled.
      const blank = ui.locator(`${LIVE} tr.leaf`, { hasText: 'about:blank' }).first();
      if (await blank.count() && !(await blank.locator('button[data-action="offline"]').isDisabled())) throw new Error('about:blank save offline should be disabled');

      await btn('Page four', 'offline').click();
      await ui.locator('#msg div', { hasText: 'Saving "Page four" for offline reading' }).first().waitFor();
      await until(async () => (await api('GET', '/api/offline')).items.find((o) => o.url === `${SITE}/four`), 'row save offline');
      await until(async () => (await btn('Page four', 'offline').getAttribute('class')).includes('done'), 'save button shows "saved"', 10000);
      if (!(await btn('Page four', 'offline').getAttribute('title')).startsWith('Saved offline')) throw new Error('saved tooltip');

      await btn('Page four', 'archive').click();
      await ui.locator('#msg div', { hasText: 'Archiving "Page four"' }).first().waitFor();
      await until(async () => !(await tab('four')) && (await api('GET', '/api/archive')).items.some((a) => a.url === `${SITE}/four`), 'row archive');
      const arow = () => ui.locator('table.tt.archive tr.leaf', { hasText: 'Page four' }).first();
      await arow().waitFor();
      const aActions = await arow().locator('button.rb').evaluateAll((bs) => bs.map((b) => b.dataset.action));
      if (JSON.stringify(aActions) !== '["purge","restore"]') throw new Error('archive row buttons: ' + aActions);

      await ui.selectOption('#target', alpha.id);
      await arow().locator('button[data-action="restore"]').click();
      await until(async () => (await tab('four')) && !(await api('GET', '/api/archive')).items.some((a) => a.url === `${SITE}/four`), 'row restore');

      await ui.reload();
      await row('Page four').waitFor();
      await btn('Page four', 'archive').click();
      await until(async () => (await api('GET', '/api/archive')).items.some((a) => a.url === `${SITE}/four`), 'archived again');
      await arow().waitFor();
      ui.once('dialog', (d) => d.accept());
      await arow().locator('button[data-action="purge"]').click();
      await until(async () => !(await api('GET', '/api/archive')).items.some((a) => a.url === `${SITE}/four`), 'row purge');

      // Delete asks for confirmation; dismissing it does nothing.
      ui.once('dialog', (d) => d.dismiss());
      await btn('Page five', 'delete').click();
      await sleep(1500);
      if (!(await tab('five'))) throw new Error('dismissed delete must not close the tab');
      ui.once('dialog', (d) => d.accept());
      await btn('Page five', 'delete').click();
      await until(async () => !(await tab('five')), 'row delete');
      if ((await api('GET', '/api/archive')).items.some((a) => a.url === `${SITE}/five`)) throw new Error('delete must not archive');

      // Flat list: every live row has its three buttons too.
      await ui.check('#flat');
      await ui.waitForSelector(`${LIVE}.flat tr.leaf`);
      const nRows = await ui.locator(`${LIVE}.flat tr.leaf`).count();
      const nBtns = await ui.locator(`${LIVE}.flat tr.leaf button.rb`).count();
      await ui.screenshot({ path: path.join(WORK, 'ui-row-buttons-flat.png'), fullPage: true });
      await ui.uncheck('#flat');
      if (nBtns !== nRows * 3) throw new Error(`flat: ${nBtns} buttons for ${nRows} rows`);
      await ui.screenshot({ path: path.join(WORK, 'ui-row-buttons.png'), fullPage: true });
      step(`row buttons: save offline (→ "saved"), archive, restore, purge, delete with confirm; selection kept; flat list ${nRows} rows × 3 buttons`);
    }

    // 8. Remove a stale (offline) client from the UI
    await api('POST', '/api/clients/ghost-client/state', { machine: 'ghost', profile: { label: 'stale' }, windows: [{ id: 1, tabs: [{ id: 1, url: 'https://ghost/' }] }] });
    await sleep(31000);   // let it go offline
    await ui.reload();
    const ghostRow = ui.locator('table.tt:not(.archive) tr.grp.profile', { hasText: 'stale' });
    await ghostRow.waitFor();
    ui.once('dialog', (d) => d.accept());
    await ghostRow.getByRole('button', { name: 'Remove' }).click();
    await until(async () => !(await tree()).some((c) => c.id === 'ghost-client'), 'ghost client removed');
    if ((await tree()).length !== 2) throw new Error('live clients must not be removed');
    step('UI "Remove" deletes an offline client');

    // 9. Optional: a real website (E2E_REAL_URL=https://…), checks images/CSS survive the round trip.
    if (process.env.E2E_REAL_URL) {
      const real = await A.newPage();
      await real.goto(process.env.E2E_REAL_URL, { waitUntil: 'load' });
      const rt = await until(async () => (await tabsOf('alpha')).find((t) => t.url === real.url()), 'real page pushed');
      await api('POST', '/api/actions/offline', { tabs: [{ clientId: alpha.id, tabId: rt.id }] });
      const rc = await until(async () => (await api('GET', '/api/offline')).items.find((o) => o.url === real.url()), 'real page captured', 60000);
      const rv = await B.newPage();
      const failed = [];
      rv.on('requestfailed', (r) => failed.push(r.url()));
      await rv.goto(`${BASE}/api/offline/${rc.id}/view?token=${TOKEN}`, { waitUntil: 'load' });
      const imgs = await rv.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length);
      const local = failed.filter((u) => u.startsWith(BASE));
      await rv.screenshot({ path: path.join(WORK, 'real-offline-view.png') });
      if (local.length) throw new Error('parts failed to load: ' + local.slice(0, 3));
      step(`real page "${rc.title}" (${rc.size} bytes) renders offline, ${imgs} images loaded`);
    }

    console.log('E2E OK, screenshots in', WORK);
  } finally {
    await A.close(); await B.close(); srv.kill(); site.close();
    for (const p of ['alpha', 'beta']) fs.rmSync(path.join(WORK, `profile-${p}`), { recursive: true, force: true });
  }
})().catch((e) => { console.error('E2E FAIL', e); process.exit(1); });

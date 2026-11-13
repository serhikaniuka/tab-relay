'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { parseMhtml, renderPart } = require('./mhtml');

const ONLINE_MS = 30_000;          // client counts as online if seen within this window
const REDELIVER_MS = 60_000;       // re-send a delivered-but-unacked command after this
const MAX_FAVICON = 16_384;        // drop huge data: favicons

function str(v, max = 4096) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function decodeHeader(v, max) {
  if (!v) return '';
  try { return decodeURIComponent(v).slice(0, max); } catch (e) { return String(v).slice(0, max); }
}

function idList(v) {
  return (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

// Offline view/download links are opened by the browser directly, so they may carry ?token=.
const QUERY_TOKEN_ROUTE = /^\/offline\/\d+\/(view|raw|download|res\/\d+)$/;

// Saved pages are untrusted: render them sandboxed with scripts and plugins disabled.
const OFFLINE_CSP = "sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation; "
  + "script-src 'none'; object-src 'none'";

function createApp({
  db, token, now = () => Date.now(),
  offlineDir = path.join(__dirname, '..', 'data', 'offline'),
  maxOfflineBytes = 200 * 1024 * 1024,
}) {
  if (!token) throw new Error('token is required');
  fs.mkdirSync(offlineDir, { recursive: true });
  const app = express();
  app.disable('x-powered-by');
  if (process.env.DEBUG_HTTP) app.use((req, res, next) => { res.on('finish', () => console.error('HTTP', req.method, req.url.slice(0, 120), res.statusCode, req.get('content-length'), req.get('origin'))); next(); });
  app.use(express.json({ limit: '20mb' }));

  // CORS: the extension fetches from its own origin; the web UI is same-origin.
  app.use('/api', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Tab-Url, X-Tab-Title');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, time: now() }));

  app.use('/api', (req, res, next) => {
    const h = req.get('authorization') || '';
    let given = h.startsWith('Bearer ') ? h.slice(7) : (req.get('x-token') || '');
    if (!given && req.method === 'GET' && QUERY_TOKEN_ROUTE.test(req.path)) given = str(req.query.token, 200);
    if (!given || !safeEqual(given, token)) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  // ---------- prepared statements ----------
  const st = {
    getClient: db.prepare('SELECT * FROM clients WHERE id = ?'),
    upsertClient: db.prepare(`
      INSERT INTO clients (id, machine, profile_email, profile_label, user_agent, created_at, last_seen)
      VALUES (@id, @machine, @profile_email, @profile_label, @user_agent, @now, @now)
      ON CONFLICT(id) DO UPDATE SET machine=@machine, profile_email=@profile_email,
        profile_label=@profile_label, user_agent=@user_agent, last_seen=@now`),
    touchClient: db.prepare('UPDATE clients SET last_seen = ? WHERE id = ?'),
    delWindows: db.prepare('DELETE FROM windows WHERE client_id = ?'),
    delTabs: db.prepare('DELETE FROM tabs WHERE client_id = ?'),
    insWindow: db.prepare(`INSERT OR REPLACE INTO windows (client_id, window_id, focused, incognito, type)
      VALUES (?, ?, ?, ?, ?)`),
    insTab: db.prepare(`INSERT OR REPLACE INTO tabs
      (client_id, tab_id, window_id, idx, url, title, fav_icon_url, pinned, active, last_seen)
      VALUES (@client_id, @tab_id, @window_id, @idx, @url, @title, @fav_icon_url, @pinned, @active, @last_seen)`),
    allClients: db.prepare('SELECT * FROM clients ORDER BY machine, profile_email, profile_label'),
    allWindows: db.prepare('SELECT * FROM windows ORDER BY client_id, window_id'),
    allTabs: db.prepare('SELECT * FROM tabs ORDER BY client_id, window_id, idx'),
    getTab: db.prepare('SELECT * FROM tabs WHERE client_id = ? AND tab_id = ?'),
    deleteClient: db.prepare('DELETE FROM clients WHERE id = ?'),
    insCommand: db.prepare(`INSERT INTO commands (client_id, type, payload, depends_on, dep_mode, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`),
    getCommand: db.prepare('SELECT * FROM commands WHERE id = ?'),
    pendingFor: db.prepare(`
      SELECT c.* FROM commands c
      LEFT JOIN commands d ON d.id = c.depends_on
      WHERE c.client_id = ?
        AND (c.status = 'pending' OR (c.status = 'delivered' AND c.delivered_at < ?))
        AND (c.depends_on IS NULL OR d.status = 'done'
             OR (c.dep_mode = 'finish' AND d.status IN ('failed', 'cancelled')))
      ORDER BY c.id`),
    markDelivered: db.prepare("UPDATE commands SET status='delivered', delivered_at=? WHERE id=?"),
    ackCommand: db.prepare('UPDATE commands SET status=?, acked_at=?, result=? WHERE id=?'),
    cancelDependents: db.prepare(`UPDATE commands SET status='cancelled', acked_at=?, result=?
      WHERE depends_on = ? AND dep_mode = 'success' AND status IN ('pending','delivered')`),
    openCloses: db.prepare(`SELECT client_id, payload FROM commands
      WHERE type = 'close' AND status IN ('pending','delivered')`),
    recentCommands: db.prepare(`SELECT c.*, cl.machine, cl.profile_email, cl.profile_label
      FROM commands c LEFT JOIN clients cl ON cl.id = c.client_id ORDER BY c.id DESC LIMIT ?`),
    insSnapshot: db.prepare('INSERT INTO snapshots (name, created_at, tabs) VALUES (?, ?, ?)'),
    allSnapshots: db.prepare('SELECT * FROM snapshots ORDER BY id DESC'),
    getSnapshot: db.prepare('SELECT * FROM snapshots WHERE id = ?'),
    delSnapshot: db.prepare('DELETE FROM snapshots WHERE id = ?'),
    insArchive: db.prepare(`INSERT INTO archive_items
      (batch_id, source_client_id, machine, profile_email, profile_label, window_id, idx, url, title,
       fav_icon_url, pinned, archived_at)
      VALUES (@batch_id, @source_client_id, @machine, @profile_email, @profile_label, @window_id, @idx, @url,
       @title, @fav_icon_url, @pinned, @archived_at)`),
    allArchive: db.prepare(`SELECT a.*, o.size AS offline_size FROM archive_items a
      LEFT JOIN offline_pages o ON o.id = a.offline_id
      ORDER BY a.machine, a.profile_email, a.archived_at DESC, a.window_id, a.idx`),
    getArchive: db.prepare('SELECT * FROM archive_items WHERE id = ?'),
    delArchive: db.prepare('DELETE FROM archive_items WHERE id = ?'),
    linkArchiveOffline: db.prepare('UPDATE archive_items SET offline_id = ? WHERE id = ?'),
    insOffline: db.prepare(`INSERT INTO offline_pages
      (client_id, machine, profile_email, profile_label, tab_id, url, title, fav_icon_url, file, size, created_at)
      VALUES (@client_id, @machine, @profile_email, @profile_label, @tab_id, @url, @title, @fav_icon_url, @file,
       @size, @created_at)`),
    allOffline: db.prepare('SELECT * FROM offline_pages ORDER BY id DESC'),
    getOffline: db.prepare('SELECT * FROM offline_pages WHERE id = ?'),
    delOffline: db.prepare('DELETE FROM offline_pages WHERE id = ?'),
  };

  const clientView = (c) => ({
    id: c.id,
    machine: c.machine,
    profile: { email: c.profile_email, label: c.profile_label, signedIn: !!c.profile_email },
    lastSeen: c.last_seen,
    online: now() - c.last_seen < ONLINE_MS,
  });

  const tabView = (t) => ({
    id: t.tab_id,
    windowId: t.window_id,
    index: t.idx,
    url: t.url,
    title: t.title,
    favIconUrl: t.fav_icon_url,
    pinned: !!t.pinned,
    active: !!t.active,
    lastSeen: t.last_seen,
  });

  const commandView = (c) => ({
    id: c.id,
    clientId: c.client_id,
    type: c.type,
    payload: JSON.parse(c.payload),
    status: c.status,
    dependsOn: c.depends_on,
    createdAt: c.created_at,
    ackedAt: c.acked_at,
    result: c.result ? JSON.parse(c.result) : null,
  });

  const offlineView = (o) => ({
    id: o.id,
    clientId: o.client_id,
    source: { machine: o.machine, email: o.profile_email, label: o.profile_label },
    tabId: o.tab_id,
    url: o.url,
    title: o.title,
    favIconUrl: o.fav_icon_url,
    size: o.size,
    createdAt: o.created_at,
  });

  const archiveView = (a) => ({
    id: a.id,
    batchId: a.batch_id,
    source: { clientId: a.source_client_id, machine: a.machine, email: a.profile_email, label: a.profile_label },
    windowId: a.window_id,
    index: a.idx,
    url: a.url,
    title: a.title,
    favIconUrl: a.fav_icon_url,
    pinned: !!a.pinned,
    archivedAt: a.archived_at,
    offline: a.offline_id ? { id: a.offline_id, size: a.offline_size } : null,
  });

  function requireClient(id) {
    const c = st.getClient.get(id);
    if (!c) throw httpError(404, `unknown client ${id}`);
    return c;
  }

  function normOpenItems(items) {
    if (!Array.isArray(items)) throw httpError(400, 'urls/tabs must be an array');
    const out = [];
    for (const it of items) {
      const o = typeof it === 'string' ? { url: it } : it || {};
      const url = str(o.url, 8192);
      if (!url) continue;
      out.push({ url, pinned: !!o.pinned });
    }
    if (!out.length) throw httpError(400, 'no urls to open');
    return out;
  }

  // Open payload. With newWindow, tabs that came from different source windows go to separate
  // new windows (`windows`), so moving a whole profile keeps its window layout.
  function openPayload(items, newWindow, groupKey) {
    const tabs = items.map((t) => ({ url: t.url, pinned: !!t.pinned }));
    const payload = { tabs, newWindow: !!newWindow };
    if (newWindow && groupKey) {
      const groups = new Map();
      items.forEach((t, i) => {
        const k = groupKey(t);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(tabs[i]);
      });
      if (groups.size > 1) payload.windows = [...groups.values()];
    }
    return payload;
  }
  const tabWindowKey = (t) => `${t.client_id}:${t.window_id}`;

  function enqueue(clientId, type, payload, dependsOn = null, depMode = 'success') {
    const info = st.insCommand.run(clientId, type, JSON.stringify(payload), dependsOn, depMode, now());
    return Number(info.lastInsertRowid);
  }

  // Resolve [{clientId, tabId}] to stored tab rows (skip unknown).
  function resolveTabs(refs) {
    if (!Array.isArray(refs) || !refs.length) throw httpError(400, 'tabs must be a non-empty array');
    const rows = [];
    for (const r of refs) {
      const t = st.getTab.get(String(r.clientId), Number(r.tabId));
      if (t) rows.push(t);
    }
    if (!rows.length) throw httpError(404, 'none of the selected tabs are known');
    return rows;
  }

  function resolveArchive(ids) {
    const list = idList(ids);
    if (!list.length) throw httpError(400, 'ids must be a non-empty array');
    const rows = list.map((id) => st.getArchive.get(id)).filter(Boolean);
    if (!rows.length) throw httpError(404, 'none of the archive items exist');
    return rows;
  }

  function groupByClient(rows) {
    const m = new Map();
    for (const t of rows) {
      if (!m.has(t.client_id)) m.set(t.client_id, []);
      m.get(t.client_id).push(t);
    }
    return m;
  }

  function removeOffline(o) {
    st.delOffline.run(o.id);   // archive_items.offline_id is set NULL by the FK
    parsed.delete(o.file);
    fs.rm(path.join(offlineDir, o.file), { force: true }, () => {});
  }

  // Hook run when a command is acked as done.
  function onCommandDone(cmd) {
    const p = JSON.parse(cmd.payload);
    // Archive restore with "remove from archive": drop the items once the open succeeded.
    if (cmd.type === 'open' && p.removeArchiveIds) {
      for (const id of idList(p.removeArchiveIds)) st.delArchive.run(id);
    }
  }

  // ---------- extension endpoints ----------

  // Full state push: replaces stored windows/tabs for this client.
  app.post('/api/clients/:id/state', (req, res) => {
    const id = str(req.params.id, 128);
    if (!id) throw httpError(400, 'client id required');
    const b = req.body || {};
    const t = now();
    const profile = b.profile || {};
    const windows = Array.isArray(b.windows) ? b.windows : [];
    let tabCount = 0;
    db.transaction(() => {
      st.upsertClient.run({
        id,
        machine: str(b.machine, 200) || 'unnamed',
        profile_email: str(profile.email, 320),
        profile_label: str(profile.label, 200),
        user_agent: str(b.userAgent, 500),
        now: t,
      });
      st.delWindows.run(id);
      st.delTabs.run(id);
      for (const w of windows) {
        const wid = Number(w.id);
        if (!Number.isFinite(wid)) continue;
        st.insWindow.run(id, wid, w.focused ? 1 : 0, w.incognito ? 1 : 0, str(w.type, 30) || 'normal');
        for (const tab of Array.isArray(w.tabs) ? w.tabs : []) {
          const tid = Number(tab.id);
          if (!Number.isFinite(tid)) continue;
          const fav = str(tab.favIconUrl, MAX_FAVICON + 1);
          st.insTab.run({
            client_id: id,
            tab_id: tid,
            window_id: wid,
            idx: Number(tab.index) || 0,
            url: str(tab.url, 8192),
            title: str(tab.title, 1000),
            fav_icon_url: fav.length > MAX_FAVICON ? '' : fav,
            pinned: tab.pinned ? 1 : 0,
            active: tab.active ? 1 : 0,
            last_seen: t,
          });
          tabCount++;
        }
      }
    })();
    res.json({ ok: true, tabs: tabCount });
  });

  // Poll for commands. Marks returned ones as delivered; unacked ones are re-sent after REDELIVER_MS.
  app.get('/api/clients/:id/commands', (req, res) => {
    const id = req.params.id;
    const t = now();
    const cmds = db.transaction(() => {
      if (!st.getClient.get(id)) return [];
      st.touchClient.run(t, id);
      const rows = st.pendingFor.all(id, t - REDELIVER_MS);
      for (const r of rows) st.markDelivered.run(t, r.id);
      return rows;
    })();
    res.json({ commands: cmds.map((c) => ({ id: c.id, type: c.type, payload: JSON.parse(c.payload) })) });
  });

  app.post('/api/commands/:id/ack', (req, res) => {
    const c = st.getCommand.get(Number(req.params.id));
    if (!c) throw httpError(404, 'unknown command');
    const b = req.body || {};
    const ok = b.ok !== false;
    const t = now();
    db.transaction(() => {
      st.ackCommand.run(ok ? 'done' : 'failed', t, JSON.stringify(b.result ?? b.error ?? null), c.id);
      if (ok) onCommandDone(c);
      else st.cancelDependents.run(t, JSON.stringify(`dependency ${c.id} failed`), c.id);
    })();
    res.json({ ok: true });
  });

  // Upload an MHTML capture. Body = raw MHTML; query: tabId, commandId; headers X-Tab-Url / X-Tab-Title
  // (URI-encoded). Streamed to disk with a size cap.
  app.post('/api/clients/:id/offline', (req, res, next) => {
    const client = st.getClient.get(req.params.id);
    if (!client) return next(httpError(404, 'unknown client'));
    const tabId = Number(req.query.tabId);
    const commandId = Number(req.query.commandId) || null;
    const name = `${now()}-${crypto.randomBytes(6).toString('hex')}.mhtml`;
    const tmp = path.join(offlineDir, `.${name}.part`);
    const out = fs.createWriteStream(tmp);
    let size = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rm(tmp, { force: true }, () => {});
      req.unpipe(out);
      req.resume();
      next(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxOfflineBytes) fail(httpError(413, `capture larger than ${maxOfflineBytes} bytes`));
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (failed) return;
      if (!size) return fail(httpError(400, 'empty body'));
      try {
        fs.renameSync(tmp, path.join(offlineDir, name));
        const tab = Number.isFinite(tabId) ? st.getTab.get(client.id, tabId) : null;
        const id = db.transaction(() => {
          const info = st.insOffline.run({
            client_id: client.id,
            machine: client.machine,
            profile_email: client.profile_email,
            profile_label: client.profile_label,
            tab_id: Number.isFinite(tabId) ? tabId : null,
            url: decodeHeader(req.get('x-tab-url'), 8192) || tab?.url || '',
            title: decodeHeader(req.get('x-tab-title'), 1000) || tab?.title || '',
            fav_icon_url: tab?.fav_icon_url || '',
            file: name,
            size,
            created_at: now(),
          });
          const offlineId = Number(info.lastInsertRowid);
          // Link to the archive item this capture was made for, if any.
          const cmd = commandId ? st.getCommand.get(commandId) : null;
          if (cmd && cmd.type === 'capture' && cmd.client_id === client.id) {
            const archiveId = JSON.parse(cmd.payload).archiveMap?.[tabId];
            if (archiveId) st.linkArchiveOffline.run(offlineId, archiveId);
          }
          return offlineId;
        })();
        res.status(201).json({ id, size });
      } catch (e) {
        fail(e);
      }
    });
    req.pipe(out);
  });

  // ---------- UI endpoints ----------

  // Tree: clients -> windows -> tabs. Grouping by machine/profile is done by the UI.
  // Tabs with an outstanding close command carry `closing: <reason>`.
  app.get('/api/tree', (req, res) => {
    const closing = new Map();
    for (const c of st.openCloses.all()) {
      const p = JSON.parse(c.payload);
      for (const id of p.tabIds || []) closing.set(`${c.client_id}:${id}`, p.reason || 'close');
    }
    const clients = st.allClients.all().map((c) => ({ ...clientView(c), windows: [] }));
    const byId = new Map(clients.map((c) => [c.id, c]));
    const wins = new Map();
    for (const w of st.allWindows.all()) {
      const c = byId.get(w.client_id);
      if (!c) continue;
      const wv = { id: w.window_id, focused: !!w.focused, incognito: !!w.incognito, type: w.type, tabs: [] };
      c.windows.push(wv);
      wins.set(`${w.client_id}:${w.window_id}`, wv);
    }
    for (const t of st.allTabs.all()) {
      const w = wins.get(`${t.client_id}:${t.window_id}`);
      if (!w) continue;
      const v = tabView(t);
      const reason = closing.get(`${t.client_id}:${t.tab_id}`);
      if (reason) v.closing = reason;
      w.tabs.push(v);
    }
    res.json({ now: now(), onlineMs: ONLINE_MS, clients });
  });

  app.delete('/api/clients/:id', (req, res) => {
    requireClient(req.params.id);
    st.deleteClient.run(req.params.id);
    res.json({ ok: true });
  });

  // Generic command: {clientId, type:'open', urls|tabs:[...], newWindow} | {clientId, type:'close', tabIds:[...]}
  app.post('/api/commands', (req, res) => {
    const b = req.body || {};
    requireClient(b.clientId);
    let id;
    if (b.type === 'open') {
      id = enqueue(b.clientId, 'open', { tabs: normOpenItems(b.tabs || b.urls), newWindow: !!b.newWindow });
    } else if (b.type === 'close') {
      const tabIds = (Array.isArray(b.tabIds) ? b.tabIds : []).map(Number).filter(Number.isFinite);
      if (!tabIds.length) throw httpError(400, 'tabIds required');
      id = enqueue(b.clientId, 'close', { tabIds, reason: 'close' });
    } else {
      throw httpError(400, "type must be 'open' or 'close'");
    }
    res.status(201).json({ id });
  });

  app.get('/api/commands', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
    res.json({ commands: st.recentCommands.all(limit).map((c) => ({
      ...commandView(c),
      client: { machine: c.machine, email: c.profile_email, label: c.profile_label },
    })) });
  });

  // Open selected tabs (from any clients) on a target client.
  app.post('/api/actions/open', (req, res) => {
    const b = req.body || {};
    requireClient(b.targetClientId);
    const rows = resolveTabs(b.tabs);
    const id = enqueue(b.targetClientId, 'open', openPayload(rows, b.newWindow, tabWindowKey));
    res.status(201).json({ commands: [id] });
  });

  // Close selected tabs on whatever client they live on (= "delete": no archive).
  app.post('/api/actions/close', (req, res) => {
    const rows = resolveTabs((req.body || {}).tabs);
    const ids = db.transaction(() => [...groupByClient(rows)].map(([clientId, tabs]) =>
      enqueue(clientId, 'close', { tabIds: tabs.map((t) => t.tab_id), reason: 'delete' })))();
    res.status(201).json({ commands: ids });
  });

  // Move: open on target; close on sources only after the open command is acked OK.
  app.post('/api/actions/move', (req, res) => {
    const b = req.body || {};
    requireClient(b.targetClientId);
    const rows = resolveTabs(b.tabs).filter((t) => t.client_id !== b.targetClientId || b.allowSameClient);
    if (!rows.length) throw httpError(400, 'selected tabs are already on the target client');
    const ids = db.transaction(() => {
      const openId = enqueue(b.targetClientId, 'open', openPayload(rows, b.newWindow, tabWindowKey));
      const out = [openId];
      for (const [clientId, tabs] of groupByClient(rows)) {
        out.push(enqueue(clientId, 'close', { tabIds: tabs.map((t) => t.tab_id), reason: 'move' }, openId));
      }
      return out;
    })();
    res.status(201).json({ commands: ids });
  });

  // Save offline: ask each source client to capture its tabs as MHTML and upload them.
  app.post('/api/actions/offline', (req, res) => {
    const rows = resolveTabs((req.body || {}).tabs);
    const ids = db.transaction(() => [...groupByClient(rows)].map(([clientId, tabs]) =>
      enqueue(clientId, 'capture', { tabIds: tabs.map((t) => t.tab_id) })))();
    res.status(201).json({ commands: ids });
  });

  // Archive: keep the tabs on the server, then close them on the source.
  // With offline:true each tab is captured first; the close waits for the capture to finish
  // (even if some captures failed — the archive still has the URL).
  app.post('/api/actions/archive', (req, res) => {
    const b = req.body || {};
    const rows = resolveTabs(b.tabs);
    const batch = crypto.randomUUID();
    const t = now();
    const result = db.transaction(() => {
      const commands = [];
      const archiveIds = [];
      for (const [clientId, tabs] of groupByClient(rows)) {
        const c = st.getClient.get(clientId);
        const archiveMap = {};
        for (const tab of tabs) {
          const info = st.insArchive.run({
            batch_id: batch,
            source_client_id: clientId,
            machine: c.machine,
            profile_email: c.profile_email,
            profile_label: c.profile_label,
            window_id: tab.window_id,
            idx: tab.idx,
            url: tab.url,
            title: tab.title,
            fav_icon_url: tab.fav_icon_url,
            pinned: tab.pinned,
            archived_at: t,
          });
          archiveMap[tab.tab_id] = Number(info.lastInsertRowid);
          archiveIds.push(archiveMap[tab.tab_id]);
        }
        const tabIds = tabs.map((x) => x.tab_id);
        let dep = null;
        if (b.offline) {
          dep = enqueue(clientId, 'capture', { tabIds, archiveMap });
          commands.push(dep);
        }
        commands.push(enqueue(clientId, 'close', { tabIds, reason: 'archive' }, dep, 'finish'));
      }
      return { batchId: batch, archived: archiveIds, commands };
    })();
    res.status(201).json(result);
  });

  // ---------- archive ----------

  app.get('/api/archive', (req, res) => {
    res.json({ items: st.allArchive.all().map(archiveView) });
  });

  // Restore archived items on a target. With remove (default) they leave the archive once opened.
  app.post('/api/archive/restore', (req, res) => {
    const b = req.body || {};
    requireClient(b.targetClientId);
    const rows = resolveArchive(b.ids);
    const payload = openPayload(rows, b.newWindow !== false, (a) => `${a.batch_id}:${a.source_client_id}:${a.window_id}`);
    if (b.remove !== false) payload.removeArchiveIds = rows.map((a) => a.id);
    const id = enqueue(b.targetClientId, 'open', payload);
    res.status(201).json({ commands: [id] });
  });

  // Permanently delete archive items (and their offline copies).
  app.post('/api/archive/delete', (req, res) => {
    const rows = resolveArchive((req.body || {}).ids);
    db.transaction(() => {
      for (const a of rows) {
        st.delArchive.run(a.id);
        const o = a.offline_id && st.getOffline.get(a.offline_id);
        if (o) removeOffline(o);
      }
    })();
    res.json({ deleted: rows.length });
  });

  // ---------- offline copies ----------

  app.get('/api/offline', (req, res) => {
    const items = st.allOffline.all().map(offlineView);
    res.json({ items, totalSize: items.reduce((n, o) => n + o.size, 0) });
  });

  function offlineFile(req) {
    const o = st.getOffline.get(Number(req.params.id));
    if (!o) throw httpError(404, 'unknown offline copy');
    const file = path.join(offlineDir, o.file);
    if (!fs.existsSync(file)) throw httpError(410, 'offline file is missing on disk');
    return { o, file };
  }

  // Small cache of parsed archives (a page view pulls many sub-resources).
  const parsed = new Map();
  function loadMhtml(o, file) {
    let mh = parsed.get(o.file);
    if (!mh) {
      mh = parseMhtml(fs.readFileSync(file));
      parsed.set(o.file, mh);
      if (parsed.size > 4) parsed.delete(parsed.keys().next().value);
    }
    return mh;
  }

  // Chrome downloads MHTML served over http instead of rendering it, so /view unpacks the archive:
  // the main HTML is served as text/html and its images/CSS/frames point at /res/<n> of the same copy.
  function sendPart(req, res, index) {
    const { o, file } = offlineFile(req);
    let mh;
    try { mh = loadMhtml(o, file); } catch (e) { return sendRaw(res, file); }   // not parseable: raw
    const origin = `${req.protocol}://${req.get('host')}`;
    const part = renderPart(mh, index ?? mh.root,
      (i) => `${origin}/api/offline/${o.id}/res/${i}?token=${encodeURIComponent(token)}`);
    if (!part) throw httpError(404, 'no such part');
    res.set({
      'Content-Type': part.type,
      'Content-Security-Policy': OFFLINE_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
      'Referrer-Policy': 'no-referrer',
    });
    res.send(part.body);
  }

  function sendRaw(res, file) {
    res.set({
      'Content-Type': 'multipart/related',
      'Content-Security-Policy': OFFLINE_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.sendFile(file);
  }

  app.get('/api/offline/:id/view', (req, res) => sendPart(req, res));
  app.get('/api/offline/:id/res/:n', (req, res) => sendPart(req, res, Number(req.params.n)));
  // The archive itself, as multipart/related (Chrome will offer it as a download; it opens from disk).
  app.get('/api/offline/:id/raw', (req, res) => sendRaw(res, offlineFile(req).file));

  app.get('/api/offline/:id/download', (req, res) => {
    const { o, file } = offlineFile(req);
    const base = (o.title || 'page').replace(/[^\p{L}\p{N} ._-]+/gu, '_').trim().slice(0, 100) || 'page';
    res.set('Referrer-Policy', 'no-referrer');
    res.download(file, `${base}.mhtml`, { headers: { 'Content-Type': 'multipart/related' } });
  });

  app.delete('/api/offline/:id', (req, res) => {
    const o = st.getOffline.get(Number(req.params.id));
    if (!o) throw httpError(404, 'unknown offline copy');
    removeOffline(o);
    res.json({ ok: true });
  });

  // ---------- snapshots ----------

  app.get('/api/snapshots', (req, res) => {
    res.json({ snapshots: st.allSnapshots.all().map((s) => ({
      id: s.id, name: s.name, createdAt: s.created_at, tabs: JSON.parse(s.tabs),
    })) });
  });

  app.post('/api/snapshots', (req, res) => {
    const b = req.body || {};
    const rows = resolveTabs(b.tabs);
    const clients = new Map();
    const tabs = rows.map((t) => {
      if (!clients.has(t.client_id)) clients.set(t.client_id, st.getClient.get(t.client_id));
      const c = clients.get(t.client_id);
      return {
        url: t.url, title: t.title, favIconUrl: t.fav_icon_url, pinned: !!t.pinned,
        source: { clientId: t.client_id, machine: c.machine, email: c.profile_email, label: c.profile_label },
      };
    });
    const name = str(b.name, 200) || `Snapshot ${new Date(now()).toISOString().slice(0, 16).replace('T', ' ')}`;
    const info = st.insSnapshot.run(name, now(), JSON.stringify(tabs));
    res.status(201).json({ id: Number(info.lastInsertRowid), name, count: tabs.length });
  });

  app.post('/api/snapshots/:id/restore', (req, res) => {
    const s = st.getSnapshot.get(Number(req.params.id));
    if (!s) throw httpError(404, 'unknown snapshot');
    const b = req.body || {};
    requireClient(b.targetClientId);
    const tabs = JSON.parse(s.tabs);
    const id = enqueue(b.targetClientId, 'open', {
      tabs: normOpenItems(tabs),
      newWindow: b.newWindow !== false,
    });
    res.status(201).json({ commands: [id] });
  });

  app.delete('/api/snapshots/:id', (req, res) => {
    const info = st.delSnapshot.run(Number(req.params.id));
    if (!info.changes) throw httpError(404, 'unknown snapshot');
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // ---------- static web UI ----------
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    if (res.headersSent) return;
    res.status(status).json({ error: err.message || 'error' });
  });

  return app;
}

module.exports = { createApp, ONLINE_MS, REDELIVER_MS };

'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');

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

function createApp({ db, token, now = () => Date.now() }) {
  if (!token) throw new Error('token is required');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  // CORS: the extension fetches from its own origin; the web UI is same-origin.
  app.use('/api', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, time: now() }));

  app.use('/api', (req, res, next) => {
    const h = req.get('authorization') || '';
    const given = h.startsWith('Bearer ') ? h.slice(7) : (req.get('x-token') || '');
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
    insCommand: db.prepare(`INSERT INTO commands (client_id, type, payload, depends_on, created_at)
      VALUES (?, ?, ?, ?, ?)`),
    getCommand: db.prepare('SELECT * FROM commands WHERE id = ?'),
    pendingFor: db.prepare(`
      SELECT c.* FROM commands c
      LEFT JOIN commands d ON d.id = c.depends_on
      WHERE c.client_id = ?
        AND (c.status = 'pending' OR (c.status = 'delivered' AND c.delivered_at < ?))
        AND (c.depends_on IS NULL OR d.status = 'done')
      ORDER BY c.id`),
    markDelivered: db.prepare("UPDATE commands SET status='delivered', delivered_at=? WHERE id=?"),
    ackCommand: db.prepare('UPDATE commands SET status=?, acked_at=?, result=? WHERE id=?'),
    cancelDependents: db.prepare(`UPDATE commands SET status='cancelled', acked_at=?, result=?
      WHERE depends_on = ? AND status IN ('pending','delivered')`),
    recentCommands: db.prepare(`SELECT c.*, cl.machine, cl.profile_email, cl.profile_label
      FROM commands c LEFT JOIN clients cl ON cl.id = c.client_id ORDER BY c.id DESC LIMIT ?`),
    insSnapshot: db.prepare('INSERT INTO snapshots (name, created_at, tabs) VALUES (?, ?, ?)'),
    allSnapshots: db.prepare('SELECT * FROM snapshots ORDER BY id DESC'),
    getSnapshot: db.prepare('SELECT * FROM snapshots WHERE id = ?'),
    delSnapshot: db.prepare('DELETE FROM snapshots WHERE id = ?'),
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

  function enqueue(clientId, type, payload, dependsOn = null) {
    const info = st.insCommand.run(clientId, type, JSON.stringify(payload), dependsOn, now());
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

  function groupByClient(rows) {
    const m = new Map();
    for (const t of rows) {
      if (!m.has(t.client_id)) m.set(t.client_id, []);
      m.get(t.client_id).push(t);
    }
    return m;
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
      if (!ok) st.cancelDependents.run(t, JSON.stringify(`dependency ${c.id} failed`), c.id);
    })();
    res.json({ ok: true });
  });

  // ---------- UI endpoints ----------

  // Tree: clients -> windows -> tabs. Grouping by machine/profile is done by the UI.
  app.get('/api/tree', (req, res) => {
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
      if (w) w.tabs.push(tabView(t));
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
      id = enqueue(b.clientId, 'close', { tabIds });
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
    const id = enqueue(b.targetClientId, 'open', {
      tabs: rows.map((t) => ({ url: t.url, pinned: !!t.pinned })),
      newWindow: !!b.newWindow,
    });
    res.status(201).json({ commands: [id] });
  });

  // Close selected tabs on whatever client they live on.
  app.post('/api/actions/close', (req, res) => {
    const rows = resolveTabs((req.body || {}).tabs);
    const ids = [];
    for (const [clientId, tabs] of groupByClient(rows)) {
      ids.push(enqueue(clientId, 'close', { tabIds: tabs.map((t) => t.tab_id) }));
    }
    res.status(201).json({ commands: ids });
  });

  // Move: open on target; close on sources only after the open command is acked OK.
  app.post('/api/actions/move', (req, res) => {
    const b = req.body || {};
    requireClient(b.targetClientId);
    const rows = resolveTabs(b.tabs).filter((t) => t.client_id !== b.targetClientId || b.allowSameClient);
    if (!rows.length) throw httpError(400, 'selected tabs are already on the target client');
    const ids = db.transaction(() => {
      const openId = enqueue(b.targetClientId, 'open', {
        tabs: rows.map((t) => ({ url: t.url, pinned: !!t.pinned })),
        newWindow: !!b.newWindow,
      });
      const out = [openId];
      for (const [clientId, tabs] of groupByClient(rows)) {
        out.push(enqueue(clientId, 'close', { tabIds: tabs.map((t) => t.tab_id) }, openId));
      }
      return out;
    })();
    res.status(201).json({ commands: ids });
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
    res.status(status).json({ error: err.message || 'error' });
  });

  return app;
}

module.exports = { createApp, ONLINE_MS, REDELIVER_MS };

'use strict';
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id            TEXT PRIMARY KEY,
  machine       TEXT NOT NULL DEFAULT '',
  profile_email TEXT NOT NULL DEFAULT '',
  profile_label TEXT NOT NULL DEFAULT '',
  user_agent    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS windows (
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  window_id  INTEGER NOT NULL,
  focused    INTEGER NOT NULL DEFAULT 0,
  incognito  INTEGER NOT NULL DEFAULT 0,
  type       TEXT NOT NULL DEFAULT 'normal',
  PRIMARY KEY (client_id, window_id)
);

CREATE TABLE IF NOT EXISTS tabs (
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tab_id       INTEGER NOT NULL,
  window_id    INTEGER NOT NULL,
  idx          INTEGER NOT NULL DEFAULT 0,
  url          TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  fav_icon_url TEXT NOT NULL DEFAULT '',
  pinned       INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 0,
  last_seen    INTEGER NOT NULL,
  PRIMARY KEY (client_id, tab_id)
);

CREATE TABLE IF NOT EXISTS commands (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,              -- 'open' | 'close' | 'capture'
  payload      TEXT NOT NULL,              -- JSON
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | done | failed | cancelled
  depends_on   INTEGER REFERENCES commands(id),
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  acked_at     INTEGER,
  result       TEXT
);
CREATE INDEX IF NOT EXISTS commands_client_status ON commands(client_id, status);

-- Pages captured as MHTML; the file lives in the offline dir.
CREATE TABLE IF NOT EXISTS offline_pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     TEXT NOT NULL,
  machine       TEXT NOT NULL DEFAULT '',
  profile_email TEXT NOT NULL DEFAULT '',
  profile_label TEXT NOT NULL DEFAULT '',
  tab_id        INTEGER,
  url           TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  fav_icon_url  TEXT NOT NULL DEFAULT '',
  file          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Archived tabs (closed on the source, kept here). Source client info is copied
-- so the archive survives the client being forgotten.
CREATE TABLE IF NOT EXISTS archive_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id         TEXT NOT NULL,
  source_client_id TEXT NOT NULL,
  machine          TEXT NOT NULL DEFAULT '',
  profile_email    TEXT NOT NULL DEFAULT '',
  profile_label    TEXT NOT NULL DEFAULT '',
  window_id        INTEGER,
  idx              INTEGER NOT NULL DEFAULT 0,
  url              TEXT NOT NULL DEFAULT '',
  title            TEXT NOT NULL DEFAULT '',
  fav_icon_url     TEXT NOT NULL DEFAULT '',
  pinned           INTEGER NOT NULL DEFAULT 0,
  archived_at      INTEGER NOT NULL,
  offline_id       INTEGER REFERENCES offline_pages(id) ON DELETE SET NULL
);

-- Short page descriptions per URL (from the live page via the extension, a server-side fetch,
-- or an MHTML capture). Kept independently of tabs so archived tabs keep theirs.
CREATE TABLE IF NOT EXISTS page_meta (
  url                TEXT PRIMARY KEY,
  description        TEXT NOT NULL DEFAULT '',
  source             TEXT NOT NULL DEFAULT '',   -- page | fetch | mhtml
  updated_at         INTEGER NOT NULL,
  fetch_attempted_at INTEGER,
  fetch_error        TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tabs       TEXT NOT NULL                 -- JSON array
);
`;

function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(commands)').all().map((c) => c.name);
  // dep_mode: 'success' = run only if the dependency succeeded; 'finish' = run once it finished at all.
  if (!cols.includes('dep_mode')) db.exec("ALTER TABLE commands ADD COLUMN dep_mode TEXT NOT NULL DEFAULT 'success'");
}

function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

module.exports = { openDb };

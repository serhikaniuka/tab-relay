'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openDb } = require('./db');
const { createApp } = require('./app');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = process.env.TAB_RELAY_ENV || path.join(ROOT, '.env');

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const fileEnv = loadEnv(ENV_FILE);
let token = process.env.TAB_RELAY_TOKEN || fileEnv.TAB_RELAY_TOKEN;
if (!token) {
  token = crypto.randomBytes(24).toString('base64url');
  const prefix = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').replace(/\n?$/, '\n') : '';
  fs.writeFileSync(ENV_FILE, `${prefix}TAB_RELAY_TOKEN=${token}\n`, { mode: 0o600 });
  console.log(`Generated a new auth token and saved it to ${ENV_FILE}`);
}

const host = process.env.HOST || fileEnv.HOST || '0.0.0.0';
const port = Number(process.env.PORT || fileEnv.PORT || 8787);
const dbFile = process.env.TAB_RELAY_DB || fileEnv.TAB_RELAY_DB || path.join(ROOT, 'data', 'tab-relay.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const offlineDir = process.env.TAB_RELAY_OFFLINE_DIR || fileEnv.TAB_RELAY_OFFLINE_DIR || path.join(ROOT, 'data', 'offline');
const maxOfflineMb = Number(process.env.MAX_OFFLINE_MB || fileEnv.MAX_OFFLINE_MB || 200);

const db = openDb(dbFile);
const app = createApp({ db, token, offlineDir, maxOfflineBytes: maxOfflineMb * 1024 * 1024 });

app.listen(port, host, () => {
  console.log(`Tab Relay server listening on http://${host}:${port}`);
  console.log(`Database: ${dbFile}`);
  console.log(`Offline copies: ${offlineDir} (max ${maxOfflineMb} MB each)`);
  console.log(`Auth token is stored in ${ENV_FILE} (TAB_RELAY_TOKEN)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { db.close(); process.exit(0); });
}

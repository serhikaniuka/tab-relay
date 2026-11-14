# Tab Relay: move Chrome tabs between machines

Build a working MVP in this directory (git repo; commit as you go).

## Components
1. **server/**: Node.js (no heavy frameworks; express ok) + SQLite (better-sqlite3). Listens on 0.0.0.0:8787 (LAN, devbox 192.168.1.103). Auth: a shared token from `server/.env` (generate a random one on first run, print where it is). Stores, per client: machine name, Chrome profile info (Google account email or "not signed in", profile label), windows, tabs (url, title, favIconUrl, pinned, active, lastSeen). Command queue per client: open URLs, close tab ids. Snapshots (saved sets of tabs, restorable).
2. **extension/**: Chrome MV3 extension. Options page: server URL, token, machine name (e.g. "MacBook", "devbox"). Uses chrome.identity.getProfileUserInfo({accountStatus:"ANY"}) (permission identity + identity.email) to get the signed-in Google account; empty means "not signed in". Each profile gets a stable client id in chrome.storage.local. Pushes full tab state on tab/window events (debounced) and every ~10 s; polls commands every ~3 s (use chrome.alarms + events; MV3 service worker friendly). Executes open (in new window or current) / close commands and acks them.
3. **Web UI** served by the server at `/`: a TREE — machine → Chrome profile (account email or "not signed in") → window → tabs (favicon, title, url, which machine/profile it came from). Checkbox selection at any level. Actions: "Open on <target client>", "Close on source", "Move" (open on target then close on source), "Save snapshot", restore snapshot to a target. Show online/offline status per client by lastSeen. Simple clean UI, no build step needed (vanilla JS fine).

## Requirements
- README.md (in English, with a short Ukrainian section) explaining: run server (and a systemd --user unit or tmux command for keeping it running), loading the extension via chrome://extensions → Developer mode → Load unpacked, setting options.
- Basic tests for the server API; run them.
- Do not use sudo. Start the server in a detached tmux session named `tab-relay-server` when done and verify `/` and the API respond with curl.
- Final: write SUMMARY.md with what was built, how to use it, the token file location, and any limitations.

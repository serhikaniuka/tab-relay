# Tab Relay fix: duplicate clients (phase 3)

Bug: the live DB has two clients for the same Chrome profile on devbox (machine "devbox", label "personal", no account), created ~1 s apart (ids f3c968f5-50e9-4cf1-aa18-2d8ee5e613e8 stale/offline with 11 tabs, d78e7dae-b5d7-464c-b394-64377de85f43 live with 13 tabs). Likely cause: on first run the extension generated the client id twice concurrently (e.g. onInstalled + onStartup/alarm/push racing before chrome.storage.local write).

Do:
1. Make client-id creation race-safe in extension/background.js (single shared promise / lock; read-then-write once). Bump extension version.
2. Server: add DELETE /api/clients/:id (removes client, its windows/tabs and pending commands; keeps archive + offline copies) and a "Remove" button on offline client nodes in the web UI (with confirmation), plus a "Remove all offline clients older than N days" option is optional.
3. Server-side dedupe safety net: when a client pushes state, if another OFFLINE client has same machine + profile label + email and was created within a few seconds / identical window ids, it is fine to just leave it — do NOT auto-delete by heuristics; the manual Remove button is enough.
4. Remove the stale client f3c968f5-50e9-4cf1-aa18-2d8ee5e613e8 from the live DB using the new endpoint.
5. Add tests, run all tests, commit, restart the server in tmux session tab-relay-server, verify with curl. Append a short note to SUMMARY.md. Note in SUMMARY that the extension must be reloaded on each machine to pick up the fix.

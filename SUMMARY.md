# Tab Relay: build summary

## What was built

### Phase 1 (MVP)
- **Server** (`server/`): Node.js + Express + better-sqlite3.
  - Listens on `0.0.0.0:8787`.
  - Stores clients (machine, Google account, profile label, lastSeen), plus their windows and tabs.
  - Keeps a command queue per client, with dependencies between commands, and snapshots.
  - Bearer-token auth on `/api/*`. Serves the web UI at `/`.
- **Chrome MV3 extension** (`extension/`):
  - Options: server URL, token, machine name, profile label.
  - Reads the Google account with `chrome.identity.getProfileUserInfo({accountStatus:"ANY"})`, and gives each profile a stable client id.
  - Pushes state on events (debounced) and every 10 s. Polls commands every 3 s, with a `chrome.alarms` keepalive.
- **Web UI**: tree machine → profile → window → tabs, with tri-state checkboxes, Open / Move / Close, snapshots, online/offline status and recent commands.

### Phase 2
- **Move between computers**:
  - Any tab, window, profile or whole machine can be moved: it opens on the target and closes on the source only after the open succeeded.
  - Ways to do it: the toolbar (bulk, on the selection), the hover buttons on every tree node, or **drag and drop** onto a profile node (or onto a machine that has only one profile). Hold Ctrl or Alt while dropping to copy instead of move.
  - With "new window", each source window becomes its own new window on the target, so the layout is kept.
- **Archive** closes tabs on the source and keeps them on the server. They appear in an **Archive** section of the tree: source machine → profile → date (YYYY-MM-DD).
  - **Restore** opens them on any chosen client (button, or drag them onto a profile). They leave the archive once the target confirms they opened.
  - **Delete permanently** asks for confirmation, then also deletes their offline copies.
- **Delete** closes tabs without archiving, after a confirmation.
- Tabs waiting to close are shown greyed out and marked *moving… / archiving… / closing…*.
- **Offline save**:
  - The extension (v0.2, `pageCapture` permission) captures each page with `chrome.pageCapture.saveAsMHTML` and streams it to the server.
  - The server stores files under `server/data/offline/` and metadata in SQLite. The upload is streamed to disk with a cap (`MAX_OFFLINE_MB`, default 200).
  - Discarded tabs are reloaded before capture. Failed captures and uploads are retried.
  - **Archive + save offline**: capture first, then archive and close. The close waits for the capture to finish, and runs even if some pages couldn't be captured, because the URL is archived anyway.
  - The UI shows an **offline <size>** badge on live tabs (matched by URL) and on archived tabs. An **Offline copies** panel lists every copy with its size and the total, plus view / raw mhtml / download / delete links.
- **Reading offline copies**: Chrome downloads MHTML served over http(s) instead of rendering it, whatever the headers. I verified this with Chromium 1194 and Google Chrome 156, and tried `multipart/related`, `message/rfc822`, with and without CSP or nosniff. So:
  - `GET /api/offline/:id/view` unpacks the archive (`server/src/mhtml.js`) and serves the saved HTML. Its images, CSS and frames point at `/api/offline/:id/res/<n>` of the same copy.
  - It's sandboxed: `Content-Security-Policy: sandbox …; script-src 'none'`, `nosniff`, `no-referrer`. If the file isn't a parseable archive, it falls back to raw.
  - `GET /api/offline/:id/raw` serves the archive as `Content-Type: multipart/related`.
  - `GET /api/offline/:id/download` serves it as an `.mhtml` attachment, which opens in Chrome from disk.
  - These offline GET routes, and only these, accept `?token=`. Every other endpoint needs the `Authorization` header (tested).
- **Bulk actions**: every action works on checkbox selections at any level. There are separate selections for live tabs and archived tabs, plus a "Clear selection" link.

## Verification

- **`cd server && npm test`: 21 tests pass.**
  - Phase 1 API.
  - Window-preserving moves and closing markers.
  - Archive with and without offline, including capture → close ordering where the close still runs after a failed capture.
  - Upload (headers and fallbacks, 413 size limit, empty body, unknown client, no leftover partial files).
  - view / res / raw / download and the query-token scope.
  - Archive restore (removed only after a successful open; `remove:false` keeps the items) and permanent delete, including the files.
  - Offline copy delete. MHTML parsing and CSS URL rewriting.
- **`scripts/e2e.js`**: two headless Chromium profiles with the real extension (two clients), a throwaway server and a local test site. It checks, in order:
  1. Save offline.
  2. Archive + offline.
  3. Drag-and-drop move alpha → beta in the UI.
  4. The archive section and offline badges render.
  5. The offline copy renders with the captured CSS applied after the test site is shut down.
  6. Restore from the archive via the UI.
  7. Delete via the UI, which doesn't archive.
  - It passed 6 runs in a row. 3 of those runs also used `E2E_REAL_URL=https://en.wikipedia.org/wiki/Google_Chrome`: that 2.4 MB capture renders offline with all its sub-resources (33 images).
- **Bugs found and fixed along the way:**
  - The `pageCapture` Blob is file-backed, and `fetch` sometimes couldn't read it ("Failed to fetch", no request reached the server). The extension now copies it into memory right away and retries the whole capture-and-upload.
  - Stylesheets served from the server resolved root-relative `url(/…)` against the wrong origin. They are now made absolute against the stylesheet's original URL.
- **Live server** restarted in tmux session **`tab-relay-server`** (the existing DB was migrated in place). Checked with curl on `http://192.168.1.103:8787`:
  - `/` → 200 HTML; `/api/health` → ok.
  - `/api/archive` without the token → 401, with it → 200; `/api/offline` → 200.
  - Uploading a 2.4 MB MHTML → 201.
  - `view?token=` → 200 `text/html`; view without a token → 401.
  - `raw` → 200 `multipart/related`; `download` → `Content-Disposition: attachment`; `res/1` → 200 `image/webp`.
  - `/api/tree?token=` → 401 (the query token isn't accepted there).
  - The test client and its copy were deleted afterwards.

## How to use

1. Server (already running): `./run-server.sh` restarts it in tmux; the systemd user unit is in `deploy/`. See the README.
2. Get the token: `grep TAB_RELAY_TOKEN server/.env`
3. On each machine and Chrome profile: `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`. Set the server URL `http://192.168.1.103:8787`, the token and a machine name, then **Save & sync**. **If the extension is already installed, click its reload button**, because v0.2 adds the `pageCapture` permission.
4. Open `http://192.168.1.103:8787/` (or click the extension icon):
   - select tabs or drag them;
   - use Open / Move / Archive / Archive + save offline / Save offline / Delete / Save snapshot;
   - manage the Archive section and the Offline copies panel.

## Token file

**`/home/serhiy/Projects/tab-relay/server/.env`** (`TAB_RELAY_TOKEN=…`, mode 600, git-ignored). It is generated on the first run. To rotate the token, delete the line, restart the server, and update every extension's options.

Data locations (all git-ignored):
- database: `server/data/tab-relay.db`
- offline copies: `server/data/offline/*.mhtml`

## Limitations

- Plain HTTP on the LAN with one shared token. Use it only on a trusted network, or put it behind TLS or a VPN.
- Offline copy links carry the token in the URL by design, so it can end up in browser history.
- The offline reader view is a reconstruction. Scripts are disabled, so pages that build their content with JavaScript after load may look incomplete or static, and lazy-loaded images that never loaded aren't in the capture. Use the downloaded `.mhtml` for Chrome's own rendering.
- Relative URLs in inline `<style>` and HTML attributes resolve against the original site through `<base>`. If that site is down, they fail; Chrome's capture usually uses absolute URLs, so this is rare.
- `pageCapture` can't capture `chrome://` pages, the Web Store, PDFs viewed in Chrome, or other extensions' pages. Archive + offline still archives those, without a copy.
- Large captures are buffered in the extension's memory before upload. The size limit is `MAX_OFFLINE_MB`.
- Live tabs are matched to offline copies by exact URL.
- Restoring an archived item keeps its offline copy (listed in the panel). Permanently deleting archive items removes their copies.
- Chrome doesn't expose the profile's display name, so the "profile label" is typed by hand. The account email is empty when the profile isn't signed in.
- Tab ids are only valid for the browser session. Tabs of offline clients show their last known state. Commands for offline clients wait in the queue, with no expiry or cancel button.
- Tab groups, scroll position, history and form state are not transferred.
- Tested in headless Chromium and Chrome 156, not yet in a real Chrome signed in to a Google account.

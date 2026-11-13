# Tab Relay: build summary

## What was built

- **Server** (`server/`): Node.js + Express + better-sqlite3.
  - Listens on `0.0.0.0:8787`.
  - Tables:
    - `clients`: machine, Google account email, profile label, lastSeen
    - `windows`, `tabs`: url, title, favIconUrl, pinned, active, lastSeen
    - `commands`: per-client queue, statuses pending/delivered/done/failed/cancelled, plus dependencies used by "move"
    - `snapshots`
  - Bearer-token auth on `/api/*`.
  - Serves the web UI at `/`.
- **Chrome MV3 extension** (`extension/`):
  - Options page: server URL, token, machine name, and an optional profile label.
  - Reads the Google account with `chrome.identity.getProfileUserInfo({accountStatus:"ANY"})`.
  - Each profile gets a stable client id in `chrome.storage.local`.
  - Pushes full state on tab/window events (debounced by 1 s) and every 10 s. Polls commands every 3 s, with a `chrome.alarms` keepalive every 30 s.
  - Runs open commands (new window or the current one, keeping the pinned state) and close commands, then acks them. Commands that were already run are not repeated if an ack gets lost.
  - The toolbar icon opens the web UI with the token filled in.
- **Web UI** (`server/public/`, vanilla JS, no build step):
  - Tree: machine → profile (email or "not signed in") → window → tabs, with favicon, title and URL. Hovering a tab shows its source machine and profile.
  - Tri-state checkboxes at every level, plus a filter box.
  - Actions: Open on target, Move to target, Close on source, Save snapshot. Snapshots can be restored to any client or deleted.
  - Online/offline dot for each client (online = contact within 30 s), and a recent-commands panel.
- **Move is safe**: the server releases the close on the source only after the target acks the open as fully successful. A failed open cancels the close, so tabs are never lost.
- **Docs and ops**:
  - `README.md` (English, with a Ukrainian section)
  - `run-server.sh` (tmux)
  - `deploy/tab-relay.service` (systemd --user unit)

## Verification

- `cd server && npm test`: 11 API tests pass. They cover auth, state push and replace, online/offline, delivery, redelivery and ack, close grouping, move dependency ordering, cancellation of a failed move, input validation, and snapshots.
- `scripts/e2e.js` loaded the unpacked extension into headless Chromium (Playwright build) against a throwaway server. It checked the state push, executing an open command (a new window with 2 tabs), the ack, the close command, and the web UI tree and selection. It passed 4 runs in a row.
  - The first run failed, probably because of a race where a stale in-flight push hid newly opened tabs. That race is fixed.
- The live server is running in tmux session **`tab-relay-server`**. Checked with curl:
  - `GET http://192.168.1.103:8787/` → 200, the HTML page
  - `/api/health` → `{"ok":true}`
  - `/api/tree` without a token → 401; with the token → 200

## How to use

1. Server (already running): `./run-server.sh` restarts it in tmux. For autostart, use the systemd user unit; see the README.
2. Get the token: `grep TAB_RELAY_TOKEN server/.env`
3. On each machine and Chrome profile:
   - Open `chrome://extensions` → Developer mode → **Load unpacked** → choose `extension/`.
   - In the options, enter server URL `http://192.168.1.103:8787`, the token, and a machine name, then click **Save & sync**.
4. Open `http://192.168.1.103:8787/` (or click the extension icon), select tabs, choose a target, and use Open / Move / Close / Save snapshot.

## Token file

**`/home/serhiy/Projects/tab-relay/server/.env`** (`TAB_RELAY_TOKEN=…`, mode 600, git-ignored). It is generated on the first run. To rotate the token, delete the line and restart the server, then update every extension's options.

The database is at `server/data/tab-relay.db` (git-ignored).

## Limitations

- Plain HTTP on the LAN. The token travels unencrypted, so use it only on a trusted network, or put the server behind a TLS reverse proxy or VPN.
- There is one shared token, with no per-user or per-device accounts.
- Chrome doesn't expose the profile's display name to extensions, so the "profile label" is set by hand in the options.
- The account email is empty when the profile isn't signed in to Chrome, or when Chrome sync/identity is unavailable (e.g. some Chromium builds).
- Tab ids are only valid for the current browser session. A "close" for a tab that no longer exists is reported as `missing`. Tabs from offline clients still show their last known state.
- Commands for an offline client wait in the queue until it comes back. There is no expiry and no way to cancel from the UI.
- Some URLs can't be opened by extensions, e.g. `chrome://` pages, `file://` without "Allow access to file URLs", and other extensions' pages. Those show up as errors in the open result; in a move, the source tabs are then kept.
- Incognito windows are only synced if the extension is allowed in incognito. Tab groups, scroll position, history and form state are not transferred.
- The extension keeps its service worker alive with a 3 s loop, and the 30 s alarm brings it back if Chrome kills it. In the worst case, commands are picked up about 30 s late.
- The web UI polls every 4 s and redraws the tree. The selection, collapsed state and filter are kept.
- The extension was tested in headless Chromium, not yet in a real Chrome with a signed-in Google account.

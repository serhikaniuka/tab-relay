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

## Phase 3: duplicate clients fix

- **Cause:** on first run, the extension's `getClientId()` did read → generate → write with no lock. The poll loop and the push triggered by saving the options both ran before the id was stored, so each generated its own id. That produced two server clients for one profile, about 1 s apart, with one of them seen only once.
  - `ensureLoop()` could also start two poll loops at once, because its guard is only set after the first tick's awaits.
- **Extension 0.2.1:**
  - Client-id creation goes through one shared promise per service worker (read, then write once; it retries if storage fails).
  - The poll loop is started at most once.
- **Server:**
  - `DELETE /api/clients/:id` removes the client with its windows, tabs and commands, and keeps archive items and offline copies. It returns what it removed.
  - It used to fail with `FOREIGN KEY constraint failed` when another client's command depended on one of the removed client's commands (e.g. the close half of a move). Those dependents are now cancelled and detached first.
  - New `POST /api/clients/prune {olderThanDays}` removes offline clients not seen for N days (0 = all offline clients).
  - There is deliberately no automatic dedupe on push: duplicates stay until you remove them by hand.
- **Web UI:**
  - Offline profile nodes have a **Remove** button, which asks for confirmation (showing the client id, tab count and last seen).
  - The toolbar has **Remove offline clients…**, which prompts for N days and confirms the list of clients first.
- **Tests:** 24 API tests pass. New ones cover:
  - a duplicate client is kept on push;
  - remove with cross-client dependent commands, keeping the archive and offline copy, then 404 / 401;
  - prune by age.
- **The live DB is cleaned up:** the stale duplicate `f3c968f5-50e9-4cf1-aa18-2d8ee5e613e8` (devbox / personal, 11 tabs, seen only at creation) is removed through the new endpoint. `d78e7dae-…` is kept.
- **⚠ Reload the extension on every machine** (the reload button on its card in `chrome://extensions`, or Load unpacked again after pulling) to pick up the fix (v0.2.1). Existing clients keep their stored id, so nothing changes for them; the fix prevents new duplicates on fresh installs and new profiles.

## Phase 4: table view with page descriptions

- **Table view (the default)** with the columns **URL**, **Title** and **Description**.
  - URL: shortened in the middle, full on hover, clickable, with a favicon.
  - Title: with its badges (pinned / moving… / offline).
  - Description: up to 2 lines, "—" when unknown.
  - Machine → profile → window are **group header rows** with tri-state checkboxes, collapse arrows and hover actions. Profile rows (and single-profile machine rows) are drop targets.
  - Every leaf row has a checkbox, is draggable (a selected row drags the whole selection) and has hover buttons (Move / Archive / Archive+offline / Offline / Delete).
  - The column header stays visible under the sticky toolbar.
  - The **Archive** is a table too, with an extra **Archived** column, grouped Archive → machine → profile → date (Restore / Delete).
  - **Tree view** in the toolbar switches back to the old tree, and the choice is remembered. Both views are rendered from one model, so all actions work the same in both.
  - The filter also searches descriptions.
- **Descriptions from the live page (extension 0.3.0):**
  - `chrome.scripting.executeScript` reads `meta description` → `og:description` → `twitter:description` → the first paragraph with real text.
  - It runs when a tab finishes loading, on single-page-app URL changes, and for existing tabs at startup and install.
  - Results are cached per URL in `chrome.storage.session` and sent with the state push.
  - Skipped: `chrome://`, the Web Store, extension pages, `file://`; failed attempts are retried after 10 min.
  - New permissions: `scripting` and host access `<all_urls>`, which replaces the per-server optional host permission.
- **Server `page_meta` table** (url → description, source page / fetch / mhtml, fetch attempt and error):
  - The tree, archive and offline lists join descriptions by URL, so archived tabs and offline copies keep them.
  - A live-page description always wins; fetched and MHTML ones only fill gaps. Descriptions are trimmed to about 200 characters at a word boundary.
  - `GET /api/meta?url=` shows what is stored for a URL.
- **Server fetch fallback** for http(s) tabs without a description, e.g. discarded or unloaded tabs and archived tabs:
  - waits 15 s first, so the extension has the first chance;
  - 2 requests at a time, 1 request per host every 2 s, at most 500 queued;
  - 5 s deadline, 512 KB cap, 3 redirects, HTML only, respects the page's charset (e.g. windows-1251);
  - a failed fetch is retried after 24 h at the earliest;
  - `TAB_RELAY_META_FETCH=0` turns it off.
- **The fallback is LAN-safe:**
  - Private, loopback, link-local, CGNAT, multicast and reserved IPv4/IPv6 addresses (including v4-mapped) are refused.
  - Every DNS answer, IP-literal host and redirect hop is checked, and the connection goes to the checked address.
  - The tests caught that IP-literal URLs (`http://127.0.0.1/…`) skipped Node's custom `lookup`; they are now checked explicitly.
  - Checked against the real network: Wikipedia, GitHub, pravda.com.ua (Ukrainian) and example.com get descriptions; `192.168.1.103` and `localhost` are blocked.
- **MHTML uploads** fill in a missing description from the captured HTML.
- **Tests:** 33 pass. 24 are API tests; 9 new ones in `test/meta.test.js` use a local test website:
  - extraction rules, clamping, inline-tag spacing;
  - the private-address table;
  - the guarded fetch: blocking of 127.0.0.1 / localhost / `[::1]` / decimal IP / 192.168.x, file: and ftp:; redirects, 404, non-HTML, redirect loop, redirect to ftp; the 5 s deadline (tested with a short one); the size cap against an endless response; windows-1251;
  - queue rate limit, concurrency and bound;
  - page_meta priorities, the retry window, the archive keeping descriptions, the default fetcher refusing LAN URLs, and MHTML-derived descriptions.
- **e2e** (`scripts/e2e.js`, two Chromium profiles): it now also checks that:
  - descriptions from the live pages (meta tag, and the paragraph fallback clamped to 198 chars) reach the server;
  - the table cells show URL / title / description;
  - the archived row keeps its description;
  - the tree-view toggle works.
  - All earlier steps still pass on the table: drag & drop move, archive + offline, restore, delete, Remove client.
- **⚠ Reload the extension on every machine** (the reload button on its card in `chrome://extensions`, or Load unpacked again after pulling). Version 0.3.0 **asks for new permissions**: "Read and change all your data on all websites" (`<all_urls>`, needed to read page descriptions) and `scripting`. Chrome may disable the extension until you accept them; re-enable it on its card.
  - Until it's reloaded, the old extension sends no descriptions; the server fallback fills them in for public pages only.

## Phase 5: table polish (spacing, sorting)

- **Spacing:**
  - Cells have 9 px × 12 px padding, tab rows are at least 44 px high, and the header row has more room and a 2 px rule.
  - Group header rows are indented 20 px per level (machine / profile / window, or archive machine / profile / date). Each tab row's checkbox is indented to line up under its parent group's children.
  - Machine groups are separated by a gap. The toolbar, the layout margins (24 px) and the sidebar have more breathing room.
  - The archive table uses the same rules.
- **Sorting:** clickable column headers (**URL**, **Title**, **Description**, and **Archived** in the archive) with an arrow indicator. Each click cycles ▲ → ▼ → original browser order (the default).
  - URL sorts by host (without `www.`), then by the full URL, using locale-aware, numeric comparison. Empty titles and descriptions go last. Ties keep browser order.
  - Sorting applies within each window (or archive date group), so grouping stays.
  - **Flat list (no grouping)** in the toolbar sorts all tabs, and all archived tabs, globally. Rows then show their source machine/profile as a badge, and since there are no profile rows, client "drop chips" above the table keep drag-and-drop working.
  - The header has a select-all checkbox per table.
  - The sort and flat choice are saved in localStorage. The tree view uses the same sort order.
- **Code:** front-end only (`server/public/`). No server or extension changes, so there is no need to reload the extension for this phase.
- **Tests:** all 33 server tests pass (unchanged).
  - The e2e now also checks: the flat list has no group rows and shows 2 drop chips; URL ascending/descending matches the expected host-then-URL order; the ▲/▼ indicator; the choice survives a page reload; the third click restores the original order; title sort within each window keeps the groups; turning sorting off restores the grouped browser order.
  - The whole e2e passes, including all earlier steps.

## Phase 6: per-row action buttons

- **New column:** every table row has compact icon buttons right after its checkbox, before the URL. They act on that one tab, through the same endpoints as the bulk toolbar actions (no new API).
  - Live tabs:
    - **Delete** (trash) → `/api/actions/close`, after a confirmation naming the tab;
    - **Save offline** (download) → `/api/actions/offline`;
    - **Archive** (box) → `/api/actions/archive`.
  - Archived tabs:
    - **Delete permanently** → `/api/archive/delete`, with a confirmation;
    - **Restore** to the Target client → `/api/archive/restore`.
  - Archived rows have no Archive button, and no Save offline because the tab is already closed.
- **Feedback:**
  - Each button has a tooltip and shows a spinner while its request runs.
  - A message names the tab ("Archiving "Page four"") or shows the error, and the table refreshes.
  - Rows being moved, archived or closed get their buttons disabled, next to the existing *archiving…* / *closing…* badges.
- **Save offline states:**
  - A spinner and a *saving offline…* badge while a capture is pending. To support this, `/api/tree` now marks such tabs `capturing: true`; it's an extra field on an existing endpoint.
  - A green ✓ "saved" icon once a copy for that URL exists, with size and date in the tooltip. Clicking it saves a fresh copy, the same as the bulk Save offline, which also allows re-saving.
  - Disabled for pages that can't be captured (non-http(s), Web Store).
- **Selection:** per-row actions, and the existing hover actions, now deselect only the affected tabs. Before, any action cleared the whole selection. Bulk toolbar actions are unchanged.
- **Hover menu:** in the table, it keeps Move and Archive+offline (Delete/Offline/Archive moved into the row buttons). The tree view is unchanged.
- **Layout:** the buttons work in grouped and flat-list modes, in a fixed-width column (3 buttons for live tabs, 2 for archived ones). The archive table got narrower URL/Title columns so Description stays readable.
- **Tests:**
  - All 33 server tests pass; the save-offline test now also checks the `capturing` flag.
  - The e2e has a new row-button step: Save offline (→ ✓ "saved"), Archive, Restore and Delete permanently from the archive row, Delete with cancel and then confirm, another row's checkbox kept, Save offline disabled on `about:blank`, and 3 buttons per row in flat mode.
  - The earlier e2e column check now uses the cell classes, and also asserts the column order: checkbox | buttons | URL | Title | Description.
  - The full e2e passes.
- **What you need to do:** the server was restarted (for the `capturing` flag). **Just refresh the web UI page.** The extension is unchanged, so there's no need to reload it.

## Phase 7: single-line rows and 25/25/50 columns

- **One line per tab row**, in the live and archive tables, grouped and flat:
  - The height is fixed at 38 px (39 px with the border).
  - Checkbox, row buttons (now 24 px tall), favicon, text and badges sit on one vertically centred line.
  - In the Title cell the title text shrinks first and badges stay whole. The flat-list source badge gives way before the title does.
  - Group header rows stay single-line too, slightly taller, and their labels truncate instead of wrapping.
  - The archive's Archived cell uses a compact `YYYY-MM-DD HH:MM`, with the full date/time in its tooltip.
- **Column widths:** `table-layout: fixed` with a `colgroup`.
  - Checkbox (its width depends on the indentation depth), row buttons (112 px live, 80 px archive) and Archived (150 px) are fixed.
  - Of the remaining width, **URL 25 %, Title 25 %, Description 50 %**.
  - Chrome ignores `calc(100% - Npx)` on `<col>` (it split the three columns equally), so a `ResizeObserver` measures the flexible width into a CSS variable `--flex-w`, and the columns use `calc(var(--flex-w) * 0.25 / 0.25 / 0.5)`. This holds on window resize, in both tables and in flat mode.
- **Overflow:** URL, Title, Description (and Archived) use `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`.
  - Each cell carries the full text in a native `title` tooltip.
  - When the text is actually truncated, or the URL is shown shortened, hovering for 350 ms shows a **styled popover** with the full text, URLs in monospace. The native tooltip is suppressed meanwhile so the two don't stack. The popover hides on mouse-out, scroll and drag.
- **Unchanged:** row buttons, hover actions, sorting, grouping, flat list, drag & drop and bulk actions all work as before.
- **Tests:** all 33 server tests pass. The e2e now checks:
  - live grouped, archive and flat tables have every row one line at the same height (39 px);
  - no URL / Title / Description / Archived text wraps;
  - the URL / Title / Description width ratios are 25/25/50 within ±1.5 %;
  - the popover shows the full 198-character description of a truncated cell, the native tooltip is suppressed while it shows and restored after.
  - The full e2e passes.
- **What you need to do:** only static files changed (`server/public/`), served straight from disk, so there was no server restart. **Just refresh the web UI page (Ctrl+Shift+R if the browser cached the old files).** The extension is unchanged, so there's no need to reload it.

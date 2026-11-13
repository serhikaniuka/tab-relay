# Tab Relay

Move Chrome tabs between machines and profiles over your LAN.

- **server/** is a small Node.js + SQLite server. It stores every connected Chrome profile's windows and tabs, queues commands for each client (open, close, capture), and keeps the archive, offline page copies and snapshots. It also serves the web UI.
- **extension/** is a Chrome MV3 extension. It pushes the profile's tabs to the server, runs the commands the server queues for it, and uploads pages saved for offline reading.
- **Web UI** (`http://<server>:8787/`) shows a tree: machine → Chrome profile (Google account or "not signed in") → window → tabs, with an **Archive** section below it. You can select tabs at any level, or drag them onto another profile, to:
  - move them to another machine
  - open copies there
  - archive them
  - save them for offline reading
  - delete them
  - save and restore snapshots

## 1. Run the server

Requires Node.js 18+ (tested with 22).

```bash
cd server
npm install
npm start          # listens on 0.0.0.0:8787
```

On first start the server generates a random token and saves it to **`server/.env`** (`TAB_RELAY_TOKEN=…`, mode 600). The path is printed at startup. Get the token with:

```bash
grep TAB_RELAY_TOKEN server/.env
```

Optional settings, either in `server/.env` or as environment variables:

- `PORT` (default 8787)
- `HOST` (default `0.0.0.0`)
- `TAB_RELAY_DB` (default `server/data/tab-relay.db`)
- `TAB_RELAY_OFFLINE_DIR`: where offline copies are stored (default `server/data/offline/`)
- `MAX_OFFLINE_MB`: the size limit for one captured page (default 200)

### Keep it running

**tmux** (simplest):

```bash
./run-server.sh                          # (re)starts it in tmux session "tab-relay-server"
tmux attach -t tab-relay-server          # view logs; detach with Ctrl-b d
```

**systemd --user** (starts on boot, no sudo):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/tab-relay.service ~/.config/systemd/user/   # adjust WorkingDirectory if needed
systemctl --user daemon-reload
systemctl --user enable --now tab-relay
loginctl enable-linger "$USER"     # keep running while logged out
journalctl --user -u tab-relay -f  # logs
```

Use only one of the two, because both bind to port 8787.

### Tests

```bash
cd server && npm test
```

There is also an optional end-to-end check, `scripts/e2e.js` (setup instructions are in the comments at the top of the file). It runs two headless Chromium profiles with the real extension against a throwaway server and checks:

- saving a page offline, and archive + offline
- drag-and-drop move in the UI
- reading the offline copy while the site is down
- restoring from the archive, and delete

Set `E2E_REAL_URL=https://…` to also capture a real website.

## 2. Install the extension (on every machine and Chrome profile)

1. Copy the `extension/` folder to the machine, or clone the repo there.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/` folder.
4. The options page opens automatically. If it doesn't, open it from the extension's **Details → Extension options**. Fill in:
   - **Server URL**: e.g. `http://192.168.1.103:8787`
   - **Token**: the value of `TAB_RELAY_TOKEN` from `server/.env`
   - **Machine name**: e.g. `MacBook`, `devbox`
   - **Profile label** (optional): e.g. `Work`. Chrome doesn't tell extensions the profile name, so you can set it here.
5. Click **Save & sync** and allow access to the server when Chrome asks. The page should report "Connected".

After updating the extension (version 0.2 adds the `pageCapture` permission), click the reload icon on its card in `chrome://extensions` on every machine.

Repeat this for each Chrome profile you want to see. Each profile gets its own stable client id. The Google account is read with `chrome.identity.getProfileUserInfo`. If the profile isn't signed in to Chrome, it shows as "not signed in".

Click the extension's toolbar icon to open the web UI. The token is passed in the URL fragment, so you don't have to type it.

## 3. Use the web UI

Open `http://192.168.1.103:8787/` and enter the token (it's remembered in localStorage).

- Tick checkboxes on machines, profiles, windows or single tabs. The filter box narrows the tree. All toolbar buttons are bulk actions on the current selection.
- Hovering over any tab, window, profile or machine shows quick buttons for that node: **Move, Archive, Archive+offline, Offline, Delete**. Archive nodes show **Restore** and **Delete**.
- Pick a **Target** client. With **new window** ticked, the tabs open in new windows, one per source window, so moving a whole profile keeps its window layout.

**Live tabs**
- **Open on target** opens copies of the selected tabs on the target.
- **Move to target** opens the tabs on the target. The source tabs close only after the target confirms that every tab opened.
- **Drag and drop:** drag a tab, window, profile or machine onto another profile (or onto a machine that has only one profile) to move it there. Hold **Ctrl** (or Alt) while dropping to copy instead. If you drag a selected tab, the whole selection goes with it.
- **Archive** closes the tabs on their source and keeps them in the **Archive** section of the tree, grouped by source machine → profile → date.
- **Archive + save offline** captures each page first, then archives it and closes it. If a page can't be captured (e.g. `chrome://` pages), it is still archived, just without a copy.
- **Save offline** captures the pages as MHTML (`chrome.pageCapture`) and stores them on the server. The tabs stay open.
- **Delete** closes the tabs without archiving them, after a confirmation.
- **Save snapshot** stores the selected tabs (URL, title, pinned state, source). Snapshots are listed on the right. **Restore** opens a snapshot in a new window on the chosen client.
- Tabs waiting to be closed are greyed out and marked *moving…*, *archiving…* or *closing…*.

**Archive**
- Select archived tabs (at any level), then click **Restore to target**. The tabs open in new windows on the target and leave the archive once they have opened. You can also drag archived tabs onto a profile.
- **Delete permanently** removes archived tabs, and their offline copies, after a confirmation.

**Offline copies**
- Tabs with a saved copy show a blue **offline** badge with the size. This applies to live tabs (matched by URL) and to archived tabs. Click the badge to read the copy.
- The **Offline copies** panel lists every copy, with its size and the total. Each copy has these links:
  - **title**: read the copy
  - **mhtml**: the raw archive as `multipart/related`
  - **⬇**: download the `.mhtml` file
  - **✕**: delete the copy
- Copies stay readable after the tab is closed or the site goes down. They are only removed when you delete them.
- Chrome won't display MHTML loaded over http(s); it always downloads it. So the server unpacks the archive: the reader view serves the saved HTML, and its images, CSS and frames come from the same copy. Scripts are disabled (`CSP: sandbox; script-src 'none'`). The downloaded `.mhtml` opens in Chrome as a file.

**Other**
- A green dot means the client was in contact within the last 30 s. Offline clients can be removed with **forget**.
- **Recent commands** shows the queue status: pending, delivered, done, failed, or cancelled.

## How it works

- The extension pushes the full tab state on tab and window events (debounced by 1 s) and every 10 s. It polls `GET /api/clients/:id/commands` every 3 s. A `chrome.alarms` tick every 30 s restarts the loop if Chrome suspended the service worker.
- Once delivered, a command isn't sent again unless it stays unacked for 60 s. The extension also remembers which command ids it has already run, so a lost ack doesn't make it open the tabs twice.
- In a move, each close command depends on the open command. The server releases the close only after the open is acked as successful. If the open fails, the close is cancelled.
- In archive + offline, the close depends on the capture with mode `finish`: it runs once the capture is over, even if some pages failed, because the archive already holds the URLs.
- Offline capture: the server queues a `capture` command for the source client. The extension reloads discarded tabs if needed, calls `chrome.pageCapture.saveAsMHTML`, and streams each page to `POST /api/clients/:id/offline`. The server writes the file to `server/data/offline/` and the metadata to SQLite. The upload size is capped by `MAX_OFFLINE_MB`.
- Auth: every `/api/*` call (except `/api/health`) needs `Authorization: Bearer <token>`. The browser opens offline copy links directly, so those GET routes (`/api/offline/:id/view|raw|download|res/:n`) also accept `?token=`. No other route does.

### API summary

| Method & path | Purpose |
|---|---|
| `POST /api/clients/:id/state` | extension: full state push `{machine, profile:{email,label}, windows:[{id,focused,tabs:[…]}]}` |
| `GET /api/clients/:id/commands` | extension: fetch pending commands |
| `POST /api/commands/:id/ack` | extension: `{ok, result \| error}` |
| `GET /api/tree` | all clients → windows → tabs, with `online` |
| `POST /api/actions/open` / `move` | `{tabs:[{clientId,tabId}], targetClientId, newWindow}` |
| `POST /api/actions/close` | delete (close, no archive): `{tabs:[{clientId,tabId}]}` |
| `POST /api/actions/archive` | `{tabs, offline?}` → archive items and capture/close commands |
| `POST /api/actions/offline` | `{tabs}` → capture commands |
| `GET /api/archive` | archived items (with source and the linked offline copy) |
| `POST /api/archive/restore` | `{ids, targetClientId, newWindow?, remove?}` |
| `POST /api/archive/delete` | `{ids}` → permanent delete, including the offline copies |
| `POST /api/clients/:id/offline?tabId=&commandId=` | extension: upload MHTML (raw body, `X-Tab-Url` / `X-Tab-Title` URI-encoded) |
| `GET /api/offline` | offline copies and their total size |
| `GET /api/offline/:id/view` · `/res/:n` · `/raw` · `/download` | reader view, its parts, raw `multipart/related`, download |
| `DELETE /api/offline/:id` | delete an offline copy |
| `POST /api/commands` | raw command `{clientId, type:'open', urls, newWindow}` or `{clientId, type:'close', tabIds}` |
| `GET /api/commands` | recent commands and their status |
| `GET/POST /api/snapshots`, `POST /api/snapshots/:id/restore`, `DELETE /api/snapshots/:id` | snapshots |
| `DELETE /api/clients/:id` | forget a client |

## Українською

**Tab Relay** переносить вкладки Chrome між комп'ютерами та профілями в локальній мережі.

1. **Сервер:** `cd server && npm install && npm start`. Сервер слухає `0.0.0.0:8787`. Під час першого запуску він створює токен і зберігає його в `server/.env` (`TAB_RELAY_TOKEN`). Щоб сервер працював постійно, запустіть `./run-server.sh` (tmux-сесія `tab-relay-server`) або встановіть systemd-юніт `deploy/tab-relay.service` у `~/.config/systemd/user/` і виконайте `systemctl --user enable --now tab-relay`.
2. **Розширення:** відкрийте `chrome://extensions`, увімкніть **Режим розробника** (Developer mode), натисніть **Завантажити розпаковане** (Load unpacked) і виберіть папку `extension/`. У налаштуваннях розширення вкажіть URL сервера (`http://192.168.1.103:8787`), токен і назву машини. Повторіть це для кожного профілю Chrome.
3. **Веб-інтерфейс:** відкрийте `http://192.168.1.103:8787/` і введіть токен. Дерево показує машину → профіль → вікно → вкладки, а під ним розділ **Archive** (архів).
   - **Перенесення:** позначте вкладки, вікно або цілий профіль, виберіть цільовий клієнт і натисніть «Move to target». Те саме можна зробити перетягуванням на вузол профілю іншої машини (з Ctrl вкладки копіюються).
   - **Архів:** «Archive» закриває вкладки й зберігає їх на сервері (групування: машина → профіль → дата). «Restore to target» відкриває їх знову на вибраному клієнті, «Delete permanently» видаляє назавжди.
   - **Офлайн-копії:** «Save offline» зберігає сторінку як MHTML на сервері, а «Archive + save offline» робить те саме й одразу архівує вкладку. Значок **offline** відкриває збережену копію навіть тоді, коли сайт недоступний. Розмір копій видно на панелі «Offline copies», там же їх можна видалити.
   - **Видалення:** «Delete» закриває вкладки без архівування (після підтвердження).
   - Після оновлення розширення натисніть «Оновити» (reload) на його картці в `chrome://extensions`: версія 0.2 потребує дозволу `pageCapture`.

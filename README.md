# Tab Relay

Move Chrome tabs between machines and profiles over your LAN.

- **server/** is a small Node.js + SQLite server. It stores every connected Chrome profile's windows and tabs, queues open/close commands for each client, keeps snapshots, and serves the web UI.
- **extension/** is a Chrome MV3 extension. It pushes the profile's tabs to the server and runs the open/close commands the server queues for it.
- **Web UI** (`http://<server>:8787/`) shows a tree: machine → Chrome profile (Google account or "not signed in") → window → tabs. Select tabs at any level, then open them on another machine, close them on their source, move them (open on the target, then close on the source), or save and restore snapshots.

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

Optional settings, either in `server/.env` or as environment variables: `PORT` (default 8787), `HOST` (default `0.0.0.0`), `TAB_RELAY_DB` (default `server/data/tab-relay.db`).

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

There is also an optional end-to-end check that loads the real extension into a headless Chromium: `scripts/e2e.js` (see the comments at the top of the file).

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

Repeat this for each Chrome profile you want to see. Each profile gets its own stable client id. The Google account is read with `chrome.identity.getProfileUserInfo`. If the profile isn't signed in to Chrome, it shows as "not signed in".

Click the extension's toolbar icon to open the web UI. The token is passed in the URL fragment, so you don't have to type it.

## 3. Use the web UI

Open `http://192.168.1.103:8787/` and enter the token (it's remembered in localStorage).

- Tick checkboxes on machines, profiles, windows or single tabs. The filter box narrows the tree.
- Pick a **Target** client. Tick **new window** if you want the tabs in a separate window.
- **Open on target** opens copies of the selected tabs on the target.
- **Move to target** opens the tabs on the target. The source tabs close only after the target confirms that every tab opened.
- **Close on source** closes the selected tabs wherever they are.
- **Save snapshot** stores the selected tabs (URL, title, pinned state, source). Snapshots are listed on the right. **Restore** opens a snapshot in a new window on the chosen client.
- A green dot means the client was in contact within the last 30 s. Offline clients can be removed with **forget**.
- **Recent commands** shows the queue status: pending, delivered, done, failed, or cancelled.

## How it works

- The extension pushes the full tab state on tab and window events (debounced by 1 s) and every 10 s. It polls `GET /api/clients/:id/commands` every 3 s. A `chrome.alarms` tick every 30 s restarts the loop if Chrome suspended the service worker.
- Once delivered, a command isn't sent again unless it stays unacked for 60 s. The extension also remembers which command ids it has already run, so a lost ack doesn't make it open the tabs twice.
- In a move, each close command depends on the open command. The server releases the close only after the open is acked as successful. If the open fails, the close is cancelled.
- Auth: every `/api/*` call (except `/api/health`) needs `Authorization: Bearer <token>`.

### API summary

| Method & path | Purpose |
|---|---|
| `POST /api/clients/:id/state` | extension: full state push `{machine, profile:{email,label}, windows:[{id,focused,tabs:[…]}]}` |
| `GET /api/clients/:id/commands` | extension: fetch pending commands |
| `POST /api/commands/:id/ack` | extension: `{ok, result \| error}` |
| `GET /api/tree` | all clients → windows → tabs, with `online` |
| `POST /api/actions/open` / `move` | `{tabs:[{clientId,tabId}], targetClientId, newWindow}` |
| `POST /api/actions/close` | `{tabs:[{clientId,tabId}]}` |
| `POST /api/commands` | raw command `{clientId, type:'open', urls, newWindow}` or `{clientId, type:'close', tabIds}` |
| `GET /api/commands` | recent commands and their status |
| `GET/POST /api/snapshots`, `POST /api/snapshots/:id/restore`, `DELETE /api/snapshots/:id` | snapshots |
| `DELETE /api/clients/:id` | forget a client |

## Українською

**Tab Relay** переносить вкладки Chrome між комп'ютерами та профілями в локальній мережі.

1. **Сервер:** `cd server && npm install && npm start`. Сервер слухає `0.0.0.0:8787`. Під час першого запуску він створює токен і зберігає його в `server/.env` (`TAB_RELAY_TOKEN`). Щоб сервер працював постійно, запустіть `./run-server.sh` (tmux-сесія `tab-relay-server`) або встановіть systemd-юніт `deploy/tab-relay.service` у `~/.config/systemd/user/` і виконайте `systemctl --user enable --now tab-relay`.
2. **Розширення:** відкрийте `chrome://extensions`, увімкніть **Режим розробника** (Developer mode), натисніть **Завантажити розпаковане** (Load unpacked) і виберіть папку `extension/`. У налаштуваннях розширення вкажіть URL сервера (`http://192.168.1.103:8787`), токен і назву машини. Повторіть це для кожного профілю Chrome.
3. **Веб-інтерфейс:** відкрийте `http://192.168.1.103:8787/` і введіть токен. Дерево показує машину → профіль → вікно → вкладки. Позначте потрібні вкладки, виберіть цільовий клієнт і натисніть «Open on target» (відкрити), «Move to target» (перенести), «Close on source» (закрити) або «Save snapshot» (зберегти знімок).

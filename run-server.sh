#!/usr/bin/env bash
# Start (or restart) the server in a detached tmux session "tab-relay-server".
set -euo pipefail
cd "$(dirname "$0")/server"
[ -d node_modules ] || npm install --omit=dev
tmux kill-session -t tab-relay-server 2>/dev/null || true
tmux new-session -d -s tab-relay-server "node src/index.js 2>&1 | tee -a server.log"
sleep 1
tmux capture-pane -pt tab-relay-server

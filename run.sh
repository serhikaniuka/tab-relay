#!/bin/bash -l
cd ~/Projects/tab-relay
export PATH="$HOME/.local/bin:$PATH"
claude -p "$(cat TASK.md)" --dangerously-skip-permissions --output-format stream-json --verbose > claude.log 2>&1
echo "EXIT $?" >> claude.log

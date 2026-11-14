#!/bin/bash -l
cd ~/Projects/tab-relay
export PATH="$HOME/.local/bin:$PATH"
claude --continue -p "$(cat TASK5.md)" --dangerously-skip-permissions --output-format stream-json --verbose > claude5.log 2>&1
echo "EXIT $?" >> claude5.log

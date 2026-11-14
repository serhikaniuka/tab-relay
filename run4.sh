#!/bin/bash -l
cd ~/Projects/tab-relay
export PATH="$HOME/.local/bin:$PATH"
claude --continue -p "$(cat TASK4.md)" --dangerously-skip-permissions --output-format stream-json --verbose > claude4.log 2>&1
echo "EXIT $?" >> claude4.log

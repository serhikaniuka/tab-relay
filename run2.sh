#!/bin/bash -l
cd ~/Projects/tab-relay
export PATH="$HOME/.local/bin:$PATH"
while ! grep -qa "^EXIT" claude.log; do sleep 20; done
claude --continue -p "$(cat TASK2.md)" --dangerously-skip-permissions --output-format stream-json --verbose > claude2.log 2>&1
echo "EXIT $?" >> claude2.log

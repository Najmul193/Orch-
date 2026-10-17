#!/bin/sh
# Start orch (dashboard + agent runner + Claude limit watcher) in the background.
cd "$(dirname "$0")" && mkdir -p data
nohup node bin/orch.mjs serve >> data/orch.log 2>&1 &
sleep 1
tail -n 1 data/orch.log

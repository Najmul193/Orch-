#!/bin/sh
# Stop orch. On SIGTERM it stops the agents it is running first, then exits.
PATTERN='bin/orch(\.mjs)? serve'
pkill -TERM -f "$PATTERN" || { echo "orch is not running"; exit 0; }
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pgrep -f "$PATTERN" > /dev/null || { echo "orch stopped"; exit 0; }
  sleep 0.5
done
echo "orch did not stop within 5s, force-killing it (running agents may keep going)"
pkill -KILL -f "$PATTERN"

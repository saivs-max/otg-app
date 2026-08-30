#!/bin/sh
# bin/start.sh — container entrypoint
# 1. On first boot (or after a volume replacement), restore the DB from R2.
# 2. Start litestream as PID 1 wrapping Node so replication runs continuously
#    and SIGTERM on deploys/restarts is handled cleanly.
set -e

DB=/app/data/otg.db
CFG=/app/litestream.yml

if [ ! -f "$DB" ]; then
  echo "[start] No database found — attempting restore from R2..."
  if litestream restore -if-replica-exists -config "$CFG" "$DB"; then
    echo "[start] Restore complete."
  else
    echo "[start] No replica in R2 yet — starting fresh."
  fi
fi

exec litestream replicate -config "$CFG" \
  -exec "node --experimental-sqlite --no-warnings=ExperimentalWarning server.js"

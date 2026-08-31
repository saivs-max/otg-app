#!/bin/sh
# bin/start.sh — container entrypoint
# 1. On first boot (or after a volume replacement), restore the DB from R2/Tigris.
# 2. Start litestream as PID 1 wrapping Node so replication runs continuously
#    and SIGTERM on deploys/restarts is handled cleanly.
#
# v0.91.1 — Litestream is now OPTIONAL at boot. Previously an unconfigured or
# failing litestream took the whole app down (it was PID 1 via `exec`), so a
# missing Tigris secret = production outage. Now, if litestream's credentials
# aren't present, we log a loud warning and run Node directly (no replication)
# so the app always comes up. Setting the secrets (see below) re-enables
# continuous replication automatically on the next boot.
set -e

DB=/app/data/otg.db
CFG=/app/litestream.yml

# Litestream needs all four of these (injected by `fly storage create` +
# `fly secrets set LITESTREAM_BUCKET=...`). If any is missing it cannot start.
litestream_configured() {
  [ -n "$LITESTREAM_BUCKET" ] && \
  [ -n "$AWS_ACCESS_KEY_ID" ] && \
  [ -n "$AWS_SECRET_ACCESS_KEY" ] && \
  [ -n "$AWS_ENDPOINT_URL_S3" ]
}

run_node_direct() {
  exec node --experimental-sqlite --no-warnings=ExperimentalWarning server.js
}

if ! command -v litestream >/dev/null 2>&1 || ! litestream_configured; then
  echo "[start] ============================================================"
  echo "[start] WARNING: litestream is NOT configured (missing bucket or"
  echo "[start] Tigris credentials). Starting Node WITHOUT DB replication."
  echo "[start] The existing database on the volume is used as-is and is NOT"
  echo "[start] backed up until you run:"
  echo "[start]     fly storage create"
  echo "[start]     fly secrets set LITESTREAM_BUCKET=<bucket> -a breadapp"
  echo "[start] ============================================================"
  run_node_direct
fi

# Litestream is configured. Only restore when there's no local DB (fresh volume);
# an existing production DB is used as-is and never overwritten.
if [ ! -f "$DB" ]; then
  echo "[start] No database found — attempting restore from replica..."
  if litestream restore -if-replica-exists -config "$CFG" "$DB"; then
    echo "[start] Restore complete."
  else
    echo "[start] No replica yet — starting fresh."
  fi
fi

exec litestream replicate -config "$CFG" \
  -exec "node --experimental-sqlite --no-warnings=ExperimentalWarning server.js"

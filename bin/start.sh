#!/bin/sh
# bin/start.sh — container entrypoint
#
# v0.91.2 — Node is ALWAYS PID 1; litestream replication is best-effort and can
# NEVER block boot. Previously litestream ran as PID 1 wrapping Node
# (`exec litestream ... -exec node`), so ANY litestream startup failure — a
# missing OR wrong LITESTREAM_BUCKET, bad credentials, an unreachable endpoint —
# crash-looped the machine and failed the whole deploy. Now:
#   - if the DB is missing AND a replica is configured, try a restore (non-fatal);
#   - if replication is configured, start `litestream replicate` in the BACKGROUND;
#   - then exec Node in the foreground as PID 1.
# A broken or misconfigured replica just means "no backup" (logged loudly) — the
# app still boots and serves. Fix the bucket/credentials and replication resumes
# on the next restart, no code change needed.
set -e

DB=/app/data/otg.db
CFG=/app/litestream.yml

# Litestream needs its binary plus all four Tigris/S3 values (bucket + AWS_*,
# injected by `fly storage create` + `fly secrets set LITESTREAM_BUCKET=...`).
litestream_configured() {
  command -v litestream >/dev/null 2>&1 && \
  [ -n "$LITESTREAM_BUCKET" ] && \
  [ -n "$AWS_ACCESS_KEY_ID" ] && \
  [ -n "$AWS_SECRET_ACCESS_KEY" ] && \
  [ -n "$AWS_ENDPOINT_URL_S3" ]
}

if litestream_configured; then
  # Restore only when there's no local DB (fresh volume). An existing production
  # DB is used as-is and never overwritten. Restore failure is non-fatal.
  if [ ! -f "$DB" ]; then
    echo "[start] No database found — attempting one-time restore from replica..."
    if litestream restore -if-replica-exists -config "$CFG" "$DB"; then
      echo "[start] Restore complete."
    else
      echo "[start] Restore skipped/failed — starting fresh (non-fatal)."
    fi
  fi
  echo "[start] Starting litestream replication in the background (best-effort)."
  # Background, best-effort: litestream watches the SQLite WAL independently of
  # the Node process, so it does not need to wrap it. If it can't reach the
  # replica it logs the error and exits; Node keeps serving either way.
  litestream replicate -config "$CFG" &
else
  echo "[start] ============================================================"
  echo "[start] WARNING: litestream is NOT configured (missing bucket or"
  echo "[start] Tigris credentials). Running WITHOUT database replication."
  echo "[start] Set LITESTREAM_BUCKET + the Tigris AWS_* secrets to enable"
  echo "[start] continuous backup. The app still boots and serves normally."
  echo "[start] ============================================================"
fi

# Node is ALWAYS PID 1 — the app boots regardless of litestream's health.
exec node --experimental-sqlite --no-warnings=ExperimentalWarning server.js

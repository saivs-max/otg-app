# Bread (OTG Field Cost App) — Fly.io image.
# Node 22 is required for the built-in `node:sqlite` module (db.js).
FROM node:22-slim

# App lives in /app; the Fly volume is mounted at /app/data (see fly.toml),
# which is exactly where db.js and the attachment routes read/write.
WORKDIR /app

ENV NODE_ENV=production
# v0.90 — SMTP for Send-to-AP email. Set these secrets via `fly secrets set`.
# When SMTP_HOST is absent the app falls back to log-only mode (no real email).
# ENV SMTP_HOST=
# ENV SMTP_PORT=587
# ENV SMTP_SECURE=false
# ENV SMTP_USER=
# ENV SMTP_PASS=
# ENV SMTP_FROM=Bread App <bread@instacart.com>

# v0.74 — OCR for image-only / scanned vendor invoices. `tesseract-ocr` does the
# OCR and `poppler-utils` (pdftoppm) rasterizes PDF pages to images first. These
# are the only system packages we shell out to (see lib/ocr.js); everything else
# stays pure-JS. If this layer is dropped, OCR degrades gracefully to "scanned —
# enter manually" rather than breaking uploads.
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr curl \
    && rm -rf /var/lib/apt/lists/*

# v0.91 — Install litestream for continuous SQLite replication to Cloudflare R2.
# Credentials (LITESTREAM_ACCESS_KEY_ID, LITESTREAM_SECRET_ACCESS_KEY,
# LITESTREAM_BUCKET, CLOUDFLARE_ACCOUNT_ID) are set as Fly secrets.
ARG LITESTREAM_VERSION=0.3.13
RUN curl -sSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz" \
    | tar -C /usr/local/bin -xz

# Install dependencies first for better layer caching.
# All Node deps are pure-JS (no native addons), so no build toolchain is needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the rest of the app (see .dockerignore for what's excluded).
# The UI is the vanilla app in public/ (restyled via public/redesign.css) — no
# build step required.
COPY . .

RUN chmod +x bin/start.sh

EXPOSE 3000

# litestream is PID 1; it wraps Node and handles SIGTERM on deploys/restarts.
# On first boot it restores the DB from R2 if a replica exists (see bin/start.sh).
CMD ["/app/bin/start.sh"]

# Bread (OTG Field Cost App) — Fly.io image.
# Node 22 is required for the built-in `node:sqlite` module (db.js).
FROM node:22-slim

# App lives in /app; the Fly volume is mounted at /app/data (see fly.toml),
# which is exactly where db.js and the attachment routes read/write.
WORKDIR /app

ENV NODE_ENV=production

# v0.74 — OCR for image-only / scanned vendor invoices. `tesseract-ocr` does the
# OCR and `poppler-utils` (pdftoppm) rasterizes PDF pages to images first. These
# are the only system packages we shell out to (see lib/ocr.js); everything else
# stays pure-JS. If this layer is dropped, OCR degrades gracefully to "scanned —
# enter manually" rather than breaking uploads.
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first for better layer caching.
# All Node deps are pure-JS (no native addons), so no build toolchain is needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the rest of the app (see .dockerignore for what's excluded).
# The UI is the vanilla app in public/ (restyled via public/redesign.css) — no
# build step required.
COPY . .

EXPOSE 3000

# Run node directly so it is PID 1 and receives SIGTERM on deploys/restarts.
CMD ["node", "--experimental-sqlite", "--no-warnings=ExperimentalWarning", "server.js"]

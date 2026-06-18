# Caper CostWise — Fly.io image
# Node 22 is required for the built-in `node:sqlite` module (db.js).
FROM node:22-slim

# App lives in /app; the Fly volume is mounted at /app/data (see fly.toml),
# which is exactly where db.js and the attachment routes read/write
# (path.join(__dirname, 'data', ...)). No code changes needed.
WORKDIR /app

ENV NODE_ENV=production

# Install dependencies first for better layer caching.
# All deps are pure-JS (no native addons), so no build toolchain is needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the rest of the app (see .dockerignore for what's excluded).
COPY . .

# The server listens on PORT (defaults to 3000); fly.toml sets it explicitly.
EXPOSE 3000

# Run node directly so it is PID 1 and receives SIGTERM on deploys/restarts.
# Flags mirror the npm "start" script (Node 22 needs --experimental-sqlite).
CMD ["node", "--experimental-sqlite", "--no-warnings=ExperimentalWarning", "server.js"]

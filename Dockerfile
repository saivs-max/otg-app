# Bread — Fly.io image. Multi-stage: build the redesigned React UI, then run.
# Node 22 is required for the built-in `node:sqlite` module (db.js).

# ---- Stage 1: build the redesigned "Bread" UI  →  /app/web-dist ----
FROM node:22-slim AS webbuild
WORKDIR /app/redesign/react-app
# Install UI deps first for better layer caching.
COPY redesign/react-app/package.json redesign/react-app/package-lock.json ./
RUN npm ci
# Build the UI. vite.web.config.js outputs to ../../web-dist → /app/web-dist
COPY redesign/react-app/ ./
RUN npm run build:web

# ---- Stage 2: runtime ----
FROM node:22-slim
WORKDIR /app

ENV NODE_ENV=production

# Server deps (pure-JS, no native build toolchain needed).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (see .dockerignore for exclusions).
COPY . .

# Bring in the freshly built UI from the builder stage so server.js serves it
# at the site root. (web-dist is git-ignored; it's always built here.)
COPY --from=webbuild /app/web-dist ./web-dist

EXPOSE 3000

# Run node directly so it is PID 1 and receives SIGTERM on deploys/restarts.
CMD ["node", "--experimental-sqlite", "--no-warnings=ExperimentalWarning", "server.js"]

// lib/download_tokens.js — v0.45
//
// Short-lived, single-use download tokens for Excel exports and PDF links
// that get clicked via `<a target="_blank">`. The browser can't add an
// Authorization header on a plain anchor click, and putting the bearer
// session token into the URL exposes it in browser history, server access
// logs, and Referer headers.
//
// Flow:
//   1. The frontend calls POST /api/download-token while authenticated to
//      mint a one-time token bound to a specific path + query.
//   2. The server returns a short opaque token (32-byte hex), valid for
//      5 minutes.
//   3. The frontend builds the download URL with `?dt=<token>`.
//   4. When the user clicks the link, the server exchanges the dt for the
//      original session (which the token was bound to) — once. The token
//      is then deleted so the link can't be replayed.
//
// In-memory store keyed by token. Sufficient for single-process Node.
// For multi-process deployments, swap for a DB or Redis.
const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000;   // 5 minutes

const store = new Map();        // token → { user_id, path, query, expires_at }

function _purge() {
  const now = Date.now();
  for (const [tok, rec] of store) if (rec.expires_at < now) store.delete(tok);
}

// Issue a new download token for the calling user. `path` is the URL path
// the token will be valid against (e.g. `/api/dashboard/export`); `query`
// is the query string that must match (so a token can't be repurposed for
// a different filter slice).
function issue(userId, path, query = '') {
  _purge();
  const token = crypto.randomBytes(32).toString('hex');
  store.set(token, {
    user_id: Number(userId),
    path: String(path),
    query: String(query || ''),
    expires_at: Date.now() + TTL_MS,
  });
  return { token, expires_at: new Date(Date.now() + TTL_MS).toISOString() };
}

// Consume (single-use): redeems the token if it matches `path` + `query`,
// returns the bound user_id, then deletes it. Returns null on miss / mismatch.
function redeem(token, path, query = '') {
  _purge();
  if (!token) return null;
  const rec = store.get(token);
  if (!rec) return null;
  if (rec.expires_at < Date.now()) { store.delete(token); return null; }
  if (rec.path !== path) return null;
  if (rec.query !== query) return null;
  store.delete(token);     // single-use: invalidate immediately
  return rec.user_id;
}

module.exports = { issue, redeem, TTL_MS };

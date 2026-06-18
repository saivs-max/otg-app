// Real authentication for the OTG app.
//
// - Passwords hashed with Node's built-in crypto.scrypt (no new deps).
//   Stored format: "scrypt$N$r$p$saltHex$keyHex" so future upgrades to
//   parameters can be detected and the hash transparently re-derived.
// - Sessions are 32-byte random tokens stored in the `sessions` table with a
//   30-day default TTL. Clients send `Authorization: Bearer <token>` (or, for
//   simple GET links, ?uid=... is still honored as a legacy fallback).
// - Middleware reads the token, looks up the session, sets req.user, and
//   ALSO sets req.headers['x-user-id'] so existing handlers that read that
//   header continue working without modification.

const crypto = require('crypto');

const SCRYPT_N = 16384;          // CPU/memory cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN  = 64;             // bytes
const SALT_LEN = 16;             // bytes
const SESSION_TTL_DAYS = 30;

function hashPassword(password) {
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  // v0.65.1 (F-L1) — cap length so a multi-MB password can't be used to burn CPU.
  if (password.length > 128) throw new Error('Password must be at most 128 characters');
  const salt = crypto.randomBytes(SALT_LEN);
  const key = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

// v0.65.1 (F-L1) — async so the scrypt KDF (deliberately ~tens of ms) doesn't
// block the single-threaded event loop on every login. Returns a Promise<bool>.
function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    if (!password || !stored || password.length > 128) return resolve(false);
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false);
    const N = parseInt(parts[1], 10), r = parseInt(parts[2], 10), p = parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], 'hex');
    const expected = Buffer.from(parts[5], 'hex');
    crypto.scrypt(password, salt, expected.length, { N, r, p }, (err, got) => {
      if (err) return resolve(false);
      try { resolve(crypto.timingSafeEqual(got, expected)); } catch (_) { resolve(false); }
    });
  });
}

function newToken() { return crypto.randomBytes(32).toString('hex'); }
// v0.65.1 (F-L2) — store only a SHA-256 of the session token so a DB read leak
// can't be replayed as a live session. The raw token is returned to the client.
function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }

function createSession(db, userId, userAgent) {
  const token = newToken();
  const now = new Date();
  const exp = new Date(now); exp.setDate(exp.getDate() + SESSION_TTL_DAYS);
  db.prepare(`
    INSERT INTO sessions (token, user_id, user_agent, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(hashToken(token), userId, userAgent || null, now.toISOString(), exp.toISOString());
  return { token, expires_at: exp.toISOString() };
}

function deleteSession(db, token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(hashToken(token));
}

function getSessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.*, u.id AS uid, u.role, u.status
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(hashToken(token));
  if (!row) return null;
  if (row.status === 'disabled') return null;
  if (new Date(row.expires_at) < new Date()) {
    deleteSession(db, token);
    return null;
  }
  return { id: row.uid, role: row.role };
}

// Express middleware. Resolves Bearer token → user → sets x-user-id header
// for downstream handlers. If token missing/invalid, leaves the headers
// untouched (and the handlers' own auth checks will reject).
//
// v0.45 — BUG-009: also accepts a single-use download token via ?dt=<...>
// for file-download links where the browser can't set Authorization
// headers. Download tokens are bound to path+query and self-expire after
// 5 minutes; see lib/download_tokens.js.
function attachUserFromToken(db) {
  // Lazy require to avoid circular import at module load.
  const { redeem } = require('./download_tokens');
  return (req, _res, next) => {
    // v0.65.1 — SECURITY (BUG-B01): never trust a client-supplied identity
    // header. Identity is derived ONLY from a validated session/token below, so
    // strip any inbound x-user-id first — otherwise a request could impersonate
    // any user (incl. admins) simply by sending `x-user-id: <id>` with no token.
    delete req.headers['x-user-id'];
    // 1. Bearer token in Authorization header
    let token = null;
    const auth = req.header('authorization') || '';
    const m = auth.match(/^Bearer\s+([A-Za-z0-9_-]+)$/);
    if (m) token = m[1];
    // 2. Single-use download token bound to this exact path+query.
    if (!token && req.query?.dt) {
      // Build the canonical query without `dt` itself for the binding check.
      const stripped = { ...req.query };
      delete stripped.dt;
      const qs = new URLSearchParams(stripped).toString();
      const userId = redeem(String(req.query.dt), req.path, qs);
      if (userId) {
        req.headers['x-user-id'] = String(userId);
        req._authUser = { id: userId };
        return next();
      }
    }
    // 3. Legacy ?token=<bearer> fallback. Discouraged for new code (token
    //    appears in URLs); use ?dt= instead. Kept for back-compat.
    if (!token && req.query?.token) token = String(req.query.token);
    if (!token) return next();

    const user = getSessionUser(db, token);
    if (user) {
      // Inject x-user-id so existing handlers Just Work
      req.headers['x-user-id'] = String(user.id);
      req._authUser = user;
    }
    next();
  };
}

// Garbage-collect expired sessions on startup. Called once from server.js.
function purgeExpiredSessions(db) {
  const r = db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  if (r.changes) console.log(`[auth] Purged ${r.changes} expired session(s)`);
}

module.exports = {
  hashPassword, verifyPassword,
  createSession, deleteSession, getSessionUser,
  attachUserFromToken, purgeExpiredSessions,
};

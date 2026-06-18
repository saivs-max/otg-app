// v0.35 — Real authentication. Replaces the v0.x user-picker stand-in.
//
// Endpoints:
//   POST /api/login                         { username, password } → { token, user, must_change_password }
//   POST /api/logout                        kills the bearer's session
//   GET  /api/users                         legacy picker (returns only password-less accounts so dev still works)
//   GET  /api/me                            currently signed-in user
//   PATCH /api/me                           profile updates (rate / address / phone)
//   POST /api/me/password                   { current_password?, new_password }
//   POST /api/users                         manager-only: create technician (legacy, kept)
//   GET  /api/admin/users                   admin: list all users with auth metadata
//   POST /api/admin/users                   admin: create user with temp password
//   PATCH /api/admin/users/:id              admin: edit name/role/status/etc
//   POST /api/admin/users/:id/reset-password admin: issue temp password, force change
//   DELETE /api/admin/users/:id             admin: soft-disable
const express = require('express');
const { hashPassword, verifyPassword, createSession, deleteSession } = require('../lib/auth');
const { logAudit } = require('../db');

// v0.65.1 (F-L3) — simple in-memory login throttle (single-process app). Locks a
// username or IP after repeated failures so credentials can't be brute-forced.
const _loginFails = new Map();   // key -> { fails, first, lockedUntil }
const LOGIN_MAX_FAILS = 8, LOGIN_WINDOW_MS = 15 * 60 * 1000, LOGIN_LOCK_MS = 15 * 60 * 1000;
function loginLockSeconds(key) { const r = _loginFails.get(key); return (r && r.lockedUntil && r.lockedUntil > Date.now()) ? Math.ceil((r.lockedUntil - Date.now()) / 1000) : 0; }
function recordLoginFail(key) { const now = Date.now(); let r = _loginFails.get(key); if (!r || now - r.first > LOGIN_WINDOW_MS) r = { fails: 0, first: now }; r.fails++; if (r.fails >= LOGIN_MAX_FAILS) r.lockedUntil = now + LOGIN_LOCK_MS; _loginFails.set(key, r); }
function clearLoginFails(key) { _loginFails.delete(key); }

module.exports = (db) => {
  const router = express.Router();

  function scrubUser(u) {
    if (!u) return u;
    const { password_hash, ...safe } = u;
    return safe;
  }

  // ---------- LOGIN / LOGOUT ----------
  router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const lookup = String(username).trim();
    // v0.45 — BUG-012 fix: empty after trim returns 400 (input validation)
    // rather than 401 (silent invalid creds).
    if (!lookup)   return res.status(400).json({ error: 'username cannot be blank' });
    if (!String(password).length) return res.status(400).json({ error: 'password cannot be blank' });
    // v0.65.1 (F-L3) — throttle brute-force / credential-stuffing per username + IP.
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const lockKeys = [`u:${lookup.toLowerCase()}`, `ip:${ip}`];
    const lockedFor = lockKeys.map(loginLockSeconds).reduce((a, b) => Math.max(a, b), 0);
    if (lockedFor > 0) { res.set('Retry-After', String(lockedFor)); return res.status(429).json({ error: `too many attempts — try again in ${Math.ceil(lockedFor / 60)} min` }); }
    const u = db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE`)
                .get(lookup, lookup);
    if (!u) { lockKeys.forEach(recordLoginFail); return res.status(401).json({ error: 'invalid username or password' }); }
    if (u.status === 'disabled') return res.status(403).json({ error: 'account disabled — contact your administrator' });
    if (!u.password_hash) return res.status(401).json({ error: 'no password set on this account — ask an administrator to issue one' });
    if (!(await verifyPassword(password, u.password_hash))) { lockKeys.forEach(recordLoginFail); return res.status(401).json({ error: 'invalid username or password' }); }
    lockKeys.forEach(clearLoginFails);

    const session = createSession(db, u.id, req.header('user-agent'));
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), u.id);
    logAudit(db, { entity_type: 'users', entity_id: u.id, user_id: u.id, action: 'login' });

    // Build the same shape /me returns so the client can store it directly
    const fullUser = db.prepare(`
      SELECT u.id, u.name, u.email, u.username, u.role, u.worker_type, u.hourly_rate,
             u.home_address, u.home_phone, u.must_change_password, u.status,
             m.id AS ops_manager_id, m.name AS ops_manager_name
      FROM users u LEFT JOIN users m ON m.id = u.ops_manager_id WHERE u.id = ?
    `).get(u.id);
    res.json({
      token: session.token,
      expires_at: session.expires_at,
      must_change_password: !!u.must_change_password,
      user: fullUser,
    });
  });

  router.post('/logout', (req, res) => {
    const auth = req.header('authorization') || '';
    const m = auth.match(/^Bearer\s+([A-Za-z0-9_-]+)$/);
    if (m) deleteSession(db, m[1]);
    res.json({ ok: true });
  });

  // ---------- LEGACY PICKER ----------
  // After v0.35 this is mostly cosmetic — only password-less users appear,
  // which means a fresh DB still lets you "pick" a user for first-time setup.
  router.get('/users', (req, res) => {
    // v0.65.1 (F-M2) — was unauthenticated and leaked every user's name / email /
    // role / username (a ready-made target list). The login screen uses
    // username+password, so this legacy picker is no longer needed by the UI;
    // restrict it to authenticated managers.
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT role FROM users WHERE id = ?").get(userId) : null;
    if (!me || !['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }
    const rows = db.prepare(`
      SELECT id, name, email, role, worker_type, username,
             CASE WHEN password_hash IS NULL OR password_hash = '' THEN 0 ELSE 1 END AS has_password
      FROM users WHERE status = 'active' ORDER BY role, name
    `).all();
    res.json(rows);
  });

  // POST /api/users — manager-only tech-creation shortcut (unchanged from v0.x)
  router.post('/users', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT role FROM users WHERE id = ?").get(userId) : null;
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }
    const { name, email, worker_type, hourly_rate, home_address, home_phone } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });
    if (!['contractor','fte'].includes(worker_type)) {
      return res.status(400).json({ error: 'worker_type must be contractor or fte' });
    }
    const dup = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (dup) return res.status(409).json({ error: 'a user with that email already exists' });
    const rate = Number(hourly_rate);
    if (hourly_rate != null && (!isFinite(rate) || rate < 0 || rate > 500)) {
      return res.status(400).json({ error: 'hourly_rate must be 0–500' });
    }
    const r = db.prepare(`
      INSERT INTO users (name, email, role, worker_type, hourly_rate, home_address, home_phone, ops_manager_id)
      VALUES (?, ?, 'technician', ?, ?, ?, ?, ?)
    `).run(name.trim(), email.trim().toLowerCase(), worker_type,
           Number.isFinite(rate) ? rate : 40.0,
           home_address || null, home_phone || null,
           me.role === 'ops_manager' ? userId : null);
    if (me.role === 'ops_manager') {
      db.prepare(`INSERT OR IGNORE INTO manager_team (manager_user_id, tech_user_id) VALUES (?, ?)`)
        .run(userId, r.lastInsertRowid);
    }
    logAudit(db, { entity_type: 'users', entity_id: r.lastInsertRowid, user_id: userId,
                   action: 'create_tech', details: { name, email, worker_type } });
    const row = db.prepare("SELECT id, name, email, role, worker_type, hourly_rate FROM users WHERE id = ?").get(r.lastInsertRowid);
    res.json(row);
  });

  // ---------- /download-token ----------
  // v0.45 — BUG-009 fix: mint a one-time, path-bound, 5-min token for file
  // downloads. The frontend calls this while authenticated, then appends
  // ?dt=<token> to the actual download URL. Avoids putting the long-lived
  // bearer session token into URLs / logs / referer headers.
  // Body: { path: "/api/dashboard/export", query: "period=all&store=X" }
  router.post('/download-token', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const path = String(req.body?.path || '').trim();
    const query = String(req.body?.query || '').trim();
    if (!path.startsWith('/api/')) {
      return res.status(400).json({ error: 'path must start with /api/' });
    }
    // Whitelist endpoints that legitimately need download tokens — keeps
    // attack surface tight. Each entry is either an exact match or a regex.
    const ALLOWED_EXACT = ['/api/dashboard/export'];
    const ALLOWED_REGEX = [
      /^\/api\/invoices\/\d+\/pdf$/,        // PDF download for a specific invoice
    ];
    const ok = ALLOWED_EXACT.includes(path) || ALLOWED_REGEX.some(re => re.test(path));
    if (!ok) {
      return res.status(400).json({ error: 'path not allowed for download tokens' });
    }
    const { issue, TTL_MS } = require('../lib/download_tokens');
    const t = issue(userId, path, query);
    res.json({ ...t, ttl_ms: TTL_MS });
  });

  // ---------- /me ----------
  router.get('/me', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const u = db.prepare(`
      SELECT u.id, u.name, u.email, u.username, u.role, u.worker_type, u.hourly_rate,
             u.home_address, u.home_phone, u.must_change_password, u.status,
             m.id AS ops_manager_id, m.name AS ops_manager_name
      FROM users u LEFT JOIN users m ON m.id = u.ops_manager_id WHERE u.id = ?
    `).get(userId);
    if (!u) return res.status(404).json({ error: 'user not found' });
    res.json(u);
  });

  router.patch('/me', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!u) return res.status(404).json({ error: 'user not found' });
    const { hourly_rate, home_address, home_phone } = req.body;
    if (hourly_rate != null) {
      const r = Number(hourly_rate);
      if (!isFinite(r) || r < 0 || r > 500) {
        return res.status(400).json({ error: 'hourly_rate must be a number between 0 and 500' });
      }
      db.prepare("UPDATE users SET hourly_rate = ? WHERE id = ?").run(r, userId);
      logAudit(db, { entity_type: 'users', entity_id: userId, user_id: userId, action: 'rate_change',
                     details: { from: u.hourly_rate, to: r } });
    }
    if (home_address !== undefined) {
      db.prepare("UPDATE users SET home_address = ? WHERE id = ?").run(home_address || null, userId);
    }
    if (home_phone !== undefined) {
      db.prepare("UPDATE users SET home_phone = ? WHERE id = ?").run(home_phone || null, userId);
    }
    const updated = db.prepare(`
      SELECT id, name, email, role, worker_type, hourly_rate, home_address, home_phone
      FROM users WHERE id = ?
    `).get(userId);
    res.json(updated);
  });

  // POST /api/me/password — change own password
  router.post('/me/password', async (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!u) return res.status(404).json({ error: 'not found' });
    const { current_password, new_password } = req.body || {};
    if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'new password must be at least 8 characters' });
    // Skip current_password check on temp-password first-login
    if (!u.must_change_password) {
      if (!current_password) return res.status(400).json({ error: 'current_password required' });
      if (!u.password_hash || !(await verifyPassword(current_password, u.password_hash))) {
        return res.status(401).json({ error: 'current password is wrong' });
      }
    }
    const newHash = hashPassword(new_password);
    db.prepare(`UPDATE users SET password_hash = ?, password_set_at = ?, must_change_password = 0 WHERE id = ?`)
      .run(newHash, new Date().toISOString(), userId);
    logAudit(db, { entity_type: 'users', entity_id: userId, user_id: userId, action: 'password_changed' });
    res.json({ ok: true });
  });

  // ---------- ADMIN (PM / Sr Mgr) ----------
  function requireAdmin(req, res) {
    const userId = Number(req.header('x-user-id'));
    if (!userId) { res.status(401).json({ error: 'no user selected' }); return null; }
    const me = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
    if (!me || !['pm','sr_manager'].includes(me.role)) {
      res.status(403).json({ error: 'admin (pm / sr_manager) role required' });
      return null;
    }
    return me;
  }

  router.get('/admin/users', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = db.prepare(`
      SELECT id, name, email, username, role, worker_type, status,
             hourly_rate, last_login_at, password_set_at, must_change_password,
             CASE WHEN password_hash IS NULL OR password_hash = '' THEN 0 ELSE 1 END AS has_password
      FROM users
      ORDER BY status DESC, role, name
    `).all();
    res.json(rows);
  });

  router.post('/admin/users', (req, res) => {
    const me = requireAdmin(req, res); if (!me) return;
    const { name, email, username, role, worker_type, hourly_rate, temp_password } = req.body || {};
    if (!name || !email || !username || !role || !temp_password) {
      return res.status(400).json({ error: 'name, email, username, role, and temp_password are required' });
    }
    if (!['technician','ops_manager','sr_manager','pm'].includes(role)) {
      return res.status(400).json({ error: 'invalid role' });
    }
    if (role === 'technician' && (!worker_type || !['contractor','fte'].includes(worker_type))) {
      return res.status(400).json({ error: 'technician worker_type must be contractor or fte' });
    }
    let hash;
    try { hash = hashPassword(temp_password); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const r = db.prepare(`
        INSERT INTO users (name, email, username, role, worker_type, hourly_rate,
                           password_hash, password_set_at, must_change_password, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active')
      `).run(name.trim(), email.trim().toLowerCase(), username.trim(), role,
             role === 'technician' ? worker_type : null,
             role === 'technician' ? (Number(hourly_rate) || 40) : null,
             hash, new Date().toISOString());
      logAudit(db, { entity_type: 'users', entity_id: r.lastInsertRowid, user_id: me.id,
                     action: 'admin_created_user', details: { role } });
      res.json({ ok: true, id: r.lastInsertRowid });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'username or email already in use' });
      return res.status(500).json({ error: e.message });
    }
  });

  router.patch('/admin/users/:id', (req, res) => {
    const me = requireAdmin(req, res); if (!me) return;
    const id = Number(req.params.id);
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!u) return res.status(404).json({ error: 'not found' });

    // v0.44 — BUG-002 fix: refuse self-disable and refuse demotions / disables
    // that would leave zero active admins (PM or Sr Mgr) in the system.
    const wantsDisable = req.body.status === 'disabled';
    const wantsDemote  = req.body.role !== undefined &&
                         req.body.role !== u.role &&
                         !['sr_manager','pm'].includes(req.body.role);
    if (id === me.id && wantsDisable) {
      return res.status(409).json({ error: 'cannot disable your own account' });
    }
    if (id === me.id && wantsDemote) {
      return res.status(409).json({ error: 'cannot demote your own admin role' });
    }
    // Block actions that would orphan the org (no remaining active PM/Sr Mgr).
    if ((wantsDisable || wantsDemote) && ['sr_manager','pm'].includes(u.role)) {
      const otherAdmins = db.prepare(`
        SELECT COUNT(*) AS n FROM users
        WHERE id != ? AND role IN ('sr_manager','pm') AND status = 'active'
      `).get(id).n;
      if (otherAdmins === 0) {
        return res.status(409).json({ error: 'cannot disable / demote the last active admin' });
      }
    }

    const allowed = ['name','email','username','role','worker_type','hourly_rate','status'];
    const sets = [], vals = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) { sets.push(`${k} = ?`); vals.push(req.body[k] === '' ? null : req.body[k]); }
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(id);
    try {
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'username or email already in use' });
      return res.status(500).json({ error: e.message });
    }
    // v0.44 — Disabling someone also kills their existing sessions so old
    // bearer tokens stop working immediately.
    if (wantsDisable) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    logAudit(db, { entity_type: 'users', entity_id: id, user_id: me.id, action: 'admin_edit_user', details: req.body });
    res.json(scrubUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id)));
  });

  router.post('/admin/users/:id/reset-password', (req, res) => {
    const me = requireAdmin(req, res); if (!me) return;
    const id = Number(req.params.id);
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!u) return res.status(404).json({ error: 'not found' });
    const { temp_password } = req.body || {};
    if (!temp_password) return res.status(400).json({ error: 'temp_password required' });
    let hash;
    try { hash = hashPassword(temp_password); } catch (e) { return res.status(400).json({ error: e.message }); }
    db.prepare(`UPDATE users SET password_hash = ?, password_set_at = ?, must_change_password = 1 WHERE id = ?`)
      .run(hash, new Date().toISOString(), id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    logAudit(db, { entity_type: 'users', entity_id: id, user_id: me.id, action: 'admin_reset_password' });
    res.json({ ok: true });
  });

  router.delete('/admin/users/:id', (req, res) => {
    const me = requireAdmin(req, res); if (!me) return;
    const id = Number(req.params.id);
    if (id === me.id) return res.status(409).json({ error: 'cannot disable your own account' });
    // v0.44 — last-admin protection
    const u = db.prepare("SELECT role FROM users WHERE id = ?").get(id);
    if (u && ['sr_manager','pm'].includes(u.role)) {
      const otherAdmins = db.prepare(`
        SELECT COUNT(*) AS n FROM users
        WHERE id != ? AND role IN ('sr_manager','pm') AND status = 'active'
      `).get(id).n;
      if (otherAdmins === 0) {
        return res.status(409).json({ error: 'cannot disable the last active admin' });
      }
    }
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    logAudit(db, { entity_type: 'users', entity_id: id, user_id: me.id, action: 'admin_disabled_user' });
    res.json({ ok: true });
  });

  return router;
};

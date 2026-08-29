// lib/proxyAuth.js — v0.90
// Validates the x-on-behalf-of proxy header and returns the effective user ID.
//
// Rules enforced:
//   1. Requester must have a manager role (ops_manager / sr_manager / pm).
//   2. Target must not be the requester themselves (no circular self-proxy).
//   3. Target must be a technician (role = 'technician').
//   4. ops_manager additionally must have the target on their manager_team.
//
// Usage:
//   const proxy = resolveProxy(db, userId, req.header('x-on-behalf-of'));
//   if (!proxy.ok) return res.status(proxy.status).json({ error: proxy.error });
//   const effectiveUserId = proxy.effectiveUserId;

'use strict';

const MANAGER_ROLES = new Set(['ops_manager', 'sr_manager', 'pm']);

/**
 * @param {object}  db        - node:sqlite Database instance
 * @param {number}  userId    - authenticated requester's user ID
 * @param {string|undefined} onBehalfRaw - raw value of x-on-behalf-of header
 * @returns {{ ok: true, effectiveUserId: number }
 *          |{ ok: false, status: number, error: string }}
 */
function resolveProxy(db, userId, onBehalfRaw) {
  const onBehalf = Number(onBehalfRaw);

  // Header not set or zero → no proxy, use requester's own ID.
  if (!onBehalf) {
    return { ok: true, effectiveUserId: userId };
  }

  // Rule 2: self-proxy is never allowed.
  if (onBehalf === userId) {
    return { ok: false, status: 403, error: 'cannot proxy as yourself' };
  }

  // Rule 1: requester must be a manager.
  const me = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (!me || !MANAGER_ROLES.has(me.role)) {
    return { ok: false, status: 403, error: 'only managers may use x-on-behalf-of' };
  }

  // Rule 3: target must be a technician.
  const target = db.prepare('SELECT role FROM users WHERE id = ?').get(onBehalf);
  if (!target || target.role !== 'technician') {
    return { ok: false, status: 403, error: 'proxy target must be a technician' };
  }

  // Rule 4: ops_manager must have the target on their team.
  if (me.role === 'ops_manager') {
    const onTeam = db
      .prepare('SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?')
      .get(userId, onBehalf);
    if (!onTeam) {
      return { ok: false, status: 403, error: 'technician is not on your team' };
    }
  }

  return { ok: true, effectiveUserId: onBehalf };
}

module.exports = { resolveProxy };

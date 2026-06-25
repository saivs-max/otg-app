// In-app notifications (v0.71).
//
// The notifications table doubles as a mocked outbound-email log AND the feed
// for in-app banners. These tech-facing endpoints let the home screen list the
// current user's active (un-dismissed) notifications and dismiss them. Dismissal
// is recorded server-side (notifications.dismissed_at) so it persists across
// reloads and devices instead of relying on browser storage.
//
// Endpoints:
//   GET  /api/notifications             → my un-dismissed banner notifications, newest first
//   POST /api/notifications/:id/dismiss → mark one of MY notifications dismissed (owner-scoped)

const express = require('express');
const router  = express.Router();

// Only these kinds surface as in-app home banners. Every other row in the
// notifications table is a pure email-log entry (e.g. 'invoice_to_ap',
// 'invoice_approved_for_ap') that predates this feature — surfacing them would
// dump a backlog onto every tech's home screen. Extend this allowlist as more
// notification kinds become banner-worthy.
const BANNER_KINDS = ['invoice_rejected'];

module.exports = (db) => {
  // Resolve the authenticated user. The auth middleware sets x-user-id from the
  // bearer token; we deliberately use the real user (not x-on-behalf-of) so a
  // tech only ever sees their own banners.
  function currentUser(req) {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return null;
    return db.prepare("SELECT id, email FROM users WHERE id = ?").get(userId);
  }

  // GET /api/notifications — active (un-dismissed) banner notifications for me.
  router.get('/notifications', (req, res) => {
    const me = currentUser(req);
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (!me.email) return res.json([]); // notifications are addressed by email
    const placeholders = BANNER_KINDS.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT n.id, n.kind, n.invoice_id, n.subject, n.body, n.created_at,
             i.invoice_number, i.status AS invoice_status
      FROM notifications n
      LEFT JOIN invoices i ON i.id = n.invoice_id
      WHERE n.recipient = ?
        AND n.dismissed_at IS NULL
        AND n.kind IN (${placeholders})
      ORDER BY n.created_at DESC, n.id DESC
    `).all(me.email, ...BANNER_KINDS);
    res.json(rows);
  });

  // POST /api/notifications/:id/dismiss — owner-scoped soft dismissal.
  router.post('/notifications/:id/dismiss', (req, res) => {
    const me = currentUser(req);
    if (!me) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid notification id' });
    }
    const now = new Date().toISOString();
    // Only the recipient can dismiss their own notification, and only while it
    // is still active — the WHERE clause enforces both.
    const r = db.prepare(`
      UPDATE notifications
      SET dismissed_at = ?
      WHERE id = ? AND recipient = ? AND dismissed_at IS NULL
    `).run(now, id, me.email);
    if (r.changes === 0) {
      // Distinguish "not yours / not found" from "already dismissed" so a
      // double-tap from the client is treated as success (idempotent).
      const row = db.prepare("SELECT recipient, dismissed_at FROM notifications WHERE id = ?").get(id);
      if (!row || row.recipient !== me.email) {
        return res.status(404).json({ error: 'notification not found' });
      }
    }
    res.json({ ok: true, id });
  });

  return router;
};

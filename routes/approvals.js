// Ops Manager approval workflow.
//
// Endpoints:
//   GET    /api/team                          → techs on my team (Ops Mgr only)
//   GET    /api/team/available                → techs not yet on my team (for adding)
//   POST   /api/team/:techId                  → claim a tech onto my team
//   DELETE /api/team/:techId                  → remove a tech from my team
//
//   GET    /api/approvals/queue               → invoices in {submitted, approved_ops}
//                                                that I'm allowed to act on
//   POST   /api/invoices/:id/approve          → Ops approve (status=approved_ops; routes to Sr Mgr).
//                                                If caller is sr_mgr, status=approved_sr → queued_ap.
//   POST   /api/invoices/:id/reject {reason}  → return invoice to draft, notify tech via audit log

const express = require('express');
const router  = express.Router();
const { logAudit } = require('../db');

function getMe(db, userId) {
  return db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
}

function teamTechIds(db, managerUserId) {
  return db.prepare("SELECT tech_user_id FROM manager_team WHERE manager_user_id = ?")
    .all(managerUserId).map(r => r.tech_user_id);
}

module.exports = (db) => {

  // ===== Team management =====
  router.get('/team', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = getMe(db, userId);
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (me.role !== 'ops_manager' && me.role !== 'sr_manager' && me.role !== 'pm') {
      return res.status(403).json({ error: 'manager role required' });
    }
    const rows = db.prepare(`
      SELECT u.id, u.name, u.email, u.worker_type, u.hourly_rate
      FROM manager_team mt JOIN users u ON u.id = mt.tech_user_id
      WHERE mt.manager_user_id = ? AND u.role = 'technician'
      ORDER BY u.name
    `).all(userId);
    res.json(rows);
  });

  router.get('/team/available', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = getMe(db, userId);
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (me.role !== 'ops_manager' && me.role !== 'sr_manager' && me.role !== 'pm') {
      return res.status(403).json({ error: 'manager role required' });
    }
    const rows = db.prepare(`
      SELECT u.id, u.name, u.email, u.worker_type
      FROM users u
      WHERE u.role = 'technician'
        AND u.id NOT IN (SELECT tech_user_id FROM manager_team WHERE manager_user_id = ?)
      ORDER BY u.name
    `).all(userId);
    res.json(rows);
  });

  router.post('/team/:techId', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = getMe(db, userId);
    if (!me || (me.role !== 'ops_manager' && me.role !== 'pm')) return res.status(403).json({ error: 'ops manager only' });
    const techId = Number(req.params.techId);
    const tech = db.prepare("SELECT id, role FROM users WHERE id = ?").get(techId);
    if (!tech || tech.role !== 'technician') return res.status(400).json({ error: 'not a technician' });
    db.prepare(`INSERT OR IGNORE INTO manager_team (manager_user_id, tech_user_id) VALUES (?, ?)`).run(userId, techId);
    logAudit(db, { entity_type: 'manager_team', entity_id: techId, user_id: userId, action: 'add_tech' });
    res.json({ ok: true });
  });

  router.delete('/team/:techId', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = getMe(db, userId);
    if (!me || (me.role !== 'ops_manager' && me.role !== 'pm')) return res.status(403).json({ error: 'ops manager only' });
    const techId = Number(req.params.techId);
    db.prepare("DELETE FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").run(userId, techId);
    logAudit(db, { entity_type: 'manager_team', entity_id: techId, user_id: userId, action: 'remove_tech' });
    res.json({ ok: true });
  });

  // ===== Team invoices (all states) =====
  // Powers the manager's Invoices tab. Ops Mgr sees their team; Sr Mgr / PM
  // sees everyone. Optional `?status=draft,submitted,...` to filter.
  router.get('/team-invoices', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = getMe(db, userId);
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }
    // v0.32 — Ops Mgr and Sr Mgr / PM see the same set of all invoices on
    // this endpoint. Team membership only constrains the approval queue.
    const statuses = (req.query.status || '').split(',').filter(Boolean);
    const params = [];
    let where = '1=1';
    if (statuses.length) {
      where += ` AND i.status IN (${statuses.map(() => '?').join(',')})`;
      params.push(...statuses);
    }
    const rows = db.prepare(`
      SELECT i.*, u.name AS tech_name, u.worker_type AS tech_worker_type
      FROM invoices i JOIN users u ON u.id = i.user_id
      WHERE ${where}
      ORDER BY
        CASE i.status
          WHEN 'submitted'    THEN 0
          WHEN 'approved_ops' THEN 1
          WHEN 'draft'        THEN 2
          WHEN 'approved_sr'  THEN 3
          WHEN 'queued_ap'    THEN 4
          WHEN 'sent_ap'      THEN 5
          WHEN 'rejected'     THEN 6
          ELSE 7 END,
        i.period_start DESC
    `).all(...params);
    res.json(rows);
  });

  // ===== Approval queue =====
  // Ops Mgr sees: invoices in 'submitted' state from techs on their team.
  // Sr Mgr / PM sees: invoices in 'approved_ops' state (every invoice flows through).
  router.get('/approvals/queue', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = getMe(db, userId);
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (me.role !== 'ops_manager' && me.role !== 'sr_manager' && me.role !== 'pm') {
      return res.status(403).json({ error: 'manager role required' });
    }

    let rows = [];
    if (me.role === 'ops_manager') {
      // Ops Mgr: tech-labor invoices submitted by their team. Vendor invoices
      // skip Ops review entirely.
      const techIds = teamTechIds(db, userId);
      if (!techIds.length) return res.json([]);
      const placeholders = techIds.map(() => '?').join(',');
      rows = db.prepare(`
        SELECT i.*, u.name AS tech_name, u.worker_type AS tech_worker_type
        FROM invoices i JOIN users u ON u.id = i.user_id
        WHERE i.user_id IN (${placeholders})
          AND i.status = 'submitted'
          AND (i.invoice_type IS NULL OR i.invoice_type = 'tech_labor')
        ORDER BY i.submitted_at ASC
      `).all(...techIds);
    } else {
      // Sr Mgr / PM: every approved_ops tech invoice + every submitted vendor invoice
      rows = db.prepare(`
        SELECT i.*, u.name AS tech_name, u.worker_type AS tech_worker_type
        FROM invoices i JOIN users u ON u.id = i.user_id
        WHERE (i.status = 'approved_ops')
           OR (i.status = 'submitted' AND i.invoice_type = 'vendor')
        ORDER BY i.escalated_at IS NULL, i.submitted_at ASC
      `).all();
    }
    res.json(rows);
  });

  // ===== Approve =====
  router.post('/invoices/:id/approve', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = getMe(db, userId);
    if (!me) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
    if (!inv) return res.status(404).json({ error: 'invoice not found' });

    const now = new Date().toISOString();

    // v0.36 — Vendor invoices skip Ops Mgr review (the Ops Mgr created them)
    // and go directly from `submitted` → `approved_sr` when Sr Mgr approves.
    // v0.44 — BUG-006 fix: race-safe state transitions. The UPDATE WHERE
    // clause re-asserts the source status; if a concurrent caller already
    // moved it, changes() === 0 and we return 409.
    if (inv.invoice_type === 'vendor') {
      if (me.role !== 'sr_manager' && me.role !== 'pm') {
        return res.status(403).json({ error: 'vendor invoices require Sr Mgr / PM approval' });
      }
      if (inv.status !== 'submitted') {
        return res.status(409).json({ error: `vendor invoice is ${inv.status}, not submitted` });
      }
      const r = db.prepare(`
        UPDATE invoices SET status = 'approved_sr', approved_sr_at = ?, approved_sr_by = ?
        WHERE id = ? AND status = 'submitted' AND invoice_type = 'vendor'
      `).run(now, userId, id);
      if (r.changes === 0) return res.status(409).json({ error: 'invoice state changed — refresh and retry' });
      logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId, action: 'approve_vendor_sr' });
      return res.json(db.prepare("SELECT * FROM invoices WHERE id = ?").get(id));
    }

    if (me.role === 'ops_manager') {
      if (inv.status !== 'submitted') return res.status(409).json({ error: `invoice is ${inv.status}, not submitted` });
      // Confirm this tech is on my team
      const inTeam = db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?")
        .get(userId, inv.user_id);
      if (!inTeam) return res.status(403).json({ error: 'this technician is not on your team' });

      const r = db.prepare(`
        UPDATE invoices SET status = 'approved_ops', approved_ops_at = ?, approved_ops_by = ?
        WHERE id = ? AND status = 'submitted'
      `).run(now, userId, id);
      if (r.changes === 0) return res.status(409).json({ error: 'invoice state changed — refresh and retry' });
      logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId, action: 'approve_ops' });
      return res.json(db.prepare("SELECT * FROM invoices WHERE id = ?").get(id));
    }

    if (me.role === 'sr_manager' || me.role === 'pm') {
      if (inv.status !== 'approved_ops') return res.status(409).json({ error: `invoice is ${inv.status}, not approved_ops` });
      const r = db.prepare(`
        UPDATE invoices SET status = 'approved_sr', approved_sr_at = ?, approved_sr_by = ?
        WHERE id = ? AND status = 'approved_ops'
      `).run(now, userId, id);
      if (r.changes === 0) return res.status(409).json({ error: 'invoice state changed — refresh and retry' });
      logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId, action: 'approve_sr' });
      return res.json(db.prepare("SELECT * FROM invoices WHERE id = ?").get(id));
    }

    return res.status(403).json({ error: 'manager role required' });
  });

  // ===== Reject =====
  router.post('/invoices/:id/reject', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = getMe(db, userId);
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (me.role !== 'ops_manager' && me.role !== 'sr_manager' && me.role !== 'pm') {
      return res.status(403).json({ error: 'manager role required' });
    }

    const id = Number(req.params.id);
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
    if (!inv) return res.status(404).json({ error: 'invoice not found' });
    if (!['submitted','approved_ops'].includes(inv.status)) {
      return res.status(409).json({ error: `invoice is ${inv.status}, cannot reject` });
    }

    const reason = (req.body.reason || '').trim();
    if (reason.length < 5) return res.status(400).json({ error: 'rejection reason required (min 5 chars)' });
    if (reason.length > 2000) return res.status(400).json({ error: 'rejection reason max 2000 chars' });

    if (me.role === 'ops_manager') {
      const inTeam = db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?")
        .get(userId, inv.user_id);
      if (!inTeam) return res.status(403).json({ error: 'this technician is not on your team' });
    }

    const now = new Date().toISOString();
    // Returns to draft so the tech can edit and re-submit. Reason + reviewer are recorded.
    // v0.44 — BUG-006 fix: re-assert the prior status in WHERE clause.
    const r = db.prepare(`
      UPDATE invoices
      SET status = 'draft', rejected_at = ?, rejected_by = ?, rejection_reason = ?
      WHERE id = ? AND status IN ('submitted','approved_ops')
    `).run(now, userId, reason, id);
    if (r.changes === 0) return res.status(409).json({ error: 'invoice state changed — refresh and retry' });
    logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId,
                   action: 'reject', details: { reason, prior_status: inv.status } });
    res.json(db.prepare("SELECT * FROM invoices WHERE id = ?").get(id));
  });

  // ============================================================
  // POST /api/invoices/:id/escalate  { note? }
  // ------------------------------------------------------------
  // Ops Mgr defers a flagged invoice to Sr Mgr for secondary approval.
  // Stamps escalated_at + escalated_by; advances status to approved_ops so
  // Sr Mgr's queue picks it up. After this, /send-to-ap requires Sr Mgr
  // countersign before it'll accept (the Sr Mgr step stops being optional
  // for THIS invoice).
  router.post('/invoices/:id/escalate', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = getMe(db, userId);
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (!['ops_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'ops manager role required to escalate' });
    }
    const id = Number(req.params.id);
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
    if (!inv) return res.status(404).json({ error: 'invoice not found' });
    if (inv.status !== 'submitted' && inv.status !== 'approved_ops') {
      return res.status(409).json({ error: `invoice must be submitted or approved_ops to escalate (current: ${inv.status})` });
    }
    if (me.role === 'ops_manager') {
      const inTeam = db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?")
        .get(userId, inv.user_id);
      if (!inTeam) return res.status(403).json({ error: 'this technician is not on your team' });
    }

    const now = new Date().toISOString();
    const note = (req.body?.note || '').trim() || null;
    // Move to approved_ops if still in submitted (so Sr Mgr's queue picks it
    // up), and stamp escalation. If already in approved_ops we just stamp.
    if (inv.status === 'submitted') {
      db.prepare(`
        UPDATE invoices SET
          status = 'approved_ops', approved_ops_at = ?, approved_ops_by = ?,
          escalated_at = ?, escalated_by = ?, escalation_note = ?
        WHERE id = ?
      `).run(now, userId, now, userId, note, id);
    } else {
      db.prepare(`
        UPDATE invoices SET escalated_at = ?, escalated_by = ?, escalation_note = ?
        WHERE id = ?
      `).run(now, userId, note, id);
    }
    logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId,
                   action: 'escalate_to_sr', details: { note } });

    res.json(db.prepare("SELECT * FROM invoices WHERE id = ?").get(id));
  });

  return router;
};

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
const { logAudit, sumHours } = require('../db');
const rulesEvaluator = require('./rules');

// v0.58 — Run the policy engine against every WO line on an invoice and
// return the resulting flag count. Used to decorate queue rows so Ops Mgrs
// can see at-a-glance which invoices need attention before they drill in.
// v0.67.2 — now also runs the per-WO/category budget evaluator (evaluateBudgets),
// so the queue surfaces overages (wo_category_budget / category_per_wo_cap /
// category_receipt_required) instead of dropping them. Previously this only ran
// evaluate(), so budget overages showed on the invoice side but never here.
function computeFlagsForInvoice(db, invoiceId) {
  const allTimes = db.prepare(`
    SELECT t.*, w.external_id, w.work_type, w.store_name, w.cart_count
    FROM time_entries t JOIN work_orders w ON w.id = t.work_order_id
    WHERE t.invoice_id = ?
  `).all(invoiceId);
  const expenses = db.prepare(`
    SELECT e.*, w.external_id, w.work_type, w.store_name, w.cart_count
    FROM expenses e JOIN work_orders w ON w.id = e.work_order_id
    WHERE e.invoice_id = ?
  `).all(invoiceId);

  // Group by WO so the evaluator gets a `line` object matching computeInvoice.
  const byWO = {};
  for (const t of allTimes) {
    const k = t.external_id;
    // v0.67.2 — capture work_order_id so evaluateBudgets() (per-WO budgets) can run.
    byWO[k] ||= { external_id: k, work_order_id: t.work_order_id, work_type: t.work_type, store_name: t.store_name, cart_count: t.cart_count, labor_hours: 0 };
    if ((t.mode || 'work') === 'work') byWO[k].labor_hours += sumHours([t]);
  }
  for (const e of expenses) {
    const k = e.external_id;
    byWO[k] ||= { external_id: k, work_order_id: e.work_order_id, work_type: e.work_type, store_name: e.store_name, cart_count: e.cart_count, labor_hours: 0 };
  }

  const flags = [];
  for (const line of Object.values(byWO)) {
    const lineExpenses = expenses.filter(e => e.external_id === line.external_id);
    const lineFlags = rulesEvaluator.evaluate(db, line,
      lineExpenses,
      allTimes.filter(t => t.external_id === line.external_id).map(t => ({
        external_id: t.external_id, clock_in: t.clock_in, clock_out: t.clock_out,
        mode: t.mode || 'work', hours: sumHours([t]),
      }))
    );
    for (const f of lineFlags) flags.push({ wo: line.external_id, store: line.store_name, ...f });
    // v0.67.2 — per-WO / category budget overages, mirroring computeInvoice on
    // the invoice side. evaluateBudgets() reads wo_category_budgets + category_rules
    // (and live corp-card spend) and no-ops without line.work_order_id.
    const budgetFlags = rulesEvaluator.evaluateBudgets(db, line, lineExpenses);
    for (const f of budgetFlags) flags.push({ wo: line.external_id, store: line.store_name, ...f });
  }
  return flags;
}

function getMe(db, userId) {
  return db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
}

function teamTechIds(db, managerUserId) {
  return db.prepare("SELECT tech_user_id FROM manager_team WHERE manager_user_id = ?")
    .all(managerUserId).map(r => r.tech_user_id);
}

// v0.67 — Ops approval is now the FINAL approval gate in the tech-labor flow.
// Once a tech-labor invoice clears approval (Ops approval in the normal path, or
// a Sr Mgr countersign on an escalated invoice), the technician owns the last
// step: verify the invoice and send it to Accounts Payable. We record that as a
// notification row so it surfaces on the tech's Invoices screen and in the
// (mocked) outbound-email log. We track the lifecycle only up to the AP
// hand-off, not the downstream payment status. Best-effort: a notify failure
// must never block the approval transaction.
function notifyTechVerifyAndSend(db, { invoice, approverUserId }) {
  try {
    const tech = db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(invoice.user_id);
    if (!tech) return;
    const approver = db.prepare("SELECT name FROM users WHERE id = ?").get(approverUserId);
    const subject = `Invoice ${invoice.invoice_number} approved — verify & send to AP`;
    const body = `Your invoice ${invoice.invoice_number} was approved by ${approver?.name || 'your manager'}. `
      + `Please review the details and send it to Accounts Payable from the invoice screen.`;
    db.prepare(`
      INSERT INTO notifications (kind, invoice_id, triggered_by, recipient, subject, body, status)
      VALUES ('invoice_approved_for_ap', ?, ?, ?, ?, ?, 'logged')
    `).run(invoice.id, approverUserId, tech.email || null, subject, body);
    console.log(`🔔 [mock notify] To tech ${tech.email || tech.id} · ${subject}`);
  } catch (e) {
    console.error('notifyTechVerifyAndSend failed:', e.message);
  }
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
    // v0.65.1 (F-M3) — Ops Mgrs see only their own team's invoices (plus any
    // vendor invoice they created); Sr Mgr / PM continue to see everything.
    if (me.role === 'ops_manager') {
      const techIds = teamTechIds(db, userId);
      const ph = techIds.map(() => '?').join(',') || 'NULL';
      where += ` AND (i.user_id IN (${ph}) OR i.created_by = ?)`;
      params.push(...techIds, userId);
    }
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
  // Sr Mgr / PM sees: EVERY approved_ops tech invoice (so they retain full
  // visibility of what's flowing through) + every submitted vendor invoice.
  // v0.67 — Ops approval is now final, so the Sr Mgr no longer needs to approve
  // normal invoices: those rows are surfaced as review-only (action_needed=0).
  // Only ESCALATED tech invoices and submitted vendor invoices need Sr Mgr
  // action (action_needed=1); escalated items sort to the top.
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
      // Sr Mgr / PM: every approved_ops tech invoice (full visibility) + every
      // submitted vendor invoice. Escalated items sort first since they're the
      // only tech invoices that still need a Sr Mgr countersign.
      rows = db.prepare(`
        SELECT i.*, u.name AS tech_name, u.worker_type AS tech_worker_type
        FROM invoices i JOIN users u ON u.id = i.user_id
        WHERE (i.status = 'approved_ops')
           OR (i.status = 'submitted' AND i.invoice_type = 'vendor')
        ORDER BY i.escalated_at IS NULL, i.submitted_at ASC
      `).all();
    }

    // v0.58 — decorate each row with flag info (count + rule-type breakdown
    // + the first message) so the queue UI can show "⚠ 4 flags" badges and
    // a short summary without having to drill into each invoice.
    // v0.67 — also flag whether the row still needs THIS manager's action:
    //   • Ops Mgr queue rows are all 'submitted' → always action_needed.
    //   • Sr Mgr / PM: vendor-submitted + escalated tech invoices need action;
    //     non-escalated approved_ops invoices are review-only (Ops already final).
    for (const row of rows) {
      row.action_needed = me.role === 'ops_manager'
        ? 1
        : ((row.invoice_type === 'vendor' && row.status === 'submitted') || row.escalated_at ? 1 : 0);
      if (row.invoice_type === 'vendor') {
        row.flag_count = 0; row.flag_rules = []; row.flag_preview = null;
        continue;
      }
      const flags = computeFlagsForInvoice(db, row.id);
      row.flag_count   = flags.length;
      row.flag_rules   = [...new Set(flags.map(f => f.rule))];
      row.flag_preview = flags[0] ? flags[0].message : null;
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

    // v0.65 — Segregation of duties: you cannot approve an invoice you own
    // (tech labor) or created (vendor). A different approver is required.
    const ownerOrCreator = inv.invoice_type === 'vendor' ? inv.created_by : inv.user_id;
    if (ownerOrCreator && ownerOrCreator === userId) {
      return res.status(409).json({ error: 'you cannot approve your own invoice — a different approver is required' });
    }

    const now = new Date().toISOString();

    // v0.36 — Vendor invoices skip Ops Mgr review (the Ops Mgr created them)
    // and go directly from `submitted` → `approved_sr` when Sr Mgr approves.
    // v0.44 — BUG-006 fix: race-safe state transitions. The UPDATE WHERE
    // clause re-asserts the source status; if a concurrent caller already
    // moved it, changes() === 0 and we return 409.
    if (inv.invoice_type === 'vendor') {
      // v0.65.2 — Sr Mgr approval is optional at all levels, so any manager
      // (Ops / Sr / PM) may approve a vendor invoice; a single approval clears
      // it for AP. Sr/PM stamps approved_sr; Ops stamps approved_ops. The
      // self-approval guard above still blocks the Ops Mgr who created it.
      if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
        return res.status(403).json({ error: 'manager role required to approve vendor invoices' });
      }
      if (inv.status !== 'submitted') {
        return res.status(409).json({ error: `vendor invoice is ${inv.status}, not submitted` });
      }
      const isSr = me.role === 'sr_manager' || me.role === 'pm';
      const r = isSr
        ? db.prepare(`UPDATE invoices SET status = 'approved_sr', approved_sr_at = ?, approved_sr_by = ? WHERE id = ? AND status = 'submitted' AND invoice_type = 'vendor'`).run(now, userId, id)
        : db.prepare(`UPDATE invoices SET status = 'approved_ops', approved_ops_at = ?, approved_ops_by = ? WHERE id = ? AND status = 'submitted' AND invoice_type = 'vendor'`).run(now, userId, id);
      if (r.changes === 0) return res.status(409).json({ error: 'invoice state changed — refresh and retry' });
      logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId, action: isSr ? 'approve_vendor_sr' : 'approve_vendor_ops' });
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
      // v0.67 — Ops approval is final: hand off to the tech to verify & send to AP.
      notifyTechVerifyAndSend(db, { invoice: inv, approverUserId: userId });
      return res.json(db.prepare("SELECT * FROM invoices WHERE id = ?").get(id));
    }

    if (me.role === 'sr_manager' || me.role === 'pm') {
      if (inv.status !== 'approved_ops') return res.status(409).json({ error: `invoice is ${inv.status}, not approved_ops` });
      // v0.65 — the Sr Mgr gate must be cleared by someone other than the Ops approver.
      if (inv.approved_ops_by && inv.approved_ops_by === userId) {
        return res.status(409).json({ error: 'the Sr Mgr approval must be made by someone other than the Ops Mgr who approved it' });
      }
      const r = db.prepare(`
        UPDATE invoices SET status = 'approved_sr', approved_sr_at = ?, approved_sr_by = ?
        WHERE id = ? AND status = 'approved_ops'
      `).run(now, userId, id);
      if (r.changes === 0) return res.status(409).json({ error: 'invoice state changed — refresh and retry' });
      logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId, action: 'approve_sr' });
      // v0.67 — Final approval cleared on an escalated invoice: same hand-off —
      // notify the tech to verify & send to AP.
      notifyTechVerifyAndSend(db, { invoice: inv, approverUserId: userId });
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
  // Ops Mgr defers a flagged invoice to Sr Mgr for secondary review.
  // Stamps escalated_at + escalated_by; advances status to approved_ops so
  // Sr Mgr's queue picks it up. v0.65.2 — Sr Mgr review is OPTIONAL: escalation
  // only surfaces the invoice for an optional second look; it no longer blocks
  // /send-to-ap, which accepts approved_ops without a Sr Mgr countersign.
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

    // v0.67.1 — Segregation of duties: you cannot escalate your own invoice
    // (tech-labor owner / vendor creator). Escalation advances submitted →
    // approved_ops, so without this guard an approver could move an invoice
    // they're party to onward themselves. Mirrors the /approve self-guard.
    const ownerOrCreator = inv.invoice_type === 'vendor' ? inv.created_by : inv.user_id;
    if (ownerOrCreator && ownerOrCreator === userId) {
      return res.status(409).json({ error: 'you cannot escalate your own invoice — a different manager is required' });
    }

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
    // v0.65 — Escalation is NOT an Ops approval, so we no longer stamp
    // approved_ops_at/by (which fabricated a review that never happened). A
    // 'submitted' invoice still advances to 'approved_ops' so the Sr Mgr queue
    // surfaces it, but only the escalation is recorded. Both paths are race-safe.
    let r;
    if (inv.status === 'submitted') {
      r = db.prepare(`
        UPDATE invoices SET
          status = 'approved_ops',
          escalated_at = ?, escalated_by = ?, escalation_note = ?
        WHERE id = ? AND status = 'submitted'
      `).run(now, userId, note, id);
    } else {
      r = db.prepare(`
        UPDATE invoices SET escalated_at = ?, escalated_by = ?, escalation_note = ?
        WHERE id = ? AND status = 'approved_ops'
      `).run(now, userId, note, id);
    }
    if (r.changes === 0) {
      return res.status(409).json({ error: 'invoice state changed — refresh and retry' });
    }
    logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId,
                   action: 'escalate_to_sr', details: { note } });

    res.json(db.prepare("SELECT * FROM invoices WHERE id = ?").get(id));
  });

  return router;
};

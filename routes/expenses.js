// Expense entry endpoints. Policy enforced at write time.
const express = require('express');
const router  = express.Router();
const { POLICY, getPolicy, logAudit, weekBounds } = require('../db');
const weekBoundsFor = (d) => weekBounds(new Date(d));

// v0.54 — 'labor' and 'drive' added so techs can log labor/drive as expenses
// (hours × rate). Both are billable; drive is tracked separately for reporting
// (v0.55 — drive promoted to billable; the earlier non-billable treatment was wrong).
const VALID_CATS = new Set(['mileage','tolls','parking','vendor','labor','drive','other']);
const VALID_SUBS = new Set(['Meal','Tools','Hotel','Supplies','Misc']); // category='other' requires one of these
// v0.65 — hard per-expense ceiling. Previously there was no upper bound, so a
// fat-finger / absurd amount (e.g. $99,999,999) was stored verbatim.
const MAX_EXPENSE_AMOUNT = 100000;

module.exports = (db) => {

  // GET /api/expenses  → my expenses (this week, joined with WO context)
  router.get('/expenses', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const rows = db.prepare(`
      SELECT e.*, w.external_id, w.source_system, w.work_type, w.store_name
      FROM expenses e JOIN work_orders w ON w.id = e.work_order_id
      WHERE e.user_id = ?
      ORDER BY e.expense_date DESC, e.id DESC
    `).all(userId);
    res.json(rows);
  });

  // GET /api/expenses/:id  → single expense (owner or scoped manager)
  router.get('/expenses/:id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const e = db.prepare(`
      SELECT e.*, w.external_id, w.source_system, w.work_type, w.store_name
      FROM expenses e JOIN work_orders w ON w.id = e.work_order_id
      WHERE e.id = ?
    `).get(id);
    if (!e) return res.status(404).json({ error: 'not found' });
    if (e.user_id !== userId) {
      const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
      const allowed = me && (
        me.role === 'sr_manager' || me.role === 'pm' ||
        (me.role === 'ops_manager' && db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, e.user_id))
      );
      if (!allowed) return res.status(403).json({ error: 'not yours' });
    }
    res.json(e);
  });

  // POST /api/expenses
  // Body:
  //   { work_order_id, category, expense_date, amount?, quantity?, description?, receipt_path? }
  // For category=mileage, amount is computed from quantity * MILEAGE_RATE; client may omit it.
  router.post('/expenses', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });

    const { work_order_id, category, subcategory, expense_date, quantity, description, receipt_path } = req.body;
    let { amount, rate } = req.body;

    // Allow managers to create expenses on behalf of a team tech (for mgr-uploaded invoices).
    // Header: x-on-behalf-of: <tech_user_id>
    const onBehalf = Number(req.header('x-on-behalf-of'));
    if (onBehalf && onBehalf !== userId) {
      const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
      const allowed = me && (
        me.role === 'sr_manager' || me.role === 'pm' ||
        (me.role === 'ops_manager' && db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, onBehalf))
      );
      if (!allowed) return res.status(403).json({ error: 'cannot create on behalf of this tech' });
    }
    const effectiveUserId = onBehalf || userId;

    if (!work_order_id || !category || !expense_date) {
      return res.status(400).json({ error: 'work_order_id, category, expense_date are required' });
    }
    if (!VALID_CATS.has(category)) {
      return res.status(400).json({ error: `category must be one of ${[...VALID_CATS].join(', ')}` });
    }
    if (category === 'other') {
      if (!subcategory || !VALID_SUBS.has(subcategory)) {
        return res.status(400).json({ error: `Other expenses require a sub-option: ${[...VALID_SUBS].join(', ')}` });
      }
    }
    const wo = db.prepare("SELECT id FROM work_orders WHERE id = ?").get(Number(work_order_id));
    if (!wo) return res.status(404).json({ error: 'work order not found' });

    // Apply policy
    if (category === 'mileage') {
      const q = Number(quantity);
      if (!q || q < 0) return res.status(400).json({ error: 'mileage requires quantity (miles)' });
      const POL = getPolicy(db);
      rate = POL.MILEAGE_RATE;
      amount = +(q * rate).toFixed(2);
    } else if (category === 'labor' || category === 'drive') {
      // v0.54 → v0.55 — Labor/Drive-as-expense: quantity = hours,
      // rate = tech's hourly rate (or override), amount = hours × rate.
      // Both are billable; drive stays distinct so the summary can show
      // how much of the billable time was drive vs on-site labor.
      const q = Number(quantity);
      if (!q || q <= 0) return res.status(400).json({ error: `${category} requires quantity (hours)` });
      const reqRate = Number(rate);
      if (isFinite(reqRate) && reqRate > 0) {
        rate = reqRate;
      } else {
        const me = db.prepare("SELECT hourly_rate FROM users WHERE id = ?").get(effectiveUserId);
        const POL = getPolicy(db);
        rate = me?.hourly_rate || POL.HOURLY_RATE_DEFAULT;
      }
      amount = +(q * rate).toFixed(2);
    } else {
      amount = Number(amount);
      if (!isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be greater than 0' });
    }
    // v0.65 — unified hard ceiling across every category (also catches a huge
    // mileage/labor/drive amount computed from quantity × rate).
    if (!isFinite(amount) || amount > MAX_EXPENSE_AMOUNT) {
      return res.status(400).json({ error: `amount exceeds the per-expense maximum of $${MAX_EXPENSE_AMOUNT.toLocaleString()}` });
    }
    // Meal cap (now lives under category='other', subcategory='Meal')
    {
      const POL = getPolicy(db);
      if (category === 'other' && subcategory === 'Meal' && amount > POL.MEAL_DAILY_CAP) {
        return res.status(400).json({ error: `Meals are capped at $${POL.MEAL_DAILY_CAP}/day` });
      }
    }

    const r = db.prepare(`
      INSERT INTO expenses
        (user_id, work_order_id, category, subcategory, expense_date, amount, quantity, rate, description, receipt_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(effectiveUserId, Number(work_order_id), category, category === 'other' ? subcategory : null,
           expense_date, amount,
           quantity ? Number(quantity) : null, rate ?? null,
           description || null, receipt_path || null);
    const newId = r.lastInsertRowid;

    // Auto-attach to a draft invoice whose period contains the expense_date.
    // We check by date-in-range (not week-boundary equality) so that uploads
    // with non-Mon-Sun periods (e.g. fortnightly contractor invoices) still
    // work. Most-recent draft wins if multiple match.
    const draft = db.prepare(`
      SELECT id FROM invoices
      WHERE user_id = ? AND status = 'draft'
        AND ? BETWEEN period_start AND period_end
      ORDER BY id DESC LIMIT 1
    `).get(effectiveUserId, expense_date);
    if (draft) {
      db.prepare(`UPDATE expenses SET invoice_id = ? WHERE id = ?`).run(draft.id, newId);
    }

    logAudit(db, { entity_type: 'expenses', entity_id: newId, user_id: userId, action: 'create',
                   details: { category, amount, attached_invoice: draft?.id || null } });

    const row = db.prepare("SELECT * FROM expenses WHERE id = ?").get(newId);
    res.json(row);
  });

  // PATCH /api/expenses/:id  → edit fields on a draft-invoice expense
  router.patch('/expenses/:id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const e = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
    if (!e) return res.status(404).json({ error: 'not found' });
    if (e.user_id !== userId) {
      const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
      const allowed = me && (
        me.role === 'sr_manager' || me.role === 'pm' ||
        (me.role === 'ops_manager' && db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, e.user_id))
      );
      if (!allowed) return res.status(403).json({ error: 'not yours' });
    }
    if (e.invoice_id) {
      const inv = db.prepare("SELECT status FROM invoices WHERE id = ?").get(e.invoice_id);
      if (inv) {
        // v0.64 — Ops managers (sr/pm, or ops_mgr on the tech's team) can correct
        // line items right up until the invoice is approved: draft / submitted /
        // in_review. The owning tech can still only edit while it's a draft.
        // Once approved, queued, sent to AP, or rejected, line items are locked.
        const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
        const isManagerActor = me && (
          me.role === 'sr_manager' || me.role === 'pm' ||
          (me.role === 'ops_manager' && db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, e.user_id))
        );
        const editable = isManagerActor ? ['draft','submitted','in_review'] : ['draft'];
        if (!editable.includes(inv.status)) {
          return res.status(409).json({ error: `Cannot edit — invoice is ${inv.status}.` });
        }
      }
    }

    let { category, subcategory, expense_date, amount, quantity, rate, description } = req.body;
    category     = category     ?? e.category;
    subcategory  = subcategory  ?? e.subcategory;
    expense_date = expense_date ?? e.expense_date;
    description  = description  ?? e.description;

    if (!VALID_CATS.has(category)) return res.status(400).json({ error: `category must be one of ${[...VALID_CATS].join(', ')}` });
    if (category === 'other' && (!subcategory || !VALID_SUBS.has(subcategory))) {
      return res.status(400).json({ error: `Other expenses require a sub-option: ${[...VALID_SUBS].join(', ')}` });
    }
    if (category !== 'other') subcategory = null;

    if (category === 'mileage') {
      const q = quantity != null ? Number(quantity) : e.quantity;
      if (!q || q < 0) return res.status(400).json({ error: 'mileage requires a positive quantity (miles)' });
      rate = getPolicy(db).MILEAGE_RATE;
      amount = +(q * rate).toFixed(2);
      quantity = q;
    } else if (category === 'labor' || category === 'drive') {
      // v0.55 — both labor and drive are billable: amount = hours × rate.
      const q = quantity != null ? Number(quantity) : e.quantity;
      if (!q || q <= 0) return res.status(400).json({ error: `${category} requires a positive quantity (hours)` });
      let effectiveRate = rate != null ? Number(rate) : (e.rate || 0);
      if (!isFinite(effectiveRate) || effectiveRate <= 0) {
        const owner = db.prepare("SELECT hourly_rate FROM users WHERE id = ?").get(e.user_id);
        effectiveRate = owner?.hourly_rate || getPolicy(db).HOURLY_RATE_DEFAULT;
      }
      rate = effectiveRate;
      amount = +(q * effectiveRate).toFixed(2);
      quantity = q;
    } else {
      amount = amount != null ? Number(amount) : e.amount;
      if (!isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a positive number' });
      quantity = quantity != null ? Number(quantity) : null;
      rate = rate != null ? Number(rate) : null;
    }
    {
      const POL = getPolicy(db);
      if (category === 'other' && subcategory === 'Meal' && amount > POL.MEAL_DAILY_CAP) {
        return res.status(400).json({ error: `Meals are capped at $${POL.MEAL_DAILY_CAP}/day` });
      }
    }

    db.prepare(`
      UPDATE expenses SET category = ?, subcategory = ?, expense_date = ?, amount = ?,
        quantity = ?, rate = ?, description = ?
      WHERE id = ?
    `).run(category, subcategory, expense_date, amount, quantity, rate, description, id);

    logAudit(db, { entity_type: 'expenses', entity_id: id, user_id: userId, action: 'update',
                   details: { category, amount } });

    // v0.64 — keep the invoice total fresh immediately after a line-item edit.
    // computeInvoice is shared from routes/invoices.js (see db.__computeInvoice).
    if (e.invoice_id && typeof db.__computeInvoice === 'function') {
      try { db.__computeInvoice(e.invoice_id); } catch (_) {}
    }

    // v0.64.3 — when a MANAGER edits a tech's expense, leave an informational
    // notice for the tech. No action required unless the invoice is rejected.
    if (e.user_id !== userId) {
      try {
        const tech = db.prepare("SELECT email FROM users WHERE id = ?").get(e.user_id);
        const mgr  = db.prepare("SELECT name FROM users WHERE id = ?").get(userId);
        db.prepare(`INSERT INTO notifications (kind, invoice_id, triggered_by, recipient, subject, body, status)
                    VALUES ('line_item_edited', ?, ?, ?, ?, ?, 'logged')`)
          .run(e.invoice_id || null, userId, tech?.email || null,
               `${mgr?.name || 'A manager'} edited an expense on your invoice`,
               `${mgr?.name || 'A manager'} updated a ${category}${subcategory ? ' / ' + subcategory : ''} expense to $${(+amount).toFixed(2)}. Informational — no action needed unless the invoice is rejected and returned for resubmission.`);
      } catch (_) {}
    }

    const row = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
    res.json(row);
  });

  // DELETE /api/expenses/:id
  router.delete('/expenses/:id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const e = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
    if (!e) return res.status(404).json({ error: 'not found' });
    if (e.user_id !== userId) {
      const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
      const allowed = me && (
        me.role === 'sr_manager' || me.role === 'pm' ||
        (me.role === 'ops_manager' && db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, e.user_id))
      );
      if (!allowed) return res.status(403).json({ error: 'not yours' });
    }
    if (e.invoice_id) {
      const inv = db.prepare("SELECT status FROM invoices WHERE id = ?").get(e.invoice_id);
      if (inv && inv.status !== 'draft') {
        return res.status(409).json({ error: 'expense already on submitted invoice' });
      }
    }
    db.prepare("DELETE FROM expenses WHERE id = ?").run(id);
    logAudit(db, { entity_type: 'expenses', entity_id: id, user_id: userId, action: 'delete' });
    res.json({ deleted: true });
  });

  return router;
};

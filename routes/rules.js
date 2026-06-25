// Custom validation rules — Ops-Mgr-configurable layer on top of built-in policy.
//
// Endpoints (manager-only):
//   GET    /api/rules
//   POST   /api/rules    { rule_type, work_type_filter?, category_filter?, threshold, description?, severity? }
//   DELETE /api/rules/:id
//   PATCH  /api/rules/:id  { active }   → toggle on/off without deleting
//
// Rule evaluation lives in lib/rules.js so invoices.js can import it.

const express = require('express');
const router  = express.Router();
const { logAudit, activeWorkTypes, getPolicy } = require('../db');

const VALID_TYPES = new Set([
  'max_hours_per_shift','max_hours_per_day','max_drive_hours_per_day','max_miles_per_day',
  'max_expense_amount','require_receipt_above',
  // v0.20 — replace the retired universal HOURS_FLAG_MULTIPLIER with explicit
  // configurable thresholds the Ops Mgr sets per work_type and cart count.
  // v0.23 — `max_hours_per_cart` retired and replaced by `max_hours_per_10_carts`
  // (the legacy name still parses for backward compatibility on existing rows).
  'max_hours_per_wo','max_hours_per_10_carts','max_hours_per_cart',
]);

function requireManager(db, userId) {
  if (!userId) return false;
  const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
  return me && ['ops_manager','sr_manager','pm'].includes(me.role);
}

module.exports = (db) => {
  router.get('/rules', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!requireManager(db, userId)) return res.status(403).json({ error: 'manager role required' });
    const rows = db.prepare(`
      SELECT r.*, u.name AS created_by_name
      FROM custom_rules r LEFT JOIN users u ON u.id = r.created_by
      ORDER BY active DESC, r.id DESC
    `).all();
    res.json(rows);
  });

  router.post('/rules', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!requireManager(db, userId)) return res.status(403).json({ error: 'manager role required' });
    const { rule_type, work_type_filter, category_filter, cart_count_min, threshold, description, severity } = req.body;
    if (!VALID_TYPES.has(rule_type)) return res.status(400).json({ error: `rule_type must be one of: ${[...VALID_TYPES].join(', ')}` });
    const t = Number(threshold);
    if (!isFinite(t) || t <= 0) return res.status(400).json({ error: 'threshold must be a positive number' });
    if (work_type_filter && !activeWorkTypes(db).has(work_type_filter)) {
      return res.status(400).json({ error: 'work_type_filter invalid' });
    }
    let cm = null;
    if (cart_count_min != null && cart_count_min !== '') {
      cm = Number(cart_count_min);
      if (!Number.isInteger(cm) || cm < 0) return res.status(400).json({ error: 'cart_count_min must be a non-negative integer' });
    }
    const sev = ['warn','flag','block'].includes(severity) ? severity : 'flag';

    const r = db.prepare(`
      INSERT INTO custom_rules (rule_type, work_type_filter, category_filter, cart_count_min, threshold, description, severity, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(rule_type, work_type_filter || null, category_filter || null, cm, t, description || null, sev, userId);

    logAudit(db, { entity_type: 'custom_rules', entity_id: r.lastInsertRowid, user_id: userId,
                   action: 'create', details: { rule_type, threshold: t, work_type_filter, cart_count_min: cm, severity: sev } });

    res.json(db.prepare("SELECT * FROM custom_rules WHERE id = ?").get(r.lastInsertRowid));
  });

  router.patch('/rules/:id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!requireManager(db, userId)) return res.status(403).json({ error: 'manager role required' });
    const id = Number(req.params.id);
    const r = db.prepare("SELECT * FROM custom_rules WHERE id = ?").get(id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const { active, threshold, description, severity, cart_count_min, work_type_filter } = req.body;
    if (active != null)      db.prepare("UPDATE custom_rules SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
    if (threshold != null)   db.prepare("UPDATE custom_rules SET threshold = ? WHERE id = ?").run(Number(threshold), id);
    if (description != null) db.prepare("UPDATE custom_rules SET description = ? WHERE id = ?").run(String(description), id);
    if (severity && ['warn','flag','block'].includes(severity)) db.prepare("UPDATE custom_rules SET severity = ? WHERE id = ?").run(severity, id);
    if (cart_count_min !== undefined) {
      const cm = (cart_count_min === null || cart_count_min === '') ? null : Number(cart_count_min);
      if (cm !== null && (!Number.isInteger(cm) || cm < 0)) return res.status(400).json({ error: 'cart_count_min must be a non-negative integer' });
      db.prepare("UPDATE custom_rules SET cart_count_min = ? WHERE id = ?").run(cm, id);
    }
    if (work_type_filter !== undefined) {
      const wt = (work_type_filter === '' || work_type_filter === null) ? null : work_type_filter;
      if (wt && !activeWorkTypes(db).has(wt)) return res.status(400).json({ error: 'work_type_filter invalid' });
      db.prepare("UPDATE custom_rules SET work_type_filter = ? WHERE id = ?").run(wt, id);
    }
    logAudit(db, { entity_type: 'custom_rules', entity_id: id, user_id: userId, action: 'update', details: req.body });
    res.json(db.prepare("SELECT * FROM custom_rules WHERE id = ?").get(id));
  });

  router.delete('/rules/:id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!requireManager(db, userId)) return res.status(403).json({ error: 'manager role required' });
    const id = Number(req.params.id);
    db.prepare("DELETE FROM custom_rules WHERE id = ?").run(id);
    logAudit(db, { entity_type: 'custom_rules', entity_id: id, user_id: userId, action: 'delete' });
    res.json({ deleted: true });
  });

  return router;
};

// Evaluator used by routes/invoices.js when computing flags on a WO line.
module.exports.evaluate = (db, line, expenses, timeEntries) => {
  const rules = db.prepare("SELECT * FROM custom_rules WHERE active = 1").all();
  const flags = [];
  for (const r of rules) {
    if (r.work_type_filter && r.work_type_filter !== line.work_type) continue;

    if (r.rule_type === 'max_hours_per_shift') {
      for (const t of timeEntries) {
        if (t.external_id !== line.external_id) continue;
        if ((t.hours || 0) > r.threshold) {
          flags.push({ rule: r.rule_type, severity: r.severity,
            message: `Shift on ${new Date(t.clock_in).toLocaleDateString()} was ${(t.hours||0).toFixed(2)} hrs (max ${r.threshold})` });
        }
      }
    } else if (r.rule_type === 'max_hours_per_day') {
      const byDate = {};
      for (const t of timeEntries) {
        if (t.external_id !== line.external_id || (t.mode || 'work') !== 'work') continue;
        const d = (t.clock_in || '').slice(0,10);
        byDate[d] = (byDate[d] || 0) + (t.hours || 0);
      }
      for (const [d, h] of Object.entries(byDate)) {
        if (h > r.threshold) flags.push({ rule: r.rule_type, severity: r.severity,
          message: `${h.toFixed(2)} work hrs on ${d} exceeds max ${r.threshold} hrs/day` });
      }
    } else if (r.rule_type === 'max_drive_hours_per_day') {
      const byDate = {};
      for (const t of timeEntries) {
        if (t.external_id !== line.external_id || t.mode !== 'drive') continue;
        const d = (t.clock_in || '').slice(0,10);
        byDate[d] = (byDate[d] || 0) + (t.hours || 0);
      }
      for (const [d, h] of Object.entries(byDate)) {
        if (h > r.threshold) flags.push({ rule: r.rule_type, severity: r.severity,
          message: `${h.toFixed(2)} drive hrs on ${d} exceeds max ${r.threshold} hrs/day` });
      }
    } else if (r.rule_type === 'max_miles_per_day') {
      const byDate = {};
      for (const e of expenses) {
        if (e.external_id !== line.external_id || e.category !== 'mileage') continue;
        const d = (e.expense_date || '').slice(0,10);
        byDate[d] = (byDate[d] || 0) + (e.quantity || 0);
      }
      for (const [d, mi] of Object.entries(byDate)) {
        if (mi > r.threshold) flags.push({ rule: r.rule_type, severity: r.severity,
          message: `${mi.toFixed(1)} mi on ${d} exceeds max ${r.threshold} mi/day` });
      }
    } else if (r.rule_type === 'max_expense_amount') {
      for (const e of expenses) {
        if (e.external_id !== line.external_id) continue;
        if (r.category_filter && e.category !== r.category_filter) continue;
        if ((e.amount || 0) > r.threshold) flags.push({ rule: r.rule_type, severity: r.severity,
          message: `${e.category}${e.subcategory?'/'+e.subcategory:''} of $${e.amount.toFixed(2)} on ${e.expense_date} exceeds max $${r.threshold}` });
      }
    } else if (r.rule_type === 'require_receipt_above') {
      for (const e of expenses) {
        if (e.external_id !== line.external_id) continue;
        if (r.category_filter && e.category !== r.category_filter) continue;
        if ((e.amount || 0) > r.threshold && !e.receipt_path) flags.push({ rule: r.rule_type, severity: r.severity,
          message: `${e.category}${e.subcategory?'/'+e.subcategory:''} $${e.amount.toFixed(2)} requires a receipt (over $${r.threshold})` });
      }
    } else if (r.rule_type === 'max_hours_per_wo') {
      // Cap on total work hours billed to a single WO line, optionally
      // gated by a minimum cart count so the rule only applies to large WOs.
      if (r.cart_count_min != null && (line.cart_count || 0) < r.cart_count_min) continue;
      if ((line.labor_hours || 0) > r.threshold) {
        const wt = r.work_type_filter ? `${r.work_type_filter} ` : '';
        const carts = r.cart_count_min ? ` with ≥${r.cart_count_min} carts` : '';
        flags.push({ rule: r.rule_type, severity: r.severity,
          message: `${(line.labor_hours||0).toFixed(2)} labor hrs on ${line.external_id} exceeds max ${r.threshold} hrs for ${wt}WO${carts} (${line.cart_count || 0} carts)` });
      }
    } else if (r.rule_type === 'max_hours_per_10_carts' || r.rule_type === 'max_hours_per_cart') {
      // Cap on hours-per-10-carts productivity ratio. Threshold = hrs per 10 carts.
      // The legacy `max_hours_per_cart` rule type is auto-treated as per-cart (×10
      // converts the threshold for evaluation); we keep both running so old rules
      // saved before the v0.23 rename keep their original semantics.
      const carts = line.cart_count || 0;
      if (carts <= 0) continue;
      if (r.cart_count_min != null && carts < r.cart_count_min) continue;
      // Scale so the threshold's units match the rule type. The DB stores raw
      // user input — so a per-cart row's threshold is hrs/cart and a per-10-carts
      // row's threshold is hrs/10-carts. We compare both in their native unit.
      const isPer10 = r.rule_type === 'max_hours_per_10_carts';
      const actual = isPer10
        ? (line.labor_hours || 0) / (carts / 10)   // hrs per 10 carts
        : (line.labor_hours || 0) / carts;          // hrs per cart (legacy)
      if (actual > r.threshold) {
        const wt   = r.work_type_filter ? `${r.work_type_filter} ` : '';
        const unit = isPer10 ? 'hrs / 10 carts' : 'hrs/cart';
        flags.push({ rule: r.rule_type, severity: r.severity,
          message: `${actual.toFixed(2)} ${unit} on ${line.external_id} (${(line.labor_hours||0).toFixed(2)} hrs / ${carts} carts) exceeds max ${r.threshold} ${unit} for ${wt}WO` });
      }
    }
  }
  return flags;
};

// v0.61 — Per-WO category budget overruns + category receipt thresholds.
//
// Three flag sources, all keyed off the line's work_order_id:
//
//   1. wo_category_budgets — explicit per-WO $ cap. Wins over the org default.
//   2. category_rules.per_wo_cap — org default cap, used only when no explicit
//      wo_category_budgets row exists for that (WO, category).
//   3. category_rules.receipt_required_above (tech_expense only) — any single
//      expense above the threshold without a receipt flags.
//
// Corp-card spend is pulled live from corp_card_expenses since it never lives
// on a reimbursable invoice. Tech-expense subcategory spend is summed from
// the invoice's expenses arg, matching `subcategory` against `category_key`.
module.exports.evaluateBudgets = (db, line, expenses) => {
  const flags = [];
  if (!line || !line.work_order_id) return flags;
  const woId = line.work_order_id;

  // --- helpers ---------------------------------------------------------
  const ccCatName = (key) => {
    const row = db.prepare("SELECT name FROM corp_card_categories WHERE id = ?").get(Number(key));
    return row ? row.name : `Corp card #${key}`;
  };

  function spendForCategory(source, key) {
    if (source === 'corp_card') {
      const row = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS t
        FROM corp_card_expenses
        WHERE work_order_id = ? AND category_id = ?
      `).get(woId, Number(key));
      return row.t || 0;
    }
    // tech_expense — sum from the invoice's expenses for this WO + subcategory.
    let sum = 0;
    for (const e of expenses) {
      if (e.work_order_id !== woId) continue;
      if ((e.subcategory || '') !== key) continue;
      sum += e.amount || 0;
    }
    return sum;
  }

  // --- 1. Explicit per-WO budgets --------------------------------------
  const budgets = db.prepare(`
    SELECT * FROM wo_category_budgets WHERE work_order_id = ?
  `).all(woId);
  const explicit = new Set();
  for (const b of budgets) {
    explicit.add(`${b.category_source}|${b.category_key}`);
    const spent = spendForCategory(b.category_source, b.category_key);
    if (spent > b.amount_cap) {
      const label = b.category_source === 'corp_card' ? ccCatName(b.category_key) : b.category_key;
      flags.push({
        rule: 'wo_category_budget',
        severity: 'flag',
        message: `${label} spend $${spent.toFixed(2)} on ${line.external_id} exceeds per-WO budget $${b.amount_cap.toFixed(2)} (over by $${(spent - b.amount_cap).toFixed(2)})`,
      });
    }
  }

  // --- 2. Org-default per_wo_cap from category_rules -------------------
  const defaultCaps = db.prepare(`
    SELECT * FROM category_rules
    WHERE rule_kind = 'per_wo_cap' AND amount IS NOT NULL
  `).all();
  for (const r of defaultCaps) {
    const k = `${r.category_source}|${r.category_key}`;
    if (explicit.has(k)) continue; // explicit budget already evaluated above
    const spent = spendForCategory(r.category_source, r.category_key);
    if (spent > r.amount) {
      const label = r.category_source === 'corp_card' ? ccCatName(r.category_key) : r.category_key;
      flags.push({
        rule: 'category_per_wo_cap',
        severity: 'flag',
        message: `${label} spend $${spent.toFixed(2)} on ${line.external_id} exceeds org per-WO cap $${r.amount.toFixed(2)}`,
      });
    }
  }

  // --- 3. receipt_required_above (tech_expense only) -------------------
  // Corp-card charges don't carry receipt_path on expenses, so this rule
  // only applies to tech-expense subcategories on the invoice.
  const receiptRules = db.prepare(`
    SELECT * FROM category_rules
    WHERE rule_kind = 'receipt_required_above'
      AND amount IS NOT NULL
      AND category_source = 'tech_expense'
  `).all();
  for (const r of receiptRules) {
    for (const e of expenses) {
      if (e.work_order_id !== woId) continue;
      if ((e.subcategory || '') !== r.category_key) continue;
      if ((e.amount || 0) > r.amount && !e.receipt_path) {
        flags.push({
          rule: 'category_receipt_required',
          severity: 'flag',
          message: `${r.category_key} $${(e.amount || 0).toFixed(2)} on ${e.expense_date} requires a receipt (over $${r.amount.toFixed(2)})`,
        });
      }
    }
  }

  return flags;
};

// v0.70 — Baseline hours-per-10-carts enforcement.
//
// The Policy page exposes one HOURS_PER_10_CARTS value per work type. Until now
// that number was display-only — it fed the per-line "expected hours" label but
// nothing flagged when actuals blew past it (the universal hours-overrun flag
// was retired in v0.20, leaving the setting with no teeth). This re-connects it:
// a WO line flags when its labor hrs / 10 carts exceeds the configured baseline
// for its work type.
//
// Custom rules still win. To avoid double-flagging, the baseline is SUPPRESSED
// for a work type whenever an active custom hours rule already governs it
// (max_hours_per_10_carts / max_hours_per_wo / max_hours_per_cart, scoped to
// that work type or universal) — the manager's explicit rule is the override.
module.exports.evaluateBaselines = (db, line, policy) => {
  const flags = [];
  if (!line) return flags;
  const carts = line.cart_count || 0;
  if (carts <= 0) return flags;                    // hrs/10-carts ratio is undefined without carts
  const wt = line.work_type;
  if (!wt) return flags;

  const pol = policy || getPolicy(db);
  const baseline = pol && pol.HOURS_PER_10_CARTS ? pol.HOURS_PER_10_CARTS[wt] : undefined;
  if (!(baseline > 0)) return flags;               // no baseline configured for this work type

  // Suppress when a custom hours rule already covers this work type.
  const covered = db.prepare(`
    SELECT 1 FROM custom_rules
     WHERE active = 1
       AND rule_type IN ('max_hours_per_10_carts','max_hours_per_wo','max_hours_per_cart')
       AND (work_type_filter IS NULL OR work_type_filter = ?)
     LIMIT 1
  `).get(wt);
  if (covered) return flags;

  const actual = (line.labor_hours || 0) / (carts / 10);   // hrs per 10 carts
  if (actual > baseline) {
    flags.push({
      rule: 'baseline_hours_per_10_carts',
      severity: 'flag',
      message: `${actual.toFixed(2)} hrs / 10 carts on ${line.external_id} (${(line.labor_hours||0).toFixed(2)} hrs / ${carts} carts) exceeds the ${wt} policy baseline of ${baseline} hrs / 10 carts`,
    });
  }
  return flags;
};

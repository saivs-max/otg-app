// Per-category rules + per-WO category budgets API (v0.61).
//
// Two related concepts share this file because they share an addressing
// scheme: every category is identified by (source, key) where
//   source = 'corp_card'   → key is the corp_card_categories.id (stringified)
//   source = 'tech_expense'→ key is one of TECH_EXPENSE_SUBCATS
//
// Endpoints (manager-only):
//   GET    /api/category-rules                    — list every (cat, rule_kind) row + amount
//   PUT    /api/category-rules/:id  { amount }    — set the $ amount (null clears it)
//
//   GET    /api/wo-budgets                        — list every per-WO budget (optionally filtered)
//                                                   ?work_order_id=N | ?category_source=... | ?category_key=...
//   PUT    /api/wo-budgets                        — upsert one budget
//                                                   { work_order_id, category_source, category_key, amount_cap }
//   DELETE /api/wo-budgets/:id                    — drop a budget row
//
//   GET    /api/category-dashboard                — per-category summary used by the
//                                                   Dashboard sub-tabs:
//                                                     [{ source, key, label,
//                                                        rules: {per_wo_cap, global_cap, receipt_required_above},
//                                                        mtd, ytd, all_time, count,
//                                                        over_budget_wos: [...] }]
//
const express = require('express');
const router  = express.Router();
const { logAudit, CATEGORY_RULE_KINDS, TECH_EXPENSE_SUBCATS } = require('../db');

const MGR_ROLES = new Set(['ops_manager', 'sr_manager', 'pm']);

module.exports = (db) => {

  function requireManager(req, res) {
    const userId = Number(req.header('x-user-id'));
    if (!userId) { res.status(401).json({ error: 'no user selected' }); return null; }
    const me = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
    if (!me) { res.status(401).json({ error: 'unknown user' }); return null; }
    if (!MGR_ROLES.has(me.role)) { res.status(403).json({ error: 'manager role required' }); return null; }
    return me;
  }

  // Resolve (source, key) → human label. Used by every read endpoint so the
  // UI never has to look up names a second time.
  function labelFor(source, key) {
    if (source === 'corp_card') {
      const row = db.prepare("SELECT name FROM corp_card_categories WHERE id = ?").get(Number(key));
      return row ? row.name : `Corp card #${key}`;
    }
    return key; // tech_expense — the key already is the human-readable name
  }

  // ---- category_rules ---------------------------------------------------

  router.get('/category-rules', (req, res) => {
    if (!requireManager(req, res)) return;
    const rows = db.prepare(`
      SELECT r.id, r.category_source, r.category_key, r.rule_kind, r.amount,
             r.updated_by, r.updated_at,
             u.name AS updated_by_name
      FROM category_rules r
      LEFT JOIN users u ON u.id = r.updated_by
      ORDER BY r.category_source, r.category_key, r.rule_kind
    `).all();
    res.json(rows.map(r => ({ ...r, category_label: labelFor(r.category_source, r.category_key) })));
  });

  router.put('/category-rules/:id', (req, res) => {
    const me = requireManager(req, res); if (!me) return;
    const id  = Number(req.params.id);
    const row = db.prepare("SELECT * FROM category_rules WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: 'not found' });

    const raw = req.body?.amount;
    let amount = null;
    if (raw !== null && raw !== '' && raw !== undefined) {
      amount = Number(raw);
      if (!isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a non-negative number or null' });
    }
    db.prepare(`
      UPDATE category_rules
         SET amount = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(amount, me.id, id);

    logAudit(db, { entity_type: 'category_rules', entity_id: id, user_id: me.id,
                   action: 'update', details: { amount, rule_kind: row.rule_kind, category_source: row.category_source, category_key: row.category_key } });

    res.json(db.prepare("SELECT * FROM category_rules WHERE id = ?").get(id));
  });

  // ---- wo_category_budgets ----------------------------------------------

  router.get('/wo-budgets', (req, res) => {
    if (!requireManager(req, res)) return;
    const where = [];
    const params = [];
    if (req.query.work_order_id) { where.push('b.work_order_id = ?'); params.push(Number(req.query.work_order_id)); }
    if (req.query.category_source) { where.push('b.category_source = ?'); params.push(String(req.query.category_source)); }
    if (req.query.category_key) { where.push('b.category_key = ?'); params.push(String(req.query.category_key)); }

    const rows = db.prepare(`
      SELECT b.id, b.work_order_id, b.category_source, b.category_key, b.amount_cap,
             b.updated_by, b.updated_at,
             u.name AS updated_by_name,
             w.external_id AS wo_external_id,
             w.store_name  AS wo_store_name,
             w.work_type   AS wo_work_type
      FROM wo_category_budgets b
      LEFT JOIN users u ON u.id = b.updated_by
      LEFT JOIN work_orders w ON w.id = b.work_order_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY w.external_id, b.category_source, b.category_key
    `).all(...params);
    res.json(rows.map(r => ({ ...r, category_label: labelFor(r.category_source, r.category_key) })));
  });

  router.put('/wo-budgets', (req, res) => {
    const me = requireManager(req, res); if (!me) return;
    const work_order_id  = Number(req.body?.work_order_id);
    const category_source = String(req.body?.category_source || '');
    const category_key    = String(req.body?.category_key || '');
    const raw = req.body?.amount_cap;

    if (!work_order_id) return res.status(400).json({ error: 'work_order_id required' });
    if (!['corp_card','tech_expense'].includes(category_source)) return res.status(400).json({ error: 'category_source invalid' });
    if (!category_key) return res.status(400).json({ error: 'category_key required' });
    if (raw === null || raw === '' || raw === undefined) {
      // Clearing a budget — equivalent to delete.
      const existing = db.prepare(`
        SELECT id FROM wo_category_budgets
        WHERE work_order_id = ? AND category_source = ? AND category_key = ?
      `).get(work_order_id, category_source, category_key);
      if (existing) {
        db.prepare("DELETE FROM wo_category_budgets WHERE id = ?").run(existing.id);
        logAudit(db, { entity_type: 'wo_category_budgets', entity_id: existing.id, user_id: me.id, action: 'delete' });
      }
      return res.json({ cleared: true });
    }
    const amount = Number(raw);
    if (!isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount_cap must be a non-negative number' });

    // Validate the work order + category combo exists.
    const wo = db.prepare("SELECT id FROM work_orders WHERE id = ?").get(work_order_id);
    if (!wo) return res.status(400).json({ error: 'unknown work_order_id' });
    if (category_source === 'corp_card') {
      const cat = db.prepare("SELECT id FROM corp_card_categories WHERE id = ?").get(Number(category_key));
      if (!cat) return res.status(400).json({ error: 'unknown corp-card category' });
    } else if (!TECH_EXPENSE_SUBCATS.includes(category_key)) {
      return res.status(400).json({ error: `category_key must be one of: ${TECH_EXPENSE_SUBCATS.join(', ')}` });
    }

    // Upsert.
    db.prepare(`
      INSERT INTO wo_category_budgets (work_order_id, category_source, category_key, amount_cap, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (work_order_id, category_source, category_key) DO UPDATE
        SET amount_cap = excluded.amount_cap,
            updated_by = excluded.updated_by,
            updated_at = CURRENT_TIMESTAMP
    `).run(work_order_id, category_source, category_key, amount, me.id);

    const row = db.prepare(`
      SELECT * FROM wo_category_budgets
      WHERE work_order_id = ? AND category_source = ? AND category_key = ?
    `).get(work_order_id, category_source, category_key);
    logAudit(db, { entity_type: 'wo_category_budgets', entity_id: row.id, user_id: me.id, action: 'upsert',
                   details: { work_order_id, category_source, category_key, amount_cap: amount } });
    res.json(row);
  });

  router.delete('/wo-budgets/:id', (req, res) => {
    const me = requireManager(req, res); if (!me) return;
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM wo_category_budgets WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    db.prepare("DELETE FROM wo_category_budgets WHERE id = ?").run(id);
    logAudit(db, { entity_type: 'wo_category_budgets', entity_id: id, user_id: me.id, action: 'delete' });
    res.json({ deleted: true });
  });

  // ---- per-category dashboard summary -----------------------------------
  //
  // Returns one row per category with totals + a list of WOs that have
  // exceeded their per-WO budget. Used by the Dashboard sub-tabs.
  router.get('/category-dashboard', (req, res) => {
    if (!requireManager(req, res)) return;

    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm   = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(now.getUTCDate()).padStart(2, '0');
    const today = `${yyyy}-${mm}-${dd}`;
    const mtdStart = `${yyyy}-${mm}-01`;
    const ytdStart = `${yyyy}-01-01`;

    // Pull every category we know about (active + archived corp-card rows
    // + every tech-expense subcategory).
    const ccCats = db.prepare("SELECT id, name, archived_at FROM corp_card_categories").all();
    const cats = [
      ...ccCats.map(c => ({ source: 'corp_card', key: String(c.id), label: c.name, archived_at: c.archived_at })),
      ...TECH_EXPENSE_SUBCATS.map(s => ({ source: 'tech_expense', key: s, label: s, archived_at: null })),
    ];

    // Pre-pull every rule + every budget so we can attach them with N=O(rows).
    const allRules = db.prepare("SELECT * FROM category_rules").all();
    const allBudgets = db.prepare(`
      SELECT b.*, w.external_id AS wo_external_id, w.store_name AS wo_store_name
      FROM wo_category_budgets b LEFT JOIN work_orders w ON w.id = b.work_order_id
    `).all();

    const out = cats.map(cat => {
      const rules = { per_wo_cap: null, global_cap: null, receipt_required_above: null };
      for (const r of allRules) {
        if (r.category_source === cat.source && r.category_key === cat.key) rules[r.rule_kind] = r.amount;
      }
      const budgets = allBudgets.filter(b => b.category_source === cat.source && b.category_key === cat.key);

      // Totals — corp_card vs tech_expense source different tables.
      let mtd = 0, ytd = 0, allTime = 0, count = 0;
      if (cat.source === 'corp_card') {
        const cid = Number(cat.key);
        const mtdRow = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM corp_card_expenses WHERE category_id = ? AND expense_date BETWEEN ? AND ?").get(cid, mtdStart, today);
        const ytdRow = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM corp_card_expenses WHERE category_id = ? AND expense_date BETWEEN ? AND ?").get(cid, ytdStart, today);
        const allRow = db.prepare("SELECT COALESCE(SUM(amount),0) AS t, COUNT(*) AS n FROM corp_card_expenses WHERE category_id = ?").get(cid);
        mtd = mtdRow.t; ytd = ytdRow.t; allTime = allRow.t; count = allRow.n;
      } else {
        // tech_expense subcategory — stored on expenses table as subcategory
        // when category = 'other' (per VALID_SUBS in routes/expenses.js).
        const mtdRow = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM expenses WHERE subcategory = ? AND expense_date BETWEEN ? AND ?").get(cat.key, mtdStart, today);
        const ytdRow = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM expenses WHERE subcategory = ? AND expense_date BETWEEN ? AND ?").get(cat.key, ytdStart, today);
        const allRow = db.prepare("SELECT COALESCE(SUM(amount),0) AS t, COUNT(*) AS n FROM expenses WHERE subcategory = ?").get(cat.key);
        mtd = mtdRow.t; ytd = ytdRow.t; allTime = allRow.t; count = allRow.n;
      }

      // Per-WO actuals + over-budget detection.
      const woActuals = {};
      if (cat.source === 'corp_card') {
        const rows = db.prepare(`
          SELECT x.work_order_id AS wo_id, w.external_id, w.store_name,
                 COALESCE(SUM(x.amount),0) AS spent, COUNT(*) AS n
          FROM corp_card_expenses x LEFT JOIN work_orders w ON w.id = x.work_order_id
          WHERE x.category_id = ? AND x.work_order_id IS NOT NULL
          GROUP BY x.work_order_id
        `).all(Number(cat.key));
        for (const r of rows) woActuals[r.wo_id] = r;
      } else {
        const rows = db.prepare(`
          SELECT e.work_order_id AS wo_id, w.external_id, w.store_name,
                 COALESCE(SUM(e.amount),0) AS spent, COUNT(*) AS n
          FROM expenses e LEFT JOIN work_orders w ON w.id = e.work_order_id
          WHERE e.subcategory = ?
          GROUP BY e.work_order_id
        `).all(cat.key);
        for (const r of rows) woActuals[r.wo_id] = r;
      }

      const overBudget = [];
      for (const b of budgets) {
        const a = woActuals[b.work_order_id];
        const spent = a ? a.spent : 0;
        if (spent > (b.amount_cap || 0)) {
          overBudget.push({
            work_order_id: b.work_order_id,
            external_id:   b.wo_external_id,
            store_name:    b.wo_store_name,
            amount_cap:    b.amount_cap,
            spent:         +spent.toFixed(2),
            overage:       +(spent - b.amount_cap).toFixed(2),
          });
        }
      }

      return {
        source: cat.source,
        key:    cat.key,
        label:  cat.label,
        archived: !!cat.archived_at,
        rules,
        budgets: budgets.map(b => ({
          id: b.id,
          work_order_id: b.work_order_id,
          external_id:   b.wo_external_id,
          store_name:    b.wo_store_name,
          amount_cap:    b.amount_cap,
          spent:         woActuals[b.work_order_id]?.spent || 0,
        })),
        over_budget_wos: overBudget,
        totals: {
          mtd:     +mtd.toFixed(2),
          ytd:     +ytd.toFixed(2),
          all_time:+allTime.toFixed(2),
          count,
        },
      };
    });

    res.json(out);
  });

  return router;
};

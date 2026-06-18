// Corporate-card ledger API (v0.60).
//
// Lives entirely separate from /api/expenses so corp-card spend can never
// end up on a reimbursable tech invoice. Write access is gated to manager
// roles (ops_manager / sr_manager / pm); read access is gated to the same
// set (techs do not see corp-card spend).
//
// Endpoints:
//   GET    /api/corp-card/categories          → all categories (active by default; ?include=archived)
//   POST   /api/corp-card/categories          → ops_manager+ creates a category
//   PATCH  /api/corp-card/categories/:id      → ops_manager+ rename or unarchive
//   DELETE /api/corp-card/categories/:id      → ops_manager+ soft-archive
//   GET    /api/corp-card/expenses            → filterable list (date range, tech, category, store, work_order)
//   POST   /api/corp-card/expenses            → file a charge (manager+)
//   PATCH  /api/corp-card/expenses/:id        → edit (creator or sr_manager+)
//   DELETE /api/corp-card/expenses/:id        → delete (creator or sr_manager+)
//   GET    /api/corp-card/summary             → totals by category / tech / month for dashboard + tab
//
const express = require('express');
const router  = express.Router();
const { logAudit, CATEGORY_RULE_KINDS } = require('../db');

const MGR_ROLES = new Set(['ops_manager', 'sr_manager', 'pm']);

module.exports = (db) => {

  // ---- helpers ----------------------------------------------------------
  function requireUser(req, res) {
    const userId = Number(req.header('x-user-id'));
    if (!userId) { res.status(401).json({ error: 'no user selected' }); return null; }
    const me = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
    if (!me) { res.status(401).json({ error: 'unknown user' }); return null; }
    return me;
  }

  function requireManager(req, res) {
    const me = requireUser(req, res);
    if (!me) return null;
    if (!MGR_ROLES.has(me.role)) { res.status(403).json({ error: 'corp card is manager-only' }); return null; }
    return me;
  }

  // ---- categories -------------------------------------------------------

  router.get('/corp-card/categories', (req, res) => {
    if (!requireManager(req, res)) return;
    const includeArchived = req.query.include === 'archived';
    const rows = db.prepare(`
      SELECT c.id, c.name, c.created_by, c.created_at, c.archived_at, c.archived_by,
             u.name AS created_by_name,
             (SELECT COUNT(*) FROM corp_card_expenses x WHERE x.category_id = c.id) AS use_count
      FROM corp_card_categories c
      LEFT JOIN users u ON u.id = c.created_by
      ${includeArchived ? '' : 'WHERE c.archived_at IS NULL'}
      ORDER BY (c.archived_at IS NULL) DESC, c.name COLLATE NOCASE
    `).all();
    res.json(rows);
  });

  router.post('/corp-card/categories', (req, res) => {
    const me = requireManager(req, res); if (!me) return;
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    if (name.length > 60) return res.status(400).json({ error: 'name too long (max 60 chars)' });
    try {
      const r = db.prepare(
        "INSERT INTO corp_card_categories (name, created_by) VALUES (?, ?)"
      ).run(name, me.id);
      // v0.61 — every new category gets three editable rule rows auto-created
      // (per_wo_cap, global_cap, receipt_required_above). amount is NULL until
      // an admin sets it on the Policy page.
      const seedRule = db.prepare(`
        INSERT OR IGNORE INTO category_rules (category_source, category_key, rule_kind, amount)
        VALUES ('corp_card', ?, ?, NULL)
      `);
      for (const k of CATEGORY_RULE_KINDS) seedRule.run(String(r.lastInsertRowid), k);
      logAudit(db, { entity_type: 'corp_card_categories', entity_id: r.lastInsertRowid, user_id: me.id, action: 'create', details: { name } });
      const row = db.prepare("SELECT * FROM corp_card_categories WHERE id = ?").get(r.lastInsertRowid);
      res.status(201).json(row);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        // Resurrect an archived category with the same name instead of erroring.
        const existing = db.prepare("SELECT * FROM corp_card_categories WHERE name = ?").get(name);
        if (existing && existing.archived_at) {
          db.prepare("UPDATE corp_card_categories SET archived_at = NULL, archived_by = NULL WHERE id = ?").run(existing.id);
          logAudit(db, { entity_type: 'corp_card_categories', entity_id: existing.id, user_id: me.id, action: 'unarchive', details: { name } });
          return res.json(db.prepare("SELECT * FROM corp_card_categories WHERE id = ?").get(existing.id));
        }
        return res.status(409).json({ error: 'category already exists' });
      }
      throw e;
    }
  });

  router.patch('/corp-card/categories/:id', (req, res) => {
    const me = requireManager(req, res); if (!me) return;
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM corp_card_categories WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: 'not found' });

    const updates = [];
    const params  = [];
    if (typeof req.body?.name === 'string') {
      const n = req.body.name.trim();
      if (!n) return res.status(400).json({ error: 'name cannot be empty' });
      updates.push('name = ?'); params.push(n);
    }
    if (req.body?.unarchive === true) {
      updates.push('archived_at = NULL', 'archived_by = NULL');
    }
    if (!updates.length) return res.status(400).json({ error: 'nothing to update' });
    params.push(id);
    try {
      db.prepare(`UPDATE corp_card_categories SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'name already in use' });
      throw e;
    }
    logAudit(db, { entity_type: 'corp_card_categories', entity_id: id, user_id: me.id, action: 'update', details: req.body });
    res.json(db.prepare("SELECT * FROM corp_card_categories WHERE id = ?").get(id));
  });

  router.delete('/corp-card/categories/:id', (req, res) => {
    const me = requireManager(req, res); if (!me) return;
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM corp_card_categories WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    // Soft-archive so historical expenses keep their category name.
    db.prepare(
      "UPDATE corp_card_categories SET archived_at = CURRENT_TIMESTAMP, archived_by = ? WHERE id = ?"
    ).run(me.id, id);
    logAudit(db, { entity_type: 'corp_card_categories', entity_id: id, user_id: me.id, action: 'archive' });
    res.json({ archived: true });
  });

  // ---- expenses ---------------------------------------------------------

  // Shared SELECT shape used by GET list + single-row reads after writes.
  // Joins category name, creator, tech (on_behalf_of), and WO/external_id so
  // the UI never has to do a second round trip.
  const EXP_SELECT = `
    SELECT x.id, x.expense_date, x.amount, x.description,
           x.created_at, x.updated_at,
           x.created_by_user_id, x.on_behalf_of_user_id,
           x.work_order_id, x.store_name,
           x.unplanned_tag, x.unplanned_note, x.unplanned_wasted,
           x.category_id, c.name AS category_name,
           cu.name AS created_by_name, cu.role AS created_by_role,
           tu.name AS on_behalf_of_name,
           w.external_id AS wo_external_id,
           w.store_name  AS wo_store_name
    FROM corp_card_expenses x
    JOIN  corp_card_categories c ON c.id = x.category_id
    JOIN  users cu                ON cu.id = x.created_by_user_id
    LEFT  JOIN users tu           ON tu.id = x.on_behalf_of_user_id
    LEFT  JOIN work_orders w      ON w.id = x.work_order_id
  `;

  router.get('/corp-card/expenses', (req, res) => {
    if (!requireManager(req, res)) return;
    const where = [];
    const params = [];
    if (req.query.from) { where.push('x.expense_date >= ?'); params.push(req.query.from); }
    if (req.query.to)   { where.push('x.expense_date <= ?'); params.push(req.query.to); }
    if (req.query.category_id) { where.push('x.category_id = ?'); params.push(Number(req.query.category_id)); }
    if (req.query.tech_id)     { where.push('x.on_behalf_of_user_id = ?'); params.push(Number(req.query.tech_id)); }
    if (req.query.creator_id)  { where.push('x.created_by_user_id = ?'); params.push(Number(req.query.creator_id)); }
    if (req.query.work_order_id) { where.push('x.work_order_id = ?'); params.push(Number(req.query.work_order_id)); }
    const sql = `${EXP_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY x.expense_date DESC, x.id DESC`;
    res.json(db.prepare(sql).all(...params));
  });

  router.get('/corp-card/expenses/:id', (req, res) => {
    if (!requireManager(req, res)) return;
    const row = db.prepare(`${EXP_SELECT} WHERE x.id = ?`).get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  });

  router.post('/corp-card/expenses', (req, res) => {
    const me = requireManager(req, res); if (!me) return;
    const {
      category_id, expense_date, amount, description,
      work_order_id, on_behalf_of_user_id, store_name,
    } = req.body || {};

    if (!category_id) return res.status(400).json({ error: 'category_id required' });
    if (!expense_date) return res.status(400).json({ error: 'expense_date required' });
    if (typeof amount !== 'number' || !(amount > 0)) return res.status(400).json({ error: 'amount must be > 0' });

    const cat = db.prepare("SELECT id, archived_at FROM corp_card_categories WHERE id = ?").get(Number(category_id));
    if (!cat) return res.status(400).json({ error: 'unknown category' });
    if (cat.archived_at) return res.status(400).json({ error: 'category is archived' });

    // Resolve the WO's store_name when WO is provided, so the row is
    // self-describing even if the WO is later edited / deleted.
    let resolvedStore = store_name || null;
    let woId = work_order_id ? Number(work_order_id) : null;
    if (woId) {
      const wo = db.prepare("SELECT id, store_name FROM work_orders WHERE id = ?").get(woId);
      if (!wo) return res.status(400).json({ error: 'unknown work_order_id' });
      if (!resolvedStore) resolvedStore = wo.store_name;
    }

    let techId = on_behalf_of_user_id ? Number(on_behalf_of_user_id) : null;
    if (techId) {
      const t = db.prepare("SELECT id, role FROM users WHERE id = ?").get(techId);
      if (!t) return res.status(400).json({ error: 'unknown on_behalf_of_user_id' });
      // We don't restrict to role=technician — a manager could in principle
      // be the "owner" of a charge for tracking purposes — but we capture
      // the relation for reporting.
    }

    const r = db.prepare(`
      INSERT INTO corp_card_expenses
        (created_by_user_id, on_behalf_of_user_id, work_order_id, store_name,
         category_id, expense_date, amount, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(me.id, techId, woId, resolvedStore, cat.id, expense_date, amount, description || null);

    logAudit(db, { entity_type: 'corp_card_expenses', entity_id: r.lastInsertRowid, user_id: me.id, action: 'create',
                   details: { category_id: cat.id, amount, expense_date, on_behalf_of_user_id: techId, work_order_id: woId } });

    res.status(201).json(db.prepare(`${EXP_SELECT} WHERE x.id = ?`).get(r.lastInsertRowid));
  });

  router.patch('/corp-card/expenses/:id', (req, res) => {
    const me = requireManager(req, res); if (!me) return;
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM corp_card_expenses WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    // Creator can edit their own; sr_manager / pm can edit anyone's.
    if (row.created_by_user_id !== me.id && me.role !== 'sr_manager' && me.role !== 'pm') {
      return res.status(403).json({ error: 'only the creator or sr_manager can edit' });
    }

    const updates = [];
    const params  = [];
    const b = req.body || {};
    if (b.category_id != null) {
      const cat = db.prepare("SELECT id, archived_at FROM corp_card_categories WHERE id = ?").get(Number(b.category_id));
      if (!cat) return res.status(400).json({ error: 'unknown category' });
      if (cat.archived_at) return res.status(400).json({ error: 'category is archived' });
      updates.push('category_id = ?'); params.push(cat.id);
    }
    if (b.expense_date) { updates.push('expense_date = ?'); params.push(b.expense_date); }
    if (b.amount != null) {
      if (typeof b.amount !== 'number' || !(b.amount > 0)) return res.status(400).json({ error: 'amount must be > 0' });
      updates.push('amount = ?'); params.push(b.amount);
    }
    if ('description' in b) { updates.push('description = ?'); params.push(b.description || null); }
    if ('work_order_id' in b) {
      const woId = b.work_order_id ? Number(b.work_order_id) : null;
      if (woId) {
        const wo = db.prepare("SELECT id, store_name FROM work_orders WHERE id = ?").get(woId);
        if (!wo) return res.status(400).json({ error: 'unknown work_order_id' });
        updates.push('work_order_id = ?', 'store_name = ?'); params.push(woId, wo.store_name);
      } else {
        updates.push('work_order_id = NULL');
      }
    }
    if ('on_behalf_of_user_id' in b) {
      const t = b.on_behalf_of_user_id ? Number(b.on_behalf_of_user_id) : null;
      updates.push('on_behalf_of_user_id = ?'); params.push(t);
    }
    if (!updates.length) return res.status(400).json({ error: 'nothing to update' });

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);
    db.prepare(`UPDATE corp_card_expenses SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    logAudit(db, { entity_type: 'corp_card_expenses', entity_id: id, user_id: me.id, action: 'update', details: b });
    res.json(db.prepare(`${EXP_SELECT} WHERE x.id = ?`).get(id));
  });

  router.delete('/corp-card/expenses/:id', (req, res) => {
    const me = requireManager(req, res); if (!me) return;
    const id = Number(req.params.id);
    const row = db.prepare("SELECT * FROM corp_card_expenses WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.created_by_user_id !== me.id && me.role !== 'sr_manager' && me.role !== 'pm') {
      return res.status(403).json({ error: 'only the creator or sr_manager can delete' });
    }
    db.prepare("DELETE FROM corp_card_expenses WHERE id = ?").run(id);
    logAudit(db, { entity_type: 'corp_card_expenses', entity_id: id, user_id: me.id, action: 'delete' });
    res.json({ deleted: true });
  });

  // ---- summary ----------------------------------------------------------
  //
  // GET /api/corp-card/summary
  //   ?from=YYYY-MM-DD&to=YYYY-MM-DD   (defaults: month-to-date)
  //
  // Returns:
  //   {
  //     period: { from, to, label },
  //     totals: { all_time, in_period, mtd, ytd, count_in_period },
  //     by_category: [{ category_id, category_name, total, count }],
  //     by_tech:     [{ tech_id, tech_name, total, count }],
  //     by_month:    [{ month: 'YYYY-MM', total, count }],
  //   }
  router.get('/corp-card/summary', (req, res) => {
    if (!requireManager(req, res)) return;
    const now   = new Date();
    const yyyy  = now.getUTCFullYear();
    const mm    = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd    = String(now.getUTCDate()).padStart(2, '0');
    const today = `${yyyy}-${mm}-${dd}`;
    const mtdStart = `${yyyy}-${mm}-01`;
    const ytdStart = `${yyyy}-01-01`;

    const from = req.query.from || mtdStart;
    const to   = req.query.to   || today;

    const inPeriod = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n
      FROM corp_card_expenses
      WHERE expense_date BETWEEN ? AND ?
    `).get(from, to);

    const allTime = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM corp_card_expenses").get();
    const mtd     = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM corp_card_expenses WHERE expense_date BETWEEN ? AND ?").get(mtdStart, today);
    const ytd     = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM corp_card_expenses WHERE expense_date BETWEEN ? AND ?").get(ytdStart, today);

    const byCat = db.prepare(`
      SELECT c.id AS category_id, c.name AS category_name,
             COALESCE(SUM(x.amount), 0) AS total, COUNT(x.id) AS count
      FROM corp_card_categories c
      LEFT JOIN corp_card_expenses x
        ON x.category_id = c.id AND x.expense_date BETWEEN ? AND ?
      GROUP BY c.id
      HAVING total > 0
      ORDER BY total DESC
    `).all(from, to);

    const byTech = db.prepare(`
      SELECT u.id AS tech_id, u.name AS tech_name, u.role AS tech_role,
             SUM(x.amount) AS total, COUNT(x.id) AS count
      FROM corp_card_expenses x
      LEFT JOIN users u ON u.id = x.on_behalf_of_user_id
      WHERE x.expense_date BETWEEN ? AND ?
      GROUP BY x.on_behalf_of_user_id
      ORDER BY total DESC
    `).all(from, to);

    const byMonth = db.prepare(`
      SELECT substr(expense_date, 1, 7) AS month,
             SUM(amount) AS total, COUNT(*) AS count
      FROM corp_card_expenses
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `).all();

    res.json({
      period: { from, to, label: `${from} → ${to}` },
      totals: {
        all_time:        +allTime.total.toFixed(2),
        all_time_count:  allTime.n,
        in_period:       +inPeriod.total.toFixed(2),
        count_in_period: inPeriod.n,
        mtd:             +mtd.total.toFixed(2),
        ytd:             +ytd.total.toFixed(2),
      },
      by_category: byCat.map(r => ({ ...r, total: +r.total.toFixed(2) })),
      by_tech:     byTech.map(r => ({ ...r, total: +r.total.toFixed(2), tech_name: r.tech_name || '(no tech assigned)' })),
      by_month:    byMonth.map(r => ({ ...r, total: +r.total.toFixed(2) })),
    });
  });

  return router;
};

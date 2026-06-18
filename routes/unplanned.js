// routes/unplanned.js — v0.63.1
// Unplanned / wasted-labour tagging and leadership summary dashboard.
//
// Tags are stored as a JSON array so one item can carry multiple reasons:
//   ["wasted_labour", "ad_hoc"]
//
// Allowed tag values:
//   • wasted_labour  — rework, preventable re-visits, duplicate effort
//   • ad_hoc         — reactive / unscheduled work not in the plan
//   • unexpected     — unforeseen circumstances (equipment failure, etc.)
//
// A null / empty array means the item is untagged (planned).

'use strict';
const express = require('express');
const router  = express.Router();
const { logAudit } = require('../db');

const VALID_TAGS   = ['wasted_labour', 'ad_hoc', 'unexpected'];
const VALID_TABLES = {
  work_order:        { table: 'work_orders',        idCol: 'id' },
  time_entry:        { table: 'time_entries',        idCol: 'id' },
  expense:           { table: 'expenses',            idCol: 'id' },
  corp_card_expense: { table: 'corp_card_expenses',  idCol: 'id' },
};

// Parse stored JSON-array tag value → string[]. Handles legacy single strings too.
function parseTags(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter(t => VALID_TAGS.includes(t));
  } catch (_) {}
  // Legacy single-string value
  return VALID_TAGS.includes(raw) ? [raw] : [];
}

module.exports = (db) => {

  // ── Tag or un-tag a line item ──────────────────────────────────────────────
  // PATCH /api/unplanned/tag
  // Body: { entity_type, entity_id, tags: string[] (empty/null to clear), note }
  router.patch('/unplanned/tag', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'auth required' });

    const me = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (!me || !['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'ops_manager role required' });
    }

    const { entity_type, entity_id, tags, note, wasted } = req.body;

    if (!VALID_TABLES[entity_type]) {
      return res.status(400).json({ error: `entity_type must be one of: ${Object.keys(VALID_TABLES).join(', ')}` });
    }

    // Normalise: accept array or single string or null/empty
    let tagArray = [];
    if (Array.isArray(tags)) {
      tagArray = tags.filter(t => VALID_TAGS.includes(t));
    } else if (tags && VALID_TAGS.includes(tags)) {
      tagArray = [tags];
    }

    const invalidTags = (Array.isArray(tags) ? tags : []).filter(t => !VALID_TAGS.includes(t));
    if (invalidTags.length) {
      return res.status(400).json({ error: `invalid tag values: ${invalidTags.join(', ')}. Allowed: ${VALID_TAGS.join(', ')}` });
    }

    const { table } = VALID_TABLES[entity_type];
    const tagVal    = tagArray.length ? JSON.stringify(tagArray) : null;
    const noteVal   = note || null;
    const now       = new Date().toISOString();

    // v0.64.4 — optional "wasted portion" ($). Only meaningful when tagged.
    // NULL means "the whole item is wasted" (back-compat with earlier tags).
    let wastedVal = null;
    if (tagVal && wasted != null && wasted !== '') {
      const w = Number(wasted);
      if (!isFinite(w) || w < 0) return res.status(400).json({ error: 'wasted must be a non-negative number' });
      wastedVal = +w.toFixed(2);
    }

    const result = db.prepare(`
      UPDATE ${table}
         SET unplanned_tag       = ?,
             unplanned_note      = ?,
             unplanned_wasted    = ?,
             unplanned_tagged_by = ?,
             unplanned_tagged_at = ?
       WHERE id = ?
    `).run(tagVal, noteVal, wastedVal, tagVal ? userId : null, tagVal ? now : null, entity_id);

    if (result.changes === 0) {
      return res.status(404).json({ error: `${entity_type} ${entity_id} not found` });
    }

    logAudit(db, {
      entity_type, entity_id, user_id: userId,
      action: tagVal ? 'unplanned_tagged' : 'unplanned_cleared',
      details: { tags: tagArray, note: noteVal, wasted: wastedVal },
    });

    res.json({ ok: true, entity_type, entity_id, tags: tagArray, note: noteVal, wasted: wastedVal });
  });

  // ── Leadership summary ─────────────────────────────────────────────────────
  // GET /api/unplanned/summary?period=last_30|last_90|ytd|all
  router.get('/unplanned/summary', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'auth required' });
    const me = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (!me || !['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }

    const period = String(req.query.period || 'last_90');
    const dateFloor = periodFloor(period);
    const pSql = dateFloor ? `AND {TA}.unplanned_tagged_at >= '${dateFloor}'` : '';

    // Helper: expand rows by their tag array so by_tag counts work correctly
    // (an item tagged ["wasted_labour","ad_hoc"] contributes to both buckets)
    function fanOut(rows, costKey) {
      const out = {};
      for (const tag of VALID_TAGS) out[tag] = [];
      for (const r of rows) {
        const tags = parseTags(r.unplanned_tag);
        for (const tag of tags) out[tag].push(r);
      }
      return out;
    }

    // ── 1. Unplanned labor (time_entries) ─────────────────────────────────
    const laborRows = db.prepare(`
      SELECT
        te.unplanned_tag,
        te.unplanned_note                                  AS note,
        te.unplanned_tagged_by                             AS tagged_by,
        u_tag.name                                         AS tagged_by_name,
        u_tech.name                                        AS tech_name,
        te.clock_in, te.clock_out, te.break_minutes,
        te.unplanned_wasted                                AS wasted_raw,
        COALESCE(u_tech.hourly_rate, 40.0)                 AS hourly_rate,
        te.id                                              AS te_id,
        wo.id                                              AS wo_id,
        wo.external_id                                     AS wo_external_id,
        wo.title                                           AS wo_title,
        wo.work_type, wo.store_name
      FROM time_entries te
      JOIN work_orders  wo      ON wo.id     = te.work_order_id
      JOIN users        u_tech  ON u_tech.id = te.user_id
      LEFT JOIN users   u_tag   ON u_tag.id  = te.unplanned_tagged_by
      WHERE te.unplanned_tag IS NOT NULL
        ${pSql.replace('{TA}', 'te')}
      ORDER BY te.unplanned_tagged_at DESC
    `).all();

    const laborDetail = laborRows.map(r => {
      const inMs  = new Date(r.clock_in).getTime();
      const outMs = r.clock_out ? new Date(r.clock_out).getTime() : Date.now();
      const hrs   = Math.max(0, (outMs - inMs - (r.break_minutes || 0) * 60000) / 3600000);
      const originalCost = hrs * r.hourly_rate;
      // Wasted portion ($). NULL → the whole entry is wasted. Clamp to original.
      const wastedCost = (r.wasted_raw != null) ? Math.min(+r.wasted_raw, originalCost) : 0;
      const wastedHrs  = r.hourly_rate > 0 ? wastedCost / r.hourly_rate : 0;
      return { ...r, tags: parseTags(r.unplanned_tag),
        hours: +wastedHrs.toFixed(2),  cost: +wastedCost.toFixed(2),   // wasted slice (the extra cost)
        original_hours: +hrs.toFixed(2), original_cost: +originalCost.toFixed(2),
        actual_cost: +(originalCost - wastedCost).toFixed(2) };
    });

    // ── 2. Unplanned tech expenses ────────────────────────────────────────
    const expRows = db.prepare(`
      SELECT
        e.unplanned_tag,
        e.unplanned_note                                   AS note,
        e.amount, e.category, e.subcategory, e.expense_date,
        e.unplanned_wasted                                 AS wasted_raw,
        e.id                                               AS exp_id,
        wo.id                                              AS wo_id,
        wo.external_id                                     AS wo_external_id,
        wo.title                                           AS wo_title,
        wo.work_type, wo.store_name,
        u_tag.name                                         AS tagged_by_name
      FROM expenses e
      JOIN work_orders wo ON wo.id = e.work_order_id
      LEFT JOIN users  u_tag ON u_tag.id = e.unplanned_tagged_by
      WHERE e.unplanned_tag IS NOT NULL
        ${pSql.replace('{TA}', 'e')}
      ORDER BY e.unplanned_tagged_at DESC
    `).all().map(r => {
      const wasted = (r.wasted_raw != null) ? Math.min(+r.wasted_raw, r.amount) : 0;
      return { ...r, tags: parseTags(r.unplanned_tag),
        original: +(+r.amount).toFixed(2), wasted: +wasted.toFixed(2), actual: +(r.amount - wasted).toFixed(2) };
    });

    // ── 3. Unplanned corp-card expenses ───────────────────────────────────
    const ccRows = db.prepare(`
      SELECT
        cc.unplanned_tag,
        cc.unplanned_note                                  AS note,
        cc.amount, cc.expense_date,
        cc.unplanned_wasted                                AS wasted_raw,
        ccc.name                                           AS category,
        cc.id                                              AS cc_id,
        wo.id                                              AS wo_id,
        wo.external_id                                     AS wo_external_id,
        wo.title                                           AS wo_title,
        COALESCE(cc.store_name, wo.store_name)             AS store_name,
        wo.work_type,
        u_tag.name                                         AS tagged_by_name
      FROM corp_card_expenses cc
      LEFT JOIN work_orders          wo  ON wo.id  = cc.work_order_id
      LEFT JOIN corp_card_categories ccc ON ccc.id = cc.category_id
      LEFT JOIN users                u_tag ON u_tag.id = cc.unplanned_tagged_by
      WHERE cc.unplanned_tag IS NOT NULL
        ${pSql.replace('{TA}', 'cc')}
      ORDER BY cc.unplanned_tagged_at DESC
    `).all().map(r => {
      const wasted = (r.wasted_raw != null) ? Math.min(+r.wasted_raw, r.amount) : 0;
      return { ...r, tags: parseTags(r.unplanned_tag),
        original: +(+r.amount).toFixed(2), wasted: +wasted.toFixed(2), actual: +(r.amount - wasted).toFixed(2) };
    });

    // ── 4. Unplanned WO-level tags ────────────────────────────────────────
    const woRows = db.prepare(`
      SELECT
        wo.id, wo.external_id, wo.title, wo.work_type, wo.store_name,
        wo.unplanned_tag, wo.unplanned_note AS note,
        wo.unplanned_tagged_at              AS tagged_at,
        u_tag.name                          AS tagged_by_name,
        cto.actual_labor, cto.third_party_cost
      FROM work_orders wo
      LEFT JOIN cost_tracker_overrides cto ON cto.work_order_id = wo.id
      LEFT JOIN users u_tag ON u_tag.id = wo.unplanned_tagged_by
      WHERE wo.unplanned_tag IS NOT NULL
        ${pSql.replace('{TA}', 'wo')}
      ORDER BY wo.unplanned_tagged_at DESC
    `).all().map(r => ({ ...r, tags: parseTags(r.unplanned_tag) }));

    // ── 5. Aggregate totals (cost = the WASTED slice; originals tracked too) ─
    const totalLaborHours = laborDetail.reduce((s, r) => s + r.hours, 0);   // wasted hrs
    const totalLaborCost  = laborDetail.reduce((s, r) => s + r.cost,  0);   // wasted $
    const totalExpCost    = expRows.reduce((s, r) => s + r.wasted,    0);
    const totalCCCost     = ccRows.reduce((s, r) => s + r.wasted,     0);
    const totalOriginal   = laborDetail.reduce((s, r) => s + r.original_cost, 0)
                          + expRows.reduce((s, r) => s + r.original, 0)
                          + ccRows.reduce((s, r) => s + r.original, 0);
    const totalActual     = totalOriginal - (totalLaborCost + totalExpCost + totalCCCost);

    // by_tag: fan-out so multi-tagged items count in each bucket
    const byTag = {};
    for (const tag of VALID_TAGS) {
      const lr = laborDetail.filter(r => r.tags.includes(tag));
      const er = expRows.filter(r => r.tags.includes(tag));
      const cr = ccRows.filter(r => r.tags.includes(tag));
      const wr = woRows.filter(r => r.tags.includes(tag));
      byTag[tag] = {
        labor_hours:  +lr.reduce((s, r) => s + r.hours,  0).toFixed(2),
        labor_cost:   +lr.reduce((s, r) => s + r.cost,   0).toFixed(2),
        expense_cost: +er.reduce((s, r) => s + r.wasted, 0).toFixed(2),
        cc_cost:      +cr.reduce((s, r) => s + r.wasted, 0).toFixed(2),
        wo_count: wr.length,
      };
    }

    // by_work_type: each row contributes once (not fan-out; work_type is singular)
    const allRows = [
      ...laborDetail.map(r => ({ ...r, cost: r.cost, kind: 'labor' })),
      ...expRows.map(r => ({ ...r, cost: r.wasted, kind: 'expense' })),
      ...ccRows.map(r => ({ ...r, cost: r.wasted, kind: 'cc' })),
    ];
    const byWorkType = {};
    for (const r of allRows) {
      const k = r.work_type || 'unknown';
      if (!byWorkType[k]) byWorkType[k] = { labor_hours: 0, total_cost: 0, count: 0 };
      byWorkType[k].total_cost += r.cost;
      byWorkType[k].count++;
      if (r.kind === 'labor') byWorkType[k].labor_hours += r.hours || 0;
    }
    for (const k of Object.keys(byWorkType)) {
      byWorkType[k].labor_hours = +byWorkType[k].labor_hours.toFixed(2);
      byWorkType[k].total_cost  = +byWorkType[k].total_cost.toFixed(2);
    }

    // by_store
    const byStore = {};
    for (const r of allRows) {
      const k = r.store_name || 'Unknown';
      if (!byStore[k]) byStore[k] = { total_cost: 0, count: 0 };
      byStore[k].total_cost += r.cost;
      byStore[k].count++;
    }
    for (const k of Object.keys(byStore)) byStore[k].total_cost = +byStore[k].total_cost.toFixed(2);

    // weekly trend (each item counts once)
    const weekMap = {};
    for (const r of allRows) {
      const tagged = r.unplanned_tagged_at || r.expense_date || r.clock_in;
      if (!tagged) continue;
      const d = new Date(tagged);
      const week = `${d.getFullYear()}-W${String(Math.ceil((d - new Date(d.getFullYear(), 0, 1)) / 604800000)).padStart(2,'0')}`;
      if (!weekMap[week]) weekMap[week] = 0;
      weekMap[week] += r.cost;
    }
    const weeklyTrend = Object.entries(weekMap)
      .sort(([a],[b]) => a < b ? -1 : 1)
      .slice(-12)
      .map(([week, cost]) => ({ week, cost: +cost.toFixed(2) }));

    // ── Helper: total (planned + unplanned) labor cost for a set of rows ─────
    const hoursOf = (t) => Math.max(0,
      (new Date(t.clock_out) - new Date(t.clock_in) - (t.break_minutes || 0) * 60000) / 3600000);

    // ── by_work_type: add org-wide TOTAL cost per type so the UI can show the
    //    full deployment/service/… cost vs the unplanned slice. ───────────────
    const totalByWT = {};
    for (const t of db.prepare(`
        SELECT wo.work_type AS wt, te.clock_in, te.clock_out, te.break_minutes,
               COALESCE(u.hourly_rate, 40.0) AS rate
        FROM time_entries te JOIN work_orders wo ON wo.id = te.work_order_id
        JOIN users u ON u.id = te.user_id
        WHERE (te.mode IS NULL OR te.mode = 'work') AND te.clock_out IS NOT NULL`).all()) {
      const k = t.wt || 'unknown';
      totalByWT[k] = (totalByWT[k] || 0) + hoursOf(t) * t.rate;
    }
    for (const r of db.prepare(`SELECT wo.work_type AS wt, COALESCE(SUM(e.amount),0) AS amt
        FROM expenses e JOIN work_orders wo ON wo.id = e.work_order_id
        WHERE e.category NOT IN ('labor','drive') GROUP BY wo.work_type`).all()) {
      totalByWT[r.wt || 'unknown'] = (totalByWT[r.wt || 'unknown'] || 0) + r.amt;
    }
    for (const r of db.prepare(`SELECT wo.work_type AS wt, COALESCE(SUM(cc.amount),0) AS amt
        FROM corp_card_expenses cc JOIN work_orders wo ON wo.id = cc.work_order_id GROUP BY wo.work_type`).all()) {
      totalByWT[r.wt || 'unknown'] = (totalByWT[r.wt || 'unknown'] || 0) + r.amt;
    }
    for (const k of Object.keys(byWorkType)) {
      byWorkType[k].unplanned_cost = byWorkType[k].total_cost;        // alias: the tagged slice
      byWorkType[k].total_all_cost = +(totalByWT[k] || 0).toFixed(2); // full cost for the type
      byWorkType[k].unplanned_pct  = byWorkType[k].total_all_cost > 0
        ? +(byWorkType[k].unplanned_cost / byWorkType[k].total_all_cost * 100).toFixed(1) : 0;
    }

    // ── by_work_order: per-WO unplanned cost vs the WO's TOTAL cost ──────────
    const woIdSet = new Set();
    for (const r of laborDetail) if (r.wo_id) woIdSet.add(r.wo_id);
    for (const r of expRows)     if (r.wo_id) woIdSet.add(r.wo_id);
    for (const r of ccRows)      if (r.wo_id) woIdSet.add(r.wo_id);
    for (const r of woRows)      if (r.id)    woIdSet.add(r.id);
    const byWorkOrder = [];
    if (woIdSet.size) {
      const ids = [...woIdSet];
      const ph  = ids.map(() => '?').join(',');
      const meta = {};
      for (const w of db.prepare(`SELECT id, external_id, title, work_type, store_name FROM work_orders WHERE id IN (${ph})`).all(...ids)) meta[w.id] = w;
      const totalLabor = {};
      for (const t of db.prepare(`SELECT te.work_order_id AS wo, te.clock_in, te.clock_out, te.break_minutes, COALESCE(u.hourly_rate,40.0) AS rate
          FROM time_entries te JOIN users u ON u.id = te.user_id
          WHERE te.work_order_id IN (${ph}) AND (te.mode IS NULL OR te.mode='work') AND te.clock_out IS NOT NULL`).all(...ids)) {
        totalLabor[t.wo] = (totalLabor[t.wo] || 0) + hoursOf(t) * t.rate;
      }
      const totalExp = {};
      for (const r of db.prepare(`SELECT work_order_id AS wo, COALESCE(SUM(amount),0) AS amt FROM expenses WHERE work_order_id IN (${ph}) AND category NOT IN ('labor','drive') GROUP BY work_order_id`).all(...ids)) totalExp[r.wo] = r.amt;
      const totalCc = {};
      for (const r of db.prepare(`SELECT work_order_id AS wo, COALESCE(SUM(amount),0) AS amt FROM corp_card_expenses WHERE work_order_id IN (${ph}) GROUP BY work_order_id`).all(...ids)) totalCc[r.wo] = r.amt;

      const unp = {}, cnt = {}, dt = {};
      const bump = (wo, c) => { if (wo) unp[wo] = (unp[wo] || 0) + (c || 0); };
      const seen = (wo, d) => { if (wo && d) dt[wo] = (!dt[wo] || String(d) < dt[wo]) ? String(d) : dt[wo]; };
      for (const r of laborDetail) { bump(r.wo_id, r.cost); if (r.wo_id) cnt[r.wo_id] = (cnt[r.wo_id]||0)+1; seen(r.wo_id, r.clock_in); }
      for (const r of expRows) { if (r.category !== 'labor' && r.category !== 'drive') bump(r.wo_id, r.wasted); if (r.wo_id) cnt[r.wo_id] = (cnt[r.wo_id]||0)+1; seen(r.wo_id, r.expense_date); }
      for (const r of ccRows) { bump(r.wo_id, r.wasted); if (r.wo_id) cnt[r.wo_id] = (cnt[r.wo_id]||0)+1; seen(r.wo_id, r.expense_date); }
      for (const r of woRows) seen(r.id, r.tagged_at);

      for (const id of ids) {
        const m = meta[id] || {};
        const total = (totalLabor[id]||0) + (totalExp[id]||0) + (totalCc[id]||0);
        const unplanned = unp[id] || 0;
        byWorkOrder.push({
          wo_id: id,
          external_id: m.external_id || ('WO #' + id),
          title: m.title || '',
          work_type: m.work_type || 'unknown',
          store_name: m.store_name || '',
          date: dt[id] || null,
          total_cost: +total.toFixed(2),
          unplanned_cost: +unplanned.toFixed(2),
          unplanned_pct: total > 0 ? +(unplanned / total * 100).toFixed(1) : 0,
          unplanned_count: cnt[id] || 0,
        });
      }
      // Earliest → latest by the date of the first unplanned activity on the WO.
      byWorkOrder.sort((a, b) => String(a.date || '9999-12-31').localeCompare(String(b.date || '9999-12-31')));
    }

    res.json({
      period,
      summary: {
        total_labor_hours:  +totalLaborHours.toFixed(2),
        total_labor_cost:   +totalLaborCost.toFixed(2),
        total_expense_cost: +totalExpCost.toFixed(2),
        total_cc_cost:      +totalCCCost.toFixed(2),
        total_cost:         +(totalLaborCost + totalExpCost + totalCCCost).toFixed(2),
        total_original_cost: +totalOriginal.toFixed(2),
        total_actual_cost:   +totalActual.toFixed(2),
        tagged_wo_count:    woRows.length,
        tagged_te_count:    laborRows.length,
        tagged_exp_count:   expRows.length,
        tagged_cc_count:    ccRows.length,
      },
      by_tag:        byTag,
      by_work_type:  byWorkType,
      by_work_order: byWorkOrder,
      by_store:      byStore,
      weekly_trend:  weeklyTrend,
      detail: {
        work_orders:        woRows,
        time_entries:       laborDetail,
        expenses:           expRows,
        corp_card_expenses: ccRows,
      },
    });
  });

  // ── List all tagged items ──────────────────────────────────────────────────
  // GET /api/unplanned/items?tag=wasted_labour|ad_hoc|unexpected
  router.get('/unplanned/items', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'auth required' });
    const me = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (!me || !['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }

    // With JSON arrays we filter in JS after fetching all tagged rows
    const tagFilter = req.query.tag;

    const filterByTag = rows => tagFilter
      ? rows.filter(r => parseTags(r.unplanned_tag || r.tag).includes(tagFilter))
      : rows;

    const wos = filterByTag(db.prepare(`
      SELECT wo.id, wo.external_id, wo.title, wo.work_type, wo.store_name,
             wo.unplanned_tag AS tag, wo.unplanned_note AS note, wo.unplanned_tagged_at AS tagged_at,
             u.name AS tagged_by_name
      FROM work_orders wo
      LEFT JOIN users u ON u.id = wo.unplanned_tagged_by
      WHERE wo.unplanned_tag IS NOT NULL
      ORDER BY wo.unplanned_tagged_at DESC LIMIT 500
    `).all()).map(r => ({ ...r, tags: parseTags(r.tag) }));

    const tes = filterByTag(db.prepare(`
      SELECT te.id, te.clock_in, te.clock_out, te.break_minutes,
             te.unplanned_tag AS tag, te.unplanned_note AS note, te.unplanned_tagged_at AS tagged_at,
             wo.external_id AS wo_external_id, wo.title AS wo_title, wo.work_type, wo.store_name,
             u_tech.name AS tech_name, u_tag.name AS tagged_by_name
      FROM time_entries te
      JOIN work_orders wo ON wo.id = te.work_order_id
      JOIN users u_tech ON u_tech.id = te.user_id
      LEFT JOIN users u_tag ON u_tag.id = te.unplanned_tagged_by
      WHERE te.unplanned_tag IS NOT NULL
      ORDER BY te.unplanned_tagged_at DESC LIMIT 500
    `).all()).map(r => ({ ...r, tags: parseTags(r.tag) }));

    const exps = filterByTag(db.prepare(`
      SELECT e.id, e.category, e.subcategory, e.amount, e.expense_date,
             e.unplanned_tag AS tag, e.unplanned_note AS note, e.unplanned_tagged_at AS tagged_at,
             wo.external_id AS wo_external_id, wo.title AS wo_title, wo.work_type, wo.store_name,
             u_tag.name AS tagged_by_name
      FROM expenses e
      JOIN work_orders wo ON wo.id = e.work_order_id
      LEFT JOIN users u_tag ON u_tag.id = e.unplanned_tagged_by
      WHERE e.unplanned_tag IS NOT NULL
      ORDER BY e.unplanned_tagged_at DESC LIMIT 500
    `).all()).map(r => ({ ...r, tags: parseTags(r.tag) }));

    const ccs = filterByTag(db.prepare(`
      SELECT cc.id, ccc.name AS category, cc.amount, cc.expense_date,
             cc.unplanned_tag AS tag, cc.unplanned_note AS note, cc.unplanned_tagged_at AS tagged_at,
             COALESCE(cc.store_name, wo.store_name) AS store_name,
             wo.work_type, wo.external_id AS wo_external_id, wo.title AS wo_title,
             u_tag.name AS tagged_by_name
      FROM corp_card_expenses cc
      LEFT JOIN corp_card_categories ccc ON ccc.id = cc.category_id
      LEFT JOIN work_orders wo ON wo.id = cc.work_order_id
      LEFT JOIN users u_tag ON u_tag.id = cc.unplanned_tagged_by
      WHERE cc.unplanned_tag IS NOT NULL
      ORDER BY cc.unplanned_tagged_at DESC LIMIT 500
    `).all()).map(r => ({ ...r, tags: parseTags(r.tag) }));

    res.json({ work_orders: wos, time_entries: tes, expenses: exps, corp_card_expenses: ccs });
  });

  return router;
};

// ── helpers ───────────────────────────────────────────────────────────────────
function periodFloor(p) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (p) {
    case 'last_30': return new Date(now - 30*86400e3).toISOString().slice(0,10);
    case 'last_90': return new Date(now - 90*86400e3).toISOString().slice(0,10);
    case 'ytd':     return `${y}-01-01`;
    case 'mtd':     return `${y}-${String(m+1).padStart(2,'0')}-01`;
    default:        return null;
  }
}

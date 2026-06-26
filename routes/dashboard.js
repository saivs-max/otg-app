// Ops Manager dashboard endpoint.
//
// GET /api/dashboard?period=mtd|last_30|last_90|qtd|ytd|all
//
// Returns a single payload with:
//   - summary    — KPI tiles (spend, count, avg, queue, forecasts)
//   - by_tech    — spend / hrs / avg per tech, sorted by spend
//   - by_work_type — spend by work_type, with $ / cart and $ / hour
//   - by_store     — spend by store, with avg per visit
//   - by_cart_bucket — spend bucketed by WO cart count (1-5, 6-10, 11-20, 21+)
//   - weekly_trend — last 12 weeks of spend, with a 4-week linear projection
//   - forecast     — bottoms-up: open/in_progress WO carts × historical $/cart
//   - top_invoices — top 10 by amount (within scope/period)
//   - aging        — items in queue >3 days (submitted but not approved_ops)
//
// Scope is automatic: ops_manager → invoices for their team only,
// sr_manager / pm → all invoices.
const express = require('express');
const router  = express.Router();
const XLSX    = require('xlsx');
const gsheets = require('../lib/google_sheets');
const { activeWorkTypes } = require('../db');

module.exports = (db) => {

  // Shared payload builder used by both /dashboard (JSON) and /dashboard/export (XLSX).
  // Returns { ok: true, payload } on success, or { ok: false, status, error } on failure.
  function buildDashboardPayload(req) {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) : null;
    if (!me) return { ok: false, status: 401, error: 'no user selected' };
    if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
      return { ok: false, status: 403, error: 'manager role required' };
    }

    // v0.32 — every manager role sees the whole org on the dashboard. Team
    // membership only constrains the approval queue (so each Ops Mgr only
    // sees invoices that need their stamp). Keeping `scopeIds = null` means
    // no user-level WHERE clause is added, the same as sr_mgr/pm get.
    const scopeIds = null;

    // ---- Period: convert to a SQL date floor ----
    const period = String(req.query.period || 'last_90');
    const periodStart = periodStartDate(period);
    const periodLabel = periodHumanLabel(period);

    // ---- Optional filters (tech, store) ----
    const techFilter = req.query.tech ? Number(req.query.tech) : null;
    if (techFilter && scopeIds && !scopeIds.includes(techFilter)) {
      return { ok: false, status: 403, error: 'tech is not in your scope' };
    }
    const storeFilter = (req.query.store || '').trim() || null;
    const wtFilter    = (req.query.work_type || '').trim() || null;
    if (wtFilter) {
      const validTypes = activeWorkTypes(db);
      if (!validTypes.has(wtFilter)) {
        return { ok: false, status: 400, error: `work_type must be one of ${[...validTypes].join(' / ')}` };
      }
    }

    // ---- Build SQL helpers for scope + period + filters ----
    // `scopeSql` constrains by manager team (or filter to a specific tech).
    const effectiveTechIds = techFilter ? [techFilter] : scopeIds;
    const scopeSql  = effectiveTechIds ? `AND i.user_id IN (${effectiveTechIds.map(() => '?').join(',')})` : '';
    const params    = effectiveTechIds ? [...effectiveTechIds] : [];
    const periodSql = periodStart ? `AND i.period_start >= ?` : '';
    if (periodStart) params.push(periodStart);
    // The store filter joins through work_orders, so we can only apply it on
    // the WO-keyed aggregates (by_work_type, by_store, by_cart_bucket, etc.).
    // Summary-level totals stay un-filtered by store so the KPI tiles reflect
    // the full team's spend regardless of store selection — that's typical
    // dashboard behavior.

    // For "billable" stats we exclude pure drafts (they're work in progress and
    // have not been validated). Counted statuses match real spend.
    const BILLABLE_STATUSES = "('submitted','approved_ops','approved_sr','queued_ap','sent_ap')";
    // v0.36 — labor-only filter so the dashboard's tech-labor totals don't
    // double-count 3rd-party vendor spend (which has its own KPI tile).
    const LABOR_TYPE_SQL = "AND (i.invoice_type IS NULL OR i.invoice_type = 'tech_labor')";

    // Store + work_type filter SQL fragments applied to WO-joined aggregations.
    const storeFilterSql = storeFilter ? `AND w.store_name = ?` : '';
    const wtFilterSql    = wtFilter    ? `AND w.work_type  = ?` : '';
    const storeParam     = [...(storeFilter ? [storeFilter] : []), ...(wtFilter ? [wtFilter] : [])];
    const woFilterSql    = `${storeFilterSql} ${wtFilterSql}`;
    // Whether any WO-side filter is active (forces summary-level numbers to
    // be recomputed via the WO-spend join so they match the chart totals).
    const hasWoFilter    = !!(storeFilter || wtFilter);

    // ---- KPI summary ----
    // When a WO-side filter (store / work_type) is in play, recompute totals
    // via WO join so the numbers reflect that slice of spend.
    let sumRow;
    if (hasWoFilter) {
      sumRow = db.prepare(`
        SELECT COUNT(DISTINCT i.id) AS n,
               COALESCE(SUM(spend.amount),0) AS sum_total,
               COALESCE(SUM(spend.amount),0) / NULLIF(COUNT(DISTINCT i.id), 0) AS avg_total
        FROM invoices i
        JOIN (
          SELECT t.invoice_id AS iid, t.work_order_id AS wo_id,
                 (julianday(t.clock_out)-julianday(t.clock_in))*24 *
                   COALESCE((SELECT u.hourly_rate FROM users u WHERE u.id = t.user_id), 40) AS amount
          FROM time_entries t
          WHERE t.clock_out IS NOT NULL AND (t.mode IS NULL OR t.mode = 'work')
          UNION ALL
          SELECT e.invoice_id AS iid, e.work_order_id AS wo_id, e.amount
          FROM expenses e
        ) spend ON spend.iid = i.id
        JOIN work_orders w ON w.id = spend.wo_id
        WHERE i.status IN ${BILLABLE_STATUSES} ${scopeSql} ${periodSql} ${woFilterSql}
      `).get(...params, ...storeParam);
      sumRow.avg_total = sumRow.avg_total || 0;
    } else {
      sumRow = db.prepare(`
        SELECT COUNT(*) AS n, COALESCE(SUM(i.total),0) AS sum_total,
               COALESCE(AVG(i.total),0) AS avg_total
        FROM invoices i
        WHERE i.status IN ${BILLABLE_STATUSES} ${scopeSql} ${periodSql} ${LABOR_TYPE_SQL}
      `).get(...params);
    }

    // pending/draft tiles always reflect the team-or-tech scope but stay
    // store-agnostic. Tech-labor only — vendor pending tracked separately.
    const noStoreParams = effectiveTechIds ? [...effectiveTechIds] : [];
    const pendingRow = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(i.total),0) AS sum_total,
             COALESCE(AVG(julianday('now') - julianday(i.submitted_at)), 0) AS avg_age
      FROM invoices i
      WHERE i.status IN ('submitted','approved_ops') ${scopeSql} ${LABOR_TYPE_SQL}
    `).get(...noStoreParams);

    const draftRow = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(i.total),0) AS sum_total
      FROM invoices i
      WHERE i.status = 'draft' ${scopeSql} ${LABOR_TYPE_SQL}
    `).get(...noStoreParams);

    // ---- By technician ----
    // When a WO-side filter (store/work_type) is set, route through WO spend
    // so the per-tech total reflects only that slice.
    let byTech;
    if (hasWoFilter) {
      // Build WHERE-clause additions for any active WO filter, paired with
      // OR-IS-NULL to keep zero-spend techs visible in the result set.
      const woWhere = [];
      const woParams = [];
      if (storeFilter) { woWhere.push('(w.store_name = ? OR w.id IS NULL)'); woParams.push(storeFilter); }
      if (wtFilter)    { woWhere.push('(w.work_type  = ? OR w.id IS NULL)'); woParams.push(wtFilter); }
      byTech = db.prepare(`
        SELECT u.id AS user_id, u.name, u.worker_type,
               COUNT(DISTINCT i.id) AS invoice_count,
               COALESCE(SUM(spend.amount),0) AS total,
               COALESCE(SUM(spend.amount),0) / NULLIF(COUNT(DISTINCT i.id), 0) AS avg_per_invoice
        FROM users u
        LEFT JOIN invoices i ON i.user_id = u.id AND i.status IN ${BILLABLE_STATUSES} ${periodSql}
        LEFT JOIN (
          SELECT t.invoice_id AS iid, t.work_order_id AS wo_id,
                 (julianday(t.clock_out)-julianday(t.clock_in))*24 *
                   COALESCE((SELECT u2.hourly_rate FROM users u2 WHERE u2.id = t.user_id), 40) AS amount
          FROM time_entries t
          WHERE t.clock_out IS NOT NULL AND (t.mode IS NULL OR t.mode = 'work')
          UNION ALL
          SELECT e.invoice_id AS iid, e.work_order_id AS wo_id, e.amount
          FROM expenses e
        ) spend ON spend.iid = i.id
        LEFT JOIN work_orders w ON w.id = spend.wo_id
        WHERE u.role = 'technician'
          ${effectiveTechIds ? `AND u.id IN (${effectiveTechIds.map(() => '?').join(',')})` : ''}
          ${woWhere.length ? 'AND ' + woWhere.join(' AND ') : ''}
        GROUP BY u.id, u.name, u.worker_type
        ORDER BY total DESC
      `).all(...(periodStart ? [periodStart] : []), ...(effectiveTechIds || []), ...woParams);
    } else {
      byTech = db.prepare(`
        SELECT u.id AS user_id, u.name, u.worker_type,
               COUNT(i.id) AS invoice_count,
               COALESCE(SUM(i.total),0) AS total,
               COALESCE(AVG(i.total),0) AS avg_per_invoice
        FROM users u LEFT JOIN invoices i
          ON i.user_id = u.id AND i.status IN ${BILLABLE_STATUSES} ${periodSql} ${LABOR_TYPE_SQL}
        WHERE u.role = 'technician'
          ${effectiveTechIds ? `AND u.id IN (${effectiveTechIds.map(() => '?').join(',')})` : ''}
        GROUP BY u.id, u.name, u.worker_type
        ORDER BY total DESC
      `).all(...(periodStart ? [periodStart] : []), ...(effectiveTechIds || []));
    }

    // ---- By work type (joined through line items) ----
    // Compute spend per WO line then aggregate. We approximate "work_type spend"
    // as labor + linked expenses on time/expense rows belonging to the WO.
    const byWorkType = db.prepare(`
      SELECT w.work_type,
             COUNT(DISTINCT w.id) AS wo_count,
             COALESCE(SUM(spend.amount),0) AS total,
             COALESCE(SUM(w.cart_count),0) AS total_carts
      FROM work_orders w
      JOIN (
        SELECT t.work_order_id AS wo_id,
               (julianday(t.clock_out)-julianday(t.clock_in))*24 *
                 COALESCE((SELECT u.hourly_rate FROM users u WHERE u.id = t.user_id), 40) AS amount
        FROM time_entries t
        JOIN invoices i ON i.id = t.invoice_id
        WHERE t.clock_out IS NOT NULL AND (t.mode IS NULL OR t.mode = 'work')
          AND i.status IN ${BILLABLE_STATUSES} ${scopeSql} ${periodSql}
        UNION ALL
        SELECT e.work_order_id AS wo_id, e.amount
        FROM expenses e
        JOIN invoices i ON i.id = e.invoice_id
        WHERE i.status IN ${BILLABLE_STATUSES} ${scopeSql} ${periodSql}
      ) spend ON spend.wo_id = w.id
      WHERE 1=1 ${woFilterSql}
      GROUP BY w.work_type
      ORDER BY total DESC
    `).all(...params, ...params, ...storeParam);

    // Compute $ per cart per work_type (used by the forecast)
    const ratePerCart = {};
    for (const r of byWorkType) {
      ratePerCart[r.work_type] = r.total_carts > 0 ? r.total / r.total_carts : 0;
      r.dollars_per_cart = +(ratePerCart[r.work_type]).toFixed(2);
    }

    // ---- By store ----
    const byStore = db.prepare(`
      SELECT w.store_name,
             COUNT(DISTINCT w.id) AS wo_count,
             COALESCE(SUM(spend.amount),0) AS total
      FROM work_orders w
      JOIN (
        SELECT t.work_order_id AS wo_id,
               (julianday(t.clock_out)-julianday(t.clock_in))*24 *
                 COALESCE((SELECT u.hourly_rate FROM users u WHERE u.id = t.user_id), 40) AS amount
        FROM time_entries t
        JOIN invoices i ON i.id = t.invoice_id
        WHERE t.clock_out IS NOT NULL AND (t.mode IS NULL OR t.mode = 'work')
          AND i.status IN ${BILLABLE_STATUSES} ${scopeSql} ${periodSql}
        UNION ALL
        SELECT e.work_order_id AS wo_id, e.amount
        FROM expenses e
        JOIN invoices i ON i.id = e.invoice_id
        WHERE i.status IN ${BILLABLE_STATUSES} ${scopeSql} ${periodSql}
      ) spend ON spend.wo_id = w.id
      WHERE w.store_name IS NOT NULL AND w.store_name != ''
        ${woFilterSql}
      GROUP BY w.store_name
      ORDER BY total DESC
      LIMIT 15
    `).all(...params, ...params, ...storeParam);

    // ---- By cart-count bucket ----
    // Buckets: 1-5 (small repair/svc), 6-10, 11-20, 21+ (big deploys)
    const byCartBucket = db.prepare(`
      SELECT bucket,
             COUNT(DISTINCT wo_id) AS wo_count,
             COALESCE(SUM(amount),0) AS total,
             COALESCE(AVG(carts),0)  AS avg_carts
      FROM (
        SELECT w.id AS wo_id, w.cart_count AS carts, spend.amount,
               CASE
                 WHEN COALESCE(w.cart_count,0) <= 0 THEN 'misc'
                 WHEN w.cart_count <= 5  THEN '1-5'
                 WHEN w.cart_count <= 10 THEN '6-10'
                 WHEN w.cart_count <= 20 THEN '11-20'
                 ELSE '21+' END AS bucket
        FROM work_orders w
        JOIN (
          SELECT t.work_order_id AS wo_id,
                 (julianday(t.clock_out)-julianday(t.clock_in))*24 *
                   COALESCE((SELECT u.hourly_rate FROM users u WHERE u.id = t.user_id), 40) AS amount
          FROM time_entries t
          JOIN invoices i ON i.id = t.invoice_id
          WHERE t.clock_out IS NOT NULL AND (t.mode IS NULL OR t.mode = 'work')
            AND i.status IN ${BILLABLE_STATUSES} ${scopeSql} ${periodSql}
          UNION ALL
          SELECT e.work_order_id AS wo_id, e.amount
          FROM expenses e
          JOIN invoices i ON i.id = e.invoice_id
          WHERE i.status IN ${BILLABLE_STATUSES} ${scopeSql} ${periodSql}
        ) spend ON spend.wo_id = w.id
        WHERE 1=1 ${woFilterSql}
      )
      GROUP BY bucket
      ORDER BY CASE bucket WHEN '1-5' THEN 0 WHEN '6-10' THEN 1 WHEN '11-20' THEN 2 WHEN '21+' THEN 3 ELSE 4 END
    `).all(...params, ...params, ...storeParam);

    // ---- Tech × Work Type matrix (for stacked bar comparison) ----
    // Each tech's spend split by work_type. Tech filter narrows scope; store
    // filter applies through the WO join.
    const matrixRows = db.prepare(`
      SELECT i.user_id, u.name AS tech_name, w.work_type,
             COALESCE(SUM(spend.amount), 0) AS total
      FROM invoices i
      JOIN users u ON u.id = i.user_id
      JOIN (
        SELECT t.invoice_id AS iid, t.work_order_id AS wo_id,
               (julianday(t.clock_out)-julianday(t.clock_in))*24 *
                 COALESCE((SELECT u2.hourly_rate FROM users u2 WHERE u2.id = t.user_id), 40) AS amount
        FROM time_entries t
        WHERE t.clock_out IS NOT NULL AND (t.mode IS NULL OR t.mode = 'work')
        UNION ALL
        SELECT e.invoice_id AS iid, e.work_order_id AS wo_id, e.amount FROM expenses e
      ) spend ON spend.iid = i.id
      JOIN work_orders w ON w.id = spend.wo_id
      WHERE i.status IN ${BILLABLE_STATUSES} ${scopeSql} ${periodSql} ${woFilterSql}
      GROUP BY i.user_id, u.name, w.work_type
    `).all(...params, ...storeParam);
    // Re-shape into { tech: { name, totals: {dpl, rtr, svc, rpr}, total } }
    const techMatrix = {};
    for (const r of matrixRows) {
      const k = r.user_id;
      if (!techMatrix[k]) techMatrix[k] = { user_id: k, name: r.tech_name, totals: { deployment:0, retrofit:0, maintenance:0, repair:0 }, total: 0 };
      if (techMatrix[k].totals[r.work_type] !== undefined) techMatrix[k].totals[r.work_type] += r.total;
      techMatrix[k].total += r.total;
    }
    const byTechWorkType = Object.values(techMatrix).sort((a,b) => b.total - a.total);

    // ---- Per-tech weekly trend (for multi-line chart) ----
    // Same 12-week window as the aggregate trend.
    const ttStart = isoWeekStart(daysAgo(12 * 7));
    const ttScopeIds = effectiveTechIds || [];
    const techTrendRows = ttScopeIds.length || !scopeIds
      ? db.prepare(`
          SELECT i.user_id, u.name AS tech_name, i.period_start, COALESCE(SUM(${hasWoFilter ? 'spend.amount' : 'i.total'}), 0) AS spend
          FROM invoices i
          JOIN users u ON u.id = i.user_id
          ${hasWoFilter ? `
            JOIN (
              SELECT t.invoice_id AS iid, t.work_order_id AS wo_id,
                     (julianday(t.clock_out)-julianday(t.clock_in))*24 *
                       COALESCE((SELECT u2.hourly_rate FROM users u2 WHERE u2.id = t.user_id), 40) AS amount
              FROM time_entries t
              WHERE t.clock_out IS NOT NULL AND (t.mode IS NULL OR t.mode = 'work')
              UNION ALL
              SELECT e.invoice_id AS iid, e.work_order_id AS wo_id, e.amount FROM expenses e
            ) spend ON spend.iid = i.id
            JOIN work_orders w ON w.id = spend.wo_id
          ` : ''}
          WHERE i.status IN ${BILLABLE_STATUSES}
            ${ttScopeIds.length ? `AND i.user_id IN (${ttScopeIds.map(() => '?').join(',')})` : ''}
            AND i.period_start >= ?
            ${hasWoFilter ? woFilterSql : ''}
          GROUP BY i.user_id, u.name, i.period_start
          ORDER BY i.period_start
        `).all(...ttScopeIds, ttStart, ...(hasWoFilter ? storeParam : []))
      : [];
    // Build series per tech with all 12 weeks padded to zero.
    const techTrendSeries = {};
    for (const r of techTrendRows) {
      if (!techTrendSeries[r.user_id]) techTrendSeries[r.user_id] = { user_id: r.user_id, name: r.tech_name, points: {} };
      techTrendSeries[r.user_id].points[r.period_start] = (techTrendSeries[r.user_id].points[r.period_start] || 0) + r.spend;
    }
    // Pad each series to all 12 weeks
    const allWeeks = [];
    {
      const start = new Date(ttStart);
      for (let i = 0; i < 12; i++) {
        const d = new Date(start); d.setDate(d.getDate() + i * 7);
        allWeeks.push(iso(d));
      }
    }
    const trendByTech = Object.values(techTrendSeries).map(s => ({
      user_id: s.user_id,
      name:    s.name,
      points:  allWeeks.map(w => ({ week_start: w, spend: +(s.points[w] || 0).toFixed(2) })),
      total:   +Object.values(s.points).reduce((a,b)=>a+b, 0).toFixed(2),
    })).sort((a,b) => b.total - a.total);

    // ---- Vendor spend (3rd-party invoices, v0.36) ----
    // Aggregates the `invoice_type='vendor'` flow alongside the tech-labor
    // numbers. Honors period + tech filter (uploader); store/work_type
    // filters are tech-side only so they don't apply.
    const vendorRows = db.prepare(`
      SELECT i.vendor_name, COUNT(*) AS n, COALESCE(SUM(i.total),0) AS total
      FROM invoices i
      WHERE i.invoice_type = 'vendor' AND i.status IN ${BILLABLE_STATUSES}
        ${periodSql}
      GROUP BY i.vendor_name
      ORDER BY total DESC
    `).all(...(periodStart ? [periodStart] : []));
    const vendorSummary = {
      total: +vendorRows.reduce((a,v) => a + v.total, 0).toFixed(2),
      count: vendorRows.reduce((a,v) => a + v.n, 0),
      vendor_count: vendorRows.length,
    };

    // Vendor invoices currently awaiting Sr Mgr approval (informational tile)
    const vendorPending = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total
      FROM invoices WHERE invoice_type = 'vendor' AND status = 'submitted'
    `).get();

    // ---- Per-store weekly trend (top 5 stores by total spend) ----
    // Powers the multi-line "Spend trend per store" chart so managers can
    // compare individual store burn over time.
    const ttStartStore = isoWeekStart(daysAgo(12 * 7));
    const top5Stores = byStore.slice(0, 5).map(s => s.store_name);
    let trendByStore = [];
    if (top5Stores.length) {
      const placeholders = top5Stores.map(() => '?').join(',');
      const trendStoreRows = db.prepare(`
        SELECT w.store_name, i.period_start, COALESCE(SUM(spend.amount), 0) AS spend
        FROM invoices i
        JOIN (
          SELECT t.invoice_id AS iid, t.work_order_id AS wo_id,
                 (julianday(t.clock_out)-julianday(t.clock_in))*24 *
                   COALESCE((SELECT u2.hourly_rate FROM users u2 WHERE u2.id = t.user_id), 40) AS amount
          FROM time_entries t
          WHERE t.clock_out IS NOT NULL AND (t.mode IS NULL OR t.mode = 'work')
          UNION ALL
          SELECT e.invoice_id AS iid, e.work_order_id AS wo_id, e.amount FROM expenses e
        ) spend ON spend.iid = i.id
        JOIN work_orders w ON w.id = spend.wo_id
        WHERE i.status IN ${BILLABLE_STATUSES}
          ${effectiveTechIds ? `AND i.user_id IN (${effectiveTechIds.map(() => '?').join(',')})` : ''}
          AND i.period_start >= ?
          AND w.store_name IN (${placeholders})
        GROUP BY w.store_name, i.period_start
        ORDER BY i.period_start
      `).all(...(effectiveTechIds || []), ttStartStore, ...top5Stores);
      const storeMap = {};
      for (const r of trendStoreRows) {
        if (!storeMap[r.store_name]) storeMap[r.store_name] = { name: r.store_name, points: {} };
        storeMap[r.store_name].points[r.period_start] = (storeMap[r.store_name].points[r.period_start] || 0) + r.spend;
      }
      const allStoreWeeks = [];
      {
        const start = new Date(ttStartStore);
        for (let i = 0; i < 12; i++) {
          const d = new Date(start); d.setDate(d.getDate() + i * 7);
          allStoreWeeks.push(iso(d));
        }
      }
      trendByStore = top5Stores
        .filter(name => storeMap[name])
        .map(name => ({
          name,
          points: allStoreWeeks.map(w => ({ week_start: w, spend: +(storeMap[name].points[w] || 0).toFixed(2) })),
          total:  +Object.values(storeMap[name].points).reduce((a,b)=>a+b, 0).toFixed(2),
        }));
    }

    // ---- Weekly spend trend (last 12 weeks) ----
    const trendStart = isoWeekStart(daysAgo(12 * 7));
    const trendScope = effectiveTechIds ? `AND i.user_id IN (${effectiveTechIds.map(() => '?').join(',')})` : '';
    let trendRows;
    if (hasWoFilter) {
      trendRows = db.prepare(`
        SELECT i.period_start, COUNT(DISTINCT i.id) AS n, COALESCE(SUM(spend.amount),0) AS spend
        FROM invoices i
        JOIN (
          SELECT t.invoice_id AS iid, t.work_order_id AS wo_id,
                 (julianday(t.clock_out)-julianday(t.clock_in))*24 *
                   COALESCE((SELECT u.hourly_rate FROM users u WHERE u.id = t.user_id), 40) AS amount
          FROM time_entries t
          WHERE t.clock_out IS NOT NULL AND (t.mode IS NULL OR t.mode = 'work')
          UNION ALL
          SELECT e.invoice_id AS iid, e.work_order_id AS wo_id, e.amount FROM expenses e
        ) spend ON spend.iid = i.id
        JOIN work_orders w ON w.id = spend.wo_id
        WHERE i.status IN ${BILLABLE_STATUSES} ${trendScope} AND i.period_start >= ? ${woFilterSql}
        GROUP BY i.period_start
        ORDER BY i.period_start
      `).all(...(effectiveTechIds || []), trendStart, ...storeParam);
    } else {
      trendRows = db.prepare(`
        SELECT i.period_start, COUNT(*) AS n, COALESCE(SUM(i.total),0) AS spend
        FROM invoices i
        WHERE i.status IN ${BILLABLE_STATUSES} ${trendScope}
          AND i.period_start >= ?
        GROUP BY i.period_start
        ORDER BY i.period_start
      `).all(...(effectiveTechIds || []), trendStart);
    }
    const trend = padWeeks(trendRows, 12);
    const projection = projectNextNWeeks(trend, 4);

    // ---- Bottoms-up forecast based on open WO cart counts ----
    const openWosScope = effectiveTechIds ? `AND w.assigned_user_id IN (${effectiveTechIds.map(() => '?').join(',')})` : '';
    const openWos = db.prepare(`
      SELECT w.work_type, w.cart_count, w.store_name, w.external_id
      FROM work_orders w
      WHERE w.status IN ('open','in_progress') ${openWosScope} ${woFilterSql}
    `).all(...(effectiveTechIds || []), ...storeParam);
    let forecastBottomsUp = 0;
    const forecastDetail = [];
    for (const wo of openWos) {
      const rate = ratePerCart[wo.work_type] || 0;
      const carts = wo.cart_count || 0;
      const est = +(rate * carts).toFixed(2);
      forecastBottomsUp += est;
      forecastDetail.push({
        external_id: wo.external_id, work_type: wo.work_type,
        store_name: wo.store_name, cart_count: carts,
        rate_per_cart: +rate.toFixed(2), estimated_spend: est,
      });
    }
    forecastDetail.sort((a, b) => b.estimated_spend - a.estimated_spend);

    // ---- Top invoices ----
    const topInvoicesParams = [...params];
    let topInvoicesWoClause = '';
    if (hasWoFilter) {
      // Subquery: invoice ids that touch a WO matching the active filters.
      const sub = `(
        SELECT DISTINCT t.invoice_id FROM time_entries t
          JOIN work_orders w ON w.id = t.work_order_id
          WHERE 1=1 ${woFilterSql}
        UNION
        SELECT DISTINCT e.invoice_id FROM expenses e
          JOIN work_orders w ON w.id = e.work_order_id
          WHERE 1=1 ${woFilterSql}
      )`;
      topInvoicesWoClause = `AND i.id IN ${sub}`;
      topInvoicesParams.push(...storeParam, ...storeParam);
    }
    const topInvoices = db.prepare(`
      SELECT i.id, i.invoice_number, i.status, i.total, i.period_start, i.period_end,
             u.name AS tech_name
      FROM invoices i JOIN users u ON u.id = i.user_id
      WHERE i.status IN ${BILLABLE_STATUSES} ${scopeSql} ${periodSql} ${topInvoicesWoClause}
      ORDER BY i.total DESC
      LIMIT 10
    `).all(...topInvoicesParams);

    // ---- Aging items in queue ----
    const aging = db.prepare(`
      SELECT i.id, i.invoice_number, i.total, i.submitted_at, u.name AS tech_name,
             ROUND(julianday('now') - julianday(i.submitted_at), 1) AS days_in_queue
      FROM invoices i JOIN users u ON u.id = i.user_id
      WHERE i.status IN ('submitted','approved_ops') ${scopeSql}
        AND julianday('now') - julianday(i.submitted_at) > 3
      ORDER BY i.submitted_at
    `).all(...(effectiveTechIds || []));

    // Available filter values — let the UI populate the tech and store
    // dropdowns without a separate round-trip.
    const availableTechs = db.prepare(`
      SELECT u.id, u.name FROM users u
      WHERE u.role = 'technician'
        ${scopeIds ? `AND u.id IN (${scopeIds.map(() => '?').join(',')})` : ''}
      ORDER BY u.name
    `).all(...(scopeIds || []));
    const availableStores = db.prepare(`
      SELECT DISTINCT w.store_name AS name
      FROM work_orders w
      WHERE w.store_name IS NOT NULL AND w.store_name != ''
        ${scopeIds ? `AND w.assigned_user_id IN (${scopeIds.map(() => '?').join(',')})` : ''}
      ORDER BY w.store_name
    `).all(...(scopeIds || []));

    return { ok: true, payload: {
      meta: {
        period, period_label: periodLabel, period_start: periodStart,
        scope: me.role === 'ops_manager' ? 'team' : 'all',
        scope_size: scopeIds ? scopeIds.length : null,
        tech_filter:      techFilter,
        store_filter:     storeFilter,
        work_type_filter: wtFilter,
        available_techs:       availableTechs,
        available_stores:      availableStores.map(s => s.name),
        available_work_types:  [...activeWorkTypes(db)],
        generated_at: new Date().toISOString(),
      },
      summary: {
        total_spend: +sumRow.sum_total.toFixed(2),
        invoice_count: sumRow.n,
        avg_invoice: +sumRow.avg_total.toFixed(2),
        pending_count: pendingRow.n,
        pending_value: +pendingRow.sum_total.toFixed(2),
        pending_avg_age_days: +pendingRow.avg_age.toFixed(1),
        draft_count: draftRow.n,
        draft_value: +draftRow.sum_total.toFixed(2),
        forecast_next_4_weeks_trend: projection.total,
        forecast_open_wos: +forecastBottomsUp.toFixed(2),
        // v0.36 — 3rd-party vendor spend
        vendor_spend:           vendorSummary.total,
        vendor_invoice_count:   vendorSummary.count,
        vendor_unique:          vendorSummary.vendor_count,
        vendor_pending_count:   vendorPending.n,
        vendor_pending_value:   +vendorPending.total.toFixed(2),
      },
      by_vendor: vendorRows.map(v => ({ vendor_name: v.vendor_name, n: v.n, total: +v.total.toFixed(2) })),
      by_tech: byTech,
      by_work_type: byWorkType,
      by_store: byStore,
      by_cart_bucket: byCartBucket,
      by_tech_work_type: byTechWorkType,
      trend_by_tech:     trendByTech,
      trend_by_store:    trendByStore,
      trend,
      projection: projection.weeks,
      forecast_open_wos_detail: forecastDetail,
      top_invoices: topInvoices,
      aging,
    }};
  } // end buildDashboardPayload

  // GET /dashboard
  router.get('/dashboard', (req, res) => {
    const r = buildDashboardPayload(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    // v0.40 — also attach the cost-tracker monthly summary so the
    // in-app Dashboard tab can show forecast-vs-actual by month
    // (matching the Excel DASHBOARD sheet).
    try {
      const costRows = buildCostTrackerRows(db, req);
      r.payload.cost_tracker_monthly = aggregateCostTrackerByMonth(costRows);
      r.payload.cost_tracker_row_count = costRows.length;
    } catch (e) {
      console.warn('[dashboard] cost_tracker_monthly skipped:', e.message);
    }
    res.json(r.payload);
  });

  // GET /dashboard/export?period=&tech=&store=
  // Streams an .xlsx workbook in the FY26 Deployment & Retrofit Cost
  // Tracker format: COST TRACKER MAIN, Assumptions, DASHBOARD. v0.40
  router.get('/dashboard/export', (req, res) => {
    const r = buildDashboardPayload(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const rows = buildCostTrackerRows(db, req);
    const buf = buildDashboardWorkbook(r.payload, rows);
    const filename = makeExportFilename(r.payload.meta);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  });

  // PATCH /cost-tracker/:wo_id — Ops Mgr edits a single Cost Tracker row.
  // Stores in cost_tracker_overrides so the row's computed values get
  // overlaid on subsequent reads. Empty/null values clear the override.
  // v0.42
  router.patch('/cost-tracker/:wo_id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) : null;
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }
    const woId = Number(req.params.wo_id);
    const wo = db.prepare("SELECT id FROM work_orders WHERE id = ?").get(woId);
    if (!wo) return res.status(404).json({ error: 'work order not found' });

    const b = req.body || {};
    const norm = (v) => (v === '' || v === undefined ? null : v);
    const fields = {
      cost_reconciled:    norm(b.cost_reconciled),
      pm_dri:             norm(b.pm_dri),
      ops_manager:        norm(b.ops_manager),
      num_techs:          b.num_techs == null || b.num_techs === '' ? null : Number(b.num_techs),
      tech_names:         norm(b.tech_names),
      actual_labor:       b.actual_labor == null || b.actual_labor === '' ? null : Number(b.actual_labor),
      actual_travel:      b.actual_travel == null || b.actual_travel === '' ? null : Number(b.actual_travel),
      actual_expenses:    b.actual_expenses == null || b.actual_expenses === '' ? null : Number(b.actual_expenses),
      service_delay:      norm(b.service_delay),
      has_third_party:    b.has_third_party == null ? null : (b.has_third_party ? 1 : 0),
      third_party_vendor: norm(b.third_party_vendor),
      third_party_cost:   b.third_party_cost == null || b.third_party_cost === '' ? null : Number(b.third_party_cost),
      notes:              norm(b.notes),
    };
    // Validate numerics
    for (const k of ['num_techs','actual_labor','actual_travel','actual_expenses','third_party_cost']) {
      if (fields[k] !== null && (!isFinite(fields[k]) || fields[k] < 0)) {
        return res.status(400).json({ error: `${k} must be a non-negative number` });
      }
    }
    // v0.44 — BUG-005 fix: cap free-text fields.
    const stringCaps = {
      pm_dri: 80, ops_manager: 80, tech_names: 500,
      service_delay: 80, third_party_vendor: 200, notes: 2000,
    };
    for (const [k, max] of Object.entries(stringCaps)) {
      if (fields[k] != null && typeof fields[k] === 'string' && fields[k].length > max) {
        return res.status(400).json({ error: `${k} max ${max} chars` });
      }
    }
    // v0.44 — sanity bounds on numeric overrides
    if (fields.num_techs != null && fields.num_techs > 100) {
      return res.status(400).json({ error: 'num_techs cannot exceed 100' });
    }

    const existing = db.prepare("SELECT 1 FROM cost_tracker_overrides WHERE work_order_id = ?").get(woId);
    const now = new Date().toISOString();
    if (existing) {
      db.prepare(`
        UPDATE cost_tracker_overrides SET
          cost_reconciled = ?, pm_dri = ?, ops_manager = ?,
          num_techs = ?, tech_names = ?,
          actual_labor = ?, actual_travel = ?, actual_expenses = ?,
          service_delay = ?, has_third_party = ?, third_party_vendor = ?,
          third_party_cost = ?, notes = ?,
          updated_by = ?, updated_at = ?
        WHERE work_order_id = ?
      `).run(
        fields.cost_reconciled, fields.pm_dri, fields.ops_manager,
        fields.num_techs, fields.tech_names,
        fields.actual_labor, fields.actual_travel, fields.actual_expenses,
        fields.service_delay, fields.has_third_party, fields.third_party_vendor,
        fields.third_party_cost, fields.notes,
        userId, now, woId,
      );
    } else {
      db.prepare(`
        INSERT INTO cost_tracker_overrides
          (work_order_id, cost_reconciled, pm_dri, ops_manager, num_techs, tech_names,
           actual_labor, actual_travel, actual_expenses, service_delay, has_third_party, third_party_vendor,
           third_party_cost, notes, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        woId, fields.cost_reconciled, fields.pm_dri, fields.ops_manager,
        fields.num_techs, fields.tech_names,
        fields.actual_labor, fields.actual_travel, fields.actual_expenses,
        fields.service_delay, fields.has_third_party, fields.third_party_vendor,
        fields.third_party_cost, fields.notes, userId, now,
      );
    }

    res.json({ ok: true, work_order_id: woId, updated_at: now });
  });

  // DELETE /cost-tracker/:wo_id/override — clear the override; restore
  // the row to its computed-only state.
  router.delete('/cost-tracker/:wo_id/override', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) : null;
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }
    const woId = Number(req.params.wo_id);
    db.prepare("DELETE FROM cost_tracker_overrides WHERE work_order_id = ?").run(woId);
    res.json({ ok: true, work_order_id: woId, cleared: true });
  });

  // GET /cost-tracker — full data for the Cost Tracker tab. Mirrors the
  // Excel template structure (rows, monthly summary, assumptions) so the
  // in-app view matches what's in the export. v0.41
  router.get('/cost-tracker', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) : null;
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }

    const rows = buildCostTrackerRows(db, req);
    const monthly = aggregateCostTrackerByMonth(rows);
    const by_store_invoices = buildSubmittedApprovedInvoicesByStore(db, req);   // v0.57
    const missingCount = rows.filter(r => r.missing_data).length;
    const editedCount  = rows.filter(r => r.is_edited).length;
    res.json({
      meta: {
        period:        req.query.period || 'last_90',
        period_label:  periodHumanLabel(req.query.period || 'last_90'),
        store_filter:  req.query.store      || '',
        wt_filter:     req.query.work_type  || '',
        generated_at:  new Date().toISOString(),
        row_count:     rows.length,
        missing_count: missingCount,
        edited_count:  editedCount,
      },
      rows,
      monthly,
      by_store_invoices,   // v0.57 — submitted + approved invoices grouped by store
    });
  });

  // GET /dashboard/drive-status — does the server have Google creds + a target sheet?
  // The UI uses this to decide whether to show the "Push to Drive" button.
  router.get('/dashboard/drive-status', (_req, res) => {
    res.json({
      configured: gsheets.isConfigured(),
      sheet_id:   process.env.GOOGLE_SHEET_ID || null,
      sheet_url:  process.env.GOOGLE_SHEET_ID
        ? `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}/edit`
        : null,
    });
  });

  // POST /dashboard/push-to-drive — write the current dashboard slice to the
  // configured Google Sheet (one tab per section). Same filters as /dashboard.
  router.post('/dashboard/push-to-drive', async (req, res) => {
    if (!gsheets.isConfigured()) {
      return res.status(503).json({
        error: 'Google Sheets is not configured on this server. See data/google-service-account.json + GOOGLE_SHEET_ID.',
      });
    }
    const r = buildDashboardPayload(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const costRows = buildCostTrackerRows(db, req);
    try {
      const out = await gsheets.pushDashboardToSheet(r.payload, costRows);
      res.json({ ok: true, ...out });
    } catch (e) {
      console.error('[push-to-drive]', e);
      res.status(502).json({ error: e.message || 'push failed' });
    }
  });

  return router;
};

// ============================ helpers ============================

function emptyPayload(message) {
  return {
    meta: { empty: true, message },
    summary: { total_spend: 0, invoice_count: 0, avg_invoice: 0,
               pending_count: 0, pending_value: 0, pending_avg_age_days: 0,
               draft_count: 0, draft_value: 0,
               forecast_next_4_weeks_trend: 0, forecast_open_wos: 0 },
    by_tech: [], by_work_type: [], by_store: [], by_cart_bucket: [],
    trend: [], projection: [], forecast_open_wos_detail: [],
    top_invoices: [], aging: [],
  };
}

function periodStartDate(p) {
  const d = new Date();
  switch (p) {
    case 'mtd':     return iso(new Date(d.getFullYear(), d.getMonth(), 1));
    case 'last_30': return iso(daysAgo(30));
    case 'last_90': return iso(daysAgo(90));
    case 'qtd': {
      const q = Math.floor(d.getMonth() / 3) * 3;
      return iso(new Date(d.getFullYear(), q, 1));
    }
    case 'ytd':     return iso(new Date(d.getFullYear(), 0, 1));
    case 'all':     return null;
    default:        return iso(daysAgo(90));
  }
}

function periodHumanLabel(p) {
  return ({
    mtd: 'Month-to-date', last_30: 'Last 30 days', last_90: 'Last 90 days',
    qtd: 'Quarter-to-date', ytd: 'Year-to-date', all: 'All time',
  })[p] || 'Last 90 days';
}

function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n); return d;
}
function iso(d) { return d.toISOString().slice(0, 10); }

// Snap to Monday-start (matches the rest of the app's week convention)
function isoWeekStart(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + offset);
  dt.setHours(0,0,0,0);
  return iso(dt);
}

// Pad sparse weekly data so the chart shows zero-weeks too.
function padWeeks(rows, weeks) {
  const out = [];
  const map = Object.fromEntries(rows.map(r => [r.period_start, r]));
  const start = new Date(isoWeekStart(daysAgo(weeks * 7)));
  for (let i = 0; i < weeks; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i * 7);
    const k = iso(d);
    out.push({
      week_start: k,
      spend: map[k] ? +map[k].spend.toFixed(2) : 0,
      invoice_count: map[k] ? map[k].n : 0,
    });
  }
  return out;
}

// Simple linear regression over the weekly spend array; project N future weeks.
// Returns { weeks: [{week_start, projected_spend}], total: $ }.
// Build a workbook in the FY26 Deployment & Retrofit Cost Tracker format.
// v0.40 — mirrors the team's existing Excel template so the Ops/PM team
// can drop our export straight onto Drive without reformatting.
//
// Sheets produced:
//   * COST TRACKER MAIN — one row per work order with formulas referencing
//     the Assumptions tab (deployment vs retrofit forecast labor, mileage
//     forecast, overspend, totals, variance)
//   * Assumptions       — editable rate inputs (mileage rate, hours/cart,
//     hourly rate, deployment budget, third-party rates)
//   * DASHBOARD         — month-by-service-type summary with grand totals
//   * Summary (legacy)  — KPI tiles preserved for back-compat
function buildDashboardWorkbook(p, costRows = []) {
  const wb = XLSX.utils.book_new();

  // ============== Sheet 1: COST TRACKER MAIN (actuals only) v0.42 ==============
  const ctmHeader = [
    'Cost Reconciled', 'Store (e.g., WF 30)', 'PM DRI', 'Ops Manager',
    'Service Type', '# of Carts', 'Service Month', 'Service Completion Date',
    'Caper # Techs', 'Caper Technician(s)',
    'Actual Labor Cost (Caper)', 'Actual Travel Cost (Caper)', 'Actual Expenses (Caper)',
    'Service Delay',
    'Third Party Vendor', 'Actual Third Party Cost',
    'Actual Total (Caper + 3P)', 'Invoice', 'Notes',
  ];
  const ctmRows = [ctmHeader];
  for (const r of costRows) {
    ctmRows.push([
      r.cost_reconciled || 'No',
      r.store_name || '',
      r.pm_dri || '',
      r.ops_manager || '',
      r.service_type || '',
      r.cart_count || '',
      r.service_month || '',
      r.service_date || '',
      r.num_techs || '',
      r.tech_names || '',
      r.actual_labor != null ? +r.actual_labor.toFixed(2) : '',
      r.actual_travel != null ? +r.actual_travel.toFixed(2) : '',
      r.actual_expenses != null ? +r.actual_expenses.toFixed(2) : '',
      r.service_delay || 'None',
      r.has_third_party ? 'Yes' : 'No',
      r.third_party_cost != null ? +r.third_party_cost.toFixed(2) : 0,
      null, // formula below
      r.invoice_link || '',
      r.notes || '',
    ]);
  }
  const ctmSheet = XLSX.utils.aoa_to_sheet(ctmRows);
  // Q column = SUM(K + L + M + P) — Actual Total.
  // K=Actual Labor, L=Actual Travel, M=Actual Expenses, P=Actual 3P Cost.
  for (let i = 0; i < costRows.length; i++) {
    const xr = i + 2;
    setFormula(ctmSheet, `Q${xr}`, `IF($B${xr}="","",SUM(IF($K${xr}="",0,$K${xr}),IF($L${xr}="",0,$L${xr}),IF($M${xr}="",0,$M${xr}),IF($P${xr}="",0,$P${xr})))`);
  }
  // v0.67 — grand-total row so the export showcases the same bottom-line totals
  // as the in-app footer (Labor / Travel / Expenses / 3P / Total). Pending rows
  // carry $0, so the column sums equal the approved actuals.
  if (costRows.length) {
    const first = 2, last = costRows.length + 1, totalRow = costRows.length + 2;
    XLSX.utils.sheet_add_aoa(ctmSheet, [['', 'TOTAL (approved actuals)']], { origin: `A${totalRow}` });
    setFormula(ctmSheet, `K${totalRow}`, `SUM(K${first}:K${last})`);
    setFormula(ctmSheet, `L${totalRow}`, `SUM(L${first}:L${last})`);
    setFormula(ctmSheet, `M${totalRow}`, `SUM(M${first}:M${last})`);
    setFormula(ctmSheet, `P${totalRow}`, `SUM(P${first}:P${last})`);
    setFormula(ctmSheet, `Q${totalRow}`, `SUM(Q${first}:Q${last})`);
  }
  ctmSheet['!cols'] = [
    { wch: 14 }, { wch: 20 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch:  8 },
    { wch: 12 }, { wch: 18 }, { wch: 11 }, { wch: 22 },
    { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 13 },
    { wch: 16 }, { wch: 18 }, { wch: 18 },
    { wch: 12 }, { wch: 30 },
  ];
  XLSX.utils.book_append_sheet(wb, ctmSheet, 'COST TRACKER MAIN');

  // ============== Sheet 2: DASHBOARD (approved actuals, by work type) ==============
  // v0.67 — reuse the very same aggregate the app + Google Sheets use, broken out
  // by EVERY work type (a column each) so the export matches the in-app dashboard.
  const agg   = aggregateCostTrackerByMonth(costRows);
  const types = agg.types;
  const NT    = types.length;
  const colL  = (i) => XLSX.utils.encode_col(i);     // 0->A, 1->B, …
  const totalColIdx = NT + 1;                         // grand-total col (after month + N types)
  const countColIdx = NT + 2;                         // # work orders col
  const dashRows = [
    ['Caper CostWise — Cost Tracker Dashboard (approved actuals only)'],
    [],
    ['Service Month', ...types.map(t => `Actual: ${t}`), 'GRAND TOTAL Actual', '# Work Orders'],
  ];
  agg.rows.forEach(m => {
    dashRows.push([
      m.month,
      ...types.map(t => +(+(m.by_type[t] || 0)).toFixed(2)),
      null,                                            // grand-total formula filled below
      m.wo_count,
    ]);
  });
  const dashSheet = XLSX.utils.aoa_to_sheet(dashRows);
  for (let i = 0; i < agg.rows.length; i++) {
    const xr = i + 4;
    setFormula(dashSheet, `${colL(totalColIdx)}${xr}`, `SUM(${colL(1)}${xr}:${colL(NT)}${xr})`);
  }
  if (agg.rows.length) {
    const totalRow = agg.rows.length + 4;
    XLSX.utils.sheet_add_aoa(dashSheet, [['Total']], { origin: `A${totalRow}` });
    for (let c = 1; c <= countColIdx; c++) {
      setFormula(dashSheet, `${colL(c)}${totalRow}`, `SUM(${colL(c)}4:${colL(c)}${totalRow - 1})`);
    }
  }
  dashSheet['!cols'] = [{ wch: 16 }, ...types.map(() => ({ wch: 16 })), { wch: 20 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, dashSheet, 'DASHBOARD');

  // ============== Sheet 4: Summary (legacy KPI tiles, back-compat) ==============
  const summaryRows = [
    ['Caper CostWise — Dashboard Export (legacy summary)'],
    [],
    ['Period',           p.meta.period_label],
    ['Period start',     p.meta.period_start || ''],
    ['Tech filter',      p.meta.tech_filter ? (p.meta.available_techs.find(t => t.id === p.meta.tech_filter)?.name || p.meta.tech_filter) : '— all —'],
    ['Store filter',     p.meta.store_filter || '— all —'],
    ['Generated at',     p.meta.generated_at],
    [],
    ['Total spend (tech labor)',           p.summary.total_spend],
    ['Vendor spend (3rd party)',           p.summary.vendor_spend],
    ['Pending count',                      p.summary.pending_count],
    ['Pending value',                      p.summary.pending_value],
    ['Forecast: open WOs (bottoms-up)',    p.summary.forecast_open_wos],
    ['Cost-tracker rows generated',        costRows.length],
  ];
  const sumSheet = XLSX.utils.aoa_to_sheet(summaryRows);
  sumSheet['!cols'] = [{ wch: 38 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, sumSheet, 'Summary');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function setFormula(sheet, addr, formula) {
  sheet[addr] = { t: 'n', f: formula };
}

// v0.57 — one row per visit (invoice × work-order) for submitted / approved
// invoices. A store visited three times shows up as three separate rows so
// the Ops Mgr can see each visit individually. Vendor invoices appear as
// their own rows since they have no work-order. Honors period / store /
// work-type filters from the main cost tracker view.
function buildSubmittedApprovedInvoicesByStore(db, req) {
  const periodStart = periodStartDate(req.query.period);
  const storeFilter = (req.query.store || '').trim();
  const wtFilter    = (req.query.work_type || '').trim().toLowerCase();

  // Tech-labor invoices: one row per (invoice × work-order). The labor +
  // expense subtotals are scoped to that single WO so multiple visits to
  // the same store each get accurate per-visit dollars.
  const params = [];
  const where  = ["i.status IN ('submitted','approved_ops','approved_sr','queued_ap','sent_ap')",
                  "i.invoice_type = 'tech_labor'"];
  if (periodStart) { where.push('i.period_end >= ?'); params.push(periodStart); }
  if (storeFilter) { where.push('w.store_name = ?'); params.push(storeFilter); }
  if (wtFilter && activeWorkTypes(db).has(wtFilter)) {
    where.push('w.work_type = ?'); params.push(wtFilter);
  }

  const techRows = db.prepare(`
    WITH visit AS (
      SELECT DISTINCT i.id AS invoice_id, w.id AS wo_id
      FROM invoices i
      JOIN (
        SELECT DISTINCT invoice_id, work_order_id FROM time_entries WHERE invoice_id IS NOT NULL
        UNION
        SELECT DISTINCT invoice_id, work_order_id FROM expenses     WHERE invoice_id IS NOT NULL
      ) j ON j.invoice_id = i.id
      JOIN work_orders w ON w.id = j.work_order_id
    )
    SELECT
      i.id                     AS invoice_id,
      i.invoice_number,
      i.status, i.submitted_at, i.approved_ops_at, i.approved_sr_at, i.sent_to_ap_at,
      i.period_start, i.period_end,
      u.name                   AS tech_name,
      w.id                     AS wo_id,
      w.external_id            AS wo_external_id,
      w.store_name, w.store_id,
      w.work_type, w.cart_count, w.scheduled_date, w.title,
      -- v0.67 — labor = clocked work time OR labor logged as an expense (quantity=hours).
      -- When both exist for this tech/WO the manual expense WINS (replaces the clock),
      -- matching the cost tracker so the pipeline visit_total reconciles 1:1.
      CASE WHEN COALESCE((
             SELECT SUM(e.amount) FROM expenses e
             WHERE e.invoice_id = i.id AND e.work_order_id = w.id AND e.category = 'labor'), 0) > 0
        THEN COALESCE((SELECT SUM(e.amount) FROM expenses e
             WHERE e.invoice_id = i.id AND e.work_order_id = w.id AND e.category = 'labor'), 0)
        ELSE COALESCE((
          SELECT SUM(CASE WHEN t.clock_out IS NOT NULL AND (t.mode IS NULL OR t.mode = 'work')
               THEN (julianday(t.clock_out) - julianday(t.clock_in)) * 24 * COALESCE(u.hourly_rate, 40) ELSE 0 END)
          FROM time_entries t WHERE t.invoice_id = i.id AND t.work_order_id = w.id), 0)
      END AS labor_subtotal,
      CASE WHEN COALESCE((
             SELECT SUM(e.amount) FROM expenses e
             WHERE e.invoice_id = i.id AND e.work_order_id = w.id AND e.category = 'drive'), 0) > 0
        THEN COALESCE((SELECT SUM(e.amount) FROM expenses e
             WHERE e.invoice_id = i.id AND e.work_order_id = w.id AND e.category = 'drive'), 0)
        ELSE COALESCE((
          SELECT SUM(CASE WHEN t.clock_out IS NOT NULL AND t.mode = 'drive'
               THEN (julianday(t.clock_out) - julianday(t.clock_in)) * 24 * COALESCE(u.hourly_rate, 40) ELSE 0 END)
          FROM time_entries t WHERE t.invoice_id = i.id AND t.work_order_id = w.id), 0)
      END AS drive_subtotal,
      COALESCE((
        SELECT SUM(e.amount)
        FROM expenses e
        WHERE e.invoice_id = i.id AND e.work_order_id = w.id
          AND e.category NOT IN ('labor','drive')
      ), 0) AS expense_subtotal
    FROM invoices i
    JOIN visit v       ON v.invoice_id = i.id
    JOIN work_orders w ON w.id         = v.wo_id
    JOIN users u       ON u.id         = i.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(w.scheduled_date, i.period_end) DESC, w.store_name, i.id
  `).all(...params);

  // Vendor invoices: no work_order context — surface as separate rows so the
  // tracker still accounts for them.
  const vendorParams = [];
  const vendorWhere  = ["i.status IN ('submitted','approved_ops','approved_sr','queued_ap','sent_ap')",
                        "i.invoice_type = 'vendor'"];
  if (periodStart) { vendorWhere.push('i.period_end >= ?'); vendorParams.push(periodStart); }
  const vendorRows = !storeFilter ? db.prepare(`
    SELECT
      i.id AS invoice_id, i.invoice_number, i.status,
      i.submitted_at, i.approved_ops_at, i.approved_sr_at, i.sent_to_ap_at,
      i.period_start, i.period_end,
      i.vendor_name, i.vendor_invoice_number, i.vendor_invoice_date, i.vendor_category,
      i.total AS amount
    FROM invoices i
    WHERE ${vendorWhere.join(' AND ')}
    ORDER BY i.period_end DESC, i.id
  `).all(...vendorParams) : [];

  const visits = techRows.map(r => ({
    type:           'tech_labor',
    invoice_id:     r.invoice_id,
    invoice_number: r.invoice_number,
    status:         r.status,
    submitted_at:   r.submitted_at,
    approved_ops_at:r.approved_ops_at,
    approved_sr_at: r.approved_sr_at,
    sent_to_ap_at:  r.sent_to_ap_at,
    period_start:   r.period_start,
    period_end:     r.period_end,
    tech_name:      r.tech_name,
    wo_id:          r.wo_id,
    wo_external_id: r.wo_external_id,
    store_name:     r.store_name,
    store_id:       r.store_id,
    work_type:      r.work_type,
    cart_count:     r.cart_count,
    scheduled_date: r.scheduled_date,
    title:          r.title,
    labor_subtotal:   +Number(r.labor_subtotal).toFixed(2),
    drive_subtotal:   +Number(r.drive_subtotal).toFixed(2),
    expense_subtotal: +Number(r.expense_subtotal).toFixed(2),
    visit_total: +(Number(r.labor_subtotal) + Number(r.drive_subtotal) + Number(r.expense_subtotal)).toFixed(2),
  }));
  for (const r of vendorRows) {
    visits.push({
      type:           'vendor',
      invoice_id:     r.invoice_id,
      invoice_number: r.invoice_number,
      status:         r.status,
      submitted_at:   r.submitted_at,
      approved_ops_at:r.approved_ops_at,
      approved_sr_at: r.approved_sr_at,
      sent_to_ap_at:  r.sent_to_ap_at,
      period_start:   r.period_start,
      period_end:     r.period_end,
      vendor_name:    r.vendor_name,
      vendor_invoice_number: r.vendor_invoice_number,
      vendor_invoice_date:   r.vendor_invoice_date,
      vendor_category:r.vendor_category,
      visit_total:    +Number(r.amount).toFixed(2),
    });
  }

  const grand_total = +visits.reduce((s, v) => s + v.visit_total, 0).toFixed(2);
  return { visits, grand_total, grand_count: visits.length };
}

// Build cost-tracker rows from work_orders + time_entries + expenses,
// then overlay any cost_tracker_overrides (manual edits made by Ops Mgrs
// to fill in missing data). v0.42 — actuals only; forecast logic dropped.
function buildCostTrackerRows(db, req) {
  const periodStart = periodStartDate(req.query.period);
  const techFilter  = Number(req.query.tech) || null;
  const storeFilter = (req.query.store || '').trim();
  const wtFilter    = (req.query.work_type || '').trim().toLowerCase();

  const params  = [];
  const where   = [];
  // v0.62.3 — period filter still primarily based on scheduled_date, but a
  // completed WO with no scheduled date should still appear (the tech may
  // have marked it done off-schedule). Same for WOs whose only signal is a
  // time entry inside the period.
  if (periodStart)  {
    where.push(`(
      w.scheduled_date >= ?
      OR EXISTS (SELECT 1 FROM time_entries t3 WHERE t3.work_order_id = w.id AND date(t3.clock_in) >= ?)
      OR w.status = 'completed'
    )`);
    params.push(periodStart, periodStart);
  }
  // Tech filter now matches either a clocked-in tech OR the assigned tech,
  // so completed-but-unclocked WOs show up under the right name.
  if (techFilter)   {
    where.push(`(
      EXISTS (SELECT 1 FROM time_entries t2 WHERE t2.work_order_id = w.id AND t2.user_id = ?)
      OR w.assigned_user_id = ?
    )`);
    params.push(techFilter, techFilter);
  }
  if (storeFilter)  { where.push('w.store_name = ?'); params.push(storeFilter); }
  if (wtFilter && activeWorkTypes(db).has(wtFilter)) {
    where.push('w.work_type = ?'); params.push(wtFilter);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // v0.67 — APPROVED-ONLY actuals. A labor / drive / expense line only counts
  // toward the cost tracker once its invoice has reached approval (approved_ops
  // and later). Anything still in draft / submitted / in_review is treated as
  // not-yet-real and is excluded from every total. Kept as a single source list
  // so the main query and the per-bucket queries below stay in lock-step.
  const APPROVED = "('approved_ops','approved_sr','queued_ap','sent_ap')";

  const woRows = db.prepare(`
    SELECT
      w.id            AS wo_id,
      w.external_id   AS wo_ext,
      w.store_id, w.store_name, w.work_type, w.cart_count, w.scheduled_date,
      w.title, w.status, w.created_at AS wo_created_at,
      w.assigned_user_id,
      au.name         AS assigned_user_name,
      COUNT(DISTINCT t.user_id) AS num_techs,
      COALESCE(GROUP_CONCAT(DISTINCT u.name), '') AS tech_names,
      -- v0.67 — labor counts only when the time entry sits on an APPROVED invoice.
      COALESCE(SUM(
        CASE WHEN t.clock_out IS NOT NULL AND (t.mode IS NULL OR t.mode = 'work')
                  AND t.invoice_id IN (SELECT id FROM invoices WHERE status IN ${APPROVED})
             THEN (julianday(t.clock_out) - julianday(t.clock_in)) * 24 * COALESCE(u.hourly_rate, 40)
             ELSE 0 END
      ), 0) AS actual_labor,
      o.cost_reconciled    AS o_reconciled,
      o.pm_dri             AS o_pm_dri,
      o.ops_manager        AS o_ops_manager,
      o.num_techs          AS o_num_techs,
      o.tech_names         AS o_tech_names,
      o.actual_labor       AS o_actual_labor,
      o.actual_travel      AS o_actual_travel,
      o.actual_expenses    AS o_actual_expenses,
      o.service_delay      AS o_delay,
      o.has_third_party    AS o_has_3p,
      o.third_party_vendor AS o_3p_vendor,
      o.third_party_cost   AS o_3p_cost,
      o.notes              AS o_notes,
      o.updated_at         AS o_updated_at
    FROM work_orders w
    LEFT JOIN time_entries t ON t.work_order_id = w.id
    LEFT JOIN users u ON u.id = t.user_id
    LEFT JOIN users au ON au.id = w.assigned_user_id
    LEFT JOIN cost_tracker_overrides o ON o.work_order_id = w.id
    ${whereSql}
    GROUP BY w.id
    -- v0.62.3 — also surface completed WOs even if they have no scheduled
    -- date AND no clocked-in time. That covers the "tech marked complete
    -- without clocking in" path that used to disappear from the tracker.
    HAVING (actual_labor > 0)
        OR (w.scheduled_date IS NOT NULL)
        OR (w.status = 'completed')
    ORDER BY w.scheduled_date, w.id
  `).all(...params);

  // v0.67 — Cost Tracker reflects APPROVED ACTUALS ONLY and is the 1:1 source of
  // truth on spend. Cost is split four ways, each auditable on its own:
  //   Act Labor    = approved work-mode time         (priced at the tech's hourly rate)
  //   Act Travel   = approved drive-mode time + approved travel expenses (mileage/tolls/parking/travel)
  //   Act Expenses = approved materials / 'other' / vendor / misc expenses
  // Act Total = Labor + Travel + Expenses + 3P. A work order's computed actuals
  // count toward the totals only when it is COMPLETED and has lines on an approved
  // invoice; un-approved work shows as a "pending approval" row at $0 and is left
  // out of every total. Manager overrides (cost_tracker_overrides) ALWAYS apply and
  // always count — that's the manual reconciliation lever. Mirrors the AP pipeline:
  //   visit_total = work-labor + drive-labor + (expenses NOT IN 'labor','drive').
  const travelByWo  = {};
  const expenseByWo = {};
  const APPROVED_INV = `invoice_id IN (SELECT id FROM invoices WHERE status IN ${APPROVED})`;

  // ----- Per-(work-order, tech) labor/drive resolution -----
  // v0.67 — labor & drive can be recorded two ways: the clock (work/drive-mode
  // time entries) OR logged as an expense (category='labor'/'drive', quantity=
  // hours). When BOTH exist for the SAME tech on a WO, the manual entry is the
  // source of truth and REPLACES that tech's timer (no double-counting). Resolved
  // per tech so another tech's clocked time on the same WO is never dropped.
  const woUser = {};   // wo -> { uid -> { work, drive, laborExp, driveExp } }
  const slot = (wo, uid) => {
    woUser[wo] = woUser[wo] || {};
    return (woUser[wo][uid] = woUser[wo][uid] || { work: 0, drive: 0, laborExp: 0, driveExp: 0 });
  };
  // clocked time (approved), split work vs drive, per (wo, user)
  for (const r of db.prepare(`
    SELECT t.work_order_id AS wo, t.user_id AS uid,
      COALESCE(SUM(CASE WHEN t.clock_out IS NOT NULL AND (t.mode IS NULL OR t.mode = 'work')
        THEN (julianday(t.clock_out) - julianday(t.clock_in)) * 24 * COALESCE(u.hourly_rate, 40) ELSE 0 END), 0) AS work,
      COALESCE(SUM(CASE WHEN t.clock_out IS NOT NULL AND t.mode = 'drive'
        THEN (julianday(t.clock_out) - julianday(t.clock_in)) * 24 * COALESCE(u.hourly_rate, 40) ELSE 0 END), 0) AS drive
    FROM time_entries t LEFT JOIN users u ON u.id = t.user_id
    WHERE t.work_order_id IS NOT NULL AND t.${APPROVED_INV}
    GROUP BY t.work_order_id, t.user_id
  `).all()) { const s = slot(r.wo, r.uid); s.work += r.work; s.drive += r.drive; }
  // labor/drive logged AS EXPENSES (approved), per (wo, user)
  for (const r of db.prepare(`
    SELECT work_order_id AS wo, user_id AS uid, category, COALESCE(SUM(amount), 0) AS amt
    FROM expenses
    WHERE category IN ('labor','drive') AND work_order_id IS NOT NULL AND ${APPROVED_INV}
    GROUP BY work_order_id, user_id, category
  `).all()) { const s = slot(r.wo, r.uid); if (r.category === 'labor') s.laborExp += r.amt; else s.driveExp += r.amt; }

  // Resolve: per tech, manual (expense) wins over the clock when both exist.
  const laborByWo = {};   // resolved → Act Labor
  for (const [wo, users] of Object.entries(woUser)) {
    let labor = 0, drive = 0;
    for (const u of Object.values(users)) {
      labor += (u.laborExp > 0 ? u.laborExp : u.work);    // manual labor replaces clocked work
      drive += (u.driveExp > 0 ? u.driveExp : u.drive);   // manual drive replaces clocked drive
    }
    laborByWo[wo] = labor;
    travelByWo[wo] = (travelByWo[wo] || 0) + drive;        // resolved drive → Travel
  }
  // travel-category expenses (mileage/tolls/parking/travel) → Travel (always added)
  for (const r of db.prepare(`
    SELECT work_order_id AS wo, COALESCE(SUM(amount), 0) AS amt
    FROM expenses
    WHERE category IN ('mileage','tolls','travel','parking') AND work_order_id IS NOT NULL AND ${APPROVED_INV}
    GROUP BY work_order_id
  `).all()) travelByWo[r.wo] = (travelByWo[r.wo] || 0) + r.amt;
  // every other approved expense (materials / 'other' / vendor / misc) → Expenses
  for (const r of db.prepare(`
    SELECT work_order_id AS wo, COALESCE(SUM(amount), 0) AS amt
    FROM expenses
    WHERE category NOT IN ('labor','drive','mileage','tolls','travel','parking')
      AND work_order_id IS NOT NULL AND ${APPROVED_INV}
    GROUP BY work_order_id
  `).all()) expenseByWo[r.wo] = (expenseByWo[r.wo] || 0) + r.amt;

  // Which work orders have at least one line on an approved invoice? Only these
  // (when also completed) contribute their computed actuals to the totals.
  const approvedWoSet = new Set();
  for (const r of db.prepare(`
    SELECT DISTINCT work_order_id AS wo FROM time_entries
      WHERE work_order_id IS NOT NULL
        AND invoice_id IN (SELECT id FROM invoices WHERE status IN ${APPROVED})
    UNION
    SELECT DISTINCT work_order_id AS wo FROM expenses
      WHERE work_order_id IS NOT NULL
        AND invoice_id IN (SELECT id FROM invoices WHERE status IN ${APPROVED})
  `).all()) approvedWoSet.add(r.wo);

  // Latest logged work date per WO — fallback "service month" so a completed WO
  // with no scheduled_date still lands in a real month and is never dropped from
  // the dashboard totals.
  const workDateByWo = {};
  for (const r of db.prepare(`
    SELECT work_order_id AS wo, MAX(date(clock_in)) AS d
    FROM time_entries WHERE clock_out IS NOT NULL AND work_order_id IS NOT NULL
    GROUP BY work_order_id
  `).all()) workDateByWo[r.wo] = r.d;

  const monthName = (iso) => {
    if (!iso) return '';
    const m = new Date(iso).getMonth();
    return ['January','February','March','April','May','June','July','August','September','October','November','December'][m] || '';
  };
  const titleCase = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  // Coalesce helper: override wins if non-null/non-empty.
  const ov = (override, computed) => {
    if (override === null || override === undefined) return computed;
    if (typeof override === 'string' && override === '') return computed;
    return override;
  };

  return woRows.map(w => {
    const computedLabor    = +(laborByWo[w.wo_id]   || 0).toFixed(2); // resolved labor (clock OR manual; manual wins per tech)
    const computedTravel   = +(travelByWo[w.wo_id]  || 0).toFixed(2); // resolved drive + travel/drive expenses
    const computedExpenses = +(expenseByWo[w.wo_id] || 0).toFixed(2); // approved other expenses (labor/drive excluded — counted above)

    // Manager overrides always win and always count — even before approval.
    const hasLaborOv   = w.o_actual_labor    != null;
    const hasTravelOv  = w.o_actual_travel   != null;
    const hasExpenseOv = w.o_actual_expenses != null;
    const has3pOv      = w.o_3p_cost         != null;
    const hasCostOverride = hasLaborOv || hasTravelOv || hasExpenseOv || has3pOv;

    const actualLabor    = hasLaborOv   ? +(+w.o_actual_labor).toFixed(2)    : computedLabor;
    const actualTravel   = hasTravelOv  ? +(+w.o_actual_travel).toFixed(2)   : computedTravel;
    const actualExpenses = hasExpenseOv ? +(+w.o_actual_expenses).toFixed(2) : computedExpenses;
    const tpCost         = has3pOv      ? +(+w.o_3p_cost).toFixed(2)         : 0;

    // v0.67 — a row contributes to the totals only when COMPLETED + approved, or
    // when a manager has typed an override. Otherwise it's surfaced as pending.
    const isCompleted    = (w.status || 'open') === 'completed';
    const hasApprovedInv = approvedWoSet.has(w.wo_id);
    const inTotals       = hasCostOverride || (isCompleted && hasApprovedInv);
    const pendingApproval = !inTotals;

    // v0.62.3 — fall back to work_orders.assigned_user_id (and its name) when
    // no time entries exist. Without this, a tech who marks a WO completed
    // without ever clocking in disappears from the Technicians column.
    const computedTechNames = w.tech_names || w.assigned_user_name || '';
    const computedNumTechs  = (w.num_techs || 0) || (w.assigned_user_id ? 1 : 0);
    const numTechs     = w.o_num_techs != null ? +w.o_num_techs : computedNumTechs;
    const techNames    = ov(w.o_tech_names, computedTechNames);
    const has3p        = w.o_has_3p != null ? !!w.o_has_3p : false;
    const reconciled   = ov(w.o_reconciled, (inTotals && actualLabor > 0) ? 'Yes' : 'No');
    const isEdited     = !!w.o_updated_at;

    // Effective date for month bucketing: scheduled date → last logged work date
    // → WO creation date. Guarantees a month so the dashboard never drops a row.
    const createdDate   = w.wo_created_at ? String(w.wo_created_at).slice(0, 10) : '';
    const effectiveDate = w.scheduled_date || workDateByWo[w.wo_id] || createdDate;
    const actualTotal   = +(actualLabor + actualTravel + actualExpenses + tpCost).toFixed(2);

    return {
      wo_id:            w.wo_id,
      // v0.62.3 — expose work-order status + external id so the tracker can
      // render a Status badge and link out to the WO. external_id is also
      // useful for users who think in terms of "MX-DPL-…" rather than wo_id.
      status:           w.status || 'open',
      external_id:      w.wo_ext || '',
      assigned_user_id: w.assigned_user_id || null,
      cost_reconciled:  reconciled,
      store_name:       w.store_name || '',
      pm_dri:           ov(w.o_pm_dri, ''),
      ops_manager:      ov(w.o_ops_manager, ''),
      service_type:     titleCase(w.work_type),
      cart_count:       w.cart_count || 0,
      service_month:    monthName(effectiveDate),
      service_date:     w.scheduled_date || workDateByWo[w.wo_id] || '',
      num_techs:        numTechs,
      tech_names:       techNames,
      actual_labor:     actualLabor,
      actual_travel:    actualTravel,
      actual_expenses:  actualExpenses,
      service_delay:    ov(w.o_delay, 'None'),
      has_third_party:  has3p,
      third_party_vendor: ov(w.o_3p_vendor, ''),
      third_party_cost: tpCost,
      actual_total:     actualTotal,
      invoice_link:     w.wo_ext || '',
      notes:            ov(w.o_notes, w.title || ''),
      // v0.67 — approval gating. `in_totals` is the single flag every total
      // (footer row, monthly dashboard, exports) keys off of.
      approved:         hasApprovedInv,
      pending_approval: pendingApproval,
      in_totals:        inTotals,
      // Flags so the UI can show edit-state badges & call attention to
      // rows that have NO actuals data at all (so Ops Mgrs know to fill in).
      missing_data:     inTotals && actualLabor === 0 && actualTravel === 0 && actualExpenses === 0 && tpCost === 0,
      is_edited:        isEdited,
      // v0.67 — raw override values (null when not set) so the edit modal can
      // pre-fill ONLY what was explicitly overridden. Pre-filling computed values
      // used to freeze them into an override, so later-added labor/expenses
      // stopped summing in — this is the fix for that.
      override: {
        actual_labor:     hasLaborOv   ? +(+w.o_actual_labor).toFixed(2)    : null,
        actual_travel:    hasTravelOv  ? +(+w.o_actual_travel).toFixed(2)   : null,
        actual_expenses:  hasExpenseOv ? +(+w.o_actual_expenses).toFixed(2) : null,
        third_party_cost: has3pOv      ? +(+w.o_3p_cost).toFixed(2)         : null,
        num_techs:        w.o_num_techs != null ? +w.o_num_techs : null,
        tech_names:       (w.o_tech_names != null && w.o_tech_names !== '') ? w.o_tech_names : null,
      },
      computed: {
        actual_labor:    computedLabor,
        actual_travel:   computedTravel,
        actual_expenses: computedExpenses,
        num_techs:       w.num_techs || 0,
        tech_names:      w.tech_names || '',
      },
    };
  });
}

// v0.67 — ordered list of the work-type categories present in a set of cost
// rows (approved/counted only). Known types lead in a fixed order; any custom or
// unexpected types follow alphabetically. Used so the dashboard breaks every
// work type out into its own column instead of lumping them under "Other".
function orderedServiceTypes(rows) {
  const present = new Set();
  for (const r of rows) { if (r && !r.pending_approval) present.add(r.service_type || 'Other'); }
  const PREFERRED = ['Deployment', 'Retrofit', 'Maintenance', 'Repair'];
  const lead  = PREFERRED.filter(t => present.has(t));
  const extra = [...present].filter(t => !PREFERRED.includes(t)).sort();
  const out = [...lead, ...extra];
  return out.length ? out : ['Deployment'];
}

// v0.42 — actuals-only monthly aggregate. Forecast columns dropped per
// product direction; the team is reconciling only what's been spent.
// v0.67 — counts APPROVED rows only (skips pending_approval) and never drops a
// row: anything without a month lands in an "Unscheduled" bucket so the grand
// total always equals the sum of every counted row (1:1 source of truth). Cost
// is now broken out by EVERY work type (not just Deployment/Retrofit/Other).
function aggregateCostTrackerByMonth(rows) {
  const months = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
  const types = orderedServiceTypes(rows);
  const map = {};
  for (const r of rows) {
    if (r.pending_approval) continue;            // approved + completed actuals only
    const month = r.service_month || 'Unscheduled';
    const ty = r.service_type || 'Other';
    map[month] = map[month] || { byType: {}, Count: 0 };
    map[month].byType[ty] = (map[month].byType[ty] || 0) + (r.actual_total || 0);
    map[month].Count += 1;
  }
  const ordered = months.filter(m => map[m]);
  if (map['Unscheduled']) ordered.push('Unscheduled');   // always last
  const totals = { actual: 0, wo_count: 0, by_type: {} };
  types.forEach(t => { totals.by_type[t] = 0; });
  const out = ordered.map(m => {
    const by_type = {};
    let ac = 0;
    // every known type column…
    types.forEach(t => {
      const v = +(map[m].byType[t] || 0);
      by_type[t] = +v.toFixed(2);
      ac += v;
      totals.by_type[t] += v;
    });
    // …plus any stray type not in the ordered list, so no dollars are dropped.
    for (const [t, v] of Object.entries(map[m].byType)) {
      if (!(t in by_type)) { by_type[t] = +(+v).toFixed(2); ac += v; totals.by_type[t] = (totals.by_type[t] || 0) + v; }
    }
    totals.actual   += ac;
    totals.wo_count += map[m].Count;
    return { month: m, by_type, actual_total: +ac.toFixed(2), wo_count: map[m].Count };
  });
  Object.keys(totals.by_type).forEach(t => { totals.by_type[t] = +totals.by_type[t].toFixed(2); });
  totals.actual = +totals.actual.toFixed(2);
  return { rows: out, totals, types };
}

function makeExportFilename(meta) {
  const d = new Date().toISOString().slice(0, 10);
  const techPart  = meta.tech_filter
    ? `__${(meta.available_techs.find(t => t.id === meta.tech_filter)?.name || `u${meta.tech_filter}`).replace(/\s+/g,'_')}`
    : '';
  const storePart = meta.store_filter ? `__${meta.store_filter.replace(/[^A-Za-z0-9]+/g,'_')}` : '';
  return `otg-dashboard__${meta.period}${techPart}${storePart}__${d}.xlsx`;
}

function projectNextNWeeks(weekly, n) {
  const ys = weekly.map(w => w.spend);
  const xs = weekly.map((_, i) => i);
  const N = ys.length;
  if (!N) return { weeks: [], total: 0 };
  const sumX = xs.reduce((a,b)=>a+b,0);
  const sumY = ys.reduce((a,b)=>a+b,0);
  const sumXY = xs.reduce((a,x,i)=>a+x*ys[i],0);
  const sumXX = xs.reduce((a,x)=>a+x*x,0);
  const slope = (N * sumXY - sumX * sumY) / Math.max(1, (N * sumXX - sumX * sumX));
  const intercept = (sumY - slope * sumX) / N;
  const lastWeek = new Date(weekly[N - 1]?.week_start || new Date());
  const out = [];
  let total = 0;
  for (let i = 1; i <= n; i++) {
    const projected = Math.max(0, intercept + slope * (N - 1 + i));
    const d = new Date(lastWeek); d.setDate(d.getDate() + i * 7);
    out.push({ week_start: iso(d), projected_spend: +projected.toFixed(2) });
    total += projected;
  }
  return { weeks: out, total: +total.toFixed(2) };
}

// routes/launch_actuals.js — v0.37
//
// Ops Mgrs need to file a weekly "Launch Actuals" report per store via a
// Google Form. The form fields are:
//   Email, Week Ending, Store ID, Retailer (Store Name),
//   Which Team (HardwareOps), What's your Role (Team),
//   What are you supporting for this Launch?, Hours Spent, Additional Hours,
//   What type of hours, Brief Description, Notes
//
// Rather than retyping numbers from the dashboard, Ops Mgrs use the Launch
// Actuals tab in this app:
//   1. Pick a week (defaults to last week ending Sunday)
//   2. Pick a store (autocomplete from work_orders)
//   3. App auto-computes Hours Spent from time_entries that fall in that
//      week and reference work_orders at that store.
//   4. Ops Mgr fills in role / supporting / additional hours / notes
//   5. App generates a Google Form prefill URL with all those values
//   6. Ops Mgr clicks "Open prefilled form" → reviews → submits on Google
//   7. App marks the local record as `submitted`
//
// The Google Form entry IDs live in `LAUNCH_FORM_FIELD_MAP` below. They can
// be overridden via env vars without code changes (see lib/launch_form.js).

const express = require('express');
const router  = express.Router();
const path    = require('path');
const { buildPrefillUrl, getFieldMap } = require('../lib/launch_form');

module.exports = (db) => {

  // ---------- helpers ----------
  function me(req) {
    const id = Number(req.header('x-user-id'));
    return id ? db.prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(id) : null;
  }

  function requireMgr(req, res) {
    const u = me(req);
    if (!u) { res.status(401).json({ error: 'no user selected' }); return null; }
    if (!['ops_manager','sr_manager','pm'].includes(u.role)) {
      res.status(403).json({ error: 'manager role required' }); return null;
    }
    return u;
  }

  // YYYY-MM-DD for the Sunday that ends the week containing `d`.
  function weekEnding(d) {
    const dt = new Date(d);
    const day = dt.getDay();           // 0=Sun
    const offset = (7 - day) % 7;      // 0 if Sunday
    dt.setDate(dt.getDate() + offset);
    return dt.toISOString().slice(0, 10);
  }
  function weekStartFromEnding(weekEnd) {
    const dt = new Date(weekEnd);
    dt.setDate(dt.getDate() - 6);
    return dt.toISOString().slice(0, 10);
  }

  // ---------- GET /launch-actuals/stores ----------
  // Returns the list of stores (deduped) with the # of work orders, # of carts,
  // and total hours logged in the given week. Powers the store picker.
  router.get('/launch-actuals/stores', (req, res) => {
    const u = requireMgr(req, res); if (!u) return;
    const weekEnd   = (req.query.week_ending && /^\d{4}-\d{2}-\d{2}$/.test(req.query.week_ending))
                        ? req.query.week_ending : weekEnding(new Date());
    const weekStart = weekStartFromEnding(weekEnd);

    // Hours = sum((clock_out - clock_in)) for time_entries whose work_order
    // points at the store, falling in the week. We also surface store_id and
    // store_name so the form prefill has both.
    const rows = db.prepare(`
      SELECT
        w.store_id,
        w.store_name,
        COUNT(DISTINCT w.id)              AS wo_count,
        COALESCE(SUM(w.cart_count), 0)    AS cart_count,
        COALESCE(SUM(
          CASE WHEN t.clock_out IS NOT NULL AND (t.mode IS NULL OR t.mode = 'work')
               THEN (julianday(t.clock_out) - julianday(t.clock_in)) * 24
               ELSE 0 END
        ), 0)                             AS hours_spent
      FROM work_orders w
      LEFT JOIN time_entries t
        ON t.work_order_id = w.id
       AND t.clock_in IS NOT NULL
       AND date(t.clock_in) BETWEEN ? AND ?
      WHERE w.store_name IS NOT NULL
      GROUP BY w.store_id, w.store_name
      HAVING wo_count > 0 OR hours_spent > 0
      ORDER BY hours_spent DESC, w.store_name
    `).all(weekStart, weekEnd);

    res.json({
      week_ending: weekEnd,
      week_start:  weekStart,
      stores:      rows.map(r => ({
        store_id:   r.store_id,
        store_name: r.store_name,
        wo_count:   r.wo_count,
        cart_count: r.cart_count,
        hours_spent: +r.hours_spent.toFixed(2),
      })),
    });
  });

  // ---------- GET /launch-actuals/store-detail ----------
  // Detailed work-order + hours breakdown for a single store/week. Used when
  // the user opens the prefill sheet to confirm what they're submitting.
  router.get('/launch-actuals/store-detail', (req, res) => {
    const u = requireMgr(req, res); if (!u) return;
    const weekEnd   = req.query.week_ending || weekEnding(new Date());
    const weekStart = weekStartFromEnding(weekEnd);
    const storeName = req.query.store_name;
    if (!storeName) return res.status(400).json({ error: 'store_name required' });

    const wos = db.prepare(`
      SELECT id, external_id, title, work_type, cart_count, scheduled_date, status
      FROM work_orders
      WHERE store_name = ?
      ORDER BY scheduled_date DESC, id DESC
    `).all(storeName);

    const hours = db.prepare(`
      SELECT t.id, t.user_id, u.name AS tech_name, t.work_order_id, t.clock_in, t.clock_out,
             (julianday(t.clock_out) - julianday(t.clock_in)) * 24 AS hours,
             w.external_id, w.work_type
      FROM time_entries t
      JOIN users u       ON u.id = t.user_id
      LEFT JOIN work_orders w ON w.id = t.work_order_id
      WHERE w.store_name = ?
        AND t.clock_in IS NOT NULL AND t.clock_out IS NOT NULL
        AND (t.mode IS NULL OR t.mode = 'work')
        AND date(t.clock_in) BETWEEN ? AND ?
      ORDER BY t.clock_in
    `).all(storeName, weekStart, weekEnd);

    const totalHours = hours.reduce((a, h) => a + h.hours, 0);
    // Most-common work_type → "what are you supporting" suggestion.
    const wtCounts = {};
    for (const h of hours) wtCounts[h.work_type || 'maintenance'] = (wtCounts[h.work_type || 'maintenance'] || 0) + h.hours;
    const topWt = Object.entries(wtCounts).sort((a,b) => b[1]-a[1])[0]?.[0];
    const supportingSuggestion = ({
      deployment: 'New Store Launch',
      retrofit:   'Retrofit',
      maintenance: 'Service & Support',
      repair:     'Repair / Break-fix',
    })[topWt] || 'New Store Launch';

    res.json({
      week_start: weekStart, week_ending: weekEnd, store_name: storeName,
      work_orders: wos,
      time_entries: hours.map(h => ({
        ...h, hours: +h.hours.toFixed(2),
      })),
      total_hours: +totalHours.toFixed(2),
      supporting_suggestion: supportingSuggestion,
      work_type_breakdown: Object.entries(wtCounts).map(([wt, hrs]) => ({
        work_type: wt, hours: +hrs.toFixed(2),
      })).sort((a,b) => b.hours - a.hours),
    });
  });

  // ---------- POST /launch-actuals  (save draft + build prefill URL) ----------
  router.post('/launch-actuals', (req, res) => {
    const u = requireMgr(req, res); if (!u) return;
    const {
      week_ending, store_id, store_name, role, supporting,
      hours_spent, additional_hours, hours_type,
      brief_description, notes, email,
    } = req.body || {};

    if (!week_ending || !/^\d{4}-\d{2}-\d{2}$/.test(week_ending))
      return res.status(400).json({ error: 'week_ending (YYYY-MM-DD) required' });
    if (!store_name) return res.status(400).json({ error: 'store_name required' });
    const hrs    = Number(hours_spent      || 0);
    const addHrs = Number(additional_hours || 0);
    if (!isFinite(hrs)    || hrs    < 0) return res.status(400).json({ error: 'hours_spent must be >= 0' });
    if (!isFinite(addHrs) || addHrs < 0) return res.status(400).json({ error: 'additional_hours must be >= 0' });
    // v0.44 — BUG-004 fix: a single submitter can't physically work more
    // than 168 hrs in a 7-day week. Reject obvious fat-fingers / typos.
    if (hrs    > 168) return res.status(400).json({ error: 'hours_spent cannot exceed 168 (a full week)' });
    if (addHrs > 168) return res.status(400).json({ error: 'additional_hours cannot exceed 168' });
    if (hrs + addHrs > 168) return res.status(400).json({ error: 'hours_spent + additional_hours cannot exceed 168' });
    // v0.44 — BUG-005 fix: cap free-text fields so a runaway paste doesn't
    // bloat the row. brief_description is a one-line UI field; notes is
    // multi-line but should still fit on a Google Form.
    if ((brief_description || '').length > 200)
      return res.status(400).json({ error: 'brief_description max 200 chars' });
    if ((notes || '').length > 2000)
      return res.status(400).json({ error: 'notes max 2000 chars' });

    // Build the Google Form prefill URL. If the form's entry IDs aren't yet
    // configured, we still save the local row + return a non-prefilled URL
    // so the user can click through.
    const formValues = {
      email:             email || u.email,
      week_ending,
      store_id:          store_id || '',
      store_name,
      team:              'HardwareOps',
      role:              role || 'Ops Manager',
      supporting:        supporting || 'New Store Launch',
      hours_spent:       hrs.toFixed(2),
      additional_hours:  addHrs.toFixed(2),
      hours_type:        hours_type || 'Regular',
      brief_description: brief_description || '',
      notes:             notes || '',
    };
    const prefillUrl = buildPrefillUrl(formValues);

    // UPSERT — one row per (user, week, store).
    const existing = db.prepare(`
      SELECT id FROM launch_actuals WHERE user_id = ? AND week_ending = ? AND store_id IS ?
    `).get(u.id, week_ending, store_id || null);

    let id;
    if (existing) {
      db.prepare(`
        UPDATE launch_actuals SET
          store_name = ?, team = ?, role = ?, supporting = ?,
          hours_spent = ?, additional_hours = ?, hours_type = ?,
          brief_description = ?, notes = ?, email = ?,
          prefill_url = ?
        WHERE id = ?
      `).run(store_name, 'HardwareOps', formValues.role, formValues.supporting,
             hrs, addHrs, formValues.hours_type,
             formValues.brief_description, formValues.notes, formValues.email,
             prefillUrl, existing.id);
      id = existing.id;
    } else {
      const r = db.prepare(`
        INSERT INTO launch_actuals
          (user_id, email, week_ending, store_id, store_name, team, role, supporting,
           hours_spent, additional_hours, hours_type, brief_description, notes,
           status, prefill_url)
        VALUES (?, ?, ?, ?, ?, 'HardwareOps', ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
      `).run(u.id, formValues.email, week_ending, store_id || null, store_name,
             formValues.role, formValues.supporting,
             hrs, addHrs, formValues.hours_type,
             formValues.brief_description, formValues.notes, prefillUrl);
      id = r.lastInsertRowid;
    }

    const row = db.prepare("SELECT * FROM launch_actuals WHERE id = ?").get(id);
    res.json({ ...row, field_map: getFieldMap() });
  });

  // ---------- POST /launch-actuals/:id/mark-submitted ----------
  // Once the Ops Mgr clicks through to Google and submits, they tap "Mark
  // submitted" in the app to flip status. (We can't observe Google's submit.)
  router.post('/launch-actuals/:id/mark-submitted', (req, res) => {
    const u = requireMgr(req, res); if (!u) return;
    const id = Number(req.params.id);
    const r  = db.prepare("SELECT * FROM launch_actuals WHERE id = ?").get(id);
    if (!r)            return res.status(404).json({ error: 'not found' });
    if (r.user_id !== u.id && u.role !== 'pm' && u.role !== 'sr_manager') {
      return res.status(403).json({ error: 'only the submitter can mark submitted' });
    }
    db.prepare(`UPDATE launch_actuals SET status = 'submitted', submitted_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
    res.json(db.prepare("SELECT * FROM launch_actuals WHERE id = ?").get(id));
  });

  // ---------- GET /launch-actuals?week_ending=... ----------
  // List of all submissions (draft + submitted) for the user, optionally
  // scoped to a specific week. Sr Mgr / PM see everyone's.
  router.get('/launch-actuals', (req, res) => {
    const u = requireMgr(req, res); if (!u) return;
    const weekEnd = req.query.week_ending;
    const scope   = (u.role === 'sr_manager' || u.role === 'pm') ? '' : 'AND la.user_id = ?';
    const params  = (u.role === 'sr_manager' || u.role === 'pm') ? [] : [u.id];
    const weekSql = weekEnd ? 'AND la.week_ending = ?' : '';
    if (weekEnd) params.push(weekEnd);

    const rows = db.prepare(`
      SELECT la.*, u.name AS submitter_name
      FROM launch_actuals la
      JOIN users u ON u.id = la.user_id
      WHERE 1=1 ${scope} ${weekSql}
      ORDER BY la.week_ending DESC, la.store_name
    `).all(...params);
    res.json(rows);
  });

  // ---------- GET /launch-actuals/form-info ----------
  // Returns the field map + form URL so the UI can show what's wired up.
  router.get('/launch-actuals/form-info', (_req, res) => {
    res.json({ field_map: getFieldMap() });
  });

  return router;
};

// Clock in / clock out endpoints.
const express = require('express');
const router  = express.Router();
const { logAudit, sumHours, weekBounds } = require('../db');
const weekBoundsFor = (d) => weekBounds(new Date(d));

// v0.82 — Fold an in-progress live-tracked break into break_minutes. Shared by
// POST /break/resume and the clock-out path (so "Clock Out" works straight from
// a break). Flags the entry when THIS break interval exceeded 60 min. Callers
// must guard that break_started_at is set. Clears break_started_at.
function finalizeBreak(db, e) {
  const startedMs = new Date(e.break_started_at).getTime();
  const elapsedMs = Math.max(0, Date.now() - startedMs);
  const minutes   = Math.round(elapsedMs / 60000);
  const break_minutes = (e.break_minutes || 0) + minutes;
  const break_flagged = (e.break_flagged ? 1 : 0) || (elapsedMs > 60 * 60000 ? 1 : 0);
  db.prepare("UPDATE time_entries SET break_minutes = ?, break_flagged = ?, break_started_at = NULL WHERE id = ?")
    .run(break_minutes, break_flagged, e.id);
  return { break_minutes, break_flagged, minutes };
}

module.exports = (db) => {
  // GET /api/timeentries/active   → ALL currently-running entries (array)
  // Multiple active timers are allowed: a tech may run 2 jobs at one site.
  router.get('/timeentries/active', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const rows = db.prepare(`
      SELECT t.*, w.external_id, w.source_system, w.work_type, w.store_name, w.cart_count, w.description
      FROM time_entries t JOIN work_orders w ON w.id = t.work_order_id
      WHERE t.user_id = ? AND t.clock_out IS NULL
      ORDER BY t.clock_in DESC
    `).all(userId);
    res.json(rows);
  });

  // GET /api/timeentries          → my entries (or the tech's, if mgr is proxying)
  router.get('/timeentries', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    // Honor x-on-behalf-of so a manager browsing a tech's invoice sees the
    // tech's entries (used by the inline edit-time-entry sheet).
    const onBehalf = Number(req.header('x-on-behalf-of'));
    let effectiveUserId = userId;
    if (onBehalf && onBehalf !== userId) {
      const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
      const allowed = me && (
        me.role === 'sr_manager' || me.role === 'pm' ||
        (me.role === 'ops_manager' && db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, onBehalf))
      );
      if (allowed) effectiveUserId = onBehalf;
    }
    const rows = db.prepare(`
      SELECT t.*, w.external_id, w.source_system, w.work_type, w.store_name, w.cart_count
      FROM time_entries t JOIN work_orders w ON w.id = t.work_order_id
      WHERE t.user_id = ?
      ORDER BY t.clock_in DESC
    `).all(effectiveUserId);
    res.json(rows);
  });

  // GET /api/timeentries/:id  → a single entry (with WO fields + computed hours).
  // v0.68 — needed so the Ops-Mgr review edit sheet can load a tech's entry by id.
  // GET /timeentries is owner/proxy-scoped, but a manager reviewing a SUBMITTED
  // invoice isn't in proxy mode, so list-and-find won't see the tech's rows.
  // Authorization mirrors GET /expenses/:id and the PATCH path: sr/pm, or an
  // ops_manager on the owning tech's team.
  router.get('/timeentries/:id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const e = db.prepare(`
      SELECT t.*, w.external_id, w.source_system, w.work_type, w.store_name, w.cart_count
      FROM time_entries t JOIN work_orders w ON w.id = t.work_order_id
      WHERE t.id = ?
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
    res.json({ ...e, hours: sumHours([e]) });
  });

  // POST /api/timeentries
  // Modes:
  //   (a) live clock-in:  { work_order_id, mode?, gps? }
  //         mode = 'work' (default) or 'drive'
  //   (b) manual / backdated entry:
  //       { work_order_id, clock_in, clock_out, break_minutes?, notes?, mode? }
  router.post('/timeentries', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const { work_order_id, gps, clock_in, clock_out, break_minutes, notes } = req.body;
    const mode = req.body.mode === 'drive' ? 'drive' : 'work';
    if (!work_order_id) return res.status(400).json({ error: 'work_order_id required' });

    // Manager-on-behalf-of-tech (for mgr-uploaded invoices)
    const onBehalf = Number(req.header('x-on-behalf-of'));
    let effectiveUserId = userId;
    if (onBehalf && onBehalf !== userId) {
      const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
      const allowed = me && (
        me.role === 'sr_manager' || me.role === 'pm' ||
        (me.role === 'ops_manager' && db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, onBehalf))
      );
      if (!allowed) return res.status(403).json({ error: 'cannot create on behalf of this tech' });
      effectiveUserId = onBehalf;
    }

    const wo = db.prepare("SELECT id FROM work_orders WHERE id = ?").get(Number(work_order_id));
    if (!wo) return res.status(404).json({ error: 'work order not found' });

    // ----- Manual / backdated entry -----
    if (clock_in && clock_out) {
      const ci = new Date(clock_in);
      const co = new Date(clock_out);
      if (isNaN(ci) || isNaN(co)) return res.status(400).json({ error: 'invalid clock_in or clock_out' });
      if (co <= ci)               return res.status(400).json({ error: 'clock_out must be after clock_in' });
      if (ci > new Date())        return res.status(400).json({ error: 'clock_in cannot be in the future' });
      // v0.65.1 (F-H4) — reject future clock-outs and absurd shift lengths.
      if (co.getTime() > Date.now() + 5*60*1000) return res.status(400).json({ error: 'clock_out cannot be in the future' });
      if (co.getTime() - ci.getTime() > 24*60*60*1000) return res.status(400).json({ error: 'a single time entry cannot exceed 24 hours — split it into multiple entries' });

      const r = db.prepare(`
        INSERT INTO time_entries (user_id, work_order_id, clock_in, clock_out, break_minutes, notes, mode)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(effectiveUserId, Number(work_order_id), ci.toISOString(), co.toISOString(),
             Number(break_minutes) || 0, notes || null, mode);
      const newId = r.lastInsertRowid;
      // Auto-attach to a draft invoice whose period contains the clock_in
      // date — date-in-range so non-Mon-Sun periods (e.g. fortnightly
      // contractor invoices) still match.
      const ciDate = ci.toISOString().slice(0, 10);
      const draft = db.prepare(`
        SELECT id FROM invoices
        WHERE user_id = ? AND status = 'draft'
          AND ? BETWEEN period_start AND period_end
        ORDER BY id DESC LIMIT 1
      `).get(effectiveUserId, ciDate);
      if (draft) db.prepare(`UPDATE time_entries SET invoice_id = ? WHERE id = ?`).run(draft.id, newId);

      logAudit(db, { entity_type: 'time_entries', entity_id: newId, user_id: userId,
                     action: 'manual_entry',
                     details: { work_order_id, mode, clock_in: ci.toISOString(), clock_out: co.toISOString(),
                                attached_invoice: draft?.id || null } });
      return res.json(db.prepare("SELECT * FROM time_entries WHERE id = ?").get(newId));
    }

    // ----- Live clock-in -----
    const dupe = db.prepare(`
      SELECT id FROM time_entries
      WHERE user_id = ? AND work_order_id = ? AND clock_out IS NULL
    `).get(userId, Number(work_order_id));
    if (dupe) return res.status(409).json({ error: 'You already have a running timer on this work order.' });

    // Drive-mode exclusivity: only one drive timer at a time globally. You
    // can't be driving to two places at once. Work timers can still be concurrent.
    if (mode === 'drive') {
      const otherDrive = db.prepare(`
        SELECT t.id, t.work_order_id, w.external_id
        FROM time_entries t JOIN work_orders w ON w.id = t.work_order_id
        WHERE t.user_id = ? AND t.clock_out IS NULL AND t.mode = 'drive'
        LIMIT 1
      `).get(userId);
      if (otherDrive) {
        return res.status(409).json({
          error: `You already have a Drive timer running on ${otherDrive.external_id}. Clock out (or switch that one to Work) before starting another Drive timer.`,
          conflicting: otherDrive,
        });
      }
    }

    const now = new Date().toISOString();
    const r = db.prepare(`
      INSERT INTO time_entries
        (user_id, work_order_id, clock_in, mode, gps_lat_in, gps_lng_in, gps_accuracy_in)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, Number(work_order_id), now, mode,
           gps?.lat ?? null, gps?.lng ?? null, gps?.accuracy ?? null);

    db.prepare("UPDATE work_orders SET status = 'in_progress' WHERE id = ? AND status = 'open'").run(Number(work_order_id));

    logAudit(db, {
      entity_type: 'time_entries', entity_id: r.lastInsertRowid, user_id: userId,
      action: 'clock_in', details: { work_order_id, mode, gps: gps ? { lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy } : null },
    });
    res.json({ id: r.lastInsertRowid, clock_in: now, mode });
  });

  // POST /api/timeentries/:id/switch-mode  { gps? }
  // Atomically clocks out the current running entry and opens a new one on the
  // same WO with the opposite mode. Used for drive→work or work→drive transitions.
  router.post('/timeentries/:id/switch-mode', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const e = db.prepare("SELECT * FROM time_entries WHERE id = ?").get(id);
    if (!e) return res.status(404).json({ error: 'not found' });
    if (e.user_id !== userId) return res.status(403).json({ error: 'not yours' });
    if (e.clock_out) return res.status(409).json({ error: 'entry already clocked out' });
    // v0.82 — can't switch modes mid-break; resume first. The UI hides Switch
    // while paused; this guards direct API calls.
    if (e.break_started_at) return res.status(409).json({ error: 'Resume your break before switching modes.' });

    const newMode = e.mode === 'drive' ? 'work' : 'drive';

    // Drive-mode exclusivity also applies to switches — can't switch into Drive
    // if another drive timer is already running on a different WO.
    if (newMode === 'drive') {
      const otherDrive = db.prepare(`
        SELECT t.id, w.external_id FROM time_entries t JOIN work_orders w ON w.id = t.work_order_id
        WHERE t.user_id = ? AND t.clock_out IS NULL AND t.mode = 'drive' AND t.id != ?
        LIMIT 1
      `).get(userId, id);
      if (otherDrive) {
        return res.status(409).json({
          error: `Can't switch to Drive — already driving on ${otherDrive.external_id}. Clock out that drive timer first.`,
          conflicting: otherDrive,
        });
      }
    }

    const now = new Date().toISOString();
    const gps = req.body.gps;

    db.exec('BEGIN');
    try {
      // Close current entry
      db.prepare(`
        UPDATE time_entries
        SET clock_out = ?, gps_lat_out = ?, gps_lng_out = ?, gps_accuracy_out = ?
        WHERE id = ?
      `).run(now, gps?.lat ?? null, gps?.lng ?? null, gps?.accuracy ?? null, id);

      // Open new entry on same WO with opposite mode (clock_in = same now timestamp)
      const r = db.prepare(`
        INSERT INTO time_entries
          (user_id, work_order_id, clock_in, mode, gps_lat_in, gps_lng_in, gps_accuracy_in)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(userId, e.work_order_id, now, newMode,
             gps?.lat ?? null, gps?.lng ?? null, gps?.accuracy ?? null);
      db.exec('COMMIT');

      logAudit(db, { entity_type: 'time_entries', entity_id: r.lastInsertRowid, user_id: userId,
                     action: 'switch_mode',
                     details: { from_id: id, from_mode: e.mode, to_mode: newMode } });

      res.json({
        closed: db.prepare("SELECT * FROM time_entries WHERE id = ?").get(id),
        opened: db.prepare("SELECT * FROM time_entries WHERE id = ?").get(r.lastInsertRowid),
      });
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  });

  // POST /api/timeentries/:id/break/start   {}
  // v0.82 — Begin a live-tracked break: pauses the running timer (the main clock
  // freezes) by stamping break_started_at. The entry KEEPS its mode, so the tech
  // resumes the same activity (work or drive) afterwards. Billable time is not
  // touched until the break is resumed/finalized (see /break/resume).
  router.post('/timeentries/:id/break/start', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const e = db.prepare("SELECT * FROM time_entries WHERE id = ?").get(id);
    if (!e) return res.status(404).json({ error: 'not found' });
    if (e.user_id !== userId) {
      const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
      const allowed = me && (
        me.role === 'sr_manager' || me.role === 'pm' ||
        (me.role === 'ops_manager' && db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, e.user_id))
      );
      if (!allowed) return res.status(403).json({ error: 'not yours' });
    }
    if (e.clock_out)        return res.status(409).json({ error: 'entry already clocked out' });
    if (e.break_started_at) return res.status(409).json({ error: 'already on break' });

    const now = new Date().toISOString();
    db.prepare("UPDATE time_entries SET break_started_at = ? WHERE id = ?").run(now, id);
    logAudit(db, { entity_type: 'time_entries', entity_id: id, user_id: userId,
                   action: 'break_start', details: { mode: e.mode, at: now } });
    res.json(db.prepare("SELECT * FROM time_entries WHERE id = ?").get(id));
  });

  // POST /api/timeentries/:id/break/resume   {}
  // v0.82 — End a live-tracked break: fold the measured interval into
  // break_minutes (so it's deducted from billable time), flag the entry if the
  // break ran over 60 min, and clear break_started_at so the timer resumes in the
  // SAME mode it paused from. Returns the refreshed entry (+ computed hours).
  router.post('/timeentries/:id/break/resume', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const e = db.prepare("SELECT * FROM time_entries WHERE id = ?").get(id);
    if (!e) return res.status(404).json({ error: 'not found' });
    if (e.user_id !== userId) {
      const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
      const allowed = me && (
        me.role === 'sr_manager' || me.role === 'pm' ||
        (me.role === 'ops_manager' && db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, e.user_id))
      );
      if (!allowed) return res.status(403).json({ error: 'not yours' });
    }
    if (e.clock_out)         return res.status(409).json({ error: 'entry already clocked out' });
    if (!e.break_started_at) return res.status(409).json({ error: 'not on break' });

    const fin = finalizeBreak(db, e);
    logAudit(db, { entity_type: 'time_entries', entity_id: id, user_id: userId,
                   action: 'break_resume', details: { minutes: fin.minutes, flagged: !!fin.break_flagged } });
    const updated = db.prepare("SELECT * FROM time_entries WHERE id = ?").get(id);
    res.json({ ...updated, hours: sumHours([updated]) });
  });

  // PATCH /api/timeentries/:id
  //   While running: { notes?, gps?: { lat, lng, accuracy } }  → clocks out
  //     (finalizes any in-progress break first). Breaks are started/ended via
  //     the /break/start + /break/resume routes above, not here.
  //   After clock-out (and while invoice is draft):
  //     { break_minutes?, notes?, clock_in?, clock_out?, mode? } → adjust
  router.patch('/timeentries/:id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const e = db.prepare("SELECT * FROM time_entries WHERE id = ?").get(id);
    if (!e) return res.status(404).json({ error: 'not found' });

    // Allow the entry's owner directly, or a manager acting on the owner's
    // behalf (Ops Mgr with the tech on their team, or Sr Mgr / PM).
    if (e.user_id !== userId) {
      const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
      const allowed = me && (
        me.role === 'sr_manager' || me.role === 'pm' ||
        (me.role === 'ops_manager' && db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, e.user_id))
      );
      if (!allowed) return res.status(403).json({ error: 'not yours' });
    }

    const breaks = req.body.break_minutes != null ? Number(req.body.break_minutes) : e.break_minutes;
    const notes  = req.body.notes ?? e.notes;

    // Branch A: still running → this PATCH is a clock-out.
    if (!e.clock_out) {
      // v0.82 — the old { break_only:true } fixed-30 path is gone; breaks are now
      // live-tracked via POST /break/start + /break/resume. If the tech clocks out
      // straight from a break, finalize that break first so its measured minutes
      // are deducted and a >60-min break is flagged (also clears break_started_at).
      let effBreak   = breaks;
      let effFlagged = e.break_flagged ? 1 : 0;
      if (e.break_started_at) {
        const fin  = finalizeBreak(db, e);
        effBreak   = fin.break_minutes;
        effFlagged = fin.break_flagged;
      }
      const now = new Date().toISOString();
      const gps = req.body.gps;
      db.prepare(`
        UPDATE time_entries
        SET clock_out = ?, break_minutes = ?, break_flagged = ?, notes = ?,
            gps_lat_out = ?, gps_lng_out = ?, gps_accuracy_out = ?
        WHERE id = ?
      `).run(now, effBreak || 0, effFlagged, notes,
             gps?.lat ?? null, gps?.lng ?? null, gps?.accuracy ?? null,
             id);
      logAudit(db, {
        entity_type: 'time_entries', entity_id: id, user_id: userId, action: 'clock_out',
        details: { break_minutes: effBreak, break_flagged: effFlagged, gps: gps ? { lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy } : null },
      });
    } else {
      // Branch B: already clocked out → editing a logged entry.
      // v0.64 — Ops managers (sr/pm, or ops_mgr on the tech's team) can correct
      // logged hours until the invoice is approved (draft/submitted/in_review).
      // The owning tech can still only edit while it's a draft. Approved / queued
      // / sent / rejected invoices lock their line items.
      if (e.invoice_id) {
        const inv = db.prepare("SELECT status FROM invoices WHERE id = ?").get(e.invoice_id);
        if (inv) {
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
      // Allow editing clock_in / clock_out / mode on a draft entry. Used by
      // the inline "edit time entry" sheet on the editable line items list.
      let clockIn  = e.clock_in;
      let clockOut = e.clock_out;
      let mode     = e.mode;
      if (req.body.clock_in)  {
        const ci = new Date(req.body.clock_in);
        if (isNaN(ci)) return res.status(400).json({ error: 'invalid clock_in' });
        clockIn = ci.toISOString();
      }
      if (req.body.clock_out !== undefined) {
        if (req.body.clock_out === null || req.body.clock_out === '') {
          return res.status(400).json({ error: 'clock_out cannot be cleared on a closed entry' });
        }
        const co = new Date(req.body.clock_out);
        if (isNaN(co)) return res.status(400).json({ error: 'invalid clock_out' });
        clockOut = co.toISOString();
      }
      if (req.body.mode !== undefined) {
        if (!['work','drive'].includes(req.body.mode)) return res.status(400).json({ error: 'mode must be work or drive' });
        mode = req.body.mode;
      }
      if (new Date(clockOut) <= new Date(clockIn)) {
        return res.status(400).json({ error: 'clock_out must be after clock_in' });
      }
      // v0.65.1 (F-H4) — same magnitude/future guards as the create path.
      if (new Date(clockOut).getTime() > Date.now() + 5*60*1000) {
        return res.status(400).json({ error: 'clock_out cannot be in the future' });
      }
      if (new Date(clockOut).getTime() - new Date(clockIn).getTime() > 24*60*60*1000) {
        return res.status(400).json({ error: 'a single time entry cannot exceed 24 hours — split it into multiple entries' });
      }
      db.prepare(`
        UPDATE time_entries
        SET break_minutes = ?, notes = ?, clock_in = ?, clock_out = ?, mode = ?
        WHERE id = ?
      `).run(breaks || 0, notes, clockIn, clockOut, mode, id);
      logAudit(db, { entity_type: 'time_entries', entity_id: id, user_id: userId, action: 'edit',
                     details: { break_minutes: breaks, clock_in: clockIn, clock_out: clockOut, mode } });
    }

    // v0.64 — refresh the invoice total after editing logged hours.
    if (e.invoice_id && typeof db.__computeInvoice === 'function') {
      try { db.__computeInvoice(e.invoice_id); } catch (_) {}
    }

    // v0.64.3 — informational notice to the tech when a manager edits their time.
    if (e.user_id !== userId && e.invoice_id) {
      try {
        const tech = db.prepare("SELECT email FROM users WHERE id = ?").get(e.user_id);
        const mgr  = db.prepare("SELECT name FROM users WHERE id = ?").get(userId);
        db.prepare(`INSERT INTO notifications (kind, invoice_id, triggered_by, recipient, subject, body, status)
                    VALUES ('line_item_edited', ?, ?, ?, ?, ?, 'logged')`)
          .run(e.invoice_id, userId, tech?.email || null,
               `${mgr?.name || 'A manager'} edited a time entry on your invoice`,
               `${mgr?.name || 'A manager'} adjusted logged hours on this invoice. Informational — no action needed unless the invoice is rejected and returned for resubmission.`);
      } catch (_) {}
    }

    const updated = db.prepare("SELECT * FROM time_entries WHERE id = ?").get(id);
    const hours   = sumHours([updated]);
    res.json({ ...updated, hours });
  });

  // DELETE /api/timeentries/:id  → only on draft-invoice entries (or unattached)
  router.delete('/timeentries/:id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const e = db.prepare("SELECT * FROM time_entries WHERE id = ?").get(id);
    if (!e) return res.status(404).json({ error: 'not found' });
    if (e.user_id !== userId) {
      const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
      const allowed = me && (
        me.role === 'sr_manager' || me.role === 'pm' ||
        (me.role === 'ops_manager' && db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, e.user_id))
      );
      if (!allowed) return res.status(403).json({ error: 'not yours' });
    }
    if (!e.clock_out) return res.status(409).json({ error: 'cannot delete a running timer — clock out first' });
    if (e.invoice_id) {
      const inv = db.prepare("SELECT status FROM invoices WHERE id = ?").get(e.invoice_id);
      if (inv && inv.status !== 'draft') {
        return res.status(409).json({ error: 'time entry already on submitted invoice' });
      }
    }
    db.prepare("DELETE FROM time_entries WHERE id = ?").run(id);
    logAudit(db, { entity_type: 'time_entries', entity_id: id, user_id: userId, action: 'delete' });
    res.json({ deleted: true });
  });

  return router;
};

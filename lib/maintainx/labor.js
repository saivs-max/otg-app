// lib/maintainx/labor.js
//
// Labor-time reconciliation between Bread and MaintainX for a single work order.
//
// Priority rules (v0.80 — MaintainX is source of truth for completed WOs):
//
//   COMPLETED work order + MaintainX has time
//     → MX always wins. Delete any non-invoiced app-sourced work entries for
//       this WO, then insert/update the synthetic MaintainX entry. Every future
//       sync continues to overwrite with the latest MX value.
//
//   COMPLETED work order + no MaintainX time
//     → Keep whatever Bread has (no MX data to import).
//
//   Non-completed work order + worker logged real time in Bread
//     → App wins. Drop any previously-imported synthetic MX entry so invoices
//       never double-count. (Pushing Bread's time up to MaintainX is deferred.)
//
//   Non-completed work order + no app time
//     → Pull from MaintainX if available (live in-progress estimate).
//
// MaintainX time source priority (handled by extractMxTime in client.js):
//   1. Logged Time & Cost entries (timeEntries[] / totalLoggedMinutes / etc.)
//      — explicit entries the worker made; most accurate.
//   2. In-Progress duration (inProgressDurationMinutes / startedAt→completedAt)
//      — auto-computed wall-clock time; less accurate (includes breaks/idle).
//
// The synthetic entry (source='maintainx_sync') rides Bread's existing sumHours /
// invoice pipeline unchanged, stays fully auditable, and is idempotent on re-runs.

const MAX_MINUTES = 7 * 24 * 60;   // clamp implausible durations (bad timestamps)

function sumWorkHours(entries) {
  let ms = 0;
  for (const e of entries) {
    const start = new Date(e.clock_in).getTime();
    const end   = e.clock_out ? new Date(e.clock_out).getTime() : Date.now();
    if (isNaN(start) || isNaN(end)) continue;
    ms += (end - start) - (e.break_minutes || 0) * 60000;
  }
  return Math.max(0, ms / 3600000);
}

function anchorIso(anchorDate) {
  // Prefer a 'YYYY-MM-DD' (e.g. the WO scheduled date) anchored at local noon
  // so the synthetic shift reads naturally; fall back to now.
  if (anchorDate && /^\d{4}-\d{2}-\d{2}$/.test(String(anchorDate))) {
    return new Date(`${anchorDate}T12:00:00`).toISOString();
  }
  return new Date().toISOString();
}

// Upsert the synthetic MaintainX time entry and return a result summary.
// Shared by both the completed-MX-wins path and the non-completed pull path.
// skipStaleCleanup: when true, skip the DELETE of other synthetic entries for
// this WO — the caller (reconcilePerTechLaborCompleted) handles cleanup once
// upfront so writing N per-tech entries doesn't clobber each other.
function writeMxTimeEntry(db, { workOrderId, userId, mxTime, anchorDate }, { skipStaleCleanup = false } = {}) {
  const minutes = mxTime && mxTime.minutes ? Math.round(mxTime.minutes) : 0;
  if (!(minutes > 0)) return null;

  const clampedMin = Math.min(MAX_MINUTES, Math.max(1, minutes));
  // external_ref is globally unique (source, external_ref index), so it MUST be
  // scoped to this work order — otherwise two WOs sharing an entry marker
  // (e.g. the 'logged' aggregate) would collide on one row.
  const extRef   = mxTime.entryId ? `mx:${workOrderId}:${mxTime.entryId}` : `mx-inprogress:${workOrderId}`;
  const clockIn  = anchorIso(anchorDate);
  const clockOut = new Date(new Date(clockIn).getTime() + clampedMin * 60000).toISOString();
  const notes = `Imported from MaintainX (${mxTime.source === 'logged' ? 'logged Time & Cost' : 'in-progress duration'})`;

  // Remove stale synthetic entries for this WO whose ref no longer matches
  // (e.g. entryId changed from 'logged' to 'times-userId' on a re-import).
  // v0.82.1 — If a stale entry is already on an invoice, redirect its ref to
  // the new value instead of deleting it, so it gets updated in-place and
  // never produces a duplicate line on an existing invoice.
  // Skipped when the caller pre-cleans the full set (multi-tech path).
  if (!skipStaleCleanup) {
    const staleRows = db.prepare(
      "SELECT id, invoice_id FROM time_entries WHERE work_order_id = ? AND source = 'maintainx_sync' AND (external_ref IS NOT ? OR external_ref IS NULL)"
    ).all(workOrderId, extRef);
    let redirected = false;
    for (const row of staleRows) {
      if (row.invoice_id && !redirected) {
        // Redirect the first invoiced stale row to the new ref so the upsert
        // below updates it in place (preserving its invoice attachment).
        db.prepare("UPDATE time_entries SET external_ref = ? WHERE id = ?").run(extRef, row.id);
        redirected = true;
      } else {
        db.prepare("DELETE FROM time_entries WHERE id = ?").run(row.id);
      }
    }
  }

  // v0.82 — Inherit invoice_id from any existing invoiced entry on this WO so
  // the MX entry shows up immediately on an already-submitted/viewed invoice.
  // Only inherit when the MX entry itself doesn't yet have an invoice_id.
  const invoicedEntry = db.prepare(
    "SELECT invoice_id FROM time_entries WHERE work_order_id = ? AND invoice_id IS NOT NULL AND source != 'maintainx_sync' LIMIT 1"
  ).get(workOrderId);
  const inheritedInvoiceId = invoicedEntry ? invoicedEntry.invoice_id : null;

  const existing = db.prepare("SELECT id, invoice_id FROM time_entries WHERE source = 'maintainx_sync' AND external_ref = ?").get(extRef);

  if (existing) {
    db.prepare(`
      UPDATE time_entries
      SET clock_in = ?, clock_out = ?, break_minutes = 0, mode = 'work', notes = ?, user_id = ?,
          invoice_id = COALESCE(invoice_id, ?)
      WHERE id = ?
    `).run(clockIn, clockOut, notes, userId, inheritedInvoiceId, existing.id);
    return { direction: 'pull', minutes: clampedMin, source: mxTime.source, action: 'updated', timeEntryId: existing.id };
  }

  const ins = db.prepare(`
    INSERT INTO time_entries (user_id, work_order_id, clock_in, clock_out, break_minutes, mode, notes, source, external_ref, invoice_id)
    VALUES (?, ?, ?, ?, 0, 'work', ?, 'maintainx_sync', ?, ?)
  `).run(userId, workOrderId, clockIn, clockOut, notes, extRef, inheritedInvoiceId);

  return { direction: 'pull', minutes: clampedMin, source: mxTime.source, action: 'inserted', timeEntryId: Number(ins.lastInsertRowid) };
}

// db: node:sqlite handle.
// woStatus: the Bread status of the work order AFTER the sync upsert ('open' |
//           'in_progress' | 'completed' | 'cancelled').
// Returns a summary object describing the reconciliation decision.
function reconcileLaborForWorkOrder(db, { workOrderId, userId, mxTime, anchorDate, woStatus }) {
  const minutes = mxTime && mxTime.minutes ? Math.round(mxTime.minutes) : 0;

  // ── COMPLETED: MaintainX is always the source of truth ───────────────────
  // When the WO is complete and MaintainX has time data, that value wins
  // unconditionally — even if the worker also logged time in Bread. Any
  // non-invoiced app-sourced work entries for this WO are removed to prevent
  // double-counting in invoices and cost reports.
  if (woStatus === 'completed' && minutes > 0) {
    // Delete app-sourced work entries not yet attached to an invoice.
    // Invoiced entries are left in place to preserve historical invoice integrity,
    // but going forward the MX synthetic entry is the authoritative record.
    const removedApp = db.prepare(`
      DELETE FROM time_entries
      WHERE work_order_id = ?
        AND (source IS NULL OR source = 'app')
        AND (mode IS NULL OR mode = 'work')
        AND invoice_id IS NULL
    `).run(workOrderId).changes;

    const result = writeMxTimeEntry(db, { workOrderId, userId, mxTime, anchorDate });
    return { ...result, direction: 'mx_wins', removedAppEntries: removedApp,
             reason: 'completed_wo_mx_authoritative' };
  }

  // ── COMPLETED: no MaintainX time — keep whatever Bread has ───────────────
  if (woStatus === 'completed') {
    return { direction: 'none', reason: 'completed_no_mx_time' };
  }

  // ── NON-COMPLETED: app-sourced time takes priority ────────────────────────
  // Worker is still active; respect what they logged in Bread.
  const workerEntries = db.prepare(`
    SELECT clock_in, clock_out, break_minutes
    FROM time_entries
    WHERE work_order_id = ?
      AND (source IS NULL OR source = 'app')
      AND (mode IS NULL OR mode = 'work')
  `).all(workOrderId);

  const workerHours = sumWorkHours(workerEntries);

  if (workerHours > 0) {
    // App wins: drop any previously-imported synthetic entry so invoices
    // never double-count. Pushing Bread's time to MaintainX is deferred.
    const del = db.prepare("DELETE FROM time_entries WHERE work_order_id = ? AND source = 'maintainx_sync'").run(workOrderId);
    return { direction: 'app_wins', workerHours, removedSynthetic: del.changes || 0 };
  }

  // ── NON-COMPLETED: no app time — pull MaintainX as live estimate ──────────
  if (!(minutes > 0)) {
    const del = db.prepare("DELETE FROM time_entries WHERE work_order_id = ? AND source = 'maintainx_sync'").run(workOrderId);
    return { direction: 'none', reason: 'no_mx_time', removedSynthetic: del.changes || 0 };
  }

  return writeMxTimeEntry(db, { workOrderId, userId, mxTime, anchorDate });
}

// ── Multi-technician completed WO reconciliation (v0.81) ─────────────────────
//
// Called when extractMxTimePerTech() returns entries that carry assignee info.
// perTechEntries: [{ mxUserId, email, name, minutes, source, entryId, breadUserId }]
//   breadUserId: already resolved by sync.js (ownerId used as fallback for unknown techs)
//
// One synthetic time_entries row is written per tech (each with a unique
// external_ref). The batch cleanup runs once before the loop so individual
// writeMxTimeEntry calls don't clobber each other.
function reconcilePerTechLaborCompleted(db, { workOrderId, ownerId, perTechEntries, anchorDate }) {
  // 1. Delete all non-invoiced app work entries for this WO.
  const removedApp = db.prepare(`
    DELETE FROM time_entries
    WHERE work_order_id = ?
      AND (source IS NULL OR source = 'app')
      AND (mode IS NULL OR mode = 'work')
      AND invoice_id IS NULL
  `).run(workOrderId).changes;

  // 2. Compute the set of external_refs we are about to write.
  const incomingRefs = new Set(
    perTechEntries
      .filter(e => e.minutes > 0)
      .map(e => e.entryId ? `mx:${workOrderId}:${e.entryId}` : `mx-inprogress:${workOrderId}`)
  );

  // 3. Remove stale synthetic entries not in the incoming set.
  //    v0.82.1 — If stale entry is on an invoice, update its ref to the closest
  //    incoming ref (keeps it attached to the invoice) rather than deleting it.
  const existingMx = db.prepare(
    "SELECT id, external_ref, invoice_id FROM time_entries WHERE work_order_id = ? AND source = 'maintainx_sync'"
  ).all(workOrderId);
  const availableRefs = [...incomingRefs];
  for (const row of existingMx) {
    if (!incomingRefs.has(row.external_ref)) {
      if (row.invoice_id && availableRefs.length > 0) {
        // Redirect to the first available incoming ref so the upsert updates it.
        db.prepare("UPDATE time_entries SET external_ref = ? WHERE id = ?").run(availableRefs[0], row.id);
      } else {
        db.prepare("DELETE FROM time_entries WHERE id = ?").run(row.id);
      }
    }
  }

  // 4. Upsert one synthetic entry per tech (stale cleanup already done above).
  const techResults = [];
  let totalMinutes = 0;
  for (const entry of perTechEntries) {
    if (!(entry.minutes > 0)) continue;
    const mxTime = { minutes: entry.minutes, source: entry.source, entryId: entry.entryId };
    const result = writeMxTimeEntry(
      db,
      { workOrderId, userId: entry.breadUserId || ownerId, mxTime, anchorDate },
      { skipStaleCleanup: true }
    );
    if (result) {
      techResults.push({ ...result, mxUserId: entry.mxUserId, email: entry.email, breadUserId: entry.breadUserId });
      totalMinutes += result.minutes || 0;
    }
  }

  return {
    direction: 'mx_wins',
    minutes: totalMinutes,
    removedAppEntries: removedApp,
    techResults,
    reason: 'completed_wo_mx_authoritative_per_tech',
  };
}

module.exports = { reconcileLaborForWorkOrder, reconcilePerTechLaborCompleted, sumWorkHours };

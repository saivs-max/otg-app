// lib/maintainx/labor.js
//
// Labor-time reconciliation between Bread and MaintainX for a single work order.
//
// Rule (per product decision):
//   • If the WORKER logged labor in Bread (real, app-sourced 'work' time) →
//     Bread is the source of truth. We do NOT import MaintainX time, and we
//     remove any previously-imported synthetic entry so invoices never double
//     count. (Pushing Bread's time up to MaintainX is a later, deferred phase.)
//   • Otherwise → import MaintainX's "time taken" as a single synthetic 'work'
//     time entry (source='maintainx_sync'), preferring logged Time & Cost time,
//     else the In-Progress duration. Idempotent: re-syncing updates the same
//     entry in place rather than stacking duplicates.
//
// The synthetic entry rides Bread's existing labor math (sumHours over 'work'
// entries) and therefore flows into invoices unchanged, while staying fully
// auditable (source + external_ref) and reversible.

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

// db: node:sqlite handle. Returns a summary object describing the decision.
function reconcileLaborForWorkOrder(db, { workOrderId, userId, mxTime, anchorDate }) {
  const workerEntries = db.prepare(`
    SELECT clock_in, clock_out, break_minutes
    FROM time_entries
    WHERE work_order_id = ?
      AND (source IS NULL OR source = 'app')
      AND (mode IS NULL OR mode = 'work')
  `).all(workOrderId);

  const workerHours = sumWorkHours(workerEntries);

  // --- App wins: worker logged real time → drop any imported entry. ---
  if (workerHours > 0) {
    const del = db.prepare("DELETE FROM time_entries WHERE work_order_id = ? AND source = 'maintainx_sync'").run(workOrderId);
    return { direction: 'app_wins', workerHours, removedSynthetic: del.changes || 0 };
  }

  const minutes = mxTime && mxTime.minutes ? Math.round(mxTime.minutes) : 0;

  // --- No MaintainX time to import: clear any stale synthetic entry. ---
  if (!(minutes > 0)) {
    const del = db.prepare("DELETE FROM time_entries WHERE work_order_id = ? AND source = 'maintainx_sync'").run(workOrderId);
    return { direction: 'none', reason: 'no_mx_time', removedSynthetic: del.changes || 0 };
  }

  const clampedMin = Math.min(MAX_MINUTES, Math.max(1, minutes));
  // external_ref is globally unique (source, external_ref index), so it MUST be
  // scoped to this work order — otherwise two WOs sharing an entry marker
  // (e.g. the 'logged' aggregate) would collide on one row.
  const extRef = mxTime.entryId ? `mx:${workOrderId}:${mxTime.entryId}` : `mx-inprogress:${workOrderId}`;
  const clockIn  = anchorIso(anchorDate);
  const clockOut = new Date(new Date(clockIn).getTime() + clampedMin * 60000).toISOString();
  const notes = `Imported from MaintainX (${mxTime.source === 'logged' ? 'logged time' : 'in-progress duration'})`;

  // Remove any synthetic entries for this WO whose ref no longer matches
  // (e.g. switched from in-progress estimate to a logged entry), keeping exactly one.
  db.prepare("DELETE FROM time_entries WHERE work_order_id = ? AND source = 'maintainx_sync' AND external_ref IS NOT ?")
    .run(workOrderId, extRef);

  const existing = db.prepare("SELECT id FROM time_entries WHERE source = 'maintainx_sync' AND external_ref = ?").get(extRef);

  if (existing) {
    db.prepare(`
      UPDATE time_entries
      SET clock_in = ?, clock_out = ?, break_minutes = 0, mode = 'work', notes = ?, user_id = ?
      WHERE id = ?
    `).run(clockIn, clockOut, notes, userId, existing.id);
    return { direction: 'pull', minutes: clampedMin, source: mxTime.source, action: 'updated', timeEntryId: existing.id };
  }

  const ins = db.prepare(`
    INSERT INTO time_entries (user_id, work_order_id, clock_in, clock_out, break_minutes, mode, notes, source, external_ref)
    VALUES (?, ?, ?, ?, 0, 'work', ?, 'maintainx_sync', ?)
  `).run(userId, workOrderId, clockIn, clockOut, notes, extRef);

  return { direction: 'pull', minutes: clampedMin, source: mxTime.source, action: 'inserted', timeEntryId: Number(ins.lastInsertRowid) };
}

module.exports = { reconcileLaborForWorkOrder, sumWorkHours };

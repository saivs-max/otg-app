// Materialize an extracted PDF summary into real time_entries + expenses on a
// draft invoice. Idempotent: skips rows that already exist (matched by
// invoice + WO + date + start time for labor; by invoice + category + date +
// description + amount for expenses).
//
// Returns: { created: { time_entries, expenses, work_orders }, skipped: { duplicates } }

function importExtractedSummary(db, invoice, summary) {
  const result = {
    created:  { time_entries: 0, expenses: 0, work_orders: 0 },
    skipped:  { duplicates: 0 },
    errors:   [],
  };
  if (!summary) return result;

  const invId   = invoice.id;
  const techId  = invoice.user_id;
  const periodS = invoice.period_start;
  const periodE = invoice.period_end;

  // ---- 1. Resolve / create WO per ticket id ----
  // Map: ticket_id (string) → work_orders.id
  const woByTicket = {};
  for (const item of summary.line_items || []) {
    if (!item.ticket_id) continue;
    const tid = String(item.ticket_id);
    if (woByTicket[tid]) continue;
    woByTicket[tid] = ensureWorkOrderForTicket(db, tid, techId, summary.candidates).id;
  }
  result.created.work_orders = Object.keys(woByTicket).length;

  // ---- 2. Time entries from labor line_items ----
  // We need a per-day fallback WO for mileage/tolls when no labor line exists
  // for that date. Keep a map: date → first wo_id used on that date.
  const woByDate = {};
  for (const item of summary.line_items || []) {
    if (!item.date) continue;
    const woId = woByTicket[String(item.ticket_id || '')] || ensureMiscWO(db, periodS, techId).id;
    woByDate[item.date] = woByDate[item.date] || woId;

    if (!item.start || !item.end) {
      // We don't have a real shift window — synthesize one starting at 09:00.
      // The manager can edit it via the inline edit affordance.
      const synthStart = `${item.date}T09:00:00`;
      const hrs = Number(item.hours || 0);
      const synthEnd   = `${item.date}T${pad(9 + Math.floor(hrs))}:${pad(Math.round((hrs % 1) * 60))}:00`;
      maybeInsertTimeEntry(db, result, invId, techId, woId, synthStart, synthEnd, 0,
        `[from PDF] ${truncate(item.description || '', 200)}`);
      continue;
    }
    const clockIn  = combineDateTime(item.date, item.start);
    const clockOut = combineDateTime(item.date, item.end);
    if (!clockIn || !clockOut) {
      result.errors.push(`Could not parse time for ${item.date} ${item.start}-${item.end}`);
      continue;
    }
    maybeInsertTimeEntry(db, result, invId, techId, woId, clockIn, clockOut, 0,
      `[from PDF] ${truncate(item.description || '', 200)}`);
  }

  // ---- 3. Mileage expenses from per-day stops ----
  for (const day of summary.mileage || []) {
    if (!day.date) continue;
    const woId = woByDate[day.date] || ensureMiscWO(db, periodS, techId).id;
    if (!woByDate[day.date]) woByDate[day.date] = woId;
    for (const stop of day.stops || []) {
      // Only insert legs that have positive miles and a dollar amount.
      if (!stop.miles || stop.miles <= 0) continue;
      maybeInsertExpense(db, result, invId, techId, woId, 'mileage', null,
        day.date, stop.amount, stop.miles, 0.725,
        `[from PDF] Mileage leg`);
    }
  }

  // ---- 4. Toll/parking expenses ----
  for (const t of summary.tolls || []) {
    if (!t.date || !t.amount) continue;
    // Tolls might fall outside the invoice period (the Brennan PDF includes a
    // 2-month receipts roll-up). Only import tolls inside the period.
    if (periodS && t.date < periodS) continue;
    if (periodE && t.date > periodE) continue;
    const woId = woByDate[t.date] || ensureMiscWO(db, periodS, techId).id;
    if (!woByDate[t.date]) woByDate[t.date] = woId;
    const cat = (t.category || '').toLowerCase().includes('park') ? 'parking' : 'tolls';
    maybeInsertExpense(db, result, invId, techId, woId, cat, null,
      t.date, Number(t.amount), null, null,
      `[from PDF] ${truncate(t.vendor || cat, 100)}`);
  }

  return result;
}

// ------------------------- helpers -------------------------

function ensureWorkOrderForTicket(db, ticketId, techId, candidatesArr) {
  // Match existing WO by source_ticket_id or trailing-id pattern
  let wo = db.prepare("SELECT * FROM work_orders WHERE source_ticket_id = ?").get(ticketId);
  if (!wo) wo = db.prepare("SELECT * FROM work_orders WHERE external_id LIKE ?").get(`%-${ticketId}`);
  if (wo) {
    if (wo.assigned_user_id !== techId) {
      db.prepare("UPDATE work_orders SET assigned_user_id = ? WHERE id = ?").run(techId, wo.id);
    }
    return wo;
  }
  // Create placeholder. Heuristic for source_system: cross-reference candidates
  // hint, else default to maintainx for short ids and freshdesk for 4-6 digits.
  const hint = (candidatesArr || []).find(c => String(c.candidate_id) === String(ticketId))?.source_hint;
  const src  = hint || (ticketId.length >= 7 || ticketId.length <= 3 ? 'maintainx' : 'freshdesk');
  const ext  = `${src === 'maintainx' ? 'MX' : 'FD'}-MNT-${ticketId}`;
  const r = db.prepare(`
    INSERT INTO work_orders
      (external_id, source_system, source_ticket_id, work_type, store_name, cart_count, status, assigned_user_id)
    VALUES (?, ?, ?, 'maintenance', '(from invoice — refine)', 1, 'in_progress', ?)
  `).run(ext, src, ticketId, techId);
  return db.prepare("SELECT * FROM work_orders WHERE id = ?").get(r.lastInsertRowid);
}

function ensureMiscWO(db, periodStart, techId) {
  // Single per-week catch-all WO for mileage/tolls without a clear ticket
  const ext = `MISC-PDF-${periodStart}-U${techId}`;
  let wo = db.prepare("SELECT * FROM work_orders WHERE external_id = ?").get(ext);
  if (wo) return wo;
  const r = db.prepare(`
    INSERT INTO work_orders
      (external_id, source_system, source_ticket_id, work_type, store_name, cart_count, status, assigned_user_id)
    VALUES (?, 'maintainx', ?, 'maintenance', '(misc PDF: tolls/mileage)', 0, 'in_progress', ?)
  `).run(ext, `MISC-${periodStart}`, techId);
  return db.prepare("SELECT * FROM work_orders WHERE id = ?").get(r.lastInsertRowid);
}

function maybeInsertTimeEntry(db, result, invoiceId, userId, woId, clockIn, clockOut, breakMin, notes) {
  // Idempotency: same invoice + WO + clock_in (to the minute)
  const dup = db.prepare(`
    SELECT id FROM time_entries
    WHERE invoice_id = ? AND work_order_id = ? AND substr(clock_in, 1, 16) = ?
  `).get(invoiceId, woId, clockIn.slice(0, 16));
  if (dup) { result.skipped.duplicates++; return; }
  db.prepare(`
    INSERT INTO time_entries (user_id, work_order_id, clock_in, clock_out, break_minutes, notes, mode, invoice_id)
    VALUES (?, ?, ?, ?, ?, ?, 'work', ?)
  `).run(userId, woId, clockIn, clockOut, breakMin, notes, invoiceId);
  result.created.time_entries++;
}

function maybeInsertExpense(db, result, invoiceId, userId, woId, category, subcategory,
                            expenseDate, amount, quantity, rate, description) {
  const dup = db.prepare(`
    SELECT id FROM expenses
    WHERE invoice_id = ? AND work_order_id = ? AND category = ? AND expense_date = ?
      AND ABS(amount - ?) < 0.005
      AND COALESCE(description, '') = COALESCE(?, '')
  `).get(invoiceId, woId, category, expenseDate, amount, description);
  if (dup) { result.skipped.duplicates++; return; }
  db.prepare(`
    INSERT INTO expenses (user_id, work_order_id, category, subcategory, expense_date, amount, quantity, rate, description, invoice_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, woId, category, subcategory, expenseDate, amount, quantity, rate, description, invoiceId);
  result.created.expenses++;
}

// ------------------------- parsing -------------------------

// "9:30 AM" → "09:30:00". Handles "1:00 PM" → "13:00:00". Returns null if invalid.
function parseClock(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3].toUpperCase();
  if (h === 12) h = 0;
  if (ampm === 'PM') h += 12;
  return `${pad(h)}:${pad(min)}:00`;
}

function combineDateTime(dateISO, clockStr) {
  const t = parseClock(clockStr);
  if (!t) return null;
  return `${dateISO}T${t}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { importExtractedSummary, parseClock };

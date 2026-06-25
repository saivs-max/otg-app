// Invoice endpoints — assemble lines, compute flags, submit.
const express = require('express');
const router  = express.Router();
const { POLICY, getPolicy, weekBounds, invoiceNumber, sumHours, logAudit } = require('../db');
const rulesEvaluator = require('./rules');
const { extractFromPdfBuffer } = require('../lib/pdfExtractor');
const { importExtractedSummary } = require('../lib/pdfImporter');
const { extractVendorPdf }       = require('../lib/vendorPdfExtractor');
const { validateInvoice }        = require('../lib/invoiceValidation');
const { generateInvoicePdf } = require('../lib/invoicePdf');

module.exports = (db) => {

  // Helper: can `userId` edit/extract/import on `invoiceId`?
  // v0.65.2 — Policy flags are surfaced to MANAGERS ONLY (at the Ops Mgr
  // approval queue + manager invoice views). Field techs no longer see policy
  // flags on their own invoices, so strip them from any computed payload we
  // return to a non-manager viewer. No-op for managers — flags pass through.
  function stripFlagsForTech(computed, userId) {
    const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
    if (me && (me.role === 'ops_manager' || me.role === 'sr_manager' || me.role === 'pm')) return computed;
    if (computed && Array.isArray(computed.lines)) for (const l of computed.lines) l.flags = [];
    if (computed && computed.summary) computed.summary.flag_count = 0;
    return computed;
  }

  // Yes if: they own it, OR they're sr_mgr/pm, OR they're an ops_mgr with the
  // invoice's owner on their team. Returns { ok: bool, error?: string, inv? }.
  function canActOnInvoice(invoiceId, userId) {
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId);
    if (!inv) return { ok: false, error: 'invoice not found', status: 404 };
    if (inv.user_id === userId) return { ok: true, inv };
    const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
    if (!me) return { ok: false, error: 'no user selected', status: 401 };
    if (me.role === 'sr_manager' || me.role === 'pm') return { ok: true, inv };
    if (me.role === 'ops_manager') {
      const inTeam = db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?")
                       .get(userId, inv.user_id);
      if (inTeam) return { ok: true, inv };
    }
    return { ok: false, error: 'not allowed on this invoice', status: 403 };
  }

  // v0.67.1 (security) — Self-service invoice creation is for FIELD TECHNICIANS
  // only. A tech_labor invoice's payee is its user_id, so letting a manager / PM
  // create one for themselves mints an invoice payable to an approver — a
  // segregation-of-duties hole (they could then submit → escalate → send-to-ap
  // it with no second party). Managers file on a tech's behalf via
  // POST /invoices/upload, which already enforces a technician payee (see below).
  // Returns the user row, or null after sending the 401/403 response.
  function requireSelfInvoiceTech(req, res) {
    const userId = Number(req.header('x-user-id'));
    if (!userId) { res.status(401).json({ error: 'no user selected' }); return null; }
    const me = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
    if (!me) { res.status(401).json({ error: 'no user selected' }); return null; }
    if (me.role !== 'technician') {
      res.status(403).json({ error: 'only technicians can create invoices for their own work — managers file on a technician’s behalf via upload' });
      return null;
    }
    return me;
  }

  // Find or create the draft invoice covering a specific week. If `forDate` is null,
  // uses the current week. Always attaches any orphaned time/expenses falling in that week.
  function ensureDraftForWeek(userId, forDate) {
    const { start, end } = weekBounds(forDate ? new Date(forDate) : new Date());
    let inv = db.prepare(`
      SELECT * FROM invoices WHERE user_id = ? AND period_start = ?
    `).get(userId, start);

    if (!inv) {
      const num = invoiceNumber(userId, end);
      const r = db.prepare(`
        INSERT INTO invoices (invoice_number, user_id, period_start, period_end, status, total)
        VALUES (?, ?, ?, ?, 'draft', 0)
      `).run(num, userId, start, end);
      inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(r.lastInsertRowid);
    }
    if (inv.status === 'draft') {
      db.prepare(`
        UPDATE time_entries SET invoice_id = ?
        WHERE user_id = ? AND invoice_id IS NULL
          AND date(clock_in) BETWEEN ? AND ?
          AND clock_out IS NOT NULL
      `).run(inv.id, userId, start, end);
      db.prepare(`
        UPDATE expenses SET invoice_id = ?
        WHERE user_id = ? AND invoice_id IS NULL
          AND date(expense_date) BETWEEN ? AND ?
      `).run(inv.id, userId, start, end);
    }
    return inv;
  }
  function ensureCurrentDraft(userId) { return ensureDraftForWeek(userId, null); }

  // v0.34 — Always create a fresh draft for a given week, even if other
  // invoices already exist for that user+period. Used by /invoices/upload so
  // contractors can file multiple supplemental invoices for the same week.
  // Resolves invoice_number collisions by appending an alphabetic suffix.
  function createNewUploadDraft(userId, forDate) {
    const { start, end } = weekBounds(forDate ? new Date(forDate) : new Date());
    const baseNum = invoiceNumber(userId, end);
    // Scan invoice_numbers across the whole user's history (not just this
    // week) — period_start can shift after creation when the PDF parser
    // snaps to its detected dates, so a same-base collision could come from
    // any prior week's draft for this user.
    const existing = new Set(db.prepare(
      `SELECT invoice_number FROM invoices WHERE user_id = ? AND invoice_number LIKE ?`
    ).all(userId, `${baseNum}%`).map(r => r.invoice_number));
    let num = baseNum;
    for (let suffixCode = 'A'.charCodeAt(0); existing.has(num); suffixCode++) {
      if (suffixCode > 'Z'.charCodeAt(0)) { num = `${baseNum}-${Date.now()}`; break; }
      num = `${baseNum}-${String.fromCharCode(suffixCode)}`;
    }
    const r = db.prepare(`
      INSERT INTO invoices (invoice_number, user_id, period_start, period_end, status, total)
      VALUES (?, ?, ?, ?, 'draft', 0)
    `).run(num, userId, start, end);
    // Don't sweep orphans into this new draft — those should keep belonging
    // to whichever week-draft they originally landed on. Each upload starts
    // fresh so PDF auto-import lines attach cleanly via date-in-range.
    return db.prepare("SELECT * FROM invoices WHERE id = ?").get(r.lastInsertRowid);
  }

  // v0.64 — share computeInvoice with sibling route modules (expenses,
  // timeentries) so a line-item edit there can refresh the persisted invoice
  // total. computeInvoice is hoisted, so this reference resolves at call time.
  db.__computeInvoice = (invoiceId, hourlyRate) => computeInvoice(invoiceId, hourlyRate);

  function computeInvoice(invoiceId, hourlyRate) {
    const inv  = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId);
    const user = db.prepare("SELECT hourly_rate FROM users WHERE id = ?").get(inv.user_id);
    const POL  = getPolicy(db);
    const rate = hourlyRate || user.hourly_rate || POL.HOURLY_RATE_DEFAULT;

    // Mode='work' entries are billable labor; mode='drive' is billable too
    // (v0.55) and tracked separately for reporting. Only CLOSED entries count —
    // an open timer (clock_out IS NULL) must never contribute to invoice money,
    // since sumHours() would otherwise extrapolate its hours to the current time.
    const allTimes = db.prepare(`
      SELECT t.*, w.id AS work_order_id, w.external_id, w.source_system, w.work_type, w.store_name, w.cart_count, w.description AS wo_description
      FROM time_entries t JOIN work_orders w ON w.id = t.work_order_id
      WHERE t.invoice_id = ? AND t.clock_out IS NOT NULL
      ORDER BY t.clock_in
    `).all(invoiceId);
    const times      = allTimes.filter(t => (t.mode || 'work') === 'work');
    const driveTimes = allTimes.filter(t => t.mode === 'drive');
    const expenses = db.prepare(`
      SELECT e.*, w.external_id, w.source_system, w.work_type, w.store_name, w.cart_count
      FROM expenses e JOIN work_orders w ON w.id = e.work_order_id
      WHERE e.invoice_id = ?
      ORDER BY e.expense_date, e.id
    `).all(invoiceId);

    // Group by work order
    const byWO = {};
    const ensureWO = (key, src) => byWO[key] ||= {
      external_id: key,
      // v0.61 — capture the DB id so the per-WO budget evaluator can look up
      // wo_category_budgets without a second lookup by external_id.
      work_order_id: src.work_order_id,
      source_system: src.source_system,
      work_type: src.work_type,
      store_name: src.store_name,
      cart_count: src.cart_count,
      labor_hours: 0,
      labor_amount: 0,
      // v0.55 — drive is billable. Tracked distinctly from labor so reports
      // can show how much of paid time was drive vs on-site labor.
      drive_hours: 0,
      drive_amount: 0,
      // Default hours per 10 carts for this work type, scaled to actual carts.
      expected_hours: ((POLICY.HOURS_PER_10_CARTS[src.work_type] || 10) / 10) * (src.cart_count || 1),
      expenses: [],
      flags: [],
    };

    for (const t of times) {
      const w = ensureWO(t.external_id, t);
      const hrs = sumHours([t]);
      w.labor_hours += hrs;
      w.labor_amount += hrs * rate;
    }
    for (const t of driveTimes) {
      const w = ensureWO(t.external_id, t);
      const hrs = sumHours([t]);
      w.drive_hours += hrs;
      w.drive_amount += hrs * rate;
    }
    for (const e of expenses) {
      const w = ensureWO(e.external_id, e);
      // v0.54/v0.55 — Labor/Drive logged via the expense tab roll into the
      // labor / drive buckets so invoice totals match what the tech entered.
      if (e.category === 'labor') {
        w.labor_hours += Number(e.quantity || 0);
        w.labor_amount += Number(e.amount || 0);
      } else if (e.category === 'drive') {
        w.drive_hours  += Number(e.quantity || 0);
        w.drive_amount += Number(e.amount   || 0);
      }
      w.expenses.push(e);
    }

    let total = 0;
    for (const w of Object.values(byWO)) {
      w.labor_hours  = +w.labor_hours.toFixed(2);
      w.labor_amount = +w.labor_amount.toFixed(2);
      w.drive_hours  = +w.drive_hours.toFixed(2);
      w.drive_amount = +w.drive_amount.toFixed(2);
      // Exclude labor + drive expenses from expensesTotal — both have been
      // folded into labor_amount / drive_amount above. Including their amount
      // here would double-count. (v0.55)
      const expensesTotal = w.expenses
        .filter(e => e.category !== 'labor' && e.category !== 'drive')
        .reduce((a, e) => a + e.amount, 0);
      w.total = +(w.labor_amount + w.drive_amount + expensesTotal).toFixed(2);
      total += w.total;

      // (v0.20) The universal "hours > 1.5× expected" flag was retired.
      // Hours-overrun thresholds are now configured as custom rules
      // (max_hours_per_wo / max_hours_per_cart) so managers can scope them by
      // work_type and cart count.
      // Apply custom rules layered by Ops Mgr
      const customFlags = rulesEvaluator.evaluate(db, w,
        w.expenses,
        // Build a lightweight time-entries view scoped to this WO with hours computed
        times.filter(t => t.external_id === w.external_id).map(t => ({
          external_id: t.external_id,
          clock_in: t.clock_in, clock_out: t.clock_out, mode: t.mode || 'work',
          hours: sumHours([t]),
        })).concat(allTimes.filter(t => t.external_id === w.external_id && t.mode === 'drive').map(t => ({
          external_id: t.external_id,
          clock_in: t.clock_in, clock_out: t.clock_out, mode: 'drive',
          hours: sumHours([t]),
        })))
      );
      w.flags.push(...customFlags);
      // v0.61 — Per-WO category budget overruns + category receipt thresholds.
      // Evaluates wo_category_budgets (explicit per-WO caps) and category_rules
      // (org-wide per-category caps + receipt thresholds). Corp-card spend is
      // pulled live from corp_card_expenses, since it never lives on invoices.
      const budgetFlags = rulesEvaluator.evaluateBudgets(db, w, w.expenses);
      w.flags.push(...budgetFlags);
    }

    // ===== By-date breakdown (AP requirement) =====
    // Each day shows: every time entry on that day with WO context (work + drive),
    // every expense on that day, plus aggregated totals.
    const byDate = {};
    function bucket(d) {
      const key = d.slice(0, 10);
      return (byDate[key] ||= {
        date: key, labor_hours: 0, labor_amount: 0,
        drive_hours: 0, drive_amount: 0,   // v0.55 — drive is billable
        expenses: 0, total: 0,
        work_orders: new Set(), categories: {},
        time_entries: [], drive_entries: [], expense_entries: [],
      });
    }
    for (const t of times) {
      const day = bucket(t.clock_in);
      const hrs = sumHours([t]);
      day.labor_hours  += hrs;
      day.labor_amount += hrs * rate;
      day.work_orders.add(t.external_id);
      day.time_entries.push({
        id: t.id, external_id: t.external_id, store_name: t.store_name, work_type: t.work_type,
        clock_in: t.clock_in, clock_out: t.clock_out, hours: +hrs.toFixed(2), notes: t.notes,
        mode: 'work',
        // v0.64 — surfaced for the review UI only; never rendered on the AP PDF.
        unplanned_tag: t.unplanned_tag, unplanned_note: t.unplanned_note, unplanned_wasted: t.unplanned_wasted,
      });
    }
    for (const t of driveTimes) {
      const day = bucket(t.clock_in);
      const hrs = sumHours([t]);
      day.drive_hours  += hrs;
      day.drive_amount += hrs * rate;   // v0.55 — drive is billable
      day.work_orders.add(t.external_id);
      day.drive_entries.push({
        id: t.id, external_id: t.external_id, store_name: t.store_name, work_type: t.work_type,
        clock_in: t.clock_in, clock_out: t.clock_out, hours: +hrs.toFixed(2), notes: t.notes,
        mode: 'drive',
        unplanned_tag: t.unplanned_tag, unplanned_note: t.unplanned_note, unplanned_wasted: t.unplanned_wasted,
      });
    }
    for (const e of expenses) {
      const day = bucket(e.expense_date);
      day.work_orders.add(e.external_id);
      day.categories[e.category] = (day.categories[e.category] || 0) + e.amount;
      day.expense_entries.push({
        id: e.id, external_id: e.external_id, store_name: e.store_name,
        // v0.62.2 — expose work_type + work_order_id so the contractor
        // invoice table can render labor/drive logged as expenses as
        // proper rows (with the right work-type tag).
        work_type: e.work_type, work_order_id: e.work_order_id,
        category: e.category, subcategory: e.subcategory, amount: e.amount,
        quantity: e.quantity, rate: e.rate, description: e.description,
        expense_date: e.expense_date, receipt_path: e.receipt_path,
        unplanned_tag: e.unplanned_tag, unplanned_note: e.unplanned_note, unplanned_wasted: e.unplanned_wasted,
      });
      // v0.55 — labor and drive expenses fold into their respective day buckets
      // (matches the by-WO logic above). Other categories go to general expenses.
      if (e.category === 'labor') {
        day.labor_hours  += Number(e.quantity || 0);
        day.labor_amount += Number(e.amount   || 0);
      } else if (e.category === 'drive') {
        day.drive_hours  += Number(e.quantity || 0);
        day.drive_amount += Number(e.amount   || 0);
      } else {
        day.expenses += e.amount;
      }
    }
    const byDateArr = Object.values(byDate)
      .map(d => ({
        date: d.date,
        labor_hours:  +d.labor_hours.toFixed(2),
        labor_amount: +d.labor_amount.toFixed(2),
        drive_hours:  +d.drive_hours.toFixed(2),
        drive_amount: +d.drive_amount.toFixed(2),
        expenses:     +d.expenses.toFixed(2),
        total:        +(d.labor_amount + d.drive_amount + d.expenses).toFixed(2),
        work_orders: [...d.work_orders],
        categories: Object.fromEntries(Object.entries(d.categories).map(([k,v]) => [k, +v.toFixed(2)])),
        time_entries:    d.time_entries,
        drive_entries:   d.drive_entries,
        expense_entries: d.expense_entries,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Persist total
    db.prepare("UPDATE invoices SET total = ? WHERE id = ?").run(+total.toFixed(2), invoiceId);

    // Attachments linked to this invoice or any of its expenses / time_entries / WOs
    const attachments = db.prepare(`
      SELECT a.id, a.original_name, a.mime_type, a.size_bytes, a.caption, a.uploaded_at,
             a.invoice_id, a.expense_id, a.time_entry_id, a.work_order_id,
             w.external_id AS wo_external_id,
             e.category    AS expense_category, e.amount AS expense_amount, e.expense_date
      FROM attachments a
      LEFT JOIN expenses     e ON e.id = a.expense_id
      LEFT JOIN time_entries t ON t.id = a.time_entry_id
      LEFT JOIN work_orders  w ON w.id = COALESCE(e.work_order_id, t.work_order_id, a.work_order_id)
      WHERE a.user_id = ?
        AND (a.invoice_id = ?
             OR a.expense_id IN (SELECT id FROM expenses WHERE invoice_id = ?)
             OR a.time_entry_id IN (SELECT id FROM time_entries WHERE invoice_id = ?))
      ORDER BY a.uploaded_at DESC
    `).all(inv.user_id, invoiceId, invoiceId, invoiceId);

    // v0.59 — bucket attachments by expense_id so the client can render each
    // line item's image inline (preview, editable line items, and the
    // contractor invoice summary view). We only carry the minimal fields the
    // client needs for a thumbnail link.
    const attsByExpense = {};
    for (const a of attachments) {
      if (!a.expense_id) continue;
      (attsByExpense[a.expense_id] ||= []).push({
        id: a.id, original_name: a.original_name, mime_type: a.mime_type, size_bytes: a.size_bytes,
      });
    }
    for (const d of byDateArr) {
      for (const e of d.expense_entries) {
        e.attachments = attsByExpense[e.id] || [];
      }
    }

    // v0.43 — Vendor invoices have no time entries / expenses to recompute
    // their total from. The total stored on the row IS the source of truth
    // for vendor invoices, so don't overwrite it.
    const finalTotal = inv.invoice_type === 'vendor' ? inv.total : +total.toFixed(2);
    // v0.48 — Surface the invoice owner's worker_type to the frontend so
    // the Expensify button can be gated on FTE.
    const ownerMeta = db.prepare("SELECT worker_type, email FROM users WHERE id = ?").get(inv.user_id) || {};
    return {
      invoice: {
        ...inv,
        total: finalTotal,
        hourly_rate: rate,
        owner_worker_type: ownerMeta.worker_type || null,
        owner_email:       ownerMeta.email || null,
      },
      lines: Object.values(byWO),
      by_date: byDateArr,
      attachments,
      summary: {
        // v0.55 — drive is billable. labor_amount / drive_amount are tracked
        // separately so reports can break down paid time by category.
        labor_hours:  +Object.values(byWO).reduce((a,w) => a + w.labor_hours, 0).toFixed(2),
        labor_amount: +Object.values(byWO).reduce((a,w) => a + w.labor_amount, 0).toFixed(2),
        drive_hours:  +Object.values(byWO).reduce((a,w) => a + w.drive_hours, 0).toFixed(2),
        drive_amount: +Object.values(byWO).reduce((a,w) => a + w.drive_amount, 0).toFixed(2),
        mileage: +expenses.filter(e => e.category==='mileage').reduce((a,e) => a + e.amount, 0).toFixed(2),
        tolls_parking: +expenses.filter(e => ['tolls','parking'].includes(e.category)).reduce((a,e) => a + e.amount, 0).toFixed(2),
        meals: +expenses.filter(e => e.category==='other' && e.subcategory==='Meal').reduce((a,e) => a + e.amount, 0).toFixed(2),
        tools: +expenses.filter(e => e.category==='other' && e.subcategory==='Tools').reduce((a,e) => a + e.amount, 0).toFixed(2),
        other: +expenses.filter(e => e.category==='vendor' || (e.category==='other' && !['Meal','Tools'].includes(e.subcategory))).reduce((a,e) => a + e.amount, 0).toFixed(2),
        total: +total.toFixed(2),
        flag_count: Object.values(byWO).reduce((a,w) => a + w.flags.length, 0),
        days_worked: byDateArr.length,
      },
    };
  }

  // GET /api/invoices/current  → current-week draft (creates if needed)
  router.get('/invoices/current', (req, res) => {
    // v0.67.1 — technician-only: a "current draft" is a self-invoice (payee =
    // caller). Managers/PMs are approvers, not payees, and have no own draft.
    const me = requireSelfInvoiceTech(req, res); if (!me) return;
    const userId = me.id;
    const inv = ensureCurrentDraft(userId);
    res.json(stripFlagsForTech(computeInvoice(inv.id), userId));
  });

  // POST /api/invoices/:id/extract-wos  (manager-only)
  // Body: { text }                — free-form text from the uploaded invoice
  // Returns: [{ candidate_id, source_hint, line }] — candidate ticket numbers
  // The manager confirms which to Pull via /api/workorders/parse-url.
  router.post('/invoices/:id/extract-wos', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const perm = canActOnInvoice(Number(req.params.id), userId);
    if (!perm.ok) return res.status(perm.status || 403).json({ error: perm.error });
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });

    // Extract candidate ticket IDs from the text. Patterns commonly seen on
    // contractor invoices (e.g. John Brennan example):
    //   "WF 16 ShopRite of Bridge & Harbison - All Carts - 12816"
    //   "[Hall Sensor Replacement] WF 26 - ... - 12827"
    //   "WF 79 - ShopRite of Riverside ... - 12829"
    // Heuristic: a 4–8 digit number at end of a line, or after a dash.
    const candidates = [];
    const seen = new Set();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // ID at end of a line after a dash (strong context — accept 3+ digits to
      // handle seeded MaintainX 3-digit short IDs like "- 127")
      let m = trimmed.match(/-\s*(\d{3,8})\s*$/);
      if (!m) m = trimmed.match(/\b(?:ticket|wo|#)\s*#?\s*(\d{3,8})\b/i);
      if (!m) m = trimmed.match(/(?:^|\s)(\d{5,8})(?:\s|$)/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        // Hint at source: MaintainX ids tend to be 7+ digits, Freshdesk 4–6.
        // 3-digit ids are ambiguous — default to MaintainX since that's what
        // contractor short refs (127/128/etc) typically map to in our data.
        const hint = m[1].length >= 7 || m[1].length <= 3 ? 'maintainx' : 'freshdesk';
        // Snippet of context for the manager to confirm
        candidates.push({
          candidate_id: m[1],
          source_hint:  hint,
          line:         trimmed.slice(0, 200),
        });
      }
    }
    res.json({ count: candidates.length, candidates });
  });

  // POST /api/invoices/:id/link-wo  (manager-only)
  // Body: { source_system, ticket_id }
  // Pulls the WO from FD/MX, creates the local WO record (if needed), and
  // returns it so the UI can show "linked work orders" on the invoice.
  router.post('/invoices/:id/link-wo', async (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const perm = canActOnInvoice(id, userId);
    if (!perm.ok) return res.status(perm.status || 403).json({ error: perm.error });
    const inv = perm.inv;

    const { source_system, ticket_id } = req.body;
    if (!source_system || !ticket_id) return res.status(400).json({ error: 'source_system and ticket_id required' });

    // Build canonical external_id from prefix conventions
    const src = source_system === 'maintainx' ? 'MX' : 'FD';
    // We don't know work_type yet — use SVC as a placeholder; parse-url will
    // refresh the actual values. The user can fix the type via the WO detail.
    const candidates = [`${src}-DPL-${ticket_id}`, `${src}-RTR-${ticket_id}`,
                        `${src}-SVC-${ticket_id}`, `${src}-RPR-${ticket_id}`];
    let existing = null;
    for (const ex of candidates) {
      existing = db.prepare("SELECT * FROM work_orders WHERE external_id = ?").get(ex);
      if (existing) break;
    }
    // Also check by trailing ticket id match
    if (!existing) {
      existing = db.prepare("SELECT * FROM work_orders WHERE external_id LIKE ?").get(`%-${ticket_id}`);
    }

    if (existing) {
      // Already linked. Reassign to invoice's tech if needed.
      if (existing.assigned_user_id !== inv.user_id) {
        db.prepare("UPDATE work_orders SET assigned_user_id = ? WHERE id = ?").run(inv.user_id, existing.id);
      }
      logAudit(db, { entity_type: 'work_orders', entity_id: existing.id, user_id: userId, action: 'linked_existing_to_invoice', details: { invoice_id: id } });
      return res.json({ work_order: existing, was_existing: true });
    }

    // Create a placeholder WO; manager can refine details after pulling from source
    const r = db.prepare(`
      INSERT INTO work_orders
        (external_id, source_system, source_ticket_id, work_type, store_name, cart_count, status, assigned_user_id)
      VALUES (?, ?, ?, 'maintenance', '(pulled from invoice — refine details)', 1, 'in_progress', ?)
    `).run(`${src}-MNT-${ticket_id}`, source_system, ticket_id, inv.user_id);
    const wo = db.prepare("SELECT * FROM work_orders WHERE id = ?").get(r.lastInsertRowid);
    logAudit(db, { entity_type: 'work_orders', entity_id: wo.id, user_id: userId,
                   action: 'created_from_invoice', details: { invoice_id: id, source_system, ticket_id } });
    res.json({ work_order: wo, was_existing: false });
  });

  // POST /api/invoices/upload  (manager-only)
  // Body: { tech_user_id, week_of: "YYYY-MM-DD", attachment?: { filename, mime_type, data_b64 }, notes? }
  // Creates a draft invoice on the technician's behalf, with the original file
  // (e.g. the PDF the tech emailed in) stored as an invoice-level attachment.
  // The manager can then add expenses/time-entries via the normal endpoints
  // using the on_behalf_of header.
  router.post('/invoices/upload', async (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT id, name, role FROM users WHERE id = ?").get(userId) : null;
    if (!me) return res.status(401).json({ error: 'no user selected' });
    // Allowed: managers (uploading on behalf of any tech they manage) +
    // technicians (uploading their own historical PDFs to backfill).
    if (!['ops_manager','sr_manager','pm','technician'].includes(me.role)) {
      return res.status(403).json({ error: 'role not permitted to upload invoices' });
    }

    const { tech_user_id, week_of, attachment, notes } = req.body;
    // Techs default to self; managers must specify tech_user_id.
    const techId = me.role === 'technician'
      ? me.id
      : Number(tech_user_id);
    if (me.role === 'technician' && tech_user_id && Number(tech_user_id) !== me.id) {
      return res.status(403).json({ error: 'technicians can only upload their own invoices' });
    }
    const tech = db.prepare("SELECT id, name, role FROM users WHERE id = ?").get(techId);
    if (!tech || tech.role !== 'technician') return res.status(400).json({ error: 'tech_user_id must be a technician' });

    // Ops Mgr can only upload for techs on their team
    if (me.role === 'ops_manager') {
      const inTeam = db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, techId);
      if (!inTeam) return res.status(403).json({ error: `${tech.name} is not on your team — add them on the Team tab first` });
    }

    if (!week_of) return res.status(400).json({ error: 'week_of (YYYY-MM-DD) required' });
    const targetDate = new Date(week_of);
    if (isNaN(targetDate)) return res.status(400).json({ error: 'invalid week_of date' });

    // v0.34 — every upload creates its own NEW draft, even if other invoices
    // exist for that week (whether draft or already submitted/approved/sent).
    // This is what contractors expect when they're filing supplemental
    // invoices: each PDF becomes its own line-item bucket; totals roll up via
    // the dashboard. The invoice_number gets a suffix (-A, -B, …) when a
    // collision is detected so the canonical numbers stay unique.
    const inv = createNewUploadDraft(techId, targetDate);
    db.prepare(`
      UPDATE invoices SET origin = 'mgr_upload', created_by = ?, notes = COALESCE(?, notes)
      WHERE id = ? AND status = 'draft'
    `).run(userId, notes || null, inv.id);

    // Attach the file (if provided) at invoice level via the attachments table
    let attachmentId = null;
    let extractionResult = null;
    if (attachment && attachment.filename && attachment.data_b64) {
      const fs = require('fs'), path = require('path'), crypto = require('crypto');
      const RECEIPT_DIR = path.join(__dirname, '..', 'data', 'receipts');
      fs.mkdirSync(RECEIPT_DIR, { recursive: true });
      const buf = Buffer.from(attachment.data_b64, 'base64');
      if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'file > 20MB' });
      const ext  = path.extname(attachment.filename) || '.bin';
      const name = `${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(RECEIPT_DIR, name), buf);
      const r = db.prepare(`
        INSERT INTO attachments (user_id, invoice_id, storage_name, original_name, mime_type, size_bytes, caption)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(techId, inv.id, name, attachment.filename, attachment.mime_type || null, buf.length,
             `Original invoice uploaded by ${me.role === 'ops_manager' ? 'Ops Mgr' : 'admin'}`);
      attachmentId = r.lastInsertRowid;

      // If it's a PDF, attempt structured extraction and store on the invoice.
      // Failure is non-fatal — the manager can still paste invoice text or
      // edit fields manually.
      const isPdf = (attachment.mime_type || '').toLowerCase().includes('pdf') ||
                    /\.pdf$/i.test(attachment.filename);
      if (isPdf) {
        try {
          extractionResult = await extractFromPdfBuffer(buf);
          if (extractionResult.ok) {
            // Validate the extraction BEFORE anything auto-posts. needs_review
            // parses (scanned PDF, missing/suspect total, line items that don't
            // reconcile) are stored for manual review but NOT auto-imported, so
            // a bad parse can't reach the ledger. See lib/invoiceValidation.js.
            const validation = validateInvoice({
              kind: 'contractor', extraction: extractionResult, text: extractionResult.text });
            extractionResult.validation = validation;
            db.prepare(`
              UPDATE invoices
              SET extracted_text = ?, extracted_summary = ?, extracted_at = ?
              WHERE id = ?
            `).run(
              extractionResult.text,
              JSON.stringify({ ...extractionResult.summary, _validation: validation }),
              new Date().toISOString(),
              inv.id
            );
            // If the manager left notes blank but the PDF supplies an invoice
            // number, drop a friendly note so the audit trail captures it.
            if (extractionResult.summary?.header?.invoice_number && !notes) {
              db.prepare("UPDATE invoices SET notes = ? WHERE id = ? AND (notes IS NULL OR notes = '')")
                .run(`Imported from PDF — original invoice #${extractionResult.summary.header.invoice_number}`, inv.id);
            }
            // If the PDF's period covers different week than the upload's
            // week_of, snap the invoice's period to match the PDF so the
            // line items land in their correct dated slots.
            const pdfPeriod = extractionResult.summary?.header?.period;
            if (pdfPeriod?.start && pdfPeriod?.end &&
                (pdfPeriod.start !== inv.period_start || pdfPeriod.end !== inv.period_end)) {
              db.prepare("UPDATE invoices SET period_start = ?, period_end = ? WHERE id = ? AND status = 'draft'")
                .run(pdfPeriod.start, pdfPeriod.end, inv.id);
              inv.period_start = pdfPeriod.start;
              inv.period_end   = pdfPeriod.end;
            }
            // Auto-import line items, mileage, and tolls into the draft — but
            // ONLY when validation passed. Held parses wait for manual review;
            // the manager can fix fields and re-run POST /invoices/:id/import-pdf.
            if (validation.needs_review) {
              logAudit(db, { entity_type: 'invoices', entity_id: inv.id, user_id: userId,
                             action: 'pdf_held_for_review',
                             details: { confidence: validation.confidence, issues: validation.issues } });
            } else {
              try {
                const importRes = importExtractedSummary(db, inv, extractionResult.summary);
                extractionResult.import = importRes;
                logAudit(db, { entity_type: 'invoices', entity_id: inv.id, user_id: userId,
                               action: 'pdf_auto_import', details: importRes });
              } catch (e) {
                console.error('PDF auto-import failed:', e.message);
              }
            }
          }
        } catch (e) {
          console.error('PDF extraction failed:', e.message);
        }
      }
    }

    logAudit(db, { entity_type: 'invoices', entity_id: inv.id, user_id: userId, action: 'mgr_upload',
                   details: { tech_user_id: techId, week_of, attachment_id: attachmentId,
                              extracted: extractionResult?.ok || false } });

    const computed = computeInvoice(inv.id);
    if (extractionResult?.ok) {
      computed.extracted  = extractionResult.summary;
      computed.import     = extractionResult.import;
      computed.validation = extractionResult.validation; // {confidence, needs_review, issues}
    }
    res.json(stripFlagsForTech(computed, userId));
  });

  // POST /api/invoices/:id/import-pdf  (manager-only)
  // Manually re-runs the auto-importer using the stored extracted_summary.
  // Idempotent — duplicate rows are skipped. Useful if the manager edited the
  // extracted JSON or wants to retry after fixing an upstream parser bug.
  router.post('/invoices/:id/import-pdf', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const perm = canActOnInvoice(id, userId);
    if (!perm.ok) return res.status(perm.status || 403).json({ error: perm.error });
    const inv = perm.inv;
    if (inv.status !== 'draft') return res.status(409).json({ error: `invoice is ${inv.status}, not draft` });
    if (!inv.extracted_summary) return res.status(400).json({ error: 'no extracted_summary on this invoice — upload a PDF first' });

    let summary;
    try { summary = JSON.parse(inv.extracted_summary); }
    catch (_) { return res.status(500).json({ error: 'extracted_summary is not valid JSON' }); }

    const importRes = importExtractedSummary(db, inv, summary);
    logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId,
                   action: 'pdf_manual_import', details: importRes });
    res.json({ ok: true, import: importRes });
  });

  // GET /api/invoices/:id/extracted  (manager-only)
  // Returns the raw text + structured summary parsed from the uploaded PDF.
  router.get('/invoices/:id/extracted', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const perm = canActOnInvoice(id, userId);
    if (!perm.ok) return res.status(perm.status || 403).json({ error: perm.error });
    const row = db.prepare("SELECT extracted_text, extracted_summary, extracted_at FROM invoices WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: 'invoice not found' });
    let summary = null;
    try { summary = row.extracted_summary ? JSON.parse(row.extracted_summary) : null; } catch (_) {}
    res.json({
      extracted_at:   row.extracted_at,
      has_text:       !!row.extracted_text,
      text_length:    (row.extracted_text || '').length,
      summary,
      // Only return text on explicit request to keep the payload light.
      text:           req.query.include_text === '1' ? row.extracted_text : undefined,
    });
  });

  // POST /api/invoices/:id/reextract  (manager-only)
  // Re-runs the PDF extractor against the most recent PDF attachment on this
  // invoice. Useful after extractor improvements ship without re-uploading.
  router.post('/invoices/:id/reextract', async (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const perm = canActOnInvoice(id, userId);
    if (!perm.ok) return res.status(perm.status || 403).json({ error: perm.error });
    const inv = perm.inv;

    // Find the most recent PDF attachment on the invoice.
    const att = db.prepare(`
      SELECT * FROM attachments
      WHERE invoice_id = ? AND (mime_type LIKE '%pdf%' OR original_name LIKE '%.pdf')
      ORDER BY uploaded_at DESC LIMIT 1
    `).get(id);
    if (!att) return res.status(400).json({ error: 'no PDF attachment found on this invoice' });

    const fs = require('fs'), path = require('path');
    const filepath = path.join(__dirname, '..', 'data', 'receipts', att.storage_name);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'attachment file missing on disk' });
    const buf = fs.readFileSync(filepath);
    const result = await extractFromPdfBuffer(buf);
    if (!result.ok) return res.status(500).json({ error: result.error || 'extraction failed' });

    db.prepare(`
      UPDATE invoices SET extracted_text = ?, extracted_summary = ?, extracted_at = ?
      WHERE id = ?
    `).run(result.text, JSON.stringify(result.summary), new Date().toISOString(), id);

    logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId, action: 'reextract',
                   details: { attachment_id: att.id, candidates: result.summary.candidates.length } });

    res.json({ ok: true, summary: result.summary });
  });

  // PUT /api/invoices/:id  (manager-only, mgr-uploaded drafts only)
  // Updates editable header fields. Body may include any subset of:
  //   { notes, period_start, period_end, hourly_rate_override }
  // hourly_rate_override is stored on the invoice's "notes" via a JSON tag
  // unless we add a dedicated column — for now we keep it server-side via the
  // notes field (tagged "[rate_override:NN]").
  router.put('/invoices/:id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const perm = canActOnInvoice(id, userId);
    if (!perm.ok) return res.status(perm.status || 403).json({ error: perm.error });
    const inv = perm.inv;
    // v0.64 — managers (canActOnInvoice already verified team access) can edit
    // header fields right up until approval: draft / submitted / in_review. The
    // owning tech can still only edit while it's a draft.
    const meRow = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
    const isMgr = meRow && ['ops_manager','sr_manager','pm'].includes(meRow.role) && inv.user_id !== userId;
    const editableStatuses = isMgr ? ['draft','submitted','in_review'] : ['draft'];
    if (!editableStatuses.includes(inv.status)) {
      return res.status(409).json({ error: `invoice cannot be edited at status=${inv.status}` });
    }

    const updates = [];
    const params = [];
    const { notes, period_start, period_end } = req.body || {};

    if (typeof notes === 'string') { updates.push('notes = ?'); params.push(notes); }

    if (period_start) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(period_start)) return res.status(400).json({ error: 'period_start must be YYYY-MM-DD' });
      updates.push('period_start = ?'); params.push(period_start);
    }
    if (period_end) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(period_end)) return res.status(400).json({ error: 'period_end must be YYYY-MM-DD' });
      updates.push('period_end = ?'); params.push(period_end);
    }

    if (!updates.length) return res.status(400).json({ error: 'no editable fields supplied' });

    params.push(id);
    db.prepare(`UPDATE invoices SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId, action: 'mgr_edit',
                   details: { fields: Object.keys(req.body || {}) } });

    res.json(computeInvoice(id));
  });

  // POST /api/invoices/custom-period
  //   { period_start: "YYYY-MM-DD", period_end: "YYYY-MM-DD",
  //     work_order_ids?: [int] }
  // v0.52 — tech can submit invoices spanning more than 1 week, up to 31 days.
  // Optionally specify which WOs to load — orphan time entries + expenses
  // belonging to the tech, dated within [period_start, period_end], on those
  // WOs (or any WO if work_order_ids omitted) get attached to the new draft.
  // Already-attached entries are left alone so we never steal from a submitted
  // invoice; if you re-run the same period, only new orphans get pulled in.
  router.post('/invoices/custom-period', (req, res) => {
    // v0.67.1 — technician-only self-create (payee = caller). See
    // requireSelfInvoiceTech: managers use POST /invoices/upload on a tech's behalf.
    const me = requireSelfInvoiceTech(req, res); if (!me) return;
    const userId = me.id;

    const { period_start, period_end, work_order_ids } = req.body || {};
    if (!period_start || !period_end) return res.status(400).json({ error: 'period_start and period_end required (YYYY-MM-DD)' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period_start) || !/^\d{4}-\d{2}-\d{2}$/.test(period_end)) {
      return res.status(400).json({ error: 'dates must be YYYY-MM-DD' });
    }
    const ps = new Date(period_start);
    const pe = new Date(period_end);
    if (isNaN(ps) || isNaN(pe)) return res.status(400).json({ error: 'invalid dates' });
    if (pe < ps) return res.status(400).json({ error: 'period_end cannot be before period_start' });
    const todayIso = new Date().toISOString().slice(0,10);
    if (period_start > todayIso) return res.status(400).json({ error: 'cannot create an invoice for a future period' });
    // 31 days inclusive cap — covers any calendar month.
    const days = Math.round((pe - ps) / (24*3600*1000)) + 1;
    if (days > 31) return res.status(400).json({ error: 'period cannot exceed 31 days' });

    // Validate WO ids belong to this tech (or are unassigned). Empty array =
    // "all WOs" semantically; we treat undefined and [] the same way.
    const woIds = Array.isArray(work_order_ids) ? work_order_ids.map(Number).filter(n => Number.isFinite(n)) : [];

    // Build the new draft. Use the period_end-based invoice number; collision
    // is resolved by createNewUploadDraft's alphabetic suffix, but for clarity
    // we generate fresh here to keep the suffix path centralized.
    const baseNum = invoiceNumber(userId, period_end);
    let num = baseNum;
    const existing = db.prepare("SELECT invoice_number FROM invoices WHERE user_id = ? AND invoice_number LIKE ?").all(userId, `${baseNum}%`);
    if (existing.length) {
      const used = new Set(existing.map(r => r.invoice_number));
      for (const suffix of ['-A','-B','-C','-D','-E','-F','-G','-H','-I','-J']) {
        if (!used.has(baseNum + suffix)) { num = baseNum + suffix; break; }
      }
    }
    // origin uses the existing 'tech_self' enum value; the notes column flags
    // this as a multi-week custom-period draft so downstream views can label it.
    const r = db.prepare(`
      INSERT INTO invoices (invoice_number, user_id, period_start, period_end, status, total, origin, created_by, notes)
      VALUES (?, ?, ?, ?, 'draft', 0, 'tech_self', ?, ?)
    `).run(num, userId, period_start, period_end, userId, `Custom period · ${period_start} → ${period_end}`);
    const invId = r.lastInsertRowid;

    // Attach orphan time entries falling in range, optionally scoped to WOs.
    const woClause = woIds.length ? ` AND work_order_id IN (${woIds.map(() => '?').join(',')})` : '';
    const teRes = db.prepare(`
      UPDATE time_entries SET invoice_id = ?
      WHERE user_id = ? AND invoice_id IS NULL
        AND clock_out IS NOT NULL
        AND date(clock_in) BETWEEN ? AND ?
        ${woClause}
    `).run(invId, userId, period_start, period_end, ...woIds);

    const expRes = db.prepare(`
      UPDATE expenses SET invoice_id = ?
      WHERE user_id = ? AND invoice_id IS NULL
        AND date(expense_date) BETWEEN ? AND ?
        ${woClause}
    `).run(invId, userId, period_start, period_end, ...woIds);

    logAudit(db, { entity_type: 'invoices', entity_id: invId, user_id: userId,
                   action: 'create_custom_period',
                   details: { period_start, period_end, work_order_ids: woIds,
                              attached: { time_entries: teRes.changes, expenses: expRes.changes } } });

    const computed = computeInvoice(invId);
    computed.attached = { time_entries: teRes.changes, expenses: expRes.changes, days };
    res.json(stripFlagsForTech(computed, userId));
  });

  // POST /api/invoices/for-week { week_of: "YYYY-MM-DD" }
  // Creates (or returns) a draft invoice for the week containing the given date.
  // Used for retroactive entries — tech can backfill an old week and submit it.
  router.post('/invoices/for-week', (req, res) => {
    // v0.67.1 — technician-only self-create (payee = caller). See
    // requireSelfInvoiceTech: managers use POST /invoices/upload on a tech's behalf.
    const me = requireSelfInvoiceTech(req, res); if (!me) return;
    const userId = me.id;
    const date = (req.body.week_of || '').trim();
    if (!date) return res.status(400).json({ error: 'week_of (YYYY-MM-DD) required' });
    const d = new Date(date);
    if (isNaN(d)) return res.status(400).json({ error: 'invalid date' });
    if (d > new Date()) return res.status(400).json({ error: 'cannot create an invoice for a future week' });
    const inv = ensureDraftForWeek(userId, d);
    res.json(stripFlagsForTech(computeInvoice(inv.id), userId));
  });

  // GET /api/invoices  → all my invoices (list view)
  router.get('/invoices', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const rows = db.prepare(`
      SELECT id, invoice_number, period_start, period_end, status, total, submitted_at,
             approved_ops_at, approved_sr_at, rejected_at, rejection_reason
      FROM invoices WHERE user_id = ?
      ORDER BY period_start DESC
    `).all(userId);
    res.json(rows);
  });

  // ── 3rd-party (vendor) invoices — dedicated org-wide list + summary for the
  //    3rd Party tab. Manager-only. v0.64.6. ─────────────────────────────────
  function vendMgr(req, res) {
    const uid = Number(req.header('x-user-id'));
    const me = uid ? db.prepare("SELECT role FROM users WHERE id = ?").get(uid) : null;
    if (!me || !['ops_manager','sr_manager','pm'].includes(me.role)) {
      res.status(403).json({ error: 'manager role required' }); return null;
    }
    return me;
  }
  // Date basis: the vendor's invoice date when present, else the upload date.
  const VEND_D = "COALESCE(vendor_invoice_date, substr(created_at,1,10))";

  router.get('/vendor-invoices', (req, res) => {
    if (!vendMgr(req, res)) return;
    const where = ["i.invoice_type = 'vendor'"]; const params = [];
    if (req.query.from)   { where.push(`COALESCE(i.vendor_invoice_date, substr(i.created_at,1,10)) >= ?`); params.push(req.query.from); }
    if (req.query.to)     { where.push(`COALESCE(i.vendor_invoice_date, substr(i.created_at,1,10)) <= ?`); params.push(req.query.to); }
    if (req.query.status) { where.push('i.status = ?'); params.push(req.query.status); }
    if (req.query.vendor) { where.push('i.vendor_name LIKE ?'); params.push('%' + req.query.vendor + '%'); }
    const rows = db.prepare(`
      SELECT i.id, i.invoice_number, i.vendor_name, i.vendor_invoice_number, i.vendor_invoice_date,
             i.vendor_category, i.status, i.total, i.notes, i.created_at, i.submitted_at,
             i.approved_ops_at, i.approved_sr_at, i.sent_to_ap_at,
             cu.name AS created_by_name,
             (SELECT COUNT(*) FROM attachments a WHERE a.invoice_id = i.id) AS attachment_count
      FROM invoices i LEFT JOIN users cu ON cu.id = i.created_by
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(i.vendor_invoice_date, substr(i.created_at,1,10)) DESC, i.id DESC
    `).all(...params);
    res.json(rows);
  });

  router.get('/vendor-invoices/summary', (req, res) => {
    if (!vendMgr(req, res)) return;
    const today = new Date().toISOString().slice(0, 10);
    const y = today.slice(0, 4);
    const mtdStart = `${today.slice(0, 7)}-01`, ytdStart = `${y}-01-01`;
    const from = req.query.from || '1970-01-01', to = req.query.to || today;
    const between = (a, b) => db.prepare(`SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM invoices WHERE invoice_type='vendor' AND ${VEND_D} BETWEEN ? AND ?`).get(a, b);
    const inP = between(from, to), all = between('1970-01-01', today);
    const totals = {
      in_period: +inP.total.toFixed(2), count_in_period: inP.n,
      mtd: +between(mtdStart, today).total.toFixed(2),
      ytd: +between(ytdStart, today).total.toFixed(2),
      all_time: +all.total.toFixed(2), all_time_count: all.n,
    };
    const by_vendor = db.prepare(`
      SELECT COALESCE(vendor_name, '— unnamed —') AS vendor_name, COUNT(*) AS count, COALESCE(SUM(total),0) AS total
      FROM invoices WHERE invoice_type='vendor' AND ${VEND_D} BETWEEN ? AND ?
      GROUP BY vendor_name ORDER BY total DESC`).all(from, to).map(r => ({ ...r, total: +r.total.toFixed(2) }));
    const by_status = db.prepare(`
      SELECT status, COUNT(*) AS count, COALESCE(SUM(total),0) AS total
      FROM invoices WHERE invoice_type='vendor' AND ${VEND_D} BETWEEN ? AND ?
      GROUP BY status ORDER BY total DESC`).all(from, to).map(r => ({ ...r, total: +r.total.toFixed(2) }));
    res.json({ totals, by_vendor, by_status });
  });

  // GET /api/invoices/:id
  // Allowed for: invoice owner, an Ops Mgr who has the tech on their team,
  // any Sr Mgr / PM (they oversee everything).
  router.get('/invoices/:id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const id = Number(req.params.id);
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
    if (!inv) return res.status(404).json({ error: 'not found' });
    if (inv.user_id !== userId) {
      const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
      const allowed = me && (
        me.role === 'sr_manager' || me.role === 'pm' ||
        (me.role === 'ops_manager' && db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, inv.user_id))
      );
      if (!allowed) return res.status(403).json({ error: 'not yours' });
    }
    const computed = computeInvoice(id);
    // Always include the TECH's profile so the contractor invoice header
    // renders the bill-from name/address/phone correctly when a manager is
    // viewing/editing on behalf of someone else (fixes v0.21 bug where the
    // header showed the manager's name instead of the tech's).
    const tech = db.prepare("SELECT id, name, email, home_address, home_phone, worker_type, hourly_rate FROM users WHERE id = ?").get(inv.user_id);
    computed.tech_user = tech || null;
    // If the invoice was uploaded as a PDF, surface the extracted summary so
    // the UI can render the side-by-side "extracted vs computed" panel.
    const ext = db.prepare("SELECT extracted_summary, extracted_at FROM invoices WHERE id = ?").get(id);
    if (ext && ext.extracted_summary) {
      try {
        computed.extracted    = JSON.parse(ext.extracted_summary);
        computed.extracted_at = ext.extracted_at;
      } catch (_) {}
    }
    res.json(stripFlagsForTech(computed, userId));
  });

  // GET /api/invoices/:id/notices — informational "manager edited a line item"
  // notices for this invoice. Visible to the owning tech and to managers on the
  // team. v0.64.3.
  router.get('/invoices/:id/notices', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const id = Number(req.params.id);
    const inv = db.prepare("SELECT user_id FROM invoices WHERE id = ?").get(id);
    if (!inv) return res.status(404).json({ error: 'not found' });
    if (inv.user_id !== userId) {
      const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
      const ok = me && (me.role === 'sr_manager' || me.role === 'pm' ||
        (me.role === 'ops_manager' && db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, inv.user_id)));
      if (!ok) return res.status(403).json({ error: 'not yours' });
    }
    const rows = db.prepare(`
      SELECT n.id, n.subject, n.body, n.created_at, u.name AS by_name
      FROM notifications n LEFT JOIN users u ON u.id = n.triggered_by
      WHERE n.invoice_id = ? AND n.kind = 'line_item_edited'
      ORDER BY n.created_at DESC LIMIT 50`).all(id);
    res.json(rows);
  });

  // POST /api/invoices/:id/submit  { notes? }  → moves to 'submitted' if no flags w/o justification
  router.post('/invoices/:id/submit', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
    if (!inv) return res.status(404).json({ error: 'not found' });
    if (inv.user_id !== userId) {
      // Allow managers to submit a tech's draft if mgr-uploaded or in their team
      const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
      const allowed = me && (
        me.role === 'sr_manager' || me.role === 'pm' ||
        (me.role === 'ops_manager' && db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, inv.user_id))
      );
      if (!allowed) return res.status(403).json({ error: 'not yours' });
    }
    if (inv.status !== 'draft') return res.status(409).json({ error: `invoice is ${inv.status}, not draft` });

    const computed = computeInvoice(id);
    // v0.65.2 — Policy flags are surfaced to managers only, at the Ops Mgr
    // approval queue. Field techs submit freely and never see flags, so the
    // block-severity hard stop and the justification-note gate apply ONLY when
    // a manager submits on a tech's behalf. All flags are still computed and
    // shown to managers at approval, where they're reviewed and enforced.
    const submitter = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
    const submitterIsManager = !!submitter && ['ops_manager','sr_manager','pm'].includes(submitter.role);
    if (submitterIsManager) {
      const blockingLines = computed.lines.filter(l => (l.flags || []).some(f => f.severity === 'block'));
      if (blockingLines.length) {
        return res.status(400).json({
          error: 'This invoice violates a hard ("block") policy rule and cannot be submitted. Resolve the flagged lines first.',
          blocked_lines: blockingLines.map(l => ({ external_id: l.external_id, flags: l.flags.filter(f => f.severity === 'block') })),
        });
      }
      if (computed.summary.flag_count > 0 && !req.body.notes) {
        return res.status(400).json({
          error: 'This invoice has flagged lines. Please provide a justification note.',
          flagged_lines: computed.lines.filter(l => l.flags.length).map(l => ({ external_id: l.external_id, flags: l.flags })),
        });
      }
    }
    // v0.44 — BUG-006 fix: race-safe transition. WHERE status = 'draft'
    // gates the update; changes() === 0 means another caller flipped it.
    const now = new Date().toISOString();
    const r = db.prepare(`
      UPDATE invoices SET status = 'submitted', submitted_at = ?, notes = ?
      WHERE id = ? AND status = 'draft'
    `).run(now, req.body.notes || null, id);
    if (r.changes === 0) {
      return res.status(409).json({ error: 'invoice was already submitted by another action — refresh and try again' });
    }

    logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId, action: 'submit',
                   details: { total: inv.total, flag_count: computed.summary.flag_count } });

    res.json(stripFlagsForTech({ ...computed, invoice: { ...computed.invoice, status: 'submitted', submitted_at: now }}, userId));
  });

  // ════════════════════════════════════════════════════════════════════════
  // v0.68 — "Add work orders to an already-submitted week" requests.
  // ------------------------------------------------------------------------
  // Once a week's invoice is submitted it locks (only drafts are editable). If
  // the tech later needs to bill extra work orders for that SAME week, they file
  // a request against the locked invoice; the Ops Mgr (team) — or a Sr Mgr / PM
  // — decides:
  //   • DENY    → request returned to the tech with a reason + notification;
  //               the original invoice is left untouched.
  //   • APPROVE → a NEW supplemental DRAFT invoice is minted for the same week,
  //               pre-seeded with the requested work orders (and any orphan
  //               time/expenses for them swept in); the tech is notified with a
  //               link to finish + submit it.
  // ════════════════════════════════════════════════════════════════════════

  // Invoice statuses where the invoice is locked to the tech (past draft) and is
  // therefore a candidate for an add-work-orders request. A 'rejected' invoice
  // is reverted to 'draft' by the reject route, so it's editable directly.
  const LOCKED_INVOICE_STATUSES = ['submitted','in_review','approved_ops','approved_sr','queued_ap','sent_ap'];

  // Parse free-form ticket input ("12816, MX-RPR-97461873\n12827") into distinct
  // ticket tokens. Accepts canonical external_ids or bare numbers.
  function parseTicketTokens(text) {
    const out = [], seen = new Set();
    for (const raw of String(text || '').split(/[\s,;]+/)) {
      const tok = raw.trim();
      if (!tok) continue;
      const key = tok.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tok);
    }
    return out;
  }

  // Find (or create) a work order for a tech-entered ticket token and make sure
  // it's assigned to the tech. Mirrors POST /invoices/:id/link-wo, but the tech
  // needn't know the source system: we match an existing WO by canonical id /
  // trailing ticket / source_ticket_id, and only mint a placeholder (defaulting
  // to MaintainX) when nothing matches.
  function resolveWoForTech(token, techUserId, actorUserId) {
    const t = String(token).trim();
    let wo = db.prepare("SELECT * FROM work_orders WHERE external_id = ?").get(t)
      || db.prepare("SELECT * FROM work_orders WHERE external_id LIKE ?").get(`%-${t}`)
      || db.prepare("SELECT * FROM work_orders WHERE source_ticket_id = ?").get(t);
    if (wo) {
      if (wo.assigned_user_id !== techUserId) {
        db.prepare("UPDATE work_orders SET assigned_user_id = ? WHERE id = ?").run(techUserId, wo.id);
      }
      return { wo, created: false };
    }
    // Mint a placeholder. Default to MaintainX (matches link-wo's default for
    // short/ambiguous ids); the tech/manager can refine details later.
    const ticketDigits = t.replace(/[^0-9]/g, '') || t;
    let external_id = /^[A-Za-z]{2}-/.test(t) ? t : `MX-MNT-${ticketDigits}`;
    if (db.prepare("SELECT 1 FROM work_orders WHERE external_id = ?").get(external_id)) {
      external_id = `${external_id}-${Date.now()}`;
    }
    const r = db.prepare(`
      INSERT INTO work_orders
        (external_id, source_system, source_ticket_id, work_type, store_name, cart_count, status, assigned_user_id)
      VALUES (?, 'maintainx', ?, 'maintenance', '(added via week-supplement request — refine details)', 1, 'in_progress', ?)
    `).run(external_id, ticketDigits, techUserId);
    const created = db.prepare("SELECT * FROM work_orders WHERE id = ?").get(r.lastInsertRowid);
    logAudit(db, { entity_type: 'work_orders', entity_id: created.id, user_id: actorUserId,
                   action: 'created_from_wo_addition', details: { token: t } });
    return { wo: created, created: true };
  }

  // Notify the tech's Ops Manager(s) that a request was filed (mock email + the
  // notifications audit log; the request also surfaces in their queue). Best-effort.
  function notifyManagersOfRequest({ invoice, request, techUserId }) {
    try {
      const mgrs = db.prepare(`
        SELECT u.id, u.email FROM manager_team mt JOIN users u ON u.id = mt.manager_user_id
        WHERE mt.tech_user_id = ?
      `).all(techUserId);
      const tech = db.prepare("SELECT name FROM users WHERE id = ?").get(techUserId);
      const subject = `Work-order addition requested · week ${invoice.period_start} → ${invoice.period_end}`;
      const body = `${tech?.name || 'A technician'} asked to add work orders to invoice ${invoice.invoice_number} (already ${invoice.status}). `
        + `Requested: ${request.requested_wos}.` + (request.note ? ` Note: ${request.note}` : '');
      for (const m of mgrs) {
        db.prepare(`
          INSERT INTO notifications (kind, invoice_id, triggered_by, recipient, subject, body, status)
          VALUES ('wo_addition_requested', ?, ?, ?, ?, ?, 'logged')
        `).run(invoice.id, techUserId, m.email || null, subject, body);
      }
      console.log(`🔔 [mock notify] WO-addition request on ${invoice.invoice_number} → ${mgrs.length} manager(s)`);
    } catch (e) {
      console.error('notifyManagersOfRequest failed:', e.message);
    }
  }

  // Notify the tech of the manager's decision. On approval the notification
  // points at the NEW supplemental invoice; on denial, at the original. Best-effort.
  function notifyTechOfDecision({ request, decided, approverUserId, approverName, reason, newInvoiceId, newInvoiceNumber }) {
    try {
      const tech = db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(request.user_id);
      if (!tech) return;
      let kind, subject, body, invoiceId;
      if (decided === 'approved') {
        kind = 'wo_addition_approved'; invoiceId = newInvoiceId;
        subject = `Work orders approved — new invoice ${newInvoiceNumber}`;
        body = `Your request to add work orders for the week of ${request.period_start} → ${request.period_end} was approved by ${approverName || 'your manager'}. `
          + `A new invoice (${newInvoiceNumber}) was created for that week with the requested work orders — open it to add hours/expenses and submit.`;
      } else {
        kind = 'wo_addition_denied'; invoiceId = request.invoice_id;
        subject = `Work-order addition not approved`;
        body = `Your request to add work orders for the week of ${request.period_start} → ${request.period_end} was not approved by ${approverName || 'your manager'}.`
          + (reason ? ` Reason: ${reason}` : '');
      }
      db.prepare(`
        INSERT INTO notifications (kind, invoice_id, triggered_by, recipient, subject, body, status)
        VALUES (?, ?, ?, ?, ?, ?, 'logged')
      `).run(kind, invoiceId || null, approverUserId || null, tech.email || null, subject, body);
      console.log(`🔔 [mock notify] To tech ${tech.email || tech.id} · ${subject}`);
    } catch (e) {
      console.error('notifyTechOfDecision failed:', e.message);
    }
  }

  // POST /api/invoices/:id/request-additional-wos  { wos, note? }
  // The owning technician asks to add work orders to a week that's already
  // submitted/locked. Creates a 'pending' request for the Ops Mgr to decide.
  router.post('/invoices/:id/request-additional-wos', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
    if (!inv) return res.status(404).json({ error: 'invoice not found' });
    // Only the owning technician can ask to add work orders to their own week.
    if (inv.user_id !== userId) {
      return res.status(403).json({ error: 'only the invoice owner can request to add work orders' });
    }
    if (inv.invoice_type === 'vendor') {
      return res.status(400).json({ error: 'work-order additions apply to tech-labor invoices only' });
    }
    if (!LOCKED_INVOICE_STATUSES.includes(inv.status)) {
      return res.status(409).json({ error: `this invoice is ${inv.status} — just edit it directly and add the work orders` });
    }
    const body = req.body || {};
    const wosRaw = String(body.wos ?? body.work_orders ?? '').trim();
    const note   = String(body.note ?? '').trim();
    if (!wosRaw) return res.status(400).json({ error: 'list at least one work order (ticket # or WO id)' });
    if (wosRaw.length > 2000) return res.status(400).json({ error: 'work-order list too long (max 2000 chars)' });
    if (note.length > 2000)   return res.status(400).json({ error: 'note too long (max 2000 chars)' });
    const tokens = parseTicketTokens(wosRaw);
    if (!tokens.length) return res.status(400).json({ error: 'could not read any work-order references from your input' });

    // One open request per invoice at a time.
    const open = db.prepare("SELECT id FROM wo_addition_requests WHERE invoice_id = ? AND status = 'pending'").get(id);
    if (open) return res.status(409).json({ error: 'there is already a pending add-work-orders request for this invoice' });

    const r = db.prepare(`
      INSERT INTO wo_addition_requests (invoice_id, user_id, period_start, period_end, requested_wos, note, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).run(id, userId, inv.period_start, inv.period_end, wosRaw, note || null);
    const reqId = r.lastInsertRowid;

    logAudit(db, { entity_type: 'wo_addition_requests', entity_id: reqId, user_id: userId,
                   action: 'request_additional_wos', details: { invoice_id: id, tokens } });
    notifyManagersOfRequest({ invoice: inv, request: { requested_wos: wosRaw, note }, techUserId: userId });

    res.json(db.prepare("SELECT * FROM wo_addition_requests WHERE id = ?").get(reqId));
  });

  // GET /api/invoices/:id/addition-requests — requests filed against an invoice,
  // newest first. Visible to the owning tech and to managers who can act on it.
  router.get('/invoices/:id/addition-requests', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const perm = canActOnInvoice(id, userId);
    if (!perm.ok) return res.status(perm.status || 403).json({ error: perm.error });
    const rows = db.prepare(`
      SELECT wr.*, ni.invoice_number AS new_invoice_number, ni.status AS new_invoice_status,
             du.name AS decided_by_name
      FROM wo_addition_requests wr
      LEFT JOIN invoices ni ON ni.id = wr.new_invoice_id
      LEFT JOIN users    du ON du.id = wr.decided_by
      WHERE wr.invoice_id = ?
      ORDER BY wr.created_at DESC
    `).all(id);
    res.json(rows);
  });

  // GET /api/addition-requests/mine — the caller's own requests across invoices,
  // newest first. Powers the tech's "request decided" notification banner.
  router.get('/addition-requests/mine', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const rows = db.prepare(`
      SELECT wr.*, oi.invoice_number AS source_invoice_number,
             ni.invoice_number AS new_invoice_number, ni.status AS new_invoice_status,
             du.name AS decided_by_name
      FROM wo_addition_requests wr
      JOIN invoices oi      ON oi.id = wr.invoice_id
      LEFT JOIN invoices ni ON ni.id = wr.new_invoice_id
      LEFT JOIN users    du ON du.id = wr.decided_by
      WHERE wr.user_id = ?
      ORDER BY wr.created_at DESC
      LIMIT 50
    `).all(userId);
    res.json(rows);
  });

  // GET /api/addition-requests/queue — pending requests this manager can act on.
  // Ops Mgr: requests from techs on their team. Sr Mgr / PM: all pending.
  router.get('/addition-requests/queue', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) : null;
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }
    let rows;
    if (me.role === 'ops_manager') {
      const techIds = db.prepare("SELECT tech_user_id FROM manager_team WHERE manager_user_id = ?")
        .all(userId).map(r => r.tech_user_id);
      if (!techIds.length) return res.json([]);
      const ph = techIds.map(() => '?').join(',');
      rows = db.prepare(`
        SELECT wr.*, u.name AS tech_name, i.invoice_number AS source_invoice_number, i.status AS source_status
        FROM wo_addition_requests wr
        JOIN users u    ON u.id = wr.user_id
        JOIN invoices i ON i.id = wr.invoice_id
        WHERE wr.status = 'pending' AND wr.user_id IN (${ph})
        ORDER BY wr.created_at ASC
      `).all(...techIds);
    } else {
      rows = db.prepare(`
        SELECT wr.*, u.name AS tech_name, i.invoice_number AS source_invoice_number, i.status AS source_status
        FROM wo_addition_requests wr
        JOIN users u    ON u.id = wr.user_id
        JOIN invoices i ON i.id = wr.invoice_id
        WHERE wr.status = 'pending'
        ORDER BY wr.created_at ASC
      `).all();
    }
    res.json(rows);
  });

  // POST /api/addition-requests/:reqId/approve  { note? }
  // Ops Mgr (team) / Sr Mgr / PM. Mints a supplemental draft invoice for the
  // same week pre-seeded with the requested work orders, then notifies the tech.
  router.post('/addition-requests/:reqId/approve', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT id, role, name FROM users WHERE id = ?").get(userId) : null;
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }
    const reqId = Number(req.params.reqId);
    const wr = db.prepare("SELECT * FROM wo_addition_requests WHERE id = ?").get(reqId);
    if (!wr) return res.status(404).json({ error: 'request not found' });
    if (wr.status !== 'pending') return res.status(409).json({ error: `request is ${wr.status}, not pending` });
    if (wr.user_id === userId) return res.status(409).json({ error: 'you cannot decide your own request' });
    if (me.role === 'ops_manager') {
      const inTeam = db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, wr.user_id);
      if (!inTeam) return res.status(403).json({ error: 'this technician is not on your team' });
    }

    const techUserId = wr.user_id;
    const decisionNote = String((req.body && req.body.note) || '').trim() || null;

    // Race-safe claim FIRST so concurrent approvals can't both mint invoices.
    const now = new Date().toISOString();
    const claim = db.prepare(`
      UPDATE wo_addition_requests
      SET status = 'approved', decided_by = ?, decided_at = ?, decision_reason = ?
      WHERE id = ? AND status = 'pending'
    `).run(userId, now, decisionNote, reqId);
    if (claim.changes === 0) return res.status(409).json({ error: 'request was already decided — refresh and retry' });

    let newInvId, num, resolved = [];
    try {
      // 1) Mint a supplemental draft invoice for the SAME week (suffixed number).
      const baseNum = invoiceNumber(techUserId, wr.period_end);
      const used = new Set(db.prepare("SELECT invoice_number FROM invoices WHERE user_id = ? AND invoice_number LIKE ?")
        .all(techUserId, `${baseNum}%`).map(r => r.invoice_number));
      num = baseNum;
      for (let code = 'A'.charCodeAt(0); used.has(num); code++) {
        if (code > 'Z'.charCodeAt(0)) { num = `${baseNum}-${Date.now()}`; break; }
        num = `${baseNum}-${String.fromCharCode(code)}`;
      }
      const supRes = db.prepare(`
        INSERT INTO invoices (invoice_number, user_id, period_start, period_end, status, total, origin, created_by, notes)
        VALUES (?, ?, ?, ?, 'draft', 0, 'tech_self', ?, ?)
      `).run(num, techUserId, wr.period_start, wr.period_end, techUserId,
             `Supplemental · added work orders for ${wr.period_start} → ${wr.period_end} (request #${reqId}, approved by ${me.name || 'manager'})`);
      newInvId = supRes.lastInsertRowid;

      // 2) Resolve each requested WO (find-or-create + assign to tech), then
      //    sweep any orphan time/expenses for them in the week into the new draft.
      const woIds = [];
      for (const tok of parseTicketTokens(wr.requested_wos)) {
        try {
          const { wo, created } = resolveWoForTech(tok, techUserId, userId);
          woIds.push(wo.id);
          resolved.push({ token: tok, external_id: wo.external_id, created });
        } catch (e) {
          resolved.push({ token: tok, error: e.message });
        }
      }
      if (woIds.length) {
        const ph = woIds.map(() => '?').join(',');
        db.prepare(`
          UPDATE time_entries SET invoice_id = ?
          WHERE user_id = ? AND invoice_id IS NULL AND clock_out IS NOT NULL
            AND date(clock_in) BETWEEN ? AND ? AND work_order_id IN (${ph})
        `).run(newInvId, techUserId, wr.period_start, wr.period_end, ...woIds);
        db.prepare(`
          UPDATE expenses SET invoice_id = ?
          WHERE user_id = ? AND invoice_id IS NULL
            AND date(expense_date) BETWEEN ? AND ? AND work_order_id IN (${ph})
        `).run(newInvId, techUserId, wr.period_start, wr.period_end, ...woIds);
      }

      db.prepare("UPDATE wo_addition_requests SET new_invoice_id = ? WHERE id = ?").run(newInvId, reqId);
    } catch (e) {
      // Revert the claim so the manager can retry; nothing was returned to the client yet.
      db.prepare("UPDATE wo_addition_requests SET status='pending', decided_by=NULL, decided_at=NULL, decision_reason=NULL, new_invoice_id=NULL WHERE id = ?").run(reqId);
      console.error('approve wo-addition failed:', e.message);
      return res.status(500).json({ error: 'could not create the supplemental invoice — please retry' });
    }

    logAudit(db, { entity_type: 'wo_addition_requests', entity_id: reqId, user_id: userId,
                   action: 'approve_wo_addition', details: { new_invoice_id: newInvId, resolved } });
    notifyTechOfDecision({ request: wr, decided: 'approved', approverUserId: userId,
                           approverName: me.name, newInvoiceId: newInvId, newInvoiceNumber: num });

    res.json({
      ok: true,
      request: db.prepare("SELECT * FROM wo_addition_requests WHERE id = ?").get(reqId),
      new_invoice: { id: newInvId, invoice_number: num, period_start: wr.period_start, period_end: wr.period_end },
      work_orders: resolved,
    });
  });

  // POST /api/addition-requests/:reqId/deny  { reason }
  // Ops Mgr (team) / Sr Mgr / PM. Returns the request to the tech with a reason.
  router.post('/addition-requests/:reqId/deny', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT id, role, name FROM users WHERE id = ?").get(userId) : null;
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }
    const reqId = Number(req.params.reqId);
    const wr = db.prepare("SELECT * FROM wo_addition_requests WHERE id = ?").get(reqId);
    if (!wr) return res.status(404).json({ error: 'request not found' });
    if (wr.status !== 'pending') return res.status(409).json({ error: `request is ${wr.status}, not pending` });
    if (wr.user_id === userId) return res.status(409).json({ error: 'you cannot decide your own request' });
    if (me.role === 'ops_manager') {
      const inTeam = db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?").get(userId, wr.user_id);
      if (!inTeam) return res.status(403).json({ error: 'this technician is not on your team' });
    }
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 5) return res.status(400).json({ error: 'a reason is required (min 5 chars)' });
    if (reason.length > 2000) return res.status(400).json({ error: 'reason too long (max 2000 chars)' });

    const now = new Date().toISOString();
    const upd = db.prepare(`
      UPDATE wo_addition_requests
      SET status = 'denied', decided_by = ?, decided_at = ?, decision_reason = ?
      WHERE id = ? AND status = 'pending'
    `).run(userId, now, reason, reqId);
    if (upd.changes === 0) return res.status(409).json({ error: 'request was already decided — refresh and retry' });

    logAudit(db, { entity_type: 'wo_addition_requests', entity_id: reqId, user_id: userId,
                   action: 'deny_wo_addition', details: { reason } });
    notifyTechOfDecision({ request: wr, decided: 'denied', approverUserId: userId, approverName: me.name, reason });

    res.json({ ok: true, request: db.prepare("SELECT * FROM wo_addition_requests WHERE id = ?").get(reqId) });
  });

  // ============================================================
  // POST /api/invoices/:id/send-to-ap   { ap_email? }
  // ------------------------------------------------------------
  // Final hand-off after Sr Mgr approval. Allowed for: invoice owner (the
  // tech), Ops Mgr (if tech on team), Sr Mgr / PM. Generates the PDF, logs an
  // outbound notification (mock email), attaches the PDF to the invoice, and
  // moves status to 'sent_ap'.
  router.post('/invoices/:id/send-to-ap', async (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const perm = canActOnInvoice(id, userId);
    if (!perm.ok) return res.status(perm.status || 403).json({ error: perm.error });
    const inv = perm.inv;
    // v0.65.2 — Sr Mgr approval is OPTIONAL at all levels. An invoice can be
    // sent to AP after Ops approval alone (approved_ops) or after a Sr Mgr
    // countersign (approved_sr). Escalation no longer forces a Sr Mgr gate — it
    // simply surfaces the invoice in the Sr Mgr queue as an optional review.
    if (inv.status !== 'approved_ops' && inv.status !== 'approved_sr') {
      return res.status(409).json({ error: `invoice must be approved before it can be sent to AP (current: ${inv.status})` });
    }

    const me = db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId);
    // Resolution order: explicit body → org policy → env override → safety net.
    const policy  = getPolicy(db);
    const apEmail = (req.body.ap_email || policy.AP_EMAIL || process.env.AP_EMAIL || 'ap@instacart.com').trim();

    // Build the PDF payload by reusing computeInvoice + tech profile + audit.
    const computed = computeInvoice(id);
    const tech     = db.prepare("SELECT id, name, email, home_address, home_phone FROM users WHERE id = ?").get(inv.user_id);
    const approvals = buildApprovalAuditTrail(db, inv);
    let pdfBuf;
    try {
      pdfBuf = await generateInvoicePdf({
        invoice: computed.invoice, tech,
        lines: computed.lines, by_date: computed.by_date,
        summary: computed.summary, approvals,
      });
    } catch (e) {
      return res.status(500).json({ error: `PDF generation failed: ${e.message}` });
    }

    // Persist the PDF to disk and attach it to the invoice
    const fs = require('fs'), path = require('path'), crypto = require('crypto');
    const RECEIPT_DIR = path.join(__dirname, '..', 'data', 'receipts');
    fs.mkdirSync(RECEIPT_DIR, { recursive: true });
    const storageName  = `${crypto.randomUUID()}.pdf`;
    const originalName = `${inv.invoice_number || `invoice-${id}`}.pdf`;
    fs.writeFileSync(path.join(RECEIPT_DIR, storageName), pdfBuf);
    const attRow = db.prepare(`
      INSERT INTO attachments (user_id, invoice_id, storage_name, original_name, mime_type, size_bytes, caption)
      VALUES (?, ?, ?, ?, 'application/pdf', ?, ?)
    `).run(userId, inv.id, storageName, originalName, pdfBuf.length, 'Auto-generated for AP submission');
    const attachmentId = attRow.lastInsertRowid;

    // Log the outbound email (real sending is mocked in this dev build)
    const subject = `[AP] Invoice ${inv.invoice_number} — ${tech?.name || 'tech'} — $${inv.total.toFixed(2)}`;
    const body = renderEmailBody({ invoice: computed.invoice, tech, sender: me, approvals });
    db.prepare(`
      INSERT INTO notifications (kind, invoice_id, triggered_by, recipient, subject, body, attachment_id, status)
      VALUES ('invoice_to_ap', ?, ?, ?, ?, ?, ?, 'logged')
    `).run(inv.id, userId, apEmail, subject, body, attachmentId);
    console.log(`📧 [mock email] To: ${apEmail} · Subject: ${subject} · Attached: ${originalName} (${pdfBuf.length} bytes)`);

    // Transition status
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE invoices
      SET status = 'sent_ap', sent_to_ap_at = ?, sent_to_ap_by = ?, ap_email_to = ?
      WHERE id = ?
    `).run(now, userId, apEmail, id);

    logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId, action: 'send_to_ap',
                   details: { ap_email: apEmail, attachment_id: attachmentId, pdf_bytes: pdfBuf.length } });

    res.json({
      ok: true,
      invoice: { ...inv, status: 'sent_ap', sent_to_ap_at: now, sent_to_ap_by: userId, ap_email_to: apEmail },
      notification: { recipient: apEmail, subject, attachment_id: attachmentId },
      pdf_url: `/api/invoices/${id}/pdf`,
    });
  });

  // GET /api/invoices/:id/ap-preview?ap_email=...
  // Returns the rendered email payload (recipient, subject, body) the user
  // would send if they clicked "Send to AP" — without actually sending or
  // touching status. Used by the UI to show the preview before confirm.
  router.get('/invoices/:id/ap-preview', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const perm = canActOnInvoice(id, userId);
    if (!perm.ok) return res.status(perm.status || 403).json({ error: perm.error });
    const inv = perm.inv;
    const policy = getPolicy(db);
    const apEmail = (req.query.ap_email || policy.AP_EMAIL || process.env.AP_EMAIL || 'ap@instacart.com').trim();
    const me = db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId);
    const tech = db.prepare("SELECT id, name, email, home_address, home_phone FROM users WHERE id = ?").get(inv.user_id);
    const computed = computeInvoice(id);
    const approvals = buildApprovalAuditTrail(db, inv);
    const subject = `[AP] Invoice ${inv.invoice_number} — ${tech?.name || 'tech'} — $${inv.total.toFixed(2)}`;
    const body = renderEmailBody({ invoice: computed.invoice, tech, sender: me, approvals });
    res.json({
      recipient: apEmail,
      sender_name:  me?.name,
      sender_email: me?.email,
      subject,
      body,
      approvals,
      pdf_filename: `${inv.invoice_number || `invoice-${id}`}.pdf`,
      pdf_url: `/api/invoices/${id}/pdf`,
      already_sent: !!inv.sent_to_ap_at,
      // Tell the UI whether this invoice is in a state that allows sending
      can_send: inv.status === 'approved_ops' || inv.status === 'approved_sr',
      current_status: inv.status,
    });
  });

  // GET /api/invoices/:id/pdf  → on-demand PDF (re-generated each call so any
  // late edits / approvals are reflected).
  router.get('/invoices/:id/pdf', async (req, res) => {
    // v0.35 — auth middleware sets x-user-id from the bearer token (or ?token= for <a href>)
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const perm = canActOnInvoice(id, userId);
    if (!perm.ok) return res.status(perm.status || 403).json({ error: perm.error });
    const inv = perm.inv;
    const computed = computeInvoice(id);
    const tech = db.prepare("SELECT id, name, email, home_address, home_phone FROM users WHERE id = ?").get(inv.user_id);
    const approvals = buildApprovalAuditTrail(db, inv);
    try {
      const buf = await generateInvoicePdf({
        invoice: computed.invoice, tech,
        lines: computed.lines, by_date: computed.by_date,
        summary: computed.summary, approvals,
      });
      const filename = `${inv.invoice_number || `invoice-${id}`}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.send(buf);
    } catch (e) {
      res.status(500).json({ error: `PDF generation failed: ${e.message}` });
    }
  });

  // ============================================================
  // POST /api/invoices/vendor-upload  (Ops Mgr / Sr Mgr / PM)
  // ------------------------------------------------------------
  // 3rd-party vendor invoices uploaded by an Ops Mgr. Different shape from
  // the contractor labor flow: no work orders, no time entries, just vendor
  // metadata + a total. Status starts at `submitted` (skipping Ops Mgr
  // review since they uploaded it) and is routed straight to Sr Mgr.
  router.post('/invoices/vendor-upload', async (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT id, name, role FROM users WHERE id = ?").get(userId) : null;
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required to upload vendor invoices' });
    }

    let { vendor_name, vendor_invoice_number, vendor_invoice_date, total, notes,
            period_start, period_end, attachment,
            vendor_category /* v0.54 — deployment/retrofit/service/repair/parts/other */
        } = req.body || {};

    // v0.44 — BUG-005 fix: cap free-text fields up-front.
    if (typeof vendor_name === 'string' && vendor_name.length > 200)
      return res.status(400).json({ error: 'vendor_name max 200 chars' });
    if (typeof vendor_invoice_number === 'string' && vendor_invoice_number.length > 80)
      return res.status(400).json({ error: 'vendor_invoice_number max 80 chars' });
    if (typeof notes === 'string' && notes.length > 2000)
      return res.status(400).json({ error: 'notes max 2000 chars' });

    // v0.39 — If a PDF is attached, parse it FIRST and use the extracted
    // values to fill any missing manual fields. The Ops Mgr can still type
    // values in the form to override extraction.
    let extractedVendor = null;
    let pdfBuf = null;
    if (attachment && attachment.filename && attachment.data_b64) {
      const isPdf = (attachment.mime_type || '').toLowerCase().includes('pdf') ||
                    /\.pdf$/i.test(attachment.filename);
      if (isPdf) {
        try {
          pdfBuf = Buffer.from(attachment.data_b64, 'base64');
          const r = await extractVendorPdf(pdfBuf);
          if (r.ok) {
            // Validation gate. Vendor invoices already require a manual submit,
            // so this never blocks auto-posting (there isn't any) — it surfaces
            // issues (scanned PDF, total mismatch, line items that don't
            // reconcile to the subtotal) on the preview so the Ops Mgr can catch
            // them before submitting. See lib/invoiceValidation.js.
            const validation = validateInvoice({ kind: 'vendor', extraction: r, text: r.text });
            extractedVendor = {
              vendor_name:           r.vendor_name,
              vendor_invoice_number: r.vendor_invoice_number,
              vendor_invoice_date:   r.vendor_invoice_date,
              total:                 r.total,
              line_items:            r.line_items || [],
              extracted_text:        r.extracted_text,
              validation,
            };
            // Fill blanks from extraction. Anything the user typed wins.
            vendor_name           = vendor_name           || r.vendor_name;
            vendor_invoice_number = vendor_invoice_number || r.vendor_invoice_number;
            vendor_invoice_date   = vendor_invoice_date   || r.vendor_invoice_date;
            if (!total && r.total) total = r.total;
          }
        } catch (e) {
          console.error('[vendor-upload] extraction failed:', e.message);
        }
      }
    }

    // v0.39 — When a PDF is attached, we ALWAYS create a draft so the user
    // gets a preview screen even if extraction was partial. The draft preview
    // shows which fields are missing and refuses to submit until they're
    // filled in. Without a PDF, manual fields are still required (otherwise
    // we'd be creating an empty record).
    const amt = Number(total) || 0;
    const hasPdfBacking = !!extractedVendor;
    if (!hasPdfBacking) {
      const missing = [];
      if (!vendor_name)           missing.push('vendor_name');
      if (!vendor_invoice_number) missing.push('vendor_invoice_number');
      if (!vendor_invoice_date)   missing.push('vendor_invoice_date');
      if (!(amt > 0))             missing.push('total');
      if (missing.length) {
        return res.status(400).json({
          error: `Required: ${missing.join(', ')}. Attach a PDF to auto-extract these.`,
          missing,
        });
      }
    }

    // Period defaults to the week containing the vendor invoice date when
    // we have a date; otherwise we fall back to the current week (the user
    // can correct it on the preview page). v0.39
    const dateForPeriod = vendor_invoice_date || new Date().toISOString().slice(0, 10);
    const ps = (period_start && /^\d{4}-\d{2}-\d{2}$/.test(period_start))
      ? period_start
      : weekBounds(new Date(dateForPeriod)).start;
    const pe = (period_end && /^\d{4}-\d{2}-\d{2}$/.test(period_end))
      ? period_end
      : weekBounds(new Date(dateForPeriod)).end;

    // Build a unique invoice number. We always have *some* identifier — when
    // the date / vendor # came from extraction we use them; otherwise we
    // synthesize a placeholder ("VND-DRAFT-<timestamp>") that the user can
    // fix on the edit screen. v0.39
    const dateKey = (vendor_invoice_date || '').replace(/-/g, '').slice(0, 8) || `DRAFT${Date.now().toString().slice(-8)}`;
    const numKey  = (vendor_invoice_number || '').replace(/[^A-Za-z0-9-]/g, '') || 'PENDING';
    const baseNum = `VND-${dateKey}-${numKey}`;
    const existingNums = new Set(db.prepare(
      `SELECT invoice_number FROM invoices WHERE invoice_number LIKE ?`
    ).all(`${baseNum}%`).map(r => r.invoice_number));
    let invoiceNum = baseNum;
    for (let s = 'A'.charCodeAt(0); existingNums.has(invoiceNum); s++) {
      if (s > 'Z'.charCodeAt(0)) { invoiceNum = `${baseNum}-${Date.now()}`; break; }
      invoiceNum = `${baseNum}-${String.fromCharCode(s)}`;
    }

    // v0.38 — Vendor invoices land as `draft` so the Ops Mgr can review the
    // preview (extracted total, vendor name, attached file) before clicking
    // "Submit to Sr Mgr". The dedicated /vendor-submit endpoint flips it to
    // `submitted` and stamps submitted_at.
    const r = db.prepare(`
      INSERT INTO invoices (
        invoice_number, user_id, period_start, period_end,
        status, total, notes, created_by, origin,
        invoice_type, vendor_name, vendor_invoice_number, vendor_invoice_date,
        vendor_category
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, 'mgr_upload',
                'vendor', ?, ?, ?, ?)
    `).run(invoiceNum, me.id, ps, pe, +amt.toFixed(2),
           notes || null, me.id,
           vendor_name ? vendor_name.trim() : null,
           vendor_invoice_number ? vendor_invoice_number.trim() : null,
           vendor_invoice_date || null,
           vendor_category || null);
    const invoiceId = r.lastInsertRowid;

    // Attach the original file if provided
    let attachmentId = null;
    if (attachment && attachment.filename && attachment.data_b64) {
      const fs = require('fs'), path = require('path'), crypto = require('crypto');
      const RECEIPT_DIR = path.join(__dirname, '..', 'data', 'receipts');
      fs.mkdirSync(RECEIPT_DIR, { recursive: true });
      const buf = Buffer.from(attachment.data_b64, 'base64');
      if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'file > 20MB' });
      const ext  = path.extname(attachment.filename) || '.bin';
      const name = `${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(RECEIPT_DIR, name), buf);
      const ar = db.prepare(`
        INSERT INTO attachments (user_id, invoice_id, storage_name, original_name, mime_type, size_bytes, caption)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(me.id, invoiceId, name, attachment.filename, attachment.mime_type || null, buf.length,
             `Vendor invoice from ${vendor_name}`);
      attachmentId = ar.lastInsertRowid;
    }

    // v0.39 — persist the extracted text + extraction summary so the
    // preview UI can show "what we pulled from the PDF" and the user can
    // re-run extraction if they edit something else.
    if (extractedVendor) {
      db.prepare(`
        UPDATE invoices SET extracted_text = ?, extracted_summary = ?, extracted_at = ?
        WHERE id = ?
      `).run(
        extractedVendor.extracted_text,
        JSON.stringify({
          vendor_name:           extractedVendor.vendor_name,
          vendor_invoice_number: extractedVendor.vendor_invoice_number,
          vendor_invoice_date:   extractedVendor.vendor_invoice_date,
          total:                 extractedVendor.total,
          line_items:            extractedVendor.line_items || [],
          _validation:           extractedVendor.validation,
        }),
        new Date().toISOString(),
        invoiceId
      );
    }

    logAudit(db, { entity_type: 'invoices', entity_id: invoiceId, user_id: userId,
                   action: 'vendor_upload',
                   details: { vendor_name, vendor_invoice_number, total: amt, attachment_id: attachmentId,
                              auto_extracted: !!extractedVendor } });

    const invRow = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId);
    res.json({ ...invRow, auto_extracted: !!extractedVendor, extracted: extractedVendor
      ? { ...extractedVendor, extracted_text: undefined } : null });
  });

  // ------------------------------------------------------------
  // PATCH /api/invoices/:id/vendor-update  (Ops Mgr / Sr Mgr / PM, draft only)
  // ------------------------------------------------------------
  // Edit vendor invoice metadata while it's still a draft. Lets the uploader
  // fix the vendor name, invoice #, date, total, period, or notes after
  // reviewing the preview.
  router.patch('/invoices/:id/vendor-update', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) : null;
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }

    const id  = Number(req.params.id);
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
    if (!inv) return res.status(404).json({ error: 'not found' });
    if (inv.invoice_type !== 'vendor') return res.status(409).json({ error: 'not a vendor invoice' });
    if (inv.status !== 'draft')        return res.status(409).json({ error: `invoice is ${inv.status}, not draft` });
    if (inv.user_id !== me.id && me.role === 'ops_manager') {
      return res.status(403).json({ error: 'only the uploader (or Sr Mgr / PM) can edit this draft' });
    }

    const updates = {};
    const allowed = ['vendor_name','vendor_invoice_number','vendor_invoice_date',
                     'total','notes','period_start','period_end',
                     'vendor_category'];   // v0.54 — categorize vendor work
    for (const f of allowed) if (req.body[f] !== undefined) updates[f] = req.body[f];

    if ('total' in updates) {
      const n = Number(updates.total);
      if (!isFinite(n) || n <= 0) return res.status(400).json({ error: 'total must be > 0' });
      updates.total = +n.toFixed(2);
    }
    for (const dateField of ['vendor_invoice_date','period_start','period_end']) {
      if (dateField in updates && updates[dateField] && !/^\d{4}-\d{2}-\d{2}$/.test(updates[dateField])) {
        return res.status(400).json({ error: `${dateField} must be YYYY-MM-DD` });
      }
    }
    // v0.44 — BUG-005 fix: cap free-text fields.
    if (typeof updates.vendor_name === 'string' && updates.vendor_name.length > 200)
      return res.status(400).json({ error: 'vendor_name max 200 chars' });
    if (typeof updates.vendor_invoice_number === 'string' && updates.vendor_invoice_number.length > 80)
      return res.status(400).json({ error: 'vendor_invoice_number max 80 chars' });
    if (typeof updates.notes === 'string' && updates.notes.length > 2000)
      return res.status(400).json({ error: 'notes max 2000 chars' });

    if (Object.keys(updates).length === 0) {
      return res.json(inv); // nothing to change
    }
    const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    db.prepare(`UPDATE invoices SET ${setSql} WHERE id = ?`).run(...values, id);

    logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId,
                   action: 'vendor_update', details: updates });

    res.json(db.prepare("SELECT * FROM invoices WHERE id = ?").get(id));
  });

  // ------------------------------------------------------------
  // DELETE /api/invoices/:id  (vendor drafts only; uploader / Sr Mgr / PM)
  // ------------------------------------------------------------
  // Discard a vendor draft. Cleans up the row + any attachments. Tech-labor
  // invoices keep using soft state (rejected) and aren't deletable.
  router.delete('/invoices/:id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) : null;
    if (!me) return res.status(401).json({ error: 'no user selected' });

    const id  = Number(req.params.id);
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
    if (!inv) return res.status(404).json({ error: 'not found' });
    if (inv.invoice_type !== 'vendor') return res.status(409).json({ error: 'only vendor invoices can be deleted; use reject for tech-labor' });
    if (inv.status !== 'draft')        return res.status(409).json({ error: `invoice is ${inv.status}, not draft — cannot delete` });
    if (inv.user_id !== me.id && !['sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'only the uploader (or Sr Mgr / PM) can discard this draft' });
    }

    // Best-effort cleanup of on-disk attachment files. Missing files are
    // ignored — we still want the DB rows to delete cleanly.
    const fs   = require('fs');
    const path = require('path');
    const RECEIPT_DIR = path.join(__dirname, '..', 'data', 'receipts');
    const atts = db.prepare("SELECT storage_name FROM attachments WHERE invoice_id = ?").all(id);
    // v0.65.1 (F-M5) — delete atomically and clear referencing rows
    // (notifications) BEFORE the invoice, then unlink files only AFTER the DB
    // commit, so a failed delete can't leave disk and DB disagreeing.
    db.exec('BEGIN;');
    try {
      try { db.prepare("DELETE FROM notifications WHERE invoice_id = ? OR attachment_id IN (SELECT id FROM attachments WHERE invoice_id = ?)").run(id, id); } catch (_) {}
      db.prepare("DELETE FROM attachments WHERE invoice_id = ?").run(id);
      db.prepare("DELETE FROM invoices WHERE id = ?").run(id);
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      return res.status(409).json({ error: 'could not delete invoice — it may still be referenced elsewhere' });
    }
    for (const a of atts) {
      try { fs.unlinkSync(path.join(RECEIPT_DIR, a.storage_name)); } catch (_) {}
    }
    logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId,
                   action: 'vendor_discard',
                   details: { vendor_name: inv.vendor_name, total: inv.total } });
    res.json({ ok: true, deleted: id });
  });

  // ------------------------------------------------------------
  // POST /api/invoices/:id/vendor-submit  (Ops Mgr who uploaded, Sr Mgr, PM)
  // ------------------------------------------------------------
  // Flips a vendor invoice from `draft` → `submitted` so the Sr Mgr's queue
  // sees it. This replaces the legacy "create as submitted" behavior — now
  // the uploader gets a preview/edit step first.
  router.post('/invoices/:id/vendor-submit', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) : null;
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }

    const id  = Number(req.params.id);
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
    if (!inv) return res.status(404).json({ error: 'not found' });
    if (inv.invoice_type !== 'vendor') return res.status(409).json({ error: 'not a vendor invoice' });
    if (inv.status !== 'draft')        return res.status(409).json({ error: `invoice is ${inv.status}, not draft` });
    if (inv.user_id !== me.id && me.role === 'ops_manager') {
      return res.status(403).json({ error: 'only the uploader (or Sr Mgr / PM) can submit this draft' });
    }
    if (!inv.vendor_name || !inv.vendor_invoice_number || !inv.vendor_invoice_date || !(inv.total > 0)) {
      return res.status(400).json({ error: 'vendor_name, vendor_invoice_number, vendor_invoice_date, and a positive total are required before submit' });
    }

    // v0.44 — BUG-006 fix: race-safe state transition. The UPDATE asserts the
    // current status in the WHERE clause; if another caller already flipped
    // it, changes() === 0 and we return 409 instead of double-submitting.
    const now = new Date().toISOString();
    const r = db.prepare(`
      UPDATE invoices SET status = 'submitted', submitted_at = ?
      WHERE id = ? AND status = 'draft' AND invoice_type = 'vendor'
    `).run(now, id);
    if (r.changes === 0) {
      return res.status(409).json({ error: 'invoice was already submitted by another action — refresh and try again' });
    }
    logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: userId,
                   action: 'vendor_submit' });
    res.json(db.prepare("SELECT * FROM invoices WHERE id = ?").get(id));
  });

  // ------------------------------------------------------------
  // POST /api/invoices/:id/send-to-expensify  (FTE field techs only)
  // ------------------------------------------------------------
  // v0.48 — Routes a field tech's invoice line items into Expensify for
  // employee-side approval. ONLY available to FTE techs (worker_type='fte');
  // contractors stay on the existing PDF→AP flow.
  //
  // Flow:
  //   1. Caller is the tech (or a manager acting on behalf of an FTE).
  //   2. Invoice must be `submitted` or later (not draft) and not already sent.
  //   3. Pull all time entries + expenses for the invoice.
  //   4. Build Expensify transactions via lib/expensify.buildTransactions.
  //   5. POST to Expensify (or stub) → get reportID + reportURL.
  //   6. Persist on the invoice and return.
  router.post('/invoices/:id/send-to-expensify', async (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(userId) : null;
    if (!me) return res.status(401).json({ error: 'no user selected' });

    const id  = Number(req.params.id);
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
    if (!inv) return res.status(404).json({ error: 'not found' });

    // Look up the OWNER tech (whose invoice this is) and check FTE status.
    const owner = db.prepare("SELECT id, name, email, worker_type, hourly_rate FROM users WHERE id = ?").get(inv.user_id);
    if (!owner) return res.status(404).json({ error: 'invoice owner not found' });
    if (owner.worker_type !== 'fte') {
      return res.status(403).json({ error: 'Expensify export is only available for FTE techs. Contractors keep the PDF / AP flow.' });
    }

    // Permission: owner, sr_manager, pm, OR ops_manager who manages this tech.
    if (me.id !== owner.id && !['sr_manager','pm'].includes(me.role)) {
      const inTeam = me.role === 'ops_manager' && db.prepare(
        "SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?"
      ).get(me.id, owner.id);
      if (!inTeam) return res.status(403).json({ error: 'not authorized for this invoice' });
    }

    // Invoice must be at least submitted (don't ship drafts to Expensify).
    if (!['submitted','approved_ops','approved_sr','queued_ap','sent_ap'].includes(inv.status)) {
      return res.status(409).json({ error: `invoice is ${inv.status}; submit before sending to Expensify` });
    }
    if (inv.expensify_report_id) {
      return res.status(409).json({
        error: 'invoice already sent to Expensify',
        expensify_report_id: inv.expensify_report_id,
        expensify_report_url: inv.expensify_report_url,
      });
    }
    if (inv.invoice_type === 'vendor') {
      return res.status(409).json({ error: 'vendor invoices do not go to Expensify' });
    }

    // Pull time entries + expenses for the invoice.
    const time_entries = db.prepare(`
      SELECT t.*, w.external_id, w.work_type, w.store_name
      FROM time_entries t JOIN work_orders w ON w.id = t.work_order_id
      WHERE t.invoice_id = ?
        AND t.clock_out IS NOT NULL
        AND (t.mode IS NULL OR t.mode = 'work')
      ORDER BY t.clock_in
    `).all(id);
    const expenses = db.prepare(`
      SELECT e.*, w.external_id, w.store_name
      FROM expenses e JOIN work_orders w ON w.id = e.work_order_id
      WHERE e.invoice_id = ?
      ORDER BY e.expense_date, e.id
    `).all(id);
    if (!time_entries.length && !expenses.length) {
      return res.status(400).json({ error: 'invoice has no time entries or expenses to send' });
    }

    const { buildTransactions, createReport } = require('../lib/expensify');
    const settings = require('./settings');
    const creds = {
      partnerUserID:     settings.read(db, 'expensify_partner_user_id',  'EXPENSIFY_PARTNER_USER_ID'),
      partnerUserSecret: settings.read(db, 'expensify_partner_password', 'EXPENSIFY_PARTNER_PASSWORD'),
      policyID:          settings.read(db, 'expensify_policy_id',        'EXPENSIFY_POLICY_ID'),
    };

    const transactions = buildTransactions({
      time_entries, expenses,
      hourly_rate:  owner.hourly_rate || 40,
      mileage_rate: getPolicy(db).MILEAGE_RATE,
    });

    let reportInfo;
    try {
      reportInfo = await createReport({
        employeeEmail: owner.email,
        reportName:    `${inv.invoice_number} — ${owner.name} — ${inv.period_start} → ${inv.period_end}`,
        transactions,
      }, creds);
    } catch (e) {
      console.error('[expensify]', e);
      return res.status(502).json({ error: e.message || 'Expensify export failed' });
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE invoices
      SET expensify_report_id = ?, expensify_report_url = ?,
          expensify_sent_at = ?, expensify_sent_by = ?
      WHERE id = ?
    `).run(reportInfo.reportID, reportInfo.reportURL, now, me.id, id);

    logAudit(db, { entity_type: 'invoices', entity_id: id, user_id: me.id,
                   action: 'expensify_export',
                   details: {
                     report_id: reportInfo.reportID, stubbed: !!reportInfo.stubbed,
                     txn_count: transactions.length, total_cents: reportInfo.totalCents,
                   } });

    res.json({
      ok: true,
      ...reportInfo,
      sent_at: now,
      transaction_count: transactions.length,
      invoice: db.prepare("SELECT * FROM invoices WHERE id = ?").get(id),
    });
  });

  return router;
};

// Resolve approval audit trail for a single invoice — looks up the user names
// for each timestamp and returns a print-ready array.
function buildApprovalAuditTrail(db, inv) {
  function userLabel(uid) {
    if (!uid) return null;
    const u = db.prepare("SELECT name, email, role FROM users WHERE id = ?").get(uid);
    return u ? `${u.name} <${u.email}> (${u.role})` : `user #${uid}`;
  }
  function ts(s) { return s ? new Date(s).toLocaleString() : null; }
  const out = [];
  if (inv.created_at)      out.push({ label: 'Drafted',          at: inv.created_at,      value: ts(inv.created_at) });
  if (inv.submitted_at)    out.push({ label: 'Submitted',        at: inv.submitted_at,    value: `${ts(inv.submitted_at)}` });
  if (inv.approved_ops_at) out.push({ label: 'Ops Mgr approved', at: inv.approved_ops_at, value: `${ts(inv.approved_ops_at)} — ${userLabel(inv.approved_ops_by) || ''}` });
  if (inv.approved_sr_at)  out.push({ label: 'Sr Mgr approved',  at: inv.approved_sr_at,  value: `${ts(inv.approved_sr_at)} — ${userLabel(inv.approved_sr_by) || ''}` });
  if (inv.sent_to_ap_at)   out.push({ label: 'Sent to AP',       at: inv.sent_to_ap_at,   value: `${ts(inv.sent_to_ap_at)} — ${userLabel(inv.sent_to_ap_by) || ''} → ${inv.ap_email_to || ''}` });
  if (inv.rejected_at)     out.push({ label: 'Rejected',         at: inv.rejected_at,     value: `${ts(inv.rejected_at)} — ${inv.rejection_reason || ''}` });
  return out;
}

function renderEmailBody({ invoice, tech, sender }) {
  // Keep this short and clean — the audit trail lives in the attached PDF as
  // the formal record, so AP doesn't need the timestamps in the email body.
  return [
    `Hi AP team,`,
    ``,
    `Please find attached invoice ${invoice.invoice_number} from ${tech?.name || ''} for the period ${invoice.period_start} → ${invoice.period_end}.`,
    ``,
    `Total: $${invoice.total.toFixed(2)}`,
    ``,
    `Sent by ${sender?.name || ''} via Caper CostWise.`,
  ].join('\n');
}

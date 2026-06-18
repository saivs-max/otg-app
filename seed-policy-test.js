// seed-policy-test.js  (v0.57)
//
// Deterministic test fixture for the policy engine. Seeds users, work orders,
// custom rules covering every rule_type, and time/expense data carefully
// designed to make each rule fire (and one clean WO that shouldn't fire any).
//
// Usage:
//   npm run reset:policy
//   npm start
//
// Sign in as Aramiwale Shittu (tech), open the draft for the test week — every
// flagged line is annotated. Sign in as Maitland Kelly (Ops Mgr) to see the
// queue with the invoice highlighted.
//
// Re-runs are safe (FK-safe wipe identical to seed.js v0.53 fix).

const { open, ensureSchema } = require('./db');
const { hashPassword } = require('./lib/auth');

const db = open();
ensureSchema(db);

console.log('Wiping existing data…');
db.exec('PRAGMA foreign_keys = OFF');
[
  'sessions','notifications','attachments','audit_log','launch_actuals',
  'cost_tracker_overrides','expenses','time_entries','invoices',
  'work_orders','custom_rules','manager_team','settings','users',
].forEach(t => { try { db.exec(`DELETE FROM ${t}`); } catch (e) { console.warn(`[seed-policy-test] skip ${t}: ${e.message}`); } });
try { db.exec("DELETE FROM sqlite_sequence"); } catch {}
db.exec('PRAGMA foreign_keys = ON');

// ---------- Users ----------
const DEMO_PWD = hashPassword('password123');
const NOW = new Date().toISOString();
const insUser = db.prepare(`
  INSERT INTO users (name, email, username, role, worker_type, hourly_rate, ops_manager_id,
                     password_hash, password_set_at, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
`);

const opsId = insUser.run("Maitland Kelly",   "maitland.k@instacart.com", "maitland",  "ops_manager", null, null, null, DEMO_PWD, NOW).lastInsertRowid;
const srId  = insUser.run("Reshmi Chowdhury", "reshmi.c@instacart.com",   "reshmi",    "sr_manager",  null, null, null, DEMO_PWD, NOW).lastInsertRowid;
            insUser.run("Sai V.",             "sai.vs@instacart.com",     "sai",       "pm",          null, null, null, DEMO_PWD, NOW);
const tech1 = insUser.run("Aramiwale Shittu", "aramiwale@example.com",    "aramiwale", "technician", "contractor", 40.0, opsId, DEMO_PWD, NOW).lastInsertRowid;

db.prepare("UPDATE users SET home_address = ?, home_phone = ? WHERE id = ?")
  .run("24 Mayflower Drive, Sicklerville, NJ 08081", "856-725-2298", tech1);

db.prepare("INSERT INTO manager_team (manager_user_id, tech_user_id) VALUES (?, ?)").run(opsId, tech1);

// ---------- Work orders sized for the rule scenarios ----------
const insWO = db.prepare(`
  INSERT INTO work_orders (external_id, source_system, source_ticket_id, title, work_type,
                           store_id, store_name, cart_count, scheduled_date, description,
                           status, assigned_user_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const today = new Date();
const iso   = (d) => d.toISOString().slice(0,10);
const days  = (n) => { const d = new Date(today); d.setDate(d.getDate()+n); return iso(d); };
// Use Mon-Sun for the current week so the test draft lines up with weekly logic.
const day = today.getDay();
const monday = new Date(today); monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
const periodStart = iso(monday);
const periodEndD  = new Date(monday); periodEndD.setDate(monday.getDate() + 6);
const periodEnd   = iso(periodEndD);

// Days within the period
const PMON = iso(monday);
const PTUE = (() => { const d = new Date(monday); d.setDate(monday.getDate() + 1); return iso(d); })();
const PWED = (() => { const d = new Date(monday); d.setDate(monday.getDate() + 2); return iso(d); })();
const PTHU = (() => { const d = new Date(monday); d.setDate(monday.getDate() + 3); return iso(d); })();
const PFRI = (() => { const d = new Date(monday); d.setDate(monday.getDate() + 4); return iso(d); })();

const woA = insWO.run("MX-DPL-2406-901", "maintainx", "901",
  "TEST · Whole Foods Edgewater — 12 Cart Deployment",
  "deployment", "WF-EDG", "Whole Foods Edgewater", 12, periodStart,
  "TEST FIXTURE — over-billed deployment used to exercise multiple policy rules.",
  "in_progress", tech1).lastInsertRowid;

const woB = insWO.run("FD-MNT-2406-902", "freshdesk", "902",
  "TEST · ShopRite Hoboken — Service Visit",
  "maintenance", "SR-HOB", "ShopRite Hoboken", 1, periodStart,
  "TEST FIXTURE — meal expense scenarios (cap + receipt rule).",
  "completed", tech1).lastInsertRowid;

const woC = insWO.run("MX-RTR-2406-903", "maintainx", "903",
  "TEST · Whole Foods Englewood — Clean Retrofit",
  "retrofit", "WF-ENG", "Whole Foods Englewood", 5, periodStart,
  "TEST FIXTURE — should produce ZERO flags (negative test).",
  "completed", tech1).lastInsertRowid;

// ---------- Custom rules (one per rule_type) ----------
const insRule = db.prepare(`
  INSERT INTO custom_rules (rule_type, work_type_filter, category_filter, cart_count_min,
                            threshold, description, severity, active, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
`);

const RULES = [
  { type: 'max_hours_per_shift',     filter: null,         cat: null,    cm: null, th: 10,  sev: 'flag',  desc: 'Single shift over 10 hrs flagged.' },
  { type: 'max_hours_per_day',       filter: null,         cat: null,    cm: null, th: 12,  sev: 'flag',  desc: 'More than 12 work hrs on one date flagged.' },
  { type: 'max_drive_hours_per_day', filter: null,         cat: null,    cm: null, th: 3,   sev: 'flag',  desc: 'More than 3 drive hrs on one date flagged.' },
  { type: 'max_miles_per_day',       filter: null,         cat: null,    cm: null, th: 200, sev: 'flag',  desc: 'More than 200 mi on one date flagged.' },
  { type: 'max_expense_amount',      filter: null,         cat: 'other', cm: null, th: 50,  sev: 'flag',  desc: 'Other-category expense > $50 flagged.' },
  { type: 'require_receipt_above',   filter: null,         cat: 'other', cm: null, th: 25,  sev: 'flag',  desc: 'Other-category expense > $25 needs a receipt.' },
  { type: 'max_hours_per_wo',        filter: 'deployment', cat: null,    cm: 10,   th: 14,  sev: 'flag',  desc: 'Deployment with ≥10 carts: labor cap 14 hrs.' },
  { type: 'max_hours_per_10_carts',  filter: 'deployment', cat: null,    cm: 5,    th: 10,  sev: 'flag',  desc: 'Deployment productivity: max 10 hrs per 10 carts.' },
];
for (const r of RULES) {
  insRule.run(r.type, r.filter, r.cat, r.cm, r.th, r.desc, r.sev, opsId);
}

// ---------- Draft invoice for this Mon–Sun ----------
const invoiceNumber = `INV-${periodEnd.replace(/-/g, '')}-U${String(tech1).padStart(2,'0')}-TEST`;
const invRes = db.prepare(`
  INSERT INTO invoices (invoice_number, user_id, period_start, period_end, status, total, origin, created_by, notes)
  VALUES (?, ?, ?, ?, 'draft', 0, 'tech_self', ?, ?)
`).run(invoiceNumber, tech1, periodStart, periodEnd, tech1,
       'TEST FIXTURE — should produce 7+ flags across 2 work-orders. WO_C should be clean.');
const invoiceId = invRes.lastInsertRowid;

// ---------- Time entries — designed to trip rules on WO_A ----------
const insTime = db.prepare(`
  INSERT INTO time_entries (user_id, work_order_id, clock_in, clock_out, break_minutes, notes, mode, invoice_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const tISO = (date, h, m=0) => `${date}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;

// WO_A — Monday: a single 14-hour shift → trips max_hours_per_shift AND max_hours_per_day.
insTime.run(tech1, woA, tISO(PMON, 7, 0), tISO(PMON, 21, 0), 0,
  'TEST · 14-hour deployment shift — should flag max_hours_per_shift (>10) and max_hours_per_day (>12)',
  'work', invoiceId);

// WO_A — Tuesday: 6 hrs labor + 4 drive entries totaling 5 drive hrs → trips max_drive_hours_per_day.
insTime.run(tech1, woA, tISO(PTUE, 8, 0),  tISO(PTUE, 14, 0), 0,
  'TEST · 6-hr labor on Tuesday', 'work', invoiceId);
insTime.run(tech1, woA, tISO(PTUE, 6, 0),  tISO(PTUE, 7, 30), 0,
  'TEST · drive leg 1 (1.5h)', 'drive', invoiceId);
insTime.run(tech1, woA, tISO(PTUE, 14, 0), tISO(PTUE, 15, 0), 0,
  'TEST · drive leg 2 (1.0h)', 'drive', invoiceId);
insTime.run(tech1, woA, tISO(PTUE, 17, 0), tISO(PTUE, 19, 30), 0,
  'TEST · drive leg 3 (2.5h) — combined drive on Tuesday = 5.0 hrs, should flag max_drive_hours_per_day (>3)',
  'drive', invoiceId);

// WO_A — extra labor across remaining days so total labor crosses
// max_hours_per_wo (>14 for deployment ≥10 carts) AND max_hours_per_10_carts
// (>10 hrs / 10 carts). Total labor = 14 + 6 + 8 = 28 hrs on a 12-cart deployment.
insTime.run(tech1, woA, tISO(PWED, 8, 0), tISO(PWED, 16, 0), 0,
  'TEST · 8-hr labor Wednesday — pushes WO total to 28 hrs / 12 carts (23.3 hrs/10-carts)',
  'work', invoiceId);

// WO_B — short labor (under all caps)
insTime.run(tech1, woB, tISO(PTHU, 10, 0), tISO(PTHU, 12, 0), 0,
  'TEST · 2-hr service visit', 'work', invoiceId);

// WO_C — clean: well under any cap
insTime.run(tech1, woC, tISO(PFRI, 9, 0), tISO(PFRI, 16, 0), 30,
  'TEST · 6.5-hr clean retrofit shift (no rule violations)', 'work', invoiceId);

// ---------- Expenses — trips mileage, meal cap, receipt rule ----------
const insExp = db.prepare(`
  INSERT INTO expenses (user_id, work_order_id, category, subcategory, expense_date, amount, quantity, rate, description, receipt_path, invoice_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// WO_A — 250 mi on Wednesday → trips max_miles_per_day (>200)
insExp.run(tech1, woA, 'mileage', null, PWED, +(250 * 0.725).toFixed(2), 250, 0.725,
  'TEST · 250 mi single-day mileage — should flag max_miles_per_day (>200)', null, invoiceId);

// WO_B — $80 meal (over $50 cap) AND $40 meal with no receipt (over $25 receipt rule).
// Both are "other / Meal" so both rules fire on each.
insExp.run(tech1, woB, 'other', 'Meal', PTHU, 80.00, null, null,
  'TEST · $80 meal — should flag max_expense_amount (other > $50)', null, invoiceId);
insExp.run(tech1, woB, 'other', 'Meal', PTHU, 40.00, null, null,
  'TEST · $40 meal, no receipt — should flag require_receipt_above (>$25)', null, invoiceId);

// WO_C — clean expenses, with receipts
insExp.run(tech1, woC, 'mileage', null, PFRI,  +(40 * 0.725).toFixed(2), 40, 0.725,
  'TEST · 40 mi clean mileage', null, invoiceId);
insExp.run(tech1, woC, 'parking', null, PFRI, 8.00, null, null,
  'TEST · $8 parking', '/fake/receipt-1.jpg', invoiceId);

// ---------- Auto-submit so Ops Mgr's queue sees it immediately ----------
const submittedAt = new Date().toISOString();
db.prepare("UPDATE invoices SET status = 'submitted', submitted_at = ? WHERE id = ?")
  .run(submittedAt, invoiceId);

// ---------- Compute flags via the live rules engine so the fixture reports
// exactly what the user will see in the UI. We import the route module just
// to grab its `.evaluate(...)` export (the function is attached to the
// exported router under `module.exports.evaluate`).
const rulesEvaluator = require('./routes/rules');
const { POLICY, getPolicy, sumHours } = require('./db');

function flagsForInvoice(invId) {
  const inv  = db.prepare("SELECT * FROM invoices WHERE id = ?").get(invId);
  const user = db.prepare("SELECT hourly_rate FROM users WHERE id = ?").get(inv.user_id);
  const POL  = getPolicy(db);
  const rate = user.hourly_rate || POL.HOURLY_RATE_DEFAULT;

  const allTimes = db.prepare(`
    SELECT t.*, w.external_id, w.source_system, w.work_type, w.store_name, w.cart_count, w.description AS wo_description
    FROM time_entries t JOIN work_orders w ON w.id = t.work_order_id
    WHERE t.invoice_id = ? ORDER BY t.clock_in
  `).all(invId);
  const times = allTimes.filter(t => (t.mode || 'work') === 'work');
  const expenses = db.prepare(`
    SELECT e.*, w.external_id, w.work_type, w.store_name, w.cart_count
    FROM expenses e JOIN work_orders w ON w.id = e.work_order_id
    WHERE e.invoice_id = ? ORDER BY e.expense_date, e.id
  `).all(invId);

  // Group into byWO lines like computeInvoice does.
  const byWO = {};
  for (const t of allTimes) {
    const k = t.external_id;
    byWO[k] ||= { external_id: k, work_type: t.work_type, store_name: t.store_name, cart_count: t.cart_count, labor_hours: 0 };
    if ((t.mode || 'work') === 'work') byWO[k].labor_hours += sumHours([t]);
  }
  for (const e of expenses) {
    const k = e.external_id;
    byWO[k] ||= { external_id: k, work_type: e.work_type, store_name: e.store_name, cart_count: e.cart_count, labor_hours: 0 };
  }

  const all = [];
  for (const line of Object.values(byWO)) {
    const lineFlags = rulesEvaluator.evaluate(db, line,
      expenses.filter(e => e.external_id === line.external_id),
      allTimes.filter(t => t.external_id === line.external_id).map(t => ({
        external_id: t.external_id, clock_in: t.clock_in, clock_out: t.clock_out,
        mode: t.mode || 'work', hours: sumHours([t]),
      }))
    );
    for (const f of lineFlags) all.push({ wo: line.external_id, store: line.store_name, ...f });
  }
  return all;
}

const computed_flags = flagsForInvoice(invoiceId);

// ---------- Report ----------
console.log("");
console.log("✓ Seeded POLICY TEST fixture at", require('./db').DB_PATH);
console.log("");
console.log("  Test period: " + periodStart + " → " + periodEnd);
console.log("  Tech:        Aramiwale Shittu (id=" + tech1 + ", contractor, $40/hr)");
console.log("  Ops Mgr:     Maitland Kelly (id=" + opsId + ")");
console.log("  Sr Mgr:      Reshmi Chowdhury (id=" + srId + ")");
console.log("");
console.log("  Active rules: " + db.prepare("SELECT COUNT(*) AS n FROM custom_rules WHERE active = 1").get().n);
db.prepare("SELECT rule_type, threshold, work_type_filter, cart_count_min FROM custom_rules ORDER BY id").all().forEach(r => {
  const filter = r.work_type_filter ? ` [${r.work_type_filter}]` : '';
  const carts  = r.cart_count_min ? ` cart_min=${r.cart_count_min}` : '';
  console.log(`    • ${r.rule_type.padEnd(28)} threshold=${r.threshold}${filter}${carts}`);
});
console.log("");
console.log("  Draft invoice: " + invoiceNumber);
console.log("  Expected violations:");
console.log("    WO_A (MX-DPL-2406-901, deployment, 12 carts):");
console.log("      • max_hours_per_shift     (Mon 14-hr shift > 10)");
console.log("      • max_hours_per_day       (Mon 14 work hrs > 12)");
console.log("      • max_drive_hours_per_day (Tue 5 drive hrs > 3)");
console.log("      • max_miles_per_day       (Wed 250 mi > 200)");
console.log("      • max_hours_per_wo        (28 labor hrs > 14 cap for ≥10-cart deployment)");
console.log("      • max_hours_per_10_carts  (28 hrs / 1.2 cart-tens = 23.3 hrs/10 carts > 10)");
console.log("    WO_B (FD-SVC-2406-902, service):");
console.log("      • max_expense_amount      ($80 meal > $50 cap, category=other)");
console.log("      • require_receipt_above   ($40 meal, no receipt > $25)");
console.log("    WO_C (MX-RTR-2406-903, retrofit, 5 carts):");
console.log("      • (clean — should produce ZERO flags)");
console.log("");
console.log("");
console.log("  ── FLAGS ACTUALLY FIRED by the live rules engine ──");
if (computed_flags.length === 0) {
  console.log("    (none — check that the fixture data was inserted correctly)");
} else {
  let lastWO = null;
  for (const f of computed_flags) {
    if (f.wo !== lastWO) {
      console.log(`\n    ${f.wo}  (${f.store || '—'}):`);
      lastWO = f.wo;
    }
    console.log(`      [${f.severity}]  ${f.rule.padEnd(28)}  ${f.message}`);
  }
}
console.log("");
console.log("  Invoice is auto-submitted, so:");
console.log("    • Field tech (Aramiwale)  → sees the submitted invoice with flag annotations");
console.log("    • Ops Mgr   (Maitland)    → sees it in /queue, can approve or reject");
console.log("    • Sr Mgr    (Reshmi)      → sees it AFTER Ops Mgr approves (status: approved_ops)");
console.log("    • PM        (Sai V.)      → sees it alongside Sr Mgr");
console.log("");
console.log("  Login: any user — password 'password123'.");
console.log("  Run `npm start` and open http://localhost:3000");
console.log("");

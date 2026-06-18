// seed-director-demo.js  (v0.61)
//
// Director-walkthrough fixture. Sized down to the bare minimum so the demo
// stays readable on screen:
//
//   • 4 users:    Sai V. (pm), Maitland Kelly (ops_manager), Reshmi (sr_mgr),
//                 Aramiwale (technician).
//   • 2 work orders:
//       WO_HAPPY  — Whole Foods Edgewater. Within every budget + rule.
//       WO_FLAG   — ShopRite Hoboken. Breaks 3 rules: per-WO cap overrun
//                   on a corp-card category, per-WO cap overrun on a tech
//                   expense subcategory, and a receipt-required-above
//                   violation. Also trips the existing hours-per-shift rule.
//   • Per-category rules (NEW v0.61):
//       Corp-card Meals  per_wo_cap=$200  global_cap=$1500  receipt_above=$30
//       Corp-card Travel per_wo_cap=$300  global_cap=$5000  receipt_above=$75
//       Tech-exp  Meal   per_wo_cap=$50   global_cap=$300   receipt_above=$25
//       Tech-exp  Hotel  per_wo_cap=$150  global_cap=$1000  receipt_above=$50
//   • Per-WO budgets (NEW v0.61):
//       WO_HAPPY → Meals=$200 (spend $150)
//       WO_FLAG  → Travel=$300 (spend $480 → OVER), Hotel=$150 (spend $220 → OVER)
//
// Usage:
//   npm run seed:director
//   npm start
// Login: any user, password 'password123'.

const { open, ensureSchema } = require('./db');
const { hashPassword } = require('./lib/auth');

const db = open();
ensureSchema(db);

console.log('Wiping existing data…');
db.exec('PRAGMA foreign_keys = OFF');
[
  'sessions','notifications','attachments','audit_log','launch_actuals',
  'cost_tracker_overrides','wo_category_budgets','category_rules',
  'corp_card_expenses','corp_card_categories',
  'expenses','time_entries','invoices',
  'work_orders','custom_rules','manager_team','settings','users',
].forEach(t => { try { db.exec(`DELETE FROM ${t}`); } catch (e) { console.warn(`[seed-director-demo] skip ${t}: ${e.message}`); } });
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
const opsId  = insUser.run("Maitland Kelly",   "maitland.k@instacart.com", "maitland",  "ops_manager", null, null, null, DEMO_PWD, NOW).lastInsertRowid;
const srId   = insUser.run("Reshmi Chowdhury", "reshmi.c@instacart.com",   "reshmi",    "sr_manager",  null, null, null, DEMO_PWD, NOW).lastInsertRowid;
const pmId   = insUser.run("Sai V.",           "sai.vs@instacart.com",     "sai",       "pm",          null, null, null, DEMO_PWD, NOW).lastInsertRowid;
const techId = insUser.run("Aramiwale Shittu", "aramiwale@example.com",    "aramiwale", "technician", "contractor", 40.0, opsId, DEMO_PWD, NOW).lastInsertRowid;
db.prepare("INSERT INTO manager_team (manager_user_id, tech_user_id) VALUES (?, ?)").run(opsId, techId);

// ---------- Period (LAST Mon→Sun, not this week's) ----------
// We seed the demo invoice for the previous week so:
//   • the Ops Mgr queue has a submitted invoice with flags to review, AND
//   • the current week is wide open for the tech to add new expenses to a
//     fresh draft (which is what reviewers will actually click around in
//     during the demo).
const today = new Date();
const iso = (d) => d.toISOString().slice(0,10);
const day = today.getDay();
const thisMonday = new Date(today); thisMonday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
const monday = new Date(thisMonday); monday.setDate(thisMonday.getDate() - 7); // previous Mon
const periodStart = iso(monday);
const periodEndD  = new Date(monday); periodEndD.setDate(monday.getDate() + 6);
const periodEnd   = iso(periodEndD);
const PMON = iso(monday);
const PTUE = (() => { const d = new Date(monday); d.setDate(monday.getDate() + 1); return iso(d); })();
const PWED = (() => { const d = new Date(monday); d.setDate(monday.getDate() + 2); return iso(d); })();
const PTHU = (() => { const d = new Date(monday); d.setDate(monday.getDate() + 3); return iso(d); })();
const PFRI = (() => { const d = new Date(monday); d.setDate(monday.getDate() + 4); return iso(d); })();

// ---------- Work orders ----------
const insWO = db.prepare(`
  INSERT INTO work_orders (external_id, source_system, source_ticket_id, title, work_type,
                           store_id, store_name, cart_count, scheduled_date, description,
                           status, assigned_user_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const woHappy = insWO.run("MX-DPL-2606-101", "maintainx", "101",
  "Whole Foods Edgewater — 8-cart Deployment",
  "deployment", "WF-EDG", "Whole Foods Edgewater", 8, periodStart,
  "DEMO · Clean deployment within every budget + rule.",
  "completed", techId).lastInsertRowid;

const woFlag  = insWO.run("FD-MNT-2606-102", "freshdesk", "102",
  "ShopRite Hoboken — Service Visit",
  "maintenance","SR-HOB", "ShopRite Hoboken",    1, periodStart,
  "DEMO · Multiple budget overruns + missing receipt to showcase flag flow.",
  "completed", techId).lastInsertRowid;

// ---------- Corp-card categories ----------
// Same defaults as seed-demo.js so existing names line up.
const insCC = db.prepare("INSERT INTO corp_card_categories (name, created_by) VALUES (?, ?)");
const ccTravel   = insCC.run('Travel',   opsId).lastInsertRowid;
const ccHotel    = insCC.run('Hotel',    opsId).lastInsertRowid;
const ccEvents   = insCC.run('Events',   opsId).lastInsertRowid;
const ccMeals    = insCC.run('Meals',    opsId).lastInsertRowid;
const ccSoftware = insCC.run('Software', opsId).lastInsertRowid;
const ccTools    = insCC.run('Tools',    opsId).lastInsertRowid;
const ccOther    = insCC.run('Other',    opsId).lastInsertRowid;

// ensureSchema seeded the per-category rule rows already (idempotent on
// startup). For the new corp_card categories we just inserted, seed them now
// so the Policy page shows them.
const seedRule = db.prepare(`
  INSERT OR IGNORE INTO category_rules (category_source, category_key, rule_kind, amount)
  VALUES (?, ?, ?, NULL)
`);
const KINDS = ['per_wo_cap','global_cap','receipt_required_above'];
for (const cid of [ccTravel, ccHotel, ccEvents, ccMeals, ccSoftware, ccTools, ccOther]) {
  for (const k of KINDS) seedRule.run('corp_card', String(cid), k);
}
for (const sub of ['Meal','Tools','Hotel','Supplies','Misc']) {
  for (const k of KINDS) seedRule.run('tech_expense', sub, k);
}

// ---------- Per-category rule amounts ----------
const setRule = db.prepare(`
  UPDATE category_rules
     SET amount = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
   WHERE category_source = ? AND category_key = ? AND rule_kind = ?
`);
function ruleSet(source, key, kind, amount) { setRule.run(amount, opsId, source, String(key), kind); }

// Corp-card category rules
ruleSet('corp_card', ccMeals,  'per_wo_cap',             200);
ruleSet('corp_card', ccMeals,  'global_cap',            1500);
ruleSet('corp_card', ccMeals,  'receipt_required_above',  30);
ruleSet('corp_card', ccTravel, 'per_wo_cap',             300);
ruleSet('corp_card', ccTravel, 'global_cap',            5000);
ruleSet('corp_card', ccTravel, 'receipt_required_above',  75);
ruleSet('corp_card', ccHotel,  'per_wo_cap',             400);
ruleSet('corp_card', ccHotel,  'global_cap',            4000);
ruleSet('corp_card', ccHotel,  'receipt_required_above',  50);

// Tech-expense subcategory rules
ruleSet('tech_expense', 'Meal',  'per_wo_cap',              50);
ruleSet('tech_expense', 'Meal',  'global_cap',             300);
ruleSet('tech_expense', 'Meal',  'receipt_required_above',  25);
ruleSet('tech_expense', 'Hotel', 'per_wo_cap',             150);
ruleSet('tech_expense', 'Hotel', 'global_cap',            1000);
ruleSet('tech_expense', 'Hotel', 'receipt_required_above',  50);

// ---------- Per-WO category budgets ----------
const insBudget = db.prepare(`
  INSERT INTO wo_category_budgets (work_order_id, category_source, category_key, amount_cap, updated_by, updated_at)
  VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`);
// Happy WO: Meals budget $200 (spend will be $150).
insBudget.run(woHappy, 'corp_card', String(ccMeals), 200, opsId);
// Flag WO: Travel $300 (spend $480), Hotel $400 (corp-card spend $0 — not flagged),
//          tech-expense Hotel subcategory $150 (spend $220 → flagged).
insBudget.run(woFlag,  'corp_card',  String(ccTravel),  300, opsId);
insBudget.run(woFlag,  'tech_expense', 'Hotel',         150, opsId);

// ---------- One legacy custom rule (so the existing engine still fires) ----------
db.prepare(`
  INSERT INTO custom_rules (rule_type, work_type_filter, category_filter, cart_count_min,
                            threshold, description, severity, active, created_by)
  VALUES (?, NULL, NULL, NULL, ?, ?, 'flag', 1, ?)
`).run('max_hours_per_shift', 10, 'Single shift over 10 hrs flagged.', opsId);

// ---------- Draft invoice ----------
const invoiceNumber = `INV-${periodEnd.replace(/-/g, '')}-U${String(techId).padStart(2,'0')}-DEMO`;
const invoiceId = db.prepare(`
  INSERT INTO invoices (invoice_number, user_id, period_start, period_end, status, total, origin, created_by, notes)
  VALUES (?, ?, ?, ?, 'submitted', 0, 'tech_self', ?, ?)
`).run(invoiceNumber, techId, periodStart, periodEnd, techId,
       'DEMO · two WOs (one clean, one flagged) for the director walkthrough.').lastInsertRowid;
db.prepare("UPDATE invoices SET submitted_at = ? WHERE id = ?").run(new Date().toISOString(), invoiceId);

// ---------- Time entries ----------
const tISO = (d, h, m=0) => `${d}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
const insTime = db.prepare(`
  INSERT INTO time_entries (user_id, work_order_id, clock_in, clock_out, break_minutes, notes, mode, invoice_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
// Happy WO — single 7.5-hr clean shift.
insTime.run(techId, woHappy, tISO(PMON, 8, 0),  tISO(PMON, 16, 0), 30, 'Deployment install', 'work', invoiceId);
// Flagged WO — 12-hr shift (trips max_hours_per_shift).
insTime.run(techId, woFlag,  tISO(PTUE, 7, 0),  tISO(PTUE, 19, 0), 0,  'Extended service visit',  'work', invoiceId);

// ---------- Tech expenses (reimbursable, on the invoice) ----------
const insExp = db.prepare(`
  INSERT INTO expenses (user_id, work_order_id, category, subcategory, expense_date, amount, quantity, rate, description, receipt_path, invoice_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
// Happy — Meal $20 w/ receipt (under $25 receipt threshold + under per-WO cap)
insExp.run(techId, woHappy, 'other', 'Meal', PMON, 20.00, null, null, 'Lunch at the install',
           '/fake/receipt-happy-meal.jpg', invoiceId);

// Flagged — Hotel $220 with two nights, no receipt over the threshold + over per-WO budget ($150 cap).
insExp.run(techId, woFlag, 'other', 'Hotel', PTUE, 110.00, null, null, 'Hotel night 1',
           '/fake/receipt-flag-hotel-1.jpg', invoiceId);
insExp.run(techId, woFlag, 'other', 'Hotel', PWED, 110.00, null, null, 'Hotel night 2 — no receipt attached',
           null, invoiceId);
// Flagged — $50 meal, no receipt (trips receipt_required_above for tech-expense Meal at $25).
insExp.run(techId, woFlag, 'other', 'Meal', PWED, 50.00, null, null, 'Dinner — no receipt', null, invoiceId);

// ---------- Corp-card charges ----------
const insCorp = db.prepare(`
  INSERT INTO corp_card_expenses (created_by_user_id, on_behalf_of_user_id, work_order_id, store_name,
                                  category_id, expense_date, amount, description)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
// Happy WO: $150 in Meals (under $200 budget)
insCorp.run(opsId, techId, woHappy, "Whole Foods Edgewater", ccMeals, PMON,  75.00, 'Team lunch — install day');
insCorp.run(opsId, techId, woHappy, "Whole Foods Edgewater", ccMeals, PMON,  75.00, 'Team dinner — install day');

// Flagged WO: $480 in Travel (over $300 budget = $180 overage)
insCorp.run(opsId, techId, woFlag,  "ShopRite Hoboken",      ccTravel, PMON, 180.00, 'Flights — outbound');
insCorp.run(opsId, techId, woFlag,  "ShopRite Hoboken",      ccTravel, PTUE, 180.00, 'Flights — return');
insCorp.run(opsId, techId, woFlag,  "ShopRite Hoboken",      ccTravel, PTUE, 120.00, 'Rideshare to the store');

// ---------- Console report ----------
console.log('');
console.log('✓ Director-demo fixture seeded.');
console.log('');
console.log(`  Period (LAST WEEK so current week is free for fresh drafts):`);
console.log(`                 ${periodStart} → ${periodEnd}`);
console.log(`  Tech:          Aramiwale Shittu (id=${techId})`);
console.log(`  Ops Manager:   Maitland Kelly   (id=${opsId})`);
console.log(`  Sr Manager:    Reshmi Chowdhury (id=${srId})`);
console.log(`  PM:            Sai V.           (id=${pmId})`);
console.log('');
console.log('  Work orders:');
console.log(`    WO_HAPPY    MX-DPL-2606-101  Whole Foods Edgewater  (deployment, 8 carts)`);
console.log(`    WO_FLAG     FD-SVC-2606-102  ShopRite Hoboken       (service)`);
console.log('');
console.log('  Per-category rules in play:');
console.log('    Corp-card Meals    per_wo=$200  global=$1500  receipt>$30');
console.log('    Corp-card Travel   per_wo=$300  global=$5000  receipt>$75');
console.log('    Corp-card Hotel    per_wo=$400  global=$4000  receipt>$50');
console.log('    Tech-exp  Meal     per_wo=$50   global=$300   receipt>$25');
console.log('    Tech-exp  Hotel    per_wo=$150  global=$1000  receipt>$50');
console.log('');
console.log('  Per-WO budgets:');
console.log('    WO_HAPPY  corp-card Meals  cap=$200   spend=$150   (UNDER)');
console.log('    WO_FLAG   corp-card Travel cap=$300   spend=$480   (OVER  by $180)');
console.log('    WO_FLAG   tech-exp  Hotel  cap=$150   spend=$220   (OVER  by $70)');
console.log('');
console.log('  Expected outcomes on the dashboard sub-tabs:');
console.log('    Travel tab → over_budget_wos[] lists WO_FLAG with $180 overage');
console.log('    Hotel  tab → over_budget_wos[] lists WO_FLAG with $70 overage (tech-expense)');
console.log('    Meals  tab → clean ($150 of $200 used on WO_HAPPY)');
console.log('');
console.log('  Login: any user, password = "password123".');
console.log('  Run `npm start` → http://localhost:3000');
console.log('');

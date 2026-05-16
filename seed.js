// Seeds the OTG dev database with realistic mock data so you can click around
// the app immediately. Re-run anytime; idempotent — drops & re-inserts all rows.
const { open, ensureSchema } = require('./db');

const db = open();
ensureSchema(db);

// Wipe — disable FK enforcement during the truncate so we don't have to
// worry about ordering (and so leftover rows in tables we don't seed, like
// `sessions`, can't block a fresh re-run with a UNIQUE constraint error on
// users.username). Re-enabled below before the INSERTs so referential
// integrity is back in force for the new rows. (v0.53 bug fix.)
db.exec('PRAGMA foreign_keys = OFF');
[
  // children with FKs into users / invoices / work_orders / time_entries / expenses
  'sessions', 'notifications', 'attachments', 'audit_log', 'launch_actuals',
  'cost_tracker_overrides', 'expenses', 'time_entries',
  // parents
  'invoices', 'work_orders', 'custom_rules', 'manager_team', 'settings', 'users',
].forEach(t => { try { db.exec(`DELETE FROM ${t}`); } catch (e) { console.warn(`[seed] skip ${t}: ${e.message}`); } });
try { db.exec("DELETE FROM sqlite_sequence"); } catch {}
db.exec('PRAGMA foreign_keys = ON');

// ---------- Users ----------
const { hashPassword } = require('./lib/auth');
const DEMO_PWD = hashPassword('password123');   // shared demo password
const NOW = new Date().toISOString();

const insUser = db.prepare(`
  INSERT INTO users (name, email, username, role, worker_type, hourly_rate, ops_manager_id,
                     password_hash, password_set_at, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
`);

// Ops managers first so we can assign techs to them
const opsId = insUser.run("Maitland Kelly",   "maitland.k@instacart.com", "maitland",  "ops_manager", null, null, null, DEMO_PWD, NOW).lastInsertRowid;
const srId  = insUser.run("Reshmi Chowdhury", "reshmi.c@instacart.com",   "reshmi",    "sr_manager",  null, null, null, DEMO_PWD, NOW).lastInsertRowid;
            insUser.run("Sai V.",             "sai.vs@instacart.com",     "sai",       "pm",          null, null, null, DEMO_PWD, NOW);

// Technicians
const tech1 = insUser.run("Aramiwale Shittu", "aramiwale@example.com",    "aramiwale", "technician", "contractor", 40.0, opsId, DEMO_PWD, NOW).lastInsertRowid;
const tech2 = insUser.run("Carlos Martinez",  "carlos.m@example.com",     "carlos",    "technician", "contractor", 40.0, opsId, DEMO_PWD, NOW).lastInsertRowid;
const tech3 = insUser.run("Priya Patel",      "priya.p@instacart.com",    "priya",     "technician", "fte",        45.0, opsId, DEMO_PWD, NOW).lastInsertRowid;

// Seed sample profile addresses so the invoice header has something to render.
db.prepare("UPDATE users SET home_address = ?, home_phone = ? WHERE id = ?")
  .run("24 Mayflower Drive, Sicklerville, NJ 08081", "856-725-2298", tech1);
db.prepare("UPDATE users SET home_address = ?, home_phone = ? WHERE id = ?")
  .run("142 Oak St, Edgewater, NJ 07020", "201-555-0143", tech2);
db.prepare("UPDATE users SET home_address = ?, home_phone = ? WHERE id = ?")
  .run("89 Maple Ave, Hackensack, NJ 07601", "201-555-0188", tech3);

// Seed Ops Mgr team — Maitland owns all three techs initially.
const insTeam = db.prepare("INSERT INTO manager_team (manager_user_id, tech_user_id) VALUES (?, ?)");
insTeam.run(opsId, tech1);
insTeam.run(opsId, tech2);
insTeam.run(opsId, tech3);

// v0.60 — Seed default corporate-card categories. Both ops_manager and
// sr_manager can add/archive more after launch from Settings → Corp card.
const insCorpCat = db.prepare(
  "INSERT OR IGNORE INTO corp_card_categories (name, created_by) VALUES (?, ?)"
);
for (const c of ['Travel', 'Hotel', 'Events', 'Meals', 'Software', 'Tools', 'Other']) {
  insCorpCat.run(c, opsId);
}

// ---------- Work orders ----------
// Mix MaintainX (deployments / retrofits) and Freshdesk (service / repair).
// ID schema: {SOURCE}-{TYPE}-{yymm}-{seq}
//   SOURCE: MX = MaintainX,  FD = Freshdesk
//   TYPE:   DPL=deployment, RTR=retrofit, SVC=service, RPR=repair
const insWO = db.prepare(`
  INSERT INTO work_orders
    (external_id, source_system, source_ticket_id, title, work_type, store_id, store_name, cart_count,
     scheduled_date, description, status, assigned_user_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const today = new Date();
const iso = (d) => d.toISOString().slice(0,10);
const days = (n) => { const d = new Date(today); d.setDate(d.getDate()+n); return iso(d); };

// Aramiwale's queue
insWO.run("MX-RTR-2406-127", "maintainx", "127",  "Whole Foods Edgewater - Shelf Bracket Replacement",     "retrofit",   "WF-EDG", "Whole Foods Edgewater",      12, days(0),  "Replace shelf brackets and recalibrate scanners on 12 carts.",          "in_progress", tech1);
insWO.run("MX-DPL-2406-128", "maintainx", "128",  "ShopRite Paramus - 20 Cart Deployment",                  "deployment", "SR-PAR", "ShopRite Paramus",           20, days(0),  "Initial install of 20 new Caper Carts plus on-floor staff training.",   "open",        tech1);
insWO.run("FD-RPR-2406-1051","freshdesk", "1051", "Stop & Shop Hoboken - Cart #7 Calibration Error",        "repair",     "SS-HOB", "Stop & Shop Hoboken",         1, days(1),  "Cart #7 reporting persistent weight calibration error.",                 "open",        tech1);
insWO.run("MX-RTR-2406-125", "maintainx", "125",  "ShopRite Hackensack - Software + Bracket Retrofit",      "retrofit",   "SR-HKK", "ShopRite Hackensack",        10, days(-3), "Software bump + rear-shelf bracket replacement on 10 carts.",            "completed",   tech1);
insWO.run("MX-DPL-2406-126", "maintainx", "126",  "Whole Foods Englewood - 20 Cart Deploy + Register Integration","deployment","WF-ENG","Whole Foods Englewood", 20, days(-2), "Initial install of 20 carts + register integration.",                    "completed",   tech1);

// Carlos's queue
insWO.run("MX-DPL-2406-130", "maintainx", "130",  "ShopRite Clifton - 15 Cart Deployment",                  "deployment", "SR-CLF", "ShopRite Clifton",           15, days(2),  "Initial install of 15 carts.",                                           "open",        tech2);
insWO.run("FD-SVC-2406-1062","freshdesk", "1062", "Whole Foods Edgewater - Weekly Service Check",           "service",    "WF-EDG", "Whole Foods Edgewater",       3, days(-1), "Weekly service check on 3 carts (battery health + sanitizer refill).",   "completed",   tech2);

// Priya's queue
insWO.run("MX-RTR-2406-131", "maintainx", "131",  "Whole Foods Paramus - Firmware + Display Panel",         "retrofit",   "WF-PRA", "Whole Foods Paramus",        18, days(1),  "Firmware upgrade + display panel replacement on 18 carts.",              "open",        tech3);
insWO.run("FD-RPR-2406-1075","freshdesk", "1075", "Stop & Shop Weehawken - 2 Carts Unresponsive",           "repair",     "SS-WEH", "Stop & Shop Weehawken",       2, days(0),  "Two carts unresponsive after overnight charge.",                          "open",        tech3);

// ---------- Time entries (some history so the invoice screen has data) ----------
const insTime = db.prepare(`
  INSERT INTO time_entries (user_id, work_order_id, clock_in, clock_out, break_minutes, notes, mode)
  VALUES (?, ?, ?, ?, ?, ?, 'work')
`);
const woByExt = (ext) => db.prepare("SELECT id FROM work_orders WHERE external_id = ?").get(ext).id;
const isoTs = (daysAgo, hour=8, min=0) => {
  const d = new Date(today);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
};

// Aramiwale — completed work this week
insTime.run(tech1, woByExt("MX-RTR-2406-125"), isoTs(3, 7, 30),  isoTs(3, 19, 0),  30, "ShopRite Hackensack — overran due to shelf damage; photos in WO.");
insTime.run(tech1, woByExt("MX-DPL-2406-126"), isoTs(2, 7, 0),   isoTs(2, 21, 0),  60, "Whole Foods Englewood — full deployment.");
insTime.run(tech1, woByExt("MX-RTR-2406-127"), isoTs(0, 7, 27),  null,             0,  null);  // open / running

// Carlos — short service visit
insTime.run(tech2, woByExt("FD-SVC-2406-1062"), isoTs(1, 9, 0), isoTs(1, 11, 30), 0, "Quick service check.");

// ---------- Expenses ----------
const insExp = db.prepare(`
  INSERT INTO expenses (user_id, work_order_id, category, subcategory, expense_date, amount, quantity, rate, description)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Aramiwale this week
insExp.run(tech1, woByExt("MX-RTR-2406-125"), "mileage", null,    days(-3), 20.30, 28,   0.725, "Edgewater → Hackensack RT");
insExp.run(tech1, woByExt("MX-RTR-2406-125"), "tolls",   null,    days(-3), 14.50, null, null,  "GWB toll");
insExp.run(tech1, woByExt("MX-DPL-2406-126"), "mileage", null,    days(-2), 15.95, 22,   0.725, "Edgewater → Englewood RT");
insExp.run(tech1, woByExt("MX-DPL-2406-126"), "other",   "Tools", days(-2), 32.00, null, null,  "Replacement bracket clips (Home Depot)");
insExp.run(tech1, woByExt("MX-RTR-2406-127"), "mileage", null,    days(0),  23.49, 32.4, 0.725, "Edgewater on-site mileage");
insExp.run(tech1, woByExt("MX-RTR-2406-127"), "other",   "Meal",  days(0),  18.00, null, null,  "Lunch (under cap, no receipt required)");

// Carlos this week
insExp.run(tech2, woByExt("FD-SVC-2406-1062"), "mileage", null, days(-1), 11.60, 16,   0.725, "Edgewater service visit");
insExp.run(tech2, woByExt("FD-SVC-2406-1062"), "parking", null, days(-1),  6.00, null, null,  "Garage parking");

console.log("");
console.log("✓ Seeded OTG dev database at", require('./db').DB_PATH);
console.log("");
console.log("  Users:");
db.prepare("SELECT id, name, role, worker_type FROM users ORDER BY id").all().forEach(u =>
  console.log(`    [${u.id}] ${u.name.padEnd(22)} ${u.role.padEnd(13)} ${u.worker_type || ''}`));
console.log("");
console.log("  Work orders:", db.prepare("SELECT COUNT(*) AS n FROM work_orders").get().n);
console.log("  Time entries:", db.prepare("SELECT COUNT(*) AS n FROM time_entries").get().n);
console.log("  Expenses:    ", db.prepare("SELECT COUNT(*) AS n FROM expenses").get().n);
console.log("");
console.log("  Run `npm start` and open http://localhost:3000");
console.log("");

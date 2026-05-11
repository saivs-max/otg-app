// Rich demo data for the OTG dashboard. Wipes the DB and populates ~12 weeks
// of realistic invoices across 3 technicians, ~16 stores, and all 4 work
// types. Run with: npm run seed:demo
//
// Volumes (approx):
//   - 3 technicians × 12 weeks = 36 invoices, mostly paid/sent_ap
//   - 4-6 work orders per tech per week with realistic cart counts
//   - 1-3 time entries per WO with start/end timestamps
//   - 1-3 expense rows (mileage + occasional tolls/parking) per WO
//
// Status progression mirrors a real org:
//   - oldest 8 weeks → paid (everything fully cycled)
//   - prior 2 weeks  → sent_ap or approved_sr
//   - last week      → submitted / approved_ops (in-flight queue)
//   - this week      → draft (work in progress)

const { open, ensureSchema } = require('./db');

const db = open();
ensureSchema(db);

console.log('Wiping existing data…');
['notifications','attachments','audit_log','expenses','time_entries','invoices',
 'work_orders','custom_rules','manager_team','settings','users']
  .forEach(t => { try { db.exec(`DELETE FROM ${t}`); } catch {} });
try { db.exec("DELETE FROM sqlite_sequence"); } catch {}

// ---------- Stores (a realistic NJ/PA Caper deployment footprint) ----------
const STORES = [
  { id: 'WF-EDG', name: 'Whole Foods Edgewater',           addr: '905 River Rd, Edgewater, NJ 07020' },
  { id: 'WF-ENG', name: 'Whole Foods Englewood',           addr: '241 E Palisade Ave, Englewood, NJ 07631' },
  { id: 'WF-PRA', name: 'Whole Foods Paramus',             addr: '212 NJ-17, Paramus, NJ 07652' },
  { id: 'SR-PAR', name: 'ShopRite Paramus',                addr: '224 NJ-4, Paramus, NJ 07652' },
  { id: 'SR-CLF', name: 'ShopRite Clifton',                addr: '503 NJ-3, Clifton, NJ 07014' },
  { id: 'SR-HKK', name: 'ShopRite Hackensack',             addr: '335 Main St, Hackensack, NJ 07601' },
  { id: 'SR-BRH', name: 'ShopRite of Bridge & Harbison',   addr: '5597 Tulip St, Philadelphia, PA 19124' },
  { id: 'SR-YRD', name: 'ShopRite of Yardley',             addr: '1603 Big Oak Rd, Yardley, PA 19067' },
  { id: 'SR-RVS', name: 'ShopRite of Riverside',           addr: '1321 Riverside Pkwy, Belcamp, MD 21017' },
  { id: 'SR-FES', name: 'ShopRite of Festival',            addr: '5 Bel Air S Pkwy, Bel Air, MD 21015' },
  { id: 'SR-MUL', name: 'ShopRite of Mullica Hill',        addr: '143 Bridgeton Pike, Mullica Hill, NJ 08062' },
  { id: 'SR-RXB', name: 'ShopRite of Roxborough',          addr: '6901 Ridge Ave, Roxborough, PA 19128' },
  { id: 'SR-WCH', name: 'ShopRite of Watchung',            addr: '1701 US-22, Watchung, NJ 07069' },
  { id: 'SR-STG', name: 'ShopRite of Stirling',            addr: '1153 Valley Rd, Stirling, NJ 07980' },
  { id: 'SS-HOB', name: 'Stop & Shop Hoboken',             addr: '125 18th St, Hoboken, NJ 07030' },
  { id: 'SS-WEH', name: 'Stop & Shop Weehawken',           addr: '4100 Park Ave, Weehawken, NJ 07086' },
];

// ---------- Users (matching seed.js for continuity) ----------
const { hashPassword } = require('./lib/auth');
const DEMO_PWD = hashPassword('password123');
const NOW = new Date().toISOString();

const insUser = db.prepare(`
  INSERT INTO users (name, email, username, role, worker_type, hourly_rate, ops_manager_id,
                     home_address, home_phone, password_hash, password_set_at, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
`);
const opsId = insUser.run('Maitland Kelly',   'maitland.k@instacart.com', 'maitland',  'ops_manager', null, null, null, null, null, DEMO_PWD, NOW).lastInsertRowid;
const srId  = insUser.run('Reshmi Chowdhury', 'reshmi.c@instacart.com',   'reshmi',    'sr_manager',  null, null, null, null, null, DEMO_PWD, NOW).lastInsertRowid;
            insUser.run('Sai V.',             'sai.vs@instacart.com',     'sai',       'pm',          null, null, null, null, null, DEMO_PWD, NOW);
const tech1 = insUser.run('Aramiwale Shittu', 'aramiwale@example.com',    'aramiwale', 'technician', 'contractor', 40.0, opsId, '24 Mayflower Drive, Sicklerville, NJ 08081', '856-725-2298', DEMO_PWD, NOW).lastInsertRowid;
const tech2 = insUser.run('Carlos Martinez',  'carlos.m@example.com',     'carlos',    'technician', 'contractor', 40.0, opsId, '142 Oak St, Edgewater, NJ 07020', '201-555-0143', DEMO_PWD, NOW).lastInsertRowid;
const tech3 = insUser.run('Priya Patel',      'priya.p@instacart.com',    'priya',     'technician', 'fte',        45.0, opsId, '89 Maple Ave, Hackensack, NJ 07601', '201-555-0188', DEMO_PWD, NOW).lastInsertRowid;

const insTeam = db.prepare('INSERT INTO manager_team (manager_user_id, tech_user_id) VALUES (?, ?)');
[tech1, tech2, tech3].forEach(t => insTeam.run(opsId, t));

// ---------- Reproducible RNG ----------
let rngState = 1234567;
function rand() { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; }
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
function pickN(arr, n) { const c = [...arr]; const out = []; while (out.length < n && c.length) out.push(c.splice(Math.floor(rand()*c.length), 1)[0]); return out; }
function chance(p) { return rand() < p; }
function range(min, max) { return min + Math.floor(rand() * (max - min + 1)); }
function roundTo(v, step) { return Math.round(v / step) * step; }

// ---------- Date helpers ----------
const today = new Date(); today.setHours(0,0,0,0);
function daysAgo(n) { const d = new Date(today); d.setDate(d.getDate() - n); return d; }
function iso(d) { return d.toISOString().slice(0,10); }
function isoTs(d, h=8, m=0) { const x = new Date(d); x.setHours(h, m, 0, 0); return x.toISOString(); }
function weekStart(d) { const x = new Date(d); const day = x.getDay(); x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day)); return x; }

// ---------- Work order generation ----------
const insWO = db.prepare(`
  INSERT INTO work_orders
    (external_id, source_system, source_ticket_id, title, work_type, store_id, store_name, store_address, cart_count,
     scheduled_date, description, status, assigned_user_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const WORK_TYPES = ['deployment', 'retrofit', 'service', 'repair'];
let woTicketCounter = 12000;
let externalSeq     = 100;

function makeWO(techId, weekStartDate) {
  const wt = (() => { const r = rand(); return r < 0.18 ? 'deployment' : r < 0.42 ? 'retrofit' : r < 0.78 ? 'service' : 'repair'; })();
  const store = pick(STORES);
  // Cart count distribution by work type
  const carts = wt === 'deployment' ? pick([10, 12, 15, 20, 20, 25])
              : wt === 'retrofit'   ? pick([6, 8, 10, 12, 15, 18])
              : wt === 'service'    ? pick([1, 2, 3, 4, 5, 6, 8])
              :                       pick([1, 1, 2, 2, 3]);
  const source = chance(0.55) ? 'maintainx' : 'freshdesk';
  const prefix = source === 'maintainx' ? 'MX' : 'FD';
  const tCode  = wt === 'deployment' ? 'DPL' : wt === 'retrofit' ? 'RTR' : wt === 'service' ? 'SVC' : 'RPR';
  const ticketId = String(++woTicketCounter);
  const ext = `${prefix}-${tCode}-${ticketId}`;
  // schedule somewhere within the week
  const scheduled = new Date(weekStartDate); scheduled.setDate(scheduled.getDate() + range(0, 5));
  const titleVerbs = {
    deployment: ['Initial cart deploy', 'New rollout', 'Site go-live deploy', 'Carts delivery + setup'],
    retrofit:   ['Firmware + hardware retrofit', 'Bracket replacement', 'Display panel swap', 'Charger retrofit'],
    service:    ['Weekly service check', 'Calibration tune-up', 'Cart inspection visit', 'Health check'],
    repair:     ['Cart down — repair', 'Battery swap', 'Frozen screen repair', 'Bumper replacement'],
  }[wt];
  const title = `${store.name} — ${pick(titleVerbs)}`;
  const desc = `${pick(titleVerbs)} on ${carts} cart${carts === 1 ? '' : 's'} at ${store.name}.`;
  const r = insWO.run(ext, source, ticketId, title, wt, store.id, store.name, store.addr, carts,
                       iso(scheduled), desc, 'completed', techId, isoTs(scheduled, 7));
  return { id: r.lastInsertRowid, ext, work_type: wt, carts, scheduled, store };
}

// ---------- Time entries ----------
const insTime = db.prepare(`
  INSERT INTO time_entries (user_id, work_order_id, clock_in, clock_out, break_minutes, notes, mode, invoice_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function makeTimeEntries(wo, techId, invoiceId, hourlyRate) {
  // Hours scaled by work type and cart count, with some scatter so the
  // hours-per-cart rule has occasional flags.
  const baseHrsPerCart = ({ deployment: 0.7, retrofit: 0.7, service: 2.4, repair: 1.5 })[wo.work_type];
  const expectedHrs = baseHrsPerCart * wo.carts * (0.85 + rand() * 0.4);   // ±20% noise
  const days = wo.work_type === 'deployment' && wo.carts >= 15 ? 2
             : wo.work_type === 'retrofit' && wo.carts >= 12 ? 2 : 1;
  const hrsPerDay = expectedHrs / days;
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(wo.scheduled); day.setDate(day.getDate() + i);
    const startHr = pick([7, 8, 8, 8, 9, 9, 10]);
    const dur     = Math.min(11, Math.max(1, hrsPerDay));
    const breakM  = dur > 5 ? pick([30, 60]) : 0;
    const clockIn  = isoTs(day, startHr, range(0, 59));
    const clockOut = isoTs(day, startHr + Math.floor(dur), Math.round((dur % 1) * 60) + breakM);
    insTime.run(techId, wo.id, clockIn, clockOut, breakM,
                pick(['Completed cleanly', 'Minor delay due to traffic', 'Customer flagged 1 cart for follow-up', null]),
                'work', invoiceId, clockIn);
    out.push({ clockIn, clockOut, hrs: dur });
  }
  // ~20% chance of a drive-time block too
  if (chance(0.20)) {
    const day = new Date(wo.scheduled);
    const driveHrs = roundTo(0.5 + rand() * 1.5, 0.25);
    insTime.run(techId, wo.id, isoTs(day, 6, 30), isoTs(day, 6 + Math.floor(driveHrs), Math.round((driveHrs%1)*60) + 30),
                0, 'Drive to site', 'drive', invoiceId, isoTs(day, 6, 30));
  }
  return out;
}

// ---------- Expenses ----------
const insExp = db.prepare(`
  INSERT INTO expenses (user_id, work_order_id, category, subcategory, expense_date, amount, quantity, rate, description, invoice_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
function makeExpenses(wo, techId, invoiceId) {
  // Mileage every visit day
  const miles = roundTo(8 + rand() * 80, 0.5);
  const rate  = 0.725;
  insExp.run(techId, wo.id, 'mileage', null, iso(wo.scheduled), +(miles * rate).toFixed(2), miles, rate,
             `RT to ${wo.store.name}`, invoiceId, isoTs(wo.scheduled, 17));
  // 30% chance of toll
  if (chance(0.30)) {
    const tollAmt = pick([4.50, 7.50, 14.50, 22.00, 25.00]);
    insExp.run(techId, wo.id, 'tolls', null, iso(wo.scheduled), tollAmt, null, null,
               'E-ZPass', invoiceId, isoTs(wo.scheduled, 17));
  }
  // 15% chance of parking
  if (chance(0.15)) {
    insExp.run(techId, wo.id, 'parking', null, iso(wo.scheduled), pick([6.00, 12.00, 20.00]), null, null,
               'Garage parking', invoiceId, isoTs(wo.scheduled, 17));
  }
  // 20% chance of an Other expense (Tools / Meal)
  if (chance(0.20)) {
    const sub = pick(['Tools', 'Meal', 'Supplies']);
    const amt = sub === 'Meal' ? pick([12, 18, 24, 32]) : pick([15, 28, 40, 60, 95]);
    insExp.run(techId, wo.id, 'other', sub, iso(wo.scheduled), amt, null, null,
               sub === 'Meal' ? 'Lunch' : sub === 'Tools' ? 'Replacement parts' : 'Misc supplies',
               invoiceId, isoTs(wo.scheduled, 19));
  }
}

// ---------- Invoice generation ----------
const insInv = db.prepare(`
  INSERT INTO invoices
    (invoice_number, user_id, period_start, period_end, status, total,
     submitted_at, approved_ops_at, approved_ops_by, approved_sr_at, approved_sr_by,
     sent_to_ap_at, sent_to_ap_by, ap_email_to,
     notes, created_by, origin, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function invoiceNumber(uid, periodEnd) {
  const d = new Date(periodEnd);
  const yyyy = d.getFullYear();
  const mmdd = String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  return `INV-${yyyy}-${mmdd}-U${String(uid).padStart(2,'0')}`;
}

const techs = [
  { id: tech1, name: 'Aramiwale Shittu', rate: 40.0 },
  { id: tech2, name: 'Carlos Martinez',  rate: 40.0 },
  { id: tech3, name: 'Priya Patel',      rate: 45.0 },
];

const WEEKS_BACK = 12;
let totalInvoices = 0, totalWOs = 0, totalTimeEntries = 0, totalExpenses = 0;

for (let w = WEEKS_BACK; w >= 0; w--) {
  const wkStart = weekStart(daysAgo(w * 7));
  const wkEnd = new Date(wkStart); wkEnd.setDate(wkEnd.getDate() + 6);
  const wkStartIso = iso(wkStart), wkEndIso = iso(wkEnd);

  for (const tech of techs) {
    // Status progression by age
    let status, notes = null;
    if (w === 0) {
      status = chance(0.5) ? 'draft' : 'submitted';
    } else if (w === 1) {
      status = pick(['submitted', 'approved_ops']);
    } else if (w === 2) {
      status = pick(['approved_sr', 'sent_ap']);
    } else {
      status = 'sent_ap'; // v0.29 — lifecycle terminates here
    }
    // Some weeks the tech doesn't bill (vacation, no work)
    if (chance(0.08) && w > 0) continue;

    // Create the invoice shell so we have an id to attach lines to
    const numWOs = range(3, 6);
    const invR = insInv.run(invoiceNumber(tech.id, wkEndIso), tech.id, wkStartIso, wkEndIso,
      status, 0,                                  // total recomputed below
      ['submitted','approved_ops','approved_sr','sent_ap'].includes(status) ? isoTs(wkEnd, 17, 0) : null,
      ['approved_ops','approved_sr','sent_ap'].includes(status) ? isoTs(wkEnd, 18, 0) : null,
      ['approved_ops','approved_sr','sent_ap'].includes(status) ? opsId : null,
      ['approved_sr','sent_ap'].includes(status) ? isoTs(wkEnd, 19, 0) : null,
      ['approved_sr','sent_ap'].includes(status) ? srId : null,
      status === 'sent_ap' ? isoTs(daysAgo(w * 7 - 1), 9, 0) : null,
      status === 'sent_ap' ? tech.id : null,
      status === 'sent_ap' ? 'sai.vs@instacart.com' : null,
      notes, tech.id, 'tech_self', isoTs(wkStart, 8, 0));
    const invoiceId = invR.lastInsertRowid;
    totalInvoices++;

    // Generate WOs + entries
    let invoiceTotal = 0;
    for (let i = 0; i < numWOs; i++) {
      const wo = makeWO(tech.id, wkStart);
      totalWOs++;
      const teList = makeTimeEntries(wo, tech.id, invoiceId, tech.rate);
      totalTimeEntries += teList.length;
      const before = totalExpenses;
      makeExpenses(wo, tech.id, invoiceId);
      totalExpenses += 1; // mileage always
    }

    // Re-compute total from line items
    const labor = db.prepare(`
      SELECT COALESCE(SUM((julianday(t.clock_out)-julianday(t.clock_in))*24), 0) AS hrs
      FROM time_entries t WHERE t.invoice_id = ? AND (t.mode IS NULL OR t.mode = 'work') AND t.clock_out IS NOT NULL
    `).get(invoiceId).hrs * tech.rate;
    const exp = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE invoice_id = ?`).get(invoiceId).s;
    invoiceTotal = +(labor + exp).toFixed(2);
    db.prepare(`UPDATE invoices SET total = ? WHERE id = ?`).run(invoiceTotal, invoiceId);
  }
}

// ---------- Custom validation rules + flagged invoice (v0.34) ----------
// Seeds the policy engine with a realistic ruleset so the manager can see
// flagged invoices in the wild. Includes: per-shift cap, drive cap, max
// deployment hours/WO, mileage cap, max retrofit hrs/10 carts, and a
// require-receipt threshold for vendor expenses.
console.log('Seeding custom rules…');
const insRule = db.prepare(`
  INSERT INTO custom_rules (rule_type, work_type_filter, category_filter, cart_count_min, threshold, description, severity, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
[
  ['max_hours_per_shift',     null,        null,    null, 12,    'No single shift over 12 hrs',                                      'flag',  opsId],
  ['max_drive_hours_per_day', null,        null,    null, 3.5,   'Drive time per day capped at 3.5 hrs (post-IRS audit)',           'warn',  opsId],
  ['max_hours_per_wo',        'deployment', null,    10,   14,    'Deployments with 10+ carts: total labor must stay under 14 hrs',  'flag',  opsId],
  ['max_hours_per_10_carts',  'retrofit',  null,    null, 8,     'Retrofit productivity target: 8 hrs per 10 carts',                'flag',  opsId],
  ['max_miles_per_day',       null,        null,    null, 250,   '250 mi/day cap (per fleet policy)',                                'warn',  opsId],
  ['max_expense_amount',      null,        'vendor',null, 200,   'Vendor expenses over $200 need pre-approval',                      'flag',  opsId],
  ['require_receipt_above',   null,        'other', null, 25,    'Other expenses over $25 require an attached receipt',              'warn',  opsId],
].forEach(args => insRule.run(...args));

// Inject a few obviously-flagged scenarios on a recent in-flight invoice so
// the manager has something visible the moment they open the dashboard.
console.log('Adding flagged scenarios for testing…');
{
  const techId = tech1; // Aramiwale
  const wkStart = weekStart(daysAgo(7));      // last week
  const wkEnd = new Date(wkStart); wkEnd.setDate(wkEnd.getDate() + 6);

  // Find an existing submitted invoice from last week (or create one)
  let inv = db.prepare("SELECT * FROM invoices WHERE user_id = ? AND period_start = ?")
    .get(techId, iso(wkStart));
  if (!inv) {
    const num = invoiceNumber(techId, iso(wkEnd));
    const r = db.prepare(`
      INSERT INTO invoices (invoice_number, user_id, period_start, period_end, status, total, submitted_at)
      VALUES (?, ?, ?, ?, 'submitted', 0, ?)
    `).run(num + '-FLAG', techId, iso(wkStart), iso(wkEnd), isoTs(wkEnd, 17));
    inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(r.lastInsertRowid);
  } else {
    db.prepare(`UPDATE invoices SET status='submitted', submitted_at=? WHERE id=?`)
      .run(isoTs(wkEnd, 17), inv.id);
  }

  // Flagged scenario 1: 14-hour shift on a deployment WO with 18 carts
  // → trips both max_hours_per_shift (>12) AND max_hours_per_wo (>14 not quite, but close)
  const dpl = makeWO(techId, wkStart);
  db.prepare("UPDATE work_orders SET work_type='deployment', cart_count=18, store_name='Whole Foods Hoboken', store_id='WF-HOB' WHERE id = ?").run(dpl.id);
  insTime.run(techId, dpl.id, isoTs(wkStart, 7, 0), isoTs(wkStart, 21, 0), 0,
              'Long deploy day — 14 hrs straight, no breaks logged',
              'work', inv.id, isoTs(wkStart, 7));

  // Flagged scenario 2: Retrofit hours-per-cart over policy
  const rtr = makeWO(techId, wkStart);
  db.prepare("UPDATE work_orders SET work_type='retrofit', cart_count=8, store_name='ShopRite Edison', store_id='SR-EDS' WHERE id = ?").run(rtr.id);
  // 12 hrs / 8 carts = 15 hrs/10carts → trips max_hours_per_10_carts (>8)
  const day2 = new Date(wkStart); day2.setDate(day2.getDate() + 1);
  insTime.run(techId, rtr.id, isoTs(day2, 8, 0), isoTs(day2, 20, 0), 0,
              'Retrofit took longer than expected — bracket fit issues',
              'work', inv.id, isoTs(day2, 8));

  // Flagged scenario 3: Vendor expense over $200 cap
  const day3 = new Date(wkStart); day3.setDate(day3.getDate() + 2);
  insExp.run(techId, dpl.id, 'vendor', null, iso(day3), 285.50, null, null,
             'Replacement battery from Home Depot', inv.id, isoTs(day3, 14));

  // Warn scenario: 280 mi day (over 250 cap)
  const day4 = new Date(wkStart); day4.setDate(day4.getDate() + 3);
  insExp.run(techId, dpl.id, 'mileage', null, iso(day4), +(280 * 0.725).toFixed(2), 280, 0.725,
             'Multi-store route — Hoboken to Edison to Watchung', inv.id, isoTs(day4, 17));

  // Re-compute total
  const labor = db.prepare(`
    SELECT COALESCE(SUM((julianday(t.clock_out)-julianday(t.clock_in))*24), 0) AS hrs
    FROM time_entries t WHERE t.invoice_id = ? AND (t.mode IS NULL OR t.mode = 'work') AND t.clock_out IS NOT NULL
  `).get(inv.id).hrs * 40;
  const exp = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE invoice_id = ?`).get(inv.id).s;
  db.prepare(`UPDATE invoices SET total = ? WHERE id = ?`).run(+(labor + exp).toFixed(2), inv.id);
  console.log(`  Flagged invoice ${inv.invoice_number} total: $${(labor + exp).toFixed(0)}`);
}

// ---------- 3rd-party vendor invoices (v0.36) ----------
// Seeds a handful of realistic vendor invoices uploaded by the Ops Mgr so the
// dashboard's vendor breakdown has data. Mix of approved and pending.
console.log('Seeding 3rd-party vendor invoices…');
const insVendorInv = db.prepare(`
  INSERT INTO invoices (
    invoice_number, user_id, period_start, period_end, status, total,
    submitted_at, approved_sr_at, approved_sr_by,
    notes, created_by, origin, invoice_type,
    vendor_name, vendor_invoice_number, vendor_invoice_date
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mgr_upload', 'vendor', ?, ?, ?)
`);
const VENDORS = [
  { name: 'Sbot Technologies LLC',  weeks_back: 1, total: 3724.93, num: 'SBOT-0042', notes: 'Apr 11–24 contractor invoice (John Brennan), aggregated' },
  { name: 'Tek-Source Field Svc',   weeks_back: 2, total: 2189.50, num: 'TS-2026-014', notes: 'NJ region cart repairs, week of Apr 20' },
  { name: 'Bracket & Bumper Co',    weeks_back: 3, total: 1456.00, num: 'BBC-INV-991', notes: 'Replacement bracket clips bulk order' },
  { name: 'Sbot Technologies LLC',  weeks_back: 5, total: 4012.10, num: 'SBOT-0040', notes: 'Apr period 2' },
  { name: 'CartCare Mobile',        weeks_back: 6, total: 875.00,  num: 'CC-3318',    notes: 'Battery diagnostics route' },
  { name: 'Tek-Source Field Svc',   weeks_back: 8, total: 2450.75, num: 'TS-2026-008', notes: 'Multi-store retrofit support' },
  { name: 'Hardware Direct',        weeks_back: 9, total: 612.40,  num: 'HD-44521',   notes: 'Display panels (10 ea)' },
];
for (const v of VENDORS) {
  const wkStart = weekStart(daysAgo(v.weeks_back * 7));
  const wkEnd = new Date(wkStart); wkEnd.setDate(wkEnd.getDate() + 6);
  const isApproved = v.weeks_back > 1;   // recent ones still pending Sr approval
  const submittedAt = isoTs(wkEnd, 17, 30);
  const approvedAt  = isApproved ? isoTs(wkEnd, 19, 0) : null;
  const status = isApproved ? 'approved_sr' : 'submitted';
  // Build a unique number prefix
  const baseNum = `VND-${iso(wkStart).replace(/-/g,'')}-${v.num.replace(/[^A-Za-z0-9-]/g,'')}`;
  insVendorInv.run(baseNum, opsId, iso(wkStart), iso(wkEnd), status, v.total,
    submittedAt, approvedAt, isApproved ? srId : null, v.notes,
    opsId, v.name, v.num, iso(wkEnd));
}
console.log(`  Created ${VENDORS.length} vendor invoices · $${VENDORS.reduce((s,v)=>s+v.total, 0).toLocaleString()} total`);

// ---------- A few open WOs for the forecast ----------
console.log('Adding open work orders for forecast…');
for (const tech of techs) {
  for (let i = 0; i < range(2, 4); i++) {
    const wo = makeWO(tech.id, daysAgo(-range(1, 14)));
    db.prepare(`UPDATE work_orders SET status = ? WHERE id = ?`)
      .run(pick(['open', 'in_progress']), wo.id);
  }
}

console.log('');
console.log('✅  Demo data seeded.');
console.log(`   Invoices:    ${totalInvoices}`);
console.log(`   Work orders: ${db.prepare('SELECT COUNT(*) AS n FROM work_orders').get().n}`);
console.log(`   Time entries:${db.prepare('SELECT COUNT(*) AS n FROM time_entries').get().n}`);
console.log(`   Expenses:    ${db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n}`);
console.log('');
console.log('   By status:');
db.prepare("SELECT status, COUNT(*) AS n, ROUND(SUM(total)) AS total FROM invoices GROUP BY status ORDER BY n DESC").all()
  .forEach(r => console.log(`     ${r.status.padEnd(15)} ${String(r.n).padStart(3)} invoices · $${(r.total||0).toLocaleString()}`));
console.log('');
console.log('   Sign in as Maitland Kelly (ops_manager) to view the dashboard.');
console.log('   Run `npm start` to launch the app at http://localhost:3000');

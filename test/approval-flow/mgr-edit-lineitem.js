// test/approval-flow/mgr-edit-lineitem.js
//
// Smoke test for the v0.68 change: an Ops Manager can EDIT a tech's line-item
// VALUES (not just tag them) while reviewing a SUBMITTED invoice, the invoice
// total recomputes to the manager's values, and the technician is notified.
//
// Covers:
//   • GET    /timeentries/:id  — manager (on team) can load a tech's entry; an
//     unrelated manager is 403'd (the review edit sheet relies on this by-id GET).
//   • PATCH  /timeentries/:id  — Ops Mgr edits hours on a SUBMITTED invoice;
//     invoice total drops to the manager's value; a 'line_item_edited'
//     notification is created for the technician.
//   • Guard  — the owning tech still cannot edit once the invoice is submitted.
//
//   node --experimental-sqlite --no-warnings=ExperimentalWarning test/approval-flow/mgr-edit-lineitem.js

const assert = require('node:assert');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema } = require('../../db');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
ensureSchema(db);

// ---- Seed users ----------------------------------------------------------
function addUser(name, email, role, worker_type = null, rate = null) {
  return Number(db.prepare(
    "INSERT INTO users (name, email, role, worker_type, hourly_rate) VALUES (?,?,?,?,?)"
  ).run(name, email, role, worker_type, rate).lastInsertRowid);
}
const ops   = addUser('Olive Ops',   'olive@e.com', 'ops_manager');
const ops2  = addUser('Otto Other',  'otto@e.com',  'ops_manager'); // NOT on tech's team
const tech  = addUser('Terry Tech',  'terry@e.com', 'technician', 'contractor', 40);

// tech is on ops's team (but not ops2's)
db.prepare("INSERT INTO manager_team (manager_user_id, tech_user_id) VALUES (?,?)").run(ops, tech);

// ---- Seed a work order + submitted invoice + an 8h labor entry -----------
const wo = Number(db.prepare(`
  INSERT INTO work_orders (external_id, source_system, work_type, store_name)
  VALUES ('WO-1', 'maintainx', 'repair', 'Store 1')
`).run().lastInsertRowid);

const now = new Date().toISOString();
const inv = Number(db.prepare(`
  INSERT INTO invoices (invoice_number, user_id, period_start, period_end, status, total, submitted_at, invoice_type, created_by, origin)
  VALUES ('INV-EDIT-001', ?, '2026-06-01', '2026-06-07', 'submitted', 0, ?, 'tech_labor', ?, 'tech_self')
`).run(tech, now, tech).lastInsertRowid);

// 8 hours of work-mode labor (09:00 -> 17:00, no break) attached to the invoice.
const te = Number(db.prepare(`
  INSERT INTO time_entries (user_id, work_order_id, clock_in, clock_out, break_minutes, mode, notes, invoice_id)
  VALUES (?, ?, '2026-06-02T09:00:00.000Z', '2026-06-02T17:00:00.000Z', 0, 'work', 'tech logged', ?)
`).run(tech, wo, inv).lastInsertRowid);

// ---- App with stubbed auth (mount invoices FIRST so db.__computeInvoice is set) ----
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use((req, _res, next) => { if (req.headers['x-test-uid']) req.headers['x-user-id'] = req.headers['x-test-uid']; next(); });
app.use('/api', require('../../routes/invoices')(db));
app.use('/api', require('../../routes/timeentries')(db));

const notifs = (kind, invId) =>
  db.prepare("SELECT * FROM notifications WHERE kind = ? AND invoice_id = ?").all(kind, invId);

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, uid, method = 'POST', body) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-uid': String(uid) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const totalOf = async (uid) => (await call(`/api/invoices/${inv}`, uid, 'GET')).json.summary?.total;

  let pass = 0;
  const ok = (cond, label) => { assert.ok(cond, label); console.log(`  ✓ ${label}`); pass++; };

  try {
    console.log('\nGET /timeentries/:id — manager can load a tech\'s entry:');

    let r = await call(`/api/timeentries/${te}`, ops, 'GET');
    ok(r.status === 200, `Ops (on team) GET entry -> 200 (got ${r.status})`);
    ok(Math.abs((r.json.hours ?? 0) - 8) < 0.001, `entry reports 8.0 billable hours (got ${r.json.hours})`);

    r = await call(`/api/timeentries/${te}`, ops2, 'GET');
    ok(r.status === 403, `Unrelated Ops GET entry -> 403 (got ${r.status})`);

    console.log('\nPATCH /timeentries/:id — Ops edits value on a SUBMITTED invoice:');

    const t0 = await totalOf(ops);
    ok(Math.abs(t0 - 320) < 0.5, `baseline total reflects tech's 8h x $40 = $320 (got ${t0})`);

    // Ops reduces the entry to 6 hours (09:00 -> 15:00).
    r = await call(`/api/timeentries/${te}`, ops, 'PATCH', {
      clock_in:  '2026-06-02T09:00:00.000Z',
      clock_out: '2026-06-02T15:00:00.000Z',
      break_minutes: 0,
      mode: 'work',
      notes: 'ops adjusted to 6h',
    });
    ok(r.status === 200, `Ops PATCH entry on submitted invoice -> 200 (got ${r.status} ${JSON.stringify(r.json)})`);

    const t1 = await totalOf(ops);
    ok(t1 < t0, `total dropped after the edit (${t0} -> ${t1})`);
    ok(Math.abs(t1 - 240) < 0.5, `total now reflects the OPS value: 6h x $40 = $240 (got ${t1})`);

    console.log('\nTechnician is notified that values changed:');
    const n = notifs('line_item_edited', inv);
    ok(n.length >= 1, `a 'line_item_edited' notification was created (got ${n.length})`);
    ok(n.some(x => x.recipient === 'terry@e.com'), 'notification is addressed to the technician');
    ok(n.some(x => x.triggered_by === ops), 'notification records the Ops Mgr as the editor');

    console.log('\nGuard — the owning tech still cannot edit a submitted invoice:');
    r = await call(`/api/timeentries/${te}`, tech, 'PATCH', {
      clock_in:  '2026-06-02T09:00:00.000Z',
      clock_out: '2026-06-02T18:00:00.000Z',
      break_minutes: 0, mode: 'work',
    });
    ok(r.status === 409, `tech PATCH on submitted invoice -> 409 (got ${r.status})`);
    const t2 = await totalOf(ops);
    ok(Math.abs(t2 - 240) < 0.5, `total unchanged by the rejected tech edit (still $240, got ${t2})`);

    console.log(`\n✅ ALL ${pass} CHECKS PASSED`);
    server.close();
    process.exit(0);
  } catch (e) {
    console.error('\n❌ TEST FAILED:', e.message);
    server.close();
    process.exit(1);
  }
})();

// test/approval-flow/self-invoice-guard.js
//
// Regression test for the v0.67.1 segregation-of-duties fix:
//   • Only TECHNICIANS may self-create a tech_labor invoice (payee = caller).
//     Managers / Sr Mgrs / PMs are approvers, not payees — the three
//     self-create entrypoints must reject them with 403:
//        GET  /api/invoices/current
//        POST /api/invoices/for-week
//        POST /api/invoices/custom-period
//   • A technician can still self-create normally (the legit flow is intact).
//   • Nobody can ESCALATE their own invoice (tech-labor owner / vendor creator),
//     closing the submit → escalate → send-to-ap self-serve path.
//
// Mounts the REAL routes/invoices.js + routes/approvals.js on an in-memory DB
// with a stubbed auth middleware, same approach as http-smoke.js.
//
//   node --experimental-sqlite --no-warnings=ExperimentalWarning test/approval-flow/self-invoice-guard.js

const assert = require('node:assert');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema } = require('../../db');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
ensureSchema(db);

function addUser(name, email, role, worker_type = null, rate = null) {
  return Number(db.prepare(
    "INSERT INTO users (name, email, role, worker_type, hourly_rate) VALUES (?,?,?,?,?)"
  ).run(name, email, role, worker_type, rate).lastInsertRowid);
}
const pm   = addUser('Pat PM', 'pat@e.com', 'pm');
const sr   = addUser('Sam Senior', 'sam@e.com', 'sr_manager');
const ops  = addUser('Olive Ops', 'olive@e.com', 'ops_manager');
const tech = addUser('Terry Tech', 'terry@e.com', 'technician', 'contractor', 40);
db.prepare("INSERT INTO manager_team (manager_user_id, tech_user_id) VALUES (?,?)").run(ops, tech);

// A submitted tech-labor invoice OWNED BY THE PM (simulates the pre-fix state so
// the escalate self-guard is exercised in isolation) and one owned by the tech.
function addSubmitted(num, ownerId, type = 'tech_labor', createdBy = null) {
  const now = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO invoices (invoice_number, user_id, period_start, period_end, status, total, submitted_at, invoice_type, created_by, origin)
    VALUES (?, ?, '2026-06-01', '2026-06-07', 'submitted', 100, ?, ?, ?, 'tech_self')
  `).run(num, ownerId, now, type, createdBy ?? ownerId).lastInsertRowid);
}
const pmOwnInv     = addSubmitted('INV-PM-001', pm);                       // pm is the payee
const techInv      = addSubmitted('INV-TECH-001', tech);                   // tech is the payee
const opsVendorInv = addSubmitted('VND-OPS-001', ops, 'vendor', ops);      // ops is the creator

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use((req, _res, next) => { if (req.headers['x-test-uid']) req.headers['x-user-id'] = req.headers['x-test-uid']; next(); });
app.use('/api', require('../../routes/invoices')(db));
app.use('/api', require('../../routes/approvals')(db));

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

  let pass = 0;
  const ok = (cond, label) => { assert.ok(cond, label); console.log(`  ✓ ${label}`); pass++; };

  try {
    console.log('\nSELF-CREATE IS TECHNICIAN-ONLY — managers/PMs are rejected:');

    for (const [role, uid] of [['PM', pm], ['Sr Mgr', sr], ['Ops Mgr', ops]]) {
      let r = await call('/api/invoices/current', uid, 'GET');
      ok(r.status === 403, `${role} GET /invoices/current -> 403 (got ${r.status})`);
      r = await call('/api/invoices/for-week', uid, 'POST', { week_of: '2026-06-01' });
      ok(r.status === 403, `${role} POST /invoices/for-week -> 403 (got ${r.status})`);
      r = await call('/api/invoices/custom-period', uid, 'POST', { period_start: '2026-06-01', period_end: '2026-06-07', work_order_ids: [] });
      ok(r.status === 403, `${role} POST /invoices/custom-period -> 403 (got ${r.status})`);
    }

    // No new manager-owned invoices should exist as a result of the above.
    const mgrOwned = db.prepare(
      "SELECT COUNT(*) n FROM invoices i JOIN users u ON u.id = i.user_id WHERE u.role != 'technician' AND i.invoice_type = 'tech_labor'"
    ).get().n;
    ok(mgrOwned === 1, `no NEW manager-owned tech_labor invoices created (only the pre-seeded one remains: ${mgrOwned})`);

    console.log('\nTECHNICIAN SELF-CREATE STILL WORKS — legit flow intact:');

    let r = await call('/api/invoices/current', tech, 'GET');
    ok(r.status === 200 && r.json.invoice && r.json.invoice.user_id === tech,
       `Tech GET /invoices/current -> 200, draft owned by tech (got ${r.status})`);

    r = await call('/api/invoices/for-week', tech, 'POST', { week_of: '2026-06-01' });
    ok(r.status === 200 && r.json.invoice && r.json.invoice.user_id === tech,
       `Tech POST /invoices/for-week -> 200, draft owned by tech (got ${r.status})`);

    r = await call('/api/invoices/custom-period', tech, 'POST', { period_start: '2026-06-08', period_end: '2026-06-14', work_order_ids: [] });
    ok(r.status === 200 && r.json.invoice && r.json.invoice.user_id === tech,
       `Tech POST /invoices/custom-period -> 200, draft owned by tech (got ${r.status})`);

    console.log('\nESCALATION SELF-GUARD — you cannot escalate your own invoice:');

    r = await call(`/api/invoices/${pmOwnInv}/escalate`, pm, 'POST', { note: 'self' });
    ok(r.status === 409, `PM escalate OWN tech-labor invoice -> 409 (got ${r.status})`);
    ok(db.prepare("SELECT status FROM invoices WHERE id=?").get(pmOwnInv).status === 'submitted',
       'PM-owned invoice stays submitted (not advanced to approved_ops)');

    r = await call(`/api/invoices/${opsVendorInv}/escalate`, ops, 'POST', { note: 'self' });
    ok(r.status === 409, `Ops escalate OWN vendor invoice (creator) -> 409 (got ${r.status})`);

    // Positive control: a manager CAN escalate someone else's invoice.
    r = await call(`/api/invoices/${techInv}/escalate`, ops, 'POST', { note: 'please review' });
    ok(r.status === 200, `Ops escalate the TECH's invoice -> 200 (got ${r.status} ${JSON.stringify(r.json)})`);
    ok(db.prepare("SELECT status FROM invoices WHERE id=?").get(techInv).status === 'approved_ops',
       'tech invoice advanced to approved_ops by a non-owner manager');

    console.log(`\nALL ${pass} CHECKS PASSED ✅\n`);
  } catch (e) {
    console.error(`\n❌ FAILED after ${pass} checks:`, e.message, '\n');
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();

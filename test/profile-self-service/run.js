// test/profile-self-service/run.js
//
// Regression test for the v1.01 fix to PATCH /api/me (routes/auth.js):
//   • A TECHNICIAN may self-service invoice_email, home_address and home_phone.
//   • A technician may NOT change hourly_rate (rates locked, PRD §4.4) or their
//     login email (account identity) — both stay manager-managed → 403.
//   • The Settings form posts every profile field together, so the realistic
//     tech save {invoice_email, home_address, home_phone} (no login email) must
//     succeed — this is the exact bug that was 403'ing the whole request.
//   • Non-technician roles (ops_manager/sr_manager/pm) are unaffected: they may
//     still update email + hourly_rate on their own profile here (positive control).
//   • invoice_email format is still validated (bad address → 400).
//
// Mounts the REAL routes/auth.js on an in-memory DB with a stubbed auth
// middleware, same approach as test/approval-flow/self-invoice-guard.js.
//
//   node --experimental-sqlite --no-warnings=ExperimentalWarning test/profile-self-service/run.js

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
const ops  = addUser('Olive Ops', 'olive@e.com', 'ops_manager');
const tech = addUser('Terry Tech', 'terry@e.com', 'technician', 'contractor', 40);

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use((req, _res, next) => { if (req.headers['x-test-uid']) req.headers['x-user-id'] = req.headers['x-test-uid']; next(); });
app.use('/api', require('../../routes/auth')(db));

const emailOf = (id) => db.prepare("SELECT email FROM users WHERE id=?").get(id).email;
const rateOf  = (id) => db.prepare("SELECT hourly_rate FROM users WHERE id=?").get(id).hourly_rate;
const row     = (id) => db.prepare("SELECT invoice_email, home_address, home_phone FROM users WHERE id=?").get(id);

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const patchMe = async (uid, body) => {
    const r = await fetch(base + '/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-uid': String(uid) },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  let pass = 0;
  const ok = (cond, label) => { assert.ok(cond, label); console.log(`  ✓ ${label}`); pass++; };

  try {
    console.log('\nTECHNICIAN SELF-SERVICE — contact fields save (the bug):');

    // The exact shape the Settings form sends for a technician (no login email).
    let r = await patchMe(tech, { invoice_email: 'pay@terry.com', home_address: '24 Mayflower Dr', home_phone: '856-725-2298' });
    ok(r.status === 200, `Tech PATCH {invoice_email,address,phone} -> 200 (got ${r.status} ${JSON.stringify(r.json)})`);
    const after = row(tech);
    ok(after.invoice_email === 'pay@terry.com' && after.home_address === '24 Mayflower Dr' && after.home_phone === '856-725-2298',
       'Tech contact fields persisted to DB');

    console.log('\nTECHNICIAN CANNOT change login email or hourly_rate — 403, no write:');

    r = await patchMe(tech, { email: 'hacker@evil.com' });
    ok(r.status === 403, `Tech PATCH {email} -> 403 (got ${r.status})`);
    ok(emailOf(tech) === 'terry@e.com', 'Tech login email UNCHANGED in DB');

    r = await patchMe(tech, { hourly_rate: 999 });
    ok(r.status === 403, `Tech PATCH {hourly_rate} -> 403 (got ${r.status})`);
    ok(rateOf(tech) === 40, 'Tech hourly_rate UNCHANGED in DB (rates locked)');

    // Mixed request (login email bundled with contact fields) is rejected wholesale,
    // and must not partially persist the contact fields either.
    r = await patchMe(tech, { email: 'x@y.com', home_phone: '000-000-0000' });
    ok(r.status === 403, `Tech PATCH {email,phone} -> 403 (got ${r.status})`);
    ok(row(tech).home_phone === '856-725-2298', 'Tech phone NOT partially overwritten by the rejected mixed request');

    r = await patchMe(tech, { hourly_rate: 500, home_address: 'HACK ST' });
    ok(r.status === 403, `Tech PATCH {hourly_rate,address} -> 403 (got ${r.status})`);
    ok(rateOf(tech) === 40 && row(tech).home_address === '24 Mayflower Dr',
       'Tech rate + address NOT partially written by the rejected mixed request');

    console.log('\nINVOICE-EMAIL VALIDATION still enforced:');

    r = await patchMe(tech, { invoice_email: 'not-an-email' });
    ok(r.status === 400, `Tech PATCH {invoice_email:'not-an-email'} -> 400 (got ${r.status})`);

    console.log('\nNON-TECHNICIAN ROLES UNAFFECTED (positive control):');

    r = await patchMe(ops, { email: 'olive2@e.com', hourly_rate: 55 });
    ok(r.status === 200, `Ops PATCH {email,hourly_rate} -> 200 (got ${r.status} ${JSON.stringify(r.json)})`);
    ok(emailOf(ops) === 'olive2@e.com' && rateOf(ops) === 55, 'Ops email + rate updated in DB');

    r = await patchMe(ops, { invoice_email: 'ap@e.com' });
    ok(r.status === 200 && row(ops).invoice_email === 'ap@e.com', `Ops PATCH {invoice_email} -> 200 & persisted (got ${r.status})`);

    console.log(`\nALL ${pass} CHECKS PASSED ✅\n`);
  } catch (e) {
    console.error(`\n❌ FAILED after ${pass} checks:`, e.message, '\n');
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();

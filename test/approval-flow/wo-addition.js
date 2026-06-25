// test/approval-flow/wo-addition.js
//
// End-to-end HTTP smoke test for the v0.68 "add work orders to an
// already-submitted week" flow:
//   • A tech files a request against a LOCKED (submitted) invoice.
//   • Ops Mgr (team) decides:
//       - DENY    → request returned with a reason + a tech notification.
//       - APPROVE → a NEW supplemental DRAFT invoice is minted for the SAME
//                   week, pre-seeded with the requested work orders (and any
//                   orphan time/expenses for them swept in); the tech is
//                   notified with a link to the new invoice.
//   • Guards: owner-only filing, locked-status-only, one pending per invoice,
//     manager-role + team scoping on the decision, race-safe re-decide.
//
// Mounts the REAL routes/invoices.js on an in-memory DB with a stubbed auth
// middleware and drives the flow over HTTP.
//
//   node --experimental-sqlite --no-warnings=ExperimentalWarning test/approval-flow/wo-addition.js

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
const ops   = addUser('Olive Ops',  'olive@e.com', 'ops_manager');
const ops2  = addUser('Otto Other', 'otto@e.com',  'ops_manager');   // no team
const sr    = addUser('Sam Senior', 'sam@e.com',   'sr_manager');
const tech  = addUser('Terry Tech', 'terry@e.com', 'technician', 'contractor', 40);
const tech2 = addUser('Tina Tech',  'tina@e.com',  'technician', 'contractor', 40);

// tech is on ops's team; tech2 is on nobody's team; ops2 has no team.
db.prepare("INSERT INTO manager_team (manager_user_id, tech_user_id) VALUES (?,?)").run(ops, tech);

// ---- Seed invoices -------------------------------------------------------
const PSTART = '2026-06-01', PEND = '2026-06-07';
function addSubmittedInvoice(num) {
  const now = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO invoices (invoice_number, user_id, period_start, period_end, status, total, submitted_at, invoice_type, created_by, origin)
    VALUES (?, ?, ?, ?, 'submitted', 100, ?, 'tech_labor', ?, 'tech_self')
  `).run(num, tech, PSTART, PEND, now, tech).lastInsertRowid);
}
const invA = addSubmittedInvoice('INV-2026-0607-U04');   // deny path
const invB = addSubmittedInvoice('INV-2026-0607-U04-A'); // approve path
const invDraft = Number(db.prepare(`
  INSERT INTO invoices (invoice_number, user_id, period_start, period_end, status, total, invoice_type, created_by, origin)
  VALUES ('INV-2026-0614-U04', ?, '2026-06-08', '2026-06-14', 'draft', 0, 'tech_labor', ?, 'tech_self')
`).run(tech, tech).lastInsertRowid);

// An EXISTING work order for the tech + an orphan time entry in invB's week, so
// approval should sweep it into the new supplemental invoice.
const woExisting = Number(db.prepare(`
  INSERT INTO work_orders (external_id, source_system, source_ticket_id, work_type, store_name, cart_count, status, assigned_user_id)
  VALUES ('MX-RPR-555001', 'maintainx', '555001', 'repair', 'ShopRite #12', 4, 'in_progress', ?)
`).run(tech).lastInsertRowid);
db.prepare(`
  INSERT INTO time_entries (user_id, work_order_id, clock_in, clock_out, mode, invoice_id)
  VALUES (?, ?, '2026-06-03T09:00:00.000Z', '2026-06-03T13:00:00.000Z', 'work', NULL)
`).run(tech, woExisting);

// ---- App with stubbed auth ----------------------------------------------
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use((req, _res, next) => { if (req.headers['x-test-uid']) req.headers['x-user-id'] = req.headers['x-test-uid']; next(); });
app.use('/api', require('../../routes/invoices')(db));

const notifs = (kind) => db.prepare("SELECT * FROM notifications WHERE kind = ?").all(kind);
const reqRow = (id) => db.prepare("SELECT * FROM wo_addition_requests WHERE id = ?").get(id);

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
    console.log('\nFILING GUARDS:');

    // Non-owner can't file on someone else's invoice.
    let r = await call(`/api/invoices/${invA}/request-additional-wos`, tech2, 'POST', { wos: '123' });
    ok(r.status === 403, `non-owner filing -> 403 (got ${r.status})`);

    // Can't file on a draft (editable directly).
    r = await call(`/api/invoices/${invDraft}/request-additional-wos`, tech, 'POST', { wos: '123' });
    ok(r.status === 409, `filing on a draft -> 409 (got ${r.status})`);

    // Empty WO list rejected.
    r = await call(`/api/invoices/${invA}/request-additional-wos`, tech, 'POST', { wos: '   ' });
    ok(r.status === 400, `empty WO list -> 400 (got ${r.status})`);

    // Valid filing on a submitted invoice.
    r = await call(`/api/invoices/${invA}/request-additional-wos`, tech, 'POST',
      { wos: '777002', note: 'Missed a store on Friday' });
    ok(r.status === 200 && r.json.id, `tech files request on A -> 200`);
    const reqA = r.json.id;
    ok(reqRow(reqA).status === 'pending', 'request A is pending');
    ok(notifs('wo_addition_requested').length === 1, 'Ops Mgr notified of the new request');

    // Duplicate pending request blocked.
    r = await call(`/api/invoices/${invA}/request-additional-wos`, tech, 'POST', { wos: '888' });
    ok(r.status === 409, `second pending request on A -> 409 (got ${r.status})`);

    console.log('\nMANAGER QUEUE + DECISION GUARDS:');

    // Ops Mgr (team) sees the request in their queue.
    r = await call(`/api/addition-requests/queue`, ops, 'GET');
    ok(r.status === 200 && r.json.some(x => x.id === reqA), 'request A appears in Ops Mgr queue');
    ok(r.json.find(x => x.id === reqA).tech_name === 'Terry Tech', 'queue row carries tech name');

    // A tech cannot decide.
    r = await call(`/api/addition-requests/${reqA}/deny`, tech, 'POST', { reason: 'nope nope' });
    ok(r.status === 403, `tech denying -> 403 (got ${r.status})`);

    // An Ops Mgr whose team excludes this tech cannot decide.
    r = await call(`/api/addition-requests/${reqA}/deny`, ops2, 'POST', { reason: 'not my team' });
    ok(r.status === 403, `off-team Ops Mgr denying -> 403 (got ${r.status})`);

    // Deny requires a reason (min 5 chars).
    r = await call(`/api/addition-requests/${reqA}/deny`, ops, 'POST', { reason: 'no' });
    ok(r.status === 400, `deny without a real reason -> 400 (got ${r.status})`);

    console.log('\nDENY PATH:');

    r = await call(`/api/addition-requests/${reqA}/deny`, ops, 'POST',
      { reason: 'These belong on next week — file them there.' });
    ok(r.status === 200, `Ops denies request A -> 200 (got ${r.status})`);
    ok(reqRow(reqA).status === 'denied', 'request A is denied');
    const dN = notifs('wo_addition_denied');
    ok(dN.length === 1 && dN[0].recipient === 'terry@e.com', 'tech notified of denial');
    ok(/belong on next week/.test(dN[0].body || ''), 'denial notification carries the reason');

    // Re-deciding a decided request is rejected.
    r = await call(`/api/addition-requests/${reqA}/deny`, ops, 'POST', { reason: 'again again' });
    ok(r.status === 409, `re-deciding A -> 409 (got ${r.status})`);

    // Original invoice A is untouched by the denial.
    ok(db.prepare("SELECT status FROM invoices WHERE id = ?").get(invA).status === 'submitted',
       'denied request leaves the original invoice submitted/untouched');

    console.log('\nAPPROVE PATH:');

    // File a fresh request on invB referencing an existing WO (555001) + a new one (999999).
    r = await call(`/api/invoices/${invB}/request-additional-wos`, tech, 'POST',
      { wos: '555001, 999999', note: 'Two extra stores' });
    ok(r.status === 200, `tech files request on B -> 200`);
    const reqB = r.json.id;

    const invCountBefore = db.prepare("SELECT COUNT(*) c FROM invoices WHERE user_id = ?").get(tech).c;
    r = await call(`/api/addition-requests/${reqB}/approve`, ops, 'POST', {});
    ok(r.status === 200 && r.json.ok, `Ops approves request B -> 200 (got ${r.status} ${JSON.stringify(r.json).slice(0,160)})`);
    const newInvId = r.json.new_invoice && r.json.new_invoice.id;
    ok(!!newInvId, 'approval returns a new invoice');
    ok(reqRow(reqB).status === 'approved' && reqRow(reqB).new_invoice_id === newInvId,
       'request B is approved + linked to the new invoice');

    const invCountAfter = db.prepare("SELECT COUNT(*) c FROM invoices WHERE user_id = ?").get(tech).c;
    ok(invCountAfter === invCountBefore + 1, 'exactly one supplemental invoice was created');

    const newInv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(newInvId);
    ok(newInv.status === 'draft', 'supplemental invoice is a draft');
    ok(newInv.user_id === tech, 'supplemental invoice is owned by the tech');
    ok(newInv.period_start === PSTART && newInv.period_end === PEND, 'supplemental invoice is for the SAME week');
    ok(newInv.invoice_number !== 'INV-2026-0607-U04' && newInv.invoice_number.startsWith('INV-2026-0607-U04'),
       `supplemental invoice number is suffixed (${newInv.invoice_number})`);

    // WO resolution: existing matched (not created), new minted.
    const byTok = Object.fromEntries((r.json.work_orders || []).map(w => [w.token, w]));
    ok(byTok['555001'] && byTok['555001'].created === false && byTok['555001'].external_id === 'MX-RPR-555001',
       'existing WO 555001 was matched (not duplicated)');
    ok(byTok['999999'] && byTok['999999'].created === true,
       'unknown WO 999999 was minted as a placeholder');

    // The orphan time entry on the existing WO got swept into the new invoice.
    const sweptInvId = db.prepare("SELECT invoice_id FROM time_entries WHERE work_order_id = ?").get(woExisting).invoice_id;
    ok(sweptInvId === newInvId, 'orphan time entry for the requested WO was swept into the supplemental invoice');

    // Tech notified of approval, pointing at the NEW invoice.
    const aN = notifs('wo_addition_approved');
    ok(aN.length === 1 && aN[0].recipient === 'terry@e.com' && aN[0].invoice_id === newInvId,
       'tech notified of approval, linked to the new invoice');

    // Re-approving the decided request is rejected (no second invoice).
    r = await call(`/api/addition-requests/${reqB}/approve`, ops, 'POST', {});
    ok(r.status === 409, `re-approving B -> 409 (got ${r.status})`);
    ok(db.prepare("SELECT COUNT(*) c FROM invoices WHERE user_id = ?").get(tech).c === invCountAfter,
       'no extra invoice minted on the rejected re-approve');

    console.log('\nTECH-FACING READS:');

    // Tech can read their own requests across invoices.
    r = await call(`/api/addition-requests/mine`, tech, 'GET');
    ok(r.status === 200 && r.json.length === 2, `tech sees both of their requests (got ${r.json.length})`);
    const mineApproved = r.json.find(x => x.id === reqB);
    ok(mineApproved && mineApproved.new_invoice_number === newInv.invoice_number,
       'approved request exposes the new invoice number to the tech');

    // Tech can read the per-invoice request list.
    r = await call(`/api/invoices/${invB}/addition-requests`, tech, 'GET');
    ok(r.status === 200 && r.json.some(x => x.id === reqB), 'per-invoice request list returns the request');

    // Sr Mgr also sees pending requests (none now) and can act org-wide.
    r = await call(`/api/addition-requests/queue`, sr, 'GET');
    ok(r.status === 200 && Array.isArray(r.json) && r.json.length === 0,
       'queue is empty after both requests are decided');

    console.log(`\nALL ${pass} CHECKS PASSED ✅\n`);
  } catch (e) {
    console.error(`\n❌ FAILED after ${pass} checks:`, e.message, '\n');
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();

// test/approval-flow/http-smoke.js
//
// End-to-end HTTP smoke test for the v0.67 approval flow change:
//   • Ops Manager approval is the FINAL approval in the tech-labor flow.
//   • On Ops approval the technician is notified to verify & send to AP.
//   • Non-escalated approved_ops invoices no longer sit in the Sr Mgr queue;
//     escalated ones still do (the escalation safety valve).
//   • After approval the technician is cleared to send to AP (can_send=true),
//     which is the final step in the tracked lifecycle (-> sent_ap).
//
// Mounts the REAL routes/invoices.js + routes/approvals.js on an in-memory DB
// with a stubbed auth middleware (identity normally comes from a validated
// session), and drives the flow over HTTP. Side-effect free: it checks
// sendability via GET /ap-preview rather than POST /send-to-ap (which would
// write a PDF to data/receipts).
//
//   node --experimental-sqlite --no-warnings=ExperimentalWarning test/approval-flow/http-smoke.js

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
const ops  = addUser('Olive Ops', 'olive@e.com', 'ops_manager');
const sr   = addUser('Sam Senior', 'sam@e.com', 'sr_manager');
const tech = addUser('Terry Tech', 'terry@e.com', 'technician', 'contractor', 40);

// tech is on ops's team
db.prepare("INSERT INTO manager_team (manager_user_id, tech_user_id) VALUES (?,?)").run(ops, tech);

// ---- Seed two submitted tech-labor invoices ------------------------------
function addSubmittedInvoice(num) {
  const now = new Date().toISOString();
  return Number(db.prepare(`
    INSERT INTO invoices (invoice_number, user_id, period_start, period_end, status, total, submitted_at, invoice_type, created_by, origin)
    VALUES (?, ?, '2026-06-01', '2026-06-07', 'submitted', 100, ?, 'tech_labor', ?, 'tech_self')
  `).run(num, tech, now, tech).lastInsertRowid);
}
const invA = addSubmittedInvoice('INV-A-001'); // normal path
const invB = addSubmittedInvoice('INV-B-002'); // escalation path

// ---- App with stubbed auth ----------------------------------------------
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use((req, _res, next) => { if (req.headers['x-test-uid']) req.headers['x-user-id'] = req.headers['x-test-uid']; next(); });
app.use('/api', require('../../routes/invoices')(db));
app.use('/api', require('../../routes/approvals')(db));

const notifs = (kind, invId) =>
  db.prepare("SELECT * FROM notifications WHERE kind = ? AND invoice_id = ?").all(kind, invId);
const statusOf = (id) => db.prepare("SELECT status, escalated_at, approved_ops_at, approved_sr_at FROM invoices WHERE id = ?").get(id);

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
    console.log('\nNORMAL PATH — Ops approval is final, tech notified to send:');

    // 1) Ops approves invoice A
    let r = await call(`/api/invoices/${invA}/approve`, ops);
    ok(r.status === 200, `Ops approve A -> 200 (got ${r.status} ${JSON.stringify(r.json)})`);
    ok(statusOf(invA).status === 'approved_ops', 'A is approved_ops');

    // 2) Tech notification created on Ops approval
    const nA = notifs('invoice_approved_for_ap', invA);
    ok(nA.length === 1, 'one invoice_approved_for_ap notification for A');
    ok(nA[0] && nA[0].recipient === 'terry@e.com', 'notification addressed to the technician');

    // 3) Sr Mgr keeps FULL visibility: the non-escalated approved_ops invoice
    //    still appears in their queue, but flagged review-only (no action needed).
    r = await call(`/api/approvals/queue`, sr, 'GET');
    ok(r.status === 200, 'Sr Mgr queue -> 200');
    const rowA = r.json.find(i => i.id === invA);
    ok(rowA, 'Sr Mgr queue INCLUDES non-escalated approved_ops (A) — visibility retained');
    ok(rowA && rowA.action_needed === 0, 'A is marked review-only for Sr Mgr (action_needed=0)');

    // 4) Tech is cleared to send A to AP (final lifecycle step)
    r = await call(`/api/invoices/${invA}/ap-preview`, tech, 'GET');
    ok(r.status === 200 && r.json.can_send === true,
       `Tech can send A to AP after Ops approval (can_send=${r.json.can_send})`);

    // Ops Mgr can no longer approve their own non-escalated decision twice; also
    // confirm a SECOND ops approval is rejected (state already moved on).
    r = await call(`/api/invoices/${invA}/approve`, ops);
    ok(r.status === 409, `re-approving A is rejected as state moved on (got ${r.status})`);

    console.log('\nESCALATION VALVE — Sr Mgr still reviews escalated invoices:');

    // 5) Ops escalates invoice B (does NOT approve it)
    r = await call(`/api/invoices/${invB}/escalate`, ops, 'POST', { note: 'please double-check' });
    ok(r.status === 200, `Ops escalate B -> 200 (got ${r.status})`);
    const sB = statusOf(invB);
    ok(sB.status === 'approved_ops' && sB.escalated_at && !sB.approved_ops_at,
       'B is approved_ops + escalated, but not ops-approved');

    // 6) No tech "verify & send" notification yet (escalation != approval)
    ok(notifs('invoice_approved_for_ap', invB).length === 0,
       'no verify-and-send notification on escalation (pending Sr Mgr)');

    // 7) Sr Mgr queue includes the escalated invoice, flagged as action-needed
    r = await call(`/api/approvals/queue`, sr, 'GET');
    const rowB = r.json.find(i => i.id === invB);
    ok(rowB, 'Sr Mgr queue includes escalated invoice (B)');
    ok(rowB && rowB.action_needed === 1, 'B is marked action-needed for Sr Mgr (needs countersign)');

    // 8) Sr Mgr countersigns -> approved_sr
    r = await call(`/api/invoices/${invB}/approve`, sr);
    ok(r.status === 200, `Sr Mgr approve B -> 200 (got ${r.status} ${JSON.stringify(r.json)})`);
    ok(statusOf(invB).status === 'approved_sr', 'B is approved_sr');

    // 9) NOW the tech gets the verify-and-send notification
    ok(notifs('invoice_approved_for_ap', invB).length === 1,
       'verify-and-send notification created on final (Sr Mgr) approval of escalated B');

    // 10) Tech is cleared to send B to AP
    r = await call(`/api/invoices/${invB}/ap-preview`, tech, 'GET');
    ok(r.status === 200 && r.json.can_send === true,
       `Tech can send B to AP after Sr Mgr countersign (can_send=${r.json.can_send})`);

    console.log(`\nALL ${pass} CHECKS PASSED ✅\n`);
  } catch (e) {
    console.error(`\n❌ FAILED after ${pass} checks:`, e.message, '\n');
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();

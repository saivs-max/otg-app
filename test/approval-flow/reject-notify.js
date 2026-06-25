// test/approval-flow/reject-notify.js
//
// HTTP smoke test for the v0.71 rejection-notification flow:
//   • Rejecting an invoice creates an 'invoice_rejected' notification for the
//     technician (previously the reject silently reverted the invoice to draft
//     with no signal to the tech).
//   • GET /api/notifications returns the tech's active (un-dismissed) banners.
//   • Dismissal is owner-scoped (a manager can't dismiss the tech's banner) and
//     persists server-side, so a dismissed notification stops being returned.
//
// Mounts the REAL routes/invoices.js + routes/approvals.js + routes/notifications.js
// on an in-memory DB with a stubbed auth middleware, and drives it over HTTP.
//
//   node --experimental-sqlite --no-warnings=ExperimentalWarning test/approval-flow/reject-notify.js

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
const tech = addUser('Terry Tech', 'terry@e.com', 'technician', 'contractor', 40);

// tech is on ops's team (reject requires the tech to be on the ops mgr's team)
db.prepare("INSERT INTO manager_team (manager_user_id, tech_user_id) VALUES (?,?)").run(ops, tech);

// ---- Seed a submitted tech-labor invoice ---------------------------------
const now = new Date().toISOString();
const invId = Number(db.prepare(`
  INSERT INTO invoices (invoice_number, user_id, period_start, period_end, status, total, submitted_at, invoice_type, created_by, origin)
  VALUES ('INV-R-001', ?, '2026-06-01', '2026-06-07', 'submitted', 100, ?, 'tech_labor', ?, 'tech_self')
`).run(tech, now, tech).lastInsertRowid);

// ---- App with stubbed auth ----------------------------------------------
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use((req, _res, next) => { if (req.headers['x-test-uid']) req.headers['x-user-id'] = req.headers['x-test-uid']; next(); });
app.use('/api', require('../../routes/invoices')(db));
app.use('/api', require('../../routes/approvals')(db));
app.use('/api', require('../../routes/notifications')(db));

const rejectNotifs = () =>
  db.prepare("SELECT * FROM notifications WHERE kind = 'invoice_rejected' AND invoice_id = ?").all(invId);
const statusOf = (id) => db.prepare("SELECT status, rejected_at, rejection_reason FROM invoices WHERE id = ?").get(id);

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
    console.log('\nREJECTION NOTIFICATION — tech is notified and can dismiss:');

    // 0) Before rejecting, the tech has no active notifications.
    let r = await call('/api/notifications', tech, 'GET');
    ok(r.status === 200 && Array.isArray(r.json) && r.json.length === 0,
       'tech starts with no active notifications');

    // 1) Ops rejects the invoice with a reason.
    const reason = 'Mileage for 06/03 is missing a receipt — please attach and resubmit.';
    r = await call(`/api/invoices/${invId}/reject`, ops, 'POST', { reason });
    ok(r.status === 200, `Ops reject -> 200 (got ${r.status} ${JSON.stringify(r.json)})`);
    ok(statusOf(invId).status === 'draft', 'rejected invoice reverts to draft');

    // 2) A rejection notification was created for the tech.
    const n = rejectNotifs();
    ok(n.length === 1, 'exactly one invoice_rejected notification created');
    ok(n[0] && n[0].recipient === 'terry@e.com', 'notification addressed to the technician');
    ok(n[0] && (n[0].body || '').includes(reason), 'notification body carries the rejection reason');
    ok(n[0] && n[0].dismissed_at == null, 'notification starts un-dismissed');

    // 3) GET /api/notifications (as tech) returns the active banner.
    r = await call('/api/notifications', tech, 'GET');
    ok(r.status === 200 && r.json.length === 1, 'tech sees one active notification');
    const notifId = r.json[0].id;
    ok(r.json[0].invoice_id === invId, 'notification links to the rejected invoice');
    ok(r.json[0].invoice_number === 'INV-R-001', 'notification joins through to invoice_number');

    // 4) The ops manager does NOT see the tech's notification (recipient-scoped).
    r = await call('/api/notifications', ops, 'GET');
    ok(r.status === 200 && r.json.length === 0, 'ops manager does not see the tech-addressed banner');

    // 5) Dismissal is owner-scoped: the ops manager can't dismiss it.
    r = await call(`/api/notifications/${notifId}/dismiss`, ops);
    ok(r.status === 404, `ops cannot dismiss the tech's notification (got ${r.status})`);
    ok(rejectNotifs()[0].dismissed_at == null, 'notification still un-dismissed after foreign dismiss attempt');

    // 6) The tech dismisses it.
    r = await call(`/api/notifications/${notifId}/dismiss`, tech);
    ok(r.status === 200 && r.json.ok === true, 'tech dismisses their notification -> 200');
    ok(rejectNotifs()[0].dismissed_at != null, 'dismissed_at is recorded server-side');

    // 7) It no longer appears in the tech's active list (persisted dismissal).
    r = await call('/api/notifications', tech, 'GET');
    ok(r.status === 200 && r.json.length === 0, 'dismissed notification no longer returned');

    // 8) Dismissing again is idempotent (no error).
    r = await call(`/api/notifications/${notifId}/dismiss`, tech);
    ok(r.status === 200, `re-dismiss is idempotent (got ${r.status})`);

    console.log(`\nALL ${pass} CHECKS PASSED ✅\n`);
  } catch (e) {
    console.error(`\n❌ FAILED after ${pass} checks:`, e.message, '\n');
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();

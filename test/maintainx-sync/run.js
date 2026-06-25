// test/maintainx-sync/run.js
//
// Service-layer tests for the MaintainX per-worker pull + labor import.
// Runs against an in-memory SQLite DB using the real schema/migrations and the
// built-in stub MaintainX client. No network, no HTTP.
//
//   node --experimental-sqlite --no-warnings=ExperimentalWarning test/maintainx-sync/run.js
//
// Deterministic encryption key so crypto doesn't touch data/.mx_enc_key.
process.env.MX_TOKEN_ENC_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema } = require('../../db');
const { encrypt } = require('../../lib/maintainx/crypto');
const { mapWorkOrder, normalizeStatus } = require('../../lib/maintainx/map');
const { reconcileLaborForWorkOrder } = require('../../lib/maintainx/labor');
const { syncForUser, syncSingleWorkOrder } = require('../../lib/maintainx/sync');

let passed = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.strictEqual(a, b, `${msg} (got ${a}, expected ${b})`); passed++; }
function approx(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, expected ~${b})`); passed++; }

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureSchema(db);
  return db;
}
function seedUser(db) {
  const r = db.prepare("INSERT INTO users (name, email, role, worker_type, hourly_rate) VALUES (?,?,?,?,?)")
    .run('Demo Worker', 'worker@example.com', 'technician', 'contractor', 40);
  return Number(r.lastInsertRowid);
}
function connectDemo(db, userId) {
  db.prepare(`INSERT INTO user_integrations
      (user_id, provider, mx_user_id, mx_org_id, access_token_enc, token_type, status)
      VALUES (?, 'maintainx', 'mxuser-1', '477835', ?, 'demo', 'active')`)
    .run(userId, encrypt('stub-demo'));
}
const synthCount = (db, woExternal) => db.prepare(
  "SELECT COUNT(*) c FROM time_entries WHERE source='maintainx_sync' AND work_order_id=(SELECT id FROM work_orders WHERE external_id=?)"
).get(woExternal).c;
const hoursFor = (db, woExternal) => {
  const t = db.prepare("SELECT clock_in, clock_out FROM time_entries WHERE source='maintainx_sync' AND work_order_id=(SELECT id FROM work_orders WHERE external_id=?)").get(woExternal);
  if (!t) return 0;
  return (new Date(t.clock_out) - new Date(t.clock_in)) / 3600000;
};

// ---------------------------------------------------------------------------
check('crypto round-trips and never returns plaintext', () => {
  const blob = encrypt('super-secret-token');
  ok(blob.startsWith('v1:'), 'ciphertext is versioned');
  ok(!blob.includes('super-secret-token'), 'plaintext not present in ciphertext');
  const { decrypt } = require('../../lib/maintainx/crypto');
  eq(decrypt(blob), 'super-secret-token', 'decrypt restores plaintext');
});

check('status + work_type mapping', () => {
  eq(normalizeStatus('DONE'), 'completed', 'DONE -> completed');
  eq(normalizeStatus('IN_PROGRESS'), 'in_progress', 'IN_PROGRESS -> in_progress');
  eq(normalizeStatus('ON_HOLD'), 'in_progress', 'ON_HOLD -> in_progress');
  const m = mapWorkOrder({ id: '42', title: 'Cart Swap - Carts #6 - #10', description: 'Swap carts at Foo - 1 St, NJ', status: 'DONE' });
  eq(m.external_id, 'MX-RPR-42', 'swap classifies as repair');
  eq(m.cart_count, 5, 'cart range 6-10 = 5');
  eq(m.status, 'completed', 'mapped status');
});

check('full sync pulls all WOs, imports labor, idempotent', () => {
  const db = freshDb();
  const uid = seedUser(db);
  connectDemo(db, uid);

  return (async () => {
    const s1 = await syncForUser(db, uid);
    eq(s1.pulled, 5, 'pulled all 5 fixtures');
    eq(s1.created, 5, 'created 5 new WOs');
    eq(s1.laborImported, 4, '4 WOs had MaintainX time imported');
    eq(s1.laborNone, 1, '1 WO had no time');

    const woCount = db.prepare("SELECT COUNT(*) c FROM work_orders").get().c;
    eq(woCount, 5, 'work_orders table has 5 rows');
    const mineCount = db.prepare("SELECT COUNT(*) c FROM work_orders WHERE assigned_user_id=? AND source_system='maintainx'").get(uid).c;
    eq(mineCount, 5, 'all assigned to the worker');

    const synthTotal = db.prepare("SELECT COUNT(*) c FROM time_entries WHERE source='maintainx_sync'").get().c;
    eq(synthTotal, 4, '4 synthetic labor entries created');

    approx(hoursFor(db, 'MX-RPR-900001'), 95 / 60, 0.02, '900001 logged 95m');
    approx(hoursFor(db, 'MX-RPR-900002'), 130 / 60, 0.05, '900002 in-progress 130m');
    approx(hoursFor(db, 'MX-RTR-900005'), 210 / 60, 0.02, '900005 logged 210m');
    eq(synthCount(db, 'MX-DPL-900004'), 0, '900004 (open, no time) has no labor');

    // Idempotency: a second identical sync must not duplicate.
    const s2 = await syncForUser(db, uid);
    eq(s2.created, 0, 'second sync creates nothing');
    eq(s2.updated, 5, 'second sync updates the 5 existing');
    const synthTotal2 = db.prepare("SELECT COUNT(*) c FROM time_entries WHERE source='maintainx_sync'").get().c;
    eq(synthTotal2, 4, 'still exactly 4 synthetic entries (no dupes)');
  })();
});

check('worker-logged time wins: import is removed, app value kept', () => {
  const db = freshDb();
  const uid = seedUser(db);
  connectDemo(db, uid);

  return (async () => {
    await syncForUser(db, uid);
    eq(synthCount(db, 'MX-RPR-900001'), 1, 'starts with 1 imported entry');

    // Worker logs real (app) time on 900001 — 2 hours of 'work'.
    const woId = db.prepare("SELECT id FROM work_orders WHERE external_id='MX-RPR-900001'").get().id;
    const cin = new Date(Date.now() - 2 * 3600000).toISOString();
    const cout = new Date().toISOString();
    db.prepare("INSERT INTO time_entries (user_id, work_order_id, clock_in, clock_out, mode, source) VALUES (?,?,?,?, 'work','app')")
      .run(uid, woId, cin, cout);

    const s = await syncForUser(db, uid);
    eq(synthCount(db, 'MX-RPR-900001'), 0, 'imported entry removed (app wins)');
    const appEntries = db.prepare("SELECT COUNT(*) c FROM time_entries WHERE work_order_id=? AND (source IS NULL OR source='app')").get(woId).c;
    eq(appEntries, 1, 'worker entry preserved');
    ok(s.laborAppWins >= 1, 'summary records an app_wins decision');
  })();
});

check('single-WO sync refreshes one work order', () => {
  const db = freshDb();
  const uid = seedUser(db);
  connectDemo(db, uid);
  return (async () => {
    await syncForUser(db, uid);
    const woId = db.prepare("SELECT id FROM work_orders WHERE external_id='MX-RTR-900005'").get().id;
    const r = await syncSingleWorkOrder(db, uid, woId);
    eq(r.labor.direction, 'pull', 'single sync re-pulls labor');
    approx(hoursFor(db, 'MX-RTR-900005'), 210 / 60, 0.02, 'labor still 210m after single sync');
  })();
});

check('labor module: prefers logged over in-progress; clears when none', () => {
  const db = freshDb();
  const uid = seedUser(db);
  const r = db.prepare("INSERT INTO work_orders (external_id, source_system, work_type, status, assigned_user_id) VALUES ('MX-MNT-1','maintainx','maintenance','completed',?)").run(uid);
  const woId = Number(r.lastInsertRowid);

  const pull = reconcileLaborForWorkOrder(db, { workOrderId: woId, userId: uid, mxTime: { minutes: 60, source: 'logged', entryId: 'logged' } });
  eq(pull.direction, 'pull', 'pulls when no worker time');
  eq(db.prepare("SELECT COUNT(*) c FROM time_entries WHERE work_order_id=? AND source='maintainx_sync'").get(woId).c, 1, 'one synthetic entry');

  // Re-run with no MX time -> synthetic entry cleared.
  const none = reconcileLaborForWorkOrder(db, { workOrderId: woId, userId: uid, mxTime: { minutes: 0, source: null } });
  eq(none.direction, 'none', 'no direction when no time');
  eq(db.prepare("SELECT COUNT(*) c FROM time_entries WHERE work_order_id=? AND source='maintainx_sync'").get(woId).c, 0, 'synthetic entry removed');
});

// ---------------------------------------------------------------------------
(async () => {
  let failures = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (e) { failures++; console.error(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${failures ? '❌' : '✅'} ${checks.length - failures}/${checks.length} test groups passed · ${passed} assertions`);
  process.exit(failures ? 1 : 0);
})();

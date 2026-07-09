// test/maintainx-sync/run.js
//
// Service-layer tests for MaintainX WO pull + labor reconciliation.
// Covers all scenarios from the manual test plan:
//   S1 — MaintainX labor time overrides Bread time on completed WOs
//   S2 — MX wins regardless of which value is higher/lower
//   S3 — Multiple technicians on one WO (no duplication)
//   S4 — Repeat sync is idempotent
//   S5 — Automatic sync paths (single-WO on completion, org-key full sync)
//
// Runs against an in-memory SQLite DB using the real schema/migrations and
// the built-in stub MaintainX client. No network, no HTTP.
//
//   node --experimental-sqlite --no-warnings=ExperimentalWarning test/maintainx-sync/run.js

process.env.MX_TOKEN_ENC_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema } = require('../../db');
const { encrypt } = require('../../lib/maintainx/crypto');
const { mapWorkOrder, normalizeStatus } = require('../../lib/maintainx/map');
const { reconcileLaborForWorkOrder, sumWorkHours } = require('../../lib/maintainx/labor');
const {
  syncForUser, syncSingleWorkOrder,
  syncForUserWithOrgKey, syncSingleWorkOrderWithOrgKey,
} = require('../../lib/maintainx/sync');

let passed = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
function ok(cond, msg)   { assert.ok(cond, msg); passed++; }
function eq(a, b, msg)   { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); passed++; }
function approx(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, expected ~${b})`); passed++; }

// ── Helpers ─────────────────────────────────────────────────────────────────

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureSchema(db);
  return db;
}

function seedUser(db, { email = 'worker@example.com', role = 'technician' } = {}) {
  const r = db.prepare(
    "INSERT INTO users (name, email, role, worker_type, hourly_rate) VALUES (?,?,?,?,?)"
  ).run('Demo Worker', email, role, 'contractor', 40);
  return Number(r.lastInsertRowid);
}

function connectDemo(db, userId) {
  db.prepare(`
    INSERT INTO user_integrations
      (user_id, provider, mx_user_id, mx_org_id, access_token_enc, token_type, status)
    VALUES (?, 'maintainx', 'mxuser-1', '477835', ?, 'demo', 'active')
  `).run(userId, encrypt('stub-demo'));
}

// Org-key path: store global token + seed cached mx_user_id so email lookup is skipped.
function connectOrgKey(db, userId) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('maintainx_api_key', 'stub-org-key')").run();
  db.prepare(`
    INSERT INTO user_integrations
      (user_id, provider, mx_user_id, mx_org_id, access_token_enc, token_type, status)
    VALUES (?, 'maintainx', 'mxuser-stub', '477835', '', 'org_key', 'active')
    ON CONFLICT(user_id, provider) DO UPDATE SET mx_user_id = 'mxuser-stub'
  `).run(userId);
}

// Add a real app-sourced work time entry (simulates the worker clocking in Bread).
function addAppTime(db, userId, woId, hours, { invoiceId = null } = {}) {
  const cin  = new Date(Date.now() - hours * 3600000).toISOString();
  const cout = new Date().toISOString();
  db.prepare(
    "INSERT INTO time_entries (user_id, work_order_id, clock_in, clock_out, mode, source, invoice_id) VALUES (?,?,?,?,'work','app',?)"
  ).run(userId, woId, cin, cout, invoiceId);
}

const synthCount = (db, woId) =>
  db.prepare("SELECT COUNT(*) c FROM time_entries WHERE source='maintainx_sync' AND work_order_id=?").get(woId).c;

const synthHours = (db, woId) => {
  const t = db.prepare(
    "SELECT clock_in, clock_out FROM time_entries WHERE source='maintainx_sync' AND work_order_id=?"
  ).get(woId);
  if (!t) return 0;
  return (new Date(t.clock_out) - new Date(t.clock_in)) / 3600000;
};

const appEntryCount = (db, woId) =>
  db.prepare("SELECT COUNT(*) c FROM time_entries WHERE work_order_id=? AND (source IS NULL OR source='app')").get(woId).c;

const appHours = (db, woId) => {
  const rows = db.prepare(
    "SELECT clock_in, clock_out, break_minutes FROM time_entries WHERE work_order_id=? AND (source IS NULL OR source='app') AND (mode IS NULL OR mode='work')"
  ).all(woId);
  return sumWorkHours(rows);
};

const woByExtId = (db, extId) => db.prepare("SELECT id, status FROM work_orders WHERE external_id=?").get(extId);

const synthHoursByExtId = (db, extId) => {
  const wo = woByExtId(db, extId);
  return wo ? synthHours(db, wo.id) : 0;
};

const synthCountByExtId = (db, extId) => {
  const wo = woByExtId(db, extId);
  return wo ? synthCount(db, wo.id) : 0;
};

// ── Baseline: crypto + mapping ───────────────────────────────────────────────

check('crypto: round-trips and never leaks plaintext', () => {
  const blob = encrypt('super-secret-token');
  ok(blob.startsWith('v1:'), 'ciphertext is versioned');
  ok(!blob.includes('super-secret-token'), 'plaintext absent from ciphertext');
  const { decrypt } = require('../../lib/maintainx/crypto');
  eq(decrypt(blob), 'super-secret-token', 'decrypt restores plaintext');
});

check('map: status + work_type normalization', () => {
  eq(normalizeStatus('DONE'),        'completed',   'DONE → completed');
  eq(normalizeStatus('IN_PROGRESS'), 'in_progress', 'IN_PROGRESS → in_progress');
  eq(normalizeStatus('ON_HOLD'),     'in_progress', 'ON_HOLD → in_progress');
  const m = mapWorkOrder({ id: '42', title: 'Cart Swap - Carts #6 - #10',
                           description: 'Swap carts at Foo - 1 St, NJ', status: 'DONE' });
  eq(m.external_id, 'MX-RPR-42', 'swap → repair');
  eq(m.cart_count,  5,           'cart range 6-10 = 5');
  eq(m.status,      'completed', 'DONE → completed');
});

// ── S4 — Full sync + idempotency ────────────────────────────────────────────
// Stub fixtures: 900001(DONE,logged95m) 900002(DONE,inprog130m)
//                900003(IN_PROGRESS,inprog~45m) 900004(OPEN,notime) 900005(DONE,logged210m)

check('S4 — full sync: labor decisions correct, repeat sync is idempotent', () => {
  const db  = freshDb();
  const uid = seedUser(db);
  connectDemo(db, uid);

  return (async () => {
    const s1 = await syncForUser(db, uid);
    eq(s1.pulled,        5, 'pulled all 5 fixtures');
    eq(s1.created,       5, '5 new WOs on first run');
    // 3 completed WOs (900001/900002/900005) with time → mx_wins
    // 1 in-progress WO (900003) with time → pull (live estimate)
    // 1 open WO (900004) with no time → none
    eq(s1.laborMxWins,   3, '3 completed WOs: mx_wins');
    eq(s1.laborImported, 1, '1 in-progress WO: pull');
    eq(s1.laborNone,     1, '1 open WO with no time: none');
    eq(s1.laborAppWins,  0, 'no app_wins on first sync');

    const woCount = db.prepare("SELECT COUNT(*) c FROM work_orders").get().c;
    eq(woCount, 5, '5 work_orders in DB');

    const synthTotal = db.prepare("SELECT COUNT(*) c FROM time_entries WHERE source='maintainx_sync'").get().c;
    eq(synthTotal, 4, '4 synthetic entries: 3 completed + 1 in-progress');

    approx(synthHoursByExtId(db, 'MX-RPR-900001'), 95  / 60, 0.02, '900001: 95m logged');
    approx(synthHoursByExtId(db, 'MX-RPR-900002'), 130 / 60, 0.05, '900002: 130m in-progress');
    approx(synthHoursByExtId(db, 'MX-RTR-900005'), 210 / 60, 0.02, '900005: 210m logged');
    eq(synthCountByExtId(db, 'MX-DPL-900004'), 0, '900004: no time, no synthetic entry');

    // S4 — Repeat sync must be fully idempotent.
    const s2 = await syncForUser(db, uid);
    eq(s2.created, 0, 'second sync: no new WOs');
    eq(s2.updated, 5, 'second sync: 5 updated');
    const synthTotal2 = db.prepare("SELECT COUNT(*) c FROM time_entries WHERE source='maintainx_sync'").get().c;
    eq(synthTotal2, 4, 'still exactly 4 synthetic entries — no duplicates');
    approx(synthHoursByExtId(db, 'MX-RPR-900001'), 95  / 60, 0.02, '900001 unchanged after re-sync');
    approx(synthHoursByExtId(db, 'MX-RTR-900005'), 210 / 60, 0.02, '900005 unchanged after re-sync');
  })();
});

// ── S1 — MX overrides Bread on completed WO ─────────────────────────────────

check('S1 — completed WO: MaintainX labor overrides Bread app-entered time', () => {
  const db  = freshDb();
  const uid = seedUser(db);
  connectDemo(db, uid);

  return (async () => {
    await syncForUser(db, uid);

    // 900001 is DONE/completed with 95m in MX. Manually set Bread to 1.0 hr.
    const wo = woByExtId(db, 'MX-RPR-900001');
    db.prepare("DELETE FROM time_entries WHERE work_order_id=?").run(wo.id);
    addAppTime(db, uid, wo.id, 1.0);  // 1 hr in Bread

    // Re-sync: MX wins unconditionally.
    const s = await syncForUser(db, uid);

    ok(s.laborMxWins >= 1, 'summary: mx_wins counted');
    eq(synthCount(db, wo.id), 1, 'exactly one synthetic MX entry');
    approx(synthHours(db, wo.id), 95 / 60, 0.02, 'synthetic = MaintainX 95m, not Bread 60m');
    eq(appEntryCount(db, wo.id), 0, 'non-invoiced Bread app entry removed');
  })();
});

// ── S2 — MX wins regardless of relative value ────────────────────────────────

check('S2 — MX wins whether Bread is higher, lower, or manually edited', () => {
  const db  = freshDb();
  const uid = seedUser(db);
  connectDemo(db, uid);
  const mxMinutes = 95; // MX-RPR-900001 stub has 95m logged

  return (async () => {
    await syncForUser(db, uid);
    const wo = woByExtId(db, 'MX-RPR-900001');

    for (const [label, breadHours] of [
      ['Bread > MX (3 hr vs 95m)',        3.0],
      ['Bread < MX (0.5 hr vs 95m)',      0.5],
      ['Bread manually edited (4 hr)',    4.0],
    ]) {
      db.prepare("DELETE FROM time_entries WHERE work_order_id=?").run(wo.id);
      addAppTime(db, uid, wo.id, breadHours);

      await syncForUser(db, uid);

      eq(synthCount(db, wo.id), 1,
        `${label}: exactly one synthetic entry`);
      approx(synthHours(db, wo.id), mxMinutes / 60, 0.02,
        `${label}: MX value (${mxMinutes}m) used, not Bread ${breadHours * 60}m`);
      eq(appEntryCount(db, wo.id), 0,
        `${label}: Bread app entry removed`);
    }
  })();
});

// ── Non-completed WO still respects app_wins ─────────────────────────────────

check('non-completed WO: Bread app time still wins (app_wins preserved)', () => {
  const db  = freshDb();
  const uid = seedUser(db);
  connectDemo(db, uid);

  return (async () => {
    await syncForUser(db, uid);

    // 900003 is IN_PROGRESS — app time should win.
    const wo = woByExtId(db, 'MX-MNT-900003');
    eq(wo.status, 'in_progress', '900003 is in_progress in DB');

    db.prepare("DELETE FROM time_entries WHERE work_order_id=?").run(wo.id);
    addAppTime(db, uid, wo.id, 2.0);  // 2 hr logged in Bread

    const s = await syncForUser(db, uid);

    ok(s.laborAppWins >= 1, 'app_wins in summary');
    eq(synthCount(db, wo.id), 0, 'no MX synthetic entry — app wins on in_progress WO');
    approx(appHours(db, wo.id), 2.0, 0.01, 'Bread 2-hr entry preserved');
  })();
});

// ── S4 — Single-WO sync idempotency ─────────────────────────────────────────

check('S4 — single-WO sync is idempotent on a completed WO', () => {
  const db  = freshDb();
  const uid = seedUser(db);
  connectDemo(db, uid);

  return (async () => {
    await syncForUser(db, uid);
    const wo = woByExtId(db, 'MX-RTR-900005');

    const r1 = await syncSingleWorkOrder(db, uid, wo.id);
    eq(r1.labor.direction, 'mx_wins', 'first single sync: mx_wins');
    approx(synthHours(db, wo.id), 210 / 60, 0.02, 'labor 210m after first sync');

    const r2 = await syncSingleWorkOrder(db, uid, wo.id);
    eq(r2.labor.direction, 'mx_wins', 'second single sync: still mx_wins');
    eq(synthCount(db, wo.id), 1, 'still exactly 1 synthetic entry');
    approx(synthHours(db, wo.id), 210 / 60, 0.02, 'labor unchanged after repeat');
  })();
});

// ── S5 — Org-key sync path (no personal token) ───────────────────────────────

check('S5 — org-key syncForUserWithOrgKey: same decisions, no personal token needed', () => {
  const db  = freshDb();
  const uid = seedUser(db);
  connectOrgKey(db, uid);

  return (async () => {
    const s = await syncForUserWithOrgKey(db, uid);
    eq(s.pulled,        5, 'org-key path: 5 WOs pulled');
    eq(s.created,       5, 'org-key path: 5 WOs created');
    eq(s.laborMxWins,   3, 'org-key path: 3 completed WOs → mx_wins');
    eq(s.laborImported, 1, 'org-key path: 1 in-progress → pull');
    eq(s.laborNone,     1, 'org-key path: 1 no-time → none');

    const synthTotal = db.prepare("SELECT COUNT(*) c FROM time_entries WHERE source='maintainx_sync'").get().c;
    eq(synthTotal, 4, '4 synthetic entries via org-key path');
  })();
});

check('S5 — org-key single-WO sync (completion trigger path)', () => {
  const db  = freshDb();
  const uid = seedUser(db);
  connectOrgKey(db, uid);

  return (async () => {
    await syncForUserWithOrgKey(db, uid);
    const wo = woByExtId(db, 'MX-RPR-900001');

    const r = await syncSingleWorkOrderWithOrgKey(db, uid, wo.id);
    eq(r.labor.direction, 'mx_wins', 'org-key single sync: mx_wins on completed WO');
    approx(synthHours(db, wo.id), 95 / 60, 0.02, '95m from MX');
    eq(synthCount(db, wo.id), 1, 'exactly one synthetic entry');
  })();
});

// ── S3 — Multiple technicians, no duplication ────────────────────────────────

check('S3 — two techs sync same WOs: no work_order or time_entry duplication', () => {
  const db   = freshDb();
  const uid1 = seedUser(db, { email: 'tech1@example.com' });
  const uid2 = seedUser(db, { email: 'tech2@example.com' });
  connectDemo(db, uid1);
  connectDemo(db, uid2);

  return (async () => {
    const s1 = await syncForUser(db, uid1);
    const s2 = await syncForUser(db, uid2);

    ok(s1.pulled === 5, 'tech1 pulled 5 WOs');
    ok(s2.pulled === 5, 'tech2 pulled 5 WOs');

    // Work orders are deduplicated by external_id — same 5 rows regardless of user.
    const woCount = db.prepare("SELECT COUNT(*) c FROM work_orders").get().c;
    eq(woCount, 5, 'exactly 5 WOs — no duplicates across two user syncs');

    // Synthetic entries are per-WO, not per-user — still exactly 4.
    const synthTotal = db.prepare("SELECT COUNT(*) c FROM time_entries WHERE source='maintainx_sync'").get().c;
    eq(synthTotal, 4, '4 synthetic entries — no duplication across users');

    approx(synthHoursByExtId(db, 'MX-RPR-900001'), 95  / 60, 0.02, '900001 labor correct');
    approx(synthHoursByExtId(db, 'MX-RTR-900005'), 210 / 60, 0.02, '900005 labor correct');
  })();
});

// ── Labor module unit tests ──────────────────────────────────────────────────

check('labor module: full decision matrix (completed/in-progress/open)', () => {
  const db  = freshDb();
  const uid = seedUser(db);

  // Insert a completed WO directly.
  const r1  = db.prepare(
    "INSERT INTO work_orders (external_id, source_system, work_type, status, assigned_user_id) VALUES ('MX-MNT-C1','maintainx','maintenance','completed',?)"
  ).run(uid);
  const woC = Number(r1.lastInsertRowid);

  // completed + MX time → mx_wins.
  const res1 = reconcileLaborForWorkOrder(db, {
    workOrderId: woC, userId: uid, woStatus: 'completed', anchorDate: '2026-07-01',
    mxTime: { minutes: 120, source: 'logged', entryId: 'logged' },
  });
  eq(res1.direction, 'mx_wins', 'completed + MX time → mx_wins');
  eq(synthCount(db, woC), 1, 'one synthetic entry created');
  approx(synthHours(db, woC), 2.0, 0.01, '2h imported');

  // completed + no MX time → none (keep existing).
  const res2 = reconcileLaborForWorkOrder(db, {
    workOrderId: woC, userId: uid, woStatus: 'completed', anchorDate: '2026-07-01',
    mxTime: { minutes: 0, source: null },
  });
  eq(res2.direction, 'none', 'completed + no MX time → none');
  eq(res2.reason, 'completed_no_mx_time', 'correct reason');
  eq(synthCount(db, woC), 1, 'existing synthetic entry preserved');

  // Insert an in-progress WO.
  const r2  = db.prepare(
    "INSERT INTO work_orders (external_id, source_system, work_type, status, assigned_user_id) VALUES ('MX-MNT-IP1','maintainx','maintenance','in_progress',?)"
  ).run(uid);
  const woIP = Number(r2.lastInsertRowid);

  // in_progress + no app time → pull (live estimate).
  const res3 = reconcileLaborForWorkOrder(db, {
    workOrderId: woIP, userId: uid, woStatus: 'in_progress', anchorDate: '2026-07-01',
    mxTime: { minutes: 45, source: 'in_progress', entryId: null },
  });
  eq(res3.direction, 'pull', 'in_progress + no app time → pull');
  approx(synthHours(db, woIP), 0.75, 0.01, '45m estimate imported');

  // in_progress + app time → app_wins.
  addAppTime(db, uid, woIP, 1.0);
  const res4 = reconcileLaborForWorkOrder(db, {
    workOrderId: woIP, userId: uid, woStatus: 'in_progress', anchorDate: '2026-07-01',
    mxTime: { minutes: 45, source: 'in_progress', entryId: null },
  });
  eq(res4.direction, 'app_wins', 'in_progress + app time → app_wins');
  eq(synthCount(db, woIP), 0, 'synthetic removed when app wins');

  // completed WO: MX value update is written on re-sync.
  const res5 = reconcileLaborForWorkOrder(db, {
    workOrderId: woC, userId: uid, woStatus: 'completed', anchorDate: '2026-07-01',
    mxTime: { minutes: 180, source: 'logged', entryId: 'logged' },
  });
  eq(res5.direction, 'mx_wins', 'updated MX value → mx_wins');
  eq(res5.action, 'updated', 'existing synthetic updated, not duplicated');
  approx(synthHours(db, woC), 3.0, 0.01, 'synthetic updated to 3h');
  eq(synthCount(db, woC), 1, 'still exactly one synthetic entry');
});

check('labor module: mx_wins removes non-invoiced app entries; preserves invoiced ones', () => {
  const db  = freshDb();
  const uid = seedUser(db);
  const r   = db.prepare(
    "INSERT INTO work_orders (external_id, source_system, work_type, status, assigned_user_id) VALUES ('MX-MNT-INV1','maintainx','maintenance','completed',?)"
  ).run(uid);
  const woId = Number(r.lastInsertRowid);

  // Create a real invoice row so the FK constraint is satisfied.
  const invId = Number(db.prepare(
    "INSERT INTO invoices (user_id, invoice_number, period_start, period_end, status) VALUES (?,?,?,?,?)"
  ).run(uid, 'INV-TEST-999', '2026-01-01', '2026-01-07', 'submitted').lastInsertRowid);

  // One non-invoiced app entry + one invoiced app entry (simulates already-submitted invoice).
  addAppTime(db, uid, woId, 1.0, { invoiceId: null });
  addAppTime(db, uid, woId, 1.0, { invoiceId: invId });  // attached to a real invoice

  const res = reconcileLaborForWorkOrder(db, {
    workOrderId: woId, userId: uid, woStatus: 'completed', anchorDate: '2026-07-01',
    mxTime: { minutes: 90, source: 'logged', entryId: 'logged' },
  });

  eq(res.direction,          'mx_wins', 'mx_wins on completed WO');
  eq(res.removedAppEntries,  1,         'only non-invoiced app entry removed');
  eq(appEntryCount(db, woId),1,         'invoiced app entry preserved (invoice integrity)');
  eq(synthCount(db, woId),   1,         'MX synthetic entry written');
  approx(synthHours(db, woId), 1.5, 0.01, '90m MX entry written');
});

// ── S2/S3 — Multi-technician completed WO ───────────────────────────────────
// Tests scenarios 2 (per-tech attribution), 3 (tech changes), 4 (Bread manual
// edit overwritten), and 5 (idempotency) for the per-tech path.

const { extractMxTimePerTech } = require('../../lib/maintainx/client');
const { reconcilePerTechLaborCompleted } = require('../../lib/maintainx/labor');
const { processRawWorkOrder, resolveBreadUserFromMxUser } = require('../../lib/maintainx/sync');

// Helper: sum ALL synthetic minutes for a WO across all tech rows
const synthTotalMinutes = (db, woId) => {
  const rows = db.prepare(
    "SELECT clock_in, clock_out FROM time_entries WHERE source='maintainx_sync' AND work_order_id=?"
  ).all(woId);
  return rows.reduce((s, r) => s + (new Date(r.clock_out) - new Date(r.clock_in)) / 60000, 0);
};

// Helper: count synthetic entries for a given Bread user_id
const synthCountForUser = (db, woId, uid) =>
  db.prepare("SELECT COUNT(*) c FROM time_entries WHERE source='maintainx_sync' AND work_order_id=? AND user_id=?").get(woId, uid).c;

check('extractMxTimePerTech: returns per-tech entries when assignee present', () => {
  const raw = {
    timeEntries: [
      { id: 'te-a', minutes: 120, assignee: { id: 'mx-101', email: 'tech-a@example.com', fullName: 'Tech A' } },
      { id: 'te-b', minutes: 90,  assignee: { id: 'mx-102', email: 'tech-b@example.com', fullName: 'Tech B' } },
      { id: 'te-c', minutes: 180, assignee: { id: 'mx-103', email: 'tech-c@example.com', fullName: 'Tech C' } },
    ],
  };
  const entries = extractMxTimePerTech(raw);
  eq(entries.length, 3, '3 per-tech entries returned');
  const techA = entries.find(e => e.mxUserId === 'mx-101');
  eq(techA.minutes, 120, 'Tech A = 120m');
  eq(techA.email,   'tech-a@example.com', 'Tech A email preserved');
  const total = entries.reduce((s, e) => s + e.minutes, 0);
  eq(total, 390, 'total = 390m (2+1.5+3 hours)');
});

check('extractMxTimePerTech: falls back to aggregate when no assignee', () => {
  // Existing stub fixtures have timeEntries without assignee — must use aggregate path
  const raw = { timeEntries: [{ id: 'te-1', minutes: 95 }] };
  const entries = extractMxTimePerTech(raw);
  eq(entries.length, 1, 'one aggregate entry');
  ok(entries[0].mxUserId === null && entries[0].email === null, 'no identity → aggregate');
  eq(entries[0].minutes, 95, '95m preserved');
});

check('S2 — multi-tech completed WO: each tech gets own time_entries row', () => {
  const db   = freshDb();
  const uidA = seedUser(db, { email: 'tech-a@example.com' });
  const uidB = seedUser(db, { email: 'tech-b@example.com', role: 'technician' });
  const uidC = seedUser(db, { email: 'tech-c@example.com', role: 'technician' });

  // Insert WO as completed
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO work_orders (external_id, source_system, work_type, status, assigned_user_id) " +
    "VALUES ('MX-DPL-MT1','maintainx','deployment','completed',?)"
  ).run(uidA);
  const woId = Number(lastInsertRowid);

  // Seed Bread entries for all three techs that must be overwritten
  addAppTime(db, uidA, woId, 1.0);
  addAppTime(db, uidB, woId, 0.5);
  addAppTime(db, uidC, woId, 2.0);

  // per-tech entries from MX (A=120m, B=90m, C=180m)
  const perTechEntries = [
    { mxUserId: 'mx-101', email: 'tech-a@example.com', name: 'Tech A', minutes: 120, source: 'logged', entryId: 'te-a', breadUserId: uidA },
    { mxUserId: 'mx-102', email: 'tech-b@example.com', name: 'Tech B', minutes: 90,  source: 'logged', entryId: 'te-b', breadUserId: uidB },
    { mxUserId: 'mx-103', email: 'tech-c@example.com', name: 'Tech C', minutes: 180, source: 'logged', entryId: 'te-c', breadUserId: uidC },
  ];

  const result = reconcilePerTechLaborCompleted(db, {
    workOrderId: woId, ownerId: uidA, perTechEntries, anchorDate: '2026-07-01',
  });

  eq(result.direction,     'mx_wins', 'direction = mx_wins');
  eq(result.removedAppEntries, 3,     '3 non-invoiced app entries removed');
  eq(result.techResults.length, 3,    '3 tech results');
  eq(synthCount(db, woId), 3,         '3 synthetic time_entries rows (one per tech)');

  // Per-tech attribution
  eq(synthCountForUser(db, woId, uidA), 1, 'Tech A has 1 synthetic row');
  eq(synthCountForUser(db, woId, uidB), 1, 'Tech B has 1 synthetic row');
  eq(synthCountForUser(db, woId, uidC), 1, 'Tech C has 1 synthetic row');

  // Individual minutes (tolerance ±1m for rounding)
  const rowA = db.prepare("SELECT clock_in, clock_out FROM time_entries WHERE source='maintainx_sync' AND work_order_id=? AND user_id=?").get(woId, uidA);
  const rowB = db.prepare("SELECT clock_in, clock_out FROM time_entries WHERE source='maintainx_sync' AND work_order_id=? AND user_id=?").get(woId, uidB);
  const rowC = db.prepare("SELECT clock_in, clock_out FROM time_entries WHERE source='maintainx_sync' AND work_order_id=? AND user_id=?").get(woId, uidC);
  approx((new Date(rowA.clock_out) - new Date(rowA.clock_in)) / 60000, 120, 1, 'Tech A = 120m');
  approx((new Date(rowB.clock_out) - new Date(rowB.clock_in)) / 60000, 90,  1, 'Tech B = 90m');
  approx((new Date(rowC.clock_out) - new Date(rowC.clock_in)) / 60000, 180, 1, 'Tech C = 180m');

  // Total
  approx(synthTotalMinutes(db, woId), 390, 2, 'total MX labor = 390m (2+1.5+3 hrs)');
  eq(appEntryCount(db, woId), 0, 'all non-invoiced app entries removed');
});

check('S3 — tech removed before completion: stale entry cleaned up', () => {
  const db   = freshDb();
  const uidA = seedUser(db, { email: 'tech-a@example.com' });
  const uidB = seedUser(db, { email: 'tech-b@example.com', role: 'technician' });
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO work_orders (external_id, source_system, work_type, status, assigned_user_id) " +
    "VALUES ('MX-DPL-MT2','maintainx','deployment','completed',?)"
  ).run(uidA);
  const woId = Number(lastInsertRowid);

  // First sync: A=120m, B=90m (both are on the WO)
  reconcilePerTechLaborCompleted(db, {
    workOrderId: woId, ownerId: uidA, anchorDate: '2026-07-01',
    perTechEntries: [
      { mxUserId: 'mx-101', email: 'tech-a@example.com', minutes: 120, source: 'logged', entryId: 'te-a', breadUserId: uidA },
      { mxUserId: 'mx-102', email: 'tech-b@example.com', minutes: 90,  source: 'logged', entryId: 'te-b', breadUserId: uidB },
    ],
  });
  eq(synthCount(db, woId), 2, 'after first sync: 2 entries (A + B)');

  // Tech B removed before completion — second sync has only Tech A
  reconcilePerTechLaborCompleted(db, {
    workOrderId: woId, ownerId: uidA, anchorDate: '2026-07-01',
    perTechEntries: [
      { mxUserId: 'mx-101', email: 'tech-a@example.com', minutes: 120, source: 'logged', entryId: 'te-a', breadUserId: uidA },
    ],
  });
  eq(synthCount(db, woId), 1, 'after tech B removed: 1 entry (only A)');
  eq(synthCountForUser(db, woId, uidA), 1, 'Tech A entry retained');
  eq(synthCountForUser(db, woId, uidB), 0, 'Tech B stale entry cleaned up');
});

check('S4 — multi-tech idempotency: repeat sync produces identical rows', () => {
  const db   = freshDb();
  const uidA = seedUser(db, { email: 'tech-a@example.com' });
  const uidB = seedUser(db, { email: 'tech-b@example.com', role: 'technician' });
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO work_orders (external_id, source_system, work_type, status, assigned_user_id) " +
    "VALUES ('MX-DPL-MT3','maintainx','deployment','completed',?)"
  ).run(uidA);
  const woId = Number(lastInsertRowid);
  const entries = [
    { mxUserId: 'mx-101', email: 'tech-a@example.com', minutes: 120, source: 'logged', entryId: 'te-a', breadUserId: uidA },
    { mxUserId: 'mx-102', email: 'tech-b@example.com', minutes: 90,  source: 'logged', entryId: 'te-b', breadUserId: uidB },
  ];

  reconcilePerTechLaborCompleted(db, { workOrderId: woId, ownerId: uidA, perTechEntries: entries, anchorDate: '2026-07-01' });
  const snapshot1 = db.prepare("SELECT user_id, clock_in, clock_out FROM time_entries WHERE source='maintainx_sync' AND work_order_id=? ORDER BY user_id").all(woId);

  // Run again — must be fully idempotent
  reconcilePerTechLaborCompleted(db, { workOrderId: woId, ownerId: uidA, perTechEntries: entries, anchorDate: '2026-07-01' });
  const snapshot2 = db.prepare("SELECT user_id, clock_in, clock_out FROM time_entries WHERE source='maintainx_sync' AND work_order_id=? ORDER BY user_id").all(woId);

  eq(synthCount(db, woId), 2, 'still exactly 2 synthetic entries after repeat sync');
  eq(JSON.stringify(snapshot1), JSON.stringify(snapshot2), 'clock_in/clock_out identical on repeat sync');
});

check('S4 — Bread manual edit overwritten on next sync (multi-tech path)', () => {
  const db   = freshDb();
  const uidA = seedUser(db, { email: 'tech-a@example.com' });
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO work_orders (external_id, source_system, work_type, status, assigned_user_id) " +
    "VALUES ('MX-DPL-MT4','maintainx','deployment','completed',?)"
  ).run(uidA);
  const woId = Number(lastInsertRowid);
  const entries = [{ mxUserId: 'mx-101', email: 'tech-a@example.com', minutes: 120, source: 'logged', entryId: 'te-a', breadUserId: uidA }];

  reconcilePerTechLaborCompleted(db, { workOrderId: woId, ownerId: uidA, perTechEntries: entries, anchorDate: '2026-07-01' });
  approx(synthTotalMinutes(db, woId), 120, 1, 'first sync: 120m');

  // Simulate a Bread user manually adding an app entry after sync
  addAppTime(db, uidA, woId, 3.0);  // 3 hrs manual entry

  // Second sync must remove the manual entry and restore MX value
  reconcilePerTechLaborCompleted(db, { workOrderId: woId, ownerId: uidA, perTechEntries: entries, anchorDate: '2026-07-01' });
  eq(appEntryCount(db, woId), 0,  'manual Bread entry removed on re-sync');
  eq(synthCount(db, woId),    1,  'one synthetic entry');
  approx(synthTotalMinutes(db, woId), 120, 1, 'MX value restored (120m), not Bread 180m');
});

check('resolveBreadUserFromMxUser: looks up by email, then by cached mx_user_id', () => {
  const db  = freshDb();
  const uid = seedUser(db, { email: 'tech-a@example.com' });
  // Cache mx_user_id
  db.prepare(`
    INSERT INTO user_integrations
      (user_id, provider, mx_user_id, mx_org_id, access_token_enc, token_type, status)
    VALUES (?, 'maintainx', 'mx-999', '477835', '', 'org_key', 'active')
  `).run(uid);

  // By email
  eq(resolveBreadUserFromMxUser(db, { mxUserId: null, email: 'tech-a@example.com' }), uid, 'resolved by email');
  // By mx_user_id when email absent
  eq(resolveBreadUserFromMxUser(db, { mxUserId: 'mx-999', email: null }), uid, 'resolved by mx_user_id');
  // Unknown user
  ok(resolveBreadUserFromMxUser(db, { mxUserId: 'unknown', email: 'nope@x.com' }) === null, 'unknown returns null');
});

check('processRawWorkOrder: routes to per-tech path for completed WO with assignees', () => {
  const db   = freshDb();
  const uidA = seedUser(db, { email: 'tech-a@example.com' });
  const uidB = seedUser(db, { email: 'tech-b@example.com', role: 'technician' });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('maintainx_api_key', 'stub-org-key')").run();

  // Custom client that returns one multi-tech completed WO
  const { makeClient } = require('../../lib/maintainx/client');
  const customFactory = () => {
    const base = makeClient({ token: 'stub' });
    return {
      ...base,
      async getWorkOrder() {
        return {
          id: 'MT99', sequentialId: 9901, title: 'Multi-Tech Store Deploy', status: 'DONE',
          assignees: [{ id: 'mx-101', userId: 'mx-101', fullName: 'Tech A', email: 'tech-a@example.com' }],
          timeEntries: [
            { id: 'te-mt-a', minutes: 120, assignee: { id: 'mx-101', email: 'tech-a@example.com', fullName: 'Tech A' } },
            { id: 'te-mt-b', minutes: 90,  assignee: { id: 'mx-102', email: 'tech-b@example.com', fullName: 'Tech B' } },
          ],
        };
      },
    };
  };

  const client = customFactory();
  return (async () => {
  const rawWo = await client.getWorkOrder('MT99');
  const r = processRawWorkOrder(db, uidA, client, rawWo);

  eq(r.labor.direction, 'mx_wins', 'direction = mx_wins via per-tech path');
  eq(r.labor.reason, 'completed_wo_mx_authoritative_per_tech', 'per-tech reason');
  eq(synthCount(db, r.id), 2, '2 synthetic entries (one per tech)');
  approx(synthTotalMinutes(db, r.id), 210, 2, 'total = 210m (120+90)');
  eq(synthCountForUser(db, r.id, uidA), 1, 'Tech A has their own row');
  eq(synthCountForUser(db, r.id, uidB), 1, 'Tech B has their own row');
  })();
});

// ---------------------------------------------------------------------------
(async () => {
  let failures = 0;
  for (const { name, fn } of checks) {
    try   { await fn(); console.log(`  ✓ ${name}`); }
    catch (e) { failures++; console.error(`  ✗ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${failures ? '❌' : '✅'} ${checks.length - failures}/${checks.length} test groups passed · ${passed} assertions`);
  process.exit(failures ? 1 : 0);
})();

// test/break-workflow/http-smoke.js
//
// HTTP smoke test for the v0.82 live-tracked break / driving workflow:
//   • Break is a real PAUSE: POST /break/start stamps break_started_at (timer
//     frozen), POST /break/resume folds the MEASURED interval into break_minutes
//     and clears the pause. mode is preserved so the tech resumes work OR drive.
//   • A break > 60 min sets break_flagged = 1 (surfaced for review).
//   • Clocking out straight from a break finalizes that break first.
//   • Can't start a break twice, and can't switch modes while paused (409s).
//   • sumHours deducts an IN-PROGRESS break from live hours.
//
// Mounts the REAL routes/timeentries.js on an in-memory DB with stubbed auth,
// and backdates break_started_at / clock_in directly to exercise the long-break
// and billing math deterministically (no real waiting).
//
//   node --experimental-sqlite --no-warnings=ExperimentalWarning test/break-workflow/http-smoke.js

const assert  = require('node:assert');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema, sumHours } = require('../../db');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
ensureSchema(db);

const tech = Number(db.prepare(
  "INSERT INTO users (name, email, role, worker_type, hourly_rate) VALUES ('Terry Tech','terry@e.com','technician','contractor',40)"
).run().lastInsertRowid);

let woSeq = 0;
const addWO = () => {
  woSeq++;
  return Number(db.prepare(`
    INSERT INTO work_orders (external_id, source_system, work_type, store_name, cart_count, status)
    VALUES (?, 'maintainx', 'repair', 'Test Store', 4, 'open')
  `).run(`MX-TEST-${woSeq}`).lastInsertRowid);
};

const rowOf      = (id) => db.prepare("SELECT * FROM time_entries WHERE id = ?").get(id);
const minutesAgo = (m)  => new Date(Date.now() - m * 60000).toISOString();
const setCol     = (id, col, val) => db.prepare(`UPDATE time_entries SET ${col} = ? WHERE id = ?`).run(val, id);

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req, _res, next) => { if (req.headers['x-test-uid']) req.headers['x-user-id'] = req.headers['x-test-uid']; next(); });
app.use('/api', require('../../routes/timeentries')(db));

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, method = 'POST', body) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-uid': String(tech) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

  let pass = 0;
  const ok = (cond, label) => { assert.ok(cond, label); console.log(`  ✓ ${label}`); pass++; };

  try {
    // ── 1) Pause / resume basics ──────────────────────────────────────────
    console.log('\nPAUSE / RESUME — break is a real pause, mode preserved:');
    const wo1 = addWO();
    let r = await call('/api/timeentries', 'POST', { work_order_id: wo1, mode: 'work' });
    ok(r.status === 200, `clock in (work) -> 200 (got ${r.status} ${JSON.stringify(r.json)})`);
    const id1 = r.json.id;

    r = await call('/api/timeentries/active', 'GET');
    ok(r.json.length === 1 && !r.json[0].break_started_at, 'active entry present, not on break');

    r = await call(`/api/timeentries/${id1}/break/start`);
    ok(r.status === 200 && !!rowOf(id1).break_started_at, 'break/start -> paused (break_started_at set)');

    r = await call(`/api/timeentries/${id1}/break/start`);
    ok(r.status === 409, 'break/start again -> 409 (already on break)');

    r = await call(`/api/timeentries/${id1}/switch-mode`);
    ok(r.status === 409, 'switch-mode while paused -> 409');

    // Simulate a 20-minute break, then resume.
    setCol(id1, 'break_started_at', minutesAgo(20));
    r = await call(`/api/timeentries/${id1}/break/resume`);
    ok(r.status === 200, 'break/resume -> 200');
    let row = rowOf(id1);
    ok(row.break_started_at === null, 'break_started_at cleared on resume');
    ok(near(row.break_minutes, 20), `~20 min folded into break_minutes (got ${row.break_minutes})`);
    ok(row.break_flagged === 0, '20-min break is NOT flagged');

    // Switch now works again (guard lifted); clean up the opened drive timer.
    r = await call(`/api/timeentries/${id1}/switch-mode`);
    ok(r.status === 200 && r.json.opened.mode === 'drive', 'switch-mode after resume -> 200 (now drive)');
    await call(`/api/timeentries/${r.json.opened.id}`, 'PATCH', { gps: null });

    // ── 2) >60-min break is flagged ───────────────────────────────────────
    console.log('\nEXTENDED BREAK — over 60 min sets break_flagged:');
    const wo2 = addWO();
    r = await call('/api/timeentries', 'POST', { work_order_id: wo2, mode: 'work' });
    const id2 = r.json.id;
    await call(`/api/timeentries/${id2}/break/start`);
    setCol(id2, 'break_started_at', minutesAgo(65));
    r = await call(`/api/timeentries/${id2}/break/resume`);
    ok(r.status === 200 && r.json.break_flagged === 1, '65-min break -> break_flagged = 1');
    ok(near(rowOf(id2).break_minutes, 65), `~65 min folded in (got ${rowOf(id2).break_minutes})`);

    // ── 3) Clock out straight from a break finalizes it ──────────────────
    console.log('\nCLOCK OUT FROM BREAK — finalizes the break, bills correctly:');
    const wo3 = addWO();
    r = await call('/api/timeentries', 'POST', { work_order_id: wo3, mode: 'drive' });
    const id3 = r.json.id;
    setCol(id3, 'clock_in', minutesAgo(40));   // 40 min on the clock…
    await call(`/api/timeentries/${id3}/break/start`);
    setCol(id3, 'break_started_at', minutesAgo(10)); // …currently 10 min into a break
    r = await call(`/api/timeentries/${id3}`, 'PATCH', { gps: null });
    ok(r.status === 200, 'clock out from break -> 200');
    row = rowOf(id3);
    ok(!!row.clock_out, 'entry is clocked out');
    ok(row.break_started_at === null, 'break_started_at cleared on clock-out');
    ok(near(row.break_minutes, 10), `~10 min break finalized (got ${row.break_minutes})`);
    ok(near(sumHours([row]) * 60, 30, 2), `billable ~30 min (40 − 10 break) (got ${(sumHours([row]) * 60).toFixed(1)} min)`);

    // ── 4) In-progress break is deducted from live hours ─────────────────
    console.log('\nLIVE HOURS — sumHours subtracts an in-progress break:');
    const wo4 = addWO();
    r = await call('/api/timeentries', 'POST', { work_order_id: wo4, mode: 'work' });
    const id4 = r.json.id;
    setCol(id4, 'clock_in', minutesAgo(60));
    await call(`/api/timeentries/${id4}/break/start`);
    setCol(id4, 'break_started_at', minutesAgo(15));
    r = await call(`/api/timeentries/${id4}`, 'GET');
    ok(r.status === 200 && !r.json.clock_out, 'entry still running (on break)');
    ok(near(r.json.hours * 60, 45, 2), `live hours ~45 min (60 − 15 in-progress break) (got ${(r.json.hours * 60).toFixed(1)} min)`);

    console.log(`\n✅ break-workflow smoke: ${pass} checks passed\n`);
  } catch (e) {
    console.error('\n❌ break-workflow smoke FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();

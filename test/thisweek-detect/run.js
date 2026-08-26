// test/thisweek-detect/run.js
//
// Regression test for the technician "This week" current-week invoice detection
// bug (fixed v0.95): the THIS WEEK card built its match key with an inline
// `toISOString().slice(0,10)` week-start that derived the Monday from LOCAL
// calendar fields but serialized in UTC. West of UTC, every evening it rolled a
// day forward, so `period_start === thisWeekStart` failed and the tab showed
// "No invoice for this week yet" next to the real invoice in ALL INVOICES.
//
// The fix routes the card through the canonical local-Monday helper
// `weekStartISO()` (public/app.js, v0.87). This test:
//   (1) loads the REAL `weekStartISO`/`localDateISO`/`pad2` source out of
//       public/app.js and the REAL `weekBounds` out of db.js, evaluates them in a
//       vm with the clock pinned to specific instants, and asserts the client
//       detection key equals the server-stored period_start basis across a
//       day x hour matrix — including the reported Tue-evening Pacific case;
//   (2) reproduces the old inline formula and shows it diverged in the evening
//       (guard: intent is captured if anyone reintroduces it);
//   (3) asserts the call site in public/app.js is actually wired to weekStartISO().
//
// Pure logic, no DOM / no network (mirrors test/nav/run.js).
//   npm run test:thisweek     (or: TZ=America/Los_Angeles node test/thisweek-detect/run.js)

'use strict';

// The bug is timezone-dependent, so pin the zone deterministically regardless of
// how the test is invoked. TZ can only be honored at process start, so re-exec.
if (process.env.TZ !== 'America/Los_Angeles') {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [__filename], {
    stdio: 'inherit',
    env: { ...process.env, TZ: 'America/Los_Angeles' },
  });
  process.exit(r.status == null ? 1 : r.status);
}

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..', '..');
const APP_JS = path.join(REPO, 'public', 'app.js');
const DB_JS = path.join(REPO, 'db.js');

const appSrc = fs.readFileSync(APP_JS, 'utf8');
const dbSrc = fs.readFileSync(DB_JS, 'utf8');

let pass = 0;
const ok = (cond, label) => { assert.ok(cond, label); console.log(`  ✓ ${label}`); pass++; };
const eq = (a, b, label) => { assert.strictEqual(a, b, `${label} (got ${a}, expected ${b})`); console.log(`  ✓ ${label}`); pass++; };

// Pull a top-level `function <name>(...) { ... }` block out of source. These
// helpers are declared at module scope with their closing brace in column 0.
function extractFn(src, name, where) {
  const re = new RegExp(`^function ${name}\\b[\\s\\S]*?^}`, 'm');
  const m = src.match(re);
  assert.ok(m, `could not locate function ${name}() in ${where} — did it get renamed/moved?`);
  return m[0];
}

const pad2Src = (() => {
  // pad2 may be `function pad2` or a const arrow; fall back to a faithful shim.
  const fn = appSrc.match(/^function pad2\b[\s\S]*?^}/m);
  if (fn) return fn[0];
  const arrow = appSrc.match(/const pad2\s*=\s*[^\n;]+;/);
  if (arrow) return arrow[0];
  return `function pad2(n){return String(n).padStart(2,'0');}`;
})();
const localDateISOSrc = extractFn(appSrc, 'localDateISO', 'public/app.js');
const weekStartISOSrc = extractFn(appSrc, 'weekStartISO', 'public/app.js');
const weekBoundsSrc = extractFn(dbSrc, 'weekBounds', 'db.js');

// Build a sandbox whose clock is pinned to `fixedISO`, then evaluate the real
// helper sources inside it. `new Date()` with no args returns the pinned instant;
// every other Date behavior is real, so local getters honor TZ=America/Los_Angeles.
function at(fixedISO) {
  const FIXED = new Date(fixedISO).getTime();
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); }
    static now() { return FIXED; }
  }
  const ctx = { Date: FakeDate, console };
  vm.createContext(ctx);
  vm.runInContext(
    `${pad2Src}\n${localDateISOSrc}\n${weekStartISOSrc}\n${weekBoundsSrc}`,
    ctx,
    { filename: 'extracted-helpers.js' }
  );
  // The OLD, buggy inline formula the fix removed (kept here only as a guard).
  const d = new ctx.Date();
  d.setDate(d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1));
  const inlineOld = d.toISOString().slice(0, 10);
  return {
    clientKey: ctx.weekStartISO(),          // what THIS WEEK now matches on
    serverStart: ctx.weekBounds().start,    // how period_start is stored (db.js)
    inlineOld,                              // the removed, buggy value
    ptLabel: new RealDate(FIXED).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'short', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }),
  };
}

console.log('THIS WEEK current-week invoice detection (v0.95)\n');

// The reported week: invoice INV-2026-0830-U32 covers Mon 24 Aug -> Sun 30 Aug,
// so period_start is stored as "2026-08-24". Every instant below sits in that week.
const MONDAY = '2026-08-24';
const MATRIX = [
  { iso: '2026-08-25T15:00:00Z', evening: false }, // Tue 08:00 PT
  { iso: '2026-08-25T22:00:00Z', evening: false }, // Tue 15:00 PT
  { iso: '2026-08-26T02:30:00Z', evening: true  }, // Tue 19:30 PT  <-- reported
  { iso: '2026-08-26T04:00:00Z', evening: true  }, // Tue 21:00 PT
  { iso: '2026-08-27T05:00:00Z', evening: true  }, // Wed 22:00 PT
  { iso: '2026-08-30T03:00:00Z', evening: true  }, // Sat 20:00 PT
];

console.log('1. Client detection key matches the stored period_start basis, at every hour');
for (const { iso } of MATRIX) {
  const r = at(iso);
  eq(r.clientKey, MONDAY, `weekStartISO() = ${MONDAY} @ ${r.ptLabel}`);
  eq(r.clientKey, r.serverStart, `client key === server weekBounds().start @ ${r.ptLabel}`);
}

console.log('\n2. Regression guard: the removed inline toISOString() formula DID day-shift in the evening');
for (const { iso, evening } of MATRIX) {
  const r = at(iso);
  if (evening) {
    ok(r.inlineOld !== MONDAY, `old inline miss reproduced (${r.inlineOld} != ${MONDAY}) @ ${r.ptLabel}`);
  } else {
    eq(r.inlineOld, MONDAY, `old inline happened to be correct in the morning @ ${r.ptLabel}`);
  }
}

console.log('\n3. The THIS WEEK card is wired to the canonical helper (fix is present)');
ok(/const\s+thisWeekStart\s*=\s*weekStartISO\(\)\s*;/.test(appSrc),
   'public/app.js: `const thisWeekStart = weekStartISO();`');
ok(!/const\s+thisWeekStart\s*=\s*\(\(\)\s*=>\s*\{[\s\S]*?toISOString\(\)\.slice\(0,\s*10\)/.test(appSrc),
   'public/app.js: the old inline toISOString() thisWeekStart IIFE is gone');

console.log(`\nAll ${pass} assertions passed.`);

// test/local-date-consistency/run.js
//
// Regression test for the v0.96 "client local-date consistency" sweep. Several
// spots in public/app.js rendered a YYYY-MM-DD via `X.toISOString().slice(0,10)`.
// For a Date built from LOCAL fields (new Date(); setDate(...)) that returns the
// UTC date, which is a day ahead every evening west of UTC. The sweep routes them
// through the local helpers localDateISO()/todayISO(), and — where a date-only
// string was parsed — through parseDisplayDate() (which parses as LOCAL) so the
// former UTC round-trip stays correct.
//
// This test loads the REAL helpers out of public/app.js and proves they are
// timezone-local, demonstrates the exact round-trip subtlety, and asserts the
// sweep is applied at each call site while the intentional UTC timestamps
// (clock in/out sent to the server) are preserved.
//
// Pure logic, no DOM / no network (mirrors test/nav/run.js and test/thisweek-detect).
//   npm run test:localdate   (or: TZ=America/Los_Angeles node test/local-date-consistency/run.js)

'use strict';

// The behavior is timezone-dependent; pin the zone deterministically.
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

const APP_JS = path.join(__dirname, '..', '..', 'public', 'app.js');
const appSrc = fs.readFileSync(APP_JS, 'utf8');

let pass = 0;
const ok = (cond, label) => { assert.ok(cond, label); console.log(`  ✓ ${label}`); pass++; };
const eq = (a, b, label) => { assert.strictEqual(a, b, `${label} (got ${a}, expected ${b})`); console.log(`  ✓ ${label}`); pass++; };

function extractFn(name) {
  const re = new RegExp(`^(?:async )?function ${name}\\b[\\s\\S]*?^}`, 'm');
  const m = appSrc.match(re);
  assert.ok(m, `could not locate function ${name}() in public/app.js`);
  return m[0];
}
const pad2Src = appSrc.match(/^function pad2\b[\s\S]*?^}/m)[0];
const localDateISOSrc = extractFn('localDateISO');
const parseDisplayDateSrc = extractFn('parseDisplayDate');

const ctx = { Date, console };
vm.createContext(ctx);
vm.runInContext(`${pad2Src}\n${localDateISOSrc}\n${parseDisplayDateSrc}`, ctx);
const { localDateISO, parseDisplayDate } = ctx;

console.log('client local-date consistency (v0.96)\n');

// An evening instant west of UTC: Tue 2026-08-25 21:00 PT = 2026-08-26T04:00:00Z.
const EVENING = '2026-08-26T04:00:00Z';

console.log('1. localDateISO() is LOCAL (evening-West safe), unlike toISOString().slice');
{
  const d = new Date(EVENING);
  eq(localDateISO(d), '2026-08-25', 'localDateISO(evening) = local Tue 2026-08-25');
  eq(d.toISOString().slice(0, 10), '2026-08-26', '...whereas old toISOString().slice = UTC 2026-08-26 (the bug)');
}

console.log('\n2. A swept "last week" default (new Date(); setDate(-7)) lands on the right local day');
{
  const d = new Date(EVENING);
  d.setDate(d.getDate() - 7);
  eq(localDateISO(d), '2026-08-18', 'localDateISO(lastWeek) = 2026-08-18');
  eq(d.toISOString().slice(0, 10), '2026-08-19', '...old toISOString().slice would be 2026-08-19');
}

console.log('\n3. Date-only strings must be parsed LOCAL (parseDisplayDate), not new Date(str)');
{
  // Proves why enumerateWeekDays / week-option builder needed BOTH parse and format changed.
  eq(localDateISO(parseDisplayDate('2026-08-24')), '2026-08-24', 'parseDisplayDate round-trips local → 2026-08-24');
  eq(localDateISO(new Date('2026-08-24')), '2026-08-23', '...new Date("YYYY-MM-DD") is UTC-midnight → localDateISO = 2026-08-23 (the trap avoided)');
}

console.log('\n4. The sweep is applied at every call site');
const present = [
  ['enumerateWeekDays: parse local', /const d = parseDisplayDate\(start\), e = parseDisplayDate\(end\);/],
  ['enumerateWeekDays: format local', /out\.push\(localDateISO\(d\)\);/],
  ['tech upload week input', /id="tuWeek"[^>]*value="\$\{localDateISO\(lastWeekDate\)\}" max="\$\{todayISO\(\)\}"/],
  ['manager upload week input', /id="upWeek"[^>]*value="\$\{localDateISO\(lastWeekDate\)\}" max="\$\{todayISO\(\)\}"/],
  ['launch-actuals default week end', /const defaultWeekEnd = localDateISO\(lastSun\);/],
  ['launch-actuals week options', /const d = parseDisplayDate\(defaultWeekEnd\);[\s\S]*?weekOptions\.push\(localDateISO\(d\)\);/],
  ['custom-period defaults', /const defStart = localDateISO\(firstOfPrev\);[\s\S]*?const defEnd\s*=\s*localDateISO\(lastOfPrev\);[\s\S]*?const todayIso = localDateISO\(today\);/],
  ['past-invoice defaults', /const defaultDate = localDateISO\(lastWeekMon\);[\s\S]*?const today = todayISO\(\);/],
];
for (const [label, re] of present) ok(re.test(appSrc), `applied: ${label}`);

console.log('\n5. No buggy client date-string pattern remains (except the thisweek inline, fixed on its own branch)');
{
  const matches = appSrc.match(/\.toISOString\(\)\.slice\(0, ?10\)/g) || [];
  ok(matches.length <= 1, `at most one .toISOString().slice(0,10) code occurrence remains (found ${matches.length} — the renderMine thisWeekStart inline, fixed in v0.95)`);
}

console.log('\n6. Intentional UTC timestamps (clock in/out sent to the server) are preserved');
ok(/clock_in:\s*new Date\(`\$\{d\}T\$\{s\}:00`\)\.toISOString\(\)/.test(appSrc),
   'clock_in still sends a full UTC .toISOString() instant (not converted)');
ok(/clock_out:\s*ci\.toISOString\(\)|clockOut = endDt\.toISOString\(\)/.test(appSrc),
   'clock_out still sends a full UTC .toISOString() instant (not converted)');

console.log(`\nAll ${pass} assertions passed.`);

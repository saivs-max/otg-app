// test/nav/run.js
//
// Unit tests for the v0.90 navigation-stack reducer (public/nav.js) that fixes
// the Back (‹) button landing on the wrong page across all sections.
// Pure logic, no DOM / no network:
//
//   node test/nav/run.js
//
// Scenario coverage mirrors the manual matrix in PRD §4.11 / §6:
//   - drilling into a detail from each manager listing and pressing Back returns
//     to THAT listing (never the technician Home / My Invoices);
//   - work-order detail returns to its origin (Tracker / History / Home);
//   - top-level tabs reset the stack (no Back between peer tabs);
//   - in-place re-renders (edits) preserve the origin;
//   - post-action navigation to a listing collapses cleanly;
//   - a preserved parent keeps its recorded scroll position.

const assert = require('node:assert');
const { navReduce, navBack, sameEntry } = require('../../public/nav');

let passed = 0;
function eq(a, b, msg) {
  assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
  passed++;
}
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

// Helper: build the stack by replaying a sequence of goto()s.
// steps: [view, arg, isRoot]
function build(steps) {
  let stack = [];
  let last;
  for (const [view, arg, isRoot] of steps) {
    last = navReduce(stack, view, arg, !!isRoot);
    stack = last.stack;
  }
  return { stack, action: last ? last.action : null };
}
const top = s => s[s.length - 1];
const ROOT = true;

// ── 1. Root / init ────────────────────────────────────────────────────────────
{
  const r = navReduce([], 'dashboard', null, ROOT);
  eq(r.action, 'init', 'first root nav is init');
  eq(r.stack.length, 1, 'init stack has one entry');
  eq(r.stack[0].view, 'dashboard', 'landed on dashboard');
}
{
  // Switching tabs resets the stack (no Back between peer tabs).
  const { stack, action } = build([['dashboard', null, ROOT], ['tracker', null, ROOT]]);
  eq(action, 'root', 'tab switch is a root reset');
  eq(stack.length, 1, 'root reset collapses to one entry');
  eq(top(stack).view, 'tracker', 'top is the new tab');
}
{
  // Re-navigating to the same root (e.g. dashboard filter change) replaces in place.
  const { stack, action } = build([['dashboard', null, ROOT], ['dashboard', null, ROOT]]);
  eq(action, 'replace', 'same-root re-nav replaces');
  eq(stack.length, 1, 'still one entry');
}

// ── 2. Drill-in from every manager listing returns to THAT listing ─────────────
// This is the core bug: invoice detail used to always go back to "mine".
for (const origin of ['queue', 'allInv', 'tracker', 'thirdparty', 'dashboard']) {
  const { stack } = build([[origin, null, ROOT], ['invDetail', 7, false]]);
  eq(stack.length, 2, `${origin}→invDetail pushes`);
  eq(top(stack).view, 'invDetail', `${origin}: on invoice detail`);
  const back = navBack(stack);
  ok(back.changed, `${origin}: Back is available from invoice detail`);
  eq(back.entry.view, origin, `${origin}: Back returns to ${origin}, not a technician screen`);
  ok(back.entry.view !== 'mine' && back.entry.view !== 'home', `${origin}: never lands on mine/home`);
}

// ── 3. Work-order detail returns to its origin (was hard-coded to home) ─────────
{
  const { stack } = build([['tracker', null, ROOT], ['woDetail', 12, false]]);
  eq(navBack(stack).entry.view, 'tracker', 'woDetail from Tracker → back to Tracker');
}
{
  const { stack } = build([['woHistory', null, ROOT], ['woDetail', 12, false]]);
  eq(navBack(stack).entry.view, 'woHistory', 'woDetail from History → back to History');
}
{
  const { stack } = build([['home', null, ROOT], ['woDetail', 12, false]]);
  eq(navBack(stack).entry.view, 'home', 'woDetail from Home → back to Home');
}

// ── 4. In-place re-render (invoice edit) preserves the origin ───────────────────
{
  let { stack } = build([['queue', null, ROOT], ['invDetail', 5, false]]);
  const r = navReduce(stack, 'invDetail', 5, false); // edit re-render: same view+arg
  eq(r.action, 'replace', 'same view+arg re-render replaces (no dup push)');
  eq(r.stack.length, 2, 'stack depth unchanged by re-render');
  eq(navBack(r.stack).entry.view, 'queue', 'origin (queue) survives the re-render');
}
{
  // A different invoice id is a genuine push, not a replace.
  let { stack } = build([['queue', null, ROOT], ['invDetail', 5, false]]);
  const r = navReduce(stack, 'invDetail', 6, false);
  eq(r.action, 'push', 'different arg pushes');
}

// ── 5. Post-action navigation to a listing collapses cleanly ───────────────────
{
  // Queue → invoice detail → approve → goto('queue') (a root): back at the listing.
  const { stack, action } = build([
    ['queue', null, ROOT], ['invDetail', 5, false], ['queue', null, ROOT],
  ]);
  eq(action, 'root', 'post-action goto(listing) is a root reset');
  eq(stack.length, 1, 'no Back after returning to the listing');
  eq(top(stack).view, 'queue', 'back on the queue listing');
}

// ── 6. Parent pop for nested non-root drill-ins (woPick → woAdd → back) ─────────
{
  const { stack, action } = build([
    ['home', null, ROOT], ['woPick', null, false], ['woAdd', null, false], ['woPick', null, false],
  ]);
  eq(action, 'pop', 'navigating to the entry beneath the top pops (no dup)');
  eq(stack.length, 2, 'collapsed woAdd, back on woPick');
  eq(top(stack).view, 'woPick', 'top is woPick');
  eq(navBack(stack).entry.view, 'home', 'and Back from woPick → home');
}

// ── 7. navBack at the root is a no-op ──────────────────────────────────────────
{
  const { stack } = build([['dashboard', null, ROOT]]);
  const b = navBack(stack);
  eq(b.changed, false, 'no Back at a root screen');
  eq(b.stack.length, 1, 'stack unchanged');
}

// ── 8. Preserved parent keeps its recorded scroll position ─────────────────────
{
  let { stack } = build([['tracker', null, ROOT]]);
  stack[0].scrollY = 640;                                  // app records this on goto()
  const r = navReduce(stack, 'invDetail', 9, false);       // drill in
  eq(r.stack[0].scrollY, 640, 'parent scrollY carried into the new stack (shared ref)');
  eq(navBack(r.stack).entry.scrollY, 640, 'Back exposes the saved scrollY to restore');
}

// ── 9. sameEntry arg normalization (null vs undefined) ─────────────────────────
{
  ok(sameEntry({ view: 'queue', arg: null }, 'queue', undefined), 'null and undefined args match');
  ok(!sameEntry({ view: 'queue', arg: 5 }, 'queue', 6), 'different args do not match');
  ok(!sameEntry({ view: 'queue', arg: null }, 'mine', null), 'different views do not match');
}

// ── 10. Input is never mutated ─────────────────────────────────────────────────
{
  const input = [{ view: 'queue', arg: null }];
  const snapshot = JSON.stringify(input);
  navReduce(input, 'invDetail', 5, false);
  eq(JSON.stringify(input), snapshot, 'navReduce does not mutate the input array');
  navBack(input);
  eq(JSON.stringify(input), snapshot, 'navBack does not mutate the input array');
}

console.log(`\n✅ nav reducer: ${passed} assertions passed`);

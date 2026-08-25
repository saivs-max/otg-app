// nav.js — v0.90 pure navigation-stack reducer.
//
// The SPA had no navigation history: the header Back (‹) picked a destination
// from the *current* view (invoice detail → always "My Invoices", everything
// else → technician Home), so managers who drilled into a detail from Queue,
// Tracker, 3rd Party, Dashboard, etc. and pressed Back landed on an unrelated
// technician screen. This module is the single source of truth for how the
// in-session navigation stack changes on each goto(); app.js owns rendering and
// the History API. Kept dependency-free (no DOM) so it is unit-testable in node.
//
// Stack entries are { view, arg, scrollY? }. Semantics of navReduce:
//   root     — a bottom-tab / top-level destination: reset the stack to a single
//              entry so Back never appears *between* peer tabs.
//   replace  — the current screen re-rendered in place (same view+arg as top,
//              e.g. an invoice-detail edit that re-calls goto('invDetail', id));
//              the origin beneath it is preserved.
//   pop      — navigating to the entry directly beneath the top (returning to a
//              parent); collapses instead of duplicating.
//   push     — a genuine forward drill-in.
(function (root) {
  'use strict';

  function norm(arg) { return arg == null ? null : arg; }

  function sameEntry(e, view, arg) {
    return !!e && e.view === view && norm(e.arg) === norm(arg);
  }

  // Decide the stack mutation for goto(view, arg). `isRoot` marks top-level
  // (bottom-tab) destinations. Returns { stack, action } and never mutates the
  // input array (entries are shared by reference so a preserved parent keeps its
  // recorded scrollY).
  function navReduce(stack, view, arg, isRoot) {
    arg = norm(arg);
    const s = Array.isArray(stack) ? stack.slice() : [];

    if (isRoot) {
      if (s.length === 1 && sameEntry(s[0], view, arg)) {
        s[0] = { view, arg };
        return { stack: s, action: 'replace' };
      }
      return { stack: [{ view, arg }], action: s.length ? 'root' : 'init' };
    }

    if (s.length === 0) { s.push({ view, arg }); return { stack: s, action: 'init' }; }

    const top = s[s.length - 1];
    if (sameEntry(top, view, arg)) {
      s[s.length - 1] = { view, arg };
      return { stack: s, action: 'replace' };
    }
    if (s.length >= 2 && sameEntry(s[s.length - 2], view, arg)) {
      s.pop();
      return { stack: s, action: 'pop' };
    }
    s.push({ view, arg });
    return { stack: s, action: 'push' };
  }

  // Pop one level for a Back action. Returns { stack, entry, changed }.
  // At the root (length ≤ 1) nothing changes — Back is a no-op there.
  function navBack(stack) {
    const s = Array.isArray(stack) ? stack.slice() : [];
    if (s.length <= 1) return { stack: s, entry: s[0] || null, changed: false };
    s.pop();
    return { stack: s, entry: s[s.length - 1], changed: true };
  }

  const api = { navReduce, navBack, sameEntry };
  root.NAV = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

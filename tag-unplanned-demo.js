// tag-unplanned-demo.js — v0.64.2
//
// Demo augmentation: layers a realistic spread of "unplanned / wasted-labour"
// tags on top of the rich seed-demo dataset so the Dashboard → Unplanned view
// is fully populated for screenshots. Tags are spread across different weeks,
// stores, work types, and categories so every panel (KPIs, by-reason,
// by-work-type, by-store, weekly trend) shows meaningful data.
//
// Usage:
//   npm run seed:unplanned        # runs seed:demo then this script
//   npm start                     # sign in as maitland / password123
//
// Tags are reporting-only metadata — they never appear on the AP invoice/PDF.

const { open, ensureSchema } = require('./db');
const db = open();
ensureSchema(db);

const mgr = db.prepare("SELECT id FROM users WHERE role='ops_manager' ORDER BY id LIMIT 1").get()
         || db.prepare("SELECT id FROM users WHERE role IN ('sr_manager','pm') ORDER BY id LIMIT 1").get();
const mgrId = mgr ? mgr.id : 1;
const taggedAt = (daysAgo) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); return d.toISOString(); };

// Mix of single- and multi-tag reasons so the "by reason" fan-out is visible.
const TAGSETS = [
  ['wasted_labour'],
  ['ad_hoc'],
  ['unexpected'],
  ['wasted_labour', 'ad_hoc'],
  ['ad_hoc', 'unexpected'],
  ['wasted_labour'],
];
const NOTES = {
  wasted_labour: 'Rework / preventable re-visit',
  ad_hoc:        'Reactive, unscheduled work',
  unexpected:    'Unforeseen circumstance on site',
};
const noteFor = (tags) => tags.map(t => NOTES[t]).join(' · ');

function setTag(table, id, tags, daysAgo) {
  db.prepare(`UPDATE ${table} SET unplanned_tag = ?, unplanned_note = ?,
              unplanned_tagged_by = ?, unplanned_tagged_at = ? WHERE id = ?`)
    .run(JSON.stringify(tags), noteFor(tags), mgrId, taggedAt(daysAgo), id);
}

// Pick `count` items evenly across an ordered list so they span the timeline.
function spreadPick(rows, count) {
  if (rows.length <= count) return rows;
  const step = rows.length / count;
  const out = [];
  for (let i = 0; i < count; i++) out.push(rows[Math.floor(i * step)]);
  return out;
}

// 1) Labor (time entries) — the biggest unplanned cost driver.
const tes = db.prepare(`
  SELECT te.id FROM time_entries te JOIN work_orders wo ON wo.id = te.work_order_id
  WHERE te.clock_out IS NOT NULL AND (te.mode IS NULL OR te.mode = 'work')
  ORDER BY te.clock_in`).all();
spreadPick(tes, 14).forEach((r, i) => setTag('time_entries', r.id, TAGSETS[i % TAGSETS.length], (i % 10) + 2));

// 2) Tech expenses (skip the labor/drive pseudo-expenses so cost stays clean).
const exps = db.prepare("SELECT id FROM expenses WHERE category NOT IN ('labor','drive') ORDER BY expense_date").all();
spreadPick(exps, 12).forEach((r, i) => setTag('expenses', r.id, TAGSETS[(i + 1) % TAGSETS.length], (i % 9) + 1));

// 3) Corp-card charges.
const ccs = db.prepare("SELECT id FROM corp_card_expenses ORDER BY expense_date").all();
spreadPick(ccs, 8).forEach((r, i) => setTag('corp_card_expenses', r.id, TAGSETS[(i + 2) % TAGSETS.length], (i % 8) + 1));

// 4) A few whole-work-order flags.
const wos = db.prepare("SELECT id FROM work_orders ORDER BY id LIMIT 4").all();
wos.forEach((r, i) => setTag('work_orders', r.id, TAGSETS[i % 3], (i * 3) + 3));

// 5) Wasted-vs-actual split. The default is 0 wasted (fully actual until a
// manager specifies); here we set explicit, varied wasted portions on the
// tagged items so the demo shows a realistic wasted-vs-actual breakdown
// (a few stay at 0 = fully actual, some are fully wasted, most partial).
const FRACS = [1, 0.6, 0.4, 0, 0.75, 0.5, 0.3];
let fi = 0;
for (const e of db.prepare("SELECT id, amount FROM expenses WHERE unplanned_tag IS NOT NULL AND category NOT IN ('labor','drive')").all()) {
  db.prepare("UPDATE expenses SET unplanned_wasted = ? WHERE id = ?").run(+(e.amount * FRACS[fi++ % FRACS.length]).toFixed(2), e.id);
}
for (const c of db.prepare("SELECT id, amount FROM corp_card_expenses WHERE unplanned_tag IS NOT NULL").all()) {
  db.prepare("UPDATE corp_card_expenses SET unplanned_wasted = ? WHERE id = ?").run(+(c.amount * FRACS[fi++ % FRACS.length]).toFixed(2), c.id);
}
const taggedTes = db.prepare(`
  SELECT te.id, te.clock_in, te.clock_out, te.break_minutes, COALESCE(u.hourly_rate,40.0) AS rate
  FROM time_entries te JOIN users u ON u.id = te.user_id
  WHERE te.unplanned_tag IS NOT NULL AND te.clock_out IS NOT NULL`).all();
taggedTes.forEach(t => {
  const hrs = Math.max(0, (new Date(t.clock_out) - new Date(t.clock_in) - (t.break_minutes || 0) * 60000) / 3600000);
  db.prepare("UPDATE time_entries SET unplanned_wasted = ? WHERE id = ?").run(+(hrs * t.rate * FRACS[fi++ % FRACS.length]).toFixed(2), t.id);
});

const cnt = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE unplanned_tag IS NOT NULL`).get().n;
console.log(`[seed:unplanned] tagged → time_entries=${cnt('time_entries')}, expenses=${cnt('expenses')}, corp_card_expenses=${cnt('corp_card_expenses')}, work_orders=${cnt('work_orders')}`);
console.log('[seed:unplanned] Sign in as  maitland / password123  → Dashboard → "Unplanned work".');

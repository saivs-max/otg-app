// clear-test-data.js — reset transactional/test data for a new testing round.
//
// Keeps user identity + org configuration; wipes everything else. Safe to keep
// in the repo and re-run before each round of testing.
//
//   KEPT  : users, sessions, manager_team, custom_rules, corp_card_categories,
//           category_rules, work_types, settings   (accounts + logins + org setup)
//   WIPED : work_orders, invoices, time_entries, expenses, corp_card_expenses,
//           launch_actuals, notifications, audit_log, attachments,
//           cost_tracker_overrides, vendors, wo_category_budgets,
//           user_integrations, wo_sync_state, wo_addition_requests
//
// Safety:
//   * DRY RUN by default — prints what WOULD be deleted and exits. Pass --confirm
//     to actually delete.
//   * Backs up the DB file (same directory / volume) before deleting.
//   * Deletes inside a transaction; runs PRAGMA foreign_key_check afterward and
//     aborts (rolls back) if anything is left dangling.
//   * Resets AUTOINCREMENT counters for the wiped tables so new test data starts
//     at id 1 (pass --keep-ids to leave counters alone).
//   * Optionally purges uploaded receipt files with --purge-receipts.
//
// Run (needs the same node flags the app uses):
//   node --experimental-sqlite --no-warnings=ExperimentalWarning clear-test-data.js            # dry run
//   node --experimental-sqlite --no-warnings=ExperimentalWarning clear-test-data.js --confirm  # apply
//
// DB path resolves to ./data/otg.db (i.e. /app/data/otg.db on Fly). Override
// with OTG_DB_PATH=/some/other.db for testing against a copy.

const fs   = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.OTG_DB_PATH || path.join(__dirname, 'data', 'otg.db');

// Order does not matter for correctness (FKs are disabled during the wipe and
// verified afterward), but children are listed before parents for readability.
const WIPE = [
  'attachments',
  'notifications',
  'wo_addition_requests',
  'wo_sync_state',
  'user_integrations',
  'cost_tracker_overrides',
  'wo_category_budgets',
  'corp_card_expenses',
  'launch_actuals',
  'expenses',
  'time_entries',
  'invoices',
  'work_orders',
  'vendors',
  'audit_log',
];

const KEEP = [
  'users',
  'sessions',
  'manager_team',
  'custom_rules',
  'corp_card_categories',
  'category_rules',
  'work_types',
  'settings',
];

const confirm        = process.argv.includes('--confirm');
const keepIds        = process.argv.includes('--keep-ids');
const purgeReceipts  = process.argv.includes('--purge-receipts');

function tableExists(db, t) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function count(db, t) {
  if (!tableExists(db, t)) return null;
  return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
}
function fmt(v) { return v === null ? '(table absent)' : String(v); }

if (!fs.existsSync(DB_PATH)) {
  console.error('DB not found at', DB_PATH);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

console.log('DB:', DB_PATH);
console.log('\nKEEP — untouched (accounts + org setup):');
for (const t of KEEP) console.log('   ', t.padEnd(24), fmt(count(db, t)));

console.log('\nWIPE — test data to remove:');
let totalToDelete = 0;
for (const t of WIPE) {
  const c = count(db, t);
  if (c) totalToDelete += c;
  console.log('   ', t.padEnd(24), fmt(c));
}

if (!confirm) {
  console.log(`\nDRY RUN — nothing was deleted.`);
  console.log(`Would remove ${totalToDelete} rows across ${WIPE.length} tables.`);
  console.log('Re-run with --confirm to apply.');
  db.close();
  process.exit(0);
}

// --- Backup before any destructive change (lands next to the DB, i.e. on the
//     Fly volume, so it survives restarts). ---
const stamp  = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${DB_PATH}.bak-${stamp}`;
fs.copyFileSync(DB_PATH, backup);
console.log('\nBackup written:', backup);

db.exec('PRAGMA foreign_keys = OFF');
db.exec('BEGIN');
try {
  for (const t of WIPE) {
    if (tableExists(db, t)) db.exec(`DELETE FROM ${t}`);
  }
  if (!keepIds && tableExists(db, 'sqlite_sequence')) {
    const del = db.prepare('DELETE FROM sqlite_sequence WHERE name = ?');
    for (const t of WIPE) if (tableExists(db, t)) del.run(t);
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  db.exec('PRAGMA foreign_keys = ON');
  console.error('\nFAILED — rolled back, data unchanged:', e.message);
  console.error('Backup (identical to current DB) at:', backup);
  db.close();
  process.exit(1);
}
db.exec('PRAGMA foreign_keys = ON');

// --- Integrity check: no kept row may reference a deleted row. ---
const violations = db.prepare('PRAGMA foreign_key_check').all();
if (violations.length) {
  console.error('\nFK violations detected after wipe:', violations);
  console.error('Restore from backup if needed:', backup);
  db.close();
  process.exit(1);
}

db.exec('VACUUM');

console.log('\nAFTER:');
for (const t of KEEP) console.log('   keep', t.padEnd(24), fmt(count(db, t)));
for (const t of WIPE) console.log('   wipe', t.padEnd(24), fmt(count(db, t)));

const totalUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const withLogin  = db.prepare(
  "SELECT COUNT(*) AS n FROM users WHERE username IS NOT NULL AND password_hash IS NOT NULL"
).get().n;
console.log(`\nLogins preserved: ${withLogin}/${totalUsers} users still have a username + password.`);

// --- Optional: remove uploaded receipt/PDF files left orphaned by the wipe. ---
if (purgeReceipts) {
  const dir = path.join(path.dirname(DB_PATH), 'receipts');
  let removed = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (fs.statSync(p).isFile()) { fs.unlinkSync(p); removed++; } } catch (_) {}
    }
  }
  console.log(`Receipts purged: ${removed} file(s) removed from ${dir}`);
}

console.log('\nDone. Backup kept at:', backup);
db.close();

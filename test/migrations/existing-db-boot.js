// test/migrations/existing-db-boot.js
//
// Regression guard for the v0.71 boot crash.
//
// ensureSchema() runs db.exec(schema.sql) FIRST, then the migrateAddColumn()
// migrations. So any index/DDL in schema.sql that references a migration-added
// column will run before that column exists and crash boot on an EXISTING
// database (production is a persistent SQLite volume — never a fresh DB).
//
// The v0.71 idx_notif_recipient index referenced notifications.dismissed_at
// from schema.sql and took down the whole app on deploy. This test simulates an
// existing pre-v0.71 DB and asserts ensureSchema() boots cleanly, adds the
// column + index, and is idempotent across restarts.
//
//   node --experimental-sqlite --no-warnings=ExperimentalWarning test/migrations/existing-db-boot.js

const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema } = require('../../db');

let pass = 0;
const ok = (cond, label) => { assert.ok(cond, label); console.log(`  ✓ ${label}`); pass++; };

try {
  console.log('\nEXISTING-DB BOOT — ensureSchema must not crash on a pre-v0.71 DB:');

  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');

  // Pre-v0.71 notifications table — note: NO dismissed_at column.
  db.exec(`CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, invoice_id INTEGER,
    triggered_by INTEGER, recipient TEXT, subject TEXT, body TEXT, attachment_id INTEGER,
    status TEXT DEFAULT 'logged', created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  // Legacy row, to prove the migration tolerates existing data.
  db.prepare('INSERT INTO notifications (kind, recipient) VALUES (?,?)').run('invoice_to_ap', 'ap@e.com');

  // The real boot path. Pre-fix, this threw "no such column: dismissed_at".
  assert.doesNotThrow(() => ensureSchema(db), 'ensureSchema boots on an existing DB');
  ok(true, 'ensureSchema() does not crash on an existing notifications table');

  const cols = db.prepare('PRAGMA table_info(notifications)').all().map(c => c.name);
  ok(cols.includes('dismissed_at'), 'dismissed_at column was added by migration');

  const idx = db.prepare('PRAGMA index_list(notifications)').all().map(i => i.name);
  ok(idx.includes('idx_notif_recipient'), 'idx_notif_recipient index was created after the column');

  // Restart safety: a second boot (next deploy) must be a no-op, not a crash.
  assert.doesNotThrow(() => ensureSchema(db), 'second ensureSchema is idempotent');
  ok(true, 'ensureSchema() is idempotent across restarts');

  // The legacy row survives and reads back with a NULL dismissed_at.
  const legacy = db.prepare("SELECT kind, dismissed_at FROM notifications WHERE recipient = 'ap@e.com'").get();
  ok(legacy && legacy.kind === 'invoice_to_ap' && legacy.dismissed_at == null,
     'legacy notification row is preserved with dismissed_at = NULL');

  console.log(`\nALL ${pass} CHECKS PASSED ✅\n`);
} catch (e) {
  console.error(`\n❌ FAILED after ${pass} checks:`, e.message, '\n');
  process.exitCode = 1;
}

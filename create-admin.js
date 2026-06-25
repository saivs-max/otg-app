// create-admin.js — create (or reset) ONE admin login, with NO demo data.
//
// Run it INSIDE the deployed container (via `fly ssh console`), from /app:
//
//   Clean slate + your admin (clears ALL existing data first — use this to wipe
//   the demo data the seed left behind):
//     WIPE=1 ADMIN_USERNAME=you ADMIN_PASSWORD='your-strong-pass' \
//       ADMIN_NAME='Your Name' ADMIN_EMAIL=you@company.com npm run create-admin
//
//   Just add/reset your admin and leave existing data alone:
//     ADMIN_USERNAME=you ADMIN_PASSWORD='your-strong-pass' npm run create-admin
//
// It never runs on its own. WIPE=1 deletes all app data (users, work orders,
// invoices, expenses, etc.); without WIPE it only touches the one admin account.

const { open, ensureSchema } = require('./db');
const { hashPassword } = require('./lib/auth');

const username = process.env.ADMIN_USERNAME || process.argv[2];
const password = process.env.ADMIN_PASSWORD || process.argv[3];
const name     = process.env.ADMIN_NAME     || process.argv[4] || username;
const email    = process.env.ADMIN_EMAIL    || process.argv[5] || `${username}@example.com`;
const wipe     = process.env.WIPE === '1' || process.argv.includes('--wipe');

if (!username || !password) {
  console.error('Missing credentials.');
  console.error('Usage: ADMIN_USERNAME=<u> ADMIN_PASSWORD=<p> [ADMIN_NAME=..] [ADMIN_EMAIL=..] [WIPE=1] npm run create-admin');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const db = open();
ensureSchema(db);   // creates empty tables if the DB is fresh; never deletes on its own

if (wipe) {
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of [
    'sessions', 'notifications', 'attachments', 'audit_log', 'launch_actuals',
    'cost_tracker_overrides', 'expenses', 'time_entries', 'invoices', 'work_orders',
    'custom_rules', 'manager_team', 'settings', 'users',
  ]) {
    try { db.exec(`DELETE FROM ${t}`); } catch (_) { /* table may not exist yet */ }
  }
  try { db.exec('DELETE FROM sqlite_sequence'); } catch (_) {}
  db.exec('PRAGMA foreign_keys = ON');
  console.log('✓ Cleared all existing data (including the demo accounts).');
}

const now  = new Date().toISOString();
const hash = hashPassword(password);
const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);

if (existing) {
  db.prepare(`UPDATE users
                 SET password_hash = ?, password_set_at = ?, role = 'pm',
                     status = 'active', name = ?, email = ?
               WHERE id = ?`)
    .run(hash, now, name, email, existing.id);
  console.log(`✓ Reset user "${username}" (id ${existing.id}) to admin (role: pm).`);
} else {
  const r = db.prepare(`INSERT INTO users
      (name, email, username, role, worker_type, hourly_rate, ops_manager_id,
       password_hash, password_set_at, status)
      VALUES (?, ?, ?, 'pm', NULL, NULL, NULL, ?, ?, 'active')`)
    .run(name, email, username, hash, now);
  console.log(`✓ Created admin user "${username}" (id ${r.lastInsertRowid}, role: pm).`);
}

console.log(`  Users in database now: ${db.prepare('SELECT COUNT(*) AS n FROM users').get().n}`);
console.log(`  Log in at https://breadapp.fly.dev with username "${username}".`);

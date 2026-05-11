// Standalone tool: import work orders from a CSV.
//
// Usage:
//   npm run import-csv -- path/to/workorders.csv
//
// Expected columns (case-insensitive, in any order):
//   external_id      e.g. MX-RTR-2406-127  (required, unique)
//   source_system    'maintainx' or 'freshdesk'  (required)
//   work_type        'deployment' | 'retrofit' | 'service' | 'repair'  (required)
//   store_id         e.g. WF-EDG  (optional)
//   store_name       e.g. Whole Foods Edgewater  (recommended)
//   cart_count       integer (default 0)
//   scheduled_date   YYYY-MM-DD (optional)
//   description      free text  (recommended)
//   status           'open'|'in_progress'|'completed'|'cancelled' (default 'open')
//   assigned_email   email of the technician this WO is assigned to (optional)
//
// Behavior:
//   - Upserts on external_id (existing rows are updated, new rows inserted).
//   - Unknown columns are ignored.
//   - Reports a per-row summary at the end.

const fs   = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { open, ensureSchema, logAudit } = require('./db');

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Usage: npm run import-csv -- path/to/workorders.csv");
  process.exit(1);
}
if (!fs.existsSync(csvPath)) {
  console.error(`File not found: ${csvPath}`);
  process.exit(1);
}

const db = open();
ensureSchema(db);

const raw = fs.readFileSync(csvPath, 'utf8');
const rows = parse(raw, {
  columns: header => header.map(h => h.toLowerCase().trim()),
  skip_empty_lines: true,
  trim: true,
});

const REQUIRED = ['external_id', 'source_system', 'work_type'];
const VALID_SOURCES = new Set(['maintainx','freshdesk']);
const VALID_TYPES   = new Set(['deployment','retrofit','service','repair']);
const VALID_STATUS  = new Set(['open','in_progress','completed','cancelled']);

const upsert = db.prepare(`
  INSERT INTO work_orders
    (external_id, source_system, work_type, store_id, store_name, cart_count,
     scheduled_date, description, status, assigned_user_id)
  VALUES (@external_id, @source_system, @work_type, @store_id, @store_name, @cart_count,
          @scheduled_date, @description, @status, @assigned_user_id)
  ON CONFLICT(external_id) DO UPDATE SET
    source_system    = excluded.source_system,
    work_type        = excluded.work_type,
    store_id         = excluded.store_id,
    store_name       = excluded.store_name,
    cart_count       = excluded.cart_count,
    scheduled_date   = excluded.scheduled_date,
    description      = excluded.description,
    status           = excluded.status,
    assigned_user_id = excluded.assigned_user_id
`);

const findUserByEmail = db.prepare("SELECT id FROM users WHERE email = ?");

const results = { inserted: 0, updated: 0, errors: [] };

// Validate every row first; only commit if all pass.
db.exec("BEGIN");
try {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lineNo = i + 2; // header is line 1

    for (const k of REQUIRED) {
      if (!r[k]) { results.errors.push(`Line ${lineNo}: missing required column "${k}"`); break; }
    }
    if (results.errors.length) break;

    if (!VALID_SOURCES.has(r.source_system)) {
      results.errors.push(`Line ${lineNo}: source_system must be one of ${[...VALID_SOURCES].join(', ')}`); break;
    }
    if (!VALID_TYPES.has(r.work_type)) {
      results.errors.push(`Line ${lineNo}: work_type must be one of ${[...VALID_TYPES].join(', ')}`); break;
    }
    const status = r.status || 'open';
    if (!VALID_STATUS.has(status)) {
      results.errors.push(`Line ${lineNo}: status "${status}" is not valid`); break;
    }

    let assigned_user_id = null;
    if (r.assigned_email) {
      const u = findUserByEmail.get(r.assigned_email);
      if (!u) {
        results.errors.push(`Line ${lineNo}: assigned_email "${r.assigned_email}" not found in users table`);
        break;
      }
      assigned_user_id = u.id;
    }

    const before = db.prepare("SELECT id FROM work_orders WHERE external_id = ?").get(r.external_id);

    upsert.run({
      external_id:      r.external_id,
      source_system:    r.source_system,
      work_type:        r.work_type,
      store_id:         r.store_id      || null,
      store_name:       r.store_name    || null,
      cart_count:       r.cart_count ? Number(r.cart_count) : 0,
      scheduled_date:   r.scheduled_date || null,
      description:      r.description   || null,
      status,
      assigned_user_id,
    });

    if (before) results.updated++;
    else        results.inserted++;
  }

  if (results.errors.length) {
    db.exec("ROLLBACK");
    console.error("\n✗ Import aborted. No rows changed.\n");
    results.errors.forEach(e => console.error("  " + e));
    process.exit(1);
  }
  db.exec("COMMIT");
  console.log(`\n✓ Imported ${rows.length} rows from ${path.basename(csvPath)}`);
  console.log(`  ${results.inserted} inserted, ${results.updated} updated`);
  logAudit(db, {
    entity_type: 'work_orders', entity_id: 0, user_id: null,
    action: 'csv_import',
    details: { file: path.basename(csvPath), inserted: results.inserted, updated: results.updated },
  });
} catch (e) {
  try { db.exec("ROLLBACK"); } catch {}
  console.error("\n✗ Import failed:", e.message);
  process.exit(1);
}

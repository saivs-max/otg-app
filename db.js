// SQLite handle, schema bootstrap, and a few helpers shared by routes.
// Uses Node's built-in `node:sqlite` (experimental, requires Node >= 22.5).
const fs   = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH     = path.join(__dirname, 'data', 'otg.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function open() {
  // v0.57 — restrictive perms so the SQLite file and its WAL/SHM siblings
  // are only readable by the user that runs the server. Prevents another
  // local user (or a leaked container mount) from reading financial data
  // at rest. POSIX-only; chmod is a no-op on Windows.
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(DB_PATH), 0o700); } catch {}
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON');
  // Tighten file mode on the actual db file (and its WAL/SHM siblings if any).
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = DB_PATH + suffix;
      if (fs.existsSync(p)) fs.chmodSync(p, 0o600);
    }
  } catch {}
  return db;
}

function ensureSchema(db) {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  // Lightweight migrations for columns added to existing tables. SQLite's
  // IF NOT EXISTS only protects table creation, so we ALTER if missing.
  migrateAddColumn(db, 'invoices', 'extracted_text',    'TEXT');
  migrateAddColumn(db, 'invoices', 'extracted_summary', 'TEXT');
  migrateAddColumn(db, 'invoices', 'extracted_at',      'TEXT');
  migrateAddColumn(db, 'custom_rules', 'cart_count_min', 'INTEGER');
  // v0.25
  migrateAddColumn(db, 'invoices', 'sent_to_ap_at',  'TEXT');
  migrateAddColumn(db, 'invoices', 'sent_to_ap_by',  'INTEGER');
  migrateAddColumn(db, 'invoices', 'ap_email_to',    'TEXT');
  // v0.32 — Ops Mgr escalation to Sr Mgr secondary approval.
  migrateAddColumn(db, 'invoices', 'escalated_at',    'TEXT');
  migrateAddColumn(db, 'invoices', 'escalated_by',    'INTEGER');
  migrateAddColumn(db, 'invoices', 'escalation_note', 'TEXT');
  // v0.35 — username/password auth.
  migrateAddColumn(db, 'users', 'username',             'TEXT');
  migrateAddColumn(db, 'users', 'password_hash',        'TEXT');
  migrateAddColumn(db, 'users', 'password_set_at',      'TEXT');
  migrateAddColumn(db, 'users', 'must_change_password', 'INTEGER DEFAULT 0');
  migrateAddColumn(db, 'users', 'status',               "TEXT DEFAULT 'active'");
  migrateAddColumn(db, 'users', 'last_login_at',        'TEXT');
  // v0.36 — 3rd-party vendor invoices.
  migrateAddColumn(db, 'invoices', 'invoice_type',          "TEXT DEFAULT 'tech_labor'");
  migrateAddColumn(db, 'invoices', 'vendor_name',           'TEXT');
  migrateAddColumn(db, 'invoices', 'vendor_invoice_number', 'TEXT');
  migrateAddColumn(db, 'invoices', 'vendor_invoice_date',   'TEXT');
  // v0.54 — Ops Mgr can categorize a vendor invoice (deployment, retrofit,
  // service, repair, parts, other) for cost-allocation alongside regular
  // service work. Free-text-ish so we don't need a CHECK rebuild.
  migrateAddColumn(db, 'invoices', 'vendor_category',       'TEXT');
  // v0.47 — Real MaintainX responses don't always populate locationId, so
  // we now capture sequentialId (the human-readable WO number, e.g. 1613
  // vs the 99492673 internal id) plus the count of sub-WOs from the
  // `progress` object on parent work orders, plus priority.
  migrateAddColumn(db, 'work_orders', 'wo_number',     'INTEGER');
  migrateAddColumn(db, 'work_orders', 'sub_wo_count',  'INTEGER');
  migrateAddColumn(db, 'work_orders', 'priority',      'TEXT');

  // v0.66.2 — Cost Tracker splits Actual Expenses out of Actual Travel; the
  // override table needs a column so manual edits to the new field persist.
  migrateAddColumn(db, 'cost_tracker_overrides', 'actual_expenses', 'REAL');
  // v0.69 — optional explicit drive endpoints on mileage expenses. The mileage
  // reimbursement report prefers these over the work order's store location.
  migrateAddColumn(db, 'expenses', 'start_location', 'TEXT');
  migrateAddColumn(db, 'expenses', 'stop_location',  'TEXT');
  // v0.71 — in-app notifications surfaced on the tech's home banner. A
  // dismissed_at timestamp lets dismissal persist server-side (across reloads
  // and devices) rather than relying on client storage. The index MUST be
  // created here, AFTER the column is added — putting it in schema.sql would
  // run it before this migration and crash boot on existing DBs.
  migrateAddColumn(db, 'notifications', 'dismissed_at', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications(recipient, dismissed_at)');
  // v0.48 — Expensify export for FTE field techs. Contractors keep the
  // existing PDF→AP flow. Each invoice can be sent to Expensify once and
  // we track the resulting Expensify reportID + URL for re-opening it.
  migrateAddColumn(db, 'invoices', 'expensify_report_id',  'TEXT');
  migrateAddColumn(db, 'invoices', 'expensify_report_url', 'TEXT');
  migrateAddColumn(db, 'invoices', 'expensify_sent_at',    'TEXT');
  migrateAddColumn(db, 'invoices', 'expensify_sent_by',    'INTEGER');
  // v0.23 — custom_rules CHECK constraint needs the new max_hours_per_10_carts
  // rule_type. SQLite doesn't support ALTER TABLE ... DROP CONSTRAINT, so we
  // detect the old constraint by trying to insert a sentinel value; if the
  // insert fails, we rebuild the table with the new schema and copy rows over.
  migrateRulesCheckConstraint(db);
  // v0.29 — terminate lifecycle at sent_ap; convert any historic 'paid' rows.
  migrateInvoicesStatusCheck(db);
  // v0.54 — let field techs log 'labor' as an expense category (hours × rate).
  migrateExpensesCategoryCheck(db);
  // v0.61 — make sure every existing category has its three rule rows.
  seedCategoryRules(db);
  // v0.62 — drop the hard-coded work_type CHECK constraints on work_orders +
  // custom_rules so admin-added work types are accepted. Seed the four
  // originals so the dropdowns + existing rules keep working.
  migrateWorkTypeChecks(db);
  seedDefaultWorkTypes(db);
  // v0.65.2 — the 'service' work type was renamed to 'maintenance'. Migrate any
  // existing data so nothing still references the old name.
  migrateServiceToMaintenance(db);
  // v0.63 — Unplanned / wasted-labour tagging. Adds tag + note columns to the
  // four line-item tables so ops managers can mark individual items as
  // wasted_labour, ad_hoc, or unexpected without changing any existing rows.
  migrateUnplannedColumns(db);
  // v0.67 — MaintainX per-worker work-order sync. The new tables
  // (user_integrations, wo_sync_state) are created by schema.sql; here we add
  // labor-provenance columns to the existing time_entries table plus the
  // idempotency index that keeps re-syncs from duplicating imported labor.
  migrateMaintainXSync(db);
  // v0.68 — "Add work orders to an already-submitted week" requests. The
  // wo_addition_requests table is created by schema.sql above (CREATE TABLE IF
  // NOT EXISTS, applied on every boot); no column migration is needed.

  // v0.73 — Vendor master list. The `vendors` table is created by schema.sql
  // above; backfill it from any vendor names already on invoices so the new
  // picker/filter shows existing vendors immediately. Idempotent (OR IGNORE +
  // case-insensitive UNIQUE), safe on every boot.
  try {
    db.exec(`
      INSERT OR IGNORE INTO vendors (name)
      SELECT DISTINCT TRIM(vendor_name) FROM invoices
      WHERE invoice_type = 'vendor' AND vendor_name IS NOT NULL AND TRIM(vendor_name) <> ''
    `);
  } catch (_) { /* vendors table absent on a partial schema — ignore */ }

  // v0.82 — Break timer rework (live-tracked pause/resume). break_started_at is
  // the pause timestamp on a running entry; break_flagged marks a break that ran
  // over 60 min. Both default to not-on-break / unflagged, so existing rows are
  // untouched and read exactly as before. See BREAK_DRIVING_WORKFLOW_DESIGN.md.
  migrateAddColumn(db, 'time_entries', 'break_started_at', 'TEXT');
  migrateAddColumn(db, 'time_entries', 'break_flagged',    'INTEGER DEFAULT 0');

  // v0.82.1 — Backfill invoice_id on existing maintainx_sync entries that were
  // written before the inherit-invoice-id logic. Without this, the mxWorkWOs
  // dedup filter in computeInvoice never sees the MX entry (it has no invoice_id)
  // and the original Bread clock entry keeps showing as a duplicate line.
  // Safe to run every boot — COALESCE means already-set values are never touched.
  db.exec(`
    UPDATE time_entries
    SET invoice_id = (
      SELECT te2.invoice_id
      FROM time_entries te2
      WHERE te2.work_order_id = time_entries.work_order_id
        AND te2.invoice_id IS NOT NULL
        AND te2.source != 'maintainx_sync'
      LIMIT 1
    )
    WHERE source = 'maintainx_sync'
      AND invoice_id IS NULL
      AND EXISTS (
        SELECT 1 FROM time_entries te2
        WHERE te2.work_order_id = time_entries.work_order_id
          AND te2.invoice_id IS NOT NULL
          AND te2.source != 'maintainx_sync'
      )
  `);
}

// v0.63 — Unplanned tagging. Tags are stored as a JSON array so one item can
// carry multiple reasons simultaneously (e.g. ["wasted_labour","ad_hoc"]).
// The column type is plain TEXT — no CHECK constraint — because SQLite CHECK
// can't validate JSON contents without generated columns. Application-layer
// validation in routes/unplanned.js enforces the allowed values.
//
// If the column was previously added with the old single-value CHECK constraint
// we probe and rebuild the affected table to shed it.
function migrateUnplannedColumns(db) {
  const tables = ['work_orders','time_entries','expenses','corp_card_expenses'];
  for (const t of tables) {
    // Add columns as plain TEXT if they don't exist yet.
    migrateAddColumn(db, t, 'unplanned_tag',       'TEXT');
    migrateAddColumn(db, t, 'unplanned_note',      'TEXT');
    migrateAddColumn(db, t, 'unplanned_tagged_by', 'INTEGER');
    migrateAddColumn(db, t, 'unplanned_tagged_at', 'TEXT');
    // v0.64.4 — wasted portion ($) of the item; NULL = the whole item is wasted.
    // wasted + actual always totals the item's original reported amount.
    migrateAddColumn(db, t, 'unplanned_wasted',    'REAL');

    // Probe: if the old single-value CHECK is still in place it will reject a
    // JSON array. Rebuild the table to drop the constraint.
    try {
      db.exec(`SAVEPOINT chk_up_${t};`);
      db.prepare(`UPDATE ${t} SET unplanned_tag = '["wasted_labour","ad_hoc"]' WHERE 1=0`).run();
      // INSERT probe — a fake value to trigger the CHECK on real rows path
      db.prepare(`UPDATE ${t} SET unplanned_tag = unplanned_tag WHERE unplanned_tag = '["probe"]'`).run();
      db.exec(`RELEASE chk_up_${t};`);
    } catch (e) {
      db.exec(`ROLLBACK TO chk_up_${t}; RELEASE chk_up_${t};`);
      if (String(e.message).includes('CHECK')) {
        console.log(`[migrate] Rebuilding ${t} to drop unplanned_tag CHECK constraint…`);
        rebuildUnplannedCheck(db, t);
      }
    }
  }
}

// Rebuild a table to shed the old unplanned_tag CHECK constraint.
// We preserve all existing columns and data; only the column definition changes.
function rebuildUnplannedCheck(db, table) {
  // v0.65.1 (F-H7) — rebuild from the table's ORIGINAL DDL so PRIMARY KEY,
  // AUTOINCREMENT, FOREIGN KEYs, UNIQUE and defaults are all preserved; we strip
  // ONLY the legacy CHECK(...) on unplanned_tag. The previous implementation
  // reconstructed from PRAGMA table_info and silently dropped keys/FKs on the
  // core financial tables.
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table);
  if (!row || !row.sql) return;
  const stripped = row.sql.replace(/(unplanned_tag\s+[A-Za-z]+)\s+CHECK\s*\([^)]*\)/i, '$1');
  if (stripped === row.sql) return;            // no CHECK in the DDL → don't risk a lossy rebuild
  const tmp    = `${table}__rebuild`;
  const tmpDdl = stripped.replace(new RegExp(`CREATE\\s+TABLE\\s+("?)${table}\\1`, 'i'), `CREATE TABLE ${tmp}`);
  if (tmpDdl === stripped) return;             // couldn't safely rename in the DDL → abort
  const colList = db.prepare(`PRAGMA table_info(${table})`).all().map(c => `"${c.name}"`).join(', ');
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL").all(table);
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec('BEGIN;');
  try {
    db.exec(tmpDdl);
    db.exec(`INSERT INTO ${tmp} (${colList}) SELECT ${colList} FROM ${table};`);
    db.exec(`DROP TABLE ${table};`);
    db.exec(`ALTER TABLE ${tmp} RENAME TO ${table};`);
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    db.exec('PRAGMA foreign_keys=ON;');
    throw e;
  }
  for (const i of indexes) { try { db.exec(i.sql); } catch (_) {} }
  db.exec('PRAGMA foreign_keys=ON;');
}

const DEFAULT_WORK_TYPES = ['deployment','retrofit','maintenance','repair'];

function seedDefaultWorkTypes(db) {
  const ins = db.prepare("INSERT OR IGNORE INTO work_types (name) VALUES (?)");
  for (const wt of DEFAULT_WORK_TYPES) ins.run(wt);
}

// v0.65.2 — 'service' was renamed to 'maintenance'. Repoint every reference to
// the old name: the work_types row, every work_order, custom-rule work_type
// filters, and the per-type productivity policy setting key. Idempotent — safe
// to run on every boot (no-op once nothing references 'service' anymore).
function migrateServiceToMaintenance(db) {
  try {
    const hasService     = db.prepare("SELECT 1 FROM work_types WHERE name = 'service'").get();
    const hasMaintenance = db.prepare("SELECT 1 FROM work_types WHERE name = 'maintenance'").get();
    if (hasService && !hasMaintenance) {
      db.prepare("UPDATE work_types SET name = 'maintenance' WHERE name = 'service'").run();
    } else if (hasService && hasMaintenance) {
      // Both rows exist (defaults were reseeded with the new name) — drop the
      // stale 'service' row; the rows that used it are repointed below.
      db.prepare("DELETE FROM work_types WHERE name = 'service'").run();
    }
    // Repoint historical data regardless of work_types state.
    db.prepare("UPDATE work_orders  SET work_type        = 'maintenance' WHERE work_type        = 'service'").run();
    db.prepare("UPDATE custom_rules SET work_type_filter = 'maintenance' WHERE work_type_filter = 'service'").run();
    // Carry over any saved per-type productivity override to the new key name.
    const srv = db.prepare("SELECT value FROM settings WHERE key = 'policy_hours_per_10_carts_service'").get();
    if (srv) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('policy_hours_per_10_carts_maintenance', ?)").run(srv.value);
      db.prepare("DELETE FROM settings WHERE key = 'policy_hours_per_10_carts_service'").run();
    }
  } catch (e) {
    console.error('[migrate] service→maintenance failed:', e.message);
  }
}

// Returns the set of currently-active work-type names. Always includes the
// four defaults as a fallback so validators don't reject pre-existing rows
// even if the work_types table is wiped or unreadable.
function activeWorkTypes(db) {
  const set = new Set(DEFAULT_WORK_TYPES);
  try {
    const rows = db.prepare("SELECT name FROM work_types WHERE archived_at IS NULL").all();
    for (const r of rows) set.add(r.name);
  } catch (_) { /* table not yet migrated — fall back to defaults */ }
  return set;
}

// SQLite can't ALTER TABLE ... DROP CONSTRAINT, so we rebuild both tables to
// shed their work_type CHECK constraints. Probe by trying to insert a sentinel
// value inside a savepoint — if the constraint rejects it, rebuild.
function migrateWorkTypeChecks(db) {
  // ---- work_orders ----
  try {
    db.exec('SAVEPOINT chk_wo;');
    db.prepare(`INSERT INTO work_orders (external_id, source_system, source_ticket_id, title, work_type, store_id, store_name, cart_count, scheduled_date, description, status)
                VALUES ('__chk_wo__', 'maintainx', '__chk__', 'probe', '__custom_wt__', 'CHK', 'chk', 1, '2000-01-01', 'probe', 'in_progress')`).run();
    db.exec('ROLLBACK TO chk_wo; RELEASE chk_wo;');
  } catch (e) {
    db.exec('ROLLBACK TO chk_wo; RELEASE chk_wo;');
    if (String(e.message).includes('CHECK')) {
      console.log('[migrate] Rebuilding work_orders to drop work_type CHECK…');
      // Match the original schema.sql definition column-for-column (store_address
      // and the 'open' status enum value were missing from the v0.62.0 attempt
      // and broke INSERT … SELECT on every fresh boot). The only difference
      // versus the original is the work_type CHECK, which is removed.
      const cols = db.prepare(`PRAGMA table_info(work_orders)`).all().map(c => c.name).join(', ');
      db.exec(`
        BEGIN;
        CREATE TABLE work_orders_new (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          external_id       TEXT    UNIQUE NOT NULL,
          source_system     TEXT    NOT NULL CHECK (source_system IN ('maintainx','freshdesk')),
          source_ticket_id  TEXT,
          title             TEXT,
          work_type         TEXT    NOT NULL,
          store_id          TEXT,
          store_name        TEXT,
          store_address     TEXT,
          cart_count        INTEGER DEFAULT 0,
          scheduled_date    TEXT,
          description       TEXT,
          status            TEXT    DEFAULT 'open' CHECK (status IN ('open','in_progress','completed','cancelled')),
          assigned_user_id  INTEGER REFERENCES users(id),
          wo_number         INTEGER,
          sub_wo_count      INTEGER,
          priority          TEXT,
          created_at        TEXT    DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO work_orders_new (${cols}) SELECT ${cols} FROM work_orders;
        DROP TABLE work_orders;
        ALTER TABLE work_orders_new RENAME TO work_orders;
        CREATE INDEX IF NOT EXISTS idx_wo_assigned ON work_orders(assigned_user_id);
        CREATE INDEX IF NOT EXISTS idx_wo_status   ON work_orders(status);
        COMMIT;
      `);
    }
  }

  // ---- custom_rules ----
  try {
    db.exec('SAVEPOINT chk_cr;');
    db.prepare(`INSERT INTO custom_rules (rule_type, work_type_filter, threshold) VALUES ('max_hours_per_shift', '__custom_wt__', 1)`).run();
    db.exec('ROLLBACK TO chk_cr; RELEASE chk_cr;');
  } catch (e) {
    db.exec('ROLLBACK TO chk_cr; RELEASE chk_cr;');
    if (String(e.message).includes('CHECK')) {
      console.log('[migrate] Rebuilding custom_rules to drop work_type_filter CHECK…');
      db.exec(`
        BEGIN;
        CREATE TABLE custom_rules_new (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_type         TEXT    NOT NULL CHECK (rule_type IN (
                              'max_hours_per_shift','max_hours_per_day','max_drive_hours_per_day',
                              'max_miles_per_day','max_expense_amount','require_receipt_above',
                              'max_hours_per_wo','max_hours_per_cart','max_hours_per_10_carts'
                            )),
          work_type_filter  TEXT,
          category_filter   TEXT,
          cart_count_min    INTEGER,
          threshold         REAL    NOT NULL,
          description       TEXT,
          severity          TEXT    DEFAULT 'flag' CHECK (severity IN ('warn','flag','block')),
          active            INTEGER DEFAULT 1,
          created_by        INTEGER REFERENCES users(id),
          created_at        TEXT    DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO custom_rules_new
          SELECT id, rule_type, work_type_filter, category_filter, cart_count_min,
                 threshold, description, severity, active, created_by, created_at
          FROM custom_rules;
        DROP TABLE custom_rules;
        ALTER TABLE custom_rules_new RENAME TO custom_rules;
        CREATE INDEX IF NOT EXISTS idx_rules_active ON custom_rules(active);
        COMMIT;
      `);
    }
  }
}

// Each managed category (corp-card row or tech-expense subcategory) gets three
// editable rule rows: per_wo_cap, global_cap, receipt_required_above. INSERT
// OR IGNORE keeps this idempotent on every boot.
//
// Tech-expense subcategories are hard-coded by the CHECK constraint on the
// expenses table ('Meal','Tools','Hotel','Supplies','Misc' — used when the
// main category is 'other'); we seed those keys here so admins can attach
// rules to them on the Policy page without further schema work.
const TECH_EXPENSE_SUBCATS = ['Meal','Tools','Hotel','Supplies','Misc'];
const CATEGORY_RULE_KINDS  = ['per_wo_cap','global_cap','receipt_required_above'];

function seedCategoryRules(db) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO category_rules (category_source, category_key, rule_kind, amount)
    VALUES (?, ?, ?, NULL)
  `);

  // Corp-card categories — seed for every row (including archived; rules stick
  // around even if the category is later archived, mirroring soft-delete
  // semantics on the category itself).
  const ccCats = db.prepare("SELECT id FROM corp_card_categories").all();
  for (const c of ccCats) {
    for (const k of CATEGORY_RULE_KINDS) insert.run('corp_card', String(c.id), k);
  }

  // Tech-expense subcategories.
  for (const sub of TECH_EXPENSE_SUBCATS) {
    for (const k of CATEGORY_RULE_KINDS) insert.run('tech_expense', sub, k);
  }
}

function migrateExpensesCategoryCheck(db) {
  // Probe: try inserting an expense with category='drive' inside a savepoint.
  // If the existing CHECK rejects it, rebuild the table with the new constraint.
  // We probe 'drive' (the newer addition) since v0.54 adds both labor + drive.
  try {
    db.exec('SAVEPOINT chk_exp;');
    db.prepare(`INSERT INTO expenses (user_id, work_order_id, category, expense_date, amount)
                VALUES (1, 1, 'drive', '2000-01-01', 0)`).run();
    db.exec('ROLLBACK TO chk_exp; RELEASE chk_exp;');
    return;
  } catch (e) {
    db.exec('ROLLBACK TO chk_exp; RELEASE chk_exp;');
    // FK failures (user/WO id 1 missing) mean the constraint already accepts
    // 'drive' — only rebuild on a true CHECK rejection.
    if (!String(e.message).includes('CHECK')) return;
  }
  console.log('[migrate] Rebuilding expenses with v0.54 category CHECK (adds labor + drive)…');
  const cols = db.prepare(`PRAGMA table_info(expenses)`).all().map(c => c.name);
  const colList = cols.join(', ');
  db.exec(`
    BEGIN;
    CREATE TABLE expenses_new (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      work_order_id   INTEGER NOT NULL REFERENCES work_orders(id),
      category        TEXT    NOT NULL CHECK (category IN ('mileage','tolls','parking','vendor','labor','drive','other')),
      subcategory     TEXT,
      expense_date    TEXT    NOT NULL,
      amount          REAL    NOT NULL,
      quantity        REAL,
      rate            REAL,
      description     TEXT,
      -- v0.69 — keep this rebuild DDL in sync with schema.sql so the dynamic
      -- colList copy (which now includes these) doesn't fail on older DBs.
      start_location  TEXT,
      stop_location   TEXT,
      receipt_path    TEXT,
      invoice_id      INTEGER REFERENCES invoices(id),
      created_at      TEXT    DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO expenses_new (${colList}) SELECT ${colList} FROM expenses;
    DROP TABLE expenses;
    ALTER TABLE expenses_new RENAME TO expenses;
    CREATE INDEX IF NOT EXISTS idx_expense_user    ON expenses(user_id, expense_date);
    CREATE INDEX IF NOT EXISTS idx_expense_invoice ON expenses(invoice_id);
    COMMIT;
  `);
}

function migrateInvoicesStatusCheck(db) {
  // First: collapse legacy 'paid' rows so the new CHECK constraint accepts them.
  try { db.exec("UPDATE invoices SET status = 'sent_ap' WHERE status = 'paid'"); } catch (_) {}
  // Probe the CHECK constraint by attempting a sentinel insert in a savepoint.
  try {
    db.exec('SAVEPOINT chk_inv;');
    db.prepare(`INSERT INTO invoices (invoice_number, user_id, period_start, period_end, status, total)
                VALUES ('__chk__', 1, '2000-01-01', '2000-01-07', 'paid', 0)`).run();
    // If it accepted 'paid', the old constraint is still in place — rebuild.
    db.exec('ROLLBACK TO chk_inv; RELEASE chk_inv;');
    rebuildInvoicesTable(db);
  } catch (e) {
    db.exec('ROLLBACK TO chk_inv; RELEASE chk_inv;');
    if (!String(e.message).includes('CHECK')) throw e;
    // CHECK rejected — constraint already updated, nothing to do.
  }
}

function rebuildInvoicesTable(db) {
  console.log('[migrate] Rebuilding invoices with v0.29 status CHECK (drop paid)…');
  // Capture all column names so the rebuild preserves columns added by other
  // migrations (extracted_text, sent_to_ap_*, etc.).
  const cols = db.prepare(`PRAGMA table_info(invoices)`).all().map(c => c.name);
  const colList = cols.join(', ');
  db.exec(`
    BEGIN;
    CREATE TABLE invoices_new (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number    TEXT    UNIQUE NOT NULL,
      user_id           INTEGER NOT NULL REFERENCES users(id),
      period_start      TEXT    NOT NULL,
      period_end        TEXT    NOT NULL,
      status            TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN (
                          'draft','submitted','in_review','approved_ops','approved_sr',
                          'queued_ap','sent_ap','rejected'
                        )),
      total             REAL    DEFAULT 0,
      submitted_at      TEXT,
      approved_ops_at   TEXT,
      approved_ops_by   INTEGER REFERENCES users(id),
      approved_sr_at    TEXT,
      approved_sr_by    INTEGER REFERENCES users(id),
      rejected_at       TEXT,
      rejected_by       INTEGER REFERENCES users(id),
      rejection_reason  TEXT,
      sent_to_ap_at     TEXT,
      sent_to_ap_by     INTEGER REFERENCES users(id),
      ap_email_to       TEXT,
      notes             TEXT,
      created_by        INTEGER REFERENCES users(id),
      origin            TEXT    DEFAULT 'tech_self' CHECK (origin IN ('tech_self','mgr_upload','csv_import')),
      extracted_text    TEXT,
      extracted_summary TEXT,
      extracted_at      TEXT,
      created_at        TEXT    DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO invoices_new (${colList}) SELECT ${colList} FROM invoices;
    DROP TABLE invoices;
    ALTER TABLE invoices_new RENAME TO invoices;
    CREATE INDEX IF NOT EXISTS idx_invoice_user   ON invoices(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_invoice_period ON invoices(user_id, period_start);
    COMMIT;
  `);
}

function migrateRulesCheckConstraint(db) {
  // Probe: try a no-op INSERT/DELETE inside a transaction. If the CHECK
  // doesn't include 'max_hours_per_10_carts', rebuild the table.
  try {
    db.exec('BEGIN');
    db.prepare(`INSERT INTO custom_rules (rule_type, threshold) VALUES ('max_hours_per_10_carts', 1)`).run();
    db.exec('ROLLBACK');
    return; // Constraint already includes the new type — no migration needed.
  } catch (e) {
    db.exec('ROLLBACK');
    if (!String(e.message).includes('CHECK')) throw e;
  }
  console.log('[migrate] Rebuilding custom_rules with v0.23 CHECK constraint…');
  db.exec(`
    CREATE TABLE custom_rules_new (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type         TEXT    NOT NULL CHECK (rule_type IN (
                          'max_hours_per_shift','max_hours_per_day','max_drive_hours_per_day',
                          'max_miles_per_day','max_expense_amount','require_receipt_above',
                          'max_hours_per_wo','max_hours_per_cart','max_hours_per_10_carts'
                        )),
      work_type_filter  TEXT    CHECK (work_type_filter IS NULL OR work_type_filter IN ('deployment','retrofit','maintenance','repair')),
      category_filter   TEXT,
      cart_count_min    INTEGER,
      threshold         REAL    NOT NULL,
      description       TEXT,
      severity          TEXT    DEFAULT 'flag' CHECK (severity IN ('warn','flag','block')),
      active            INTEGER DEFAULT 1,
      created_by        INTEGER REFERENCES users(id),
      created_at        TEXT    DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO custom_rules_new
      SELECT id, rule_type, work_type_filter, category_filter, cart_count_min,
             threshold, description, severity, active, created_by, created_at
      FROM custom_rules;
    DROP TABLE custom_rules;
    ALTER TABLE custom_rules_new RENAME TO custom_rules;
    CREATE INDEX IF NOT EXISTS idx_rules_active ON custom_rules(active);
  `);
}

function migrateAddColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); }
    catch (_) { /* column may have been added concurrently */ }
  }
}

// v0.67 — MaintainX sync: provenance columns on time_entries + an idempotency
// index. Tables themselves live in schema.sql (CREATE TABLE IF NOT EXISTS).
function migrateMaintainXSync(db) {
  migrateAddColumn(db, 'time_entries', 'source',       "TEXT DEFAULT 'app'");
  migrateAddColumn(db, 'time_entries', 'external_ref', 'TEXT');
  // One imported entry per (source, external_ref): re-syncing updates in place
  // rather than stacking duplicate labor. Partial index — only synced rows.
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_time_entries_extref ON time_entries(source, external_ref) WHERE external_ref IS NOT NULL");
  } catch (_) { /* partial-index unsupported on very old SQLite — non-fatal */ }
}

// ---------- shared business helpers ----------

// Static defaults — used when no override is configured in the settings table.
// Read these via getPolicy(db) so the configured org-level values take effect.
//
// Note: as of v0.20 there is no built-in "hours-overrun" multiplier. The Ops
// Mgr controls hours thresholds via custom rules (max_hours_per_wo /
// max_hours_per_10_carts) on the Policy tab — far more flexible than a single
// universal multiplier.
//
// As of v0.23 productivity rates are expressed as HOURS PER 10 CARTS instead
// of hours per single cart — easier to read for managers, since the original
// per-cart numbers were small fractions (0.7, 1.5...) that are awkward to
// reason about. The math just multiplies by 10 throughout.
const POLICY = {
  HOURLY_RATE_DEFAULT: 40.0,
  MILEAGE_RATE: 0.725,
  // hours per 10 carts (was hours per cart × 10)
  HOURS_PER_10_CARTS: { deployment: 7, retrofit: 7, maintenance: 24, repair: 15 },
  MEAL_DAILY_CAP: 100.0,
  MEAL_TRIP_MIN_HOURS: 3,
  // v0.25.1 — AP recipient for /invoices/:id/send-to-ap. Defaults to a test
  // address so the dev environment routes mock emails somewhere visible.
  AP_EMAIL: 'sai.vs@instacart.com',
};

// Returns the org's effective policy: defaults overlaid with any values stored
// in the settings table under `policy_*` keys.
function getPolicy(db) {
  const out = {
    HOURLY_RATE_DEFAULT:    POLICY.HOURLY_RATE_DEFAULT,
    MILEAGE_RATE:           POLICY.MILEAGE_RATE,
    HOURS_PER_10_CARTS:     { ...POLICY.HOURS_PER_10_CARTS },
    MEAL_DAILY_CAP:         POLICY.MEAL_DAILY_CAP,
    MEAL_TRIP_MIN_HOURS:    POLICY.MEAL_TRIP_MIN_HOURS,
    AP_EMAIL:               POLICY.AP_EMAIL,
  };
  if (!db) return out;
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'policy_%'").all();
  for (const r of rows) {
    const v = r.value;
    switch (r.key) {
      case 'policy_hourly_rate_default':   out.HOURLY_RATE_DEFAULT   = parseFloat(v); break;
      case 'policy_mileage_rate':          out.MILEAGE_RATE          = parseFloat(v); break;
      case 'policy_meal_daily_cap':        out.MEAL_DAILY_CAP        = parseFloat(v); break;
      case 'policy_meal_trip_min_hours':   out.MEAL_TRIP_MIN_HOURS   = parseFloat(v); break;
      // v0.23 — values are now hours per 10 carts. Old per-cart overrides
      // (policy_hours_per_cart_*) are auto-migrated on save (×10).
      case 'policy_hours_per_10_carts_deployment': out.HOURS_PER_10_CARTS.deployment = parseFloat(v); break;
      case 'policy_hours_per_10_carts_retrofit':   out.HOURS_PER_10_CARTS.retrofit   = parseFloat(v); break;
      case 'policy_hours_per_10_carts_maintenance': out.HOURS_PER_10_CARTS.maintenance = parseFloat(v); break;
      case 'policy_hours_per_10_carts_repair':     out.HOURS_PER_10_CARTS.repair     = parseFloat(v); break;
      case 'policy_ap_email':              out.AP_EMAIL              = v; break;
    }
  }
  return out;
}

function weekBounds(d = new Date()) {
  // v0.65.1 (F-M10) — compute Mon–Sun bounds entirely in UTC so the bucket is
  // stable regardless of server timezone. (Previously mixed local getters with
  // a UTC toISOString() slice, which could shift the week near midnight off-UTC.)
  const date = new Date(d);
  const day  = date.getUTCDay();
  const offsetToMon = day === 0 ? -6 : 1 - day;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() + offsetToMon);
  monday.setUTCHours(0,0,0,0);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    start: monday.toISOString().slice(0,10),
    end:   sunday.toISOString().slice(0,10),
  };
}

function invoiceNumber(userId, periodEnd) {
  // v0.65.1 (F-M10) — derive Y/M/D straight from the ISO date string to avoid a
  // timezone off-by-one (new Date('YYYY-MM-DD') is UTC midnight, and the local
  // getters could roll back a day for servers west of UTC).
  const [yyyy, mm, dd] = String(periodEnd).slice(0, 10).split('-');
  return `INV-${yyyy}-${mm}${dd}-U${String(userId).padStart(2,'0')}`;
}

function sumHours(entries) {
  let totalMs = 0;
  for (const e of entries) {
    const start = new Date(e.clock_in).getTime();
    const end   = e.clock_out ? new Date(e.clock_out).getTime() : Date.now();
    totalMs += (end - start) - (e.break_minutes || 0) * 60000;
    // v0.82 — an entry that is still running AND currently on break has an
    // in-progress break not yet folded into break_minutes; subtract it too so
    // the live total (and the frozen timer display) don't over-count.
    if (!e.clock_out && e.break_started_at) {
      totalMs -= Math.max(0, Date.now() - new Date(e.break_started_at).getTime());
    }
  }
  return Math.max(0, totalMs / 3600000);
}

function logAudit(db, { entity_type, entity_id, user_id, action, details }) {
  db.prepare(`INSERT INTO audit_log (entity_type, entity_id, user_id, action, details, timestamp)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(entity_type, entity_id, user_id || null,
         action, details ? JSON.stringify(details) : null, new Date().toISOString());
}

module.exports = {
  open, ensureSchema,
  POLICY, getPolicy, weekBounds, invoiceNumber, sumHours, logAudit,
  DB_PATH, SCHEMA_PATH,
  // v0.61 — exported so routes/corpcard.js can seed rules at category-create time
  // without duplicating the kinds list.
  CATEGORY_RULE_KINDS, TECH_EXPENSE_SUBCATS,
  DEFAULT_WORK_TYPES, activeWorkTypes,
};

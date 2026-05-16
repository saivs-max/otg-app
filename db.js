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
      work_type_filter  TEXT    CHECK (work_type_filter IS NULL OR work_type_filter IN ('deployment','retrofit','service','repair')),
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
  HOURS_PER_10_CARTS: { deployment: 7, retrofit: 7, service: 24, repair: 15 },
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
      case 'policy_hours_per_10_carts_service':    out.HOURS_PER_10_CARTS.service    = parseFloat(v); break;
      case 'policy_hours_per_10_carts_repair':     out.HOURS_PER_10_CARTS.repair     = parseFloat(v); break;
      case 'policy_ap_email':              out.AP_EMAIL              = v; break;
    }
  }
  return out;
}

function weekBounds(d = new Date()) {
  const date = new Date(d);
  const day  = date.getDay();
  const offsetToMon = day === 0 ? -6 : 1 - day;
  const monday = new Date(date);
  monday.setDate(date.getDate() + offsetToMon);
  monday.setHours(0,0,0,0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    start: monday.toISOString().slice(0,10),
    end:   sunday.toISOString().slice(0,10),
  };
}

function invoiceNumber(userId, periodEnd) {
  const d = new Date(periodEnd);
  const yyyy = d.getFullYear();
  const mmdd = String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  return `INV-${yyyy}-${mmdd}-U${String(userId).padStart(2,'0')}`;
}

function sumHours(entries) {
  let totalMs = 0;
  for (const e of entries) {
    const start = new Date(e.clock_in).getTime();
    const end   = e.clock_out ? new Date(e.clock_out).getTime() : Date.now();
    totalMs += (end - start) - (e.break_minutes || 0) * 60000;
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
};

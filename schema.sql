-- OTG Field Cost App — v0.1 schema
-- SQLite

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  email           TEXT    UNIQUE NOT NULL,
  role            TEXT    NOT NULL CHECK (role IN ('technician','ops_manager','sr_manager','pm')),
  worker_type     TEXT    CHECK (worker_type IN ('contractor','fte')),
  hourly_rate     REAL    DEFAULT 40.0,
  ops_manager_id  INTEGER REFERENCES users(id),
  -- Profile fields used to render the formal contractor invoice header
  home_address    TEXT,
  home_phone      TEXT,
  -- v0.35 — real authentication. Username + scrypt password hash. The
  -- `must_change_password` flag is set on admin-issued temp passwords; the
  -- UI blocks the user from navigating until they update it.
  username                TEXT UNIQUE,
  password_hash           TEXT,         -- "salt:N:r:p:hex(scryptKey)"
  password_set_at         TEXT,
  must_change_password    INTEGER DEFAULT 0,
  status                  TEXT DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_login_at           TEXT
);

-- Active session tokens. Generated on /api/login, deleted on /api/logout, and
-- expire after the TTL set in auth.js (default 30 days).
CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  user_agent   TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS work_orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id       TEXT    UNIQUE NOT NULL,                  -- canonical local key (MX-RPR-97461873)
  source_system     TEXT    NOT NULL CHECK (source_system IN ('maintainx','freshdesk')),
  source_ticket_id  TEXT,                                     -- raw ticket # in source system ("97461873", "13173")
  title             TEXT,                                     -- original ticket title from source ("Queens 4 - Cart #5 Not Powering On")
  work_type         TEXT    NOT NULL CHECK (work_type IN ('deployment','retrofit','maintenance','repair')),
  store_id          TEXT,
  store_name        TEXT,
  store_address     TEXT,
  cart_count        INTEGER DEFAULT 0,
  scheduled_date    TEXT,
  description       TEXT,
  status            TEXT    DEFAULT 'open' CHECK (status IN ('open','in_progress','completed','cancelled')),
  assigned_user_id  INTEGER REFERENCES users(id),
  created_at        TEXT    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wo_assigned ON work_orders(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_wo_status   ON work_orders(status);

CREATE TABLE IF NOT EXISTS invoices (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number    TEXT    UNIQUE NOT NULL,
  user_id           INTEGER NOT NULL REFERENCES users(id),    -- the technician this invoice is FOR
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
  -- v0.25: Final hand-off to Accounts Payable. Triggered after approved_sr by
  -- the tech, ops_mgr, sr_mgr, or pm. Captures who sent, when, and which AP
  -- email it went to (the real send is mocked — see notifications table).
  sent_to_ap_at     TEXT,
  sent_to_ap_by     INTEGER REFERENCES users(id),
  ap_email_to       TEXT,
  -- v0.32 — Ops Mgr can escalate a flagged invoice for Sr Mgr secondary approval.
  -- When `escalated_at` is set, Sr Mgr countersign becomes REQUIRED before the
  -- invoice can be sent to AP. Sr Mgr's queue surfaces escalated items first.
  escalated_at      TEXT,
  escalated_by      INTEGER REFERENCES users(id),
  escalation_note   TEXT,
  -- v0.36 — 3rd-party vendor invoices uploaded by Ops Mgr. These bypass the
  -- Ops Mgr review step (since the Ops Mgr uploaded them) and go directly to
  -- Sr Mgr for secondary approval. invoice_type discriminates from the normal
  -- tech-labor flow so the dashboard can break out vendor spend separately.
  invoice_type          TEXT    DEFAULT 'tech_labor' CHECK (invoice_type IN ('tech_labor','vendor')),
  vendor_name           TEXT,
  vendor_invoice_number TEXT,
  vendor_invoice_date   TEXT,
  notes             TEXT,
  -- Audit columns: who actually created the invoice and how (tech-self vs mgr-uploaded)
  created_by        INTEGER REFERENCES users(id),
  origin            TEXT    DEFAULT 'tech_self' CHECK (origin IN ('tech_self','mgr_upload','csv_import')),
  -- Auto-extraction from uploaded PDF: raw text + structured JSON summary
  -- (header info, candidate ticket IDs, line items, totals). Populated by
  -- /invoices/upload when the attachment is a PDF.
  extracted_text    TEXT,
  extracted_summary TEXT,
  extracted_at      TEXT,
  created_at        TEXT    DEFAULT CURRENT_TIMESTAMP
);

-- Ops Manager ↔ Technician team membership. A tech can belong to multiple
-- managers' teams; a manager owns multiple techs. Default-seeded from the
-- legacy users.ops_manager_id field but overridable via the in-app Team UI.
CREATE TABLE IF NOT EXISTS manager_team (
  manager_user_id  INTEGER NOT NULL REFERENCES users(id),
  tech_user_id     INTEGER NOT NULL REFERENCES users(id),
  added_at         TEXT    DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (manager_user_id, tech_user_id)
);

CREATE INDEX IF NOT EXISTS idx_team_mgr  ON manager_team(manager_user_id);
CREATE INDEX IF NOT EXISTS idx_team_tech ON manager_team(tech_user_id);

-- Custom validation rules layered ON TOP of the built-in policy defaults.
-- Ops Manager can add/remove. Rules trigger flags on invoices when violated.
CREATE TABLE IF NOT EXISTS custom_rules (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- What this rule checks. New types can be added by extending the validator.
  rule_type         TEXT    NOT NULL CHECK (rule_type IN (
                      'max_hours_per_shift',     -- single time-entry can't exceed N hrs
                      'max_hours_per_day',       -- combined hrs on a single date
                      'max_drive_hours_per_day',
                      'max_miles_per_day',
                      'max_expense_amount',      -- single expense > N (per category, optional)
                      'require_receipt_above',   -- expenses > N must have a receipt attached
                      'max_hours_per_wo',        -- total labor hrs on a WO line can't exceed N
                      'max_hours_per_cart',      -- legacy: labor hrs / cart_count > threshold
                      'max_hours_per_10_carts'   -- v0.23: labor hrs / (cart_count/10) > threshold
                    )),
  -- Optional work-type filter; NULL = applies to all work types.
  work_type_filter  TEXT    CHECK (work_type_filter IS NULL OR work_type_filter IN ('deployment','retrofit','maintenance','repair')),
  -- Optional expense category filter (only meaningful for expense-related rules)
  category_filter   TEXT,
  -- Optional minimum cart count: rule fires only when WO has >= this many carts.
  -- Lets managers say "Deployment with 10+ carts can't exceed 14 hrs of labor".
  cart_count_min    INTEGER,
  threshold         REAL    NOT NULL,
  description       TEXT,
  severity          TEXT    DEFAULT 'flag' CHECK (severity IN ('warn','flag','block')),
  active            INTEGER DEFAULT 1,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rules_active ON custom_rules(active);

CREATE INDEX IF NOT EXISTS idx_invoice_user   ON invoices(user_id, status);
CREATE INDEX IF NOT EXISTS idx_invoice_period ON invoices(user_id, period_start);

CREATE TABLE IF NOT EXISTS time_entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  work_order_id     INTEGER NOT NULL REFERENCES work_orders(id),
  clock_in          TEXT    NOT NULL,
  clock_out         TEXT,
  break_minutes     INTEGER DEFAULT 0,
  -- "work" = on-site work, "drive" = travelling to/from job (not paid as labor)
  mode              TEXT    NOT NULL DEFAULT 'work' CHECK (mode IN ('work','drive')),
  notes             TEXT,
  -- GPS capture for audit trail (PRD §4.3)
  gps_lat_in        REAL,
  gps_lng_in        REAL,
  gps_accuracy_in   REAL,                              -- meters
  gps_lat_out       REAL,
  gps_lng_out       REAL,
  gps_accuracy_out  REAL,
  invoice_id        INTEGER REFERENCES invoices(id),
  -- v0.67 — MaintainX sync provenance. 'app' = worker-entered (source of truth
  -- for labor); 'maintainx_sync' = labor imported from MaintainX, idempotent
  -- via external_ref. See lib/maintainx/labor.js.
  source            TEXT    DEFAULT 'app',
  external_ref      TEXT,
  created_at        TEXT    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_time_user    ON time_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_time_invoice ON time_entries(invoice_id);
CREATE INDEX IF NOT EXISTS idx_time_open    ON time_entries(user_id, clock_out);

CREATE TABLE IF NOT EXISTS expenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  work_order_id   INTEGER NOT NULL REFERENCES work_orders(id),
  -- Top-level categories. Most are self-explanatory; "other" is a parent that
  -- requires a `subcategory` value (Meal, Tools, Hotel, Supplies, Misc, ...).
  category        TEXT    NOT NULL CHECK (category IN ('mileage','tolls','parking','vendor','other')),
  subcategory     TEXT,                   -- only used when category='other'
  expense_date    TEXT    NOT NULL,
  amount          REAL    NOT NULL,
  quantity        REAL,
  rate            REAL,
  description     TEXT,
  receipt_path    TEXT,
  invoice_id      INTEGER REFERENCES invoices(id),
  created_at      TEXT    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_expense_user    ON expenses(user_id);
CREATE INDEX IF NOT EXISTS idx_expense_invoice ON expenses(invoice_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type   TEXT NOT NULL,
  entity_id     INTEGER NOT NULL,
  user_id       INTEGER REFERENCES users(id),
  action        TEXT NOT NULL,
  details       TEXT,
  timestamp     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);

-- Org-level settings (shared across all users): API keys, etc.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Receipt / file attachments. Can be linked to any of: invoice, expense,
-- time_entry, work_order. Files live on disk under data/receipts/.
CREATE TABLE IF NOT EXISTS attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  invoice_id      INTEGER REFERENCES invoices(id),
  expense_id      INTEGER REFERENCES expenses(id),
  time_entry_id   INTEGER REFERENCES time_entries(id),
  work_order_id   INTEGER REFERENCES work_orders(id),
  storage_name    TEXT NOT NULL,         -- the on-disk filename (uuid.ext)
  original_name   TEXT NOT NULL,
  mime_type       TEXT,
  size_bytes      INTEGER,
  caption         TEXT,
  uploaded_at     TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_att_invoice ON attachments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_att_expense ON attachments(expense_id);
CREATE INDEX IF NOT EXISTS idx_att_time    ON attachments(time_entry_id);
CREATE INDEX IF NOT EXISTS idx_att_user    ON attachments(user_id);

-- v0.25 — outbound notifications log. Real email isn't wired in dev, but every
-- "send to AP" event records what would have been sent so the audit trail is
-- complete and the UI can show "email sent ✓" with the recipient + timestamp.
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,                            -- e.g. 'invoice_to_ap'
  invoice_id    INTEGER REFERENCES invoices(id),
  triggered_by  INTEGER REFERENCES users(id),
  recipient     TEXT,                                     -- email address
  subject       TEXT,
  body          TEXT,                                     -- text/markdown of the email body
  attachment_id INTEGER REFERENCES attachments(id),       -- the generated PDF
  status        TEXT DEFAULT 'logged' CHECK (status IN ('logged','sent','failed')),
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notif_invoice ON notifications(invoice_id);

-- v0.37 — Launch Actuals submissions. Ops Mgrs are required to file weekly
-- "launch support" hours per store via a Google Form; this table is our
-- local record of what was prepared/submitted so we don't double-file and
-- so the dashboard can show what's outstanding.
CREATE TABLE IF NOT EXISTS launch_actuals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id),     -- the submitter (Ops Mgr)
  email               TEXT,                                       -- denormalized at submit time
  week_ending         TEXT NOT NULL,                              -- YYYY-MM-DD (Sunday)
  store_id            TEXT,
  store_name          TEXT,
  team                TEXT DEFAULT 'HardwareOps',
  role                TEXT,                                       -- e.g. 'Ops Manager'
  supporting          TEXT,                                       -- "What are you supporting" — e.g. 'New Store Launch', 'Retrofit'
  hours_spent         REAL DEFAULT 0,                             -- pulled from time_entries for the week+store
  additional_hours    REAL DEFAULT 0,                             -- ad-hoc extra
  hours_type          TEXT,                                       -- 'Regular' / 'Overtime'
  brief_description   TEXT,
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  prefill_url         TEXT,                                       -- the Google Form prefill URL we generated
  submitted_at        TEXT,
  created_at          TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, week_ending, store_id)
);

CREATE INDEX IF NOT EXISTS idx_la_user_week ON launch_actuals(user_id, week_ending);
CREATE INDEX IF NOT EXISTS idx_la_store     ON launch_actuals(store_id);

-- v0.42 — Per-WO Cost Tracker overrides. The Cost Tracker view computes
-- rows on the fly from work_orders + time_entries + expenses, but Ops
-- Mgrs need to fill in / correct values that aren't in the system yet
-- (PM DRI / Ops Mgr names, manual labor entries from off-app work, 3rd
-- party vendor cost attribution, notes, etc.). Anything written here
-- coalesces over the computed value when the row is rendered.
CREATE TABLE IF NOT EXISTS cost_tracker_overrides (
  work_order_id        INTEGER PRIMARY KEY REFERENCES work_orders(id),
  cost_reconciled      TEXT,    -- 'Yes' / 'No'
  pm_dri               TEXT,
  ops_manager          TEXT,
  num_techs            INTEGER,
  tech_names           TEXT,
  actual_labor         REAL,
  actual_travel        REAL,    -- drive-time labor + travel expenses (mileage/tolls/parking)
  actual_expenses      REAL,    -- v0.66.2 — non-travel expenses (materials/'other'/vendor/misc)
  service_delay        TEXT,
  has_third_party      INTEGER, -- 0/1
  third_party_vendor   TEXT,
  third_party_cost     REAL,
  notes                TEXT,
  updated_by           INTEGER REFERENCES users(id),
  updated_at           TEXT DEFAULT CURRENT_TIMESTAMP
);

-- v0.60 — Corporate-card ledger. Lives entirely separate from the tech-paid
-- expenses table so corp-card spend can NEVER end up on a reimbursable
-- invoice. Only ops_manager / sr_manager / pm roles can write here.
--
-- corp_card_categories — managed list of spend buckets (Travel, Hotel,
-- Events, Meals, Software, …). Both ops_manager and sr_manager can add or
-- archive categories. Soft-delete via `archived_at`, never hard-delete, so
-- existing expenses keep their category name even after the category is
-- retired.
CREATE TABLE IF NOT EXISTS corp_card_categories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  archived_at  TEXT,                       -- soft delete; NULL = active
  archived_by  INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_cc_cat_active ON corp_card_categories(archived_at);

-- corp_card_expenses — the ledger itself. Every row represents a single
-- corporate-card charge filed by a manager. `on_behalf_of_user_id` is the
-- tech the spend is associated with (e.g. "Aramiwale's hotel for the NJ
-- launch"); nullable for Sr-Mgr-level events that aren't attributable to
-- one tech. `work_order_id` is optional context; `store_name` is
-- denormalized from the WO at write time so we keep historical context
-- even if the WO is later edited or deleted.
CREATE TABLE IF NOT EXISTS corp_card_expenses (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by_user_id   INTEGER NOT NULL REFERENCES users(id),
  on_behalf_of_user_id INTEGER REFERENCES users(id),
  work_order_id        INTEGER REFERENCES work_orders(id),
  store_name           TEXT,
  category_id          INTEGER NOT NULL REFERENCES corp_card_categories(id),
  expense_date         TEXT NOT NULL,
  amount               REAL NOT NULL,
  description          TEXT,
  created_at           TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_cc_exp_date     ON corp_card_expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_cc_exp_cat      ON corp_card_expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_cc_exp_creator  ON corp_card_expenses(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_cc_exp_tech     ON corp_card_expenses(on_behalf_of_user_id);
CREATE INDEX IF NOT EXISTS idx_cc_exp_wo       ON corp_card_expenses(work_order_id);

-- v0.61 — Per-category rules + per-work-order budgets.
--
-- category_rules: every category (corp-card OR tech-expense subcategory)
-- gets exactly three editable rule rows auto-seeded at creation time:
--   • per_wo_cap                 — $ cap that applies per work order
--   • global_cap                 — single $ cap across the whole org
--   • receipt_required_above     — receipt required when an item is over $X
-- amount is NULL until the admin sets it; a NULL amount means the rule is
-- defined but inactive.
--
-- category_key is intentionally TEXT so a single table can address both
-- managed corp_card_categories (stringified id) and the hard-coded
-- tech-expense subcategory enum ('Meal','Tools','Hotel','Supplies','Misc').
CREATE TABLE IF NOT EXISTS category_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  category_source TEXT NOT NULL CHECK (category_source IN ('corp_card','tech_expense')),
  category_key    TEXT NOT NULL,
  rule_kind       TEXT NOT NULL CHECK (rule_kind IN ('per_wo_cap','global_cap','receipt_required_above')),
  amount          REAL,
  updated_by      INTEGER REFERENCES users(id),
  updated_at      TEXT,
  UNIQUE (category_source, category_key, rule_kind)
);

CREATE INDEX IF NOT EXISTS idx_cat_rules_lookup ON category_rules(category_source, category_key);

-- wo_category_budgets: a $ cap on spend for a specific (work_order, category)
-- pair. Overspend is flagged at the policy-engine layer (see lib/rules.js /
-- routes/invoices.js follow-up integration).
CREATE TABLE IF NOT EXISTS wo_category_budgets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id   INTEGER NOT NULL REFERENCES work_orders(id),
  category_source TEXT NOT NULL CHECK (category_source IN ('corp_card','tech_expense')),
  category_key    TEXT NOT NULL,
  amount_cap      REAL NOT NULL,
  updated_by      INTEGER REFERENCES users(id),
  updated_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (work_order_id, category_source, category_key)
);

CREATE INDEX IF NOT EXISTS idx_wo_cat_budget_wo  ON wo_category_budgets(work_order_id);
CREATE INDEX IF NOT EXISTS idx_wo_cat_budget_cat ON wo_category_budgets(category_source, category_key);

-- v0.62 — Managed work types. Replaces the hard-coded
-- deployment/retrofit/service/repair enum that lived on work_orders.work_type
-- and custom_rules.work_type_filter. Both CHECK constraints are dropped by
-- migrateWorkTypeChecks() in db.js (table rebuild) so admin-added types
-- become valid values. Soft-archive matches the corp_card_categories pattern.
CREATE TABLE IF NOT EXISTS work_types (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  archived_at  TEXT,
  archived_by  INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_work_types_active ON work_types(archived_at);

-- v0.67 — MaintainX work-order sync (per-worker pull + labor import).
-- Each worker connects their own MaintainX account; the access token is stored
-- encrypted (AES-256-GCM) and never returned to the client. See lib/maintainx/.
CREATE TABLE IF NOT EXISTS user_integrations (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                 INTEGER NOT NULL REFERENCES users(id),
  provider                TEXT    NOT NULL DEFAULT 'maintainx',
  mx_user_id              TEXT,                       -- assignee id used to scope the worker's WOs
  mx_org_id               TEXT,
  access_token_enc        TEXT    NOT NULL,           -- AES-256-GCM ciphertext; never returned
  token_type              TEXT    DEFAULT 'api_key',  -- 'api_key' | 'demo'
  status                  TEXT    DEFAULT 'active' CHECK (status IN ('active','needs_reauth','disabled')),
  last_sync_at            TEXT,
  last_error              TEXT,
  connected_at            TEXT    DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, provider)
);

-- Per-WO sync metadata + labor reconciliation state. PK on (provider,
-- mx_workorder_id) gives upsert-by-MaintainX-id idempotency.
CREATE TABLE IF NOT EXISTS wo_sync_state (
  work_order_id     INTEGER REFERENCES work_orders(id),
  provider          TEXT    NOT NULL DEFAULT 'maintainx',
  mx_workorder_id   TEXT    NOT NULL,
  mx_sequential_id  INTEGER,
  mx_status         TEXT,
  mx_updated_at     TEXT,
  last_pulled_at    TEXT,
  last_pushed_at    TEXT,                             -- reserved for the deferred writeback phase
  labor_direction   TEXT,                             -- 'pull' | 'app_wins' | 'none'
  labor_minutes     INTEGER,
  labor_synced_at   TEXT,
  content_hash      TEXT,
  PRIMARY KEY (provider, mx_workorder_id)
);
CREATE INDEX IF NOT EXISTS idx_user_integrations_user ON user_integrations(user_id);
CREATE INDEX IF NOT EXISTS idx_wo_sync_state_wo        ON wo_sync_state(work_order_id);


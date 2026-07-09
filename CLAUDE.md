# CLAUDE.md — OTG / Caper Field-Cost app

Project context for Claude. Field-cost tracking app: techs log labor / drive /
expenses → invoices → AP approval pipeline → **Cost Tracker** reconciliation.
Node backend + vanilla-JS SPA (`public/app.js`).

## Repo & deploy
- GitHub: `github.com/saivs-max/otg-app`, branch `main`. Git auth via osxkeychain.
- **Deploy is automatic**: push to `main` → GitHub Actions `.github/workflows/fly-deploy.yml`
  → `flyctl deploy --remote-only` to Fly app **`breadapp`** (region `lax`).
  Docs-only changes (`**.md/.docx/.pptx/.xlsx/.csv`) skip the deploy.
- `flyctl` is **not** installed in the sandbox — deploy only happens via push → CI.
- DB migrations run on boot through `ensureSchema()` in `db.js`, so schema changes
  apply to the prod SQLite volume automatically on deploy.

## Runtime
- Node + `node:sqlite` → needs flags `--experimental-sqlite --no-warnings=ExperimentalWarning`
  (see package.json `start`). DB file `data/otg.db`; schema in `schema.sql`.
- Add a column: drop a `migrateAddColumn(db, table, col, type)` call inside
  `ensureSchema()` in `db.js` (idempotent) AND add it to `schema.sql` for fresh DBs.
- Tests: `npm run test:invoices`, `npm run test:maintainx`.

## Sandbox gotchas (this environment only)
- `node:sqlite` **writes** against the mounted repo fail with `disk I/O error`.
  To test DB writes, copy `data/otg.db` to `/tmp` and run there.
- Files under `.git` can be undeletable from the sandbox (EPERM) — git lock files
  must be cleared by the user on their Mac, not from here.

## Cost model — key logic
- `routes/dashboard.js`:
  - `buildCostTrackerRows()` — the Cost Tracker tab rows. Cost is split four ways:
    **Act Labor** (work-mode time **+ labor logged as an expense**), **Act Travel**
    (drive-mode time + mileage/tolls/parking expenses **+ drive logged as an
    expense**), **Act Expenses** (other expenses: materials/'other'/vendor),
    **Act Total** = Labor + Travel + Expenses + 3P. Manual edits overlaid from
    `cost_tracker_overrides`. **v0.67 — labor/drive logged via the expense tab
    (`category='labor'/'drive'`, `quantity`=hours) fold into Act Labor/Travel just
    like the invoice does, so manually-logged labor is never missed. Resolved
    per (WO, tech): when a tech has BOTH clocked time AND a manual labor/drive
    expense, the manual entry WINS and replaces that tech's clock (no double-count);
    another tech's clocked time on the same WO is still counted.**
  - **v0.67 — APPROVED-ONLY actuals (source of truth).** Labor/drive/expense lines
    count toward a WO's cost only when their invoice status ∈
    `('approved_ops','approved_sr','queued_ap','sent_ap')` (constant `APPROVED`). A
    row contributes to **totals** only when `in_totals` = (WO `completed` AND has an
    approved-invoice line) **OR** a manager cost override exists (overrides always
    apply, approved or not). Otherwise `pending_approval` = true: the row still shows
    (so in-flight work is visible) but is excluded from every total and renders ⏳ / $0.
  - **v0.67 — no dropped rows.** Each row gets an effective month = `scheduled_date →
    latest work-entry date → created_at`, so completed-off-schedule WOs land in a real
    month; the monthly aggregate also has an `Unscheduled` safety bucket. Result:
    monthly grand total === Σ of every counted row's Act Total === footer/summary total.
  - **v0.67 — every work type broken out.** `aggregateCostTrackerByMonth` returns
    `{ rows:[{month, by_type, actual_total, wo_count}], totals:{by_type, actual,
    wo_count}, types }` where `types` is the ordered set of work types present
    (`orderedServiceTypes`: deployment/retrofit/maintenance/repair lead, custom types
    follow alphabetically). The DASHBOARD renders one column per type — nothing is
    lumped into "Other" anymore.
  - **v0.67 — no accidental freezing.** Rows expose a raw `override` object (null when
    a field isn't explicitly overridden). The edit modal pre-fills Labor/Travel/
    Expenses/3P/#Techs **only** from `override`, never from computed values — so saving
    the modal for an unrelated field (notes, PM DRI) no longer snapshots/freezes
    computed actuals, and later-added approved labor/expenses keep summing in.
  - `buildSubmittedApprovedInvoicesByStore()` — AP-pipeline "visits" (one row per
    invoice×WO), still **submitted + approved** (this is the in-flight pipeline view,
    intentionally broader than the approved-only tracker totals).
  - **Reconciliation rule**: tracker Act Total per WO must equal invoice visit_total
    (for approved invoices).
- Exports just consume `buildCostTrackerRows` output (no recompute):
  XLSX `buildDashboardWorkbook` (COST TRACKER MAIN sheet) and
  Google Sheets `lib/google_sheets.js → pushDashboardToSheet`. Both gate the DASHBOARD
  aggregate on `pending_approval` and append a **TOTAL (approved actuals)** row to the
  MAIN sheet. Actual Total formula = `SUM(K,L,M,P)` = Labor, Travel, Expenses, 3P.
- Frontend: `public/app.js → renderCostTracker()` (table + columns + summary band +
  `<tfoot>` totals over the filtered, non-pending set) and the row edit modal
  (`ctEdLabor` / `ctEdTravel` / `ctEdExpenses` / `ctEd3pCost`).

## Conventions
- Version tags in comments, e.g. `v0.66.2`.
- `cost_tracker_overrides` columns: actual_labor, actual_travel, actual_expenses,
  third_party_cost, … edited via `PATCH /cost-tracker/:wo_id`.
- **Vendor PDF parser (v0.74)**: `lib/vendorPdfExtractor.js`. `findLineItems` runs
  every shape (A0 Kept-glued, D reordered/glued product table e.g. TRUNO, E clean
  DESCRIPTION/QTY/UNIT/TOTAL table, A/A2 Crystal, B classic, C qty) then picks the
  set whose amounts sum to the printed Subtotal (`findSubtotal`), else the most
  rows — add new layouts as another extractor in that list. Header parsing also
  handles Proposal/Quote #s and textual dates ("24th June 2026"). **Image-only
  PDFs (no text layer, e.g. a single full-page JPEG) now go through OCR
  (`lib/ocr.js`): pdftoppm rasterizes the page → tesseract (TSV) → rows rebuilt by
  word y-coordinate → same parser. Needs `poppler-utils`+`tesseract-ocr` (added to
  the Dockerfile); if absent OCR degrades gracefully to `scanned_pdf`/manual
  entry. `extractVendorPdf` returns `ocr:true` when used.** Parsed `line_items`
  render in the vendor invoice detail table and are **editable** on a draft via
  "🧾 Edit line items" → `openVendorLineItemsSheet` → `PATCH
  /invoices/:id/vendor-line-items` (writes `extracted_summary.line_items`; invoice
  Total stays the source of truth, never auto-overwritten). **v0.75 —
  `findVendorName` NEVER guesses: it returns a name only from an explicit
  From/Vendor/Remit-To/Supplier label or a clear company suffix (LLC/Inc/Corp/…),
  else null (no generic-keyword/positional heuristics). The upload + edit forms
  use a real `<select>` of saved vendors + a text input for a new one (not a
  datalist, which some webviews wouldn't open).
- **Vendors (v0.73)**: `vendors` master table (name UNIQUE COLLATE NOCASE +
  default_category/notes/archived_at). Auto-saved via `upsertVendor()` on
  vendor-upload + vendor-update; backfilled from existing `invoices.vendor_name`
  on boot (`db.js`). `GET /vendors` lists them (with usage count/spend) for the
  3rd-party filter dropdown and the form's vendor autocomplete (`vnName`/`veName`
  datalists). Vendor-invoice `total`/`vendor_name` are the source of truth — the
  detail GET never recomputes/zeros them (v0.72.1), and an empty `vendor_name` on
  vendor-update is ignored so a stored name can't be blanked.
- Expense categories: `mileage, tolls, parking, travel` (→ Act Travel), `other`,
  `vendor` (→ Act Expenses), `labor` (→ Act Labor), `drive` (→ Act Travel). The
  v0.54 expense tab lets techs log labor/drive as expenses with `quantity`=hours,
  `rate`=hourly, `amount`=hours×rate; the tracker, exports and AP-pipeline visit
  totals all fold these into labor/travel (WO detail shows them under Time, not
  Expenses). Reconciliation: tracker Act Total per WO === invoice visit_total.

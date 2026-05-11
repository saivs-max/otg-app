# OTG Field Cost App — v0.6 (Technician)

Local dev build of the technician persona for the **OTG Cost Tracking Modernization** project.
Lets a field tech clock in/out against a Freshdesk or MaintainX work order, log mileage and other expenses, and submit a weekly invoice.

This is the working software side of the [PRD](../OTG_FieldCost_App_PRD.docx) and [wireframes](../OTG_FieldCost_App_Wireframes.html).

---

## What's new in v0.6

- **Map view** in the app — pins for every clock-in (green) and clock-out (orange), connected by a dashed line, with popups showing WO ID, store, time, and duration. Filter by week / 30 days / all time. Powered by Leaflet + OpenStreetMap (no API key required, no tracking).
- **Bigger, cleaner UI** — base font 16px, 48px+ tap targets, larger buttons, generous padding, deeper shadows and softer corners. Designed to be readable for older eyes without looking childish.
- **Real Instacart-style branding** — refined gradient carrot mark, deep-green chrome, warm cream surfaces, grocery-themed inline SVG tab icons (cart, clock, basket-cart, map, document) replacing emoji.
- **Map tab** replaces the standalone Add tab (Add Expense lives on the Current invoice screen anyway, with a clear "+ Add an expense" button).

## What's new in v0.5

- **Retroactive shift logging.** Forgot to clock in? Tap "Log a past shift" on the Timer screen. Pick a work order, date, start/end time, breaks, notes. The hours land on the invoice covering that week — a previous-week draft is created automatically if needed.
- **Better location pull from FD/MX.** Integration now grabs store name, store number/ID, and address from a wider set of custom-field names plus regex fallback against the ticket subject/body.
- **Description = ticket body.** When you Pull a ticket, the description field is filled with the actual ticket description (not just the subject).
- **MaintainX endpoint fix.** Corrected the API path to `/v1/work-orders/{id}` (kebab-case) — required for live integration.
- **New `store_address` column** in work_orders to capture the full street address from the source system.

## What's new in v0.4

- **Real Freshdesk + MaintainX integration.** Pasting a ticket URL hits the actual API and pre-fills the Add Work Order form.
- **Org-level settings UI** — credentials are configured *once* through the app (gear icon top-right → Settings) and shared by every technician. No more editing `.env` files. Keys are masked everywhere they appear.
- Lookup order: in-app settings → `.env` (legacy) → dev stub. Falls back gracefully so the app keeps working without credentials.

## What's new in v0.3

- **Concurrent timers** — clock in to multiple work orders at once (e.g., two jobs at the same store). Each ticks independently.
- **Paste a Freshdesk / MaintainX URL** in Add Work Order and the form auto-fills (stubbed in dev; swap to real API by adding keys + replacing `stubFetchTicket()`).
- **GPS Maps links** — every captured location now shows a "View on map ↗" link to Google Maps. Visible on the timer screen and on every time entry in the edit sheet.
- **Editable hourly rate** — change it inline on the Current invoice ("change rate"); persists to your profile.
- **By-date totals** for AP — Current invoice shows a "Daily totals" table; the formal preview leads with by-date and shows by-WO underneath.
- **Invoice context on Add Expense** — banner shows which invoice you're posting to.
- **Searchable WO picker** on Add Expense.
- **Tabs renamed** — "Invoice" → Current, "Mine" → Previous (only non-draft invoices live here).
- **Instacart branding** — carrot mark, deeper green chrome, warm cream surfaces.

## What's in v0.2

- **3 seeded technicians** (Aramiwale, Carlos, Priya) — sign in via the user picker
- **9 seeded work orders** mixing MaintainX (deployments + retrofits) and Freshdesk (service + repair)
- **Add-your-own work order** — paste a Freshdesk or MaintainX ticket inline if it hasn't synced yet
- **Time tracking** with GPS capture at clock-in and clock-out (browser will ask for location permission)
- **Expense entry** for all 7 categories with policy enforcement at write time:
    - Mileage rate locked at $0.725/mi (IRS)
    - Meals capped at $100/day
    - Labor flagged when > 1.5× expected hours-per-cart
- **Auto-rolling weekly invoice** with rich editing:
    - Edit or delete expense lines inline
    - Edit time-entry break minutes / notes
    - Add an expense to a specific WO from the invoice screen
    - Bottom-sheet edit forms for clean mobile UX
- **Submit flow** with required justification when any line is flagged
- **My Invoices** browser:
    - Active vs. Completed sections
    - Tappable preview that mirrors the formal contractor PDF / Expensify layout
    - Prev/Next navigation between invoices
    - Full approval-trail visualization (Ops Mgr → Sr Mgr → AP → Paid)
- **Dismissable alerts** — every alert and toast can be tapped to dismiss
- **CSV importer** for real work-order data when you have it
- **SQLite-backed**, single-process, single-machine — no external services

What's *not* in v0.2: Ops Manager dashboard, Sr Manager queue, AP export, photo upload, offline / PWA, real SSO. Those are next.

---

## Run it

### Requirements
- **Node.js 22.5 or newer** (uses the built-in `node:sqlite` module — no native compilation, no separate DB install)

### First time
```bash
cd otg-app
npm install
npm run seed        # creates data/otg.db with mock users + work orders
npm start
```
Then open http://localhost:3000 in your browser. Phone-shaped frame on desktop; full-screen on mobile.

### Day-to-day
```bash
npm start           # start the server (re-uses existing data)
npm run reset       # wipe & re-seed the DB (use when schema changes or you want a fresh slate)
```

---

## Test the technician flow end-to-end

1. **Open** http://localhost:3000 → pick **Aramiwale Shittu** from the user picker.
2. You'll land on **Today**. Notice he already has an active timer running on `MX-RTR-2406-127` (Whole Foods Edgewater retrofit) from a previous session.
3. Tap the **Open** button on the active-timer card → **Time Tracker** screen with the running clock. Tap **Clock Out**.
4. Tap the **+ Add** tab. Pick a category (e.g., Mileage), pick a work order, enter miles. Save.
5. Tap **Invoice**. You'll see the current week's draft invoice with all your time + expenses rolled up by work order. One line will be flagged (the Hackensack retrofit overran).
6. Try to **Submit** — you'll get an error asking for a justification.
7. Type a justification in the box and tap **Submit for Approval**.
8. Tap **Mine** → invoice now shows as Pending Ops with the approval trail visualized.
9. Sign out (top-right ⎋), pick **Carlos Martinez**, and verify his data is scoped only to him.

---

## Import your real work orders

When you have a CSV export from Freshdesk and/or MaintainX, drop it in and run:

```bash
npm run import-csv -- path/to/workorders.csv
```

A working sample is included as `sample-workorders.csv`.

### Expected CSV columns
Case-insensitive, in any order. Unknown columns are ignored.

| Column            | Required | Notes |
|-------------------|----------|-------|
| `external_id`     | yes      | The WO ID. Schema: `{SOURCE}-{TYPE}-{yymm}-{seq}`. Example: `MX-RTR-2406-127`. |
| `source_system`   | yes      | `maintainx` or `freshdesk` |
| `work_type`       | yes      | `deployment`, `retrofit`, `service`, `repair` |
| `store_id`        | no       | e.g., `WF-EDG` |
| `store_name`      | recommended | e.g., `Whole Foods Edgewater` |
| `cart_count`      | no       | integer; defaults to 0 |
| `scheduled_date`  | no       | `YYYY-MM-DD` |
| `description`     | recommended | One-line description of the work |
| `status`          | no       | `open` (default), `in_progress`, `completed`, `cancelled` |
| `assigned_email`  | no       | Email of the technician this WO is assigned to (must already exist in the DB) |

The importer is **upsert by `external_id`** — re-running with the same file is safe; existing rows are updated.

---

## Project layout

```
otg-app/
├── server.js              # Express app
├── db.js                  # SQLite handle + shared helpers + policy constants
├── schema.sql             # Tables, indexes, constraints
├── seed.js                # Wipe + load mock users / WOs / time / expenses
├── import-csv.js          # CSV → work_orders importer
├── sample-workorders.csv  # Example for the importer
├── routes/
│   ├── auth.js            # /api/users, /api/me   (header-based stand-in for SSO)
│   ├── workorders.js      # /api/workorders[/:id]
│   ├── timeentries.js     # /api/timeentries (active, list, clock-in, clock-out)
│   ├── expenses.js        # /api/expenses (list, create, delete)
│   └── invoices.js        # /api/invoices (list, current, get, submit) + computeInvoice()
├── public/                # Vanilla-JS SPA, mobile-first
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── data/otg.db            # SQLite file (created on first seed)
```

---

## API quick reference

All endpoints under `/api`. The "logged in" user is identified by the `x-user-id` header (the SPA sets this from `localStorage`).

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/users` | list all users (for the picker) |
| GET    | `/me` | current user |
| GET    | `/workorders` | WOs assigned to me; `?all=1` for everything |
| GET    | `/workorders/:id` | one WO |
| GET    | `/timeentries/active` | my running timer (or null) |
| GET    | `/timeentries` | all my time entries |
| POST   | `/timeentries` `{work_order_id}` | clock in |
| PATCH  | `/timeentries/:id` `{break_minutes?, notes?}` | clock out |
| GET    | `/expenses` | my expenses |
| POST   | `/expenses` `{work_order_id, category, expense_date, amount?/quantity?, description?}` | add expense |
| DELETE | `/expenses/:id` | remove a draft expense |
| GET    | `/invoices/current` | current week's draft, with computed lines + flags |
| GET    | `/invoices` | my invoice list |
| GET    | `/invoices/:id` | one invoice with computed lines |
| POST   | `/invoices/:id/submit` `{notes?}` | submit; returns 400 if flagged lines need justification |
| GET    | `/health` | uptime check |

---

## Connecting Freshdesk and MaintainX

The app pulls real ticket data when API keys are configured. With no keys, it uses dev-mode stubs — useful for clicking around before you wire up real accounts.

### Where to configure keys

Two options, in order of preference:

1. **Through the app UI (recommended).** Open the app, click the **gear icon ⚙ top-right → Settings → Integrations**. Paste your Freshdesk subdomain + API key, and your MaintainX API token. Hit save. Stored once at the org level — every technician's "Paste ticket URL" feature uses these.

2. **Via `.env` file.** Copy `.env.example` to `.env` and fill in `FRESHDESK_DOMAIN`, `FRESHDESK_API_KEY`, `MAINTAINX_API_KEY`. Useful if you'd rather keep secrets out of the database.

If both are set, the in-app settings win.

### Get a Freshdesk API key

1. Sign in to Freshdesk
2. Click your **profile picture** (top right) → **Profile Settings**
3. On the right side, click **Show your API Key** (you may have to re-enter your password)
4. Note your **subdomain** — e.g. for `https://acme.freshdesk.com` the subdomain is `acme`

### Get a MaintainX API token

1. Sign in to MaintainX
2. Click your **organization name** (bottom left) → **Settings**
3. Go to **Integrations → API Tokens**
4. Click **Create API Token**, name it "OTG Field Cost App", choose **read-only** permissions
5. Copy the token (only shown once)

### Test from the app

Add Work Order → paste a real ticket URL like `https://acme.freshdesk.com/a/tickets/12345` or `https://acme.maintainx.com/work-orders/789` → tap **Pull**. The form auto-fills. The "stub" warning banner only shows when no key is configured for that source.

### Notes

- *Tenant-specific custom fields:* the integration looks for a few common field names (`cart_count`, `cf_store`, etc.) for cart count and store. If your Freshdesk/MaintainX uses different names, edit the `pickCustomField()` calls in `routes/workorders.js` (lines marked with the field-name lists). Check what your tenant uses by hitting the API once with curl.
- *Rate limits:* Freshdesk caps standard plans at 50 requests/minute. MaintainX has its own limits. We make one call per ticket lookup, so this is fine for normal usage.
- *Don't commit `.env`:* it's in `.gitignore`. The keys never leave your machine.

---

## What's next

Once this lands and feels right, the planned next slices:

- **Ops Manager** screens: queue, invoice detail, one-tap approve, reject with reason, escalate to Sr Mgr
- **Senior Manager** skip-level queue (only flagged or > $5k)
- **Dashboard**: cost-by-work-type, top-stores-by-$/cart, approval-funnel KPIs
- **Forecasting**: weekly retrain, spend forecast, predicted hours per WO type, anomaly flags
- **AP export** in the format AP confirms (currently TBD per PRD §4.9)
- **GPS mileage** + receipt photo upload
- **Real SSO** (Okta) and proper sessions

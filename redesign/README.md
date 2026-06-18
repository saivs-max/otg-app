# Caper CostWise — Redesign v1.0

A ground-up redesign of the **OTG Field Cost App** — Instacart Cart Tech Operations' single system of record for field costs, from clock-in to AP payment. This package contains a **runnable React + Tailwind app**, a **self-contained interactive prototype**, and the **design/strategy spec** below.

> Lead designer's note: the brief was to *redesign*, not critique. This document states what the new product **is** and how to **adopt** it. The current app was used only to reverse-engineer personas, goals, and workflows, and to target the issues logged in the v0.64.5 QA · UX · Accessibility review (heuristics 4.3/10, accessibility 2/10).

---

## What's in this folder

```
redesign/
├── CaperCostWise_Redesign_Prototype.html   ← OPEN THIS. Self-contained, no install. Click through everything.
├── react-app/                              ← Production React + Tailwind source (Vite). Runnable & buildable.
│   ├── src/
│   │   ├── components/   ui.jsx (design system in code), charts.jsx, frames.jsx
│   │   ├── lib/          format.js (money + the ONE status vocabulary), icons.jsx
│   │   ├── data/         mock.js (realistic seed across every screen)
│   │   ├── pages/field/  9 technician screens (mobile)
│   │   ├── pages/console/ 11 manager/PM screens (desktop)
│   │   └── pages/system/ Overview · Design System · IA & Flows (the live spec)
│   ├── tailwind.config.js   ← design tokens (AA-verified)
│   └── package.json
├── adopt/
│   └── accessible-tokens.css  ← TIER-0 merge: drop-in WCAG fix for the CURRENT app
└── README.md (this file)
```

### Run the React app
```bash
cd react-app
npm install      # already installed in this package
npm run dev      # → http://localhost:5173
npm run build    # production build (verified: 65 modules, ~85 KB gzip JS)
```
The left rail switches personas and jumps to any of the 23 screens, the design system, and the IA/flow maps.

---

## ✅ Tier-2 merge — DONE (integrated into the app as v0.66.0)

The redesigned React app is now wired to the **live Express API** and served by the app itself at **`/v2`**, alongside the existing vanilla UI (untouched at `/`). Both share one backend and database, so the redesign can be piloted behind a flag while parallel work continues.

### Run the merged app
```bash
# from the app root (otg-app/)
npm run build:web     # builds redesign/react-app → web-dist/  (installs its deps first)
npm run seed:demo     # demo data (skip if you already have a DB)
npm start
#  →  http://localhost:3000      existing UI
#  →  http://localhost:3000/v2   redesigned app  (sign in: aramiwale / maitland / sai · password123)
```
During development you can instead run `cd redesign/react-app && npm run dev` (Vite proxies `/api` to `localhost:3000`).

### What changed in the app (additive, non-destructive)
- `server.js` — added a path-scoped `/v2` static mount + SPA fallback. `/` and `/api` are unchanged.
- `package.json` — added `build:web`; version → `0.66.0`.
- `redesign/react-app/` — the React app gained a **product mode** (`src/Product.jsx`, real login → role-routed Field app / Console) and a **live data layer** (`src/data/api.js`, `adapters.js`, `DataProvider.jsx`). The design-review explorer still runs on mock data.
- Nothing in `public/`, `routes/`, `db.js`, or the schema was modified.

### Security note (good news)
The v0.65.1 backend **already closed the `x-user-id` auth bypass** — identity is derived only from a validated Bearer token. The React app authenticates via `POST /api/login` and sends `Authorization: Bearer`. Verified live: a spoofed `x-user-id` with no token returns **401**.

### What's live vs. seed data (this first cut)
**Live (verified against the running API):** real login/session · `GET /me` · invoices list & current invoice · invoice detail + approval trail · approvals queue · approve / reject / submit · dashboard KPIs + spend-by-work-type · work-order picker · clock-in/out & add-expense write actions.
**Still on seed data (fast-follow, clearly isolated in `mock.js`):** dashboard category/forecast/anomaly widgets, Corp Card, Cost tracker, Team, Policy, Users/Admin, AP export, Settings. Each maps to existing endpoints; the `DataProvider` falls back to mock so nothing renders empty.

> Verification performed: production build (68 modules), all 30 screens server-render without error in both mock and live-provider contexts, and the adapters were run against **real** API JSON (e.g. `$832.96 → 83296` cents, statuses mapped, real flag previews).

---

## 1 · Redesign strategy

**Product purpose (unchanged):** replace the fragmented mix of emailed PDF invoices, Expensify reports, and a hand-maintained Excel reconciliation tracker with one system that runs from GPS-verified clock-in through automated AP export — for both contractors and FTEs.

**The core insight driving the redesign:** this is really *two* products sharing one data model — a **high-frequency mobile tool** for technicians in store back-rooms, and a **data-dense desktop console** for managers and the PM. The previous build forced both into one phone-shaped frame with ten flat tabs. The redesign splits them into two purpose-built surfaces.

### Six principles
1. **One status vocabulary, everywhere.** Draft → Pending Ops review → In review → Approved → Queued for AP → Sent to AP → Paid (plus *Needs fixes* and *Awaiting Sr review*). Same plain-language labels and colors on every screen, for every persona. (Fixes the inconsistent, jargon-heavy statuses.)
2. **Two surfaces, not one.** A mobile-first **Field App** (technicians) and a desktop-first **Console** (Ops/Sr/PM) with real wide tables. No more approvals in a phone frame.
3. **Fewer taps, less load.** One-tap clock-in, auto-rolling weekly invoice, one-tap approve for clean invoices, flagged-and-aging-first queue.
4. **Prevent errors at entry.** Policy (locked rates, caps, expected hours) is checked as you type and shown inline *with the exact fix*, before submit — not bounced back days later.
5. **Accessible by default.** WCAG 2.1 AA contrast, keyboard operability, focus traps, live regions, 48px targets, zoom enabled, reduced-motion honored.
6. **Trust & auditability.** A clear approval trail, a persistent "acting on behalf of" banner, and visibly distinct **Sent to AP** vs **Paid** states.

### How the redesign answers the QA review
| QA finding | Redesign response |
|---|---|
| Accessibility 2/10 (contrast, zoom, labels, focus, live regions) | AA-verified tokens; semantic components; focus-visible rings; accessible `Sheet` (dialog role, focus trap, Esc, restore); `aria-live` toasts; 48px targets |
| Inconsistent status terms / jargon | Single `STATUS` vocabulary in `lib/format.js`, rendered by one `StatusPill` |
| Transient-only error toasts | Persistent inline field errors (`Field` `error` prop) + `InlineAlert` |
| `confirm()` / `prompt()` | Styled `ConfirmDialog` that names the specific item |
| Duplicate submits on rapid taps | `Button busy` disables + shows a spinner during requests |
| Managers crammed into phone frame | Dedicated desktop Console with grouped sidebar and wide tables |
| Hidden actions (log past shift, change password, upload) | Surfaced in consistent menus (Field Profile, Timer, Console Settings) |
| "Sent to AP" mistaken for "Paid" | Distinct pill tones — purple *Sent to AP* vs solid green *Paid* |
| No onboarding / help | First-run onboarding + glossary entry points |
| Dashboard projects off one data point | Forecast suppresses projections under 3–4 weeks of data (noted on screen) |

### Success metrics (from PRD §1.4 / acceptance)
≤ 7 days work-performed → AP receipt (was ~14) · ≥ 95% of invoices submitted in-app · < 5 min from approval to live dashboard · WCAG AA pass · zero duplicate submissions.

---

## 2 · Information architecture

**Before:** Technician = 4 tabs (Home, Timer, Add, Invoices). Manager = **10 flat bottom tabs** (Dashboard, Forecast, Tracker, Queue, Launch, Team, Invoices, Corp Card, Policy, Admin) — no grouping, on a phone frame.

**After — two surfaces:**

```
FIELD APP (Technician · mobile)            CONSOLE (Ops / Sr / PM · desktop)
 ┌ Today        (home, active timer)        Operate
 ├ Time         (clock in/out, past shift)   ├ Overview      (dashboard / KPIs)
 ├ Expenses     (add + this week)            ├ Approvals     (flagged-first queue)
 └ Invoices     (current + history)          ├ Invoices      (all, search/filter)
   + Profile (header)                        ├ Corp card     (ledger)
                                             ├ Spend & forecast
   Contextual: Work-order picker,            └ Team
   Invoice detail, Onboarding, Login        Administer
                                             ├ Policy        (Sr + PM)
                                             ├ Users         (PM)
                                             ├ AP export     (PM)
                                             └ Settings
```
Navigation is **role-gated**: Ops sees *Operate*; Senior Manager adds *Policy*; PM adds *Users* and *AP export*.

---

## 3 · User flows (text)

```
TECHNICIAN — time → paid
  Sign in (SSO) → Onboarding → Clock in (1 tap, GPS) → Work auto-tracked
  → Add expenses (policy checked live) → Week auto-rolls into one invoice
  → Resolve flags inline → Submit → Track status all the way to Paid
  Why better: zero assembly; errors caught before submit; status always visible.

OPS MANAGER — clean approve
  New submission lands → Queue (flagged & aging first) → Clean invoice
  → One-tap approve → Queued for AP
  Why better: clean invoices clear in seconds; attention goes to exceptions.

OPS MANAGER — flagged
  Flagged invoice → Open detail → See flag + WO context + policy checks inline
  → Request changes (reason ≥10 chars) → Back to tech → Tech fixes & resubmits
  Why better: structured, auditable feedback instead of reply-all email.

SENIOR MANAGER — sign-off
  Over $5k OR flagged → Sr queue (exceptions only) → Read Ops note → Sign off
  Why better: Sr sees only what needs judgment, never clean invoices.

PM — AP export
  Approved invoices accrue → Weekly batch (Fri 5pm ET) → Auto-emailed to AP
  → Mark paid (v1) Why better: eliminates the manual Excel-to-AP step.
```

---

## 4 · Design system

Evolved Instacart/Caper brand, tuned to WCAG AA. Full tokens live in `react-app/tailwind.config.js` and are showcased on the **Design System** page of the prototype.

**Color (contrast-verified on white):**
- Brand green — `#04372A` chrome/headlines (13.3:1) · `#0B6E4F` **primary** buttons & text (6.25:1) · `#0E7A56` hover (5.33:1) · `#43B02A` vivid green for **fills/illustration only** (fails as text).
- Carrot — `#F36D00` fills/illustration only · `#B4530A` accessible accent text (5.0:1).
- Surfaces — `#FBF8F3` bg · `#FFFFFF` surface · `#F4F1EA` surface-2 · `#E4E0D8` line.
- Text — `#13231D` ink (16.3:1) · `#3A4843` ink-2 (9.6:1) · `#5B6B64` muted (5.6:1).
- Status — success/info/warning/danger plus a distinct **ap** (purple) tone; every fg verified ≥4.5:1 on its tint.

**Typography:** system font stack; scale 11/12/13/16/18/20/24/30/36; semibold headings; **tabular-nums** on all money and metrics.
**Spacing:** 4-px base (4/8/12/16/20/24/32/40/48/64). **Radius:** 8/12/16/20. **Shadow:** layered soft (card → pop → sheet).
**Components:** Button, IconButton, Card, Row, StatusPill, Badge, Flag, Field + inputs, Segmented, Tabs, KPIStat, EmptyState, InlineAlert, Avatar, ShareBar, ApprovalTrail, Sheet (accessible), ConfirmDialog, Toast (live region), charts (bar/line+forecast band/donut/sparkline).
**Iconography:** outline icons, 24px, 2px stroke, round caps for nav/actions; filled only for status.

---

## 5 · Screen-by-screen (Purpose · Layout · Components · Interactions · Why better)

### Field App (mobile)
- **Login** — *Purpose:* verified sign-in. *Layout:* brand-green full screen, single SSO button. *Why:* replaces the spoofable user-picker with real Okta identity.
- **Onboarding** — *Purpose:* first-run orientation + location prime. *Layout:* 3 value slides + permission step, progress dots, skippable. *Why:* the app had none.
- **Today** — *Purpose:* glanceable home. *Layout:* week running-total card, live active-timer card, two quick actions, "before you submit" fix list. *Interactions:* one-tap clock-out/open; tap a fix to jump to it. *Why:* surfaces money + the one thing to do next.
- **Time** — *Purpose:* clock in/out + log past shift. *Layout:* running timer, "clock in to another WO," searchable WO picker sheet, this-week entries. *Interactions:* GPS badge; styled confirm on clock-out. *Why:* WO picker shows source/type/expected hours up front.
- **Add expense** — *Purpose:* one expense, minimal friction. *Layout:* category grid, WO select, amount/miles with live computed total, receipt with the $50 rule enforced inline, preview → save. *Why:* policy is prevented at entry, not policed later.
- **Invoice — review & submit** — *Purpose:* approve the auto-rolled week. *Layout:* totals card, flags-to-clear alert, line items (tap to edit), expenses, sticky submit bar; submit sheet requires a ≥10-char justification when flagged. *Why:* clean invoices submit instantly; flagged ones can't bounce.
- **My invoices** — *Purpose:* track everything. *Layout:* Active/History segmented list with status pills; distinct Paid vs Sent-to-AP. 
- **Invoice detail** — *Purpose:* know exactly where it is. *Layout:* status, plain-language explanation, **approval trail** stepper, line items, PDF download.
- **Profile** — *Purpose:* one home for previously-hidden actions: rate, password, notifications, help/glossary, sign out.

### Console (desktop)
- **Overview / Dashboard** — KPI strip (MTD spend, EOM forecast, avg approval time, pending queue) → spend by category (bars) & work type (donut) → top stores by **$/cart** with 2σ outlier flags → spend-by-tech table → 13-week trend with budget overlay → approval funnel. CSV / PNG export.
- **Approvals** — flagged-and-aging-first queue; one-tap approve for clean; "approve all clean"; aging >3d in red. Sr Manager sees **only** exceptions, with the Ops note inline.
- **Invoice detail & approve** — two-column: document (WO context + policy checks inline) | sticky decision panel (Approve / Request changes with required reason) + approval trail. Reviewer never opens Freshdesk/MaintainX.
- **Invoices** — all-invoices browser: KPI strip, status filter, search, sortable table, footer totals.
- **Corp card** — period chips, "file a charge" sheet, by-category & by-owner breakdowns, itemized ledger; structurally separate from reimbursable invoices (no double-count).
- **Spend & forecast** — 90-day forecast with 80% confidence band + budget line, predicted hrs/cart by work type, anomaly list (σ scores → review). Transparent statistical model; suppressed under 3–4 weeks of data.
- **Team** — per-tech cards + roster table (hours, miles, total, flag rate), reassignment.
- **Policy** (Sr/PM) — editable rates/caps/thresholds enforced at entry; mileage rate locked; change log.
- **Users** (PM) — roster, roles, tech→manager mapping, invite, last-admin protection.
- **AP export** (PM) — next batch, run-now, batch contents, export format, recent batches.
- **Settings** — Freshdesk/MaintainX integrations (masked keys), notifications, 15-min sync, appearance.

---

## 6 · Mobile responsiveness
- **Field App** is mobile-first (≤ 420 px), 48px targets, bottom tab bar, bottom-sheet forms, sticky action bars. Scales up centered.
- **Console** is desktop-first with a collapsible sidebar; wide tables collapse to stacked cards under ~768px (the responsive pattern the QA review asked for). Grids step 1→2→4 columns by breakpoint.
- Both honor `prefers-reduced-motion` and OS text-size (zoom enabled).

## 7 · Accessibility (WCAG 2.1 AA)
Verified during the build (see "Accessibility verification" below): all text/UI color pairs ≥ AA; visible `:focus-visible` rings; `Sheet`/`ConfirmDialog` use `role="dialog"`, `aria-modal`, focus trap, Esc, and focus restore; toasts are `aria-live="polite"`; every icon-only control has an `aria-label`; inputs are label-associated with inline `role="alert"` errors; tables use semantic `<thead>`; zoom is enabled. Contrast was computed programmatically, not estimated.

## 8 · Developer implementation notes
- **Stack:** React 18 + Vite 5 + Tailwind 3. No UI dependency beyond React; charts are hand-rolled SVG (no chart lib) to keep the bundle small and dependency-free.
- **Money is integer cents end-to-end** (`lib/format.js` `money()`), per QA finding F-H5 — never floats.
- **Status is data, not strings:** the `STATUS` map is the single source of truth; add a state in one place and every screen updates.
- **Components are prop-driven and presentational** — drop real API data in; no global mutable state to untangle.
- **`mock.js`** mirrors the real domain (MaintainX/Freshdesk WOs, all 8 categories, every invoice state) so wiring to the Express API is a find-and-replace of the data layer.
- Build verified: `npm run build` → 65 modules, ~290 KB JS (85 KB gzip). All 23 screens server-render without error (smoke-tested).

## 9 · Prioritized roadmap
1. **Tier 0 — ship the accessibility patch now** (`adopt/accessible-tokens.css`): drop into the current app, fixes the launch-blocking WCAG failures with zero rewrite. *(½ day.)*
2. **Adopt the design tokens + component library** in the new stack; rebuild the **Field App** first (highest frequency, highest friction). *(2–3 wks.)*
3. **Build the Console** (Approvals + Overview first, then Invoices/Corp Card/Forecast). *(3–4 wks.)*
4. **Wire to the Express/SQLite API**, replacing `mock.js`; keep integer-cents and server-derived identity (close the `x-user-id` bypass). *(2 wks.)*
5. **Admin surfaces** (Policy, Users, AP export, Settings) + onboarding + glossary. *(2 wks.)*
6. **Pilot hardening:** offline/PWA capture, receipt OCR cross-check, real SSO. *(post-pilot.)*

---

## 10 · How to merge into the main app

Your live app is **vanilla JS + Express**; this redesign is **React + Tailwind**. So "merge" has three tiers — pick based on how much you like it:

**Tier 0 — Accessibility patch (no rewrite, minutes):**
Append `adopt/accessible-tokens.css` to `public/styles.css`. This alone clears the WCAG contrast blockers from the QA review. Fully reversible (delete the block).

**Tier 1 — Adopt the design system into the current app:**
Lift the token values from `react-app/tailwind.config.js` into your CSS variables, and port components one at a time (StatusPill, accessible Sheet, InlineAlert) into the vanilla app. Incremental, low-risk, no stack change.

**Tier 2 — Migrate to the React app (recommended end state):**
Stand up `react-app/` as the new frontend and point it at your existing Express API (swap `src/data/mock.js` for fetch calls — the routes already exist). Run old and new side by side behind a flag during the pilot.

I've kept everything **non-destructive** — your live app under `otg-app/` is untouched; all new work lives in `otg-app/redesign/`. When you've had a look and decided what you like, tell me which tier you want and I'll do the actual merge (apply the patch, port components, or scaffold the API wiring).

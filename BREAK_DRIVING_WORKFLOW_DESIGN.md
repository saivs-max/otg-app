# Break Timer & Driving Workflow — Design & Implementation Plan

**Proposed version:** v0.82 · **Status:** ✅ Implemented (2026-07-10) · **Date:** 2026-07-10
**Author:** Design pass from UAT feedback (break timer + driving workflow)

> **Implemented.** All five items are built across `schema.sql`, `db.js`,
> `routes/timeentries.js`, and `public/app.js`, with a smoke test at
> `test/break-workflow/http-smoke.js` (`npm run test:break` — 19 checks pass).
> This section is retained as the design record.

This doc turns the five UAT findings into a concrete design. Two decisions were
locked from review before build:

1. **Live-tracked breaks.** Pressing Break *pauses* the timer and starts a real
   break clock; the **actual paused duration** is what gets deducted from
   billable work/drive time. "30 minutes" becomes the *expected/typical* break
   shown in the prompt, not a fixed deduction.
2. **Deliverable is this plan first**, before any implementation.

---

## 1. Current behavior & root cause

All the reported symptoms trace back to one design choice: **a break is stored
as a single integer `break_minutes` that is subtracted from the one running
clock.** There is no "paused" state, no memory of what the tech was doing before
the break, and no confirmation.

Relevant code:

- **`public/app.js → renderTimer()`** (~L1301–1407)
  - The clock renders as `fmtElapsed(Date.now() - start - breakMins[id]*60000)`
    (L1371). Because `fmtElapsed` clamps with `Math.max(0, …)` (L201–207), as
    soon as accrued break exceeds elapsed time the display shows **`00:00:00`** —
    this *is* the "resets to zero" report (UAT #1).
  - The `+30 min break` button (L1349, handler L1378–1386) immediately adds 30 to
    `breakMins[id]` and PATCHes `break_only` — **no confirmation** (UAT #2).
  - A running timer only ever shows `Break` / `Switch to Work|Drive` /
    `Clock Out` (L1348–1352). There is no pause and no "resume", so after a break
    while driving the only forward actions are Switch-to-Work or Clock-Out
    (UAT #4, #5).
- **`routes/timeentries.js`**
  - `PATCH /timeentries/:id` with `break_only:true` just writes
    `break_minutes` while the timer keeps running (L275–279).
  - `POST /timeentries/:id/switch-mode` atomically closes the entry and opens a
    new one in the opposite mode (L184–244) — this is a *mode switch*, not a
    pause.
- **`db.js → sumHours()`** (L638–646) subtracts `break_minutes` for **both**
  work and drive entries. So billing already deducts break time regardless of
  mode — the *math* for "break during driving isn't billable" (UAT #4) is
  effectively already right; the gaps are **UX** (no pause, no resume, no
  confirmation) and **accuracy** (fixed 30 vs. actual).
- **`schema.sql`** `time_entries` (L161–…): `break_minutes INTEGER DEFAULT 0`,
  `mode TEXT CHECK(mode IN ('work','drive'))`. No pause/flag columns.

---

## 2. Core model shift

> From *"break = a number of minutes subtracted from the clock"*
> to *"break = a real paused interval; the timer stops, the actual duration is
> deducted, and the pre-break mode is preserved so it can be resumed."*

Key insight: **pausing does not change `mode`.** The running entry keeps its
`mode` (`work` or `drive`) throughout the break, so "resume the previous
activity" is automatic — the Resume button simply reflects the entry's existing
`mode`. No separate "pre-break mode" field is needed.

A time entry now has three UI states, all derived from two persisted fields:

| State | `clock_out` | `break_started_at` | Timer display |
|-------|-------------|--------------------|---------------|
| Running (work/drive) | `NULL` | `NULL` | counts up |
| **On break (paused)** | `NULL` | set | **frozen** + a break counter counting up |
| Clocked out | set | `NULL` | final total |

---

## 3. Data model changes

Add two columns to `time_entries` (idempotent migration in `ensureSchema()` per
the repo convention, plus `schema.sql` for fresh DBs):

```js
// db.js → ensureSchema()
migrateAddColumn(db, 'time_entries', 'break_started_at', 'TEXT');           // ISO ts while paused, else NULL
migrateAddColumn(db, 'time_entries', 'break_flagged',    'INTEGER DEFAULT 0'); // 1 if any break > 60 min
```

```sql
-- schema.sql, time_entries
break_started_at  TEXT,               -- set while on break, cleared on resume/clock-out
break_flagged     INTEGER DEFAULT 0,  -- 1 when any single break exceeded 60 min (UAT #3)
```

No backfill needed: existing rows default to `NULL` / `0` and behave exactly as
today. `break_minutes` keeps its meaning (total minutes deducted); it is now
*accumulated from measured break intervals* rather than incremented by a flat 30.

Optional (nice-to-have, not required): `break_count INTEGER DEFAULT 0` and/or
`longest_break_minutes` for reporting. Left out of v1 to keep the migration
small — the flag + total minutes cover the UAT asks.

---

## 4. Pause / resume math

Let `C` = `clock_in`, `B` = `break_started_at`, `Bm` = committed `break_minutes`.

- **Start break** (at `B`): set `break_started_at = B`. Freeze display at
  `(B − C) − Bm·60000`.
- **Resume / clock out from break** (at `R`): `thisBreak = R − B`;
  `break_minutes = Bm + round(thisBreak / 60000)`; if `thisBreak > 60 min` set
  `break_flagged = 1`; clear `break_started_at`.

This is **seamless** (UAT #1, #5): right after resume the display is
`R − C − (Bm + thisBreak) = (B − C) − Bm` — exactly the frozen value, so the
clock continues from where it paused. Clocking out from a break bills
`(R − C) − break_minutes·60000 = (B − C) − Bm` — i.e. the break at the end is
**not billed** (UAT #4).

**`sumHours()` fix for the in-progress case:** while an entry is *currently* on
break (`clock_out IS NULL AND break_started_at IS NOT NULL`), the live break is
not yet in `break_minutes`. `sumHours` must also subtract `(now − break_started_at)`
so any live/active total (and the frozen display) stays correct until resume
commits it.

---

## 5. Backend API changes (`routes/timeentries.js`)

Replace the fixed `break_only` path with two explicit, audited transitions:

- **`POST /timeentries/:id/break/start`**
  Guards: entry is the caller's (or manager-on-behalf, same auth block as
  existing PATCH), `clock_out IS NULL`, `break_started_at IS NULL`.
  Effect: `break_started_at = now`. Audit action `break_start`.

- **`POST /timeentries/:id/break/resume`**
  Guards: `clock_out IS NULL`, `break_started_at IS NOT NULL`.
  Effect: commit `thisBreak` into `break_minutes`, set `break_flagged` if
  `> 60 min`, clear `break_started_at`. Audit action `break_resume`
  (details: `{ minutes, flagged }`). Returns the refreshed entry.

- **Clock-out while on break** (existing `PATCH /timeentries/:id`, running
  branch): if `break_started_at` is set, finalize the break first (commit to
  `break_minutes`, set flag if needed, clear `break_started_at`) *before*
  writing `clock_out`. This keeps "Clock Out" working from the break state.

- **`switch-mode` while on break:** reject with a clear 409 ("Resume before
  switching modes") — switching is only offered when not paused (see §6). This
  avoids ambiguous half-paused mode changes.

- **Deprecate `break_only`:** the old `{break_only:true, break_minutes}` PATCH is
  removed from the running path. The manual/edit sheets that set `break_minutes`
  directly on **clocked-out** entries (`te_break`, edit-time sheet, manual entry,
  min/max 240) are **unchanged** — they still let a manager correct total break
  on a logged entry.

---

## 6. Frontend changes (`public/app.js → renderTimer()`)

Render per-entry by state. Buttons:

- **Running — Work:** `☕ Break` · `🚗 Switch to Drive` · `Clock Out`
- **Running — Drive:** `☕ Break` · `🛠 Switch to Work` · `Clock Out`
- **On break (paused):** `▶️ Resume Work` **or** `▶️ Resume Driving` (label from
  the entry's `mode`) · `Clock Out`. Switch-mode is hidden while paused.

Display while paused: freeze the main clock at the paused value and show a second
line — a **break counter counting up** from `break_started_at`, with the 30-min
mark as the expected/typical reference, e.g. `On break · 12:41 (typical 30 min)`.
When the live break passes 60 min, show an inline ⚠ warning
(`alertHTML('warn', …)`) right on the card (UAT #3).

**Confirmations** (UAT #2, #4) — reuse the app's existing native `confirm()`
pattern (used for clock-in and deletes today):

- Work break: `confirm('Start break? This pauses your current activity; your break time is deducted from your timesheet.')`
- Drive break: `confirm('Take a break while driving? Your break time will be deducted from billable driving time.')`

> ⚠️ **Copy note vs. UAT examples.** The UAT examples say "add a **30-minute**
> break to your timesheet." Under the chosen *live-tracked* model that wording
> would be inaccurate (actual duration is deducted, not a flat 30). The strings
> above keep the UAT intent but drop the fixed "30-minute" claim. If you'd rather
> keep the exact UAT wording, we'd need the fixed-30 model instead — flagging so
> the decision is explicit.

**Persistence across reload/navigation:** because `break_started_at` is
persisted and returned by `GET /timeentries/active`, `renderTimer` reconstructs
the paused state on load — a tech who backgrounds the app mid-break returns to
the same paused card, not a lost break.

---

## 7. UAT items → changes

| # | UAT finding | Change | Where |
|---|-------------|--------|-------|
| 1 | Break resets timer to 0:00 | True pause: freeze main clock, show break counter; resume continues seamlessly | `renderTimer` display + `break/start`,`break/resume` |
| 2 | No confirmation before break | `confirm()` dialog before starting | `renderTimer` break handler |
| 3 | Extended breaks unflagged | `break_flagged` set when a break > 60 min; ⚠ on card + surfaced in manager review | resume/clock-out logic, `break_flagged`, review sheet |
| 4 | Break while driving: resets, not billable, stranded | Drive-specific confirm; actual break deducted from drive time (already deducted by `sumHours`); `Resume Driving` after | `renderTimer` (drive state) + break endpoints |
| 5 | Can't resume prior state | `mode` preserved across break → single-tap `Resume Work`/`Resume Driving` | `renderTimer` paused state |

---

## 8. Edge cases

- **Clock out directly from break** — handled in §5; break finalized, not billed.
- **Forgotten / overnight break** — `sumHours` already clamps to ≥ 0, so a huge
  break can't produce negative billable; `break_flagged` catches it (> 60 min)
  for manager review. Consider a follow-up: auto-nudge/notification if a break
  exceeds e.g. 2 h.
- **Multiple breaks in one entry** — each resume accumulates into `break_minutes`;
  `break_flagged` trips if *any single* interval exceeds 60 min.
- **Switch mode while paused** — not offered in UI; endpoint rejects (§5).
- **Concurrent timers** — each entry pauses independently; drive-mode exclusivity
  is unaffected (a paused drive entry is still the one drive timer).
- **Manual / backdated entries & manager edits** — unchanged; they set total
  `break_minutes` directly on clocked-out entries.

---

## 9. Billing, exports & reconciliation impact

Minimal by design. `break_minutes` remains the single deduction on the entry, so:

- **Cost Tracker / `buildCostTrackerRows` / exports (XLSX, Google Sheets)** consume
  clocked-out entries' hours — unchanged, since break is still deducted there.
- **Reconciliation rule** (tracker Act Total per WO === invoice `visit_total`)
  holds — both sides use the same post-break hours.
- Only genuinely new behavior: (a) the in-progress-break subtraction in
  `sumHours` for *active* entries, and (b) `break_flagged` surfaced to managers.

---

## 10. Test plan

- **Unit (`db.js`):** `sumHours` with `break_started_at` set (active, on break)
  subtracts live break; resume math commits `round(minutes)`; `> 60 min` sets flag.
- **API smoke (extend `test/…`):** clock in → `break/start` → `break/resume`
  (assert `break_minutes`, `break_started_at NULL`); start → clock out from break
  (assert finalized + billed correctly); `> 60 min` resume sets `break_flagged`;
  `switch-mode` while paused → 409; `break/start` when already on break → 409.
- **Migration (`test/migrations/existing-db-boot.js`):** boot against a pre-v0.82
  DB, assert both columns added and existing rows read as not-on-break.
- **Manual QA:** timer no longer hits 0:00 on break; confirmations appear
  (work + drive copy); Resume Work / Resume Driving restore the right mode;
  reload mid-break restores the paused card; a 65-min break shows ⚠ and flags.

---

## 11. Rollout

- Single feature version **v0.82**, tagged in comments per repo convention.
- Migration auto-applies on boot via `ensureSchema()` → applies to the prod
  SQLite volume on deploy; no manual step, no backfill.
- This is a **code** change (JS + schema), so it deploys via push → CI (not a
  docs-only skip). This design doc itself is `.md` and won't trigger a deploy.

---

## 12. Decisions needed before build

1. **Confirmation copy** — accept the adjusted live-tracked wording in §6, or
   keep the literal "30-minute" UAT wording (which implies the fixed-30 model)?
2. **Flag threshold** — 60 min per the UAT; confirm it's per-break (recommended)
   vs. cumulative across an entry.
3. **Manager surfacing of `break_flagged`** — inline ⚠ only, or also a
   notification (reuse the `notifications` table used for `line_item_edited`)?
4. **Scope of v1** — include the optional `break_count`/`longest_break_minutes`
   reporting columns now, or defer?

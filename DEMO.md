# OTG Field Cost App — Demo (v0.64.5)

This package ships with a **pre-seeded demo database** (`data/otg.db`) so you can
launch and take screenshots immediately — no seeding step required.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3000 and sign in:

| Role          | Username   | Password      |
|---------------|------------|---------------|
| Ops Manager   | `maitland` | `password123` |
| Senior Mgr    | `reshmi`   | `password123` |
| PM            | `sai`      | `password123` |
| Technician    | `aramiwale`| `password123` |

Sign in as **`maitland`** (Ops Manager) for the unplanned / leadership views.

## What to screenshot

1. **Dashboard → "Unplanned work" sub-tab** — the leadership summary: total
   unplanned cost, a by-reason breakdown (Wasted Labour / Ad-hoc / Unexpected),
   by work type, by store, and a weekly trend. Use the 30d / 90d / YTD / All
   period buttons.
2. **Cost Tracker** — each work-order row has an **↗ WO** button (opens the full
   work order) and a **Tag as unplanned** action in the row's edit sheet.
3. **A work order** (open from Cost Tracker) — whole-WO tag button plus a
   **Tag as unplanned** button on each labor entry and expense.
4. **Corp Card** — a **Tag as unplanned** button on each charge.
5. **An invoice (review)** — sign in as `maitland`, open a submitted invoice for
   one of your techs: the "Internal review" panel lets you tag and edit line
   items. These tags are **backend reporting only** — they never appear on the
   AP invoice or its PDF.

## Regenerate the demo data

```bash
npm run seed:unplanned      # rebuilds the rich demo + applies unplanned tags
```

Other fixtures: `npm run seed:demo` (rich, untagged), `npm run seed:director`
(minimal walkthrough), `npm run seed` (basic).

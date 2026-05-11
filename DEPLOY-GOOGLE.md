# Caper CostWise — Google Drive & Forms Setup (v0.37)

This is a **one-time** setup so the app can:

1. Push the dashboard export directly to a Google Sheet ("📤 Push to Drive" button on the Dashboard tab)
2. Pre-fill the Launch Actuals Google Form so Ops Mgrs only need to click *Submit*

You only need to do steps 1–6 once; after that, every Ops Mgr in the app can use both features.

---

## 1. Google Sheets push (auto-export)

### A. Create a Google service account (~5 min)

1. Go to <https://console.cloud.google.com> and pick (or create) a project.
2. **APIs & Services → Library** → search for "Google Sheets API" → **Enable**.
3. **APIs & Services → Credentials → Create Credentials → Service Account**.
   - Name it whatever (e.g. `caper-costwise-export`).
   - Skip the optional roles step.
4. After creating, click into the service account, go to **Keys → Add Key → JSON**. A `.json` file downloads.
5. Note the service account's email — it looks like `caper-costwise-export@<project>.iam.gserviceaccount.com`.

### B. Drop the key into the app

Save the downloaded JSON file as:

```
otg-app/data/google-service-account.json
```

(Or, if deploying to Render/Fly/Heroku where you can't ship a file, set the env var `GOOGLE_SERVICE_ACCOUNT_JSON` to the entire JSON contents.)

### C. Share the target sheet with the service account

1. Open the target Google Sheet — for example: <https://docs.google.com/spreadsheets/d/10WlIOttjpvPFjsVeNxfQRITV2b_Z8l1jOD8yXO17TOg/edit>
2. Click **Share** → paste the service account email → set permission to **Editor** → **Send**.
3. Copy the sheet ID from the URL (the long string between `/d/` and `/edit`).

### D. Tell the app which sheet to write to

Create or edit `otg-app/.env` and add:

```
GOOGLE_SHEET_ID=10WlIOttjpvPFjsVeNxfQRITV2b_Z8l1jOD8yXO17TOg
```

Restart the server. On the Dashboard tab, the "📤 Push to Drive" button now writes one tab per dashboard section (`Summary`, `By Tech`, `By Work Type`, `By Store`, `By Vendor`, `Top Invoices`) to that sheet, overwriting the previous export each time.

---

## 2. Launch Actuals form prefill

The Launch Actuals tab can build a deep-link URL that opens the Google Form with most of the answers already filled in. Once configured, the Ops Mgr just clicks "↗ Open prefilled form" → reviews → clicks Submit. Without this, the form still opens but is blank — the Ops Mgr can use the in-app value table to copy-paste.

### A. Get the form's entry IDs

1. Open the Launch Actuals form in **edit mode** (you must own or be a collaborator).
2. Click the ⋮ menu → **Get pre-filled link**.
3. Type a unique sentinel value into every field (e.g., type `WEEKENDING` in Week Ending, `STOREID` in Store ID, `STORENAME` in Retailer, `12345` in Hours Spent, etc.).
4. Click **Get link** at the bottom → **Copy link**.
5. Paste the resulting URL somewhere; it looks like:
   ```
   https://docs.google.com/forms/d/e/1FAIp.../viewform?usp=pp_url
     &entry.123456789=WEEKENDING
     &entry.234567891=STOREID
     &entry.345678912=STORENAME
     ...
   ```

### B. Map the entry IDs into the app

Add to `otg-app/.env` (one per field — match by your sentinel value):

```
LAUNCH_FORM_VIEW_URL=https://docs.google.com/forms/d/e/1FAIpQLSc...your form.../viewform
LAUNCH_FORM_FIELD_EMAIL=entry.123456789
LAUNCH_FORM_FIELD_WEEK_ENDING=entry.234567891
LAUNCH_FORM_FIELD_STORE_ID=entry.345678912
LAUNCH_FORM_FIELD_STORE_NAME=entry.456789123
LAUNCH_FORM_FIELD_TEAM=entry.567891234
LAUNCH_FORM_FIELD_ROLE=entry.678912345
LAUNCH_FORM_FIELD_SUPPORTING=entry.789123456
LAUNCH_FORM_FIELD_HOURS_SPENT=entry.891234567
LAUNCH_FORM_FIELD_ADDITIONAL_HOURS=entry.912345678
LAUNCH_FORM_FIELD_HOURS_TYPE=entry.123456780
LAUNCH_FORM_FIELD_BRIEF_DESCRIPTION=entry.234567801
LAUNCH_FORM_FIELD_NOTES=entry.345678012
```

Restart the server. The Launch Actuals "Open prefilled form" link will now jump to Google Forms with every field already populated.

> If you only know some of the entry IDs, set those — the app will prefill the ones it knows and leave the rest blank for the Ops Mgr to fill manually.

---

## 3. Troubleshooting

- **"Google Sheets is not configured on this server"** when clicking Push to Drive — the JSON file isn't at `data/google-service-account.json` or `GOOGLE_SHEET_ID` isn't set. Re-check steps 1B and 1D.
- **`403 The caller does not have permission`** — the target sheet hasn't been shared with the service account email. Step 1C.
- **Prefilled form opens blank** — the `LAUNCH_FORM_FIELD_*` env vars aren't set. Step 2B. The form will still work; values just need manual entry.
- **Form opens with the wrong sheet on Drive** — re-check `GOOGLE_SHEET_ID` in `.env` matches the long string in the sheet's URL.

The dashboard's "📥 Excel" button (local download) and the in-app value table (under Launch Actuals) both keep working regardless of whether Google integration is configured. The Drive/Forms integration is purely additive.

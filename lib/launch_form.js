// lib/launch_form.js — v0.37
//
// Google Form prefill URL helper for the Launch Actuals submission flow.
//
// Google Forms support deep-linked prefill via the `viewform` URL. To
// pre-populate a field, append `&entry.<NUMERIC-ID>=<value>` for each
// answer. To find the IDs for an existing form:
//   1. Open the form in Google Forms (edit mode).
//   2. Click the ⋮ menu → "Get pre-filled link".
//   3. Fill in distinct sentinel values for every field, click "Get link",
//      then "Copy link". Open the URL — the entry.NNN=value pairs appear
//      in the query string.
//   4. Drop those numeric IDs into LAUNCH_FORM_FIELD_MAP below (or override
//      via env vars).
//
// If an entry ID isn't configured, we silently skip that field — the form
// still opens, just with the unconfigured field blank for the user to fill.

const FORM_BASE_URL = process.env.LAUNCH_FORM_VIEW_URL
  || 'https://docs.google.com/forms/d/e/1FAIpQLScZgR9C3k7uyPRXDbtAHsmqDbHE8I4u-MFG5x_o5HM6nGGvPw/viewform';

// Default placeholder entry IDs. Replace with the real numeric IDs from
// your form's "Get pre-filled link" output. Values can also be set via env
// vars at runtime (no code change needed).
//
// Keys are the logical field names used by routes/launch_actuals.js;
// values are the form's `entry.<numeric-ID>` strings (or null when unknown).
const LAUNCH_FORM_FIELD_MAP = {
  email:             process.env.LAUNCH_FORM_FIELD_EMAIL             || null,
  week_ending:       process.env.LAUNCH_FORM_FIELD_WEEK_ENDING       || null,
  store_id:          process.env.LAUNCH_FORM_FIELD_STORE_ID          || null,
  store_name:        process.env.LAUNCH_FORM_FIELD_STORE_NAME        || null,
  team:              process.env.LAUNCH_FORM_FIELD_TEAM              || null,
  role:              process.env.LAUNCH_FORM_FIELD_ROLE              || null,
  supporting:        process.env.LAUNCH_FORM_FIELD_SUPPORTING        || null,
  hours_spent:       process.env.LAUNCH_FORM_FIELD_HOURS_SPENT       || null,
  additional_hours:  process.env.LAUNCH_FORM_FIELD_ADDITIONAL_HOURS  || null,
  hours_type:        process.env.LAUNCH_FORM_FIELD_HOURS_TYPE        || null,
  brief_description: process.env.LAUNCH_FORM_FIELD_BRIEF_DESCRIPTION || null,
  notes:             process.env.LAUNCH_FORM_FIELD_NOTES             || null,
};

function getFieldMap() {
  return {
    form_url: FORM_BASE_URL,
    fields: { ...LAUNCH_FORM_FIELD_MAP },
    configured_count: Object.values(LAUNCH_FORM_FIELD_MAP).filter(Boolean).length,
    total_count:      Object.keys(LAUNCH_FORM_FIELD_MAP).length,
  };
}

// Build the prefilled viewform URL. Skips any field whose entry-ID is null.
// Multi-page Google Forms note: prefill works across pages.
function buildPrefillUrl(values) {
  const params = new URLSearchParams();
  params.set('usp', 'pp_url');                  // signals "pre-populated URL"
  for (const [logical, val] of Object.entries(values || {})) {
    const entryId = LAUNCH_FORM_FIELD_MAP[logical];
    if (!entryId) continue;
    if (val === null || val === undefined || val === '') continue;
    params.set(entryId, String(val));
  }
  // If no entry IDs are configured at all, return the bare form URL so the
  // user at least gets a working "Open form" button.
  if (![...params.keys()].some(k => k.startsWith('entry.'))) return FORM_BASE_URL;
  const sep = FORM_BASE_URL.includes('?') ? '&' : '?';
  return `${FORM_BASE_URL}${sep}${params.toString()}`;
}

module.exports = { buildPrefillUrl, getFieldMap, FORM_BASE_URL, LAUNCH_FORM_FIELD_MAP };

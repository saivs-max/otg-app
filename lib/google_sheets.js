// lib/google_sheets.js — v0.37
//
// Thin wrapper around the Google Sheets v4 REST API using a service-account
// JWT. We keep this dep-free (uses the Node 22 built-in `crypto` + `fetch`)
// so we don't have to add `googleapis` to package.json.
//
// Setup (one-time, by the IT admin):
//   1. Create a Google Cloud project, enable the Sheets API + Drive API.
//   2. Create a service account; download its JSON key.
//   3. Save the JSON at `data/google-service-account.json` OR set
//      GOOGLE_SERVICE_ACCOUNT_JSON in .env to the JSON string.
//   4. Set GOOGLE_SHEET_ID in .env to the target sheet's ID (the long string
//      between /d/ and /edit in the URL).
//   5. Share the target sheet with the service account's `client_email`
//      (Editor access).
//
// If creds are missing or the sheet share isn't set up, the dashboard export
// gracefully falls back to a local download. No crash, no scary error.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const KEY_PATH = path.join(__dirname, '..', 'data', 'google-service-account.json');
const SCOPE    = 'https://www.googleapis.com/auth/spreadsheets';

function loadServiceAccount() {
  // 1) env var takes priority (works in containerized deploys)
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try { return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
    catch (e) { console.warn('[gsheets] GOOGLE_SERVICE_ACCOUNT_JSON parse fail:', e.message); }
  }
  // 2) local JSON file
  if (fs.existsSync(KEY_PATH)) {
    try { return JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')); }
    catch (e) { console.warn('[gsheets] service-account.json parse fail:', e.message); }
  }
  return null;
}

function isConfigured() {
  return !!loadServiceAccount() && !!process.env.GOOGLE_SHEET_ID;
}

// Build a signed JWT, exchange it for an access token. Cached for ~50min.
let _tokenCache = null;
async function getAccessToken() {
  if (_tokenCache && _tokenCache.expires_at > Date.now() + 60_000) return _tokenCache.token;
  const sa = loadServiceAccount();
  if (!sa) throw new Error('Google service account not configured');

  const now    = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim  = {
    iss:   sa.client_email,
    scope: SCOPE,
    aud:   sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64u(header)}.${b64u(claim)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key)
                    .toString('base64url');
  const jwt = `${unsigned}.${sig}`;

  const resp = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!resp.ok) throw new Error(`Google token exchange failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  _tokenCache = { token: data.access_token, expires_at: Date.now() + (data.expires_in * 1000) };
  return _tokenCache.token;
}

// Replace all values on a single tab.
// `tabName` is the literal sheet tab name (created if missing).
// `rows` is a 2D array of cell values.
async function writeTab(spreadsheetId, tabName, rows) {
  const token = await getAccessToken();
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Ensure the tab exists. Get spreadsheet meta first.
  const metaResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    { headers });
  if (!metaResp.ok) throw new Error(`Sheets meta failed: ${metaResp.status} ${await metaResp.text()}`);
  const meta = await metaResp.json();
  const tabs = (meta.sheets || []).map(s => s.properties.title);

  if (!tabs.includes(tabName)) {
    const addResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      { method: 'POST', headers,
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }) });
    if (!addResp.ok) throw new Error(`addSheet failed: ${addResp.status} ${await addResp.text()}`);
  }

  // Clear existing values, then write fresh data.
  const range = encodeURIComponent(`${tabName}!A1:ZZ`);
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:clear`,
    { method: 'POST', headers });

  const writeResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', headers, body: JSON.stringify({ values: rows }) });
  if (!writeResp.ok) throw new Error(`values.update failed: ${writeResp.status} ${await writeResp.text()}`);
  return await writeResp.json();
}

// Push the dashboard to the configured Sheet in the FY26 Deployment &
// Retrofit Cost Tracker template format. v0.40 — three tabs that match
// the Excel template the team already uses, so the Sheet stays consistent.
async function pushDashboardToSheet(payload, costRows = []) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID not set');

  // ----- COST TRACKER MAIN (actuals only, v0.42) -----
  const ctmHeader = [
    'Cost Reconciled', 'Store (e.g., WF 30)', 'PM DRI', 'Ops Manager',
    'Service Type', '# of Carts', 'Service Month', 'Service Completion Date',
    'Caper # Techs', 'Caper Technician(s)',
    'Actual Labor Cost (Caper)', 'Actual Travel Cost (Caper)', 'Actual Expenses (Caper)',
    'Service Delay',
    'Third Party Vendor', 'Actual Third Party Cost',
    'Actual Total (Caper + 3P)', 'Invoice', 'Notes',
  ];
  const ctmDataRows = costRows.map((r, i) => {
    const xr = i + 2;
    return [
      r.cost_reconciled || 'No',
      r.store_name || '',
      r.pm_dri || '',
      r.ops_manager || '',
      r.service_type || '',
      r.cart_count || '',
      r.service_month || '',
      r.service_date || '',
      r.num_techs || '',
      r.tech_names || '',
      r.actual_labor != null ? +r.actual_labor.toFixed(2) : '',
      r.actual_travel != null ? +r.actual_travel.toFixed(2) : '',
      r.actual_expenses != null ? +r.actual_expenses.toFixed(2) : '',
      r.service_delay || 'None',
      r.has_third_party ? 'Yes' : 'No',
      r.third_party_cost != null ? +r.third_party_cost.toFixed(2) : 0,
      `=IF($B${xr}="","",SUM(IF($K${xr}="",0,$K${xr}),IF($L${xr}="",0,$L${xr}),IF($M${xr}="",0,$M${xr}),IF($P${xr}="",0,$P${xr})))`,
      r.invoice_link || '',
      r.notes || '',
    ];
  });

  // ----- DASHBOARD (actuals only) -----
  const months = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
  const byMonthType = {};
  for (const r of costRows) {
    if (!r.service_month) continue;
    const m = r.service_month, t = r.service_type || 'Other';
    byMonthType[m] = byMonthType[m] || { Deployment: 0, Retrofit: 0, Other: 0, Count: 0 };
    const bucket = ['Deployment','Retrofit'].includes(t) ? t : 'Other';
    byMonthType[m][bucket] += (r.actual_total || 0);
    byMonthType[m].Count   += 1;
  }
  const monthsWithData = months.filter(m => byMonthType[m]);
  const dashRows = [
    ['Caper CostWise — Cost Tracker Dashboard (actuals only)'],
    [],
    ['Service Month', 'Actual: Deployment', 'Actual: Retrofit', 'Actual: Other', 'GRAND TOTAL Actual', '# Work Orders'],
  ];
  monthsWithData.forEach((m, i) => {
    const xr = i + 4;
    const v = byMonthType[m];
    dashRows.push([
      m,
      +v.Deployment.toFixed(2), +v.Retrofit.toFixed(2), +v.Other.toFixed(2),
      `=SUM(B${xr}:D${xr})`,
      v.Count,
    ]);
  });
  if (monthsWithData.length) {
    const totalRow = monthsWithData.length + 4;
    dashRows.push([
      'Total',
      `=SUM(B4:B${totalRow - 1})`, `=SUM(C4:C${totalRow - 1})`, `=SUM(D4:D${totalRow - 1})`,
      `=SUM(E4:E${totalRow - 1})`, `=SUM(F4:F${totalRow - 1})`,
    ]);
  }

  const tabs = {
    'COST TRACKER MAIN': [ctmHeader, ...ctmDataRows],
    'DASHBOARD':         dashRows,
  };
  for (const [tabName, rows] of Object.entries(tabs)) {
    await writeTab(sheetId, tabName, rows);
  }
  return {
    pushed_at: new Date().toISOString(),
    sheet_id: sheetId,
    sheet_url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    tabs: Object.keys(tabs),
    rows_written: costRows.length,
  };
}

function aoaFromObjects(rows) {
  if (!rows.length) return [['(no data)']];
  const headers = Object.keys(rows[0]);
  return [headers, ...rows.map(r => headers.map(h => r[h]))];
}

module.exports = {
  isConfigured,
  pushDashboardToSheet,
  // exported for testability
  loadServiceAccount,
  getAccessToken,
  writeTab,
};

// lib/expensify.js — v0.48
//
// Expensify Integration Server client. Used by the FTE field-tech invoice
// flow to route line items into Expensify for manager approval inside
// Expensify's workflow (instead of the contractor PDF → AP route).
//
// Setup (one-time, by IT admin):
//   1. In Expensify, generate a partner credential pair:
//      Settings → Account Settings → Integrations → REST API Credentials
//   2. Save them via PUT /api/settings/integrations:
//      {
//        "expensify_partner_user_id":  "<partner_userId>",
//        "expensify_partner_password": "<partner_userSecret>",
//        "expensify_policy_id":        "<policyID for the Cart Tech Ops policy>"
//      }
//   3. Make sure each FTE field tech is invited into the Expensify policy
//      with the same email they use in this app (we attribute reports by
//      employeeEmail).
//
// If creds are missing the route falls back to a stubbed response so the
// rest of the app keeps working in dev.

const STUB_MODE_PREFIX = 'R-STUB-';

// Convert a dollar amount (e.g. 12.34) to Expensify's expected integer cents.
function toCents(amount) {
  const n = Number(amount);
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

// Map our app's expense category to a plausible Expensify category. Expensify
// admins define their own category list, so the caller (or admin) can
// override per-policy via the expensify_category_map setting.
function defaultCategoryFor(category) {
  return ({
    mileage:  'Car, Mileage and Travel',
    tolls:    'Car, Mileage and Travel',
    parking:  'Car, Mileage and Travel',
    travel:   'Car, Mileage and Travel',
    meal:     'Meals & Entertainment',
    lodging:  'Travel',
    supplies: 'Supplies',
    other:    'Other',
  })[category] || 'Other';
}

function isConfigured(creds) {
  return !!(creds && creds.partnerUserID && creds.partnerUserSecret && creds.policyID);
}

// Translate an invoice's time-entries + expenses into Expensify transactions.
// Each row becomes one expense in the Expensify report.
function buildTransactions({ time_entries = [], expenses = [], hourly_rate = 40, mileage_rate = 0.7 }) {
  const txns = [];

  // Time entries → labor expenses (one per WO-day). Expensify doesn't have a
  // first-class "labor hours" category, so we book it as an expense with the
  // computed dollar value and a clear comment.
  for (const t of time_entries) {
    if (!t.clock_in || !t.clock_out) continue;
    const hours = (new Date(t.clock_out) - new Date(t.clock_in)) / 3600000;
    if (hours <= 0) continue;
    const amount = +(hours * hourly_rate).toFixed(2);
    txns.push({
      created: t.clock_in.slice(0, 10),
      amount:  toCents(amount),
      currency: 'USD',
      category: 'Labor',
      merchant: `${t.store_name || 'Field work'} · ${t.external_id || ''}`.trim(),
      comment:  `${hours.toFixed(2)} hrs · ${t.work_type || 'maintenance'} · WO ${t.external_id || t.work_order_id}`,
    });
  }

  // Receipt expenses → 1:1 mapping. Mileage is encoded with the rate in the
  // comment so the approver can sanity-check.
  for (const e of expenses) {
    if (!e.amount || e.amount <= 0) continue;
    const comment = e.category === 'mileage' && e.miles
      ? `${e.miles} mi × $${mileage_rate.toFixed(3)}/mi · ${e.notes || ''}`.trim()
      : (e.notes || e.merchant || '');
    txns.push({
      created:  (e.expense_date || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
      amount:   toCents(e.amount),
      currency: 'USD',
      category: defaultCategoryFor(e.category),
      merchant: e.merchant || e.store_name || e.category || 'Expense',
      comment,
    });
  }

  return txns;
}

// Create a report in Expensify. Returns { reportID, reportURL, totalCents }.
// In stub mode (no creds), returns a fake reportID so the rest of the flow
// can be exercised end-to-end without hitting Expensify.
async function createReport({ employeeEmail, reportName, transactions }, creds) {
  if (!employeeEmail) throw new Error('employeeEmail required');
  if (!reportName)    throw new Error('reportName required');
  if (!Array.isArray(transactions) || !transactions.length) {
    throw new Error('at least one transaction required');
  }
  const totalCents = transactions.reduce((s, t) => s + (Number(t.amount) || 0), 0);

  if (!isConfigured(creds)) {
    // Stub mode — useful for local dev / when no Expensify policy exists yet.
    const stubId = STUB_MODE_PREFIX + Date.now().toString().slice(-8);
    return {
      reportID:  stubId,
      reportURL: `https://www.expensify.com/reports?param={%22reportID%22:%22${stubId}%22}`,
      totalCents,
      stubbed:   true,
      message:   'Expensify partner credentials not configured — stub report created locally.',
    };
  }

  // Expensify Integration Server — form-encoded body with a JSON job description.
  // Documented at https://integrations.expensify.com/Integration-Server/doc/
  const requestJobDescription = {
    type: 'create',
    credentials: {
      partnerUserID:     creds.partnerUserID,
      partnerUserSecret: creds.partnerUserSecret,
    },
    inputSettings: {
      type:           'report',
      policyID:       creds.policyID,
      employeeEmail,
      reportName,
      transactionList: transactions,
    },
  };
  const body = new URLSearchParams({ requestJobDescription: JSON.stringify(requestJobDescription) });

  const resp = await fetch('https://integrations.expensify.com/Integration-Server/ExpensifyIntegrations', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* Expensify sometimes returns plain text on error */ }

  if (!resp.ok || (json && json.responseCode && json.responseCode !== 200)) {
    const errMsg = (json && (json.responseMessage || json.message)) || text.slice(0, 200) || `HTTP ${resp.status}`;
    throw new Error(`Expensify ${resp.status}: ${errMsg}`);
  }
  const reportID = json && (json.reportID || (json.reportList && json.reportList[0]?.reportID));
  if (!reportID) throw new Error(`Expensify response missing reportID: ${text.slice(0, 200)}`);

  return {
    reportID:  String(reportID),
    reportURL: `https://www.expensify.com/reports?param={%22reportID%22:%22${reportID}%22}`,
    totalCents,
    stubbed:   false,
  };
}

module.exports = {
  isConfigured,
  buildTransactions,
  createReport,
  toCents,
  STUB_MODE_PREFIX,
};

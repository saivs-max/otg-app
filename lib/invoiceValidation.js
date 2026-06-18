// lib/invoiceValidation.js — v0.1
//
// Post-extraction validation gate for uploaded invoices.
//
// The extractors (pdfExtractor.js / vendorPdfExtractor.js) are deliberately
// tolerant: anything they can't parse comes back as null. On its own that
// means a mis-extraction posts to the ledger silently — a phone number read
// as a total, a missing line-item table, a scanned page that yields nothing.
//
// This module is the safety net. Given an extraction result it returns:
//
//   { confidence: 0..1, needs_review: boolean, issues: [{code, severity, msg}] }
//
//   severity: 'critical' -> must not auto-post; route to human review
//             'warn'     -> usable but a field is missing/uncertain
//             'info'     -> FYI
//
// Recommended use (in routes/invoices.js, right after extraction and BEFORE
// importExtractedSummary):
//
//   const v = validateInvoice({ kind: 'vendor', extraction: r, text: r.text });
//   if (v.needs_review) { /* save as draft, surface v.issues, do NOT auto-post */ }
//
// Nothing here throws; worst case it returns needs_review:true.

const TOL = 0.02; // dollars
const approxEq = (a, b) => a != null && b != null && Math.abs(a - b) <= TOL;

// Independently re-read the stated money figures from the raw text. This is on
// purpose NOT the parser's own logic — it's a second opinion to reconcile
// against, so a parser bug can't validate itself.
function statedMoney(text) {
  const t = text || '';
  const grab = (re) => { const m = t.match(re); return m ? Number(m[1].replace(/[,$\s]/g, '')) : null; };
  return {
    subtotal: grab(/Sub-?total\s*:?\s*\$?\s*([\d,]+\.\d{2})/i),
    tax:      grab(/\bTax\s*:?\s*\$?\s*([\d,]+\.\d{2})/i),
    total:    grab(/(?:Total Due|Balance Due|Amount Due|Grand Total)\s*:?\s*\$?\s*([\d,]+\.\d{2})/i),
  };
}

// A value that looks like a phone area code or street number rather than money:
// an integer (no cents) that also appears glued to a phone/address in the text.
function looksLikeArtifactTotal(total, text) {
  if (total == null || !Number.isInteger(total)) return false;
  const s = String(total);
  const phone = new RegExp(`\\b${s}[-.\\s]\\d{3}[-.\\s]\\d{4}\\b`);          // 267-524-6090
  const addr  = new RegExp(`\\b${s}\\s+[A-Z][a-z]+\\s+(?:St|Ave|Dr|Rd|Blvd|Way|Ln|Ct|Pike|Pkwy|Hwy|Drive|Street|Road)\\b`);
  return phone.test(text || '') || addr.test(text || '');
}

function validateInvoice({ kind, extraction, text }) {
  const issues = [];
  const add = (severity, code, msg) => issues.push({ severity, code, msg });
  const ext = extraction || {};
  text = text || ext.text || '';

  if (ext.ok === false) {
    add('critical', 'extract_failed', `Extraction failed: ${ext.error || 'unknown error'}`);
    return finalize(issues);
  }

  // 1. Scanned / no text layer — parser can see nothing.
  if (ext.scanned || (ext.text_chars != null && ext.text_chars < 100)) {
    add('critical', 'scanned_pdf',
      'PDF has little or no extractable text (likely a scan/photo). Run OCR or enter manually.');
    return finalize(issues); // nothing else is trustworthy
  }

  const stated = statedMoney(text);

  if (kind === 'vendor') {
    const total = ext.total;
    const items = ext.line_items || [];
    const sum = +(items.reduce((a, x) => a + (x.amount || 0), 0)).toFixed(2);

    if (total == null) add('critical', 'no_total', 'No invoice total could be extracted.');
    else if (looksLikeArtifactTotal(total, text))
      add('critical', 'total_artifact', `Total ${total} matches a phone/address pattern, not a money value.`);
    else if (stated.total != null && !approxEq(total, stated.total))
      add('critical', 'total_mismatch', `Parsed total ${total} != stated "Total Due" ${stated.total}.`);

    if (!ext.vendor_name) add('warn', 'no_vendor', 'No vendor name extracted.');
    if (!ext.vendor_invoice_number) add('warn', 'no_invoice_number', 'No vendor invoice number extracted.');
    if (!ext.vendor_invoice_date) add('warn', 'no_date', 'No invoice date extracted.');

    if (items.length === 0) add('warn', 'no_line_items', 'No line items extracted.');
    else if (stated.subtotal != null && !approxEq(sum, stated.subtotal))
      add('critical', 'lineitems_mismatch',
        `Line items sum to ${sum} but stated subtotal is ${stated.subtotal}.`);

    if (stated.subtotal != null && stated.tax != null && stated.total != null &&
        !approxEq(+(stated.subtotal + stated.tax).toFixed(2), stated.total))
      add('warn', 'doc_math_off', `Document math: subtotal + tax != total (${stated.subtotal}+${stated.tax} vs ${stated.total}).`);

  } else if (kind === 'contractor') {
    const s = (ext.summary && ext.summary.totals) || {};
    const total = s.total;
    if (total == null) add('critical', 'no_total', 'No invoice total could be extracted.');
    else if (looksLikeArtifactTotal(total, text))
      add('critical', 'total_artifact', `Total ${total} matches a phone/address pattern, not a money value.`);

    const header = (ext.summary && ext.summary.header) || {};
    if (!header.invoice_number) add('warn', 'no_invoice_number', 'No invoice number extracted.');
    if (!header.full_name)      add('warn', 'no_name', 'No contractor name extracted.');

    const labor = (ext.summary && ext.summary.line_items) || [];
    if (labor.length === 0) add('warn', 'no_line_items', 'No labor line items extracted.');
    if (s.subtotal != null && total != null && total + TOL < s.subtotal)
      add('critical', 'total_lt_subtotal', `Total ${total} is less than subtotal ${s.subtotal}.`);
  } else {
    add('warn', 'unknown_kind', `Unknown invoice kind "${kind}".`);
  }

  return finalize(issues);
}

function finalize(issues) {
  const weight = { critical: 0.6, warn: 0.18, info: 0 };
  let confidence = 1;
  for (const i of issues) confidence -= (weight[i.severity] || 0);
  confidence = Math.max(0, +confidence.toFixed(2));
  const needs_review = issues.some(i => i.severity === 'critical') || confidence < 0.7;
  return { confidence, needs_review, issues };
}

module.exports = { validateInvoice, statedMoney, looksLikeArtifactTotal };

#!/usr/bin/env node
// test/invoice-accuracy/app-roundtrip.js
//
// Regression test for the "app-generated invoice re-uploads extract as $0" bug
// (fixed v1.06). When an Ops Manager uploads a PDF that the app itself generated
// (lib/invoicePdf.js, PDFKit), pdf-parse renders each labor row with the DATE
// cell GLUED to the details/amount ("13-Apr[4/13] [Maintenance] MaintainX #16")
// and empty days as "14-Apr0.00$40.00$0.00". The old day-header regex
// (/^(\d{1,2})-([A-Za-z]{3})$/) required the date to stand alone on its line, so
// it matched NO row → extractLaborLines produced ZERO line items → the import
// created no rows → computeInvoice summed nothing → the invoice posted as $0,
// silently (validation rated a missing labor table only a 'warn').
//
// This test feeds the CAPTURED pdf-parse text of a real app-generated $184
// invoice straight into the production parser + validator. It needs no DB and no
// PDF generation, so it is independent of the separate contactEmail fix (v1.05).
//
//   node test/invoice-accuracy/app-roundtrip.js      (or: npm run test:invoice-roundtrip)
'use strict';

const assert = require('node:assert');
const { parseInvoiceText } = require('../../lib/pdfExtractor');
const { validateInvoice }  = require('../../lib/invoiceValidation');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL-', name, '\n       ', e.message); }
}

// ---- Fixture: exact pdf-parse text of an app-generated invoice (tech @ $40/hr,
// one 4.60h maintenance visit = $184.00, the rest of the week empty). Captured
// from generateInvoicePdf -> pdf-parse; note the glued DATE+details and the glued
// empty-day rows, which the pre-v1.06 parser could not read.
const APP_PDF_TEXT = [
  '', '',
  'Full Name', 'Jane Tech',
  'Home Address', '123 Main St, Trenton, NJ 08608',
  'Phone Number', '555-123-4567',
  'INVOICE #00042',
  'Apr 19',
  'Invoice To:', 'Instacart, Inc.', 'Hardware Operations Caper — AP', '50 Beale St', 'San Francisco, CA 94105',
  'FOR', 'Hourly Services',
  'DATEDETAILS / PURPOSESTARTENDHOURSRATEAMOUNT',
  '13-Apr[4/13] [Maintenance] MaintainX #16',
  'Retailer: ShopRite',
  'Weight calibration check',
  '12:00 PM4:36 PM4.60$40.00$184.00',
  '14-Apr0.00$40.00$0.00',
  '15-Apr0.00$40.00$0.00',
  '16-Apr0.00$40.00$0.00',
  '17-Apr0.00$40.00$0.00',
  '18-Apr0.00$40.00$0.00',
  '19-Apr0.00$40.00$0.00',
  'Total Work Hours', '4.60',
  'SUBTOTAL', '$184.00',
  'TOTAL', '$184.00',
  'Payable in USD to Jane Tech',
  'If you have any questions concerning this invoice, use the following contact information:',
  'Email: ap@instacart.com   ·   Mobile: 555-123-4567',
].join('\n');

// ---- 1. The core bug: app-generated PDF must yield the labor line + right total
check('app-generated PDF extracts the labor line item (was 0)', () => {
  const s = parseInvoiceText(APP_PDF_TEXT);
  assert.ok(s.line_items.length >= 1, `expected >=1 line item, got ${s.line_items.length}`);
  const it = s.line_items[0];
  assert.strictEqual(it.hours, 4.6, `hours ${it.hours}`);
  assert.strictEqual(it.amount, 184, `amount ${it.amount}`);
  assert.strictEqual(it.rate, 40, `rate ${it.rate}`);
  assert.strictEqual(it.start, '12:00 PM', `start ${it.start}`);
  assert.strictEqual(it.end, '4:36 PM', `end ${it.end}`);
});

check('app-generated PDF total + subtotal parse to 184 (not 0)', () => {
  const s = parseInvoiceText(APP_PDF_TEXT);
  assert.strictEqual(s.totals.total, 184, `total ${s.totals.total}`);
  assert.strictEqual(s.totals.subtotal, 184, `subtotal ${s.totals.subtotal}`);
});

check('empty (0-hour) days are NOT emitted as line items', () => {
  const s = parseInvoiceText(APP_PDF_TEXT);
  assert.strictEqual(s.line_items.length, 1, `expected exactly 1 item, got ${s.line_items.length}`);
});

check('header still parses (invoice number + name)', () => {
  const s = parseInvoiceText(APP_PDF_TEXT);
  assert.strictEqual(s.header.invoice_number, '00042');
  assert.strictEqual(s.header.full_name, 'Jane Tech');
});

// ---- 2. Backward compatibility: the Brennan/Sbot template (date ALONE on its
// own line, details/time on following lines) must still parse unchanged.
check('date-alone (Brennan/Sbot) layout still parses', () => {
  const brennan = [
    '13-Apr',
    '[4/13] [Weight Calibration Check] ShopRite of Bridge & Harbison - 12816',
    'Retailer:ShopRite of Bridge & Harbison',
    '9:30 AM11:30 AM2.00$40.00$80.00',
  ].join('\n');
  const s = parseInvoiceText(brennan);
  assert.strictEqual(s.line_items.length, 1, `expected 1 item, got ${s.line_items.length}`);
  assert.strictEqual(s.line_items[0].amount, 80, `amount ${s.line_items[0].amount}`);
  assert.strictEqual(s.line_items[0].hours, 2, `hours ${s.line_items[0].hours}`);
});

// ---- 2b. Hardening: a free-text note that merely starts like a date
// ("15-May reschedule…", with a space after the month) must NOT be read as a day
// header and re-date the following row. With the pre-hardening regex this item
// would have been mis-dated to 2026-05-15; it must stay on 13-Apr.
check('a "NN-Mon <space>text" note does not steal the row date', () => {
  const withNote = [
    '13-Apr[4/13] [Maintenance] MaintainX #16',
    '15-May reschedule was requested by the store manager',
    '12:00 PM4:36 PM4.60$40.00$184.00',
  ].join('\n');
  const s = parseInvoiceText(withNote);
  assert.strictEqual(s.line_items.length, 1, `expected 1 item, got ${s.line_items.length}`);
  // month-day only (normalizeDate infers the year from the current date for "13-Apr")
  assert.ok(s.line_items[0].date.endsWith('-04-13'),
    `date ${s.line_items[0].date} — the May note stole the row date`);
  assert.strictEqual(s.line_items[0].amount, 184, `amount ${s.line_items[0].amount}`);
});

// ---- 3. Validation gate: fixed extraction auto-imports; a broken extraction
// (positive total, zero line items) is HELD for review, never silently $0.
check('validation: parsed items => needs_review is false (auto-import ok)', () => {
  const text = APP_PDF_TEXT;
  const summary = parseInvoiceText(text);
  const extraction = { ok: true, scanned: false, text_chars: text.length, text, summary };
  const v = validateInvoice({ kind: 'contractor', extraction, text });
  assert.strictEqual(v.needs_review, false, `needs_review ${v.needs_review}; issues=${JSON.stringify(v.issues)}`);
});

check('validation: total present but ZERO line items => flagged for review (not $0)', () => {
  const text = 'SUBTOTAL\n$184.00\nTOTAL\n$184.00\n';
  const extraction = {
    ok: true, scanned: false, text_chars: 500, text,
    summary: { header: { invoice_number: 'X1', full_name: 'A B' },
               line_items: [], totals: { total: 184, subtotal: 184 } },
  };
  const v = validateInvoice({ kind: 'contractor', extraction, text });
  assert.strictEqual(v.needs_review, true, `needs_review ${v.needs_review}`);
  assert.ok(v.issues.some(i => i.severity === 'critical' && i.code === 'no_line_items_but_total'),
    `expected critical no_line_items_but_total, got ${JSON.stringify(v.issues)}`);
});

console.log(failures ? `\nFAILED (${failures})` : '\nAll app-roundtrip checks passed');
process.exit(failures ? 1 : 0);

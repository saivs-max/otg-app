#!/usr/bin/env node
// Invoice parser accuracy + validation harness.
//
//   node test/invoice-accuracy/run-accuracy.js
//
// Drops every PDF in the fixtures dir through the production extractors and the
// validation gate, then (if a ground-truth key is present) scores total
// accuracy. Use it as a regression gate whenever the parsers change.
//
//   FIXTURES=/path/to/pdfs   node test/invoice-accuracy/run-accuracy.js
//   (defaults to ./fixtures next to this file)
//
// Ground truth: optional groundtruth.json keyed by filename-without-.pdf, e.g.
//   { "acme_001": { "type":"vendor", "gt_total": 426.05 } }
// See groundtruth.example.json.
const _n = () => {}; console.warn = _n; console.error = _n; // hush pdf.js font warnings
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { extractFromPdfBuffer } = require('../../lib/pdfExtractor');
const { extractVendorPdf }     = require('../../lib/vendorPdfExtractor');
const { validateInvoice }      = require('../../lib/invoiceValidation');

const FIX = process.env.FIXTURES || path.join(__dirname, 'fixtures');
const GT  = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'groundtruth.json'))); }
                     catch { return {}; } })();
const eq = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.02;

function classify(t) {
  t = t || '';
  if (t.trim().length < 200) return 'scanned';
  if (/Kept Companies|PO BOX 36014|Newark, NJ 07188|Total Due/i.test(t) &&
      !/MILEAGE REIMBURSEMENT|Hourly Services/i.test(t)) return 'vendor';
  return 'contractor';
}

(async () => {
  if (!fs.existsSync(FIX)) { console.log('No fixtures dir at', FIX); process.exit(1); }
  const files = fs.readdirSync(FIX).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
  let scored = 0, correct = 0, wrong = 0, review = 0, autoOk = 0;
  const rows = [['file', 'kind', 'total', 'gt', 'verdict', 'gate', 'conf'].join('\t')];

  for (const f of files) {
    const buf = fs.readFileSync(path.join(FIX, f));
    let text = ''; try { text = (await pdf(buf)).text || ''; } catch {}
    const kind = classify(text) === 'vendor' ? 'vendor' : 'contractor';
    const ext = kind === 'vendor' ? await extractVendorPdf(buf) : await extractFromPdfBuffer(buf);
    const total = kind === 'vendor' ? ext.total
                                    : (ext.summary && ext.summary.totals && ext.summary.totals.total);
    const v = validateInvoice({ kind, extraction: ext, text: ext.text });
    v.needs_review ? review++ : autoOk++;

    const g = GT[f.replace(/\.pdf$/i, '')];
    let verdict = '';
    if (g && g.gt_total != null) {
      scored++;
      if (eq(total, g.gt_total)) { verdict = 'CORRECT'; correct++; }
      else if (total != null)    { verdict = 'WRONG';   wrong++; }
      else                        verdict = 'NULL';
    }
    rows.push([f, kind, total ?? '', g ? (g.gt_total ?? '') : '', verdict,
               v.needs_review ? 'REVIEW' : 'auto-ok', v.confidence].join('\t'));
  }

  console.log(rows.join('\n'));
  console.log('\n--- summary ---');
  console.log(`invoices: ${files.length}   auto-ok: ${autoOk}   review: ${review}`);
  if (scored) console.log(`scored on total: ${scored}   correct: ${correct}   wrong: ${wrong}`);
  // Non-zero exit if any total is confidently wrong — handy as a CI gate.
  process.exit(wrong > 0 ? 1 : 0);
})();

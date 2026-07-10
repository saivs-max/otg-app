// lib/vendorPdfExtractor.js — v0.39
//
// Generic 3rd-party vendor invoice / statement PDF parser. Tries to pull
// out enough metadata that the Ops Mgr only has to confirm-and-submit:
//
//   { vendor_name, vendor_invoice_number, vendor_invoice_date, total,
//     extracted_text, header_lines, totals_candidates }
//
// Unlike `pdfExtractor.js` (which is tuned to the Brennan/Sbot contractor
// invoice template), this parser doesn't know what it's looking at. It
// uses these heuristics, in order of how reliable they tend to be:
//
//   * vendor_invoice_date — "Statement Date / Invoice Date / Date" labels.
//     Falls back to the first plausible date on the page.
//   * total              — "Balance Due / Amount Due / Total Due / Grand
//     Total / TOTAL" labels with $ amounts; falls back to the largest
//     dollar amount in the document (vendor invoices almost always have
//     the grand total as the largest number).
//   * vendor_invoice_number — "Invoice #, Statement #, Customer #,
//     Reference #, Ref #". Falls back to any 4–10 digit number on the
//     same line as the date label.
//   * vendor_name — the first ALL-CAPS line near the top that isn't us
//     (Maplebear / Instacart). Falls back to scanning for a "From:" or
//     "Remit To:" block, then to the vendor address city/state line.
//
// Each field returns `null` when nothing matches — the upload endpoint
// then asks the user to fill it manually. Nothing here throws; the worst
// case is everything-null.
const pdf = require('pdf-parse');
const { ocrPdf } = require('./ocr');   // v0.74 — OCR fallback for image-only PDFs

// Names we treat as the buyer (us). Anything matching is excluded from
// vendor_name candidates.
const BUYER_PATTERNS = [
  /MAPLEBEAR/i, /INSTACART/i, /CART\s*TECH\s*OPS/i, /HARDWARE\s*OPERATIONS\s*CAPER/i,
];

async function extractVendorPdf(buf) {
  let parsed = { text: '', numpages: 0, info: {} };
  try { parsed = await pdf(buf); } catch (_) { /* corrupt / no text layer — OCR may still read it */ }
  let text  = parsed.text || '';
  let chars = text.trim().length;
  let usedOcr = false;

  // v0.74 — no usable text layer (image-only / scanned PDF)? Try OCR: rasterize
  // the pages and run tesseract, then parse the recovered text with the same
  // shapes. Non-fatal — if the OCR binaries aren't installed or it fails, we keep
  // the scanned result and the upload falls back to manual entry as before.
  const looksScanned = chars < Math.max(100, (parsed.numpages || 1) * 25);
  if (looksScanned) {
    try {
      const ocrText = await ocrPdf(buf);
      if (ocrText && ocrText.trim().length > Math.max(chars, 40)) {
        text = ocrText; chars = text.trim().length; usedOcr = true;
      }
    } catch (_) { /* OCR unavailable — fall through to the scanned flag */ }
  }

  const summary = parseVendorText(text);
  const scanned = !usedOcr && chars < Math.max(100, (parsed.numpages || 1) * 25);
  return {
    ok: true,
    text,
    pages: parsed.numpages || 0,
    info: parsed.info || {},
    text_chars: chars,
    scanned,
    ocr: usedOcr,          // true → fields were recovered via OCR; UI should nudge a double-check
    ...summary,
  };
}

function parseVendorText(rawText) {
  const allLines = rawText.split(/\r?\n/).map(l => l.trim());
  const lines    = allLines.filter(l => l.length > 0);

  return {
    vendor_invoice_date:    findInvoiceDate(rawText, lines),
    total:                  findTotal(rawText, lines),
    vendor_invoice_number:  findInvoiceNumber(rawText, lines),
    vendor_name:            findVendorName(rawText, lines),
    line_items:             findLineItems(rawText, lines),
    extracted_text:         rawText,
  };
}

// ---------- Line items ----------
// Vendor invoices/statements typically have rows like:
//   04/07/2026 0177066-IN SERVICE        355.06 355.06
//   05/15/2026 INV-1234   Repair: cart  1,200.00
//   1   Onsite labor (8 hrs)            $640.00
// We try a few common shapes. Each item we recognize gets:
//   { date, reference, description, qty, unit_price, amount }
// Anything we can't parse cleanly gets dropped (rather than guessed) so
// the user-facing preview only shows confident matches.
// v0.74 — Adaptive line-item extraction. Vendor PDFs come in many layouts and
// pdf-parse glues/reorders columns differently per exporter, so instead of
// locking onto the first regex that fires we run EVERY shape, then pick the set
// that best fits the invoice: the one whose amounts sum to the printed Subtotal
// (when we can read one), else the one with the most rows. Each shape is still
// conservative (drops anything it can't parse cleanly) so a bad guess loses to a
// confident one. Add new vendor layouts as another extractor in `shapes` below.
function findLineItems(text, lines) {
  const subtotal = findSubtotal(text, lines);
  const candidates = [];
  const add = (arr) => { if (arr && arr.length) candidates.push(arr); };

  // Shape A0 — Kept Companies glued service table:
  //   "2/20/20263537270Cart - Repair10$18.00$180.00"
  //    <date><WO#><description><qty>$<unit>$<amount>
  add((() => {
    const re = /^(\d{1,2}\/\d{1,2}\/\d{2,4})(\d{5,})(.+?)(\d{1,4})\$([\d,]+\.\d{2})\$([\d,]+\.\d{2})$/;
    const out = [];
    for (const ln of lines) {
      const m = ln.match(re); if (!m) continue;
      const amount = parseDollar(m[6]); if (amount == null || amount <= 0) continue;
      out.push({ date: normalizeDate(m[1]), reference: m[2], description: m[3].trim(), qty: Number(m[4]), unit_price: parseDollar(m[5]), amount });
    }
    return out;
  })());

  // Shape D — product table where pdf-parse reorders + glues columns (TRUNO/Crystal):
  //   "EPS-C31CK50022Each$285.59 $285.59  0.0XBVQ099564Epson … WiFi1.01.0"
  //    <item><UM>$<price> $<amount> <bko><serial><description><order><ship>
  // Anchored on item-code + unit word + two dollar amounts; the trailing columns
  // are peeled procedurally because their glued order varies between exporters.
  add((() => {
    const UM = '(?:Each|EA|Ea|PCS|Pcs|Pc|Units?|Sets?|Box(?:es)?|Cases?|Rolls?|Hours?|Hrs?|Days?|Lot|Kit|Pair|Pkg|Ft|Yd|Lb|Gal|Hr)';
    const re = new RegExp('^([A-Z0-9][A-Z0-9.\\-\\/]{2,}?)' + UM + '\\$\\s*([\\d,]+\\.\\d{2})\\s*\\$\\s*([\\d,]+\\.\\d{2})(.*)$');
    const out = [];
    for (const ln of lines) {
      const m = ln.match(re); if (!m) continue;
      const unit_price = parseDollar(m[2]); const amount = parseDollar(m[3]);
      if (amount == null || amount <= 0) continue;
      let tail = (m[4] || '').replace(/^[\s\d.]+/, '');           // drop BkO / leading nums+spaces
      let serial = null;
      const sm = tail.match(/^([A-Z]{2,}\d{3,})/);                 // serial: letters then digits
      if (sm) { serial = sm[1]; tail = tail.slice(serial.length); }
      const description = tail.replace(/[\d.\s]+$/, '').trim();    // drop trailing order/ship nums
      if (!/[A-Za-z]/.test(description)) continue;
      const qty = (unit_price && unit_price > 0) ? +(amount / unit_price).toFixed(2) : null;
      out.push({ date: null, reference: m[1], serial, description, qty, unit_price, amount });
    }
    return out;
  })());

  // Shape E — clean column table "DESCRIPTION  QTY  UNIT PRICE  TOTAL", spaced or glued:
  //   "Service Agreement - Light Capacity 1 $1,025.00 $1,025.00"
  //   "Calibration Services - After Hours rate0.5$180.00$90.00"
  // The 2nd amount is optional (some tables print only the line total).
  add((() => {
    // qty is optional — OCR sometimes drops it ("Emergency Dispatch $300.00 $300.00").
    const re = /^([A-Za-z][^$]*?)\s*(\d+(?:\.\d+)?)?\s*\$\s*([\d,]+\.\d{2})(?:\s*\$\s*([\d,]+\.\d{2}))?\s*$/;
    // Exact summary/column-header labels to exclude (NOT a prefix test — a real
    // description like "Service Agreement…" legitimately starts with "Service").
    const SUMMARY = /^(sub-?total|tax|vat|gst|total|balance(?:\s+due)?|amount\s+due|discount|freight|shipping|handling|description|quantity|qty|unit\s*price|total\s*price|price|amount)$/i;
    const out = [];
    for (const ln of lines) {
      const m = ln.match(re); if (!m) continue;
      const description = m[1].replace(/[\s|]+$/, '').trim();
      if (description.length < 3 || SUMMARY.test(description)) continue;
      const hasQty = m[2] != null && m[2] !== '';
      const a1 = parseDollar(m[3]);
      const a2 = m[4] != null ? parseDollar(m[4]) : null;
      if (!hasQty && a2 == null) continue;        // need a qty OR a 2nd (total) amount — skips prose w/ a price
      let qty = hasQty ? Number(m[2]) : null;
      const unit_price = a1;
      let amount;
      if (a2 != null) { amount = a2; if (qty == null && unit_price > 0) qty = +(a2 / unit_price).toFixed(2); }
      else { amount = (qty && qty > 0) ? +(a1 * qty).toFixed(2) : a1; }
      if (amount == null || amount <= 0) continue;
      out.push({ date: null, reference: null, description, qty, unit_price, amount });
    }
    return out;
  })());

  // Shape T — Truno "SERVICE INVOICE" grid (v0.76). pdf-parse scrambles the five
  // money columns (Labor / Travel / Materials / Other / Total) across adjacent
  // lines. A service call prints as:
  //   "<equipment><serial>$<labor> $<travel> $<materials>"   (3 trailing amounts)
  //   "<make/model>"                                          (optional text line)
  //   "$<other> $<total>"                                     (2 amounts)
  // We anchor on the 3-amount line, pair it with the following 2-amount line, and
  // ONLY accept the row when the five reconcile (labor+travel+materials+other ==
  // total) — a strong guard so this never fires on prose. One line item per call;
  // amount = the reconciling row total; reference = the Call Number line above.
  add((() => {
    const three = /^(.*?)\$\s*([\d,]+\.\d{2})\s+\$\s*([\d,]+\.\d{2})\s+\$\s*([\d,]+\.\d{2})\s*$/;
    const two   = /^\$\s*([\d,]+\.\d{2})\s+\$\s*([\d,]+\.\d{2})\s*$/;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(three);
      if (!m) continue;
      const lead = (m[1] || '').trim();
      if (lead.length < 4 || lead.length > 60 || !/[A-Za-z]/.test(lead) || !/\d/.test(lead)) continue;
      const labor = parseDollar(m[2]) || 0, travel = parseDollar(m[3]) || 0, materials = parseDollar(m[4]) || 0;
      let desc = null, total = null;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const t = lines[j].match(two);
        if (t) {
          const other = parseDollar(t[1]) || 0, tot = parseDollar(t[2]);
          if (tot != null && Math.abs((labor + travel + materials + other) - tot) < 0.02) total = tot;
          break;
        }
        if (!/\$/.test(lines[j]) && /[A-Za-z]/.test(lines[j]) && lines[j].length <= 60 && !desc) desc = lines[j].trim();
      }
      if (total == null || total <= 0) continue;
      const ref = (i > 0 && /^\d{4,}$/.test(lines[i - 1].trim())) ? lines[i - 1].trim() : null;
      out.push({ date: null, reference: ref, description: desc || 'Service call', qty: null, unit_price: null, amount: total });
    }
    return out;
  })());

  // Shape A — Crystal Reports / statement layout, ref glued to the first amount:
  //   "0177066-IN355.06 355.06 04/07/2026SERVICE"  (charge == credit columns)
  add((() => {
    const re = /^(.+?-[A-Z]{1,4})([\d]{1,3}(?:,\d{3})*\.\d{2})\s+([\d,]+\.\d{2})\s+([0-1]?\d[\/\-][0-3]?\d[\/\-]\d{2,4})\s*([A-Z][A-Za-z\s]{1,40}?)?\s*$/;
    const out = [];
    for (const ln of lines) {
      const m = ln.match(re); if (!m) continue;
      const ref = m[1]; const amount1 = parseDollar(m[2]); const amount2 = parseDollar(m[3]);
      const date = normalizeDate(m[4]); const desc = (m[5] || '').trim() || 'Service';
      if (amount1 == null || amount1 <= 0) continue;
      const amount = (amount2 != null && Math.abs(amount1 - amount2) < 0.01) ? amount1 : Math.max(amount1, amount2 || 0);
      if (HEADER_WORD.test(ref)) continue;
      out.push({ date, reference: ref, description: desc, amount });
    }
    return out;
  })());

  // Shape A2 — Crystal layout with no trailing description column.
  add((() => {
    const re = /^(.+?-[A-Z]{1,4})([\d]{1,3}(?:,\d{3})*\.\d{2})\s+([\d,]+\.\d{2})\s*$/;
    const out = [];
    for (const ln of lines) {
      const m = ln.match(re); if (!m) continue;
      const ref = m[1]; const amount = parseDollar(m[2]);
      if (amount == null || amount <= 0) continue;
      if (HEADER_WORD.test(ref)) continue;
      out.push({ date: null, reference: ref, description: 'Service', amount });
    }
    return out;
  })());

  // Shape B — classic "DATE  REF  DESC  …  AMOUNT".
  add((() => {
    const re = /^([0-1]?\d[\/\-][0-3]?\d[\/\-]\d{2,4})\s+([A-Z0-9][A-Z0-9\-]{1,15})\s+(.+?)\s+\$?\s*([\d,]+\.\d{2})\s*$/;
    const out = [];
    for (const ln of lines) {
      const m = ln.match(re); if (!m) continue;
      const amount = parseDollar(m[4]); if (amount == null || amount <= 0) continue;
      out.push({ date: normalizeDate(m[1]), reference: m[2], description: m[3].trim(), amount });
    }
    return out;
  })());

  // Shape C — simple "qty  description  amount" (no date / ref).
  add((() => {
    const re = /^(\d{1,4})\s+([A-Za-z][^$]{3,80}?)\s+\$?\s*([\d,]+\.\d{2})\s*$/;
    const out = [];
    for (const ln of lines) {
      const m = ln.match(re); if (!m) continue;
      const qty = Number(m[1]); const desc = m[2].trim(); const amount = parseDollar(m[3]);
      if (amount == null || amount <= 0) continue;
      out.push({ date: null, reference: null, description: desc, qty, unit_price: qty > 0 ? +(amount / qty).toFixed(2) : null, amount });
    }
    return out;
  })());

  if (!candidates.length) return [];

  // Intelligent pick: a set whose amounts sum to the printed Subtotal wins big;
  // otherwise the set with the most rows.
  const scoreOf = (items) => {
    const sum = items.reduce((s, it) => s + (it.amount || 0), 0);
    let score = items.length;
    if (subtotal && subtotal > 0) {
      const diff = Math.abs(sum - subtotal);
      if (diff < 0.02) score += 1000;
      else if (diff / subtotal < 0.02) score += 500;
    }
    return score;
  };
  candidates.sort((a, b) => scoreOf(b) - scoreOf(a));
  return candidates[0].slice(0, 200);
}

// Subtotal (pre-tax/freight) — used to score competing line-item extractions.
// Handles same-line ("Subtotal $856.77") and label/value-on-separate-lines
// layouts (Crystal prints the value just ABOVE the label).
function findSubtotal(text, lines) {
  const m = text.match(/sub\s*-?\s*total[:\s]*\$?\s*([0-9][\d,]*\.\d{2})/i);
  if (m) return parseDollar(m[1]);
  const idx = lines.findIndex(l => /^sub\s*-?\s*total\s*:?$/i.test(l));
  if (idx >= 0) {
    for (let j = idx + 1; j < Math.min(idx + 4, lines.length); j++) {
      const mm = lines[j].match(/^\$?\s*([0-9][\d,]*\.\d{2})\s*$/); if (mm) return parseDollar(mm[1]);
    }
    for (let j = idx - 1; j >= Math.max(0, idx - 4); j--) {
      const mm = lines[j].match(/^\$?\s*([0-9][\d,]*\.\d{2})\s*$/); if (mm) return parseDollar(mm[1]);
    }
  }
  return null;
}

// ---------- Date ----------
function findInvoiceDate(text, lines) {
  // Highest-priority labels first.
  const labelPatterns = [
    /statement\s*date[:\s]*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i,
    /invoice\s*date[:\s]*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i,
    /date\s*of\s*invoice[:\s]*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i,
    /invoice\s*date[:\s]*([0-9]{4}-[0-9]{2}-[0-9]{2})/i,
    /^\s*date[:\s]+([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/im,
  ];
  for (const re of labelPatterns) {
    const m = text.match(re);
    if (m) return normalizeDate(m[1]);
  }

  // Look at lines that contain "Date" and a date.
  for (const ln of lines) {
    if (!/date/i.test(ln)) continue;
    const m = ln.match(/([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/);
    if (m) return normalizeDate(m[1]);
  }

  // v0.74 — textual dates near the top: "24th June 2026", "24 June 2026",
  // "June 24, 2026". Scoped to the first ~25 lines so we don't grab a body date.
  const td = parseTextualDate(lines.slice(0, 25).join('  '));
  if (td) return td;

  // Fallback: the first plausible date on the page (skip line-item dates by
  // requiring it to appear in the first 20 non-empty lines).
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    const m = lines[i].match(/([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/);
    if (m) return normalizeDate(m[1]);
  }
  return null;
}

function normalizeDate(s) {
  if (!s) return null;
  // YYYY-MM-DD passthrough
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // M/D/YY or MM/DD/YYYY
  const sep = s.includes('/') ? '/' : '-';
  const parts = s.split(sep);
  if (parts.length !== 3) return null;
  let [m, d, y] = parts.map(p => p.trim());
  if (y.length === 2) y = (Number(y) > 80 ? '19' : '20') + y;
  m = m.padStart(2, '0'); d = d.padStart(2, '0');
  // Sanity check: 01..12 / 01..31
  const mn = Number(m), dn = Number(d), yn = Number(y);
  if (!(mn >= 1 && mn <= 12) || !(dn >= 1 && dn <= 31) || !(yn >= 1990 && yn <= 2100)) return null;
  return `${y}-${m}-${d}`;
}

// v0.74 — textual dates ("24th June 2026", "June 24, 2026", "24 June 2026").
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function parseTextualDate(s) {
  if (!s) return null;
  let m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/);   // 24th June 2026
  if (m) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo) return buildIso(m[3], mo, m[1]); }
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);     // June 24, 2026
  if (m) { const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo) return buildIso(m[3], mo, m[2]); }
  return null;
}
function buildIso(y, mo, d) {
  const yn = Number(y), dn = Number(d);
  if (!(dn >= 1 && dn <= 31) || !(yn >= 1990 && yn <= 2100)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(dn).padStart(2, '0')}`;
}

// ---------- Total ($) ----------
function findTotal(text, lines) {
  // Labeled totals, ranked.
  const labels = [
    /balance\s*due[:\s]*\$?\s*([0-9][\d,]*\.\d{2})/i,
    /total\s*due[:\s]*\$?\s*([0-9][\d,]*\.\d{2})/i,
    /amount\s*due[:\s]*\$?\s*([0-9][\d,]*\.\d{2})/i,
    /grand\s*total[:\s]*\$?\s*([0-9][\d,]*\.\d{2})/i,
    /invoice\s*total[:\s]*\$?\s*([0-9][\d,]*\.\d{2})/i,
    /total\s*amount[:\s]*\$?\s*([0-9][\d,]*\.\d{2})/i,
    /^\s*total[:\s]+\$?\s*([0-9][\d,]*\.\d{2})\s*$/im,
  ];
  for (const re of labels) {
    const m = text.match(re);
    if (m) return parseDollar(m[1]);
  }

  // Try `<label>\n<amount>` (label and value on separate lines, common in
  // table-style statements like Winter Scale's: "Balance Due" then later
  // "8,767.78").
  const labelLines = ['Balance Due', 'Total Due', 'Amount Due', 'Grand Total', 'Invoice Total'];
  for (const ll of labelLines) {
    const idx = lines.findIndex(l => new RegExp(`^${ll}$`, 'i').test(l));
    if (idx >= 0) {
      // Search forward up to 5 lines for a $ amount.
      for (let j = idx + 1; j < Math.min(idx + 6, lines.length); j++) {
        const m = lines[j].match(/^\$?\s*([0-9][\d,]*\.\d{2})\s*$/);
        if (m) return parseDollar(m[1]);
      }
    }
  }

  // Fallback: pick the largest dollar amount that appears repeatedly in
  // the document (statements typically print the grand total >=2 times,
  // e.g. once in the body and once in the aging-summary footer).
  const amounts = {};
  const re = /\$?\s*([0-9][\d,]*\.\d{2})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = parseDollar(m[1]);
    if (v == null || v < 1) continue;
    amounts[v] = (amounts[v] || 0) + 1;
  }
  // Pick the largest value with count >= 2; otherwise the absolute max.
  const repeated = Object.keys(amounts).filter(k => amounts[k] >= 2).map(Number);
  if (repeated.length) return Math.max(...repeated);
  const all = Object.keys(amounts).map(Number);
  return all.length ? Math.max(...all) : null;
}

function parseDollar(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/[,\s$]/g, ''));
  return isFinite(n) ? n : null;
}

// ---------- Invoice / Statement number ----------
// Words that look like captures from column-header rows ("Description /
// Charge / Credit / Service / Amount / Date / Authority"). These get
// discarded so we don't accidentally pull a header word in as the ID.
const HEADER_WORD = /^(description|purchase|date|charge|credit|authority|amount|balance|service|reference|payment|terms|due|invoice|ref|customer|account|number|qty|quantity|item|price|subtotal|tax|total)/i;

function findInvoiceNumber(text, lines) {
  // Highest priority: alpha-dash style ids like Kept's "X-D175108" / "x-K198051".
  // In Kept PDFs the label and value are glued ("Invoice NumberX-D175108") or
  // split across lines ("Invoice Number\nX-D175108"), so the generic same-line
  // patterns below (which require whitespace before the value) miss them
  // entirely. \s* spans the optional gap/newline; the value must start with a
  // letter + dash so we never grab a date ("Invoice Date 2/20/2026").
  const alphaDash = text.match(/Invoice\s*(?:Number|No\.?|#)\s*[:#]?\s*([A-Za-z]{1,3}-[A-Za-z]?\d{3,}[\w\-]*)/i);
  if (alphaDash) return alphaDash[1].replace(/[^A-Za-z0-9\-]/g, '');

  // v0.74 — Proposal / Quote / Estimate / Order numbers (e.g. "Proposal #2610470",
  // "Quote # Q-1234"). Many 3rd-party docs are proposals/quotes, not "invoices".
  const propNum = text.match(/(?:proposal|quote|estimate|order|sales\s*order)\s*(?:no\.?|number|#)?\s*[:#]\s*([A-Za-z]{0,4}-?\d{3,}[\w\-]*)/i);
  if (propNum) { const v = propNum[1].replace(/[^A-Za-z0-9\-]/g, ''); if (v.length >= 3 && !HEADER_WORD.test(v)) return v; }

  // Most reliable: explicit labels with the value on the SAME line.
  // We use [\t ]+ (no \n) so we don't capture the next line's text.
  const sameLineLabels = [
    /invoice\s*(?:no\.?|number|#)[:\s]*[\t ]([A-Z0-9][A-Z0-9\-\/]{2,})/i,
    /statement\s*(?:no\.?|number|#)[:\s]*[\t ]([A-Z0-9][A-Z0-9\-\/]{2,})/i,
    /reference\s*(?:no\.?|number|#)[:\s]*[\t ]([A-Z0-9][A-Z0-9\-\/]{2,})/i,
    /ref\s*#[:\s]*[\t ]([A-Z0-9][A-Z0-9\-\/]{2,})/i,
    /customer\s*(?:no\.?|number|#)[:\s]*[\t ]([A-Z0-9][A-Z0-9\-\/]{2,})/i,
    /account\s*(?:no\.?|number|#)[:\s]*[\t ]([A-Z0-9][A-Z0-9\-\/]{2,})/i,
  ];
  for (const re of sameLineLabels) {
    const m = text.match(re);
    if (m && m[1] && !HEADER_WORD.test(m[1])) {
      const v = m[1].replace(/[^A-Za-z0-9\-]/g, '');
      if (v.length >= 3) return v;
    }
  }

  // Crystal-Reports / "Powered By Crystal" PDFs lay out the *value* in the
  // text stream BEFORE the *label*. Detect this by looking for known label
  // lines that are bare ("Customer #" / "Statement #" / "Invoice #" by
  // themselves, no value after). If found, walk backwards through the
  // first 25 lines for a digit-string that's not a year or zip.
  const labelLineNeedles = ['Customer #', 'Statement #', 'Invoice #', 'Reference #', 'Account #'];
  const labelIdx = labelLineNeedles
    .map(needle => lines.findIndex(l => new RegExp(`^${needle}\\s*$`, 'i').test(l)))
    .filter(i => i >= 0);
  if (labelIdx.length) {
    for (let i = Math.min(...labelIdx) - 1; i >= 0 && i >= Math.min(...labelIdx) - 15; i--) {
      const ln = lines[i];
      const m = ln.match(/^([A-Z]{0,3}\d{4,12})$/);
      if (m && !/^(19|20)\d{2}$/.test(m[1]) && !/^\d{5}(?:-\d{4})?$/.test(m[1])) return m[1];
    }
  }

  // Last fallback: a line that's JUST a number in the first 20 non-empty lines,
  // not a year or 5-digit zip.
  for (const ln of lines.slice(0, 20)) {
    const m = ln.match(/^([A-Z]{0,3}\d{4,12})$/);
    if (!m) continue;
    if (/^(19|20)\d{2}$/.test(m[1])) continue;
    if (/^\d{5}(?:-\d{4})?$/.test(m[1])) continue;
    return m[1];
  }
  return null;
}

// ---------- Vendor name ----------
// v0.75 — NEVER GUESS. We only return a vendor name from a high-confidence
// signal; otherwise we return null and let the user pick from the saved-vendor
// dropdown or type it. The old heuristics (generic keywords like "Service",
// positional/phone-anchored scans) mis-read things like a proposal TITLE
// ("Emergency Placed in Service") as the vendor — worse than leaving it blank.
function findVendorName(text, lines) {
  // Signal 1: an explicit vendor label ("From:", "Remit To:", "Vendor:",
  // "Supplier:"). These are unambiguous, not a guess.
  const labels = [
    /(?:^|\n)\s*from[:\s]+([A-Z][A-Za-z0-9 &.,\-]{2,80})/i,
    /(?:^|\n)\s*remit\s*to[:\s]+([A-Z][A-Za-z0-9 &.,\-]{2,80})/i,
    /(?:^|\n)\s*vendor[:\s]+([A-Z][A-Za-z0-9 &.,\-]{2,80})/i,
    /(?:^|\n)\s*supplier[:\s]+([A-Z][A-Za-z0-9 &.,\-]{2,80})/i,
  ];
  for (const re of labels) {
    const m = text.match(re);
    if (m && !isBuyer(m[1])) return cleanCompanyName(m[1]);
  }

  // Signal 2: a top-of-document line carrying an UNAMBIGUOUS company-entity
  // suffix (LLC / Inc / Corp / Co / Company / Technologies / …). This is
  // recognition, not a guess — generic words (Services/Systems/Solutions/…) are
  // intentionally NOT accepted, since those are what produced false matches.
  const STRONG = /\b(LLC|L\.L\.C|INC\.?|CORP\.?|CORPORATION|LTD\.?|PLLC|LLP|CO\.|COMPAN(?:Y|IES)|TECHNOLOGIES|ENTERPRISES|HOLDINGS|INDUSTRIES|ASSOCIATES|PARTNERS|GROUP)\b/i;
  const STOP   = /^(return service|remittance|important messages?|amount enclosed|business approver|keep (?:lower|upper)|please|customer|account|invoice|statement|work order|location|page \d|p\.?\s*o\.?\s*box|to pay|bill to|ship to)/i;
  for (const ln of lines.slice(0, 30)) {
    if (ln.length < 4 || ln.length > 80) continue;
    if (isBuyer(ln) || STOP.test(ln)) continue;
    if (((ln.match(/\d/g) || []).length) > 3) continue;   // skip address-y lines
    if (STRONG.test(ln)) return cleanCompanyName(ln);
  }

  // No confident signal — leave it blank. The user selects/types the vendor.
  return null;
}

function isBuyer(s) {
  return BUYER_PATTERNS.some(re => re.test(s));
}
function cleanCompanyName(s) {
  return s.replace(/\s+/g, ' ').replace(/[,;:]+\s*$/, '').trim();
}

module.exports = { extractVendorPdf, parseVendorText };

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

// Names we treat as the buyer (us). Anything matching is excluded from
// vendor_name candidates.
const BUYER_PATTERNS = [
  /MAPLEBEAR/i, /INSTACART/i, /CART\s*TECH\s*OPS/i, /HARDWARE\s*OPERATIONS\s*CAPER/i,
];

async function extractVendorPdf(buf) {
  let parsed;
  try { parsed = await pdf(buf); }
  catch (e) { return { ok: false, error: `pdf-parse failed: ${e.message}` }; }
  const text = parsed.text || '';
  const summary = parseVendorText(text);
  const chars = text.trim().length;
  const scanned = chars < Math.max(100, (parsed.numpages || 1) * 25);
  return {
    ok: true,
    text,
    pages: parsed.numpages,
    info: parsed.info || {},
    text_chars: chars,
    scanned,
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
function findLineItems(text, lines) {
  const items = [];

  // Shape A0: Kept Companies (and similar) service tables where pdf-parse glues
  // every column together with no spaces:
  //   "2/20/20263537270Cart - Repair10$18.00$180.00"
  //    <date>     <WO#> <description><qty>$<unit>$<amount>
  // This is the dominant 3rd-party format in the Cart-Tech AP queue and the
  // old shapes matched none of it (0 line items extracted). Anchored on a
  // leading date + >=5-digit work-order number so it won't fire on prose.
  const reKept = /^(\d{1,2}\/\d{1,2}\/\d{2,4})(\d{5,})(.+?)(\d{1,4})\$([\d,]+\.\d{2})\$([\d,]+\.\d{2})$/;
  for (const ln of lines) {
    const m = ln.match(reKept);
    if (!m) continue;
    const amount = parseDollar(m[6]);
    if (amount == null || amount <= 0) continue;
    const qty = Number(m[4]);
    items.push({
      date: normalizeDate(m[1]),
      reference: m[2],
      description: m[3].trim(),
      qty,
      unit_price: parseDollar(m[5]),
      amount,
    });
  }
  if (items.length) return items.slice(0, 200);

  // Shape A: Crystal Reports / statement layout. The PDF text often glues
  // the reference directly into the first amount with no whitespace:
  //   "0177066-IN355.06 355.06 04/07/2026SERVICE"
  // We split this by walking from the right: the date and second amount
  // are space-delimited; the leftmost token is "<ref><amount>" with no
  // space, so we extract it via a non-greedy reference + amount-shape.
  // Same dollar amount appears twice (Charge + Credit columns).
  const reCrystal = /^(.+?-[A-Z]{1,4})([\d]{1,3}(?:,\d{3})*\.\d{2})\s+([\d,]+\.\d{2})\s+([0-1]?\d[\/\-][0-3]?\d[\/\-]\d{2,4})\s*([A-Z][A-Za-z\s]{1,40}?)?\s*$/;
  for (const ln of lines) {
    const m = ln.match(reCrystal);
    if (!m) continue;
    const ref     = m[1];
    const amount1 = parseDollar(m[2]);
    const amount2 = parseDollar(m[3]);
    const date    = normalizeDate(m[4]);
    const desc    = (m[5] || '').trim() || 'Service';
    if (amount1 == null || amount1 <= 0) continue;
    // Both columns should match (charge == credit). If they're wildly
    // different we probably split wrong — use the larger.
    const amount = (amount2 != null && Math.abs(amount1 - amount2) < 0.01) ? amount1 : Math.max(amount1, amount2 || 0);
    if (HEADER_WORD.test(ref))       continue;
    items.push({ date, reference: ref, description: desc, amount });
  }

  // Fallback Shape A2: same as A but no trailing description column.
  if (items.length === 0) {
    const reA2 = /^(.+?-[A-Z]{1,4})([\d]{1,3}(?:,\d{3})*\.\d{2})\s+([\d,]+\.\d{2})\s*$/;
    for (const ln of lines) {
      const m = ln.match(reA2);
      if (!m) continue;
      const ref    = m[1];
      const amount = parseDollar(m[2]);
      if (amount == null || amount <= 0) continue;
      if (HEADER_WORD.test(ref))      continue;
      items.push({ date: null, reference: ref, description: 'Service', amount });
    }
  }

  // Shape B: classic "DATE  REF  DESC  ...  AMOUNT" row.
  if (items.length === 0) {
    const reClassic = /^([0-1]?\d[\/\-][0-3]?\d[\/\-]\d{2,4})\s+([A-Z0-9][A-Z0-9\-]{1,15})\s+(.+?)\s+\$?\s*([\d,]+\.\d{2})\s*$/;
    for (const ln of lines) {
      const m = ln.match(reClassic);
      if (!m) continue;
      const date   = normalizeDate(m[1]);
      const ref    = m[2];
      const desc   = m[3].trim();
      const amount = parseDollar(m[4]);
      if (amount == null || amount <= 0) continue;
      items.push({ date, reference: ref, description: desc, amount });
    }
  }

  // Shape C: simple "qty   description   amount" lines (no date / ref).
  // Useful for vendor invoices that aren't statements but have line items
  // like "1   Onsite labor (8 hrs)   $640.00".
  if (items.length === 0) {
    const reQty = /^(\d{1,4})\s+([A-Za-z][^$]{3,80}?)\s+\$?\s*([\d,]+\.\d{2})\s*$/;
    for (const ln of lines) {
      const m = ln.match(reQty);
      if (!m) continue;
      const qty    = Number(m[1]);
      const desc   = m[2].trim();
      const amount = parseDollar(m[3]);
      if (amount == null || amount <= 0) continue;
      const unit_price = qty > 0 ? +(amount / qty).toFixed(2) : null;
      items.push({ date: null, reference: null, description: desc, qty, unit_price, amount });
    }
  }

  // Cap to 200 items to avoid PDF-text noise blowing up the response.
  return items.slice(0, 200);
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
function findVendorName(text, lines) {
  // Strategy A: label-based "From:", "Remit To:", "Vendor:".
  const labels = [
    /(?:^|\n)\s*from[:\s]+([A-Z][A-Za-z0-9 &.,\-]{2,80})/,
    /(?:^|\n)\s*remit\s*to[:\s]+([A-Z][A-Za-z0-9 &.,\-]{2,80})/,
    /(?:^|\n)\s*vendor[:\s]+([A-Z][A-Za-z0-9 &.,\-]{2,80})/,
    /(?:^|\n)\s*supplier[:\s]+([A-Z][A-Za-z0-9 &.,\-]{2,80})/,
  ];
  for (const re of labels) {
    const m = text.match(re);
    if (m && !isBuyer(m[1])) return cleanCompanyName(m[1]);
  }

  // Strategy B: PDF metadata Producer/Author/Title — many vendors generate
  // PDFs from accounting software that puts the vendor name in metadata.
  // (We don't have access to `info` here; the upload route can fall back.)

  // Strategy C: scan the first ~30 lines and pick the STRONGEST company-name
  // candidate, not merely the first. The old "return first hint" logic grabbed
  // boilerplate such as "Return Service Requested" (it matches the weak
  // "SERVICE" hint) which sits above the real vendor line ("Kept Companies,
  // Inc."). We now (a) stop-list known boilerplate phrases and (b) rank lines
  // carrying an entity suffix (Inc/LLC/Companies/Corp) above generic-word lines.
  const STRONG = /\b(LLC|L\.L\.C|INC\.?|CORP\.?|LTD\.?|PLLC|LLP|CO\.|COMPAN(?:Y|IES)|TECHNOLOGIES|ENTERPRISES|HOLDINGS|INDUSTRIES|ASSOCIATES|PARTNERS|GROUP)\b/i;
  const WEAK   = /\b(SERVICES?|SYSTEMS|SOLUTIONS|EQUIPMENT|MANUFACTURING|SUPPLY|PRODUCTS)\b/i;
  const STOP   = /^(return service|remittance|important messages?|amount enclosed|business approver|keep (?:lower|upper)|please|customer|account|invoice|statement|work order|location|page \d|p\.?\s*o\.?\s*box|to pay)/i;
  let best = null, bestScore = 0;
  const slice = lines.slice(0, 30);
  for (const ln of slice) {
    if (ln.length < 4 || ln.length > 80) continue;
    if (isBuyer(ln)) continue;
    if (STOP.test(ln)) continue;
    if (((ln.match(/\d/g) || []).length) > 3) continue; // skip address-y lines
    const strong = STRONG.test(ln), weak = WEAK.test(ln);
    if (!strong && !weak) continue;
    const score = strong ? 3 : 1;
    if (score > bestScore) { best = ln; bestScore = score; }
  }
  if (best) return cleanCompanyName(best);

  // Strategy D: vendor address footer — many statements put the vendor's
  // address near the top with a phone number on the next line. The line
  // *before* the phone is often the vendor street address; the line above
  // that may be the vendor name. We use the phone number as an anchor.
  for (let i = 0; i < lines.length; i++) {
    if (/^\(?\d{3}\)?\s*\d{3}[\-\s]\d{4}/.test(lines[i]) || /^\(P\)\s*\d/.test(lines[i])) {
      // Look up to 3 lines above for a name candidate.
      for (let k = i - 3; k < i; k++) {
        if (k < 0) continue;
        const cand = lines[k];
        if (cand.length < 4 || cand.length > 80) continue;
        if (isBuyer(cand)) continue;
        if (((cand.match(/\d/g) || []).length) > 3) continue; // skip address
        if (!/[A-Za-z]/.test(cand)) continue;
        // Skip if it's mostly common stop-words like "Customer:" or "Statement"
        if (/^(customer|contact|page|statement|date|invoice|amount|balance|terms)/i.test(cand)) continue;
        return cleanCompanyName(cand);
      }
    }
  }

  return null;
}

function isBuyer(s) {
  return BUYER_PATTERNS.some(re => re.test(s));
}
function cleanCompanyName(s) {
  return s.replace(/\s+/g, ' ').replace(/[,;:]+\s*$/, '').trim();
}

module.exports = { extractVendorPdf, parseVendorText };

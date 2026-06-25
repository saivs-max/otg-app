// Extract structured invoice data from a contractor invoice PDF.
//
// Built around the John Brennan / Sbot Technologies template that the team
// already receives by email. The parser is deliberately tolerant: any field
// that doesn't match falls back to `null` and the manager can fill it in
// manually via the Edit Details sheet.
//
// Returns:
//   { ok, text, summary: { header, candidates, line_items, mileage,
//                          tolls, totals, errors } }
//
// `summary.candidates` lists ticket-id matches with line context — this is
// what powers the auto-link UI on the invoice screen.
const pdf = require('pdf-parse');

async function extractFromPdfBuffer(buf) {
  let parsed;
  try {
    parsed = await pdf(buf);
  } catch (e) {
    return { ok: false, error: `pdf-parse failed: ${e.message}` };
  }
  const text = parsed.text || '';
  const summary = parseInvoiceText(text);
  // Scanned/image-only PDFs yield little or no text. Surface this so the
  // upload route can route to OCR / manual entry instead of silently
  // returning a page of nulls. ~25 chars/page is well below any real invoice.
  const chars = text.trim().length;
  const scanned = chars < Math.max(100, (parsed.numpages || 1) * 25);
  return { ok: true, text, info: parsed.info, pages: parsed.numpages,
           text_chars: chars, scanned, summary };
}

function parseInvoiceText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const errors = [];

  const header     = parseHeader(text, lines);
  const candidates = extractCandidates(lines);
  const line_items = extractLaborLines(text, lines);
  const mileage    = extractMileage(text, lines);
  const tolls      = extractTolls(text, lines);
  const totals     = extractTotals(text, lines);

  return { header, candidates, line_items, mileage, tolls, totals, errors };
}

// ---------- Header (name, address, invoice number, dates) ----------
function parseHeader(text, lines) {
  const out = { full_name: null, address: null, phone: null, invoice_number: null,
                period: null, invoice_date: null };
  // Full Name appears on its own line followed by the actual name
  const nameIdx = lines.findIndex(l => /^Full Name$/i.test(l));
  if (nameIdx >= 0 && lines[nameIdx + 1]) out.full_name = lines[nameIdx + 1];

  // Sbot-template fallback: these invoices have no "Full Name" label — the
  // technician's name is simply the line just above the "INVOICE" heading
  // (e.g. "Benjamin Camp" / "Shaun Bailey"). Skip "Page N of" banners.
  if (!out.full_name) {
    const invIdx = lines.findIndex(l => /^INVOICE\b/i.test(l));
    if (invIdx > 0) {
      for (let k = invIdx - 1; k >= 0 && k >= invIdx - 3; k--) {
        const cand = (lines[k] || '').trim();
        if (!cand || /^page\s+\d+\s+of/i.test(cand) || /^#/.test(cand)) continue;
        if (/^[A-Za-z][A-Za-z.'-]+(?:\s+[A-Za-z.'-]+)+$/.test(cand) && cand.length <= 40)
          out.full_name = cand;
        break;
      }
    }
  }

  // Home Address line: "Home Address 24 Mayflower drive Sicklerville, NJ 080814/24/26"
  const addrLine = lines.find(l => /^Home Address /i.test(l));
  if (addrLine) {
    out.address = addrLine.replace(/^Home Address\s+/i, '').trim();
    // The trailing date is glued to the zip ("080814/24/26") — split where the
    // 5-digit zip ends and a 1-2 digit month begins. We try every plausible
    // split position and keep the one whose month parses to 1..12.
    const m = out.address.match(/^(.*?)(\d{5})(\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/);
    if (m) {
      const dateStr = m[3];
      const monthMatch = dateStr.match(/^(\d{1,2})\//);
      const month = monthMatch ? Number(monthMatch[1]) : 0;
      if (month >= 1 && month <= 12) {
        out.address      = `${m[1]}${m[2]}`.trim();
        out.invoice_date = normalizeDate(dateStr);
      }
    } else {
      // Fallback: shorter zip / no zip; just split on the date pattern.
      const m2 = out.address.match(/^(.*?)(\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/);
      if (m2) {
        out.address      = m2[1].trim();
        out.invoice_date = normalizeDate(m2[2]);
      }
    }
  }
  const phoneLine = lines.find(l => /^Phone Number /i.test(l));
  if (phoneLine) out.phone = phoneLine.replace(/^Phone Number\s+/i, '').trim();

  // Invoice number: "INVOICE #0003"
  const invNo = text.match(/INVOICE\s*#\s*([0-9A-Za-z\-]+)/i);
  if (invNo) out.invoice_number = invNo[1];

  // Mileage report header line tends to include the period:
  //   "John Brennan • Invoice #0003 • April 11 – April 24, 2026 • Rate: $0.725 / mile"
  const periodLine = lines.find(l => /Invoice\s*#?\d+/.test(l) && /[–-]/.test(l) && /\d{4}/.test(l));
  if (periodLine) {
    const pm = periodLine.match(/(\w+\s+\d{1,2})\s*[–-]\s*(\w+\s+\d{1,2}),?\s*(\d{4})/);
    if (pm) {
      out.period = {
        start_raw: `${pm[1]}, ${pm[3]}`,
        end_raw:   `${pm[2]}, ${pm[3]}`,
        start:     normalizeDate(`${pm[1]}, ${pm[3]}`),
        end:       normalizeDate(`${pm[2]}, ${pm[3]}`),
      };
    }
  }
  return out;
}

// ---------- Ticket id candidates (consumed by the UI's Pull&Link buttons) ----------
// Skip lines that obviously contain non-ticket numbers (addresses, phone
// numbers, ZIPs, store-internal IDs). Strong-context patterns (after a dash
// or a "Ticket #" / "WO" / "FD" / "MX" keyword) are accepted; bare numbers
// only count if they're 5-8 digits AND the line doesn't look like an address.
function extractCandidates(lines) {
  const out = [];
  const seen = new Set();
  const SKIP_LINE = /^(Phone Number|Home Address|Location|Retailer|Email|Mobile|Attn:)/i;
  const ADDRESS_HINT = /\b(St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Pkwy|Parkway|Blvd|Boulevard|Pike|Way|Ln|Lane|Ct|Court|Place|Pl)\b/i;
  const STATE_ZIP = /\b[A-Z]{2}\s+\d{5}\b/;
  // Internal IDs we want to ignore: "WF ID: 340052", "Store 519"
  const INTERNAL_ID = /\b(WF ID|Store|Cart#?|Cart\s*#?\s*\d+|cf_\w+):/i;

  for (const line of lines) {
    if (!line) continue;
    if (SKIP_LINE.test(line)) continue;
    if (INTERNAL_ID.test(line)) continue;

    let m = line.match(/-\s*(\d{3,8})\s*$/);
    let strong = !!m;
    if (!m) {
      m = line.match(/\b(?:ticket|wo|fd|mx|#)\s*#?\s*(\d{3,8})\b/i);
      strong = !!m;
    }
    if (!m && !STATE_ZIP.test(line) && !ADDRESS_HINT.test(line)) {
      m = line.match(/(?:^|\s)(\d{5,8})(?:\s|$)/);
    }
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      const id = m[1];
      const hint = id.length >= 7 || id.length <= 3 ? 'maintainx' : 'freshdesk';
      out.push({ candidate_id: id, source_hint: hint, line: line.slice(0, 200), strong });
    }
  }
  return out;
}

// ---------- Labor line items ----------
// In the Brennan PDF, each work day is a block:
//   "13-Apr"
//   " [4/13] [Weight Calibration Check] WF 16 ShopRite of Bridge & Harbison - All Carts - 12816"
//   "Inspect all carts. ..."
//   "Retailer:ShopRite of Bridge & Harbison"
//   "Location: 5597 Tulip St, Philadelphia, PA 19124"
//   "Completed weight calibration check ..."
//   "9:30 AM11:30 AM2.00$40.00$80.00"
function extractLaborLines(text, lines) {
  const out = [];
  // Day-header regex (e.g. "13-Apr", "24-Apr")
  const dayRe = /^(\d{1,2})-([A-Za-z]{3})$/;
  // Time-summary regex, time + time + hours + rate + amount glued together
  //   "9:30 AM11:30 AM2.00$40.00$80.00"
  const timeRe = /^(\d{1,2}:\d{2}\s*[AP]M)(\d{1,2}:\d{2}\s*[AP]M)([\d.]+)\$([\d,.]+)\$([\d,.]+)$/i;
  // "0.00$40.00$0.00" — empty day rows
  const emptyRe = /^([\d.]+)\$([\d,.]+)\$([\d,.]+)$/;

  let currentDate = null;
  let buf = [];
  function flush() {
    if (!currentDate) { buf = []; return; }
    if (!buf.length) return;
    const last = buf[buf.length - 1];
    let timeMatch = last.match(timeRe);
    let emptyMatch = last.match(emptyRe);
    const isTime  = !!timeMatch;
    const isEmpty = !timeMatch && !!emptyMatch;
    if (!isTime && !isEmpty) return;

    const ticket = findTicketInBuffer(buf);
    const desc   = buf.filter(l => !timeRe.test(l) && !emptyRe.test(l)).join(' | ');
    if (isTime) {
      out.push({
        date:       currentDate,
        ticket_id:  ticket,
        description: desc.slice(0, 400),
        start:      timeMatch[1].toUpperCase(),
        end:        timeMatch[2].toUpperCase(),
        hours:      Number(timeMatch[3]),
        rate:       Number(timeMatch[4].replace(/,/g, '')),
        amount:     Number(timeMatch[5].replace(/,/g, '')),
      });
    } else if (isEmpty) {
      // Skip zero-hour days — they're noise from the spreadsheet template.
      const hrs = Number(emptyMatch[1]);
      if (hrs > 0) out.push({ date: currentDate, ticket_id: ticket, description: desc.slice(0, 400),
                              hours: hrs, rate: Number(emptyMatch[2].replace(/,/g,'')),
                              amount: Number(emptyMatch[3].replace(/,/g,'')) });
    }
    buf = [];
  }

  for (const raw of lines) {
    const line = raw.trim();
    const dm = line.match(dayRe);
    if (dm) {
      flush();
      currentDate = normalizeDate(`${dm[1]}-${dm[2]}`);
      buf = [];
      continue;
    }
    if (currentDate) buf.push(line);
  }
  flush();
  return out;
}

function findTicketInBuffer(buf) {
  for (const l of buf) {
    let m = l.match(/-\s*(\d{3,8})\s*$/);
    if (!m) m = l.match(/\b(?:ticket|wo|fd|mx|#)\s*#?\s*(\d{3,8})\b/i);
    if (m) return m[1];
  }
  return null;
}

// ---------- Mileage section ----------
// Layout per day (after the "MILEAGE REIMBURSEMENT REPORT" banner):
//   "April 13, 2026Total: 93.3 mi • $67.64"
//   "■ START"
//   "24 Mayflower Drive, Sicklerville, NJ 08081——"
//   "■ Stop 1"
//   "ShopRite of Bridge & Harbison"
//   "5597 Tulip St, Philadelphia, PA 19124"
//   "27.0$19.57"
//   ...
function extractMileage(text, lines) {
  const out = [];
  const startIdx = lines.findIndex(l => /MILEAGE REIMBURSEMENT REPORT/i.test(l));
  if (startIdx < 0) return out;
  const dayHeaderRe = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})Total:\s*([\d.,]+)\s*mi\s*•\s*\$([\d.,]+)/i;
  let cur = null;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const m = line.match(dayHeaderRe);
    if (m) {
      if (cur) out.push(cur);
      cur = {
        date:        normalizeDate(`${m[1]} ${m[2]}, ${m[3]}`),
        date_raw:    `${m[1]} ${m[2]}, ${m[3]}`,
        total_miles: Number(m[4].replace(/,/g,'')),
        total_amount: Number(m[5].replace(/,/g,'')),
        stops: [],
      };
      continue;
    }
    if (!cur) continue;
    if (/TOTAL MILEAGE/i.test(line)) { out.push(cur); cur = null; break; }
    // Per-leg amount line: "27.0$19.57"
    const legM = line.match(/^([\d.,]+)\$([\d.,]+)$/);
    if (legM) {
      cur.stops.push({
        miles:  Number(legM[1].replace(/,/g,'')),
        amount: Number(legM[2].replace(/,/g,'')),
      });
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------- Toll/E-ZPass section (Smart Receipts) ----------
// Layout: "03/04/2026E-ZPass50.00USDParking/TollsNo"
function extractTolls(text, lines) {
  const out = [];
  const tollRe = /^(\d{2}\/\d{2}\/\d{4})([A-Za-z\- ]+?)([\d.,]+)([A-Z]{3})([A-Za-z/]+?)(Yes|No)$/;
  for (const line of lines) {
    const m = line.match(tollRe);
    if (m) {
      out.push({
        date:     normalizeDate(m[1]),
        vendor:   m[2].trim(),
        amount:   Number(m[3].replace(/,/g,'')),
        currency: m[4],
        category: m[5].trim(),
        reimbursable: m[6] === 'Yes',
      });
    }
  }
  return out;
}

// ---------- Header totals (SUBTOTAL / Mileage / Other / TOTAL) ----------
function extractTotals(text, lines) {
  const out = { subtotal: null, total_hours: null, miles_driven: null, mileage_amount: null,
                other: null, total: null };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^SUBTOTAL$/i.test(line)) out.subtotal = moneyAfter(lines, i);
    if (/^Mileage$/i.test(line))  out.mileage_amount = moneyAfter(lines, i);
    if (/^Other$/i.test(line))    out.other = moneyAfter(lines, i);
    if (/^TOTAL$/i.test(line))    out.total = moneyAfter(lines, i);
    // "Miles Driven" line is typically followed by "1087$0.73"
    if (/^Miles Driven$/i.test(line)) {
      const m = (lines[i + 1] || '').match(/^([\d.,]+)\$([\d.,]+)$/);
      if (m) {
        out.miles_driven = Number(m[1].replace(/,/g,''));
      }
    }
    if (/^Total Hours$/i.test(line)) {
      // value can be on i+1 or up to ~25 lines later (the Brennan template
      // places the actual hours number after the contact / mileage block).
      for (let j = i + 1; j < Math.min(i + 25, lines.length); j++) {
        const v = (lines[j] || '').match(/^([\d]+\.\d+)$/);
        if (v) { out.total_hours = Number(v[1]); break; }
      }
    }
  }
  return out;
}

function parseDollar(s) {
  if (!s) return null;
  const m = String(s).match(/\$?([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g,'')) : null;
}

// Find a *real* currency value in the few lines after a label (e.g. "TOTAL").
// pdf-parse frequently places a phone number or street address on the line
// immediately after the label, which the old `parseDollar(lines[i+1])` happily
// turned into a bogus total (e.g. "267-524-6090" -> 267, "950 Seven Hills Dr"
// -> 950, "1/2/2026" -> 1). We only accept a $-prefixed amount or a standalone
// number that carries cents; bare integers, phones and dates are rejected.
// Returns null when no trustworthy value is found (better than a wrong one).
function moneyAfter(lines, idx) {
  for (let j = idx + 1; j < Math.min(idx + 5, lines.length); j++) {
    const l = (lines[j] || '').trim();
    if (!l) continue;
    if (/(?:^|\D)\d{3}[-.\s]\d{3}[-.\s]\d{4}(?:\D|$)/.test(l)) return null; // phone -> scrambled layout, bail
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(l)) continue;                   // date -> skip
    let m = l.match(/\$\s?([\d,]+(?:\.\d{2})?)/);                           // $-prefixed amount
    if (!m) m = l.match(/^\$?([\d,]+\.\d{2})(?:\s|$)/);                     // standalone amount w/ cents
    if (m) return Number(m[1].replace(/,/g, ''));
    // A bare integer with no '$' and no cents is almost never the total here
    // (street number / page number / qty) — keep scanning the next line.
  }
  return null;
}

// ---------- date normalization ----------
const MONTH_MAP = {
  jan:1, january:1, feb:2, february:2, mar:3, march:3, apr:4, april:4, may:5,
  jun:6, june:6, jul:7, july:7, aug:8, august:8, sep:9, sept:9, september:9,
  oct:10, october:10, nov:11, november:11, dec:12, december:12,
};
function normalizeDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  // 4/24/26 or 04/24/2026
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let yyyy = Number(m[3]);
    if (yyyy < 100) yyyy = 2000 + yyyy;
    return iso(yyyy, Number(m[1]), Number(m[2]));
  }
  // 13-Apr (no year — guess current year, will be reconciled by upload's week_of)
  m = t.match(/^(\d{1,2})-([A-Za-z]{3,9})$/);
  if (m) {
    const month = MONTH_MAP[m[2].toLowerCase()];
    if (!month) return null;
    return iso(new Date().getFullYear(), month, Number(m[1]));
  }
  // April 11, 2026
  m = t.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const month = MONTH_MAP[m[1].toLowerCase()];
    if (!month) return null;
    return iso(Number(m[3]), month, Number(m[2]));
  }
  return null;
}
function iso(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

module.exports = { extractFromPdfBuffer, parseInvoiceText, normalizeDate };

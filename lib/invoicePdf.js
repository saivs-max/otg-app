// Generate a PDF version of an invoice that AP can file.
//
// v0.98 — This PDF is a faithful, print-ready mirror of the on-screen
// contractor-invoice preview the tech sees (public/app.js →
// renderInvoiceDetail). Same structure and branding: green INVOICE pill,
// "Invoice To" / "FOR" cards, dark table header, one row PER DAY of the week
// (empty days greyed), drive rows highlighted, "Total Work Hours" + SUBTOTAL,
// a separate billable-drive subtotal, mileage/other lines, a dark TOTAL bar,
// an inline contact footer, the mileage reimbursement report, and an itemized
// expense-receipts table. Times/dates render in the tech's captured timezone
// (`tz`) so they match the preview exactly.
//
// Returns a Buffer.
const PDFDocument = require('pdfkit');

// Palette lifted from the app's redesign.css so the PDF and the UI match.
const PAL = {
  ink:      '#13231D',
  muted:    '#5B6B64',
  green:    '#04372A',
  orange:   '#B4530A',
  cream:    '#FBF8F3',
  line:     '#E4E0D8',
  surface2: '#F4F1EA',
  okBg:     '#E6F4EC',
  green2:   '#0E7A56',
  dark:     '#1A1A1A',
  headTxt:  '#D9DCD8', // light gray for the dark table header
  gold:     '#7A5C00', // amt-pos / amt-total text
  subtotBg: '#F0F0F0',
  amtTotBg: '#F6F6F4',
  driveBg:  '#FFF8F0',
  white:    '#FFFFFF',
};

async function generateInvoicePdf(invoiceData) {
  const { invoice, tech, lines, by_date, summary, approvals, tz } = invoiceData;
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 48, info: {
        Title: `Invoice ${String(invoice.id).padStart(5, '0')}`,
        Author: tech?.name || 'Bread Field Cost',
        Subject: 'Hardware Operations Field Invoice',
        Producer: 'Bread Field Cost Management',
      }});
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      drawInvoice(doc, { invoice, tech, lines, by_date, summary, tz });
      doc.end();
    } catch (e) { reject(e); }
  });
}

function drawInvoice(doc, { invoice, tech, by_date, summary, tz }) {
  const left  = doc.page.margins.left;                       // 48
  const right = doc.page.width - doc.page.margins.right;      // 564
  const rate  = invoice.hourly_rate || 40;
  const money = n => '$' + (Number(n) || 0).toFixed(2);
  const pageBottom = () => doc.page.height - 54;

  // Timezone-aware date/time helpers (mirror the client's parseDisplayDate).
  const pd = s => {
    if (!s) return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00') : new Date(s);
  };
  const TZ = tz || undefined; // undefined → host default (back-compat)
  const timeOpts = { hour: 'numeric', minute: '2-digit' };
  if (TZ) timeOpts.timeZone = TZ;
  const fmtTimeTZ = s => { const d = pd(s); return d ? d.toLocaleTimeString('en-US', timeOpts) : ''; };
  const fmtDateMD = s => { const d = pd(s); return d ? d.toLocaleDateString('en-US', tzo({ month: 'short', day: 'numeric' })) : ''; };
  const fmtDayCell = s => { const d = pd(s); return d ? `${d.toLocaleDateString('en-US', tzo({ day: 'numeric' }))}-${d.toLocaleDateString('en-US', tzo({ month: 'short' }))}` : ''; };
  const fmtMD = s => { const d = pd(s); return d ? `${d.toLocaleDateString('en-US', tzo({ month: 'numeric' }))}/${d.toLocaleDateString('en-US', tzo({ day: 'numeric' }))}` : ''; };
  const fmtLong = s => { const d = pd(s); return d ? d.toLocaleDateString('en-US', tzo({ month: 'long', day: 'numeric', year: 'numeric' })) : ''; };
  function tzo(o) { return TZ ? { ...o, timeZone: TZ } : o; }

  // WO display label (server-side twin of app.js → woLabel).
  const woRef = (t) => {
    const ext = t.external_id || '';
    const num = t.wo_number || null;
    const src = t.source_system || (ext.startsWith('MX-') ? 'maintainx' : ext.startsWith('FD-') ? 'freshdesk' : null);
    const prefix = src === 'maintainx' ? 'MaintainX' : src === 'freshdesk' ? 'Freshdesk' : null;
    if (num) return (prefix || 'WO') + ' #' + num;
    if (prefix && ext) { const m = ext.match(/^(MX|FD)-(DPL|RTR|SVC|MNT|RPR)-(.+)$/i); return prefix + ' #' + (m ? m[3] : ext); }
    return ext || ('WO #' + (t.work_order_id || ''));
  };
  const workTypeLabel = t => ({ deployment: 'Deployment', retrofit: 'Retrofit', maintenance: 'Maintenance', repair: 'Repair' }[t] || (t || 'Labor'));

  // ---------- Column geometry ----------
  const pad = 5;
  const colDef = (x, w, align) => ({ x, w, align,
    tx: align === 'right' ? x : x + pad,
    tw: align === 'right' ? w - pad : w - pad * 2 });
  const C = {
    date:   colDef(left,        44,  'left'),
    detail: colDef(left + 44,   206, 'left'),
    start:  colDef(left + 250,  50,  'right'),
    end:    colDef(left + 300,  50,  'right'),
    hours:  colDef(left + 350,  42,  'right'),
    rate:   colDef(left + 392,  50,  'right'),
    amount: colDef(left + 442,  74,  'right'),
  };
  const gridXs = [C.detail.x, C.start.x, C.end.x, C.hours.x, C.rate.x, C.amount.x, right];

  // ================= HEADER (identity + INVOICE pill) =================
  let y = 44;
  const idValX = left + 100, idValW = 210;
  const idRow = (label, value) => {
    const vh = doc.font('Helvetica').fontSize(10.5).heightOfString(value || '—', { width: idValW });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(PAL.muted).text(label, left, y + 1, { width: 96 });
    doc.font('Helvetica').fontSize(10.5).fillColor(PAL.ink).text(value || '—', idValX, y, { width: idValW });
    y += Math.max(15, vh) + 5;
  };
  const idTop = y;
  idRow('Full Name',    tech?.name);
  idRow('Home Address', tech?.home_address || '—');
  idRow('Phone Number', tech?.home_phone || '—');
  const idBottom = y;

  // INVOICE pill (green), top-right, with the period-end date beneath it.
  const invNum = 'INVOICE #' + String(invoice.id).padStart(5, '0');
  doc.font('Helvetica-Bold').fontSize(11);
  const pillTextW = doc.widthOfString(invNum);
  const pillPadX = 12, pillH = 24, pillW = pillTextW + pillPadX * 2;
  const pillX = right - pillW, pillY = idTop - 2;
  doc.roundedRect(pillX, pillY, pillW, pillH, 12).fill(PAL.okBg);
  doc.fillColor(PAL.green).font('Helvetica-Bold').fontSize(11).text(invNum, pillX + pillPadX, pillY + 6.5);
  doc.font('Helvetica').fontSize(10).fillColor(PAL.muted)
     .text(fmtDateMD(invoice.period_end), pillX - 40, pillY + pillH + 5, { width: pillW + 40, align: 'right' });

  // ================= BILL-TO + FOR cards =================
  y = Math.max(idBottom, pillY + pillH + 22) + 6;
  const forW = 120, gap = 12, billW = right - left - forW - gap, cardH = 84, cardY = y;
  doc.roundedRect(left, cardY, billW, cardH, 8).fillAndStroke(PAL.surface2, PAL.line);
  doc.roundedRect(left + billW + gap, cardY, forW, cardH, 8).fillAndStroke(PAL.surface2, PAL.line);
  // Left card text
  let by = cardY + 13; const bx = left + 14;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(PAL.muted).text('Invoice To:', bx, by); by += 15;
  doc.font('Helvetica-Bold').fontSize(11.5).fillColor(PAL.ink).text('Instacart, Inc.', bx, by); by += 15;
  doc.font('Helvetica').fontSize(9.5).fillColor(PAL.ink);
  doc.text('Hardware Operations Caper — AP', bx, by); by += 13;
  doc.text('50 Beale St', bx, by); by += 13;
  doc.text('San Francisco, CA 94105', bx, by);
  // FOR card text
  const fx = left + billW + gap;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(PAL.muted).text('FOR', fx, cardY + 16, { width: forW, align: 'center', characterSpacing: 1.5 });
  doc.font('Helvetica').fontSize(10.5).fillColor(PAL.ink).text('Hourly Services', fx, cardY + 36, { width: forW, align: 'center' });

  y = cardY + cardH + 20;

  // ================= LINE-ITEM TABLE =================
  const tableHeader = (yy) => {
    doc.rect(left, yy, right - left, 22).fill(PAL.dark);
    doc.fillColor(PAL.headTxt).font('Helvetica-Bold').fontSize(8);
    const H = [['DATE', C.date], ['DETAILS / PURPOSE', C.detail], ['START', C.start],
              ['END', C.end], ['HOURS', C.hours], ['RATE', C.rate], ['AMOUNT', C.amount]];
    for (const [lab, c] of H) doc.text(lab, c.tx, yy + 7, { width: c.tw, align: c.align, characterSpacing: 0.3 });
    return yy + 22;
  };
  y = tableHeader(y);

  // Row grid: horizontal separator at bottom + light verticals for this band.
  const drawGrid = (yTop, yBot) => {
    doc.lineWidth(0.5).strokeColor(PAL.line);
    doc.moveTo(left, yBot).lineTo(right, yBot).stroke();
    for (const gx of gridXs) doc.moveTo(gx, yTop).lineTo(gx, yBot).stroke();
    doc.moveTo(left, yTop).lineTo(left, yBot).stroke();
  };

  // Measure a details cell (meta + retailer + notes) at the table's detail width.
  const measureDetail = (d) => {
    let h = 0;
    h += doc.font('Helvetica-Bold').fontSize(8.5).heightOfString(d.meta, { width: C.detail.tw });
    if (d.retailer) h += doc.font('Helvetica-Bold').fontSize(8).heightOfString('Retailer: ' + d.retailer, { width: C.detail.tw });
    if (d.notes)    h += doc.font('Helvetica-Oblique').fontSize(8).heightOfString(d.notes, { width: C.detail.tw });
    return h;
  };
  const drawDetail = (x, yy, d) => {
    let dy = yy;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(d.metaColor || PAL.ink).text(d.meta, x, dy, { width: C.detail.tw });
    dy += doc.heightOfString(d.meta, { width: C.detail.tw });
    if (d.retailer) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(PAL.ink).text('Retailer: ' + d.retailer, x, dy, { width: C.detail.tw });
      dy += doc.heightOfString('Retailer: ' + d.retailer, { width: C.detail.tw });
    }
    if (d.notes) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#444444').text(d.notes, x, dy, { width: C.detail.tw });
    }
  };

  // A single entry row.
  const entryRow = ({ dateCell, detail, start, end, hours, isDrive, amount }) => {
    const detailH = measureDetail(detail);
    const rowH = Math.max(detailH + 8, 20);
    if (y + rowH > pageBottom()) { doc.addPage(); y = tableHeader(48); }
    if (isDrive) doc.rect(left, y, right - left, rowH).fill(PAL.driveBg);
    const ty = y + 4;
    doc.font('Helvetica').fontSize(8.5).fillColor(PAL.ink).text(dateCell, C.date.tx, ty, { width: C.date.tw });
    drawDetail(C.detail.tx, ty, detail);
    doc.font('Helvetica').fontSize(8.5).fillColor(PAL.muted);
    doc.text(start || '—', C.start.tx, ty, { width: C.start.tw, align: 'right' });
    doc.text(end   || '—', C.end.tx,   ty, { width: C.end.tw,   align: 'right' });
    doc.fillColor(PAL.ink).font('Helvetica-Bold').text((hours || 0).toFixed(2), C.hours.tx, ty, { width: C.hours.tw, align: 'right' });
    doc.font('Helvetica').fillColor(PAL.ink).text(money(rate), C.rate.tx, ty, { width: C.rate.tw, align: 'right' });
    doc.font('Helvetica-Bold').fillColor(PAL.gold).text(money(amount), C.amount.tx, ty, { width: C.amount.tw, align: 'right' });
    drawGrid(y, y + rowH);
    y += rowH;
  };

  const emptyRow = (date) => {
    const rowH = 18;
    if (y + rowH > pageBottom()) { doc.addPage(); y = tableHeader(48); }
    const ty = y + 4;
    doc.font('Helvetica').fontSize(8.5).fillColor('#999999').text(fmtDayCell(date), C.date.tx, ty, { width: C.date.tw });
    doc.text('0.00', C.hours.tx, ty, { width: C.hours.tw, align: 'right' });
    doc.text(money(rate), C.rate.tx, ty, { width: C.rate.tw, align: 'right' });
    doc.text('$0.00', C.amount.tx, ty, { width: C.amount.tw, align: 'right' });
    drawGrid(y, y + rowH);
    y += rowH;
  };

  // Build day map and iterate every calendar day of the invoice week.
  const dayMap = {};
  for (const d of (by_date || [])) dayMap[d.date] = d;
  const allDays = enumerateWeekDays(invoice.period_start, invoice.period_end);

  for (const date of allDays) {
    const day = dayMap[date];
    // Mirror the preview's inclusion rule exactly (app.js renderInvoiceDetail):
    // empty row when the day has no time entries AND no expense entries.
    if (!day || (!day.time_entries.length && !day.expense_entries.length)) {
      emptyRow(date);
      continue;
    }
    // Labor/drive logged via the expense tab (category labor|drive) render as
    // rows too, so the table reconciles with summary.labor/drive hours.
    const laborExpRows = (day.expense_entries || [])
      .filter(e => e.category === 'labor' || e.category === 'drive')
      .map(e => ({
        _fromExpense: true, external_id: e.external_id, store_name: e.store_name,
        work_type: e.work_type, wo_number: e.wo_number, source_system: e.source_system,
        clock_in: e.expense_date, clock_out: null, hours: Number(e.quantity || 0),
        notes: e.description || '', mode: e.category === 'drive' ? 'drive' : 'work',
      }));
    const entries = [...(day.time_entries || []), ...(day.drive_entries || []), ...laborExpRows]
      .sort((a, b) => new Date(a.clock_in || 0) - new Date(b.clock_in || 0));

    for (const t of entries) {
      const isDrive = t.mode === 'drive';
      const start = t._fromExpense ? '' : fmtTimeTZ(t.clock_in);
      const end   = t._fromExpense ? '' : fmtTimeTZ(t.clock_out);
      const tag = t._fromExpense
        ? (isDrive ? '[Drive · logged]' : `[${workTypeLabel(t.work_type || 'labor')} · logged]`)
        : (isDrive ? '[Drive]' : `[${workTypeLabel(t.work_type)}]`);
      const meta = `[${fmtMD(t.clock_in || date)}] ${tag} ${woRef(t)}`;
      entryRow({
        dateCell: fmtDayCell(date),
        detail: { meta, retailer: t.store_name, notes: t.notes, metaColor: isDrive ? PAL.orange : PAL.ink },
        start, end, hours: t.hours, isDrive,
        amount: +((t.hours || 0) * rate).toFixed(2),
      });
    }
  }

  // ================= TOTALS =================
  const totalLabor   = summary.labor_amount || 0;
  const totalDrive   = +(summary.drive_amount || 0).toFixed(2);
  const totalMiles   = (by_date || []).reduce((s, d) =>
    s + (d.expense_entries || []).filter(e => e.category === 'mileage').reduce((a, e) => a + (e.quantity || 0), 0), 0);
  const mileageRate  = 0.725;
  const totalMileage = totalMiles * mileageRate;
  const totalOther   = +((summary.total || 0) - totalLabor - totalDrive - totalMileage).toFixed(2);
  const grandTotal   = summary.total || 0;

  const ensureTotals = (h) => { if (y + h > pageBottom()) { doc.addPage(); y = 48; } };

  // "Total Work Hours" + SUBTOTAL (labor). 2px dark top border like the UI.
  ensureTotals(24);
  doc.lineWidth(1.4).strokeColor(PAL.dark).moveTo(left, y).lineTo(right, y).stroke();
  let ry = y + 6;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(PAL.ink).text('Total Work Hours', C.date.x + 4, ry, { width: C.hours.x - C.date.x - 8 });
  doc.fontSize(9).text((summary.labor_hours || 0).toFixed(2), C.hours.tx, ry + 2, { width: C.hours.tw, align: 'right' });
  doc.rect(C.rate.x, y, C.rate.w, 22).fill(PAL.subtotBg);
  doc.rect(C.amount.x, y, C.amount.w, 22).fill(PAL.amtTotBg);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(PAL.ink).text('SUBTOTAL', C.rate.tx, ry + 3, { width: C.rate.tw, align: 'right' });
  doc.fontSize(11).fillColor(PAL.gold).text(money(totalLabor), C.amount.tx, ry + 1, { width: C.amount.tw, align: 'right' });
  y += 24;

  // Billable drive subtotal.
  if ((summary.drive_hours || 0) > 0) {
    ensureTotals(22);
    doc.rect(left, y, right - left, 20).fill(PAL.driveBg);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(PAL.orange)
       .text('Total Drive Hours (billable · tracked separately)', C.date.x + 4, y + 6, { width: C.hours.x - C.date.x - 8, align: 'right' });
    doc.fillColor(PAL.orange).text((summary.drive_hours || 0).toFixed(2), C.hours.tx, y + 6, { width: C.hours.tw, align: 'right' });
    doc.rect(C.rate.x, y, C.rate.w, 20).fill(PAL.subtotBg);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(PAL.ink).text('SUBTOTAL', C.rate.tx, y + 6, { width: C.rate.tw, align: 'right' });
    doc.fontSize(10).fillColor(PAL.gold).text(money(totalDrive), C.amount.tx, y + 5, { width: C.amount.tw, align: 'right' });
    y += 22;
  }

  // Mileage line.
  if (totalMiles > 0) {
    ensureTotals(20);
    const ly = y + 5;
    doc.font('Helvetica').fontSize(8.5).fillColor(PAL.ink).text('Miles Driven', C.date.tx, ly, { width: C.detail.w });
    doc.font('Helvetica-Bold').text(totalMiles.toFixed(0), C.hours.tx, ly, { width: C.hours.tw, align: 'right' });
    doc.rect(C.rate.x, y, C.rate.w, 18).fill(PAL.subtotBg);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(PAL.ink).text('Mileage', C.rate.tx, ly, { width: C.rate.tw, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(PAL.gold).text(money(totalMileage), C.amount.tx, ly, { width: C.amount.tw, align: 'right' });
    y += 20;
  }

  // Other expenses line.
  if (totalOther > 0.005) {
    ensureTotals(20);
    const ly = y + 5;
    doc.rect(C.rate.x, y, C.rate.w, 18).fill(PAL.subtotBg);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(PAL.ink).text('Other', C.rate.tx, ly, { width: C.rate.tw, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(PAL.gold).text(money(totalOther), C.amount.tx, ly, { width: C.amount.tw, align: 'right' });
    y += 20;
  }

  // Grand TOTAL (dark bar).
  ensureTotals(28);
  doc.rect(left, y, right - left, 26).fill(PAL.dark);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(PAL.white).text('TOTAL', C.rate.x - 60, y + 8, { width: C.rate.w + 60, align: 'right' });
  doc.fontSize(13).fillColor(PAL.white).text(money(grandTotal), C.amount.tx, y + 7, { width: C.amount.tw, align: 'right' });
  y += 26;

  // ================= FOOTER (contact) =================
  y += 12;
  doc.dash(2, { space: 2 }).lineWidth(0.7).strokeColor(PAL.line).moveTo(left, y).lineTo(right, y).stroke().undash();
  y += 10;
  // Center "Payable in USD to <name>" with the name bold — measure both pieces
  // and start at the centered offset (continued+align:center misplaces fragments).
  const p1 = 'Payable in USD to ', p2 = tech?.name || '';
  const w1 = doc.font('Helvetica').fontSize(10).widthOfString(p1);
  const w2 = doc.font('Helvetica-Bold').fontSize(10).widthOfString(p2);
  const startX = left + (right - left - (w1 + w2)) / 2;
  doc.font('Helvetica').fontSize(10).fillColor(PAL.ink).text(p1, startX, y, { lineBreak: false, continued: true })
     .font('Helvetica-Bold').text(p2, { lineBreak: false });
  y += 16;
  doc.font('Helvetica').fontSize(8.5).fillColor(PAL.muted)
     .text('If you have any questions concerning this invoice, use the following contact information:', left, y, { width: right - left, align: 'center' });
  y += 12;
  const contactEmail = tech?.invoice_email || tech?.email || '';
  const contact = `Email: ${contactEmail}${tech?.home_phone ? `   ·   Mobile: ${tech.home_phone}` : ''}`;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(PAL.ink).text(contact, left, y, { width: right - left, align: 'center' });
  y += 20;

  // ================= MILEAGE REIMBURSEMENT REPORT =================
  drawMileageReport(doc, { invoice, tech, by_date, y, left, right, money, fmtLong, mileageRate }, (ny) => { y = ny; });

  // ================= EXPENSE RECEIPTS =================
  drawExpenseReceipts(doc, { invoice, by_date, y, left, right, C, money, fmtDateMD, tableHeaderColor: PAL, pageBottom }, (ny) => { y = ny; });
}

// ---- Mileage reimbursement report (mirrors the preview's blue-banded report) ----
function drawMileageReport(doc, ctx, setY) {
  const { invoice, tech, by_date, left, right, money, fmtLong, mileageRate } = ctx;
  let y = ctx.y;
  const pageBottom = doc.page.height - 54;

  const fmtGps = (lat, lng) =>
    (lat != null && lng != null && isFinite(Number(lat)) && isFinite(Number(lng)))
      ? `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}` : '';
  const trimOr = v => (v != null && String(v).trim()) ? String(v).trim() : '';
  const mileageDays = (by_date || []).map(d => ({
    date: d.date,
    stops: (d.expense_entries || []).filter(e => e.category === 'mileage').map(e => {
      const g = e.gps || {};
      return {
        location: trimOr(e.stop_location) || fmtGps(g.lat_out, g.lng_out) || trimOr(e.store_address) || trimOr(e.store_name) || trimOr(e.external_id),
        start:    trimOr(e.start_location) || fmtGps(g.lat_in, g.lng_in),
        miles:  e.quantity || 0, amount: e.amount || 0, rate: e.rate || 0.725,
        desc:   e.description || '',
      };
    }),
  })).filter(d => d.stops.length > 0);
  if (!mileageDays.length) { setY(y); return; }

  const NAVY = '#1F3B6E';
  const totalMiles = mileageDays.reduce((s, d) => s + d.stops.reduce((ss, x) => ss + x.miles, 0), 0);
  const totalAmt   = mileageDays.reduce((s, d) => s + d.stops.reduce((ss, x) => ss + x.amount, 0), 0);
  const homeBase   = tech?.home_address || '';

  if (y + 90 > pageBottom) { doc.addPage(); y = 48; }
  y += 8;
  // Banner
  doc.rect(left, y, right - left, 30).fill(NAVY);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(13).text('MILEAGE REIMBURSEMENT REPORT', left, y + 6, { width: right - left, align: 'center', characterSpacing: 1 });
  doc.font('Helvetica').fontSize(8).fillColor('#D7DEEC')
     .text(`${tech?.name || ''} · ${fmtLong(invoice.period_start)} – ${fmtLong(invoice.period_end)} · Rate: $${mileageRate.toFixed(3)} / mile`,
           left, y + 21, { width: right - left, align: 'center' });
  y += 38;

  const mLeft = left + 8, mRight = right - 8;
  for (const day of mileageDays) {
    const dayMi  = day.stops.reduce((s, x) => s + x.miles, 0);
    const dayAmt = day.stops.reduce((s, x) => s + x.amount, 0);
    const blockH = 16 + (homeBase ? 13 : 0) + day.stops.length * 13 + (homeBase ? 13 : 0) + 8;
    if (y + blockH > pageBottom) { doc.addPage(); y = 48; }
    // Day header band
    doc.rect(left, y, right - left, 16).fill(ctxAlt());
    doc.fillColor('#13231D').font('Helvetica-Bold').fontSize(9).text(fmtLong(day.date), mLeft, y + 4);
    doc.font('Helvetica').fontSize(8.5).fillColor('#5B6B64').text(`Total: ${dayMi.toFixed(1)} mi · ${money(dayAmt)}`, left, y + 4, { width: mRight - left, align: 'right' });
    y += 18;
    // START
    const dayStart = (day.stops.find(s => s.start) || {}).start || homeBase;
    if (dayStart) { y = mileageLine(doc, '» START', dayStart, '—', mLeft, mRight, y, '#5B6B64'); }
    // Stops
    for (let i = 0; i < day.stops.length; i++) {
      const st = day.stops[i];
      y = mileageLine(doc, `» Stop ${i + 1}`, st.location || '—', `${st.miles.toFixed(1)} mi · ${money(st.amount)}`, mLeft, mRight, y, '#13231D');
    }
    // END
    if (homeBase) { y = mileageLine(doc, '» END', homeBase, '—', mLeft, mRight, y, '#5B6B64'); }
    doc.lineWidth(0.5).strokeColor('#EEEEEE').moveTo(mLeft, y + 1).lineTo(mRight, y + 1).stroke();
    y += 5;
  }
  if (y + 26 > pageBottom) { doc.addPage(); y = 48; }
  doc.rect(left, y, right - left, 22).fill('#FBF3EA');
  doc.fillColor('#B4530A').font('Helvetica-Bold').fontSize(10).text('TOTAL MILEAGE & REIMBURSEMENT', left + 8, y + 6);
  doc.text(`${totalMiles.toFixed(1)} miles × $${mileageRate.toFixed(3)} = ${money(totalAmt)}`, left, y + 6, { width: right - left - 8, align: 'right' });
  y += 30;
  setY(y);

  function ctxAlt() { return '#F4F1EA'; }
}

function mileageLine(doc, icon, text, right_val, mLeft, mRight, y, textColor) {
  doc.font('Helvetica').fontSize(8.5).fillColor(textColor).text(icon, mLeft + 4, y, { width: 60 });
  doc.fillColor(textColor).text(text, mLeft + 70, y, { width: mRight - mLeft - 70 - 90 });
  doc.fillColor('#5B6B64').text(right_val, mLeft, y, { width: mRight - mLeft, align: 'right' });
  return y + 13;
}

// ---- Itemized expense receipts (mirrors the preview's receipts table) ----
function drawExpenseReceipts(doc, ctx, setY) {
  const { invoice, by_date, left, right, money, fmtDateMD } = ctx;
  let y = ctx.y;
  const pageBottom = doc.page.height - 54;
  if (invoice.invoice_type === 'vendor') { setY(y); return; }

  const rows = (by_date || []).flatMap(d =>
    (d.expense_entries || [])
      .filter(e => e.category !== 'mileage' && e.category !== 'labor' && e.category !== 'drive')
      .map(e => ({ ...e, date: d.date })));
  if (!rows.length) { setY(y); return; }

  const cap = s => { s = (s == null) ? '' : String(s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; };
  // Columns: Date | Category | Description | Receipt | Amount
  const ec = {
    date:  { x: left,        w: 60 },
    cat:   { x: left + 60,   w: 110 },
    desc:  { x: left + 170,  w: 210 },
    rcpt:  { x: left + 380,  w: 60 },
    amt:   { x: left + 440,  w: right - (left + 440) },
  };

  if (y + 60 > pageBottom) { doc.addPage(); y = 48; }
  y += 6;
  // Section title bar
  doc.rect(left, y, right - left, 22).fill('#F4F5F7');
  doc.fillColor('#13231D').font('Helvetica-Bold').fontSize(11).text(`Expense receipts (${rows.length})`, left + 10, y + 6);
  y += 22;
  // Header
  doc.rect(left, y, right - left, 18).fill('#1A1A1A');
  doc.fillColor('#D9DCD8').font('Helvetica-Bold').fontSize(8);
  doc.text('DATE', ec.date.x + 5, y + 5, { width: ec.date.w - 8 });
  doc.text('CATEGORY', ec.cat.x + 5, y + 5, { width: ec.cat.w - 8 });
  doc.text('DESCRIPTION', ec.desc.x + 5, y + 5, { width: ec.desc.w - 8 });
  doc.text('RECEIPT', ec.rcpt.x + 5, y + 5, { width: ec.rcpt.w - 8 });
  doc.text('AMOUNT', ec.amt.x, y + 5, { width: ec.amt.w - 5, align: 'right' });
  y += 18;

  for (const e of rows) {
    const catTxt = cap(e.category || '') + (e.subcategory ? ` · ${e.subcategory}` : '');
    const descTxt = e.description || '—';
    const descH = doc.font('Helvetica').fontSize(8.5).heightOfString(descTxt, { width: ec.desc.w - 10 });
    const rowH = Math.max(descH + 8, 20);
    if (y + rowH > pageBottom) { doc.addPage(); y = 48; }
    const ty = y + 4;
    doc.font('Helvetica').fontSize(8.5).fillColor('#13231D').text(fmtDateMD(e.date), ec.date.x + 5, ty, { width: ec.date.w - 8 });
    doc.text(catTxt, ec.cat.x + 5, ty, { width: ec.cat.w - 8 });
    doc.text(descTxt, ec.desc.x + 5, ty, { width: ec.desc.w - 10 });
    const hasRcpt = Array.isArray(e.attachments) && e.attachments.length > 0;
    doc.fillColor(hasRcpt ? '#0E7A56' : '#999999').text(hasRcpt ? 'Attached' : '—', ec.rcpt.x + 5, ty, { width: ec.rcpt.w - 8 });
    doc.font('Helvetica-Bold').fillColor('#13231D').text(money(e.amount || 0), ec.amt.x, ty, { width: ec.amt.w - 5, align: 'right' });
    doc.lineWidth(0.5).strokeColor('#E4E0D8').moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
    y += rowH;
  }
  setY(y);
}

// ---- date helpers ----
function enumerateWeekDays(start, end) {
  const out = [];
  const pd = s => /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00') : new Date(s);
  const d = pd(start), e = pd(end);
  while (d <= e) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

module.exports = { generateInvoicePdf };

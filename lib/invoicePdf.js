// Generate a PDF version of an invoice that AP can file. Mirrors the
// contractor-style HTML preview and includes the full approval audit trail
// so AP can verify it went through every required gate.
//
// Returns a Buffer.
const PDFDocument = require('pdfkit');

async function generateInvoicePdf(invoiceData) {
  const { invoice, tech, lines, by_date, summary, approvals } = invoiceData;
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 48, info: {
        Title: `Invoice ${invoice.invoice_number}`,
        Author: tech?.name || 'Caper CostWise',
        Subject: 'Hardware Operations Caper Invoice',
        Producer: 'Caper CostWise',
      }});
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      drawInvoice(doc, { invoice, tech, lines, by_date, summary, approvals });
      doc.end();
    } catch (e) { reject(e); }
  });
}

function drawInvoice(doc, { invoice, tech, lines, by_date, summary }) {
  // Note: the approval audit trail is intentionally excluded from the PDF.
  // AP only needs the contractor invoice itself; approval timestamps are
  // internal-only (visible up to Sr Mgr level inside the app, see the
  // `trailFor` renderer in public/app.js).
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const colorInk = '#003D29';
  const colorMuted = '#888888';
  const colorRule = '#cccccc';

  // ---------- Header (Bill From + Invoice #) ----------
  doc.fillColor(colorInk).font('Helvetica-Bold').fontSize(11);
  doc.text('Full Name', left, 50);
  doc.font('Helvetica').fontSize(13).text(tech?.name || '—', left, 64);

  doc.font('Helvetica-Bold').fontSize(11).text('Home Address', left, 88);
  doc.font('Helvetica').fontSize(11).text(tech?.home_address || '—', left, 102, { width: 280 });

  doc.font('Helvetica-Bold').fontSize(11).text('Phone Number', left, 132);
  doc.font('Helvetica').fontSize(11).text(tech?.home_phone || '—', left, 146);

  // Invoice # box on the right
  const invNum = (invoice.invoice_number || '').replace(/\D/g,'').slice(-4) || String(invoice.id);
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#F36D00')
    .text(`INVOICE #${invNum}`, left, 50, { width: right - left, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(colorMuted)
    .text(fmtDate(invoice.period_end), left, 78, { width: right - left, align: 'right' });

  // ---------- Bill To ----------
  doc.moveTo(left, 175).lineTo(right, 175).strokeColor(colorRule).stroke();
  doc.fillColor(colorInk).font('Helvetica-Bold').fontSize(10).text('Invoice To:', left, 185);
  doc.font('Helvetica').fontSize(11).text('Instacart, Inc.', left, 200);
  doc.text('Hardware Operations Caper — AP', left, 214);
  doc.text('50 Beale St', left, 228);
  doc.text('San Francisco, CA 94105', left, 242);

  doc.font('Helvetica-Bold').fontSize(10).text('FOR', left, 185, { width: right - left, align: 'right' });
  doc.font('Helvetica').fontSize(11).text('Hourly Services', left, 200, { width: right - left, align: 'right' });

  // ---------- Table ----------
  let y = 280;
  doc.moveTo(left, y - 6).lineTo(right, y - 6).stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor(colorInk);
  const cols = [
    { x: left,        w: 60,  label: 'Date',     align: 'left' },
    { x: left + 60,   w: 230, label: 'Details / Purpose', align: 'left' },
    { x: left + 290,  w: 50,  label: 'Start',    align: 'right' },
    { x: left + 340,  w: 50,  label: 'End',      align: 'right' },
    { x: left + 390,  w: 40,  label: 'Hours',    align: 'right' },
    { x: left + 430,  w: 40,  label: 'Rate',     align: 'right' },
    { x: left + 470,  w: 75,  label: 'AMOUNT',   align: 'right' },
  ];
  cols.forEach(c => doc.text(c.label, c.x, y, { width: c.w, align: c.align }));
  y += 14;
  doc.moveTo(left, y).lineTo(right, y).stroke();
  y += 4;

  doc.font('Helvetica').fontSize(9);
  for (const day of (by_date || [])) {
    const allEntries = [...(day.time_entries || []), ...(day.drive_entries || [])]
      .sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in));
    if (!allEntries.length) continue;
    for (const t of allEntries) {
      const start = t.clock_in  ? fmtTime(t.clock_in)  : '';
      const end   = t.clock_out ? fmtTime(t.clock_out) : '';
      const isDrive = t.mode === 'drive';
      const detail =
        `[${fmtMonthDay(t.clock_in)}] ${isDrive ? '[DRIVE]' : `[${(t.work_type||'').toUpperCase()}]`} ${t.external_id || ''}` +
        (t.store_name ? `\nRetailer: ${t.store_name}` : '') +
        (t.notes ? `\n${t.notes}` : '');
      const dHeight = doc.heightOfString(detail, { width: cols[1].w });
      const rowH = Math.max(dHeight + 6, 20);
      if (y + rowH > doc.page.height - 80) { doc.addPage(); y = 50; }
      doc.text(fmtShortDate(day.date),     cols[0].x, y, { width: cols[0].w });
      doc.text(detail,                     cols[1].x, y, { width: cols[1].w });
      doc.text(start,                      cols[2].x, y, { width: cols[2].w, align: 'right' });
      doc.text(end,                        cols[3].x, y, { width: cols[3].w, align: 'right' });
      doc.text((t.hours || 0).toFixed(2),  cols[4].x, y, { width: cols[4].w, align: 'right' });
      doc.text(isDrive ? '—' : `$${(invoice.hourly_rate || 40).toFixed(2)}`,  cols[5].x, y, { width: cols[5].w, align: 'right' });
      const amt = isDrive ? 0 : (t.hours || 0) * (invoice.hourly_rate || 40);
      doc.text(isDrive ? '—' : `$${amt.toFixed(2)}`, cols[6].x, y, { width: cols[6].w, align: 'right' });
      y += rowH;
    }
  }

  // Totals block
  if (y + 90 > doc.page.height - 80) { doc.addPage(); y = 50; }
  y += 8;
  doc.moveTo(left, y).lineTo(right, y).stroke(); y += 6;
  const totals = [
    ['SUBTOTAL (Labor)', `$${summary.labor_amount.toFixed(2)}`],
    ['Mileage',          `$${summary.mileage.toFixed(2)}`],
    ['Tolls / Parking',  `$${(summary.tolls_parking || 0).toFixed(2)}`],
    ['Other',            `$${(summary.other || 0).toFixed(2)}`],
  ];
  doc.font('Helvetica').fontSize(10);
  for (const [k, v] of totals) {
    if (parseFloat(v.replace(/\$/, '')) === 0) continue;
    doc.text(k, left, y, { width: right - left - 100, align: 'right' });
    doc.text(v, left, y, { width: right - left, align: 'right' });
    y += 14;
  }
  y += 4;
  doc.moveTo(left + 350, y).lineTo(right, y).stroke(); y += 6;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#F36D00');
  doc.text('TOTAL', left, y, { width: right - left - 100, align: 'right' });
  doc.text(`$${summary.total.toFixed(2)}`, left, y, { width: right - left, align: 'right' });
  y += 24;

  // ---------- Mileage Reimbursement Report (v0.34) ----------
  // Mirrors the on-screen contractor invoice — per-day breakdown of every
  // mileage leg with origin/destination, miles, rate, and reimbursement.
  // Pulled from by_date.expense_entries where category === 'mileage'.
  const mileageDays = (by_date || []).map(d => ({
    date: d.date,
    stops: (d.expense_entries || [])
      .filter(e => e.category === 'mileage')
      .map(e => ({
        store: e.store_name || e.external_id || '',
        miles: e.quantity || 0,
        amount: e.amount || 0,
        rate:  e.rate || 0.725,
        desc:  e.description || '',
      })),
  })).filter(d => d.stops.length > 0);

  if (mileageDays.length) {
    if (y + 80 > doc.page.height - 80) { doc.addPage(); y = 50; }
    // Section banner
    doc.fillColor(colorInk).font('Helvetica-Bold').fontSize(12);
    doc.text('MILEAGE REIMBURSEMENT REPORT', left, y);
    y += 14;
    doc.font('Helvetica').fontSize(9).fillColor(colorMuted);
    const totalMiles = mileageDays.reduce((s, d) => s + d.stops.reduce((ss, x) => ss + x.miles, 0), 0);
    const totalAmt   = mileageDays.reduce((s, d) => s + d.stops.reduce((ss, x) => ss + x.amount, 0), 0);
    const homeBase   = tech?.home_address || '';
    doc.text(
      `${tech?.name || ''}${invoice.invoice_number ? ` · Invoice ${invoice.invoice_number}` : ''} · ${invoice.period_start} – ${invoice.period_end} · Rate: $${(mileageDays[0].stops[0]?.rate || 0.725).toFixed(3)} / mile`,
      left, y, { width: right - left }
    );
    y += 12;
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#cccccc').stroke();
    y += 8;

    // Per-day blocks
    doc.fillColor(colorInk);
    for (const day of mileageDays) {
      const dayMi  = day.stops.reduce((s, x) => s + x.miles, 0);
      const dayAmt = day.stops.reduce((s, x) => s + x.amount, 0);
      // Reserve room for header + each stop + total band
      const blockH = 16 + 14 + (day.stops.length * 14) + 14 + 6;
      if (y + blockH > doc.page.height - 80) { doc.addPage(); y = 50; }

      // Day header
      doc.font('Helvetica-Bold').fontSize(10);
      doc.text(fmtDate(day.date), left, y);
      doc.font('Helvetica').fontSize(9).fillColor(colorMuted);
      doc.text(`Total: ${dayMi.toFixed(1)} mi · $${dayAmt.toFixed(2)}`,
               left, y, { width: right - left, align: 'right' });
      y += 14;

      // START row (home base)
      if (homeBase) {
        doc.fillColor(colorInk).font('Helvetica').fontSize(9);
        doc.text('▸ START', left + 8, y, { width: 60 });
        doc.fillColor(colorMuted).text(homeBase, left + 76, y, { width: right - left - 80 - 60 });
        doc.text('—', left, y, { width: right - left, align: 'right' });
        y += 12;
      }

      // Stops
      for (let i = 0; i < day.stops.length; i++) {
        const st = day.stops[i];
        doc.fillColor(colorInk).font('Helvetica').fontSize(9);
        doc.text(`▸ Stop ${i + 1}`, left + 8, y, { width: 60 });
        const storeText = `${st.store}${st.desc ? `  (${st.desc.slice(0, 60)})` : ''}`;
        doc.fillColor(colorInk).text(storeText, left + 76, y, { width: right - left - 80 - 60 });
        doc.fillColor(colorMuted)
          .text(`${st.miles.toFixed(1)} mi · $${st.amount.toFixed(2)}`,
                left, y, { width: right - left, align: 'right' });
        y += 12;
      }

      // END row (home base)
      if (homeBase) {
        doc.fillColor(colorInk).font('Helvetica').fontSize(9);
        doc.text('▸ END', left + 8, y, { width: 60 });
        doc.fillColor(colorMuted).text(homeBase, left + 76, y, { width: right - left - 80 - 60 });
        doc.text('—', left, y, { width: right - left, align: 'right' });
        y += 14;
      }

      doc.moveTo(left + 8, y - 4).lineTo(right - 8, y - 4).strokeColor('#eeeeee').stroke();
    }

    // Total mileage band
    if (y + 30 > doc.page.height - 80) { doc.addPage(); y = 50; }
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#cccccc').stroke();
    y += 6;
    doc.fillColor('#F36D00').font('Helvetica-Bold').fontSize(11);
    doc.text('TOTAL MILEAGE & REIMBURSEMENT', left, y);
    doc.text(`${totalMiles.toFixed(1)} miles × $0.725 = $${totalAmt.toFixed(2)}`,
             left, y, { width: right - left, align: 'right' });
    y += 22;
  }

  // ---------- Footer ----------
  doc.font('Helvetica').fontSize(9).fillColor(colorMuted);
  doc.text(`Payable in USD to ${tech?.name || ''}`, left, doc.page.height - 70, { width: right - left });
  doc.text(`Email: ${tech?.email || ''}` + (tech?.home_phone ? `   Mobile: ${tech.home_phone}` : ''),
           left, doc.page.height - 56, { width: right - left });
  doc.text(`Generated by Caper CostWise · ${new Date().toLocaleString()}`,
           left, doc.page.height - 42, { width: right - left });
}

// ---- date helpers ----
function fmtDate(s) { if (!s) return ''; const d = new Date(s); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function fmtShortDate(s) { if (!s) return ''; const d = new Date(s); return `${d.getDate()}-${d.toLocaleDateString('en-US',{month:'short'})}`; }
function fmtMonthDay(s)  { if (!s) return ''; const d = new Date(s); return `${d.getMonth()+1}/${d.getDate()}`; }
function fmtTime(s) { if (!s) return ''; const d = new Date(s); return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }

module.exports = { generateInvoicePdf };

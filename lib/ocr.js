// lib/ocr.js — v0.74
//
// OCR fallback for image-only / scanned vendor PDFs (no extractable text layer,
// e.g. a proposal exported as a single full-page JPEG). It shells out to the
// `poppler-utils` (pdftoppm) and `tesseract-ocr` system binaries — both added to
// the Dockerfile — so there's no native npm addon and the rest of the app stays
// pure-JS.
//
// Why TSV + row reconstruction: tesseract reads table columns as SEPARATE lines
// (all descriptions, then all quantities, then all prices), which makes per-row
// line-item parsing impossible. We instead take tesseract's word-level TSV (each
// word with an x/y box) and rebuild the visual ROWS by grouping words that share
// a vertical position, then sort each row left-to-right. The result is plain
// text whose rows match the printed table, so the existing parseVendorText()
// shapes (Shape E etc.) can read it.
//
// Safe by design: if either binary is missing (or anything throws), ocrPdf
// rejects and the caller falls back to the normal "scanned — enter manually"
// path. OCR is never required for the app to function.
const { execFile } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024, ...opts },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// Rebuild visual rows from tesseract TSV (word boxes). Words whose vertical
// centers are within ~0.6× their height are treated as the same row.
function reconstructRows(tsv) {
  const words = [];
  for (const ln of String(tsv).split(/\r?\n/)) {
    const c = ln.split('\t');
    if (c.length < 12) continue;
    const text = (c[11] || '').trim();
    const conf = Number(c[10]);
    if (!text) continue;
    if (isFinite(conf) && conf >= 0 && conf < 30) continue;   // drop low-confidence noise
    const left = +c[6], top = +c[7], w = +c[8], h = +c[9];
    if (!isFinite(left) || !isFinite(top)) continue;
    words.push({ left, top, w, h, text });
  }
  const rows = [];
  for (const wd of words) {
    const cy = wd.top + wd.h / 2;
    let row = rows.find(r => Math.abs(r.cy - cy) <= Math.max(8, wd.h * 0.6));
    if (!row) { row = { cy, words: [] }; rows.push(row); }
    row.words.push(wd);
  }
  rows.sort((a, b) => a.cy - b.cy);
  return rows
    .map(r => {
      r.words.sort((a, b) => a.left - b.left);
      return r.words.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean)
    .join('\n');
}

// Rasterize the first `maxPages` pages of a PDF buffer and OCR them, returning
// row-reconstructed plain text. Throws if poppler/tesseract aren't available.
async function ocrPdf(buf, { maxPages = 3, dpi = 200 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocr-'));
  try {
    const pdfPath = path.join(dir, 'in.pdf');
    fs.writeFileSync(pdfPath, buf);
    await run('pdftoppm', ['-png', '-r', String(dpi), '-f', '1', '-l', String(maxPages), pdfPath, path.join(dir, 'pg')]);
    const pngs = fs.readdirSync(dir).filter(f => /\.png$/i.test(f)).sort();
    let text = '';
    for (const png of pngs) {
      const tsv = await run('tesseract', [path.join(dir, png), 'stdout', 'tsv']);
      text += reconstructRows(tsv) + '\n';
    }
    return text.trim();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
  }
}

module.exports = { ocrPdf, reconstructRows };

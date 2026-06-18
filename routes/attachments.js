// Receipt / attachment endpoints. Files live under data/receipts/ and are
// owned by the linking entity (expense / time_entry / invoice / work_order).
//
// Upload format: JSON with base64-encoded body. Keeps the dep tree simple
// (no multer) and works well on mobile where receipts are small photos.
//
// POST /api/attachments
//   { invoice_id?, expense_id?, time_entry_id?, work_order_id?,
//     filename, mime_type, data_b64, caption? }
//
// GET  /api/attachments?invoice_id=X | expense_id=X | time_entry_id=X
// GET  /api/attachments/:id/download   → serves the file
// DELETE /api/attachments/:id

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { logAudit } = require('../db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const RECEIPT_DIR = path.join(DATA_DIR, 'receipts');
fs.mkdirSync(RECEIPT_DIR, { recursive: true });

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/heic', 'image/webp', 'image/gif',
  'application/pdf',
]);
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

function extFor(filename, mime) {
  const fromName = path.extname(filename || '').toLowerCase();
  if (fromName) return fromName;
  return ({ 'image/jpeg':'.jpg','image/png':'.png','image/heic':'.heic','image/webp':'.webp','image/gif':'.gif','application/pdf':'.pdf' })[mime] || '.bin';
}

// v0.57 — Access control for downloading an attachment. Allowed if:
//   • The viewer uploaded it (att.user_id === viewer)
//   • Viewer is Sr Mgr / PM (org-wide audit)
//   • Viewer is Ops Mgr whose team contains the attachment's owner
//   • Viewer is the owner of the linked invoice (tech viewing their own
//     mgr-uploaded PDF / approval artifacts)
function canAccessAttachment(db, att, viewerId) {
  if (att.user_id === viewerId) return true;
  const me = db.prepare("SELECT role FROM users WHERE id = ?").get(viewerId);
  if (!me) return false;
  if (me.role === 'sr_manager' || me.role === 'pm') return true;
  if (me.role === 'ops_manager') {
    const inTeam = db.prepare("SELECT 1 FROM manager_team WHERE manager_user_id = ? AND tech_user_id = ?")
                     .get(viewerId, att.user_id);
    if (inTeam) return true;
  }
  // Owner of the linked invoice (e.g. AP PDF uploaded by manager — tech still sees it).
  if (att.invoice_id) {
    const inv = db.prepare("SELECT user_id FROM invoices WHERE id = ?").get(att.invoice_id);
    if (inv && inv.user_id === viewerId) return true;
  }
  return false;
}

module.exports = (db) => {

  // POST /api/attachments
  router.post('/attachments', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });

    const { filename, mime_type, data_b64, caption,
            invoice_id, expense_id, time_entry_id, work_order_id } = req.body;

    if (!filename || !data_b64) return res.status(400).json({ error: 'filename and data_b64 required' });
    if (mime_type && !ALLOWED_MIME.has(mime_type)) {
      return res.status(400).json({ error: `mime_type ${mime_type} not allowed. Use jpg/png/heic/webp/gif/pdf.` });
    }
    if (!invoice_id && !expense_id && !time_entry_id && !work_order_id) {
      return res.status(400).json({ error: 'must link to at least one of: invoice_id, expense_id, time_entry_id, work_order_id' });
    }

    const buf = Buffer.from(data_b64, 'base64');
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: `file is ${(buf.length/1024/1024).toFixed(1)}MB; max is ${MAX_BYTES/1024/1024}MB` });

    const storageName = `${crypto.randomUUID()}${extFor(filename, mime_type)}`;
    const fullPath = path.join(RECEIPT_DIR, storageName);
    fs.writeFileSync(fullPath, buf);

    const r = db.prepare(`
      INSERT INTO attachments
        (user_id, invoice_id, expense_id, time_entry_id, work_order_id,
         storage_name, original_name, mime_type, size_bytes, caption)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, invoice_id || null, expense_id || null, time_entry_id || null, work_order_id || null,
           storageName, filename, mime_type || null, buf.length, caption || null);

    // Backfill receipt_path on the linked expense for backward compat
    if (expense_id) {
      db.prepare("UPDATE expenses SET receipt_path = ? WHERE id = ? AND user_id = ?")
        .run(`/api/attachments/${r.lastInsertRowid}/download`, Number(expense_id), userId);
    }

    logAudit(db, { entity_type: 'attachments', entity_id: r.lastInsertRowid, user_id: userId,
                   action: 'upload', details: { filename, size: buf.length, expense_id, time_entry_id, invoice_id, work_order_id } });

    const row = db.prepare("SELECT * FROM attachments WHERE id = ?").get(r.lastInsertRowid);
    res.json(row);
  });

  // GET /api/attachments?expense_id=X (or other filters)
  router.get('/attachments', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });

    const where = ['user_id = ?'];
    const params = [userId];
    for (const k of ['invoice_id','expense_id','time_entry_id','work_order_id']) {
      if (req.query[k]) { where.push(`${k} = ?`); params.push(Number(req.query[k])); }
    }
    const rows = db.prepare(`
      SELECT id, invoice_id, expense_id, time_entry_id, work_order_id,
             original_name, mime_type, size_bytes, caption, uploaded_at
      FROM attachments WHERE ${where.join(' AND ')}
      ORDER BY uploaded_at DESC
    `).all(...params);
    res.json(rows);
  });

  // GET /api/attachments/:id/download  → serves the file inline
  // v0.57 — auth check now matches the rest of the app: owner, or a manager
  // with role/team scope for the attachment's invoice. Previously only the
  // tech owner could view their own receipts which blocked Ops Mgr review.
  router.get('/attachments/:id/download', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).send('no user selected');
    const att = db.prepare("SELECT * FROM attachments WHERE id = ?").get(Number(req.params.id));
    if (!att) return res.status(404).send('not found');
    if (!canAccessAttachment(db, att, userId)) return res.status(403).send('not authorized');
    const fullPath = path.join(RECEIPT_DIR, att.storage_name);
    if (!fs.existsSync(fullPath)) return res.status(404).send('file missing');
    // Prevent content-sniffing on user-supplied uploads (esp. PDFs / images)
    res.set('Content-Type', att.mime_type || 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    // v0.65.1 (F-M4) — strip CR/LF/quote/control chars to prevent header
    // injection, and add an RFC 5987 filename* for the real (UTF-8) name.
    const safeName = String(att.original_name || 'file').replace(/[\r\n"\\\x00-\x1f]/g, '').slice(0, 200) || 'file';
    res.set('Content-Disposition',
      `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(att.original_name || 'file')}`);
    logAudit(db, { entity_type: 'attachments', entity_id: att.id, user_id: userId, action: 'download' });
    fs.createReadStream(fullPath).pipe(res);
  });

  // DELETE /api/attachments/:id
  router.delete('/attachments/:id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const att = db.prepare("SELECT * FROM attachments WHERE id = ?").get(Number(req.params.id));
    if (!att) return res.status(404).json({ error: 'not found' });
    if (att.user_id !== userId) return res.status(403).json({ error: 'not yours' });
    if (att.invoice_id) {
      const inv = db.prepare("SELECT status FROM invoices WHERE id = ?").get(att.invoice_id);
      if (inv && inv.status !== 'draft') return res.status(409).json({ error: 'invoice already submitted' });
    }
    try { fs.unlinkSync(path.join(RECEIPT_DIR, att.storage_name)); } catch {}
    db.prepare("DELETE FROM attachments WHERE id = ?").run(att.id);
    logAudit(db, { entity_type: 'attachments', entity_id: att.id, user_id: userId, action: 'delete' });
    res.json({ deleted: true });
  });

  return router;
};

// OTG Field Cost App — Express server (v0.1, technician persona)
const path    = require('path');
const express = require('express');
const { open, ensureSchema } = require('./db');

const { attachUserFromToken, purgeExpiredSessions } = require('./lib/auth');

const app = express();
app.use(express.json({ limit: '20mb' }));   // 20MB lets a receipt photo + base64 overhead through

// One DB handle for the lifetime of the process.
const db = open();
ensureSchema(db);
purgeExpiredSessions(db);

// v0.35 — Resolve Bearer-token sessions BEFORE the request log + routes.
// This sets x-user-id from the session so downstream handlers Just Work.
app.use(attachUserFromToken(db));

// Friendly request log to the console.
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) {
    const u = req.header('x-user-id') || '-';
    console.log(`[${new Date().toISOString().slice(11,19)}] u=${u} ${req.method} ${req.originalUrl}`);
  }
  next();
});

// API
app.use('/api', require('./routes/auth')(db));
app.use('/api', require('./routes/workorders')(db));
app.use('/api', require('./routes/timeentries')(db));
app.use('/api', require('./routes/expenses')(db));
app.use('/api', require('./routes/invoices')(db));
app.use('/api', require('./routes/settings')(db));
app.use('/api', require('./routes/attachments')(db));
app.use('/api', require('./routes/approvals')(db));
app.use('/api', require('./routes/rules')(db));
app.use('/api', require('./routes/dashboard')(db));
app.use('/api', require('./routes/launch_actuals')(db));

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Errors
// v0.45 — BUG-008 fix: map body-parser errors to proper HTTP codes so the
// client sees 413 (entity too large) and 400 (malformed JSON) instead of a
// catch-all 500.
app.use((err, _req, res, _next) => {
  // Express body-parser surfaces these as `err.type` strings.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request entity too large (max 20MB)' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'malformed JSON body' });
  }
  console.error('ERR:', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('  Caper CostWise — v0.45 (P3 polish: download tokens + UX)');
  console.log(`  → http://localhost:${PORT}`);
  console.log('');
});

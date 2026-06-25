// routes/integrations.js
//
// Per-worker MaintainX integration: connect (paste a personal API key or use
// demo data), check status, disconnect, and run an on-demand sync that pulls
// the worker's assigned work orders and imports MaintainX "time taken" as labor.
//
// Writeback to MaintainX (status + comments + pushing Bread's labor up) is a
// deliberately deferred phase and is not wired here yet.
const express = require('express');
const router  = express.Router();
const { logAudit } = require('../db');
const { encrypt, mask } = require('../lib/maintainx/crypto');
const { makeClient } = require('../lib/maintainx/client');
const { syncForUser, syncSingleWorkOrder, loadIntegration } = require('../lib/maintainx/sync');

const DEFAULT_MX_ORG_ID = '477835';

module.exports = (db) => {
  // Identity comes only from the validated session (x-user-id is set by the
  // auth middleware; any client-supplied value was already stripped).
  function requireUser(req, res) {
    const userId = Number(req.header('x-user-id'));
    if (!userId) { res.status(401).json({ error: 'no user selected' }); return null; }
    const u = db.prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(userId);
    if (!u) { res.status(401).json({ error: 'no user selected' }); return null; }
    return u;
  }

  function statusPayload(userId) {
    const i = loadIntegration(db, userId);
    if (!i) return { connected: false };
    return {
      connected: i.status === 'active',
      status: i.status,
      stub: String(i.token_type) === 'demo',
      mx_user_id: i.mx_user_id || null,
      organization_id: i.mx_org_id || null,
      last_sync_at: i.last_sync_at || null,
      last_error: i.last_error || null,
      key_masked: i.access_token_enc ? '••••••' : null,
    };
  }

  // GET — is this worker connected, and when did we last sync?
  router.get('/integrations/maintainx/status', (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    res.json(statusPayload(u.id));
  });

  // POST — connect by storing an encrypted personal token (or demo data).
  //   body: { token, organization_id?, demo? }
  router.post('/integrations/maintainx/connect', async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    let token = (req.body && typeof req.body.token === 'string') ? req.body.token.trim() : '';
    const demo = !!(req.body && req.body.demo);
    if (demo && !token) token = 'stub-demo';
    if (!token)              return res.status(400).json({ error: 'token is required' });
    if (token.length > 4096) return res.status(400).json({ error: 'token too long' });

    const orgId = (req.body && req.body.organization_id) ? String(req.body.organization_id) : DEFAULT_MX_ORG_ID;

    // Validate the credential by identifying the connected MaintainX user.
    let mxUser;
    try {
      mxUser = await makeClient({ token, orgId }).me();
    } catch (e) {
      return res.status(400).json({ error: `Could not verify MaintainX token: ${e.message}` });
    }

    const enc = encrypt(token);
    const tokenType = (demo || token.startsWith('stub')) ? 'demo' : 'api_key';
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO user_integrations
        (user_id, provider, mx_user_id, mx_org_id, access_token_enc, token_type, status, connected_at)
      VALUES (?, 'maintainx', ?, ?, ?, ?, 'active', ?)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        mx_user_id = excluded.mx_user_id, mx_org_id = excluded.mx_org_id,
        access_token_enc = excluded.access_token_enc, token_type = excluded.token_type,
        status = 'active', last_error = NULL, connected_at = excluded.connected_at
    `).run(u.id, mxUser.id != null ? String(mxUser.id) : null, String(mxUser.organizationId || orgId), enc, tokenType, now);

    logAudit(db, { entity_type: 'user_integrations', entity_id: u.id, user_id: u.id, action: 'maintainx_connect',
                   details: { mx_user_id: mxUser.id, demo: tokenType === 'demo' } });
    res.json({ ok: true, ...statusPayload(u.id) });
  });

  // POST — disconnect (purge token; retain already-synced data).
  router.post('/integrations/maintainx/disconnect', (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    db.prepare("DELETE FROM user_integrations WHERE user_id = ? AND provider = 'maintainx'").run(u.id);
    logAudit(db, { entity_type: 'user_integrations', entity_id: u.id, user_id: u.id, action: 'maintainx_disconnect' });
    res.json({ ok: true, connected: false });
  });

  // POST — pull ALL of this worker's assigned work orders + reconcile labor.
  router.post('/integrations/maintainx/sync-now', async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      const summary = await syncForUser(db, u.id);
      logAudit(db, { entity_type: 'user_integrations', entity_id: u.id, user_id: u.id, action: 'maintainx_sync_all',
                     details: summary });
      res.json({ ok: true, summary });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // POST — refresh a single work order on demand (from the WO detail view).
  router.post('/workorders/:id/sync-maintainx', async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad work order id' });
    try {
      const result = await syncSingleWorkOrder(db, u.id, id);
      logAudit(db, { entity_type: 'work_orders', entity_id: id, user_id: u.id, action: 'maintainx_sync_one',
                     details: { labor: result.labor } });
      res.json({ ok: true, result });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  return router;
};

// routes/integrations.js
//
// MaintainX integration endpoints (v0.80 — org-key sync).
// All sync now uses the org-level API key from Settings → Integrations.
// Technicians and managers do NOT need to provide a personal API key.
//
// Sync flow:
//   1. Daily scheduler (server.js) calls syncAllUsersWithOrgKey at 2 AM.
//   2. WO completion (routes/workorders.js PATCH) fires syncSingleWorkOrderWithOrgKey.
//   3. Users can manually import their assigned WOs via POST /integrations/maintainx/pull-my-orders.
//   4. Per-WO refresh still available via POST /workorders/:id/sync-maintainx.
//
// Legacy personal-token connect/disconnect endpoints are retained so any existing
// user_integrations rows with personal tokens continue to resolve mx_user_id.
const express = require('express');
const router  = express.Router();
const { logAudit } = require('../db');
const { encrypt, mask } = require('../lib/maintainx/crypto');
const { makeClient } = require('../lib/maintainx/client');
const {
  syncForUser, syncSingleWorkOrder, loadIntegration,
  syncForUserWithOrgKey, syncSingleWorkOrderWithOrgKey,
  getOrgKey,
} = require('../lib/maintainx/sync');

const DEFAULT_MX_ORG_ID = '477835';

module.exports = (db) => {
  function requireUser(req, res) {
    const userId = Number(req.header('x-user-id'));
    if (!userId) { res.status(401).json({ error: 'no user selected' }); return null; }
    const u = db.prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(userId);
    if (!u) { res.status(401).json({ error: 'no user selected' }); return null; }
    return u;
  }

  // Status reflects org-key setup plus cached user identity (if resolved).
  function statusPayload(userId) {
    const orgKeyConfigured = !!(getOrgKey(db));
    const i = loadIntegration(db, userId);
    return {
      connected: orgKeyConfigured,       // connected = org key is set (no personal token needed)
      org_key_configured: orgKeyConfigured,
      status: orgKeyConfigured ? 'active' : 'not_configured',
      mx_user_id: i?.mx_user_id || null, // cached from previous pull-my-orders
      organization_id: i?.mx_org_id || null,
      last_sync_at: i?.last_sync_at || null,
      last_error: i?.last_error || null,
      // Legacy personal-token fields (null for org_key users)
      stub: i ? String(i.token_type) === 'demo' : false,
      key_masked: (i && i.token_type !== 'org_key' && i.access_token_enc) ? '••••••' : null,
    };
  }

  // GET — sync status for the current user.
  router.get('/integrations/maintainx/status', (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    res.json(statusPayload(u.id));
  });

  // POST /integrations/maintainx/pull-my-orders
  // Pull all MaintainX work orders assigned to the current user using the org key.
  // No personal API key required — identity is resolved by matching email.
  // Available to technicians AND managers.
  router.post('/integrations/maintainx/pull-my-orders', async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      const summary = await syncForUserWithOrgKey(db, u.id);
      logAudit(db, {
        entity_type: 'user_integrations', entity_id: u.id, user_id: u.id,
        action: 'maintainx_pull_my_orders', details: summary,
      });
      res.json({ ok: true, summary });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // POST /integrations/maintainx/sync-now
  // Same as pull-my-orders; kept as an alias for backward compatibility and
  // can also be triggered programmatically (e.g. from the daily scheduler API).
  router.post('/integrations/maintainx/sync-now', async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      const summary = await syncForUserWithOrgKey(db, u.id);
      logAudit(db, {
        entity_type: 'user_integrations', entity_id: u.id, user_id: u.id,
        action: 'maintainx_sync_all', details: summary,
      });
      res.json({ ok: true, summary });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // POST /workorders/:id/sync-maintainx
  // Refresh a single MaintainX WO on demand (e.g. from the WO detail view).
  // Uses the org key — no personal token needed.
  router.post('/workorders/:id/sync-maintainx', async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad work order id' });
    try {
      const result = await syncSingleWorkOrderWithOrgKey(db, u.id, id);
      logAudit(db, {
        entity_type: 'work_orders', entity_id: id, user_id: u.id,
        action: 'maintainx_sync_one', details: { labor: result.labor },
      });
      res.json({ ok: true, result });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ─── Legacy personal-token endpoints (kept for backward compat) ───────────
  // These are no longer surfaced in the UI but remain so any previously stored
  // personal tokens can still be used and mx_user_id values are preserved.

  router.post('/integrations/maintainx/connect', async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    let token = (req.body && typeof req.body.token === 'string') ? req.body.token.trim() : '';
    const demo = !!(req.body && req.body.demo);
    if (demo && !token) token = 'stub-demo';
    if (!token)              return res.status(400).json({ error: 'token is required' });
    if (token.length > 4096) return res.status(400).json({ error: 'token too long' });

    const orgId = (req.body && req.body.organization_id) ? String(req.body.organization_id) : DEFAULT_MX_ORG_ID;
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

    logAudit(db, { entity_type: 'user_integrations', entity_id: u.id, user_id: u.id,
                   action: 'maintainx_connect', details: { mx_user_id: mxUser.id, demo: tokenType === 'demo' } });
    res.json({ ok: true, ...statusPayload(u.id) });
  });

  router.post('/integrations/maintainx/disconnect', (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    db.prepare("DELETE FROM user_integrations WHERE user_id = ? AND provider = 'maintainx'").run(u.id);
    logAudit(db, { entity_type: 'user_integrations', entity_id: u.id, user_id: u.id, action: 'maintainx_disconnect' });
    res.json({ ok: true, connected: false });
  });

  return router;
};

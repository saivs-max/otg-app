// Org-level settings. Currently scoped to the integration credentials
// (Freshdesk + MaintainX) so any user of the app can paste a ticket URL
// and have the server fetch the details using shared org keys.
const express = require('express');
const router  = express.Router();
const { logAudit } = require('../db');

const KEYS = ['freshdesk_domain', 'freshdesk_api_key', 'maintainx_api_key', 'maintainx_organization_id',
              // v0.48 — Expensify integration for FTE field techs.
              'expensify_partner_user_id', 'expensify_partner_password', 'expensify_policy_id'];

// Default MaintainX Org ID — Instacart/Caper. Used when nothing is configured.
const DEFAULT_MX_ORG_ID = '477835';

function get(db, key)            { return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value || null; }
function put(db, key, value, by) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(key, value, by || null, new Date().toISOString());
}

function mask(v) {
  if (!v) return null;
  if (v.length <= 6) return '••••';
  return v.slice(0, 3) + '••••' + v.slice(-2);
}

module.exports = (db) => {

  // v0.44 — Helper: gate to manager roles (used by all sensitive integration
  // endpoints). Settings/integrations contains API keys (even masked) and
  // tweakable rate inputs that field techs shouldn't see or edit.
  function requireManager(req, res) {
    const userId = Number(req.header('x-user-id'));
    if (!userId) { res.status(401).json({ error: 'no user selected' }); return null; }
    const me = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
    if (!me) { res.status(401).json({ error: 'no user selected' }); return null; }
    if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
      res.status(403).json({ error: 'manager role required' });
      return null;
    }
    return me;
  }

  // GET — returns masked values + "configured" flags (never returns raw secrets)
  // v0.44 — manager-only. BUG-003: techs should not see masked keys at all.
  router.get('/settings/integrations', (req, res) => {
    if (!requireManager(req, res)) return;

    const fd_domain = get(db, 'freshdesk_domain');
    const fd_key    = get(db, 'freshdesk_api_key');
    const mx_key    = get(db, 'maintainx_api_key');

    const mx_org = get(db, 'maintainx_organization_id');
    const effective_org = mx_org || process.env.MAINTAINX_ORG_ID || DEFAULT_MX_ORG_ID;

    // v0.48 — Expensify (FTE-only employee approval flow).
    const ex_user   = get(db, 'expensify_partner_user_id');
    const ex_secret = get(db, 'expensify_partner_password');
    const ex_policy = get(db, 'expensify_policy_id');

    res.json({
      freshdesk: {
        domain: fd_domain || null,
        key_masked: mask(fd_key),
        configured: !!(fd_domain && fd_key),
        from_env: !!process.env.FRESHDESK_API_KEY && !fd_key,
      },
      maintainx: {
        key_masked: mask(mx_key),
        organization_id: mx_org || null,
        organization_id_effective: effective_org,        // value actually used (incl. baked-in default)
        organization_id_is_default: !mx_org && !process.env.MAINTAINX_ORG_ID,
        configured: !!mx_key,
        from_env: !!process.env.MAINTAINX_API_KEY && !mx_key,
      },
      expensify: {
        partner_user_masked: mask(ex_user),
        secret_masked:       mask(ex_secret),
        policy_id:           ex_policy || null,
        configured: !!(ex_user && ex_secret && ex_policy),
      },
    });
  });

  // GET /settings/integrations/maintainx-orgs
  // Probes MaintainX for the orgs the saved token can access.
  // The API doesn't have a single canonical endpoint for "list my orgs", so we
  // try several paths in order — whichever returns useful data wins.
  router.get('/settings/integrations/maintainx-orgs', async (req, res) => {
    if (!requireManager(req, res)) return;
    const key = get(db, 'maintainx_api_key') || process.env.MAINTAINX_API_KEY;
    if (!key) return res.status(400).json({ error: 'MaintainX token not set.' });

    const candidates = [
      'https://api.getmaintainx.com/v1/organizations',
      'https://api.getmaintainx.com/v1/users/me',
      'https://api.getmaintainx.com/v1/me',
    ];
    const tried = [];
    let orgs = [];

    for (const u of candidates) {
      try {
        const r = await fetch(u, { headers: { 'Authorization': `Bearer ${key}` } });
        const status = r.status;
        if (!r.ok) {
          tried.push({ url: u, status, error: (await r.text()).slice(0, 200) });
          continue;
        }
        const body = await r.json().catch(() => ({}));
        // Possible shapes:
        //  - /organizations         → { results: [{ id, name }, ...] } OR an array of orgs
        //  - /users/me              → { id, organizations: [{ id, name }, ...] }
        //  - /me                    → similar
        const list =
          (Array.isArray(body) ? body : null)
          || body.results
          || body.organizations
          || body.orgs
          || body.data
          || (body.organization ? [body.organization] : null);
        if (Array.isArray(list)) {
          orgs = list
            .filter(o => o && (o.id != null))
            .map(o => ({ id: String(o.id), name: o.name || o.title || `(no name #${o.id})` }));
          tried.push({ url: u, status, found: orgs.length });
          if (orgs.length) break;
        } else {
          tried.push({ url: u, status, found: 0, note: 'response had no org array' });
        }
      } catch (e) {
        tried.push({ url: u, error: e.message });
      }
    }

    res.json({ orgs, tried });
  });

  // POST /settings/integrations/test  { source: 'freshdesk' | 'maintainx' }
  // Hits a lightweight read endpoint to verify the saved credentials work.
  router.post('/settings/integrations/test', async (req, res) => {
    if (!requireManager(req, res)) return;
    const source = (req.body.source || '').toLowerCase();

    try {
      if (source === 'freshdesk') {
        const domain = get(db, 'freshdesk_domain') || process.env.FRESHDESK_DOMAIN;
        const key    = get(db, 'freshdesk_api_key') || process.env.FRESHDESK_API_KEY;
        if (!domain || !key) return res.status(400).json({ ok: false, error: 'Freshdesk credentials not set.' });
        const r = await fetch(`https://${domain}.freshdesk.com/api/v2/agents/me`, {
          headers: { 'Authorization': 'Basic ' + Buffer.from(`${key}:X`).toString('base64') },
        });
        if (!r.ok) return res.status(502).json({ ok: false, error: `Freshdesk ${r.status}: ${(await r.text()).slice(0,200)}` });
        const a = await r.json();
        return res.json({ ok: true, message: `Connected as ${a.contact?.name || 'unknown'} (${a.contact?.email || '?'})` });
      }
      if (source === 'maintainx') {
        const key   = get(db, 'maintainx_api_key') || process.env.MAINTAINX_API_KEY;
        const orgId = get(db, 'maintainx_organization_id') || process.env.MAINTAINX_ORG_ID || DEFAULT_MX_ORG_ID;
        if (!key) return res.status(400).json({ ok: false, error: 'MaintainX token not set.' });

        // v0.47 — MaintainX JWTs embed the organization id, so we no longer
        // send the speculative X-*-Organization-Id headers that earlier
        // tripped MaintainX's validator with "Invalid token". Bearer only.
        const baseHeaders = { 'Authorization': `Bearer ${key}` };
        const candidates = [
          'https://api.getmaintainx.com/v1/workorders?limit=1',
        ];
        const errs = [];
        for (const u of candidates) {
          try {
            const r = await fetch(u, { headers: baseHeaders });
            if (r.ok) {
              const data = await r.json().catch(() => ({}));
              const total = data?.meta?.total ?? data?.total ?? data?.results?.length ?? '?';
              return res.json({
                ok: true,
                message: `MaintainX OK · path: ${u.split('/v1/')[1]} · total visible: ${total}` + (orgId ? ` · org=${orgId}` : ' · (no org id set)')
              });
            }
            errs.push(`${r.status} from ${u}: ${(await r.text()).slice(0, 200)}`);
          } catch (e) {
            errs.push(`network from ${u}: ${e.message}`);
          }
        }
        return res.status(502).json({ ok: false, error: `MaintainX — all endpoints failed:\n  • ` + errs.join('\n  • ') });
      }
      res.status(400).json({ ok: false, error: 'source must be "freshdesk" or "maintainx"' });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // PUT — update one or more settings. Empty string clears that key.
  // Body: { freshdesk_domain?, freshdesk_api_key?, maintainx_api_key? }
  // v0.44 — BUG-001 fix: gate to manager roles. Sibling routes /policy and
  // /settings/work-type-map already enforce this; this one slipped through.
  router.put('/settings/integrations', (req, res) => {
    const me = requireManager(req, res);
    if (!me) return;
    const userId = me.id;

    const updates = [];
    for (const k of KEYS) {
      if (req.body[k] !== undefined) {
        const v = String(req.body[k] || '').trim();
        put(db, k, v || null, userId);
        updates.push(k);
      }
    }
    logAudit(db, { entity_type: 'settings', entity_id: 0, user_id: userId,
                   action: 'integration_keys_updated', details: { fields: updates } });

    res.json({ ok: true, updated: updates });
  });

  // ===== Policy engine (manager-editable) =====
  // GET — returns the effective policy values (defaults + overrides).
  router.get('/policy', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const { getPolicy } = require('../db');
    const pol = getPolicy(db);
    // Also tell the UI which values are explicitly overridden vs default.
    const overrides = {};
    db.prepare("SELECT key, value, updated_at FROM settings WHERE key LIKE 'policy_%'").all().forEach(r => {
      overrides[r.key] = { value: r.value, updated_at: r.updated_at };
    });
    res.json({ effective: pol, overrides });
  });

  // PUT — manager-only. Body is a flat map of { policy_*: number-or-string-or-null }.
  // null/empty clears that override.
  router.put('/policy', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT role FROM users WHERE id = ?").get(userId) : null;
    if (!me) return res.status(401).json({ error: 'no user selected' });
    if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }
    const VALID = new Set([
      'policy_hourly_rate_default','policy_mileage_rate',
      'policy_meal_daily_cap','policy_meal_trip_min_hours',
      // v0.23 — per-cart keys renamed to per-10-carts. Legacy keys still
      // accepted on PUT for backward compatibility (auto-converted ×10).
      'policy_hours_per_10_carts_deployment','policy_hours_per_10_carts_retrofit',
      'policy_hours_per_10_carts_service','policy_hours_per_10_carts_repair',
      'policy_hours_per_cart_deployment','policy_hours_per_cart_retrofit',
      'policy_hours_per_cart_service','policy_hours_per_cart_repair',
      // v0.25.1 — AP recipient email (string, not numeric)
      'policy_ap_email',
    ]);
    const STRING_KEYS = new Set(['policy_ap_email']);
    // Clean up legacy override retired in v0.20.
    db.prepare("DELETE FROM settings WHERE key = 'policy_hours_flag_multiplier'").run();
    // Auto-migrate legacy per-cart override keys into per-10-carts (×10).
    for (const wt of ['deployment','retrofit','service','repair']) {
      const oldKey = `policy_hours_per_cart_${wt}`;
      const newKey = `policy_hours_per_10_carts_${wt}`;
      const old = db.prepare("SELECT value FROM settings WHERE key = ?").get(oldKey);
      if (old && !db.prepare("SELECT 1 FROM settings WHERE key = ?").get(newKey)) {
        const v = parseFloat(old.value);
        if (isFinite(v)) put(db, newKey, String(v * 10), userId);
      }
      db.prepare("DELETE FROM settings WHERE key = ?").run(oldKey);
    }
    const updated = [];
    for (let [k, v] of Object.entries(req.body || {})) {
      if (!VALID.has(k)) continue;
      // v0.23 — if the body uses the legacy per-cart key, normalize it on the
      // way in by mapping to the per-10-carts key and multiplying value × 10.
      const legacyMatch = k.match(/^policy_hours_per_cart_(\w+)$/);
      if (legacyMatch) {
        k = `policy_hours_per_10_carts_${legacyMatch[1]}`;
        if (v != null && v !== '') v = String(Number(v) * 10);
        // Also wipe the old key so it doesn't linger in settings.
        db.prepare("DELETE FROM settings WHERE key = ?").run(`policy_hours_per_cart_${legacyMatch[1]}`);
      }
      if (v === '' || v == null) {
        db.prepare("DELETE FROM settings WHERE key = ?").run(k);
      } else if (STRING_KEYS.has(k)) {
        // String setting (e.g. AP email). Light-touch validation; trim only.
        const s = String(v).trim();
        if (k === 'policy_ap_email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
          return res.status(400).json({ error: `policy_ap_email must be a valid email address` });
        }
        put(db, k, s, userId);
      } else {
        const n = Number(v);
        if (!isFinite(n) || n < 0) continue;
        put(db, k, String(n), userId);
      }
      updated.push(k);
    }
    logAudit(db, { entity_type: 'settings', entity_id: 0, user_id: userId,
                   action: 'policy_updated', details: { fields: updated } });
    res.json({ ok: true, updated });
  });

  // ============================================================
  // Work-type integration mapping (v0.30)
  // ------------------------------------------------------------
  // GET  /settings/work-type-map
  // PUT  /settings/work-type-map { maintainx: { field, map }, freshdesk_caperhelp: { field, map } }
  //
  // Stored as 4 settings rows:
  //   integ_maintainx_work_type_field
  //   integ_maintainx_work_type_map           (JSON string)
  //   integ_freshdesk_caperhelp_work_type_field
  //   integ_freshdesk_caperhelp_work_type_map (JSON string)
  router.get('/settings/work-type-map', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT role FROM users WHERE id = ?").get(userId) : null;
    if (!me || !['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }
    const get = (k) => db.prepare("SELECT value FROM settings WHERE key = ?").get(k)?.value || '';
    res.json({
      maintainx: {
        field: get('integ_maintainx_work_type_field'),
        map:   get('integ_maintainx_work_type_map'),
      },
      freshdesk_caperhelp: {
        field: get('integ_freshdesk_caperhelp_work_type_field'),
        map:   get('integ_freshdesk_caperhelp_work_type_map'),
      },
    });
  });

  router.put('/settings/work-type-map', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const me = userId ? db.prepare("SELECT role FROM users WHERE id = ?").get(userId) : null;
    if (!me || !['ops_manager','sr_manager','pm'].includes(me.role)) {
      return res.status(403).json({ error: 'manager role required' });
    }
    const VALID = new Set(['deployment','retrofit','service','repair']);
    const body = req.body || {};

    function validateMap(label, raw) {
      if (!raw) return null;
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (_) { throw new Error(`${label} map: not valid JSON`); }
      if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} map: must be a JSON object`);
      for (const [k, v] of Object.entries(parsed)) {
        if (!VALID.has(v)) throw new Error(`${label} map: value "${v}" must be one of ${[...VALID].join(', ')}`);
      }
      return JSON.stringify(parsed);
    }

    let mxMap, fdMap;
    try {
      mxMap = validateMap('MaintainX', body.maintainx?.map);
      fdMap = validateMap('Freshdesk caperhelp', body.freshdesk_caperhelp?.map);
    } catch (e) { return res.status(400).json({ error: e.message }); }

    const ops = [
      ['integ_maintainx_work_type_field',          body.maintainx?.field || ''],
      ['integ_maintainx_work_type_map',            mxMap || ''],
      ['integ_freshdesk_caperhelp_work_type_field', body.freshdesk_caperhelp?.field || ''],
      ['integ_freshdesk_caperhelp_work_type_map',   fdMap || ''],
    ];
    for (const [k, v] of ops) {
      if (v) put(db, k, String(v), userId);
      else   db.prepare("DELETE FROM settings WHERE key = ?").run(k);
    }
    logAudit(db, { entity_type: 'settings', entity_id: 0, user_id: userId,
                   action: 'work_type_map_updated', details: { keys: ops.map(o => o[0]) } });
    res.json({ ok: true });
  });

  return router;
};

// Helper used by other routes (e.g. workorders.js) to read a setting,
// preferring the DB-stored value, falling back to env, then null.
module.exports.read = (db, key, envVar) => {
  const fromDb = get(db, key);
  if (fromDb) return fromDb;
  if (envVar && process.env[envVar]) return process.env[envVar];
  return null;
};

// Work order endpoints.
// In v0.2 a technician can also create a WO inline by pasting a Freshdesk or
// MaintainX ticket — used when the source system hasn't synced yet (PRD §4.2).
// In v0.3, pasting a ticket URL auto-fills the form (stubbed; real APIs drop in
// once MAINTAINX_API_KEY / FRESHDESK_API_KEY are set).
const express = require('express');
const router  = express.Router();
const { logAudit, activeWorkTypes } = require('../db');
const settings = require('./settings');
const { parseCaperDescription, parseCartRangeFromTitle, countSubWOsFromProgress, classifyMxWorkType } = require('../lib/maintainxExtract');

const VALID_SOURCES = new Set(['maintainx','freshdesk']);
// v0.62 — VALID_TYPES is now dynamic; resolved from the work_types table at
// validation time so admin-added types pass.

// Default MaintainX Organization ID for the Instacart/Caper tenant.
// Used when nothing is configured in Settings or env. Override per-deploy by
// setting maintainx_organization_id in Settings or MAINTAINX_ORG_ID in .env.
const DEFAULT_MX_ORG_ID = '477835';

module.exports = (db) => {

  // GET /api/workorders
  // By default returns work orders assigned to the current user, excluding
  // cancelled ones. Override flags:
  //   ?all=1                  → every user's WOs
  //   ?include_cancelled=1    → include cancelled status
  router.get('/workorders', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });

    // v0.45 — BUG-007 fix: managers default to "all WOs in the org" since
    // they don't have WOs personally assigned. Techs default to "my
    // assigned WOs". An explicit ?all=0 forces assigned-only for managers
    // who want to see only their own (rare but possible).
    const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
    const isManager = me && ['ops_manager','sr_manager','pm'].includes(me.role);
    const all = req.query.all === undefined
      ? isManager                    // managers: default true
      : req.query.all === '1';       // explicit override (any role)
    const includeCancelled = req.query.include_cancelled === '1';

    const where = [];
    const params = [];
    if (!all) { where.push('assigned_user_id = ?'); params.push(userId); }
    if (!includeCancelled) where.push("status != 'cancelled'");

    const sql = `
      SELECT id, external_id, source_system, work_type, store_id, store_name, store_address,
             cart_count, scheduled_date, description, status, assigned_user_id
      FROM work_orders
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY
        CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        scheduled_date ASC, id DESC
    `;
    res.json(db.prepare(sql).all(...params));
  });

  router.get('/workorders/:id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    const wo = db.prepare("SELECT * FROM work_orders WHERE id = ?").get(Number(req.params.id));
    if (!wo) return res.status(404).json({ error: 'not found' });

    // v0.64 — managers (ops_mgr / sr_mgr / pm) review the WHOLE work order:
    // every assigned tech's labor + expenses, so they can review, edit, and tag
    // individual line items. Technicians still see only their own entries.
    const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
    const isManager = me && ['ops_manager','sr_manager','pm'].includes(me.role);

    const time_entries = db.prepare(`
      SELECT t.*, u.name AS tech_name
      FROM time_entries t JOIN users u ON u.id = t.user_id
      WHERE t.work_order_id = ? ${isManager ? '' : 'AND t.user_id = ?'}
      ORDER BY t.clock_in DESC
    `).all(...(isManager ? [wo.id] : [wo.id, userId || 0]));
    const expenses = db.prepare(`
      SELECT e.*, u.name AS tech_name
      FROM expenses e JOIN users u ON u.id = e.user_id
      WHERE e.work_order_id = ? ${isManager ? '' : 'AND e.user_id = ?'}
      ORDER BY e.expense_date DESC, e.id DESC
    `).all(...(isManager ? [wo.id] : [wo.id, userId || 0]));
    const attachments = db.prepare(`
      SELECT a.*, e.category AS expense_category
      FROM attachments a LEFT JOIN expenses e ON e.id = a.expense_id
      WHERE (a.work_order_id = ?
             OR a.expense_id IN (SELECT id FROM expenses WHERE work_order_id = ?)
             OR a.time_entry_id IN (SELECT id FROM time_entries WHERE work_order_id = ?))
        ${isManager ? '' : 'AND a.user_id = ?'}
      ORDER BY a.uploaded_at DESC
    `).all(...(isManager ? [wo.id, wo.id, wo.id] : [wo.id, wo.id, wo.id, userId || 0]));

    // Compute drive vs work hour split + total distance from GPS points
    const summary = summarizeWoTime(time_entries);

    res.json({ ...wo, time_entries, expenses, attachments, summary });
  });

  // PATCH /api/workorders/:id  { status?, store_name?, store_id?, store_address?,
  //                              cart_count?, scheduled_date?, description? }
  // Field tech can update the WO they're assigned to.
  router.patch('/workorders/:id', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const id = Number(req.params.id);
    const wo = db.prepare("SELECT * FROM work_orders WHERE id = ?").get(id);
    if (!wo) return res.status(404).json({ error: 'not found' });

    const fields = ['status','store_name','store_id','store_address','cart_count','scheduled_date','description','wo_number','sub_wo_count','priority'];
    const updates = [];
    const params  = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        if (f === 'status' && !['open','in_progress','completed','cancelled'].includes(req.body[f])) {
          return res.status(400).json({ error: 'invalid status' });
        }
        updates.push(`${f} = ?`); params.push(req.body[f]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'no fields to update' });

    db.prepare(`UPDATE work_orders SET ${updates.join(', ')} WHERE id = ?`).run(...params, id);
    logAudit(db, { entity_type: 'work_orders', entity_id: id, user_id: userId, action: 'update',
                   details: req.body });
    res.json(db.prepare("SELECT * FROM work_orders WHERE id = ?").get(id));
  });

  // POST /api/workorders/parse-url  { url }
  // Parses a Freshdesk or MaintainX ticket URL and returns pre-filled details.
  // v0.3 stubs the actual API call — replace stubFetchTicket() with a real
  // fetch() to the source system once API keys are configured.
  router.post('/workorders/parse-url', async (req, res) => {
    const url = (req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url required' });

    const parsed = detectSourceAndTicket(url);
    if (!parsed) {
      return res.status(400).json({
        error: 'Could not detect a Freshdesk or MaintainX ticket in this URL. Expected one of: https://acme.maintainx.com/work-orders/123, https://app.getmaintainx.com/work-orders/123, https://acme.freshdesk.com/a/tickets/123, or just paste the numeric ticket id.',
        urlReceived: url,
      });
    }
    const { source_system, ticket_id } = parsed;

    try {
      const result = await fetchFromSource(source_system, ticket_id, db);

      // Compose the canonical external_id we'd store this under so we can
      // detect if a record already exists and flag any value mismatches.
      const PREFIX_RX = /^(MX|FD)-(DPL|RTR|SVC|MNT|RPR)-/i;
      const externalIdGuess = (() => {
        const src = source_system === 'maintainx' ? 'MX' : 'FD';
        const typ = ({ deployment:'DPL', retrofit:'RTR', maintenance:'MNT', repair:'RPR' })[result.data.work_type || 'maintenance'];
        return `${src}-${typ}-${ticket_id}`;
      })();
      // Existing might be under any of: the canonical guess OR a record where
      // the embedded ticket id matches.
      const existing = db.prepare(`
        SELECT * FROM work_orders WHERE external_id = ? OR external_id LIKE ?
      `).get(externalIdGuess, `%-${ticket_id}`);

      const discrepancies = existing ? diffWoData(result.data, existing) : [];

      res.json({
        ok: true, source_system, ticket_id, url,
        ...result.data,
        _stub: result.stubbed,
        _raw: result.raw || null,
        _existing: existing ? {
          id: existing.id, external_id: existing.external_id,
          status: existing.status,
          store_name: existing.store_name, store_id: existing.store_id,
          store_address: existing.store_address, cart_count: existing.cart_count,
          work_type: existing.work_type, scheduled_date: existing.scheduled_date,
          description: existing.description,
        } : null,
        _discrepancies: discrepancies,
      });
    } catch (e) {
      console.error('parse-url error:', e.message);
      return res.status(502).json({ error: `Could not fetch from ${source_system}: ${e.message}` });
    }
  });

  // Bare-number passthrough: if the user just types a number with their source
  // selected manually, the chip-driven Add WO form already handles that path.
  // This endpoint is the URL-pasting convenience.

  // POST /api/workorders   — create a WO inline
  router.post('/workorders', (req, res) => {
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });

    const { source_system, work_type, store_name, store_id, store_address, cart_count, scheduled_date, description, title } = req.body;
    let ticket_id = (req.body.ticket_id || '').trim();

    if (!source_system || !work_type || !ticket_id || !store_name) {
      return res.status(400).json({ error: 'source_system, work_type, ticket_id and store_name are required' });
    }
    if (!VALID_SOURCES.has(source_system)) return res.status(400).json({ error: `source_system must be one of ${[...VALID_SOURCES].join(', ')}` });
    const VALID_TYPES = activeWorkTypes(db);
    if (!VALID_TYPES.has(work_type))       return res.status(400).json({ error: `work_type must be one of ${[...VALID_TYPES].join(', ')}` });

    const PREFIX_RX = /^(MX|FD)-(DPL|RTR|SVC|RPR|WO)-/i;
    let external_id;
    if (PREFIX_RX.test(ticket_id)) {
      external_id = ticket_id.toUpperCase();
    } else {
      const src = source_system === 'maintainx' ? 'MX' : 'FD';
      // For known types, use their 3-letter shorthand; for admin-added types,
      // fall back to a neutral 'WO' prefix so the external_id stays parseable.
      const typ = ({ deployment:'DPL', retrofit:'RTR', maintenance:'MNT', repair:'RPR' })[work_type] || 'WO';
      const clean = ticket_id.replace(/^[a-z]{2}-[a-z]{3}-/i, '').replace(/[^a-zA-Z0-9-]/g, '');
      external_id = `${src}-${typ}-${clean}`;
    }

    const dupe = db.prepare("SELECT id, external_id, store_name, status FROM work_orders WHERE external_id = ?").get(external_id);
    if (dupe) return res.status(409).json({
      error: `Work order ${external_id} already exists.`,
      existing: dupe,
    });

    // v0.47 — also accept wo_number / sub_wo_count / priority on inline create
    // so the frontend can mirror what came back from parse-url without a
    // second PATCH round-trip.
    const wo_number    = req.body.wo_number    != null ? Number(req.body.wo_number)    : null;
    const sub_wo_count = req.body.sub_wo_count != null ? Number(req.body.sub_wo_count) : null;
    const priority     = req.body.priority     || null;

    const r = db.prepare(`
      INSERT INTO work_orders
        (external_id, source_system, source_ticket_id, title, work_type, store_id, store_name, store_address,
         cart_count, scheduled_date, description, status, assigned_user_id,
         wo_number, sub_wo_count, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
    `).run(external_id, source_system, ticket_id, title || null, work_type,
           store_id || null, store_name, store_address || null,
           Number(cart_count) || 1,
           scheduled_date || null,
           description || null,
           userId,
           wo_number, sub_wo_count, priority);

    logAudit(db, { entity_type: 'work_orders', entity_id: r.lastInsertRowid, user_id: userId,
                   action: 'tech_created', details: { external_id, source_system, work_type } });

    const row = db.prepare("SELECT * FROM work_orders WHERE id = ?").get(r.lastInsertRowid);
    res.json(row);
  });

  return router;
};

// Real API integration. Uses env vars if set; falls back to the stub otherwise
// so the app keeps running in dev mode without keys.
//
// Required env vars (put them in a .env file in the project root):
//   FRESHDESK_DOMAIN        e.g. "acme" for https://acme.freshdesk.com
//   FRESHDESK_API_KEY       Freshdesk API key (Profile Settings)
//   MAINTAINX_API_KEY       MaintainX API token (Settings → Integrations → API Tokens)
//
// Custom-field mapping is tenant-specific. Update pickCustomField() arg list
// below to match the field names used in your Freshdesk / MaintainX setup.
async function fetchFromSource(source, ticketId, db) {
  if (source === 'freshdesk') {
    const domain = settings.read(db, 'freshdesk_domain', 'FRESHDESK_DOMAIN');
    const key    = settings.read(db, 'freshdesk_api_key', 'FRESHDESK_API_KEY');
    if (!domain || !key) return { data: stubFetchTicket(source, ticketId), stubbed: true };

    const auth = 'Basic ' + Buffer.from(`${key}:X`).toString('base64');
    const r = await fetch(`https://${domain}.freshdesk.com/api/v2/tickets/${ticketId}?include=requester,company`, {
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Freshdesk ${r.status}: ${body.slice(0, 200)}`);
    }
    const t = await r.json();

    // Caperhelp + many other Freshdesk tenants use Freshdesk Companies to model
    // their physical stores. Resolve the company name if we got one and use it
    // as the store_name fallback.
    let companyName = null;
    if (t.company && t.company.name) {
      companyName = t.company.name;
    } else if (t.company_id) {
      try {
        const cr = await fetch(`https://${domain}.freshdesk.com/api/v2/companies/${t.company_id}`, {
          headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
        });
        if (cr.ok) {
          const c = await cr.json();
          companyName = c?.name || null;
          t._resolved_company = c;     // included in raw debug response
        }
      } catch (_) { /* non-fatal */ }
    }

    const subject = t.subject || '';
    const desc    = stripHTML(t.description_text || t.description || '');
    const haystack = `${subject}\n${desc}`;

    // Smart auto-discovery: Freshdesk admins name fields anything, and they
    // auto-get a `cf_` prefix. Walk every key and score it by what it looks like.
    const cf = (t.custom_fields && typeof t.custom_fields === 'object') ? t.custom_fields : {};
    const fdMatch = autoMatchFreshdeskFields(cf);

    // Per-tenant deterministic overrides — applied FIRST, before any heuristic.
    const tenantOverrides = FRESHDESK_TENANT_OVERRIDES[domain] || {};
    const overrideStoreName  = tenantOverrides.store_name_field  ? cf[tenantOverrides.store_name_field]  : null;
    const overrideStoreId    = tenantOverrides.store_id_field    ? cf[tenantOverrides.store_id_field]    : null;
    const overrideCartCount  = tenantOverrides.cart_count_field  ? cf[tenantOverrides.cart_count_field]  : null;
    const overrideCity       = tenantOverrides.city_field        ? cf[tenantOverrides.city_field]        : null;
    const overrideCompany    = tenantOverrides.company_field     ? cf[tenantOverrides.company_field]     : null;

    // For tenants that use the description as the canonical place for store info,
    // run a structured parse over `description_text`. Returns { store_name, store_id, address, cart_count }.
    const parsed = tenantOverrides.parse_description ? parseStoreFromText(`${subject}\n${desc}`) : {};

    // Store NAME: tenant override → description parse → custom fields → Company → auto-discover → regex
    const store_name =
      overrideStoreName
      || parsed.store_name
      || pickCustomField(t, [
        'cf_store_name', 'cf_store_location', 'cf_location_name', 'cf_site_name',
        'cf_business', 'cf_chain', 'cf_account', 'cf_brand',
        'store_name', 'site_name', 'location_name', 'company_name',
      ])
      || companyName                                       // Freshdesk Company.name
      || overrideCompany                                   // tenant's "company/chain" field
      || fdMatch.store_name
      || pickCustomField(t, ['cf_store', 'cf_location', 'cf_site'])
      || extractStoreName(haystack);

    const store_id =
      overrideStoreId
      || parsed.store_id
      || pickCustomField(t, [
        'cf_store_number', 'cf_store_no', 'cf_store_id', 'cf_storeid',
        'cf_site_number', 'cf_site_no', 'cf_site_id',
        'store_number', 'store_id', 'site_number', 'site_id', 'location_id',
        'cf_store', 'cf_site',
      ])
      || fdMatch.store_id
      || extractStoreNumber(haystack);

    const address =
      parsed.address
      || pickCustomField(t, [
          'cf_store_address', 'cf_address', 'address',
          'site_address', 'location_address',
        ])
      || (overrideCity ? String(overrideCity) : null)
      || null;

    // v0.30 — strict work_type resolution. Tenant-specific configured field
    // first; if no configured mapping or the value doesn't map, leave
    // work_type null and flag work_type_unresolved so the UI prompts the user.
    const fdSettingsRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'integ_freshdesk_%_work_type_%'").all();
    const fdSettings = Object.fromEntries(fdSettingsRows.map(r => [r.key, r.value]));
    const wtResolved = resolveWorkType({
      source_system: 'freshdesk', tenant: domain, ticket: t,
      extras: cf, settings: fdSettings,
    });

    return {
      stubbed: false,
      data: {
        work_type:            wtResolved.work_type,
        work_type_source:     wtResolved.source,
        work_type_unresolved: !wtResolved.work_type,
        store_name: store_name || '',
        store_id:   store_id ? String(store_id) : null,
        store_address: address,
        // CART COUNT: tenant override → description parse → explicit fields → auto-match → regex
        cart_count:
          Number(overrideCartCount)
          || parsed.cart_count
          || Number(pickCustomField(t, [
              'cf_cart_count', 'cf_number_of_carts', 'cf_carts_qty', 'cf_carts_quantity', 'cf_total_carts',
              'cart_count', 'number_of_carts', 'carts_qty', 'carts_quantity',
            ]))
          || fdMatch.cart_count
          || extractCartCount(haystack)
          || 1,
        scheduled_date: t.due_by ? t.due_by.slice(0, 10) : null,
        // Use the ticket's description body; fall back to subject if empty.
        description: desc || subject || '',
        subject: subject || null,
      },
      raw: redactedFullResponse(t, {
        description_preview: (desc || '').slice(0, 600),
        _auto_matched: fdMatch._matched,
        _description_parsed: parsed,
        _tenant_override_applied: Object.keys(tenantOverrides).length ? { domain, ...tenantOverrides } : null,
        _all_field_keys: Object.keys(t || {}),
        _custom_field_keys: Object.keys((t && t.custom_fields) || {}),
      }),
    };
  }

  if (source === 'maintainx') {
    const key   = settings.read(db, 'maintainx_api_key', 'MAINTAINX_API_KEY');
    const orgId = settings.read(db, 'maintainx_organization_id', 'MAINTAINX_ORG_ID') || DEFAULT_MX_ORG_ID;
    if (!key) return { data: stubFetchTicket(source, ticketId), stubbed: true };

    const url = `https://api.getmaintainx.com/v1/workorders/${ticketId}`;
    // v0.47 — MaintainX JWTs embed organizationId; sending an X-*-Organization-Id
    // header that doesn't match MaintainX's expected scheme causes a 401
    // "Invalid token" response. Use bearer only by default. We keep an
    // optional fallback for older API plans that DO require an org header.
    const headersNoOrg   = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
    const headersWithOrg = { ...headersNoOrg };
    if (orgId) {
      headersWithOrg['X-MX-Organization-Id'] = String(orgId);
      headersWithOrg['X-Organization-Id']    = String(orgId);
      headersWithOrg['Organization-Id']      = String(orgId);
    }

    // Try bearer-only FIRST (the modern v1 path). Only fall back to the
    // org-header variant if bearer-only somehow returned an empty body —
    // this preserves back-compat with older customers without retriggering
    // the "Invalid token" 401 we hit on JWT-bound tokens.
    const attempts = orgId
      ? [{ label: 'bearer only',         headers: headersNoOrg },
         { label: 'with org headers',    headers: headersWithOrg }]
      : [{ label: 'no org headers',      headers: headersNoOrg }];

    let w;
    let usedHeaders;
    const errs = [];
    for (const a of attempts) {
      try {
        const r = await fetch(url, { headers: a.headers });
        const text = await r.text();
        if (!r.ok) {
          errs.push(`${r.status} ${a.label}: ${text.slice(0, 200)}`);
          continue;
        }
        let raw;
        try { raw = JSON.parse(text); } catch { raw = {}; }
        // MaintainX wraps the WO in a `workOrder` envelope: {"workOrder":{...}}
        const body = raw && raw.workOrder ? raw.workOrder : raw;

        const returnedId = body && (body.id ?? body.workOrderId);
        const hasContent = body && (body.title || body.description || body.location || body.status || body.id);
        if (!hasContent) {
          const apiErr = body && (body.error || body.message || body.detail);
          const bodyDesc = apiErr ? ` (API said: ${JSON.stringify(apiErr).slice(0,160)})` : ` (body: ${text.slice(0, 160)})`;
          errs.push(`${r.status} ${a.label}: WO not in response${bodyDesc}`);
          continue;
        }
        if (returnedId != null && String(returnedId) !== String(ticketId)) {
          errs.push(`${r.status} ${a.label}: returned WO id ${returnedId} ≠ requested ${ticketId}`);
          continue;
        }
        w = body;
        usedHeaders = a.headers;
        console.log(`MaintainX OK: ${url} (${a.label}, id=${returnedId})`);
        break;
      } catch (e) {
        errs.push(`network ${a.label}: ${e.message}`);
      }
    }
    if (!w) throw new Error('MaintainX — could not retrieve work order:\n  • ' + errs.join('\n  • '));

    // Stash the working header set on the chosen attempt so the location lookup
    // below can reuse exactly the same auth/org context.
    const a = { lastHeaders: usedHeaders };

    const title = w.title || '';
    const desc  = w.description || '';
    const haystack = `${title}\n${desc}`;

    // v0.47 — Caper Tech Ops description pattern: "<verb> <obj> at <STORE> - <ADDRESS>".
    // Tested against ticket 99492673 (sequentialId 1613): pulls
    // "Market & Eatery 350" + "8800 Maurer Blvd Lenexa, KS 66219" reliably.
    const caperParse = parseCaperDescription(desc);
    // v0.47 — title pattern "Carts #N - #M" → range count.
    const cartRange = parseCartRangeFromTitle(title);

    // ---- MaintainX field mapping (per actual v1 API shape) ----
    // Custom fields can live in EITHER:
    //   extraFields:        object  { "Field Name": "value", ... }   ← typical
    //   extraFieldValues:   array   [{ extraFieldName, value }, ...] ← legacy
    const efObj = (w.extraFields && typeof w.extraFields === 'object' && !Array.isArray(w.extraFields)) ? w.extraFields : {};
    const extras = Array.isArray(w.extraFieldValues) ? w.extraFieldValues : [];

    const pickExtra = (names) => {
      // Object form first
      for (const cand of names) {
        for (const [k, v] of Object.entries(efObj)) {
          if (k.toLowerCase().trim() === cand.toLowerCase() && v != null && v !== '') return v;
        }
      }
      // Array form fallback
      for (const f of extras) {
        const n = (f.extraFieldName || f.name || '').toLowerCase().trim();
        for (const cand of names) {
          if (n === cand.toLowerCase()) return f.value ?? f.fieldValue ?? f.content;
        }
      }
      return null;
    };

    // Resolve locationId (integer) → { name, address, ... } via separate API call.
    let resolvedLocation = null;
    if (w.locationId) {
      try {
        const lr = await fetch(`https://api.getmaintainx.com/v1/locations/${w.locationId}`, {
          headers: a.lastHeaders || headersWithOrg,    // reuse the headers that just worked
        });
        if (lr.ok) {
          const ld = await lr.json().catch(() => ({}));
          resolvedLocation = ld.location || ld;       // unwrap envelope if present
        }
      } catch (_) { /* non-fatal */ }
    }
    const loc = resolvedLocation || w.location || null;

    // Title pattern parsing: "Queens 4 - Cart #5 Not Powering On"
    //   → store_name = "Queens", store_id = "4", cart # (serial) = 5
    const titleM         = title.match(/^([A-Za-z][A-Za-z'.&\s]*?)\s+(\d{1,5})\s+-\s+/);
    const titleStoreName = titleM ? titleM[1].trim() : (title.match(/^([^-]+?)\s+-\s+/) || [])[1] || null;
    const titleStoreNum  = titleM ? titleM[2]         : null;
    const titleCartNum   = (title.match(/cart\s*#\s*(\d+)/i) || [])[1] || null;

    const store_name =
      pickExtra(['Store Name', 'Store', 'Site Name', 'Site', 'Location Name'])
      || caperParse.store_name                     // v0.47 — description "at <STORE>"
      || (titleStoreName && titleStoreName.length <= 60 ? titleStoreName : null)
      || loc?.name
      || pickCustomField(w, ['store_name', 'store', 'location_name', 'site_name'])
      || extractStoreName(haystack)
      || '';

    const store_id =
      pickExtra(['Store Number', 'Store #', 'Store ID', 'Site Number', 'Site Code', 'Location Code', 'Location ID'])
      || titleStoreNum
      || (loc?.externalId || loc?.code || loc?.number)
      || pickCustomField(w, ['store_id', 'store_number', 'site_id', 'location_id', 'storeNumber'])
      || (loc?.id != null ? String(loc.id) : null)
      || extractStoreNumber(haystack)
      || null;

    const address =
      loc?.address
      || [loc?.street, loc?.address1, loc?.city, loc?.region, loc?.state, loc?.postalCode, loc?.zip].filter(Boolean).join(', ')
      || pickExtra(['Address', 'Store Address', 'Site Address'])
      || caperParse.address                         // v0.47 — description "at X - <ADDRESS>"
      || pickCustomField(w, ['address', 'store_address', 'site_address'])
      || null;

    // Cart count — explicit count fields take priority. For "Cart #5" in title,
    // that's a cart SERIAL not a count, so don't infer count from it. v0.47 —
    // adds title range parsing ("Carts #6 - #10" → 5) for the Caper cart-swap
    // pattern, plus sub-WO progress as final fallback for parent WOs.
    const cart_count =
      Number(pickExtra(['Cart Count', 'Number of Carts', '# of Carts', 'Cart Qty', 'Cart Quantity', 'Quantity', 'Total Carts']))
      || Number(pickCustomField(w, ['cart_count', 'cartCount', 'cart_qty']))
      || cartRange.cart_count
      || extractCartCount(haystack)
      || (w.isParent ? countSubWOsFromProgress(w.progress) : 0)
      || 1;

    // v0.30 — strict work_type resolution from configured MaintainX field map.
    // Pulls integ_maintainx_work_type_field + integ_maintainx_work_type_map
    // from settings; if not configured or value doesn't map, leaves null.
    // v0.47 — falls back to title/description keyword classifier so we don't
    // ship null work_types when no admin field map is configured.
    const settingsRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'integ_maintainx_work_type_%'").all();
    const wtSettings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));
    const wtResolved = resolveWorkType({
      source_system: 'maintainx', extras: efObj, settings: wtSettings,
    });
    const wtFallback = wtResolved.work_type ? null : classifyMxWorkType(w);
    const finalWorkType = wtResolved.work_type || wtFallback;

    return {
      stubbed: false,
      data: {
        work_type:            finalWorkType,
        work_type_source:     wtResolved.work_type ? wtResolved.source : (wtFallback ? 'keyword_fallback' : null),
        work_type_unresolved: !finalWorkType,
        store_name: store_name || '',
        store_id:   store_id ? String(store_id) : null,
        store_address: address || null,
        cart_count,
        scheduled_date: w.dueDate ? w.dueDate.slice(0, 10) : null,
        description: desc || title || '',
        subject: title || null,
        // v0.47 — new fields surfaced from the real MX response.
        wo_number:    w.sequentialId != null ? Number(w.sequentialId) : null,
        sub_wo_count: w.isParent ? countSubWOsFromProgress(w.progress) : 0,
        priority:     w.priority || null,
      },
      raw: redactedFullResponse(w, {
        description_preview: (desc || '').slice(0, 600),
        _all_field_keys: Object.keys(w || {}),
        _extra_field_count: Object.keys(efObj).length || extras.length,
        _extra_field_names: Object.keys(efObj).length ? Object.keys(efObj) : extras.map(f => f.extraFieldName || f.name).filter(Boolean),
        _resolved_location: resolvedLocation,
        _title_parsed: { store_name: titleStoreName, store_num: titleStoreNum, cart_num: titleCartNum },
        _caper_description_parsed: caperParse,            // v0.47 debug
        _cart_range_parsed:        cartRange,             // v0.47 debug
      }),
    };
  }
  return { data: stubFetchTicket(source, ticketId), stubbed: true };
}

// Return the full API response with PII redacted and very long strings clipped.
// This is what the user sees in the "Raw ticket data" debug panel.
function redactedFullResponse(obj, extras = {}) {
  const PII_KEYS = new Set([
    'email','phone','mobile','contact_email','contact_phone',
    'requester_email','requester_phone','responder_email',
  ]);
  const clipLong = (s) => (typeof s === 'string' && s.length > 800) ? s.slice(0, 800) + ` … [+${s.length - 800} chars]` : s;

  function clean(v, depth = 0) {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.slice(0, 50).map(x => clean(x, depth + 1));
    if (typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (PII_KEYS.has(k.toLowerCase())) { out[k] = '<redacted>'; continue; }
        if (depth > 4) { out[k] = '<too deep>'; continue; }
        out[k] = clean(val, depth + 1);
      }
      return out;
    }
    if (typeof v === 'string') return clipLong(v);
    return v;
  }
  return { ...clean(obj), ...extras };
}

// Compare a freshly-pulled payload to an already-stored work order and
// return a list of fields where the values differ. Empty array if all match.
function diffWoData(pulled, existing) {
  if (!existing) return [];
  const fields = [
    { key: 'store_name',     label: 'Store name' },
    { key: 'store_id',       label: 'Store #' },
    { key: 'store_address',  label: 'Address' },
    { key: 'cart_count',     label: 'Cart count' },
    { key: 'work_type',      label: 'Work type' },
    { key: 'scheduled_date', label: 'Scheduled date' },
    { key: 'description',    label: 'Description' },
  ];
  const out = [];
  for (const f of fields) {
    const a = norm(existing[f.key]);
    const b = norm(pulled[f.key]);
    if (a !== b && (a || b)) out.push({ field: f.key, label: f.label, existing: existing[f.key], pulled: pulled[f.key] });
  }
  return out;
}
function norm(v) {
  if (v == null) return '';
  return String(v).trim();
}

// Trims the API response to a small subset that's safe to show in the UI for
// debugging integration mismatches. Excludes PII like requester email/phone.
function pickRawForDebug(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Haversine distance in meters between two {lat,lng} points.
function haversineM(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return 0;
  const R = 6371000, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const aa = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(aa));
}

// Build per-WO summary from time entries:
//   work_minutes, drive_minutes, distance_meters, points (chronological GPS list)
function summarizeWoTime(entries) {
  let work_min = 0, drive_min = 0;
  const points = [];
  // chronological order
  const sorted = [...entries].sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in));
  for (const t of sorted) {
    const start = new Date(t.clock_in).getTime();
    const end   = t.clock_out ? new Date(t.clock_out).getTime() : Date.now();
    const minutes = Math.max(0, (end - start) / 60000 - (t.break_minutes || 0));
    if (t.mode === 'drive') drive_min += minutes;
    else                    work_min  += minutes;
    if (t.gps_lat_in  != null && t.gps_lng_in  != null) {
      points.push({ lat: t.gps_lat_in, lng: t.gps_lng_in, when: t.clock_in,  mode: t.mode, kind: 'in',  entry_id: t.id });
    }
    if (t.gps_lat_out != null && t.gps_lng_out != null) {
      points.push({ lat: t.gps_lat_out, lng: t.gps_lng_out, when: t.clock_out, mode: t.mode, kind: 'out', entry_id: t.id });
    }
  }
  let distance_m = 0;
  for (let i = 1; i < points.length; i++) distance_m += haversineM(points[i-1], points[i]);
  return {
    work_minutes:    +work_min.toFixed(2),
    drive_minutes:   +drive_min.toFixed(2),
    work_hours:      +(work_min / 60).toFixed(2),
    drive_hours:     +(drive_min / 60).toFixed(2),
    distance_meters: Math.round(distance_m),
    distance_miles:  +(distance_m / 1609.344).toFixed(2),
    points,
  };
}

// ---- Text-extraction fallbacks ---------------------------------------------

function stripHTML(s) { return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

// Find a store name in free-text. Looks for known retailers + a place name.
const RETAILERS = [
  'Whole Foods', 'Whole Foods Market', 'ShopRite', 'Stop & Shop', "Stop and Shop",
  'Wegmans', 'Acme', 'Trader Joe\'s', 'Sprouts', 'Safeway', 'Publix', 'Kroger',
  'Giant', 'Harris Teeter', 'Costco', 'Sam\'s Club', 'Walmart', 'Target',
];
function extractStoreName(text) {
  if (!text) return null;
  for (const r of RETAILERS) {
    const re = new RegExp(`\\b${r.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b[ ,\\-]*([A-Z][\\w\\.&'\\- ]{1,40})?`, 'i');
    const m = text.match(re);
    if (m) return (m[0] || '').replace(/\s+/g, ' ').trim();
  }
  return null;
}

// Pull a store number/code: matches "Store #1234", "Store 217", "WF-EDG", "site 0042", etc.
function extractStoreNumber(text) {
  if (!text) return null;
  // "Store 217", "Store #217", "Store: 217", "Store No. 217"
  let m = text.match(/\b(?:store|site|location)\s*(?:#|no\.?|number|id)?\s*[:\-]?\s*(\d{2,6})\b/i);
  if (m) return m[1];
  // Hyphenated codes like "WF-EDG", "SR-PAR"
  m = text.match(/\b([A-Z]{2,4}-[A-Z0-9]{2,6})\b/);
  if (m) return m[1];
  // Bare hash + digits at start of subject ("#217 broken")
  m = text.match(/(?:^|\s)#\s*(\d{2,6})\b/);
  if (m) return m[1];
  return null;
}

// Cart count — be strict to avoid matching cart serial numbers like "Cart 470".
// Handles "2 carts", "20 caper carts", and "Carts: 14, 20" (counts list).
function extractCartCount(text) {
  if (!text) return null;
  // "Carts: 14, 20" / "Carts 14 and 20" — count comma/and-separated serials.
  const listM = text.match(/cart(?:s|\s*#?s?)?\s*[:#]?\s*([\d,\s]+(?:\sand\s\d+)?)/i);
  if (listM) {
    const ids = listM[1].split(/[,\s]+|and/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
    if (ids.length >= 2 && ids.length <= 50) return ids.length;
  }
  // "2 carts", "20 caper carts" — number first, then carts.
  const m = text.match(/\b(\d{1,2})\s+(?:caper[\s-]+)?carts?\b/i)
         || text.match(/\bqty[:\s]+(\d{1,3})\b/i)
         || text.match(/\b(?:total|number|count)\s+of\s+carts?\s*[:=]\s*(\d{1,3})\b/i);
  return m ? Number(m[1]) : null;
}

// Structured parse for richly-formatted Freshdesk ticket descriptions like:
//   "WF 25 / ShopRite 217 – 30 Wayne Hills Mall, Wayne, NJ 07470 Carts: 14, 20"
// Returns { store_name, store_id, address, cart_count } — any subset.
function parseStoreFromText(text) {
  if (!text) return {};
  const out = {};

  // <Retailer> <Number> — most specific store identifier.
  const rx = /\b(Whole\s+Foods(?:\s+Market)?|ShopRite|Shop\s*Rite|Stop\s*&\s*Shop|Stop\s+and\s+Shop|Wegmans|Acme|Trader\s*Joe'?s?|Sprouts|Safeway|Publix|Kroger|Giant|Harris\s+Teeter|Costco|Sam'?s\s+Club|Walmart|Target)\s+(\d{1,5})\b/i;
  const sm = text.match(rx);
  if (sm) {
    out.store_name = sm[1].trim().replace(/\s+/g, ' ');
    out.store_id   = sm[2];
  }

  // US street address through the ZIP code.
  const am = text.match(/(\d{1,6}\s+[A-Z][\w'.\- ]+(?:Mall|Plaza|Center|Centre|Square|Road|Rd|Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Highway|Hwy|Parkway|Pkwy|Court|Ct)[, ]+[A-Z][\w. ]+,\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)/);
  if (am) out.address = am[1].trim();

  const cc = extractCartCount(text);
  if (cc) out.cart_count = cc;

  return out;
}

// Best-guess work type from free-text title/category.
// LEGACY — kept for backward-compatibility on tenants where no explicit
// work_type field is configured yet. The strict path is `resolveWorkType()`
// below, which only returns a value when an explicit configured field maps
// cleanly. Use that for new features.
function inferWorkType(text) {
  const s = (text || '').toLowerCase();
  if (/(retrofit|upgrade|replace)/.test(s))      return 'retrofit';
  if (/(deploy|install|new install)/.test(s))    return 'deployment';
  if (/(repair|broken|fault|error|fix)/.test(s)) return 'repair';
  return 'maintenance';
}

// v0.30 — Strict, deterministic work_type resolution from integration data.
// Returns { work_type, source }:
//   - work_type:  one of 'deployment' | 'retrofit' | 'maintenance' | 'repair', or null
//   - source:     'freshdesk:<field>' | 'maintainx:<field>' | null
// Returns null work_type when no configured field matched. The UI then
// REQUIRES the user to pick manually — we never guess.
function resolveWorkType({ source_system, tenant, ticket, extras, settings }) {
  const VALID = new Set(['deployment','retrofit','maintenance','repair']);
  const norm = (v) => String(v || '').trim();
  const matchInMap = (val, map) => {
    if (!val || !map) return null;
    if (map[val]) return map[val];
    const lc = val.toLowerCase();
    for (const [k, v] of Object.entries(map)) {
      if (k.toLowerCase() === lc) return v;
    }
    return null;
  };
  const parseMap = (s) => {
    if (!s) return null;
    try { return JSON.parse(s); } catch (_) { return null; }
  };

  if (source_system === 'freshdesk') {
    // Per-tenant settings: integ_freshdesk_<tenant>_work_type_field / _map
    // Hardcoded FRESHDESK_TENANT_OVERRIDES are still honored as a fallback.
    const fieldKey = settings?.[`integ_freshdesk_${tenant}_work_type_field`]
      || FRESHDESK_TENANT_OVERRIDES[tenant]?.work_type_field;
    const map = parseMap(settings?.[`integ_freshdesk_${tenant}_work_type_map`])
      || FRESHDESK_TENANT_OVERRIDES[tenant]?.work_type_map;
    if (fieldKey && map) {
      const raw = norm(ticket?.[fieldKey] ||
                       (ticket?.custom_fields && ticket.custom_fields[fieldKey.replace(/^cf_/, '')]));
      const mapped = matchInMap(raw, map);
      if (mapped && VALID.has(mapped)) {
        return { work_type: mapped, source: `freshdesk:${fieldKey}=${raw}` };
      }
    }
    return { work_type: null, source: null };
  }

  if (source_system === 'maintainx') {
    const fieldName = settings?.integ_maintainx_work_type_field || null;
    const map = parseMap(settings?.integ_maintainx_work_type_map);
    if (fieldName && map) {
      const raw = norm(extras?.[fieldName]);
      const mapped = matchInMap(raw, map);
      if (mapped && VALID.has(mapped)) {
        return { work_type: mapped, source: `maintainx:extraFields["${fieldName}"]=${raw}` };
      }
    }
    return { work_type: null, source: null };
  }

  return { work_type: null, source: null };
}

// ---- Tenant-specific Freshdesk field overrides ----
// When a tenant uses non-standard custom field names, lock them in here.
// Field values from these named fields are used FIRST, before any heuristic.
// Add new tenants by their Freshdesk subdomain.
const FRESHDESK_TENANT_OVERRIDES = {
  caperhelp: {
    // NOTE: caperhelp's Freshdesk has mis-labeled custom fields. cf_city actually
    // holds the STORE NUMBER (e.g. "217"). cf_store_number346147 holds the CITY.
    // The richest data lives in the description_text, so for caperhelp we lean on
    // description parsing first (parse_description: true) and use cf_company
    // ("Wakefern" — the chain) only as a fallback if parsing fails.
    parse_description:    true,
    store_name_field:     null,                       // prefer description parse
    store_id_field:       'cf_city',                  // store # is in cf_city (mis-labeled)
    city_field:           'cf_store_number346147',    // city is in cf_store_number346147 (mis-labeled)
    company_field:        'cf_company',               // chain ("Wakefern")
    cart_count_field:     null,                       // no explicit count; parse from description
    // v0.30 — explicit work_type field. When set, the value of that ticket
    // field is mapped through `work_type_map` to one of our 4 enum values.
    // If the field is absent OR maps to nothing, work_type stays null and
    // the UI forces the user to pick manually (no keyword guessing).
    work_type_field:      null,                       // e.g. 'cf_request_type' once configured
    work_type_map:        null,                       // e.g. { 'Deployment': 'deployment', 'Service Call': 'maintenance' }
  },
  // Add new tenants here as you confirm their field names.
};

// Auto-discover store_id and cart_count from any Freshdesk custom_fields object
// when explicit name matches fail. Looks at the field NAME and VALUE shape to
// pick the most likely match, and reports what it picked so the user can verify.
function autoMatchFreshdeskFields(cf) {
  const out = { store_id: null, cart_count: null, store_name: null, _matched: {} };
  if (!cf || typeof cf !== 'object') return out;

  // Pass 1 — find the best store-id candidate.
  // Prefer fields whose name contains "store" / "site" AND whose value looks
  // like a number or short code, while avoiding ones that look like serials
  // (long numeric or contain "cart" in name).
  const storeCands = [];
  const storeNameCands = [];
  const cartCountCands = [];
  for (const [k, v] of Object.entries(cf)) {
    if (v == null || v === '') continue;
    const name = k.toLowerCase();
    const val  = String(v).trim();

    // Skip anything obviously a single-cart serial
    if (/^cf_(cart|caper)([_a-z0-9]*)?$/i.test(name) && !/count|qty|total|number_of/i.test(name)) continue;

    // STORE candidate: name mentions store/site/location
    if (/(?:^|_)(store|site|location)(?:_|$)/.test(name)) {
      // Skip explicit cart-count names within store key (rare)
      if (/cart/.test(name)) continue;
      // Score: prefer "_number" / "_no" / "_id" suffix, then bare cf_store / cf_site, then anything else.
      let score = 0;
      if (/_(number|no|num|id)\b/.test(name)) score += 4;
      if (/^cf_(store|site|location)$/.test(name)) score += 3;
      if (/^cf_(store|site)_(name|address)$/.test(name)) score -= 5; // names/addresses aren't ids
      if (/^\d{1,5}$/.test(val)) score += 2;        // numeric val (typical store #)
      if (/^[A-Z]{1,4}-\w{2,8}$/i.test(val)) score += 2; // short code
      if (val.length > 30) score -= 3;              // probably an address or freeform
      storeCands.push({ name: k, value: val, score });

      // STORE NAME candidate: same field-name pool BUT looking for a string value
      // (length > 4, mostly letters/spaces, not just digits)
      const isNumericish = /^[\d\s#,.\-]+$/.test(val);
      const looksLikeName = !isNumericish && val.length >= 3 && /[A-Za-z]/.test(val);
      if (looksLikeName) {
        let nameScore = 0;
        if (/_(name|location|brand|chain|company|account|business)\b/.test(name)) nameScore += 4;
        if (/^cf_(store|site|location)$/.test(name)) nameScore += 2;
        if (val.length > 60) nameScore -= 2;     // probably an address
        if (/\d{3,}\s*[a-z]/.test(val.toLowerCase())) nameScore -= 3;  // street address pattern
        storeNameCands.push({ name: k, value: val, score: nameScore });
      }
    }

    // CART COUNT candidate: name implies a quantity/count
    if (/cart/.test(name) && /(count|qty|quantity|total|number_of|num_of|no_of)/.test(name)) {
      const n = Number(val.replace(/[^\d.]/g, ''));
      if (Number.isFinite(n) && n > 0 && n < 1000) {
        cartCountCands.push({ name: k, value: val, n, score: 5 });
      }
    }
    // Loose fallback: a numeric field named "carts" (plural, no other modifier) – likely a count
    if (/^cf_carts?$/.test(name) && /^\d{1,3}$/.test(val)) {
      cartCountCands.push({ name: k, value: val, n: Number(val), score: 2 });
    }
  }

  if (storeCands.length) {
    storeCands.sort((a, b) => b.score - a.score);
    const best = storeCands[0];
    if (best.score > 0) {
      // Strip a "Store " prefix if user typed it that way.
      const cleaned = String(best.value).replace(/^store\s*[#:]?\s*/i, '').trim();
      out.store_id = cleaned;
      out._matched.store_id = { from: best.name, value: cleaned };
    }
  }
  if (storeNameCands.length) {
    storeNameCands.sort((a, b) => b.score - a.score);
    const best = storeNameCands[0];
    if (best.score > 0) {
      out.store_name = best.value;
      out._matched.store_name = { from: best.name, value: best.value };
    }
  }
  if (cartCountCands.length) {
    cartCountCands.sort((a, b) => b.score - a.score);
    const best = cartCountCands[0];
    out.cart_count = best.n;
    out._matched.cart_count = { from: best.name, value: best.n };
  }
  return out;
}

// Both Freshdesk (custom_fields object) and MaintainX (customFields array) put
// non-standard data under different keys. Try a few common names.
function pickCustomField(obj, keys) {
  const cf = obj.custom_fields || obj.customFields || {};
  if (Array.isArray(cf)) {
    for (const k of keys) {
      const f = cf.find(x => x.name === k || x.fieldName === k || x.label === k);
      if (f) return f.value ?? f.fieldValue ?? f.content;
    }
  } else if (cf && typeof cf === 'object') {
    for (const k of keys) if (cf[k] != null) return cf[k];
  }
  return null;
}

// Detect MaintainX or Freshdesk ticket from a pasted URL. Lenient by design:
// matches any maintainx.com / getmaintainx.com / freshdesk.com URL and pulls
// out the largest numeric segment as the ticket id. Handles hash routes,
// query strings, and alternate paths (work-orders / workorders / wo / etc.).
function detectSourceAndTicket(url) {
  const u = (url || '').trim();
  if (!u) return null;

  const isMaintainX = /(?:get)?maintainx\.com/i.test(u);
  const isFreshdesk = /freshdesk\.com/i.test(u);
  if (!isMaintainX && !isFreshdesk) return null;

  // Strip query and hash, then collect every numeric segment in the path.
  // Pick the LAST one of useful length (>= 1 digit, < 10 digits to avoid timestamps).
  const noQuery = u.split('?')[0].split('#').join('/');  // keep hash-route paths
  const nums = [...noQuery.matchAll(/\b(\d{1,9})\b/g)].map(m => m[1]);
  const id = nums.length ? nums[nums.length - 1] : null;
  if (!id) return null;

  return { source_system: isMaintainX ? 'maintainx' : 'freshdesk', ticket_id: id };
}

// Returns a plausible WO payload for a source/ticket — used in dev mode when
// env keys aren't set. Replace with real call by populating .env.
function stubFetchTicket(source, ticketId) {
  const stores = [
    { id: 'WF-EDG', name: 'Whole Foods Edgewater' },
    { id: 'SR-PAR', name: 'ShopRite Paramus' },
    { id: 'SS-HOB', name: 'Stop & Shop Hoboken' },
    { id: 'WF-ENG', name: 'Whole Foods Englewood' },
    { id: 'SR-CLF', name: 'ShopRite Clifton' },
  ];
  const seed   = Number(ticketId) || 0;
  const store  = stores[seed % stores.length];
  const today  = new Date(); today.setDate(today.getDate() + 1);

  if (source === 'maintainx') {
    const isRetrofit = seed % 2 === 0;
    return {
      work_type: isRetrofit ? 'retrofit' : 'deployment',
      store_id: store.id,
      store_name: store.name,
      cart_count: isRetrofit ? 12 : 20,
      scheduled_date: today.toISOString().slice(0,10),
      description: isRetrofit
        ? `Retrofit 12 carts: replace shelf brackets and recalibrate scanners.`
        : `Deploy 20 new Caper Carts and run on-floor staff training.`,
    };
  }
  const isRepair = seed % 3 === 0;
  return {
    work_type: isRepair ? 'repair' : 'maintenance',
    store_id: store.id,
    store_name: store.name,
    cart_count: isRepair ? 1 : 4,
    scheduled_date: today.toISOString().slice(0,10),
    description: isRepair
      ? `Cart #${seed % 30 + 1} reporting calibration error — investigate and repair.`
      : `Weekly service check on 4 carts (battery health + sanitizer refill).`,
  };
}

// lib/maintainx/sync.js
//
// Pull MaintainX work orders into Bread and reconcile labor time.
// v0.80 — Org-key sync: all sync now uses the org-level MaintainX API key
// stored in settings (maintainx_api_key). Per-user personal tokens are no
// longer required. User identity in MaintainX is resolved by email lookup and
// cached in user_integrations (token_type='org_key', no personal token stored).
// Sync runs automatically via the daily scheduler and on WO completion.
const crypto = require('crypto');
const { makeClient } = require('./client');
const { mapWorkOrder } = require('./map');
const { decrypt } = require('./crypto');
const { reconcileLaborForWorkOrder, reconcilePerTechLaborCompleted } = require('./labor');

function loadIntegration(db, userId) {
  return db.prepare(
    "SELECT * FROM user_integrations WHERE user_id = ? AND provider = 'maintainx'"
  ).get(userId) || null;
}

// Returns { client, integration }. clientFactory is injectable for tests.
function clientForUser(db, userId, clientFactory = makeClient) {
  const integ = loadIntegration(db, userId);
  if (!integ || integ.status === 'disabled') {
    throw Object.assign(new Error('MaintainX is not connected for this user'), { status: 409 });
  }
  let token = null;
  try { token = decrypt(integ.access_token_enc); }
  catch (e) { throw Object.assign(new Error('Stored MaintainX token could not be read; please reconnect'), { status: 409 }); }
  const client = clientFactory({ token, orgId: integ.mx_org_id });
  return { client, integration: integ };
}

// Don't let a pull regress a status the worker already advanced locally while
// writeback is deferred (e.g. local 'completed' but MaintainX still 'in_progress').
function statusToPersist(localStatus, mxStatus) {
  if ((localStatus === 'completed' || localStatus === 'cancelled') &&
      !(mxStatus === 'completed' || mxStatus === 'cancelled')) {
    return localStatus;
  }
  return mxStatus;
}

function contentHash(mapped) {
  return crypto.createHash('sha1').update(JSON.stringify(mapped)).digest('hex');
}

function upsertWorkOrder(db, userId, mapped) {
  const existing = db.prepare("SELECT id, status, assigned_user_id FROM work_orders WHERE external_id = ?").get(mapped.external_id);
  if (existing) {
    const status = statusToPersist(existing.status, mapped.status);
    db.prepare(`
      UPDATE work_orders SET
        title = ?, work_type = ?, store_id = ?, store_name = ?, store_address = ?,
        cart_count = ?, scheduled_date = ?, description = ?, status = ?,
        wo_number = ?, sub_wo_count = ?, priority = ?,
        assigned_user_id = COALESCE(assigned_user_id, ?)
      WHERE id = ?
    `).run(mapped.title, mapped.work_type, mapped.store_id, mapped.store_name, mapped.store_address,
           mapped.cart_count, mapped.scheduled_date, mapped.description, status,
           mapped.wo_number, mapped.sub_wo_count, mapped.priority, userId, existing.id);
    return { id: existing.id, created: false, ownerId: existing.assigned_user_id || userId };
  }
  const ins = db.prepare(`
    INSERT INTO work_orders
      (external_id, source_system, source_ticket_id, title, work_type, store_id, store_name,
       store_address, cart_count, scheduled_date, description, status, assigned_user_id,
       wo_number, sub_wo_count, priority)
    VALUES (?, 'maintainx', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(mapped.external_id, mapped.source_ticket_id, mapped.title, mapped.work_type, mapped.store_id,
         mapped.store_name, mapped.store_address, mapped.cart_count, mapped.scheduled_date,
         mapped.description, mapped.status, userId, mapped.wo_number, mapped.sub_wo_count, mapped.priority);
  return { id: Number(ins.lastInsertRowid), created: true, ownerId: userId };
}

function recordSyncState(db, { workOrderId, raw, mapped, labor }) {
  db.prepare(`
    INSERT INTO wo_sync_state
      (work_order_id, provider, mx_workorder_id, mx_sequential_id, mx_status, mx_updated_at,
       last_pulled_at, labor_direction, labor_minutes, labor_synced_at, content_hash)
    VALUES (?, 'maintainx', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, mx_workorder_id) DO UPDATE SET
      work_order_id   = excluded.work_order_id,
      mx_sequential_id= excluded.mx_sequential_id,
      mx_status       = excluded.mx_status,
      mx_updated_at   = excluded.mx_updated_at,
      last_pulled_at  = excluded.last_pulled_at,
      labor_direction = excluded.labor_direction,
      labor_minutes   = excluded.labor_minutes,
      labor_synced_at = excluded.labor_synced_at,
      content_hash    = excluded.content_hash
  `).run(
    workOrderId, mapped.source_ticket_id, mapped.wo_number, raw.status || null,
    raw.updatedAt || raw.modifiedAt || null, new Date().toISOString(),
    labor ? labor.direction : null,
    labor && labor.minutes != null ? labor.minutes : null,
    labor && labor.direction === 'pull' ? new Date().toISOString() : null,
    contentHash(mapped)
  );
}

// Resolve a Bread user_id from a MaintainX assignee entry.
// Tries DB lookup by email first (most reliable), then by cached mx_user_id.
// Returns null if the MX user has no matching Bread account.
function resolveBreadUserFromMxUser(db, { mxUserId, email }) {
  if (email) {
    const u = db.prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?)").get(email);
    if (u) return u.id;
  }
  if (mxUserId) {
    const u = db.prepare(
      "SELECT user_id FROM user_integrations WHERE provider = 'maintainx' AND mx_user_id = ?"
    ).get(mxUserId);
    if (u) return u.user_id;
  }
  return null;
}

// Process one raw MaintainX WO: map, upsert, reconcile labor, record state.
function processRawWorkOrder(db, userId, client, raw) {
  const mapped = mapWorkOrder(raw);
  const { id, created, ownerId } = upsertWorkOrder(db, userId, mapped);

  // Use the post-upsert DB status as the authoritative WO status for the
  // labor reconciliation decision. upsertWorkOrder applies statusToPersist()
  // which may keep a locally-advanced status (e.g. 'completed') even if MX
  // still shows 'in_progress', so reading back from DB is the right source.
  const woRow = db.prepare("SELECT status FROM work_orders WHERE id = ?").get(id);
  const woStatus = woRow ? woRow.status : mapped.status;

  // v0.81 — per-tech labor for completed WOs when MX supplies assignee info.
  // extractMxTimePerTech returns entries with mxUserId/email when the MX API
  // response includes per-technician assignee fields on timeEntries[].
  // For completed WOs with identified techs, each tech gets their own synthetic
  // time_entries row (preserving individual invoice attribution).
  // For non-completed WOs or aggregate-only data, fall back to the single-user path.
  let labor;
  const perTechEntries = client.extractMxTimePerTech ? client.extractMxTimePerTech(raw) : [];
  const hasPerTechIds = perTechEntries.length > 0 && perTechEntries.some(e => e.mxUserId || e.email);

  if (woStatus === 'completed' && hasPerTechIds) {
    // Resolve each MX assignee to a Bread user_id; fall back to ownerId when unknown.
    const enriched = perTechEntries.map(e => ({
      ...e,
      breadUserId: resolveBreadUserFromMxUser(db, e) ?? ownerId,
    }));
    labor = reconcilePerTechLaborCompleted(db, {
      workOrderId: id, ownerId, perTechEntries: enriched, anchorDate: mapped.scheduled_date,
    });
  } else {
    const mxTime = client.extractMxTime(raw);
    labor = reconcileLaborForWorkOrder(db, {
      workOrderId: id, userId: ownerId, mxTime, anchorDate: mapped.scheduled_date, woStatus,
    });
  }

  recordSyncState(db, { workOrderId: id, raw, mapped, labor });
  return { id, created, external_id: mapped.external_id, status: woStatus, labor };
}

async function syncForUser(db, userId, { clientFactory } = {}) {
  const { client, integration } = clientForUser(db, userId, clientFactory);
  const assigneeId = integration.mx_user_id || (await client.me()).id;

  const summary = { pulled: 0, created: 0, updated: 0, laborImported: 0, laborMxWins: 0, laborAppWins: 0, laborNone: 0, errors: [] };
  try {
    for await (const raw of client.iterateAssignedWorkOrders({ assigneeId })) {
      try {
        const r = processRawWorkOrder(db, userId, client, raw);
        summary.pulled++;
        if (r.created) summary.created++; else summary.updated++;
        if (r.labor.direction === 'mx_wins') summary.laborMxWins++;
        else if (r.labor.direction === 'pull') summary.laborImported++;
        else if (r.labor.direction === 'app_wins') summary.laborAppWins++;
        else summary.laborNone++;
      } catch (e) {
        summary.errors.push({ id: raw && (raw.id ?? raw.workOrderId), error: e.message });
      }
    }
    db.prepare("UPDATE user_integrations SET last_sync_at = ?, last_error = NULL WHERE id = ?")
      .run(new Date().toISOString(), integration.id);
  } catch (e) {
    db.prepare("UPDATE user_integrations SET last_error = ? WHERE id = ?").run(e.message, integration.id);
    throw e;
  }
  return summary;
}

async function syncSingleWorkOrder(db, userId, workOrderId, { clientFactory } = {}) {
  const wo = db.prepare("SELECT id, source_system, source_ticket_id, external_id FROM work_orders WHERE id = ?").get(workOrderId);
  if (!wo) throw Object.assign(new Error('work order not found'), { status: 404 });
  if (wo.source_system !== 'maintainx') throw Object.assign(new Error('not a MaintainX work order'), { status: 400 });

  const { client, integration } = clientForUser(db, userId, clientFactory);
  const ticket = wo.source_ticket_id || String(wo.external_id).split('-').pop();
  const raw = await client.getWorkOrder(ticket);
  const r = processRawWorkOrder(db, userId, client, raw);
  db.prepare("UPDATE user_integrations SET last_sync_at = ? WHERE id = ?").run(new Date().toISOString(), integration.id);
  return r;
}

// ─── Org-key sync (v0.80) ────────────────────────────────────────────────────
// All functions below use the org-level MaintainX API key from settings instead
// of a per-user personal token. Users are identified in MaintainX by email.

function getOrgKey(db) {
  return db.prepare("SELECT value FROM settings WHERE key = 'maintainx_api_key'").get()?.value
    || process.env.MAINTAINX_API_KEY
    || null;
}

function getOrgId(db) {
  return db.prepare("SELECT value FROM settings WHERE key = 'maintainx_organization_id'").get()?.value
    || process.env.MAINTAINX_ORG_ID
    || '477835';
}

// Build a MaintainX client using the org key. Throws 409 if key not set.
function resolveOrgClient(db, clientFactory = makeClient) {
  const key = getOrgKey(db);
  if (!key) {
    throw Object.assign(
      new Error('MaintainX organization API key not configured. Ask your admin to set it in Settings → Integrations.'),
      { status: 409 }
    );
  }
  return clientFactory({ token: key, orgId: getOrgId(db) });
}

// Return cached mx_user_id for a Bread user, or look it up by email and cache it.
// Uses token_type='org_key' rows in user_integrations — no personal token needed.
async function resolveMxUserId(db, client, user) {
  const cached = db.prepare(
    "SELECT mx_user_id FROM user_integrations WHERE user_id = ? AND provider = 'maintainx'"
  ).get(user.id);
  if (cached?.mx_user_id) return cached.mx_user_id;

  const mxUser = await client.findUserByEmail(user.email);
  if (!mxUser) return null;

  const mxUserId = String(mxUser.id);
  const now = new Date().toISOString();
  // Upsert an org_key row — no personal token, just caches the mx_user_id.
  // access_token_enc is set to '' (empty) since the column is NOT NULL.
  db.prepare(`
    INSERT INTO user_integrations
      (user_id, provider, mx_user_id, mx_org_id, access_token_enc, token_type, status, connected_at)
    VALUES (?, 'maintainx', ?, ?, '', 'org_key', 'active', ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      mx_user_id = excluded.mx_user_id,
      status     = 'active',
      last_error = NULL
  `).run(user.id, mxUserId, getOrgId(db), now);

  return mxUserId;
}

// Pull all MaintainX WOs assigned to a Bread user using the org key.
async function syncForUserWithOrgKey(db, userId, { clientFactory } = {}) {
  const user = db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId);
  if (!user) throw Object.assign(new Error('user not found'), { status: 404 });

  const client = resolveOrgClient(db, clientFactory);
  const assigneeId = await resolveMxUserId(db, client, user);
  if (!assigneeId) {
    throw Object.assign(
      new Error(`No MaintainX account found for ${user.email}. Ensure your MaintainX email matches.`),
      { status: 404 }
    );
  }

  const summary = { pulled: 0, created: 0, updated: 0, laborImported: 0, laborMxWins: 0, laborAppWins: 0, laborNone: 0, errors: [] };
  const integ = db.prepare("SELECT id FROM user_integrations WHERE user_id = ? AND provider = 'maintainx'").get(userId);

  try {
    for await (const raw of client.iterateAssignedWorkOrders({ assigneeId })) {
      try {
        const r = processRawWorkOrder(db, userId, client, raw);
        summary.pulled++;
        if (r.created) summary.created++; else summary.updated++;
        if (r.labor.direction === 'mx_wins') summary.laborMxWins++;
        else if (r.labor.direction === 'pull') summary.laborImported++;
        else if (r.labor.direction === 'app_wins') summary.laborAppWins++;
        else summary.laborNone++;
      } catch (e) {
        summary.errors.push({ id: raw && (raw.id ?? raw.workOrderId), error: e.message });
      }
    }
    if (integ) {
      db.prepare("UPDATE user_integrations SET last_sync_at = ?, last_error = NULL WHERE id = ?")
        .run(new Date().toISOString(), integ.id);
    }
    console.log(`[MaintainX] Sync complete for user ${userId} (${user.email}): pulled=${summary.pulled} created=${summary.created} updated=${summary.updated}`);
  } catch (e) {
    if (integ) db.prepare("UPDATE user_integrations SET last_error = ? WHERE id = ?").run(e.message, integ.id);
    console.error(`[MaintainX] Sync failed for user ${userId}:`, e.message);
    throw e;
  }
  return summary;
}

// Refresh a single MaintainX WO using the org key (e.g. after completion).
async function syncSingleWorkOrderWithOrgKey(db, userId, workOrderId, { clientFactory } = {}) {
  const wo = db.prepare("SELECT id, source_system, source_ticket_id, external_id FROM work_orders WHERE id = ?").get(workOrderId);
  if (!wo) throw Object.assign(new Error('work order not found'), { status: 404 });
  if (wo.source_system !== 'maintainx') throw Object.assign(new Error('not a MaintainX work order'), { status: 400 });

  const client = resolveOrgClient(db, clientFactory);
  const ticket = wo.source_ticket_id || String(wo.external_id).split('-').pop();
  const raw = await client.getWorkOrder(ticket);
  const r = processRawWorkOrder(db, userId, client, raw);

  const integ = db.prepare("SELECT id FROM user_integrations WHERE user_id = ? AND provider = 'maintainx'").get(userId);
  if (integ) db.prepare("UPDATE user_integrations SET last_sync_at = ? WHERE id = ?").run(new Date().toISOString(), integ.id);

  return r;
}

// Sync all active users — called by the daily scheduler.
async function syncAllUsersWithOrgKey(db, { clientFactory } = {}) {
  const users = db.prepare(
    "SELECT id, email FROM users WHERE role IN ('technician','ops_manager','sr_manager','pm')"
  ).all();

  console.log(`[MaintainX] Daily sync starting for ${users.length} users…`);
  const results = [];
  for (const u of users) {
    try {
      const summary = await syncForUserWithOrgKey(db, u.id, { clientFactory });
      results.push({ userId: u.id, email: u.email, ...summary });
    } catch (e) {
      // Skip users who can't be found in MaintainX — expected for non-MX users
      if (e.status !== 404) console.error(`[MaintainX] Daily sync error for user ${u.id}:`, e.message);
      results.push({ userId: u.id, email: u.email, error: e.message });
    }
  }
  const total = results.reduce((s, r) => s + (r.pulled || 0), 0);
  console.log(`[MaintainX] Daily sync complete: ${total} WOs across ${results.filter(r => !r.error).length}/${users.length} users`);
  return results;
}

module.exports = {
  // Legacy per-user-token path (kept for backward compatibility)
  syncForUser, syncSingleWorkOrder, loadIntegration, clientForUser, processRawWorkOrder,
  // Org-key path (v0.80 — preferred)
  syncForUserWithOrgKey, syncSingleWorkOrderWithOrgKey, syncAllUsersWithOrgKey,
  getOrgKey, resolveOrgClient,
  // Helpers (v0.81)
  resolveBreadUserFromMxUser,
};

// lib/maintainx/sync.js
//
// Pull a worker's MaintainX work orders into Bread and reconcile labor time.
// Shared by the on-demand "Sync now" endpoints today; the same entry points
// will later be driven by webhooks + a scheduler (writeback is a deferred phase).
const crypto = require('crypto');
const { makeClient } = require('./client');
const { mapWorkOrder } = require('./map');
const { decrypt } = require('./crypto');
const { reconcileLaborForWorkOrder } = require('./labor');

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

// Process one raw MaintainX WO: map, upsert, reconcile labor, record state.
function processRawWorkOrder(db, userId, client, raw) {
  const mapped = mapWorkOrder(raw);
  const { id, created, ownerId } = upsertWorkOrder(db, userId, mapped);
  const mxTime = client.extractMxTime(raw);
  const labor = reconcileLaborForWorkOrder(db, {
    workOrderId: id, userId: ownerId, mxTime, anchorDate: mapped.scheduled_date,
  });
  recordSyncState(db, { workOrderId: id, raw, mapped, labor });
  return { id, created, external_id: mapped.external_id, status: mapped.status, labor };
}

async function syncForUser(db, userId, { clientFactory } = {}) {
  const { client, integration } = clientForUser(db, userId, clientFactory);
  const assigneeId = integration.mx_user_id || (await client.me()).id;

  const summary = { pulled: 0, created: 0, updated: 0, laborImported: 0, laborAppWins: 0, laborNone: 0, errors: [] };
  try {
    for await (const raw of client.iterateAssignedWorkOrders({ assigneeId })) {
      try {
        const r = processRawWorkOrder(db, userId, client, raw);
        summary.pulled++;
        if (r.created) summary.created++; else summary.updated++;
        if (r.labor.direction === 'pull') summary.laborImported++;
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

module.exports = { syncForUser, syncSingleWorkOrder, loadIntegration, clientForUser, processRawWorkOrder };

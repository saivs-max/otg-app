// lib/maintainx/map.js
//
// Map a raw MaintainX work-order object (as returned by GET /v1/workorders or
// an item from the list endpoint with ?expand=assignees) into the shape Bread's
// `work_orders` table expects. Reuses the battle-tested field extractors in
// lib/maintainxExtract.js so behaviour matches the existing paste-a-URL flow.
const {
  parseCaperDescription,
  parseCartRangeFromTitle,
  countSubWOsFromProgress,
  classifyMxWorkType,
} = require('../maintainxExtract');

const TYP = { deployment: 'DPL', retrofit: 'RTR', maintenance: 'MNT', repair: 'RPR' };

// MaintainX status strings vary by tenant/casing; normalize to Bread's enum.
function normalizeStatus(mxStatus) {
  const s = String(mxStatus || '').toUpperCase().replace(/[\s-]+/g, '_');
  if (['OPEN', 'TODO', 'NEW', 'REQUESTED'].includes(s)) return 'open';
  if (['IN_PROGRESS', 'INPROGRESS', 'STARTED', 'ON_HOLD', 'ONHOLD', 'PAUSED'].includes(s)) return 'in_progress';
  if (['DONE', 'COMPLETED', 'COMPLETE', 'CLOSED', 'RESOLVED'].includes(s)) return 'completed';
  if (['CANCELLED', 'CANCELED', 'VOID', 'REJECTED'].includes(s)) return 'cancelled';
  return 'open';
}

// Extract the assignee id list from an expanded WO (best-effort across shapes).
function assigneeIds(raw) {
  const out = new Set();
  const push = (v) => { if (v != null) out.add(String(v)); };
  if (Array.isArray(raw.assignees)) {
    for (const a of raw.assignees) push(typeof a === 'object' ? (a.id ?? a.userId ?? a.user?.id) : a);
  }
  if (Array.isArray(raw.assignedTo)) for (const a of raw.assignedTo) push(typeof a === 'object' ? a.id : a);
  if (raw.assigneeId != null) push(raw.assigneeId);
  if (raw.assignee && typeof raw.assignee === 'object') push(raw.assignee.id);
  return [...out];
}

function mapWorkOrder(raw) {
  const id    = raw.id ?? raw.workOrderId;
  const title = raw.title || '';
  const desc  = raw.description || '';

  const work_type = classifyMxWorkType(raw) || 'maintenance';   // NOT NULL in schema
  const typ = TYP[work_type] || 'WO';
  const external_id = `MX-${typ}-${id}`;

  const caper = parseCaperDescription(desc);
  const range = parseCartRangeFromTitle(title);
  const loc   = (raw.location && typeof raw.location === 'object') ? raw.location : null;

  const store_name =
    caper.store_name
    || loc?.name
    || (title.match(/^([^-]+?)\s+-\s+/) || [])[1]
    || '';

  const store_id =
    (loc && (loc.externalId || loc.code || loc.number)) ||
    (raw.extraFields && (raw.extraFields['Store Number'] || raw.extraFields['Store #'])) ||
    (loc?.id != null ? String(loc.id) : null);

  const store_address =
    loc?.address
    || [loc?.street, loc?.city, loc?.state, loc?.postalCode].filter(Boolean).join(', ')
    || caper.address
    || null;

  const cart_count =
    range.cart_count
    || (raw.isParent ? countSubWOsFromProgress(raw.progress) : 0)
    || 1;

  return {
    external_id,
    source_system: 'maintainx',
    source_ticket_id: id != null ? String(id) : null,
    title: title || null,
    work_type,
    store_id: store_id ? String(store_id) : null,
    store_name: store_name || null,
    store_address: store_address || null,
    cart_count,
    scheduled_date: raw.dueDate ? String(raw.dueDate).slice(0, 10) : null,
    description: desc || title || null,
    status: normalizeStatus(raw.status),
    wo_number: raw.sequentialId != null ? Number(raw.sequentialId) : null,
    sub_wo_count: raw.isParent ? countSubWOsFromProgress(raw.progress) : 0,
    priority: raw.priority || null,
  };
}

module.exports = { mapWorkOrder, normalizeStatus, assigneeIds };

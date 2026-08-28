// lib/maintainx/client.js
//
// Thin MaintainX REST v1 client used by the sync service. Responsibilities:
//   • Bearer auth, JSON, cursor pagination, polite 429/5xx backoff.
//   • A STUB mode (no token, token starting with "stub", or MAINTAINX_STUB=1)
//     that returns deterministic fixtures — so the on-demand sync UX and the
//     labor pull can be exercised end-to-end without a live MaintainX account.
//
// NOTE (Phase-0 verification): the exact field names for assignee filtering and
// for Time & Cost tracking are not yet confirmed against a live tenant. Those
// guesses are isolated in extractMxTime() and the list filter below, each with
// a documented fallback, so confirming them later is a localized change.
const { assigneeIds } = require('./map');

const BASE = process.env.MAINTAINX_API_BASE || 'https://api.getmaintainx.com/v1';
const PAGE_LIMIT = 50;
// v0.82.4 — polite pacing between list pages so a large org scan doesn't trip
// MaintainX's 429 rate limit. Tunable via env for the daily all-users sync.
const THROTTLE_MS = Number(process.env.MAINTAINX_THROTTLE_MS) || 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isStubToken(token) {
  return !token || token === 'stub' || String(token).startsWith('stub') || process.env.MAINTAINX_STUB === '1';
}

async function fetchJson(url, opts, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || r.status >= 500) {
        const ra = Number(r.headers.get('retry-after'));
        const waitMs = (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0) || Math.min(8000, 250 * 2 ** attempt) + Math.random() * 150;
        if (attempt < retries) { await new Promise(res => setTimeout(res, waitMs)); continue; }
      }
      const text = await r.text();
      let body; try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
      if (!r.ok) {
        const msg = body.error || body.message || text.slice(0, 200) || r.statusText;
        throw Object.assign(new Error(`MaintainX ${r.status}: ${msg}`), { status: r.status, body });
      }
      return body;
    } catch (e) {
      lastErr = e;
      if (e.status && e.status !== 429 && e.status < 500) throw e;   // non-retryable
      if (attempt >= retries) throw e;
      await new Promise(res => setTimeout(res, Math.min(8000, 250 * 2 ** attempt)));
    }
  }
  throw lastErr;
}

// ---- Time extraction (prefer logged Time & Cost, else In-Progress duration) ----
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function extractMxTime(raw) {
  if (!raw || typeof raw !== 'object') return { minutes: 0, source: null, entryId: null };

  // 1) Logged Time & Cost entries (most precise). Try array + scalar shapes.
  // expand=times shape (confirmed live API): raw.times[{type,durationTotal(s),quantity(hrs),userId}]
  if (Array.isArray(raw.times) && raw.times.length) {
    let mins = 0;
    for (const t of raw.times) {
      if (t.type !== 'TIME') continue;
      mins += num(t.durationTotal) > 0 ? num(t.durationTotal) / 60 : num(t.quantity) * 60;
    }
    if (mins > 0) return { minutes: mins, source: 'logged', entryId: 'logged' };
  }
  if (Array.isArray(raw.timeEntries) && raw.timeEntries.length) {
    let mins = 0;
    for (const e of raw.timeEntries) {
      mins += num(e.minutes) || num(e.durationMinutes) ||
              (num(e.seconds) || num(e.durationSeconds)) / 60;
    }
    if (mins > 0) return { minutes: mins, source: 'logged', entryId: 'logged' };
  }
  for (const k of ['totalLoggedMinutes', 'loggedTimeMinutes', 'timeSpentMinutes', 'laborMinutes']) {
    if (num(raw[k]) > 0) return { minutes: num(raw[k]), source: 'logged', entryId: 'logged' };
  }
  for (const k of ['timeSpentSeconds', 'totalLoggedSeconds']) {
    if (num(raw[k]) > 0) return { minutes: num(raw[k]) / 60, source: 'logged', entryId: 'logged' };
  }

  // 2) In-Progress duration (auto, computed from status changes).
  if (num(raw.inProgressDurationMinutes) > 0) {
    return { minutes: num(raw.inProgressDurationMinutes), source: 'in_progress', entryId: null };
  }
  const started = raw.startedAt || raw.inProgressAt || raw.inProgressStartedAt;
  if (started) {
    const startMs = new Date(started).getTime();
    const endRaw = raw.completedAt || raw.doneAt || raw.closedAt;
    const endMs = endRaw ? new Date(endRaw).getTime() : Date.now();
    if (Number.isFinite(startMs) && endMs > startMs) {
      return { minutes: (endMs - startMs) / 60000, source: 'in_progress', entryId: null };
    }
  }
  return { minutes: 0, source: null, entryId: null };
}

// Per-technician extraction.  When timeEntries[] carry assignee info, returns
// one element per tech (keyed by mx user ID or email).  Falls back to a single
// aggregate element (mxUserId/email null) when entries have no assignee, or
// when only scalar / in-progress data is present.  Returns [] when no time.
function extractMxTimePerTech(raw) {
  if (!raw || typeof raw !== 'object') return [];

  // expand=times shape: [{type:'TIME', durationTotal(s), quantity(hrs), userId}]
  // Each entry is already per-user, so group by userId.
  if (Array.isArray(raw.times) && raw.times.length) {
    const perTech = {};
    let hasUserId = false;
    for (const t of raw.times) {
      if (t.type !== 'TIME') continue;
      const mins = num(t.durationTotal) > 0 ? num(t.durationTotal) / 60 : num(t.quantity) * 60;
      if (!(mins > 0)) continue;
      const mxUserId = t.userId != null ? String(t.userId) : null;
      if (mxUserId) hasUserId = true;
      const key = mxUserId || '__agg__';
      if (!perTech[key]) {
        perTech[key] = { mxUserId, email: null, name: null, minutes: 0, source: 'logged',
                         entryId: mxUserId ? `times-${mxUserId}` : 'logged' };
      }
      perTech[key].minutes += mins;
    }
    const entries = Object.values(perTech);
    if (entries.length > 0) {
      if (!hasUserId) {
        const total = entries.reduce((s, e) => s + e.minutes, 0);
        return [{ mxUserId: null, email: null, name: null, minutes: total, source: 'logged', entryId: 'logged' }];
      }
      return entries;
    }
  }

  if (Array.isArray(raw.timeEntries) && raw.timeEntries.length) {
    const perTech = {};
    let hasAssignee = false;
    for (const e of raw.timeEntries) {
      const mins = num(e.minutes) || num(e.durationMinutes) ||
                   (num(e.seconds) || num(e.durationSeconds)) / 60;
      if (!(mins > 0)) continue;
      const asgn = e.assignee || e.user || null;
      const mxUserId = asgn ? (String(asgn.id ?? asgn.userId ?? '') || null) : null;
      const email    = asgn ? ((asgn.email || '').toLowerCase() || null) : null;
      const name     = asgn ? (asgn.fullName || asgn.name || null) : null;
      if (mxUserId || email) hasAssignee = true;
      const key = mxUserId || email || String(e.id ?? '__agg__');
      if (!perTech[key]) {
        perTech[key] = { mxUserId, email, name, minutes: 0, source: 'logged', entryId: String(e.id ?? 'logged') };
      }
      perTech[key].minutes += mins;
    }
    const entries = Object.values(perTech);
    if (entries.length > 0) {
      // If no entry had an assignee, collapse to a single aggregate element
      // with null identity so the caller uses the aggregate (single-user) path.
      if (!hasAssignee) {
        const total = entries.reduce((s, e) => s + e.minutes, 0);
        return [{ mxUserId: null, email: null, name: null, minutes: total, source: 'logged', entryId: 'logged' }];
      }
      return entries;
    }
  }

  // Scalar / in-progress fallback → single aggregate element
  const agg = extractMxTime(raw);
  if (agg.minutes > 0) {
    return [{ mxUserId: null, email: null, name: null, ...agg }];
  }
  return [];
}

function unwrap(body, key) {
  if (body && body[key]) return body[key];
  return body;
}

// ---- Real client ----
function realClient({ token, orgId }) {
  // v0.87 — MaintainX now requires x-organization-id header on all API calls.
  // Previously the org ID was embedded in the JWT; that is no longer the case.
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(orgId ? { 'x-organization-id': String(orgId) } : {}),
  };

  async function me() {
    const b = await fetchJson(`${BASE}/users/me`, { headers });
    const u = unwrap(b, 'user');
    return { id: u.id ?? u.userId, organizationId: u.organizationId ?? orgId, email: u.email, name: u.fullName || u.name };
  }

  async function getWorkOrder(id) {
    // expand=times fetches Time & Cost entries (type:TIME, durationTotal in seconds, userId)
    const b = await fetchJson(`${BASE}/workorders/${encodeURIComponent(id)}?expand=times`, { headers });
    return unwrap(b, 'workOrder');
  }

  async function* iterateAssignedWorkOrders({ assigneeId, statuses } = {}) {
    // v0.82.4 — Import ACTIVE work only: OPEN + IN_PROGRESS. DONE (plus ON_HOLD/
    // CANCELED/SKIPPED) is intentionally excluded — the DONE bucket is the org's
    // entire historical backlog, and because there is NO server-side assignee
    // filter we must page EVERY org WO per status and match client-side. Paging
    // DONE was what tripped MaintainX's 429 rate limit. Completed WOs still sync
    // individually via syncSingleWorkOrderWithOrgKey when marked done in Bread.
    // MaintainX only honours ONE statuses= value per request, so iterate per status.
    // expand=assignees is required — the base list omits assignee data entirely.
    const wanted = statuses || ['OPEN', 'IN_PROGRESS'];
    const seen = new Set();
    for (const status of wanted) {
      let cursor = null, pages = 0, scanned = 0, matched = 0;
      do {
        const qs = new URLSearchParams();
        qs.set('limit', String(PAGE_LIMIT));
        qs.append('expand', 'assignees');
        qs.set('statuses', status);
        if (cursor) qs.set('cursor', cursor);
        const b = await fetchJson(`${BASE}/workorders?${qs.toString()}`, { headers });
        const items = b.workOrders || b.data || b.results || b.items || [];
        pages++;
        for (const wo of items) {
          const woId = String(wo.id ?? wo.workOrderId ?? '');
          if (!woId || seen.has(woId)) continue;
          seen.add(woId); scanned++;
          if (!assigneeId || assigneeIds(wo).includes(String(assigneeId))) { matched++; yield wo; }
        }
        cursor = b.nextCursor ?? b.next_cursor ?? b.cursor ?? null;
        if (cursor) await sleep(THROTTLE_MS);   // pace list pages to respect rate limit
      } while (cursor);
      console.log(`[MaintainX] status=${status}: scanned ${scanned} org WOs / ${pages} page(s), matched ${matched} for assigneeId=${assigneeId}`);
    }
  }

  // Find a MaintainX user by email address using the org-level token.
  // Tries a direct email query first, then falls back to paginated scan.
  async function findUserByEmail(email) {
    const lc = email.toLowerCase();
    // 1) Direct email filter (works on some MaintainX plans)
    try {
      const b = await fetchJson(`${BASE}/users?email=${encodeURIComponent(email)}`, { headers });
      const list = b.users || b.data || b.results || b.items || (Array.isArray(b) ? b : []);
      const match = list.find(u => (u.email || '').toLowerCase() === lc);
      if (match) return { id: String(match.id ?? match.userId), email: match.email, name: match.fullName || match.name };
    } catch (_) { /* fall through to paginated scan */ }

    // 2) Paginated scan — exhausts at most a few pages before giving up
    try {
      let cursor = null;
      do {
        const qs = new URLSearchParams({ limit: '100' });
        if (cursor) qs.set('cursor', cursor);
        const b = await fetchJson(`${BASE}/users?${qs}`, { headers });
        const list = b.users || b.data || b.results || b.items || (Array.isArray(b) ? b : []);
        const match = list.find(u => (u.email || '').toLowerCase() === lc);
        if (match) return { id: String(match.id ?? match.userId), email: match.email, name: match.fullName || match.name };
        cursor = b.nextCursor ?? b.next_cursor ?? b.cursor ?? null;
      } while (cursor);
    } catch (_) { /* ignore */ }

    return null;
  }

  // ---- Locations ----
  // GET /v1/locations — returns { locations: [...], nextCursor }
  // Each location: { id, name, parentId, address, city, state, zip, country,
  //                  latitude, longitude, createdAt, updatedAt }
  async function* iterateLocations() {
    let cursor = null;
    do {
      const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) qs.set('cursor', cursor);
      const b = await fetchJson(`${BASE}/locations?${qs}`, { headers });
      const items = b.locations || b.data || b.results || b.items || [];
      for (const loc of items) yield loc;
      cursor = b.nextCursor ?? b.next_cursor ?? b.cursor ?? null;
    } while (cursor);
  }

  // ---- Assets ----
  // GET /v1/assets — returns { assets: [...], nextCursor }
  // Each asset: { id, name, description, serialNumber, model, manufacturer,
  //               category: { name }, status, location: { id, name }, createdAt, updatedAt }
  async function* iterateAssets() {
    let cursor = null;
    do {
      const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) qs.set('cursor', cursor);
      const b = await fetchJson(`${BASE}/assets?${qs}`, { headers });
      const items = b.assets || b.data || b.results || b.items || [];
      for (const asset of items) yield asset;
      cursor = b.nextCursor ?? b.next_cursor ?? b.cursor ?? null;
    } while (cursor);
  }

  return { isStub: false, me, getWorkOrder, iterateAssignedWorkOrders, findUserByEmail,
           iterateLocations, iterateAssets, extractMxTime, extractMxTimePerTech };
}

// ---- Stub client (deterministic fixtures) ----
function stubFixtures() {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const A = (id) => [{ id: 'mxuser-1', fullName: 'Demo Worker', email: 'worker@example.com', userId: 'mxuser-1', _id: id }];
  return [
    { id: '900001', sequentialId: 2101, title: 'Market & Eatery 350 - Cart Swap - Carts #6 - #10',
      description: 'Swap carts 6-10 at Market & Eatery 350 - 8800 Maurer Blvd Lenexa, KS 66219',
      status: 'DONE', priority: 'HIGH', dueDate: iso(2 * 864e5), assignees: A('900001'),
      timeEntries: [{ id: 'te-1', minutes: 95 }] },                                  // logged 95m → pull
    { id: '900002', sequentialId: 2102, title: 'Whole Foods Englewood - Replace Cart #4',
      description: 'Replace Cart #4 at Whole Foods Englewood - 100 Lincoln Ave, Englewood NJ 07631',
      status: 'DONE', priority: 'MEDIUM', dueDate: iso(3 * 864e5), assignees: A('900002'),
      startedAt: iso(200 * 6e4), completedAt: iso(70 * 6e4) },                        // in-progress 130m → pull
    { id: '900003', sequentialId: 2103, title: 'Stop & Shop Weehawken - Calibrate carts',
      description: 'Calibrate carts at Stop & Shop Weehawken',
      status: 'IN_PROGRESS', priority: 'LOW', assignees: A('900003'),
      startedAt: iso(45 * 6e4) },                                                     // in-progress ~45m → pull
    { id: '900004', sequentialId: 2104, title: 'ShopRite Paramus - New store deployment',
      description: 'Deployment at ShopRite Paramus - 250 Bergen Mall, Paramus, NJ',
      status: 'OPEN', priority: 'MEDIUM', dueDate: iso(-5 * 864e5), assignees: A('900004') }, // open, no time
    { id: '900005', sequentialId: 2105, title: 'Whole Foods Edgewater - Firmware retrofit Carts #1 - #8',
      description: 'Retrofit firmware at Whole Foods Edgewater',
      status: 'DONE', priority: 'HIGH', dueDate: iso(4 * 864e5), assignees: A('900005'),
      timeEntries: [{ id: 'te-5', minutes: 210 }] },                                 // logged 210m → pull
  ];
}

function stubLocations() {
  return [
    { id: 'loc-1', name: 'Whole Foods Market - Edgewater', parentId: null,
      address: '905 River Rd', city: 'Edgewater', state: 'NJ', zip: '07020', country: 'US',
      latitude: 40.8243, longitude: -73.9740, createdAt: '2024-01-10T00:00:00Z', updatedAt: '2024-06-01T00:00:00Z' },
    { id: 'loc-2', name: 'Whole Foods Market - Englewood', parentId: null,
      address: '100 Lincoln Ave', city: 'Englewood', state: 'NJ', zip: '07631', country: 'US',
      latitude: 40.8948, longitude: -73.9721, createdAt: '2024-01-10T00:00:00Z', updatedAt: '2024-06-01T00:00:00Z' },
    { id: 'loc-3', name: 'Stop & Shop - Weehawken', parentId: null,
      address: '2 Lincoln Tunnel', city: 'Weehawken', state: 'NJ', zip: '07086', country: 'US',
      latitude: 40.7693, longitude: -74.0234, createdAt: '2024-02-15T00:00:00Z', updatedAt: '2024-05-20T00:00:00Z' },
    { id: 'loc-4', name: 'ShopRite - Paramus', parentId: null,
      address: '250 Bergen Mall', city: 'Paramus', state: 'NJ', zip: '07652', country: 'US',
      latitude: 40.9495, longitude: -74.0723, createdAt: '2024-03-01T00:00:00Z', updatedAt: '2024-06-15T00:00:00Z' },
    { id: 'loc-5', name: 'Market & Eatery 350 - Lenexa', parentId: null,
      address: '8800 Maurer Blvd', city: 'Lenexa', state: 'KS', zip: '66219', country: 'US',
      latitude: 38.9543, longitude: -94.7977, createdAt: '2024-01-20T00:00:00Z', updatedAt: '2024-04-10T00:00:00Z' },
  ];
}

function stubAssets() {
  const locs = stubLocations();
  const makeCart = (id, num, locId, status = 'ACTIVE') => ({
    id: `asset-${id}`, name: `Cart #${num}`, description: 'Caper smart cart',
    serialNumber: `SN-CAPER-${String(num).padStart(4,'0')}`,
    model: 'Caper C2', manufacturer: 'Caper', category: { id: 'cat-1', name: 'Carts' },
    status, location: { id: locId, name: (locs.find(l=>l.id===locId)||{}).name||'' },
    createdAt: '2024-01-15T00:00:00Z', updatedAt: '2024-06-01T00:00:00Z',
  });
  return [
    makeCart(1,1,'loc-1'), makeCart(2,2,'loc-1'), makeCart(3,3,'loc-1'), makeCart(4,4,'loc-1','INACTIVE'),
    makeCart(5,1,'loc-2'), makeCart(6,2,'loc-2'), makeCart(7,3,'loc-2'),
    makeCart(8,1,'loc-3'), makeCart(9,2,'loc-3'), makeCart(10,3,'loc-3'), makeCart(11,4,'loc-3'), makeCart(12,5,'loc-3'),
    makeCart(13,1,'loc-4'), makeCart(14,2,'loc-4'),
    makeCart(15,6,'loc-5'), makeCart(16,7,'loc-5'), makeCart(17,8,'loc-5'),
                            makeCart(18,9,'loc-5'), makeCart(19,10,'loc-5'),
  ];
}

function stubClient({ orgId }) {
  const fixtures = stubFixtures();
  const locations = stubLocations();
  const assets    = stubAssets();
  return {
    isStub: true,
    async me() { return { id: 'mxuser-1', organizationId: orgId || '477835', email: 'worker@example.com', name: 'Demo Worker' }; },
    async findUserByEmail(email) {
      return { id: 'mxuser-stub', email, name: 'Demo Worker (stub)' };
    },
    async getWorkOrder(id) {
      const wo = fixtures.find(f => String(f.id) === String(id));
      if (!wo) throw Object.assign(new Error(`MaintainX 404: work order ${id} not found`), { status: 404 });
      return wo;
    },
    async *iterateAssignedWorkOrders() {
      for (const wo of fixtures) { yield wo; }
    },
    async *iterateLocations() {
      for (const loc of locations) { yield loc; }
    },
    async *iterateAssets() {
      for (const a of assets) { yield a; }
    },
    extractMxTime,
    extractMxTimePerTech,
  };
}

function makeClient({ token, orgId } = {}) {
  return isStubToken(token) ? stubClient({ orgId }) : realClient({ token, orgId });
}

module.exports = { makeClient, extractMxTime, extractMxTimePerTech, isStubToken };

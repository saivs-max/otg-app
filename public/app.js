// OTG Field Cost App — vanilla-JS SPA (technician persona)
// State, fetch helpers, view rendering, and event wiring all in one file.

const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

// Legacy keys are kept readable for one release for backward-compat with
// dev/test sessions that pre-date v0.35.
const STORAGE_USER_KEY  = 'otg.user.id';      // legacy — pre-v0.35
const STORAGE_TOKEN_KEY = 'otg.session.token'; // v0.35 — bearer token

// Toggle: set to true (or visit ?debug=1) to expose raw integration payloads
// in the Add Work Order panel. Default off — keeps the UI clean for end users.
const DEBUG_INTEGRATIONS = new URLSearchParams(location.search).get('debug') === '1';

// ---- API client ----
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = localStorage.getItem(STORAGE_TOKEN_KEY);
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // When a manager is editing on behalf of a tech, set this so writes hit the tech's record.
  if (STATE.onBehalfOf) headers['x-on-behalf-of'] = String(STATE.onBehalfOf);
  const r = await fetch('/api' + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // 401 mid-session means our token expired/got revoked → bounce to login
    if (r.status === 401 && token) {
      localStorage.removeItem(STORAGE_TOKEN_KEY);
      localStorage.removeItem(STORAGE_USER_KEY);
      location.reload();
    }
    throw Object.assign(new Error(j.error || r.statusText), { data: j });
  }
  return j;
}

// ---- MaintainX work-order sync (per-worker pull + labor import) ----
// On-demand only: the worker decides when to pull. Writeback to MaintainX is a
// deferred phase, so these helpers only read from MaintainX into Bread.
let _mxStatusCache = null;
async function mxGetStatus(force) {
  if (_mxStatusCache && !force) return _mxStatusCache;
  try { _mxStatusCache = await api('/integrations/maintainx/status'); }
  catch (_) { _mxStatusCache = { connected: false }; }
  return _mxStatusCache;
}

async function mxDoConnect(body, close) {
  try {
    const r = await api('/integrations/maintainx/connect', { method: 'POST', body });
    _mxStatusCache = r;
    toast('MaintainX connected ✓', 'ok');
    close(r);
  } catch (e) { toast(e.message || 'Could not connect to MaintainX', 'err'); }
}

// Lightweight accessible modal to paste an API key (or try demo data).
function mxConnectModal() {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'Connect MaintainX');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;';
    ov.innerHTML = `
      <div class="card" style="max-width:430px;width:100%;background:#fff;">
        <div class="section-title" style="margin-top:0;">Connect MaintainX</div>
        <p class="help" style="margin:0 0 12px;">Paste your personal MaintainX API key (MaintainX → Settings → Integrations → API Keys) to pull the work orders assigned to you and import the time you logged as labor.</p>
        <input class="field" id="mxToken" type="password" autocomplete="off" placeholder="MaintainX API key" style="width:100%;margin-bottom:12px;" />
        <div class="flex between" style="gap:8px;align-items:center;">
          <button class="btn btn-ghost btn-sm" id="mxDemo" title="Try the sync with sample work orders">Use demo data</button>
          <div class="flex" style="gap:8px;">
            <button class="btn btn-ghost btn-sm" id="mxCancel">Cancel</button>
            <button class="btn btn-primary btn-sm" id="mxConnect">Connect</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const input = ov.querySelector('#mxToken');
    input.focus();
    const close = (val) => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(null); });
    ov.querySelector('#mxCancel').addEventListener('click', () => close(null));
    ov.querySelector('#mxConnect').addEventListener('click', () => {
      const token = input.value.trim();
      if (!token) return toast('Enter your MaintainX API key, or use demo data', 'err');
      mxDoConnect({ token }, close);
    });
    ov.querySelector('#mxDemo').addEventListener('click', () => mxDoConnect({ demo: true }, close));
  });
}

// Returns true once connected; opens the connect modal if needed.
async function mxEnsureConnected() {
  const s = await mxGetStatus(true);
  if (s.connected) return true;
  const r = await mxConnectModal();
  return !!(r && r.connected);
}

async function mxSyncAll(btn) {
  if (!(await mxEnsureConnected())) return;
  const old = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Syncing…'; }
  try {
    const { summary } = await api('/integrations/maintainx/sync-now', { method: 'POST' });
    const bits = [`${summary.pulled} work order${summary.pulled === 1 ? '' : 's'}`];
    if (summary.laborImported) bits.push(`${summary.laborImported} labor time${summary.laborImported === 1 ? '' : 's'} imported`);
    toast(`Synced ${bits.join(' · ')} ✓`, 'ok');
    goto(STATE.view, STATE.view_arg);
  } catch (e) {
    toast(e.message || 'Sync failed', 'err');
    if (btn) { btn.disabled = false; btn.innerHTML = old; }
  }
}

async function mxSyncOne(woId, btn) {
  if (!(await mxEnsureConnected())) return;
  const old = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Syncing…'; }
  try {
    const { result } = await api(`/workorders/${woId}/sync-maintainx`, { method: 'POST' });
    const l = result.labor || {};
    if (l.direction === 'pull')           toast(`Labor updated from MaintainX: ${(l.minutes / 60).toFixed(2)} hrs ✓`, 'ok');
    else if (l.direction === 'app_wins')  toast('Synced ✓ — your logged time is kept (MaintainX not overwritten)', 'ok');
    else                                  toast('Synced from MaintainX ✓', 'ok');
    goto('woDetail', woId);
  } catch (e) {
    toast(e.message || 'Sync failed', 'err');
    if (btn) { btn.disabled = false; btn.innerHTML = old; }
  }
}

// v0.45 — BUG-009 fix: secure file-download helper. Mints a single-use,
// 5-minute, path-bound download token, then opens the URL with ?dt=. Avoids
// putting the long-lived bearer session token in URLs / browser history /
// server access logs / referer headers.
async function downloadWithToken(path, qs = '') {
  try {
    const t = await api('/download-token', { method: 'POST', body: { path, query: qs } });
    const sep = qs ? '?' + qs + '&' : '?';
    window.open(path + sep + 'dt=' + encodeURIComponent(t.token), '_blank', 'noopener');
  } catch (e) {
    toast(`Couldn't start download: ${e.message}`, 'err');
  }
}

// ---- Toast ----
let _toastTimer;
function toast(msg, kind='') {
  clearTimeout(_toastTimer);
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  // tap to dismiss (also cancels any pending auto-hide)
  t.onclick = () => { clearTimeout(_toastTimer); t.classList.add('hidden'); };
  // Errors stay until the user dismisses them (with a long safety fallback) so a
  // failure is never missed by glancing away; success/info auto-dismiss with a
  // duration scaled to message length so longer messages stay readable.
  if (kind === 'err') {
    t.classList.add('sticky');
    _toastTimer = setTimeout(() => t.classList.add('hidden'), 20000);
  } else {
    t.classList.remove('sticky');
    const dur = Math.min(9000, Math.max(3200, msg.length * 55));
    _toastTimer = setTimeout(() => t.classList.add('hidden'), dur);
  }
}

// ---- Dismissable alerts ----
function alertHTML(kind, ico, body, { dismissable = true } = {}) {
  return `
    <div class="alert ${kind}">
      <span class="ico">${ico}</span>
      <div class="body">${body}</div>
      ${dismissable ? '<button class="close" data-act="dismiss" aria-label="Dismiss">×</button>' : ''}
    </div>
  `;
}
document.addEventListener('click', e => {
  const dis = e.target.closest('[data-act="dismiss"]');
  if (!dis) return;
  const a = dis.closest('.alert');
  if (a) {
    a.classList.add('dismissed');
    setTimeout(() => a.remove(), 250);
  }
});

// ---- Bottom sheet ----
let _sheetPrevFocus = null, _sheetKeyHandler = null;
function showSheet(html, { onMount, dismissable = true } = {}) {
  closeSheet();
  // v0.65.1 (A11Y) — remember focus so we can restore it when the sheet closes.
  _sheetPrevFocus = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  // Dialog semantics + a focusable container for screen readers / keyboard users.
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" tabindex="-1"><div class="sheet-handle"></div>${html}</div>`;
  if (dismissable) wrap.addEventListener('click', e => { if (e.target === wrap) closeSheet(); });
  document.body.appendChild(wrap);
  const sheet = wrap.querySelector('.sheet');
  // v0.65.1 (A11Y) — give the dialog an accessible name (from its heading if it
  // has one, else a generic label) so screen readers announce it correctly.
  const _sheetHeading = sheet.querySelector('h1,h2,h3,h4');
  if (_sheetHeading) { if (!_sheetHeading.id) _sheetHeading.id = 'sheetTitle'; sheet.setAttribute('aria-labelledby', _sheetHeading.id); }
  else sheet.setAttribute('aria-label', 'Dialog');
  const focusables = () => [...sheet.querySelectorAll('input,select,textarea,button,[href],[tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && el.offsetParent !== null);
  // Move focus into the sheet (first field, else the sheet itself).
  (focusables()[0] || sheet).focus();
  // Esc closes (when dismissable); Tab is trapped inside the sheet.
  _sheetKeyHandler = (e) => {
    if (e.key === 'Escape' && dismissable) { e.preventDefault(); closeSheet(); return; }
    if (e.key === 'Tab') {
      const items = focusables();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', _sheetKeyHandler);
  if (onMount) onMount(wrap);
}
function closeSheet() {
  if (_sheetKeyHandler) { document.removeEventListener('keydown', _sheetKeyHandler); _sheetKeyHandler = null; }
  document.querySelectorAll('.sheet-backdrop').forEach(s => s.remove());
  if (_sheetPrevFocus && _sheetPrevFocus.focus) { try { _sheetPrevFocus.focus(); } catch (_) {} _sheetPrevFocus = null; }
}

// ---- Manager proxy ("acting on behalf of") mode ----
// A global, always-visible banner whenever a manager is editing on a tech's
// behalf, with an always-available Exit. Prevents a manager getting "stuck"
// writing to a tech's account without realising it.
function updateProxyBar() {
  const bar = $('#proxyBar');
  if (!bar) return;
  if (STATE.onBehalfOf) {
    bar.innerHTML = `<span class="pb-text">Acting on behalf of <strong>${escapeHTML(STATE.onBehalfOfName || 'a technician')}</strong> — entries you add or edit are recorded against their account.</span><button class="pb-exit" data-act="exit-proxy">Exit</button>`;
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
    bar.innerHTML = '';
  }
}
function exitProxy(opts = {}) {
  if (!STATE.onBehalfOf) return;
  STATE.onBehalfOf = null;
  STATE.onBehalfOfName = null;
  updateProxyBar();
  if (!opts.silent) toast('Exited acting-on-behalf mode', 'ok');
}

// ---- Helpers ----
const fmt$ = (n) => '$' + (n || 0).toFixed(2);
const fmtHrs = (n) => (n || 0).toFixed(2) + ' hrs';
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}
function workTypeLabel(t) {
  return ({ deployment: 'Deployment', retrofit: 'Retrofit', maintenance: 'Maintenance', repair: 'Repair' }[t] || t);
}
function sourceLabel(s) { return s === 'maintainx' ? 'MaintainX' : 'Freshdesk'; }
function todayISO() { return new Date().toISOString().slice(0,10); }

// Request browser geolocation. Returns { lat, lng, accuracy } or null.
function getGPS() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos => resolve({
        lat: +pos.coords.latitude.toFixed(6),
        lng: +pos.coords.longitude.toFixed(6),
        accuracy: Math.round(pos.coords.accuracy || 0),
      }),
      _err => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

function mapsUrl(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

// Render an inline GPS chip:  📍 40.8259, -73.971  ±12m  · View on map
function gpsChip(lat, lng, accuracy, label = 'Location') {
  if (lat == null || lng == null) {
    return `<div class="gps-chip none">📍 ${label}: not captured</div>`;
  }
  return `
    <div class="gps-chip">
      📍 <strong>${label}:</strong> ${lat}, ${lng}${accuracy ? ` <span class="muted">±${accuracy}m</span>` : ''}
      &nbsp;·&nbsp; <a href="${mapsUrl(lat, lng)}" target="_blank" rel="noopener">View on map ↗</a>
    </div>
  `;
}

// ---- Login (v0.35 — username + password) ----
async function renderLogin() {
  $('#loginScreen').classList.remove('hidden');
  $('#app').classList.add('hidden');
  // Replace the user picker with a real login form. Same card styling.
  $('#userList').outerHTML = `
    <form id="loginForm" class="login-form" autocomplete="on">
      <span class="label">Username</span>
      <input class="field" id="liUser" type="text" autocomplete="username" required autofocus />

      <span class="label">Password</span>
      <input class="field" id="liPass" type="password" autocomplete="current-password" required />

      <div id="liErr" class="alert err hidden" style="margin-bottom: 12px;">
        <span class="ico">!</span>
        <div class="body" id="liErrMsg"></div>
      </div>

      <button class="btn btn-primary btn-block" id="liSubmit" type="submit" style="min-height: 50px; font-size: 15px;">
        Sign in
      </button>

      <p class="login-foot" style="margin-top: 18px; font-size: 11px;">
        Trouble signing in? Contact your administrator to reset your password.
      </p>
    </form>
  `;
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#liUser').value.trim();
    const password = $('#liPass').value;
    const errBox = $('#liErr'), errMsg = $('#liErrMsg');
    errBox.classList.add('hidden');
    const btn = $('#liSubmit'); btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Sign-in failed');
      localStorage.setItem(STORAGE_TOKEN_KEY, j.token);
      localStorage.setItem(STORAGE_USER_KEY,  String(j.user.id));
      STATE._mustChangePassword = !!j.must_change_password;
      boot();
    } catch (e) {
      errMsg.textContent = e.message;
      errBox.classList.remove('hidden');
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  });
}

// ---- View router ----
const STATE = {
  user: null,
  active: null,        // running time entry
  view: 'home',
  view_arg: null,
};

async function boot() {
  const token = localStorage.getItem(STORAGE_TOKEN_KEY);
  if (!token) return renderLogin();
  try {
    STATE.user = await api('/me');
  } catch (e) {
    localStorage.removeItem(STORAGE_TOKEN_KEY);
    localStorage.removeItem(STORAGE_USER_KEY);
    return renderLogin();
  }
  $('#loginScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  // Tag the shell with the role so CSS can switch layouts (managers get the
  // wide desktop layout with a sidebar tabbar; technicians stay phone-shaped).
  $('#app').classList.remove('role-technician','role-ops_manager','role-sr_manager','role-pm');
  $('#app').classList.add(`role-${STATE.user.role}`);
  const isMgr = ['ops_manager','sr_manager','pm'].includes(STATE.user.role);
  $('#app').classList.toggle('role-manager', isMgr);
  // v0.35 — Settings tab is admin-only. Non-admins access password change
  // through the small icon next to logout (rendered inline as needed).
  const isAdmin = ['pm','sr_manager'].includes(STATE.user.role);
  $('#hdrSettingsBtn')?.classList.toggle('hidden', !isAdmin);
  $('#hdrPwdBtn')?.classList.toggle('hidden', isAdmin);   // admins access password via Settings → profile
  renderTabbar();
  // v0.35 — force change-password flow if the user is on a temp password.
  if (STATE.user.must_change_password) {
    return openChangePasswordSheet({ forced: true });
  }
  // Default landing varies by role
  goto(isMgr ? 'dashboard' : 'home');
}

// Tabbar built dynamically based on user role.
function renderTabbar() {
  const role = STATE.user?.role || 'technician';
  const tabs = role === 'technician' ? [
    { id: 'home',    label: 'Home',     ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg>` },
    { id: 'timer',   label: 'Timer',    ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M9 2h6"/><path d="M12 2v3"/></svg>` },
    { id: 'add',     label: 'Add',      ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>` },
    { id: 'mine',    label: 'Invoices', ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/></svg>` },
  ] : [
    // Manager tabs
    { id: 'dashboard', label: 'Dashboard', ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>` },
    { id: 'forecast',  label: 'Forecast',  ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>` },
    { id: 'tracker',   label: 'Tracker',   ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>` },
    { id: 'queue',     label: 'Queue',     ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/><circle cx="20" cy="18" r="2"/></svg>` },
    { id: 'launch',    label: 'Launch',    ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19l4-4M9 15l-3 3-1-1 3-3"/><path d="M14 4c-2 1-5 4-7 8l5 5c4-2 7-5 8-7 1-2 1-5 1-6-1 0-4 0-7 0z"/><circle cx="15" cy="9" r="1.6"/></svg>` },
    { id: 'team',      label: 'Team',      ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6"/><circle cx="17" cy="9" r="2.5"/><path d="M14 15c2-1 5-1 7 1"/></svg>` },
    { id: 'allInv',    label: 'Invoices',  ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/></svg>` },
    // v0.60 — Corp Card ledger. Visible only to manager roles. Separate from
    // tech expenses; corp-card spend never lands on a reimbursable invoice.
    { id: 'corpcard',  label: 'Corp Card', ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/></svg>` },
    // v0.65 — 3rd Party tab: review manager-uploaded vendor invoices, spend by vendor.
    { id: 'thirdparty', label: '3rd Party', ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18v4H3z"/><path d="M5 11v8h14v-8"/><path d="M10 15h4"/></svg>` },
    { id: 'policy',    label: 'Policy',    ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/></svg>` },
    // v0.35 — Admin tab for PM / Sr Mgr only
    ...(['pm','sr_manager'].includes(role) ? [{ id: 'admin', label: 'Admin', ico: `<svg class="tab-ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/><circle cx="18" cy="6" r="2"/></svg>` }] : []),
  ];
  $('#tabbar').innerHTML = tabs.map(t => `
    <button data-tab="${t.id}" class="tab-btn">${t.ico}<span>${t.label}</span></button>
  `).join('');
  $$('.tab-btn').forEach(b => b.addEventListener('click', () => { if (STATE.onBehalfOf) exitProxy({ silent: true }); goto(b.dataset.tab); }));
}

function goto(view, arg=null) {
  STATE.view = view; STATE.view_arg = arg;
  $$('.tab-btn').forEach(t => t.classList.toggle('active', t.dataset.tab === view));
  $('#backBtn').classList.add('hidden');
  render();
}

async function render() {
  const v = STATE.view;
  updateProxyBar();
  // v0.65.1 (F-M9) — clear the Home ticker on every navigation so intervals
  // don't stack (renderHome re-creates it when Home is shown).
  clearInterval(STATE._homeInterval); STATE._homeInterval = null;
  $('#hdrTitle').textContent = ({
    home:        'Today',
    timer:       'Time Tracker',
    add:         'Add Expense',
    invoice:     'Current Invoice',
    mine:        'Invoices',
    map:         'Map',
    woPick:      'Pick Work Order',
    woAdd:       'Add Work Order',
    woDetail:    'Work Order',
    invDetail:   'Invoice Preview',
    settings:    'Settings',
    queue:       'Approval Queue',
    team:        'My Team',
    allInv:      'All Invoices',
    policy:      'Policy & Rules',
    dashboard:   'Dashboard',
    forecast:    'Forecast',
    tracker:     'Cost Tracker',
    launch:      'Launch Actuals',
    admin:       'Admin · User management',
    corpcard:    'Corp Card',
    thirdparty:  '3rd Party Invoices',
  })[v] || '';
  if (['woPick','woAdd','woDetail','invDetail','settings'].includes(v)) $('#backBtn').classList.remove('hidden');

  const root = $('#view'); root.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    if (v === 'home')      return renderHome(root);
    if (v === 'timer')     return renderTimer(root);
    if (v === 'add')       return renderAdd(root);
    if (v === 'invoice')   return renderInvoice(root);
    if (v === 'mine')      return renderMine(root);
    if (v === 'woPick')    return renderWoPick(root);
    if (v === 'woAdd')     return renderWoAdd(root);
    if (v === 'invDetail') return renderInvoiceDetail(root, STATE.view_arg);
    if (v === 'settings')  return renderSettings(root);
    if (v === 'woDetail')  return renderWoDetail(root, STATE.view_arg);
    if (v === 'queue')     return renderApprovalQueue(root);
    if (v === 'team')      return renderTeam(root);
    if (v === 'allInv')    return renderAllInvoices(root);
    if (v === 'policy')    return renderPolicyView(root);
    if (v === 'dashboard') return renderDashboard(root);
    if (v === 'forecast')  return renderForecast(root);
    if (v === 'tracker')   return renderCostTracker(root);
    if (v === 'launch')    return renderLaunchActuals(root);
    if (v === 'admin')     return renderAdmin(root);
    if (v === 'corpcard')  return renderCorpCard(root);
    if (v === 'thirdparty') return renderThirdParty(root);
    // v0.64 — Unplanned moved into the Dashboard. Redirect any stale link there.
    if (v === 'unplanned') { STATE.view = 'dashboard'; STATE._dashSection = 'unplanned'; return renderDashboard(root); }
    // 'map' tab dropped in v0.7 — locations are now embedded in WO time-entry edit sheets.
  } catch (e) {
    root.innerHTML = alertHTML('err', '!', escapeHTML(e.message));
  }
}

// ---- HOME ----
async function renderHome(root) {
  const [actives, wos, drafts, current, notifs] = await Promise.all([
    api('/timeentries/active'),
    api('/workorders'),
    api('/invoices'),
    // v0.51 — pull the current-week draft with full summary breakdown so we
    // can show a running expected-pay total before the tech drills into the
    // invoice view.
    api('/invoices/current').catch(() => null),
    // v0.71 — active (un-dismissed) in-app notifications, e.g. invoice rejections.
    api('/notifications').catch(() => []),
  ]);
  STATE.active = actives;

  // ---- v0.71 — Rejection notifications ----
  // A rejected invoice silently reverts to draft, leaving the tech with no
  // signal their work needs fixing. Render a persistent banner per active
  // notification; it reappears on every home visit until the tech dismisses it
  // (dismissal is recorded server-side, so it sticks across reloads/devices).
  const notifBanners = (notifs || []).map(n => `
    <div class="alert err" data-notif="${n.id}"${n.invoice_id ? ` data-inv="${n.invoice_id}"` : ''}>
      <span class="ico">⚠️</span>
      <div class="body">
        <strong>${escapeHTML(n.subject || 'Invoice rejected')}</strong>
        ${n.body ? `<div style="margin-top:4px;">${escapeHTML(n.body)}</div>` : ''}
        ${n.invoice_id ? `<button class="btn btn-warn btn-sm" data-act="open-inv" style="margin-top:10px;">Open invoice →</button>` : ''}
      </div>
      <button class="close" data-act="dismiss-notif" aria-label="Dismiss notification">×</button>
    </div>
  `).join('');

  const open  = wos.filter(w => w.status === 'open' || w.status === 'in_progress');
  const draft = drafts.find(d => d.status === 'draft');

  // ---- v0.51/v0.55 — Expected pay this week ----
  // Labor hours + drive hours (both billable) × hourly rate + expenses = what
  // the tech is on track to be paid for this week's draft. Drive is broken out
  // so the tech can see how much of the paid time was drive vs labor.
  const wkRate = current?.invoice?.hourly_rate ?? STATE.user?.hourly_rate ?? 40;
  const wkSum  = current?.summary || null;
  const wkExpenses = wkSum
    ? (wkSum.mileage || 0) + (wkSum.tolls_parking || 0) + (wkSum.meals || 0) + (wkSum.tools || 0) + (wkSum.other || 0)
    : 0;
  const expectedPayCard = wkSum ? `
    <div class="card pay-card tap" id="goPayInv"
         style="background: linear-gradient(135deg, var(--ic-green-deep) 0%, var(--ic-green-dark) 100%); color:#fff; border:0;">
      <div class="flex between" style="align-items: flex-start;">
        <div>
          <div class="label" style="color:#cde9c9; letter-spacing:0.06em;">Expected pay · this week</div>
          <div style="font-size:32px; font-weight:800; line-height:1.05; margin-top:6px; letter-spacing:-0.5px;">
            ${fmt$(wkSum.total)}
          </div>
          <div style="font-size:11px; color:#cde9c9; margin-top:4px;">
            Week of ${fmtDate(current.invoice.period_start)} → ${fmtDate(current.invoice.period_end)}
            ${current.invoice.status === 'draft' ? '· running total, updates live' : `· ${labelForStatus(current.invoice.status)}`}
          </div>
        </div>
        <button class="btn btn-warn btn-sm" style="flex-shrink:0;">Open invoice →</button>
      </div>

      <div class="pay-breakdown" style="margin-top:14px; display:grid; grid-template-columns: 1fr 1fr 1fr; gap:8px 14px; font-size:12px;">
        <div>
          <div style="color:#a8d8a0; text-transform:uppercase; letter-spacing:0.06em; font-size:10px;">Labor</div>
          <div style="font-weight:700; font-size:15px; margin-top:2px;">
            ${wkSum.labor_hours.toFixed(2)} hrs
          </div>
          <div style="color:#cde9c9; margin-top:2px;">${fmt$(wkSum.labor_amount)}</div>
        </div>
        <div>
          <div style="color:#a8d8a0; text-transform:uppercase; letter-spacing:0.06em; font-size:10px;">Drive</div>
          <div style="font-weight:700; font-size:15px; margin-top:2px;">
            ${wkSum.drive_hours.toFixed(2)} hrs
          </div>
          <div style="color:#cde9c9; margin-top:2px;">${fmt$(wkSum.drive_amount || 0)}</div>
        </div>
        <div>
          <div style="color:#a8d8a0; text-transform:uppercase; letter-spacing:0.06em; font-size:10px;">Expenses</div>
          <div style="font-weight:700; font-size:15px; margin-top:2px;">
            ${fmt$(wkExpenses)}
          </div>
          <div style="color:#cde9c9; margin-top:2px;">
            ${wkSum.mileage ? `🚗 ${fmt$(wkSum.mileage)}` : ''}
            ${wkSum.tolls_parking ? ` · 🛣 ${fmt$(wkSum.tolls_parking)}` : ''}
            ${wkSum.meals ? ` · 🍴 ${fmt$(wkSum.meals)}` : ''}
            ${wkSum.tools ? ` · 🛠 ${fmt$(wkSum.tools)}` : ''}
            ${wkSum.other ? ` · ＋ ${fmt$(wkSum.other)}` : ''}
            ${!wkExpenses ? 'None yet' : ''}
          </div>
        </div>
      </div>

      <div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.15); font-size: 11px; color:#cde9c9;">
        Hourly rate: ${fmt$(wkRate)}/hr · labor + drive both billable
      </div>
    </div>
  ` : '';

  const noTimerHasOpenWos = actives.length === 0 && open.length > 0;
  const activeBlock = actives.length === 0
    ? `
      ${noTimerHasOpenWos ? `
        <div class="alert warn" style="font-size: 14px;">
          <span class="ico">⏰</span>
          <div class="body">
            <strong>You're not clocked in.</strong>
            You have ${open.length} open work order${open.length === 1 ? '' : 's'} below.
            Tap one to start tracking your time.
          </div>
          <button class="close" data-act="dismiss">×</button>
        </div>
      ` : ''}
      <div class="card flex between center">
        <div>
          <div class="label">No active timer</div>
          <div style="font-size: 13px; color: var(--ink-2);">Pick a work order to clock in.</div>
        </div>
        <button class="btn btn-primary btn-sm" id="startTimer">Clock in</button>
      </div>`
    : `
      <div class="card" style="background:var(--ic-green-deep); color:#fff; border:0;">
        <div class="flex between">
          <div>
            <div class="label" style="color:#a8d8a0;">${actives.length === 1 ? 'Active timer' : `${actives.length} active timers`}</div>
            <div style="font-size:11px; color:#cde9c9;">Tap to manage</div>
          </div>
          <button class="btn btn-warn btn-sm" id="goTimer">Open</button>
        </div>
        <div style="margin-top:10px; display: flex; flex-direction: column; gap: 6px;">
          ${actives.map((a, i) => `
            <div style="background: rgba(255,255,255,0.08); border-radius: 6px; padding: 8px 10px; display:flex; justify-content:space-between; align-items:center;">
              <div>
                <div style="font-weight:600; font-size: 13px;">${escapeHTML(a.external_id)}</div>
                <div style="font-size:11px; color:#cde9c9;">${escapeHTML(a.store_name || '')}</div>
              </div>
              <div data-elapsed="${a.clock_in}" style="font-family: 'SF Mono', Menlo, monospace; font-size: 16px; font-weight:700;">00:00:00</div>
            </div>
          `).join('')}
        </div>
      </div>`;

  root.innerHTML = `
    ${notifBanners}
    ${expectedPayCard}
    ${activeBlock}

    <div class="flex between" style="align-items: center; margin: 22px 4px 10px;">
      <div class="section-title" style="margin: 0;">Today's work orders</div>
      <div class="flex gap-12">
        <button class="btn btn-ghost btn-sm" id="mxSyncBtn" title="Pull your work orders and logged time from MaintainX">⟳ Sync MaintainX</button>
        <button class="btn btn-ghost btn-sm" id="homeUploadInvBtn" title="Upload a pre-existing invoice PDF">📄 Upload invoice</button>
        <button class="btn btn-primary btn-sm" id="newWoBtn">＋ New WO</button>
      </div>
    </div>
    ${open.length === 0
      ? `<div class="empty"><div class="big">📭</div>No open work orders assigned.<br/>Tap <strong>+ New WO</strong> above to add one from a Freshdesk or MaintainX ticket.</div>`
      : open.map(woCard).join('')}

    <div class="section-title">Drafts &amp; pending</div>
    ${draft
      ? `<div class="card tap" id="goInvoice">
           <div class="flex between"><strong>${draft.invoice_number}</strong>
             <span class="badge draft">Draft</span></div>
           <div style="font-size:12px;color:var(--muted);margin-top:4px">
             Week of ${draft.period_start} · total ${fmt$(draft.total)}
           </div>
         </div>`
      : `<div class="card" style="background:#fafafa">
           <div style="text-align:center; font-size:12px; color:var(--muted)">
             No draft invoice yet — clock in or add an expense and one is created automatically.
           </div>
         </div>`}

    ${drafts.filter(d => d.status !== 'draft').slice(0,3).map(d => `
      <div class="card tap" data-inv="${d.id}">
        <div class="flex between">
          <strong>${d.invoice_number}</strong>
          <span class="badge ${badgeForStatus(d.status)}">${labelForStatus(d.status)}</span>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">
          ${fmtDate(d.period_start)} → ${fmtDate(d.period_end)} · ${fmt$(d.total)}
        </div>
      </div>
    `).join('')}
  `;

  if (actives.length) {
    const tick = () => {
      $$('[data-elapsed]').forEach(el => {
        const start = new Date(el.dataset.elapsed).getTime();
        el.textContent = fmtElapsed(Date.now() - start);
      });
    };
    tick(); clearInterval(STATE._homeInterval); STATE._homeInterval = setInterval(tick, 1000);
    $('#goTimer')?.addEventListener('click', () => goto('timer'));
  } else {
    $('#startTimer')?.addEventListener('click', () => goto('woPick'));
  }
  $('#goInvoice')?.addEventListener('click', () => goto('invoice'));
  $('#goPayInv')?.addEventListener('click', () => {
    if (current?.invoice?.id) goto('invDetail', current.invoice.id);
    else                       goto('invoice');
  });
  $('#newWoBtn')?.addEventListener('click', () => goto('woAdd'));
  $('#mxSyncBtn')?.addEventListener('click', (e) => mxSyncAll(e.currentTarget));
  $('#homeUploadInvBtn')?.addEventListener('click', openTechUploadSheet);
  $$('.card.tap[data-inv]').forEach(c => c.addEventListener('click', () => goto('invDetail', Number(c.dataset.inv))));

  // v0.71 — Rejection banner actions: open the rejected invoice to fix &
  // resubmit, or dismiss the banner (persisted server-side so it won't return).
  $$('[data-notif]').forEach(el => {
    const id = Number(el.dataset.notif);
    el.querySelector('[data-act="open-inv"]')?.addEventListener('click', () => {
      if (el.dataset.inv) goto('invDetail', Number(el.dataset.inv));
    });
    el.querySelector('[data-act="dismiss-notif"]')?.addEventListener('click', async () => {
      el.classList.add('dismissed');           // fade out via .alert.dismissed
      setTimeout(() => el.remove(), 250);
      try { await api(`/notifications/${id}/dismiss`, { method: 'POST' }); }
      catch (_) { /* best-effort — if it failed it simply reappears next load */ }
    });
  });

  // Periodic gentle reminder if the user is using the app but isn't clocked in
  // on any work order. Shows once per visit to home; toast nudge every 10 min.
  if (actives.length === 0 && open.length > 0) startClockInNudge(open.length);
  else stopClockInNudge();
}

let _clockInNudgeTimer = null;
function startClockInNudge(openCount) {
  stopClockInNudge();
  // First nudge after 60s, then every 10 min while still no active timer.
  const nudge = async () => {
    try {
      const a = await api('/timeentries/active');
      if (a.length > 0) return stopClockInNudge();
      toast(`⏰ Heads up — you're not clocked in. ${openCount} open WO${openCount === 1 ? '' : 's'} ready.`);
    } catch {}
  };
  _clockInNudgeTimer = setTimeout(function loop() {
    nudge();
    _clockInNudgeTimer = setTimeout(loop, 10 * 60 * 1000);
  }, 60 * 1000);
}
function stopClockInNudge() {
  if (_clockInNudgeTimer) clearTimeout(_clockInNudgeTimer);
  _clockInNudgeTimer = null;
}

// Compact card used on home/lists. ID is the primary heading; title is the
// secondary description line. Invoice and detail screens still surface both.
function woCard(w) {
  const title = w.title || w.description || w.store_name || '';
  const ticketLabel = sourceLabel(w.source_system) + ' #' + (w.source_ticket_id || sourceTicketId(w.external_id));
  return `
    <div class="card tap" data-wo="${w.id}" data-act="open-wo" style="padding: 16px;">
      <div class="flex between" style="gap: 12px; align-items: center;">
        <div style="flex: 1; min-width: 0;">
          <div class="wo-id" style="margin-bottom: 4px;">${escapeHTML(ticketLabel)}</div>
          ${title ? `<div style="font-size: 14px; color: var(--ink-2); line-height: 1.4; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">${escapeHTML(title)}</div>` : ''}
          <div style="font-size: 11px; color: var(--muted); margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">
            ${workTypeLabel(w.work_type)}${w.cart_count ? ` · ${w.cart_count} carts` : ''}${w.store_name ? ' · ' + escapeHTML(w.store_name) : ''}
          </div>
        </div>
        <div style="color: var(--muted); font-size: 22px; flex-shrink: 0;">›</div>
      </div>
    </div>
  `;
}

// Strip the source/type prefix off our canonical external_id to recover the
// source-system ticket number.  "MX-RPR-97461873" → "97461873"
function sourceTicketId(externalId) {
  if (!externalId) return '';
  const m = externalId.match(/^(MX|FD)-(DPL|RTR|SVC|MNT|RPR)-(.+)$/i);
  return m ? m[3] : externalId;
}

// Click handler for any woCard rendered on home or picker
document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-act="open-wo"]');
  if (!card) return;
  // Ignore if the inner pick path needs to clock in instead — woPick wires its own listener
  if (STATE.view === 'woPick') return;
  goto('woDetail', Number(card.dataset.wo));
});

function labelForWoStatus(s) {
  return ({ in_progress: 'In progress', open: 'Open', completed: 'Done', cancelled: 'Cancelled' }[s] || s);
}
function labelForStatus(s) {
  // Single source of truth for invoice-status labels — used everywhere so the
  // same state never shows a different (or raw enum) label across screens.
  return ({
    draft: 'Draft', submitted: 'Pending Ops Mgr', in_review: 'In review',
    approved_ops: 'Ops approved · ready for AP', approved_sr: 'Sr Mgr approved · ready for AP',
    queued_ap: 'Queued for AP', sent_ap: 'Sent to AP', paid: 'Paid',
    rejected: 'Rejected', cancelled: 'Cancelled',
  }[s] || (s ? String(s).replace(/_/g, ' ') : ''));
}
// v0.67 — Viewer-aware status label. Ops Managers should never see the
// Senior-Manager stage surfaced as its own status: an escalated invoice that a
// Sr Mgr countersigned (approved_sr) reads simply as "Approved · ready for AP"
// in the Ops Mgr's table. Every other role/status falls back to labelForStatus.
function labelForStatusViewer(s, role) {
  if (role === 'ops_manager' && s === 'approved_sr') return 'Approved · ready for AP';
  return labelForStatus(s);
}
// Human-readable role labels (never surface raw role enums like "ops_manager").
function roleLabel(r) {
  return ({ technician: 'Technician', ops_manager: 'Ops Manager',
    sr_manager: 'Sr Manager', pm: 'PM' }[r] || (r ? String(r).replace(/_/g, ' ') : ''));
}
// v0.67 — An invoice is cleared for the technician to send to AP once approval
// is complete: ops-approved in the normal flow, or Sr Mgr-countersigned on an
// escalated invoice. An escalated invoice still awaiting its Sr Mgr second look
// (approved_ops + escalated_at) is NOT yet sendable. Mirrors trailFor().
function readyToSendToAp(inv) {
  if (!inv || inv.status === 'sent_ap') return false;
  return inv.status === 'queued_ap'
      || inv.status === 'approved_sr'
      || (inv.status === 'approved_ops' && !inv.escalated_at);
}
function badgeForStatus(s) {
  if (s === 'sent_ap') return 'paid';   // reuse 'paid' badge styling for terminal state
  if (s === 'rejected') return 'flagged';
  if (['draft'].includes(s)) return 'draft';
  if (['approved_ops','approved_sr','sent_ap','queued_ap'].includes(s)) return 'approved';
  return 'pending';
}

// ---- WO DETAIL ----
async function renderWoDetail(root, woId) {
  if (!woId) return goto('home');
  const w = await api(`/workorders/${woId}`);

  const total = (w.expenses || []).reduce((s, e) => s + e.amount, 0);
  const totalHours = (w.time_entries || []).reduce((s, t) => {
    const ms = (t.clock_out ? new Date(t.clock_out) : new Date()) - new Date(t.clock_in);
    return s + Math.max(0, (ms - (t.break_minutes || 0) * 60000) / 3600000);
  }, 0);

  const ticketLabel = sourceLabel(w.source_system) + ' #' + (w.source_ticket_id || sourceTicketId(w.external_id));
  root.innerHTML = `
    <div class="card">
      <div class="flex between" style="margin-bottom: 8px; align-items: flex-start;">
        <div style="flex: 1; min-width: 0;">
          <div class="wo-id" style="font-size:20px;">${escapeHTML(ticketLabel)}</div>
          <div style="font-size: 11px; color: var(--muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px;">${workTypeLabel(w.work_type)}</div>
        </div>
        <span class="badge ${w.status === 'in_progress' ? 'pending' : (w.status === 'completed' ? 'approved' : 'gray')}">${labelForWoStatus(w.status)}</span>
      </div>
      ${w.title ? `<div style="font-size: 15px; color: var(--ink-2); margin-top: 6px; line-height: 1.4;">${escapeHTML(w.title)}</div>` : ''}
      ${w.store_name ? `<div style="font-size: 14px; font-weight: 600; margin-top: 10px;">${escapeHTML(w.store_name)}</div>` : ''}
      ${w.store_id ? `<div class="meta">Store #${escapeHTML(w.store_id)}</div>` : ''}
      ${w.store_address ? `<div class="meta">${escapeHTML(w.store_address)}</div>` : ''}
      <div class="card-row" style="margin-top: 10px;">
        <span>Carts</span><span class="amt">${w.cart_count || 0}</span>
      </div>
      ${w.scheduled_date ? `<div class="card-row"><span>Scheduled</span><span>${fmtDate(w.scheduled_date)}</span></div>` : ''}
      <div class="card-row"><span>Local reference</span><span class="amt" style="font-family: 'SF Mono', Menlo, monospace; font-size: 11px; color: var(--muted);">${escapeHTML(w.external_id)}</span></div>
      ${w.description ? `<div style="margin-top: 10px; padding: 10px 12px; background: #fafafa; border-radius: 8px; font-size: 14px; line-height: 1.5; white-space: pre-wrap;">${escapeHTML(w.description)}</div>` : ''}
    </div>

    ${['ops_manager','sr_manager','pm'].includes(STATE.user?.role) ? `
    <div class="section-title">Unplanned Work</div>
    <div class="card" style="padding:12px 14px;">
      <div class="flex between" style="align-items:center;">
        <div>
          <div style="font-size:13px;font-weight:600;">Tag this entire work order as unplanned</div>
          <div style="font-size:12px;color:var(--muted);">Flags the WO for leadership reporting on wasted/unplanned costs.</div>
        </div>
        <div id="woLevelTagBtn">${renderUnplannedTagBtn('work_order', w.id, w.unplanned_tag, w.unplanned_note, null)}</div>
      </div>
      ${w.unplanned_note ? `<div style="margin-top:8px;font-size:12px;color:var(--muted);font-style:italic;">${escapeHTML(w.unplanned_note)}</div>` : ''}
    </div>` : ''}

    <div class="section-title">Status</div>
    <div class="card">
      <p class="help" style="margin: 0 0 10px;">Update the work-order status as you progress through the job.</p>
      <div class="chips" id="statusChips" style="margin-bottom: 0;">
        ${['open','in_progress','completed','cancelled'].map(s => `
          <span class="chip ${w.status === s ? 'selected' : ''}" data-status="${s}">${labelForWoStatus(s)}</span>
        `).join('')}
      </div>
    </div>

    ${w.source_system === 'maintainx' ? `
    <div class="section-title">MaintainX</div>
    <div class="card">
      <div class="flex between" style="align-items:center; gap:12px;">
        <div style="min-width:0;">
          <div style="font-size:13px;font-weight:600;">Synced from MaintainX</div>
          <div style="font-size:12px;color:var(--muted);">Pull the latest status and import the time you logged in MaintainX as labor. Your own logged time is never overwritten.</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="mxSyncOneBtn" style="white-space:nowrap;">⟳ Sync</button>
      </div>
    </div>` : ''}

    ${w.summary && (w.summary.work_hours || w.summary.drive_hours || w.summary.distance_miles) ? `
      <div class="section-title">Shift summary</div>
      <div class="card">
        <div class="flex between" style="gap: 14px; flex-wrap: wrap;">
          <div style="flex:1; min-width: 100px;">
            <div class="label">Work time</div>
            <div style="font-size: 22px; font-weight: 700; color: var(--ic-green-deep);">${(w.summary.work_hours || 0).toFixed(2)} <span style="font-size:13px; color: var(--muted);">hrs</span></div>
          </div>
          <div style="flex:1; min-width: 100px;">
            <div class="label">Drive time</div>
            <div style="font-size: 22px; font-weight: 700; color: var(--ic-orange);">${(w.summary.drive_hours || 0).toFixed(2)} <span style="font-size:13px; color: var(--muted);">hrs</span></div>
          </div>
          <div style="flex:1; min-width: 100px;">
            <div class="label">Distance</div>
            <div style="font-size: 22px; font-weight: 700;">${(w.summary.distance_miles || 0).toFixed(2)} <span style="font-size:13px; color: var(--muted);">mi</span></div>
          </div>
        </div>
      </div>

      <div id="woDetailMap" style="height: 240px; border-radius: var(--radius-md); border: 1px solid var(--line); margin-bottom: 6px; overflow: hidden;"></div>
      <div id="woDetailMap-dist" style="font-size: 13px; color: var(--ink-2); text-align: center; padding: 4px 0 14px;"></div>
    ` : ''}

    <div class="section-title">Time entries (${(w.time_entries || []).length})</div>
    ${w.time_entries.length === 0
      ? `<div class="card" style="background:#fafafa; text-align:center; color: var(--muted); font-size: 13px;">No time logged yet for this WO.</div>`
      : w.time_entries.map(t => {
          const dur = t.clock_out ? ((new Date(t.clock_out) - new Date(t.clock_in)) / 3600000).toFixed(2) : '—';
          const isDrive = (t.mode || 'work') === 'drive';
          return `
            <div class="card" style="padding: 14px;">
              <div class="flex between">
                <div>
                  <span class="badge ${isDrive ? 'pending' : 'approved'}">${isDrive ? '🚗 Drive' : '🛠 Work'}</span>${(t.source === 'maintainx_sync') ? '<span class="badge gray" style="margin-left:6px;">MaintainX</span>' : ''}
                  <strong style="margin-left: 8px;">${new Date(t.clock_in).toLocaleDateString()}</strong>${t.tech_name ? `<span class="meta"> · ${escapeHTML(t.tech_name)}</span>` : ''}
                  <div class="meta">${new Date(t.clock_in).toLocaleTimeString()} → ${t.clock_out ? new Date(t.clock_out).toLocaleTimeString() : 'running'}</div>
                </div>
                <div class="amt"><strong>${dur} hr${dur === '1.00' ? '' : 's'}</strong></div>
              </div>
              ${t.gps_lat_in  ? gpsChip(t.gps_lat_in,  t.gps_lng_in,  t.gps_accuracy_in,  'Clocked in')  : ''}
              ${t.gps_lat_out ? gpsChip(t.gps_lat_out, t.gps_lng_out, t.gps_accuracy_out, 'Clocked out') : ''}
              ${['ops_manager','sr_manager','pm'].includes(STATE.user?.role)
                ? `<div style="margin-top:8px;">${renderUnplannedTagBtn('time_entry', t.id, t.unplanned_tag, t.unplanned_note, null)}</div>${unplannedNoteLine(t.unplanned_tag, t.unplanned_note)}` : ''}
            </div>
          `;
        }).join('')}

    <div class="section-title">Expenses (${(w.expenses || []).length} · ${fmt$(total)})</div>
    ${w.expenses.length === 0
      ? `<div class="card" style="background:#fafafa; text-align:center; color: var(--muted); font-size: 13px;">No expenses on this WO yet.</div>`
      : w.expenses.map(e => `
          <div class="card" style="padding: 12px 14px;">
            <div class="flex between">
              <div>
                <strong>${capitalize(e.category)}${e.subcategory ? ' · ' + escapeHTML(e.subcategory) : ''}</strong>
                <div class="meta">${fmtDate(e.expense_date)}${e.description ? ' · ' + escapeHTML(e.description) : ''}${e.tech_name ? ' · ' + escapeHTML(e.tech_name) : ''}</div>
              </div>
              <div class="amt"><strong>${fmt$(e.amount)}</strong></div>
            </div>
            ${['ops_manager','sr_manager','pm'].includes(STATE.user?.role)
              ? `<div style="margin-top:8px;">${renderUnplannedTagBtn('expense', e.id, e.unplanned_tag, e.unplanned_note, e.amount, e.unplanned_wasted)}</div>${unplannedNoteLine(e.unplanned_tag, e.unplanned_note)}${unplannedSplitLine(e.unplanned_tag, e.unplanned_wasted, e.amount)}` : ''}
          </div>
        `).join('')}

    <div class="section-title">Attachments (${(w.attachments || []).length})</div>
    <div class="card" style="padding: 14px;">
      ${w.attachments.length
        ? `<div class="attach-list">${w.attachments.map(a => attachmentItemHTML(a, { canDelete: false })).join('')}</div>`
        : `<div class="attach-empty">No receipts on this WO yet.</div>`}
    </div>

    <div class="actions" style="margin-top: 18px;">
      <button class="btn btn-ghost" id="clockToWO">Clock in</button>
      <button class="btn btn-primary" id="addExpToWO">Add expense</button>
    </div>
  `;

  // v0.63 — wire unplanned tag buttons (WO-level + per time-entry + per expense)
  wireUnplannedTagBtns(root, () => renderWoDetail(root, woId));

  $$('#statusChips .chip').forEach(c => c.addEventListener('click', async () => {
    const newStatus = c.dataset.status;
    if (newStatus === w.status) return;
    try {
      await api(`/workorders/${w.id}`, { method: 'PATCH', body: { status: newStatus } });
      toast(`Status set to ${labelForWoStatus(newStatus)} ✓`, 'ok');
      goto('woDetail', w.id);
    } catch (e) { toast(e.message, 'err'); }
  }));
  $('#mxSyncOneBtn')?.addEventListener('click', (e) => mxSyncOne(w.id, e.currentTarget));
  $('#clockToWO').addEventListener('click', () => clockIn(w.id));
  $('#addExpToWO').addEventListener('click', () => {
    STATE._prefillWO = w.id;
    goto('add');
  });

  // Render the shift map if there's GPS data on the WO
  if (entriesHaveGps(w.time_entries) && document.getElementById('woDetailMap')) {
    drawWoMap('woDetailMap', w.time_entries);
  }
}

// ---- WO PICKER ----
async function renderWoPick(root) {
  const wos = await api('/workorders');
  const open  = wos.filter(w => ['open','in_progress'].includes(w.status));
  $('#hdrTitle').textContent = 'Pick Work Order';
  root.innerHTML = `
    <input class="field" id="woSearch" placeholder="Search by ID, store, or keyword…" />
    <div class="help">ID prefix tells you the source (MX = MaintainX, FD = Freshdesk) and work type (DPL/RTR/MNT/RPR).</div>

    <button class="btn btn-ghost btn-block" id="addWoBtn" style="margin-bottom:14px;">
      ＋ Add a Freshdesk or MaintainX ticket
    </button>

    <div id="woList">
      ${open.length === 0
        ? `<div class="empty"><div class="big">📭</div>No open work orders.<br/>Tap above to paste a ticket from Freshdesk or MaintainX.</div>`
        : open.map(woCard).join('')}
    </div>
  `;
  $('#addWoBtn').addEventListener('click', () => goto('woAdd'));
  $('#woSearch').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    const filtered = open.filter(w =>
      (w.external_id + ' ' + w.store_name + ' ' + (w.description || '') + ' ' + w.work_type).toLowerCase().includes(q)
    );
    $('#woList').innerHTML = filtered.length
      ? filtered.map(woCard).join('')
      : `<div class="empty">No matches.</div>`;
    bindWoCards();
  });
  bindWoCards();

  function bindWoCards() {
    $$('.card.tap[data-wo]').forEach(c => c.addEventListener('click', () => clockIn(Number(c.dataset.wo))));
  }
}

// ---- WO ADD (tech-side) ----
async function renderWoAdd(root) {
  // v0.62 — pull the live work-type list so admin-added types show up here.
  // Fallback to the four originals if the endpoint is unreachable so the
  // form still works offline / on broken auth.
  const activeWtRows = await api('/work-types').catch(() => []);
  const ACTIVE_WTS = activeWtRows.length
    ? activeWtRows.map(w => w.name)
    : ['deployment','retrofit','maintenance','repair'];

  let form = {
    source_system: 'maintainx',
    work_type: ACTIVE_WTS.includes('retrofit') ? 'retrofit' : ACTIVE_WTS[0],
    ticket_id: '',
    title: '',
    store_name: '',
    store_id: '',
    store_address: '',
    cart_count: '',
    scheduled_date: todayISO(),
    description: '',
    pasted_url: '',
    _stub: false,
    _raw: null,
  };

  function html() {
    return `
      <div class="alert info">
        <span class="ico">ⓘ</span>
        <div class="body">Use this when you have a ticket from Freshdesk or MaintainX that hasn't synced into the app yet. Paste the URL and we'll auto-fill the rest.</div>
        <button class="close" data-act="dismiss">×</button>
      </div>

      <span class="label">Paste ticket URL (recommended)</span>
      <div class="flex gap-8" style="margin-bottom: 12px;">
        <input class="field" id="pastedUrl" placeholder="https://acme.maintainx.com/work-orders/12345" value="${esc(form.pasted_url)}" style="margin-bottom:0; flex:1;" />
        <button class="btn btn-primary btn-sm" id="pullBtn">Pull</button>
      </div>
      ${form._stub ? alertHTML('warn','⚠','Auto-filled from a <strong>stub</strong> (dev mode — no real Freshdesk/MaintainX API connected yet). Confirm details below before saving.') : ''}
      ${form._existing ? `
        <div class="card" style="border-left: 4px solid var(--ic-orange); background: #fff8f0; padding: 12px 14px; margin-bottom: 14px;">
          <strong style="color: var(--warn-fg);">⚠ This work order already exists locally</strong>
          <div class="meta" style="margin-top: 4px;">
            ${escapeHTML(form._existing.external_id)} · ${escapeHTML(form._existing.store_name || '')} · status: ${escapeHTML(form._existing.status)}
          </div>
          ${form._discrepancies.length === 0
            ? `<div style="margin-top: 8px; font-size: 13px; color: var(--ok-fg);">✓ All pulled values match the local record.</div>`
            : `<div style="margin-top: 8px; font-size: 13px; font-weight: 600;">${form._discrepancies.length} field(s) differ between API and local:</div>
               <table style="width:100%; border-collapse: collapse; font-size: 12px; margin-top: 8px;">
                 <thead>
                   <tr style="border-bottom: 1px solid var(--line);">
                     <th style="text-align:left; padding:6px 4px; font-size:10px; color:var(--muted); text-transform:uppercase;">Field</th>
                     <th style="text-align:left; padding:6px 4px; font-size:10px; color:var(--muted); text-transform:uppercase;">Local now</th>
                     <th style="text-align:left; padding:6px 4px; font-size:10px; color:var(--muted); text-transform:uppercase;">From API</th>
                   </tr>
                 </thead>
                 <tbody>
                   ${form._discrepancies.map(d => `
                     <tr style="border-bottom: 1px solid #f4f4f4;">
                       <td style="padding:6px 4px; font-weight:600;">${escapeHTML(d.label)}</td>
                       <td style="padding:6px 4px; color: var(--ink-2);">${escapeHTML(String(d.existing ?? '—'))}</td>
                       <td style="padding:6px 4px; color: var(--ic-green-deep); font-weight:600;">${escapeHTML(String(d.pulled ?? '—'))}</td>
                     </tr>`).join('')}
                 </tbody>
               </table>`}
          <div class="actions" style="margin-top: 10px;">
            <button class="btn btn-ghost btn-sm" data-act="open-existing" data-id="${form._existing.id}">Open existing WO</button>
            ${form._discrepancies.length > 0 ? `<button class="btn btn-warn btn-sm" data-act="apply-pulled">Apply API values</button>` : ''}
          </div>
        </div>
      ` : ''}

      ${form._raw && !form._stub && DEBUG_INTEGRATIONS ? (() => {
          const allKeys = form._raw._all_field_keys || [];
          const cfKeys  = form._raw._custom_field_keys || [];
          const efNames = form._raw._extra_field_names || [];
          return `
        <details class="card" style="padding: 12px 14px; margin-bottom: 14px; background: #fafafa;">
          <summary style="cursor: pointer; font-weight: 600; font-size: 13px; color: var(--muted);">
            🔍 Debug: raw ticket data (${allKeys.length} fields)
          </summary>
          <pre style="background: #fff; padding: 10px 12px; border-radius: 8px; font-size: 11px; line-height: 1.4; overflow-x: auto; white-space: pre-wrap; word-break: break-word; border: 1px solid var(--line); margin: 10px 0 0; max-height: 360px; overflow-y: auto;">${escapeHTML(JSON.stringify(form._raw, null, 2))}</pre>
        </details>
      `; })() : ''}

      <div class="section-title">Or fill it in manually</div>

      <span class="label">Source system</span>
      <div class="chips">
        <span class="chip ${form.source_system==='maintainx'?'selected':''}" data-src="maintainx">MaintainX</span>
        <span class="chip ${form.source_system==='freshdesk'?'selected':''}" data-src="freshdesk">Freshdesk</span>
      </div>

      <span class="label">
        Work type
        ${form.work_type_source ? `<span style="font-weight: 400; color: var(--ok-fg); margin-left: 8px;">✓ from ${escapeHTML(form.work_type_source)}</span>` : ''}
        ${form.work_type_unresolved ? `<span style="font-weight: 400; color: var(--ic-orange); margin-left: 8px;">⚠ couldn't auto-determine — pick one</span>` : ''}
      </span>
      <div class="chips">
        ${ACTIVE_WTS.map(wt => `
          <span class="chip ${form.work_type === wt ? 'selected' : ''}" data-wt="${escapeHTML(wt)}">${escapeHTML(workTypeLabel(wt))}</span>
        `).join('')}
      </div>

      <span class="label">Ticket / Work Order #</span>
      <input class="field" id="ticket" placeholder="e.g. 12345 or WO-2406-127" value="${esc(form.ticket_id)}" />
      <div class="help">Stored as ${prefixPreview()}<code>{ticket}</code>. Display will show <code>${form.source_system === 'maintainx' ? 'MaintainX' : 'Freshdesk'} #{ticket}</code>.</div>

      <span class="label">Title (from ${form.source_system === 'maintainx' ? 'MaintainX' : 'Freshdesk'})</span>
      <input class="field" id="title" placeholder="e.g. Queens 4 - Cart #5 Not Powering On" value="${esc(form.title)}" />
      <div class="help">Auto-filled from the ticket title; edit if needed.</div>

      <span class="label">Store</span>
      <input class="field" id="store" placeholder="e.g. Whole Foods Edgewater" value="${esc(form.store_name)}" />

      <div class="flex gap-12">
        <div style="flex:1">
          <span class="label">Store # / ID</span>
          <input class="field" id="storeId" placeholder="e.g. WF-EDG or 1234" value="${esc(form.store_id)}" />
        </div>
        <div style="flex:1.4">
          <span class="label">Address (optional)</span>
          <input class="field" id="storeAddr" placeholder="123 Main St, Edgewater NJ" value="${esc(form.store_address)}" />
        </div>
      </div>

      <div class="flex gap-12">
        <div style="flex:1">
          <span class="label">Carts</span>
          <input class="field" id="carts" type="number" min="1" placeholder="12" value="${form.cart_count}" />
        </div>
        <div style="flex:1.4">
          <span class="label">Scheduled date</span>
          <input class="field" id="sched" type="date" value="${form.scheduled_date}" />
        </div>
      </div>

      <span class="label">Description</span>
      <textarea class="field" id="desc" rows="3" placeholder="e.g. Replace shelf brackets and recalibrate scanners on 12 carts">${esc(form.description)}</textarea>

      <div class="actions">
        <button class="btn btn-ghost" id="cancelBtn">Cancel</button>
        <button class="btn btn-primary" id="saveBtn">Add &amp; pick</button>
      </div>
    `;
  }
  function prefixPreview() {
    const src = form.source_system === 'maintainx' ? 'MX' : 'FD';
    const typ = ({ deployment:'DPL', retrofit:'RTR', maintenance:'MNT', repair:'RPR' })[form.work_type];
    return `<code>${src}-${typ}-</code>`;
  }
  function esc(s) { return (s || '').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

  function rerender() { root.innerHTML = html(); bind(); }

  function bind() {
    $$('.chip[data-src]').forEach(c => c.addEventListener('click', () => { form.source_system = c.dataset.src; rerender(); }));
    $$('.chip[data-wt]').forEach(c =>  c.addEventListener('click', () => { form.work_type = c.dataset.wt; rerender(); }));
    $$('[data-act="open-existing"]').forEach(b => b.addEventListener('click', () => goto('woDetail', Number(b.dataset.id))));
    $$('[data-act="apply-pulled"]').forEach(b => b.addEventListener('click', async () => {
      // PATCH the existing WO with the freshly-pulled values
      try {
        await api(`/workorders/${form._existing.id}`, { method: 'PATCH', body: {
          store_name: form.store_name || undefined,
          store_id:   form.store_id   || undefined,
          store_address: form.store_address || undefined,
          cart_count: form.cart_count ? Number(form.cart_count) : undefined,
          scheduled_date: form.scheduled_date || undefined,
          description:    form.description    || undefined,
        }});
        toast('Existing WO updated with API values ✓', 'ok');
        goto('woDetail', form._existing.id);
      } catch (e) { toast(e.message, 'err'); }
    }));

    $('#pullBtn').addEventListener('click', async () => {
      const url = $('#pastedUrl').value.trim();
      if (!url) return toast('Paste a Freshdesk or MaintainX URL first', 'err');
      try {
        toast('Looking up ticket…');
        const r = await api('/workorders/parse-url', { method: 'POST', body: { url } });
        // Compose a description: prefer the ticket body; if a separate subject came back, prepend it.
        let composedDesc = r.description || form.description || '';
        if (r.subject && r.subject !== composedDesc) {
          composedDesc = `${r.subject}\n\n${composedDesc}`.trim();
        }
        // v0.30 — work_type is null when no configured integration field
        // mapped. We do NOT fall back to a guess; the user must pick before save.
        form = {
          ...form,
          source_system: r.source_system,
          work_type: r.work_type,                       // may be null
          work_type_source: r.work_type_source || null, // provenance for the badge
          work_type_unresolved: !!r.work_type_unresolved,
          ticket_id: r.ticket_id,
          title:      r.subject || (r._raw && r._raw.title) || form.title || '',
          store_name: r.store_name || form.store_name,
          store_id:   r.store_id   || form.store_id || '',
          store_address: r.store_address || form.store_address || '',
          cart_count: r.cart_count || form.cart_count,
          scheduled_date: r.scheduled_date || form.scheduled_date,
          description: composedDesc,
          pasted_url: url,
          _stub: !!r._stub,
          _raw: r._raw || null,
          _existing: r._existing || null,
          _discrepancies: r._discrepancies || [],
        };
        if (r._stub) {
          toast('⚠ Filled with stub data — no API key configured. Save your MaintainX/Freshdesk key in Settings → Integrations.', 'err');
        } else {
          toast(`Pulled from ${r.source_system} ✓`, 'ok');
        }
        rerender();
      } catch (e) { toast(e.message, 'err'); }
    });

    const grab = () => {
      form.ticket_id      = $('#ticket').value.trim();
      form.title          = $('#title')?.value.trim() || '';
      form.store_name     = $('#store').value.trim();
      form.store_id       = $('#storeId')?.value.trim() || '';
      form.store_address  = $('#storeAddr')?.value.trim() || '';
      form.cart_count     = $('#carts').value;
      form.scheduled_date = $('#sched').value;
      form.description    = $('#desc').value;
    };

    $('#cancelBtn').addEventListener('click', () => goto('woPick'));
    $('#saveBtn').addEventListener('click', async () => {
      grab();
      if (!form.ticket_id)  return toast('Enter the ticket / work order number', 'err');
      if (!form.store_name) return toast('Enter the store name', 'err');
      if (!form.work_type)  return toast('Pick a work type before saving', 'err');
      try {
        const wo = await api('/workorders', { method: 'POST', body: form });
        toast(`Added ${wo.external_id} ✓`, 'ok');
        if (confirm(`Clock in to ${wo.external_id} now?`)) {
          await clockIn(wo.id);
        } else {
          goto('woDetail', wo.id);
        }
      } catch (e) {
        // Friendly handling if the WO already exists
        if (e.data && e.data.existing) {
          if (confirm(`Work order ${e.data.existing.external_id} already exists${e.data.existing.store_name ? ' (' + e.data.existing.store_name + ')' : ''}. Open it?`)) {
            return goto('woDetail', e.data.existing.id);
          }
          return;
        }
        toast(e.message, 'err');
      }
    });
  }

  root.innerHTML = html();
  bind();
}

async function clockIn(work_order_id) {
  // Ask the tech: drive or work? Then capture GPS and start the timer.
  showSheet(`
    <h3 style="margin: 0 0 6px;">What are you starting?</h3>
    <p class="help" style="margin: 0 0 14px;">Pick the right mode so drive time and work time get tracked separately.</p>
    <button class="btn btn-block" id="modeWork" style="background: var(--ic-green); color: #fff; margin-bottom: 10px; padding: 18px; font-size: 16px;">
      🛠 &nbsp; Start <strong>Work time</strong>
      <div style="font-weight: 400; opacity: 0.85; font-size: 12px; margin-top: 4px;">On-site at the store, billable as labor</div>
    </button>
    <button class="btn btn-block" id="modeDrive" style="background: var(--ic-orange); color: #fff; padding: 18px; font-size: 16px;">
      🚗 &nbsp; Start <strong>Drive time</strong>
      <div style="font-weight: 400; opacity: 0.85; font-size: 12px; margin-top: 4px;">In transit; tracked separately for mileage / ops visibility</div>
    </button>
    <button class="btn btn-ghost btn-block" data-act="sheet-close" style="margin-top: 12px;">Cancel</button>
  `, {
    onMount: (wrap) => {
      $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);
      const start = async (mode) => {
        closeSheet();
        toast('Getting your location…');
        const gps = await getGPS();
        try {
          await api('/timeentries', { method: 'POST', body: { work_order_id, mode, gps } });
          toast(gps ? `Clocked in · ${mode === 'drive' ? 'drive' : 'work'} · location captured ✓` : `Clocked in (no GPS) ✓`, 'ok');
          goto('timer');
        } catch (e) { toast(e.message, 'err'); }
      };
      $('#modeWork',  wrap).addEventListener('click', () => start('work'));
      $('#modeDrive', wrap).addEventListener('click', () => start('drive'));
    },
  });
}

// ---- TIMER ----
let _timerInterval;
async function renderTimer(root) {
  const actives = await api('/timeentries/active');
  STATE.active = actives;
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }

  if (!actives.length) {
    root.innerHTML = `
      <div class="empty"><div class="big">⏱</div>No active timer.<br/>Pick a work order to clock in, or log a past shift manually.</div>
      <button class="btn btn-primary btn-block" id="pick">Pick a work order</button>
      <button class="btn btn-ghost btn-block" id="manual" style="margin-top:8px;">＋ Log a past shift</button>
    `;
    $('#pick').addEventListener('click', () => goto('woPick'));
    $('#manual').addEventListener('click', openManualTimeSheet);
    return;
  }

  const expectedFor = (a) => ({deployment:0.7, retrofit:0.7, maintenance:2.4, repair:1.5}[a.work_type] || 1) * (a.cart_count || 1);

  // Per-timer break tally (resets each render)
  const breakMins = {};

  root.innerHTML = `
    ${actives.length > 1 ? alertHTML('info', 'ⓘ', `<strong>${actives.length} concurrent timers running.</strong> Each tracks independently — clock out individually when each job is done.`) : ''}
    ${actives.map(a => {
      const expected = expectedFor(a);
      const mode = a.mode || 'work';
      const isDrive = mode === 'drive';
      breakMins[a.id] = a.break_minutes || 0;
      return `
        <div class="card">
          <div class="flex between" style="margin-bottom:10px;">
            <div>
              <div class="wo-id">${escapeHTML(a.external_id)}</div>
              <div class="wo-source">${sourceLabel(a.source_system)} · ${workTypeLabel(a.work_type)}</div>
              <div style="font-size:12px; margin-top:4px;">${escapeHTML(a.store_name || '')} · ${a.cart_count} carts</div>
            </div>
            <span class="badge ${isDrive ? 'pending' : 'approved'}">Running</span>
          </div>
          <div class="timer">
            <div class="mode-badge ${mode}">${isDrive ? '🚗 Drive time' : '🛠 Work time'}</div>
            <div class="since">CLOCKED IN AT ${new Date(a.clock_in).toLocaleTimeString()}</div>
            <div class="clock" data-clock="${a.id}" data-start="${a.clock_in}">00:00:00</div>
            <div class="wo">${isDrive ? 'Drive time — billable, tracked separately from labor' : `Expected ${expected.toFixed(1)} hrs · flag if > ${(expected * 1.5).toFixed(1)} hrs`}</div>
          </div>
          ${gpsChip(a.gps_lat_in, a.gps_lng_in, a.gps_accuracy_in, 'Clock-in location')}
          <div class="actions">
            <button class="btn btn-ghost btn-sm" data-act="break" data-tid="${a.id}">+30 min break</button>
            <button class="btn btn-${isDrive ? 'primary' : 'warn'} btn-sm" data-act="switch" data-tid="${a.id}">${isDrive ? '🛠 Switch to Work' : '🚗 Switch to Drive'}</button>
            <button class="btn btn-warn" data-act="clockout" data-tid="${a.id}">Clock Out</button>
          </div>
        </div>
      `;
    }).join('')}

    <button class="btn btn-primary btn-block" id="addAnother">＋ Clock in to another work order</button>
    <button class="btn btn-ghost btn-block" id="manualBtn" style="margin-top:8px;">＋ Log a past shift</button>

    <div class="alert info" style="margin-top:14px;">
      <span class="ico">ⓘ</span>
      <div class="body">Hours auto-flow into your current-week invoice when you clock out. We'll capture your location at clock-out for the audit trail.</div>
      <button class="close" data-act="dismiss">×</button>
    </div>
  `;

  const tick = () => {
    $$('[data-clock]').forEach(el => {
      const start = new Date(el.dataset.start).getTime();
      const id = el.dataset.clock;
      el.textContent = fmtElapsed(Date.now() - start - (breakMins[id] || 0) * 60000);
    });
  };
  tick(); _timerInterval = setInterval(tick, 1000);

  $('#addAnother').addEventListener('click', () => goto('woPick'));
  $('#manualBtn')?.addEventListener('click', openManualTimeSheet);
  $$('[data-act="break"]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.tid;
    breakMins[id] = (breakMins[id] || 0) + 30;
    // v0.65.1 (F-M8) — persist immediately (timer keeps running) so the break
    // isn't silently lost on navigation / re-render.
    try { await api(`/timeentries/${id}`, { method: 'PATCH', body: { break_minutes: breakMins[id], break_only: true } }); }
    catch (e) { breakMins[id] -= 30; toast(e.message, 'err'); return; }
    toast(`Break time +30 min (total ${breakMins[id]})`);
  }));
  $$('[data-act="clockout"]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.tid;
    toast('Getting your location…');
    const gps = await getGPS();
    try {
      await api(`/timeentries/${id}`, { method: 'PATCH', body: { break_minutes: breakMins[id] || 0, gps } });
      toast(gps ? 'Clocked out · location captured ✓' : 'Clocked out (no GPS) ✓', 'ok');
      goto('timer');
    } catch (e) { toast(e.message, 'err'); }
  }));
  $$('[data-act="switch"]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.tid;
    toast('Getting your location…');
    const gps = await getGPS();
    try {
      const r = await api(`/timeentries/${id}/switch-mode`, { method: 'POST', body: { gps } });
      toast(`Switched to ${r.opened.mode === 'drive' ? '🚗 Drive' : '🛠 Work'} time ✓`, 'ok');
      goto('timer');
    } catch (e) { toast(e.message, 'err'); }
  }));
}

// ---- ADD EXPENSE ----
// v0.54 — 3P Vendor removed from the tech-facing chip list (managers still
// have the dedicated vendor-invoice flow). Labor and Drive added so techs can
// log hours-based items directly from the expense tab.
const CATEGORIES = [
  { key: 'mileage', label: 'Mileage' },
  { key: 'labor',   label: 'Labor' },
  { key: 'drive',   label: 'Drive' },
  { key: 'tolls',   label: 'Tolls' },
  { key: 'parking', label: 'Parking' },
  { key: 'other',   label: 'Other' },
];
const SUBCATEGORIES = ['Meal', 'Tools', 'Hotel', 'Supplies', 'Misc'];

async function renderAdd(root) {
  // Determine the target invoice. If the user came from a non-current draft
  // (e.g. via the upload flow) we honor that pin; otherwise default to the
  // current week's draft.
  const pinnedId   = STATE._addToInvoiceId;
  const pinnedPer  = STATE._addToInvoicePeriod;
  const [wos, current, pinned] = await Promise.all([
    api('/workorders'),
    api('/invoices/current').catch(() => null),
    pinnedId ? api(`/invoices/${pinnedId}`).catch(() => null) : Promise.resolve(null),
  ]);
  const target = pinned || current;
  const open = wos.filter(w => ['open','in_progress'].includes(w.status));

  // Default the expense date into the target invoice's period so the server's
  // auto-attach logic finds the right draft.
  const inPeriod = (date, p) => date >= p.start && date <= p.end;
  let defaultDate = todayISO();
  if (target?.invoice && !inPeriod(defaultDate, { start: target.invoice.period_start, end: target.invoice.period_end })) {
    defaultDate = target.invoice.period_end;  // last day of the target week
  }

  // `selected` also captures any values the user has typed into the inputs
  // (amount, miles, description, search query) so that re-renders triggered
  // by a category change, WO change, or attaching a receipt photo preserve
  // everything the tech has entered so far. (v0.49 fix)
  let selected = { category: 'mileage', subcategory: '', work_order_id: open[0]?.id || '',
                   expense_date: defaultDate, amount: '', miles: '', description: '', wo_search: '',
                   // v0.69 — optional drive endpoints shown on the mileage report.
                   start_location: '', stop_location: '' };
  // Prefill WO from a previous "Add expense to this WO" flow
  if (STATE._prefillWO && open.find(w => w.id === STATE._prefillWO)) {
    selected.work_order_id = STATE._prefillWO;
    STATE._prefillWO = null;
  } else if (target?.lines?.length) {
    const recent = open.find(w => w.external_id === target.lines[target.lines.length - 1].external_id);
    if (recent) selected.work_order_id = recent.id;
  }

  function html() {
    const cat = selected.category;
    const w = open.find(x => x.id == selected.work_order_id);
    return `
      ${target ? `
        <div class="card" style="background: var(--ic-cream); border:0; padding: 10px 12px; margin-bottom: 12px;">
          <div style="font-size:11px; color: var(--ic-green-deep); text-transform: uppercase; letter-spacing: 0.6px; font-weight:700;">
            Adding to invoice ${pinnedId ? '(pinned)' : ''}
          </div>
          <div style="font-weight:600; margin-top:2px;">${target.invoice.invoice_number}</div>
          <div style="font-size:11px; color: var(--ink-2);">Week of ${fmtDate(target.invoice.period_start)} → ${fmtDate(target.invoice.period_end)} · running total ${fmt$(target.summary.total)}</div>
          ${pinnedId ? `<div style="font-size:11px; color: var(--ic-orange); margin-top:4px;">Date locked to this week's range. <a href="#" id="unpinAdd" style="color: var(--ic-orange); text-decoration: underline;">Switch to current week →</a></div>` : ''}
        </div>
      ` : ''}

      <span class="label">Category</span>
      <div class="chips" id="catChips">
        ${CATEGORIES.map(c => `<span class="chip ${c.key === cat ? 'selected' : ''}" data-cat="${c.key}">${c.label}</span>`).join('')}
      </div>

      <span class="label">Work Order</span>
      <input class="field" id="woSearch" placeholder="🔎 Search by ID, store, type…" style="margin-bottom:6px;" value="${escapeHTML(selected.wo_search || '')}" />
      <select class="field" id="woSel" size="${Math.min(5, Math.max(2, open.length))}">
        ${open.filter(w => !selected.wo_search ||
                          (w.external_id + ' ' + (w.store_name||'') + ' ' + (w.work_type||'') + ' ' + (w.description||''))
                            .toLowerCase().includes(selected.wo_search.toLowerCase()))
              .map(woOption).join('')}
      </select>
      ${w ? `<div class="help" style="margin-top:-8px">${sourceLabel(w.source_system)} · ${workTypeLabel(w.work_type)} · ${w.cart_count} carts · ${escapeHTML(w.description || '')}</div>` : ''}

      <span class="label">Date</span>
      <input class="field" type="date" id="dateInp" value="${selected.expense_date}" />

      ${cat === 'other' ? `
        <span class="label">Sub-option</span>
        <div class="chips" id="subChips">
          ${SUBCATEGORIES.map(s => `<span class="chip ${selected.subcategory === s ? 'selected' : ''}" data-sub="${s}">${s}</span>`).join('')}
        </div>
      ` : ''}

      ${cat === 'mileage' ? `
        <span class="label">Miles</span>
        <input class="field" type="number" step="0.1" min="0" id="qtyInp" placeholder="32.4" value="${escapeHTML(selected.miles || '')}" />
        <div class="help">Rate locked at $0.725/mi (IRS).</div>
        <div class="alert ok">
          <span class="ico">✓</span><div class="body">Mileage is computed automatically: miles × $0.725.</div>
          <button class="close" data-act="dismiss">×</button>
        </div>
        <span class="label">Start location (optional)</span>
        <input class="field" id="startLocInp" placeholder="e.g., Home — 24 Mayflower Dr, Sicklerville, NJ" value="${escapeHTML(selected.start_location || '')}" />
        <span class="label">Stop location (optional)</span>
        <input class="field" id="stopLocInp" placeholder="e.g., 6901 Ridge Ave, Roxborough, PA" value="${escapeHTML(selected.stop_location || '')}" />
        <div class="help">Shown on the mileage reimbursement report. Leave blank to use the work order's store location.</div>
      ` : (cat === 'labor' || cat === 'drive') ? `
        <span class="label">Hours</span>
        <input class="field" type="number" step="0.25" min="0" id="qtyInp" placeholder="2.5" value="${escapeHTML(selected.miles || '')}" />
        <div class="help">Auto-computed: hours × your hourly rate ($${(STATE.user?.hourly_rate || 40).toFixed(2)}/hr). ${cat === 'drive'
          ? 'Adds to billable drive hours on this invoice — tracked separately from labor for reporting.'
          : 'Adds to labor on this invoice.'}</div>
      ` : `
        <span class="label">Amount ($)</span>
        <input class="field" type="number" step="0.01" min="0" id="amtInp" placeholder="0.00" value="${escapeHTML(selected.amount || '')}" />
        ${cat === 'other' && selected.subcategory === 'Meal' ? `<div class="help">Daily cap: $100. Trips under 3 hrs are ineligible.</div>` : ''}
      `}

      <span class="label">Description (optional)</span>
      <input class="field" id="descInp" placeholder="e.g., Edgewater on-site mileage" value="${escapeHTML(selected.description || '')}" />

      <span class="label">Receipt (optional but recommended)</span>
      <div id="recBlock"></div>

      <button class="btn btn-primary btn-block" id="previewBtn">Preview ▸</button>
    `;
  }
  let pendingReceipt = null;
  // v0.59 — preview-before-submit. When true, the form is replaced with a
  // read-only summary card so the tech can verify the expense + attached
  // image before committing it to the invoice.
  let previewMode = false;

  // Build the preview card shown after tapping "Preview ▸".
  function previewHTML() {
    const cat   = selected.category;
    const w     = open.find(x => x.id == selected.work_order_id);
    const woLbl = w ? `${escapeHTML(w.external_id)}${w.store_name ? ' — ' + escapeHTML(w.store_name) : ''}` : '— pick a work order —';
    const dateStr = selected.expense_date ? fmtDate(selected.expense_date) : '—';

    // Compute preview amount/qty using the same rules the server applies on save.
    let qtyStr = '', amt = 0, rateNote = '';
    if (cat === 'mileage') {
      const miles = Number(selected.miles) || 0;
      qtyStr = `${miles} mi`;
      amt    = +(miles * 0.725).toFixed(2);
      rateNote = '$0.725/mi (IRS)';
    } else if (cat === 'labor' || cat === 'drive') {
      const hrs  = Number(selected.miles) || 0;
      const rate = STATE.user?.hourly_rate || 40;
      qtyStr = `${hrs.toFixed(2)} hrs`;
      amt    = +(hrs * rate).toFixed(2);
      rateNote = `$${rate.toFixed(2)}/hr${cat === 'drive' ? ' · drive' : ''}`;
    } else {
      amt = Number(selected.amount) || 0;
    }

    const icon = ({mileage:'🚙',labor:'⏱',drive:'🚗',tolls:'🚏',parking:'🅿️',vendor:'🏪',other:'•'})[cat] || '•';
    const catLabel = capitalize(cat) + (cat === 'other' && selected.subcategory ? ` · ${escapeHTML(selected.subcategory)}` : '');

    // Inline thumbnail from the queued receipt (still client-side — not uploaded yet).
    const thumb = pendingReceipt
      ? ((pendingReceipt.mime_type || '').startsWith('image/')
          ? `<div class="exp-thumbs" style="margin-top:8px;"><div class="exp-thumb"><img src="data:${pendingReceipt.mime_type};base64,${pendingReceipt.data_b64}" alt=""/></div></div>`
          : `<div class="exp-thumbs" style="margin-top:8px;"><div class="exp-thumb">${pendingReceipt.mime_type === 'application/pdf' ? '📄' : '📎'}</div></div>`)
      : '<div class="help" style="margin-top:6px;">No receipt attached.</div>';

    return `
      ${target ? `
        <div class="card" style="background: var(--ic-cream); border:0; padding: 10px 12px; margin-bottom: 12px;">
          <div style="font-size:11px; color: var(--ic-green-deep); text-transform: uppercase; letter-spacing: 0.6px; font-weight:700;">
            Preview · will save to invoice ${pinnedId ? '(pinned)' : ''}
          </div>
          <div style="font-weight:600; margin-top:2px;">${target.invoice.invoice_number}</div>
          <div style="font-size:11px; color: var(--ink-2);">Week of ${fmtDate(target.invoice.period_start)} → ${fmtDate(target.invoice.period_end)} · running total ${fmt$(target.summary.total)}</div>
        </div>
      ` : ''}

      <div class="card" style="padding: 14px; border-left: 4px solid var(--ic-green-deep);">
        <div class="section-title" style="margin-top:0;">Review before saving</div>
        <p class="help" style="margin: 0 0 12px;">This is exactly what will land on your invoice. Tap <em>Edit</em> to change anything.</p>

        <div class="ed-row ed-expense">
          <div class="ed-row-icon">${icon}</div>
          <div class="ed-row-body">
            <div class="ed-row-title">
              <strong>${catLabel}</strong>
              ${w ? ` · <span class="meta">${escapeHTML(woLbl)}</span>` : ''}
            </div>
            <div class="meta">
              ${dateStr}
              ${qtyStr ? ` · ${qtyStr}` : ''}
              ${rateNote ? ` · <span style="color:var(--muted);">${rateNote}</span>` : ''}
            </div>
            ${selected.description ? `<div class="ed-row-notes">${escapeHTML(selected.description)}</div>` : ''}
            ${cat === 'mileage' && (selected.start_location || selected.stop_location)
              ? `<div class="ed-row-notes">🚗 ${escapeHTML([selected.start_location || '—', selected.stop_location || (w && w.store_name) || '—'].join(' → '))}</div>`
              : ''}
            ${thumb}
          </div>
          <div class="ed-row-amt">${fmt$(amt)}</div>
        </div>
      </div>

      <div class="flex gap-12" style="margin-top: 14px;">
        <button class="btn btn-ghost" style="flex:1;" id="backToEditBtn">← Edit</button>
        <button class="btn btn-primary" style="flex:2;" id="confirmSaveBtn">✓ Save to invoice</button>
      </div>
    `;
  }
  function woOption(w) {
    return `<option value="${w.id}" ${selected.work_order_id == w.id ? 'selected' : ''}>${escapeHTML(w.external_id)} — ${escapeHTML(w.store_name || '')} (${workTypeLabel(w.work_type)})</option>`;
  }

  // v0.49 — capture every input into `selected` so that any subsequent
  // re-render (category swap, WO swap, receipt attach) preserves what the
  // tech has typed. Without this, picking a receipt photo wipes amount,
  // description, miles, and the WO search.
  function snapshot() {
    selected.amount      = $('#amtInp')?.value   ?? selected.amount;
    selected.miles       = $('#qtyInp')?.value   ?? selected.miles;
    selected.description = $('#descInp')?.value  ?? selected.description;
    selected.wo_search   = $('#woSearch')?.value ?? selected.wo_search;
    selected.expense_date = $('#dateInp')?.value || selected.expense_date;
    // v0.69 — preserve drive endpoints across re-renders (mileage only inputs).
    selected.start_location = $('#startLocInp')?.value ?? selected.start_location;
    selected.stop_location  = $('#stopLocInp')?.value  ?? selected.stop_location;
  }
  function rerender() {
    if (!previewMode) snapshot();
    root.innerHTML = previewMode ? previewHTML() : html();
    bind();
  }

  // Validate the form before allowing transition to preview. Mirrors the
  // checks the original Save handler used so the preview never shows a state
  // that can't actually be saved.
  function validateForPreview() {
    snapshot();
    if (!selected.work_order_id) { toast('Pick a work order', 'err'); return false; }
    if (selected.category === 'other') {
      if (!selected.subcategory) { toast('Pick a sub-option (Meal, Tools, Hotel, …)', 'err'); return false; }
    }
    if (selected.category === 'mileage' || selected.category === 'labor' || selected.category === 'drive') {
      const q = Number($('#qtyInp')?.value);
      if (!q) { toast(selected.category === 'mileage' ? 'Enter miles' : 'Enter hours', 'err'); return false; }
      selected.miles = String(q);
    } else {
      const a = Number($('#amtInp')?.value);
      if (!a) { toast('Enter amount', 'err'); return false; }
      selected.amount = String(a);
    }
    return true;
  }

  // Shared commit path used by the preview's "✓ Save to invoice" button.
  // Posts the expense, then attaches the queued receipt (if any), then
  // navigates to the invoice the line item just landed on.
  async function commitExpense() {
    const body = {
      work_order_id: Number(selected.work_order_id),
      category: selected.category,
      expense_date: selected.expense_date,
      description: selected.description || undefined,
    };
    if (selected.category === 'other') body.subcategory = selected.subcategory;
    if (selected.category === 'mileage' || selected.category === 'labor' || selected.category === 'drive') {
      body.quantity = Number(selected.miles);
    } else {
      body.amount = Number(selected.amount);
    }
    // v0.69 — send drive endpoints for the mileage report when provided.
    if (selected.category === 'mileage') {
      if (selected.start_location) body.start_location = selected.start_location;
      if (selected.stop_location)  body.stop_location  = selected.stop_location;
    }
    try {
      const exp = await api('/expenses', { method: 'POST', body });
      if (pendingReceipt) {
        await uploadReceipt(pendingReceipt, { expense_id: exp.id });
      }
      toast(pendingReceipt ? 'Expense + receipt saved ✓' : 'Expense added ✓', 'ok');
      if (pinnedId) {
        const dest = pinnedId;
        STATE._addToInvoiceId = null; STATE._addToInvoicePeriod = null;
        goto('invDetail', dest);
      } else {
        goto('invoice');
      }
    } catch (e) { toast(e.message, 'err'); }
  }

  function bind() {
    // v0.59 — wire up preview-mode buttons separately. In preview mode the
    // form inputs aren't on the page, so we skip all the form-input bindings.
    if (previewMode) {
      $('#backToEditBtn')?.addEventListener('click', () => { previewMode = false; rerender(); });
      $('#confirmSaveBtn')?.addEventListener('click', commitExpense);
      return;
    }
    $$('#catChips .chip').forEach(c => c.addEventListener('click', () => {
      selected.category = c.dataset.cat;
      if (selected.category !== 'other') selected.subcategory = '';
      rerender();
    }));
    $$('#subChips .chip').forEach(c => c.addEventListener('click', () => {
      selected.subcategory = c.dataset.sub; rerender();
    }));
    $('#woSearch')?.addEventListener('input', e => {
      selected.wo_search = e.target.value;
      const q = selected.wo_search.toLowerCase();
      const filtered = q ? open.filter(w => (w.external_id + ' ' + w.store_name + ' ' + w.work_type + ' ' + (w.description || '')).toLowerCase().includes(q)) : open;
      $('#woSel').innerHTML = filtered.map(woOption).join('');
    });
    $('#woSel').addEventListener('change', e => { selected.work_order_id = e.target.value; rerender(); });
    $('#dateInp').addEventListener('change', e => { selected.expense_date = e.target.value; });
    // Wire the receipt picker (lives in #recBlock)
    const recBlock = $('#recBlock');
    if (recBlock) {
      if (pendingReceipt) {
        recBlock.innerHTML = `
          <div class="attach-item">
            <div class="thumb">${(pendingReceipt.mime_type || '').startsWith('image/') ? '📷' : '📄'}</div>
            <div class="meta">
              <div class="name">${escapeHTML(pendingReceipt.filename)}</div>
              <div class="sub">${fmtSize(Math.round(pendingReceipt.data_b64.length * 3 / 4))} · queued for upload</div>
            </div>
            <div class="ctrl">
              <button class="btn btn-ghost btn-sm" id="rmRec">Remove</button>
            </div>
          </div>
        `;
        $('#rmRec').addEventListener('click', () => { pendingReceipt = null; rerender(); });
      } else {
        makeReceiptPicker(recBlock, {
          label: '📷 Take photo or pick file',
          onFile: (payload) => {
            pendingReceipt = payload;
            // Re-render to show the queued receipt; keep everything else (including
            // typed amount, miles, description) — snapshot() runs inside rerender().
            rerender();
          },
        });
      }
    }

    $('#previewBtn').addEventListener('click', () => {
      if (!validateForPreview()) return;
      previewMode = true;
      rerender();
    });

    // Unpin link inside the "Adding to invoice" header
    $('#unpinAdd')?.addEventListener('click', (e) => {
      e.preventDefault();
      STATE._addToInvoiceId = null; STATE._addToInvoicePeriod = null;
      goto('add');
    });
  }

  if (!open.length) {
    root.innerHTML = `<div class="empty"><div class="big">📭</div>No open work orders.<br/>You need a WO to log expenses against.</div>`;
    return;
  }
  root.innerHTML = previewMode ? previewHTML() : html();
  bind();
}

// ---- INVOICE ----
async function renderInvoice(root) {
  // v0.32 — `invoice` is now an alias for `invDetail` of the current week's
  // draft. The tech sees the same contractor-style preview here that the
  // ops manager sees, with editable line items + add/edit/delete affordances.
  // Forwarding keeps deep links from old code paths (e.g. goto('invoice'))
  // working without duplicating the renderer.
  try {
    const r = await api('/invoices/current');
    return renderInvoiceDetail(root, r.invoice.id);
  } catch (e) {
    root.innerHTML = `
      <div class="empty"><div class="big">📄</div>Couldn't load this week's invoice.<br/>${escapeHTML(e.message)}</div>
      <button class="btn btn-primary btn-block" id="goAdd">＋ Add Expense</button>
    `;
    $('#goAdd').addEventListener('click', () => goto('add'));
    return;
  }
  // Legacy summary view below — no longer reached, kept temporarily during
  // transition. Will be deleted in a follow-up.
  /* legacy guard */ if (true) return;
  const r = await api('/invoices/current');
  const { invoice, lines, summary } = r;

  if (!lines.length) {
    root.innerHTML = `
      <div class="empty"><div class="big">📄</div>This week's invoice is empty.<br/>Clock in or add an expense to get started.</div>
      <button class="btn btn-primary btn-block" id="goAdd">＋ Add Expense</button>
    `;
    $('#goAdd').addEventListener('click', () => goto('add'));
    return;
  }

  const editable = invoice.status === 'draft';
  const flaggedCount = summary.flag_count;

  root.innerHTML = `
    <div class="card">
      <div class="flex between">
        <div>
          <strong>${invoice.invoice_number}</strong>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">
            Week of ${fmtDate(invoice.period_start)} → ${fmtDate(invoice.period_end)}
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">
            Mirrors current contractor PDF / Expensify layout.
          </div>
        </div>
        <span class="badge ${badgeForStatus(invoice.status)}">${labelForStatus(invoice.status)}</span>
      </div>
    </div>

    ${flaggedCount > 0 ? alertHTML('warn', '⚠',
      `<strong>${flaggedCount} flagged line${flaggedCount>1?'s':''}</strong> need justification before you can submit.`) : ''}

    <div class="section-title">Receipts &amp; attachments (${(r.attachments || []).length})</div>
    <div class="card" style="padding: 14px;">
      ${(r.attachments && r.attachments.length) ? `
        <div class="gallery">
          ${r.attachments.map(a => {
            const ctx = a.expense_category
              ? `${capitalize(a.expense_category)} · ${fmt$(a.expense_amount || 0)}`
              : (a.time_entry_id ? 'Time' : 'Invoice');
            return galleryThumbHTML(a, ctx);
          }).join('')}
        </div>
        <details style="margin-top: 12px;">
          <summary style="cursor: pointer; font-size: 13px; color: var(--ic-green-deep); font-weight: 600;">View all as list</summary>
          <div class="attach-list" style="margin-top: 10px;">
            ${r.attachments.map((a) => {
              const ctx = a.expense_category
                ? `${capitalize(a.expense_category)} · ${fmt$(a.expense_amount || 0)}`
                : (a.time_entry_id ? 'Time entry' : (a.invoice_id ? 'Invoice-level' : ''));
              const html = attachmentItemHTML(a, { canDelete: editable });
              return html.replace('<div class="sub">', `<div class="sub">${ctx ? escapeHTML(ctx) + ' · ' : ''}`);
            }).join('')}
          </div>
        </details>
      ` : `<div class="attach-empty">No receipts attached. Attach photos to expenses or use the button below to add invoice-level docs.</div>`}
      ${editable ? `<div id="invAttPicker" style="margin-top: 12px;"></div>` : ''}
    </div>

    <div class="section-title">Lines (grouped by work order)</div>
    ${lines.map(l => invoiceLineHTML(l, r.attachments || [])).join('')}

    ${editable ? `
      <button class="btn btn-ghost btn-block" id="addExpBtn" style="margin-bottom:14px;">
        ＋ Add an expense
      </button>
    ` : ''}

    <div class="section-title">Daily totals (for AP)</div>
    <div class="card">
      <table style="width:100%; border-collapse: collapse; font-size: 12px;">
        <thead>
          <tr style="border-bottom: 1px solid var(--line);">
            <th style="text-align:left; padding:6px 4px; font-size:10px; color:var(--muted); text-transform:uppercase;">Date</th>
            <th style="text-align:right; padding:6px 4px; font-size:10px; color:var(--muted); text-transform:uppercase;">Work hrs</th>
            <th style="text-align:right; padding:6px 4px; font-size:10px; color:var(--muted); text-transform:uppercase;">Drive hrs</th>
            <th style="text-align:right; padding:6px 4px; font-size:10px; color:var(--muted); text-transform:uppercase;">Labor $</th>
            <th style="text-align:right; padding:6px 4px; font-size:10px; color:var(--muted); text-transform:uppercase;">Expenses</th>
            <th style="text-align:right; padding:6px 4px; font-size:10px; color:var(--muted); text-transform:uppercase;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${(r.by_date || []).map(d => `
            <tr style="border-bottom: 1px solid #f4f4f4;">
              <td style="padding:8px 4px;">
                <strong>${fmtDate(d.date)}</strong>
                <div style="font-size:10px; color:var(--muted);">${d.work_orders.length} WO${d.work_orders.length>1?'s':''}</div>
              </td>
              <td class="amt" style="padding:8px 4px;">${(d.labor_hours || 0).toFixed(2)}</td>
              <td class="amt" style="padding:8px 4px; color: var(--ic-orange);">${(d.drive_hours || 0).toFixed(2)}</td>
              <td class="amt" style="padding:8px 4px;">${fmt$(d.labor_amount)}</td>
              <td class="amt" style="padding:8px 4px;">${fmt$(d.expenses)}</td>
              <td class="amt" style="padding:8px 4px; font-weight:700;">${fmt$(d.total)}</td>
            </tr>
          `).join('')}
          <tr style="border-top: 2px solid #1a1a1a;">
            <td style="padding:8px 4px; font-weight:700;">${(r.by_date||[]).length} day${(r.by_date||[]).length===1?'':'s'}</td>
            <td class="amt" style="padding:8px 4px; font-weight:700;">${(summary.labor_hours || 0).toFixed(2)}</td>
            <td class="amt" style="padding:8px 4px; font-weight:700; color: var(--ic-orange);">${(summary.drive_hours || 0).toFixed(2)}</td>
            <td class="amt" style="padding:8px 4px; font-weight:700;">${fmt$(summary.labor_amount)}</td>
            <td class="amt" style="padding:8px 4px; font-weight:700;">${fmt$((summary.mileage||0)+(summary.tolls_parking||0)+(summary.meals||0)+(summary.tools||0)+(summary.other||0))}</td>
            <td class="amt" style="padding:8px 4px; font-weight:700;">${fmt$(summary.total)}</td>
          </tr>
        </tbody>
      </table>
      <div style="font-size: 11px; color: var(--muted); margin-top: 8px;">Drive hours are tracked but not billable as labor.</div>
    </div>

    <div class="section-title">Category summary</div>
    <div class="card" style="background:#fafafa;">
      <div class="card-row">
        <span>
          Labor (${summary.labor_hours} hrs × $${(invoice.hourly_rate||40).toFixed(2)}/hr)
          ${editable ? '<a href="#" id="editRate" style="margin-left:8px; font-size:11px; color: var(--info-fg);">change rate</a>' : ''}
        </span>
        <span class="amt">${fmt$(summary.labor_amount)}</span>
      </div>
      ${summary.mileage ? `<div class="card-row"><span>Mileage</span><span class="amt">${fmt$(summary.mileage)}</span></div>` : ''}
      ${summary.tolls_parking ? `<div class="card-row"><span>Tolls / Parking</span><span class="amt">${fmt$(summary.tolls_parking)}</span></div>` : ''}
      ${summary.meals ? `<div class="card-row"><span>Meals</span><span class="amt">${fmt$(summary.meals)}</span></div>` : ''}
      ${summary.tools ? `<div class="card-row"><span>Tools / Supplies</span><span class="amt">${fmt$(summary.tools)}</span></div>` : ''}
      ${summary.other ? `<div class="card-row"><span>Other</span><span class="amt">${fmt$(summary.other)}</span></div>` : ''}
      <div class="card-row" style="font-weight:700; font-size:16px;"><span>Total</span><span class="amt">${fmt$(summary.total)}</span></div>
    </div>

    ${editable && flaggedCount > 0 ? `
      <span class="label">Justification (required for flagged lines)</span>
      <textarea class="field" id="justify" rows="3" placeholder="e.g., 2 carts had shelf damage, replaced parts on-site"></textarea>
    ` : ''}

    ${editable
      ? `<button class="btn btn-primary btn-block" id="submitBtn">Submit for Approval</button>`
      : alertHTML('info', 'ⓘ', 'This invoice is no longer editable.')}
  `;

  // Wire actions
  $('#addExpBtn')?.addEventListener('click', () => goto('add'));
  $('#editRate')?.addEventListener('click', (e) => { e.preventDefault(); openRateSheet(invoice.hourly_rate || 40); });

  // Invoice-level receipt picker (e.g. summary docs not tied to a specific expense)
  const invPicker = $('#invAttPicker');
  if (invPicker) {
    makeReceiptPicker(invPicker, {
      label: '📎 Attach a document to this invoice',
      onFile: async (payload) => {
        try {
          await uploadReceipt(payload, { invoice_id: invoice.id });
          toast('Attached ✓', 'ok');
          goto('invoice');
        } catch (e) { toast(e.message, 'err'); }
      },
    });
  }
  $('#submitBtn')?.addEventListener('click', async () => {
    try {
      const notes = $('#justify')?.value || undefined;
      await api(`/invoices/${invoice.id}/submit`, { method: 'POST', body: { notes } });
      toast('Invoice submitted ✓', 'ok');
      goto('mine');
    } catch (e) { toast(e.message, 'err'); }
  });

  if (editable) {
    const [timeEntries, expenses] = await Promise.all([api('/timeentries'), api('/expenses')]);
    bindLineActions(timeEntries, expenses);
  }
}

const RULE_TYPES = {
  // Hours overrun rules (replace the v0.19 universal 1.5× multiplier)
  max_hours_per_wo:        { label: 'Max total hours per WO',      unit: 'hrs', desc: 'Total labor hrs billed to one WO line. Filter by work type and minimum cart count.', wantsCarts: true },
  // v0.23 — per-cart re-expressed as per-10-carts for readability.
  max_hours_per_10_carts:  { label: 'Max hours per 10 carts',      unit: 'hrs / 10 carts', desc: 'Productivity threshold scaled to 10 carts (labor hrs ÷ (cart count / 10)). Filter by work type and minimum cart count.', wantsCarts: true },
  max_hours_per_shift:     { label: 'Max hours per shift',         unit: 'hrs', desc: 'Single time entry can\'t exceed N hours' },
  max_hours_per_day:       { label: 'Max work hours per day',      unit: 'hrs', desc: 'Combined work hours on one date' },
  max_drive_hours_per_day: { label: 'Max drive hours per day',     unit: 'hrs', desc: 'Combined drive time on one date' },
  max_miles_per_day:       { label: 'Max miles per day',           unit: 'mi',  desc: 'Combined mileage on one date' },
  max_expense_amount:      { label: 'Max single expense amount',   unit: '$',   desc: 'Per category, optional', wantsCategory: true },
  require_receipt_above:   { label: 'Require receipt above amount',unit: '$',   desc: 'Expenses over N must have a receipt', wantsCategory: true },
};

function renderRulesEditor(rules) {
  const active   = rules.filter(r => r.active);
  const inactive = rules.filter(r => !r.active);
  return `
    <div class="section-title">Custom validation rules</div>
    <div class="card">
      <p class="help" style="margin: 0 0 14px;">Add rules on top of the built-in policy. Violations show as flags on submitted invoices and route to Sr Mgr review.</p>

      <button class="btn btn-primary btn-block" id="addRuleBtn">＋ Add a custom rule</button>

      ${active.length === 0 ? `<div class="empty" style="padding: 14px; font-size: 12px;">No custom rules yet. Add a <strong>Max total hours per WO</strong> rule (filter by work type and minimum carts) to flag overruns.</div>` : `
        <div style="font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; margin: 16px 0 8px; font-weight: 600;">Active (${active.length})</div>
        ${active.map(ruleRowHTML).join('')}
      `}

      ${inactive.length ? `
        <div style="font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; margin: 16px 0 8px; font-weight: 600;">Disabled (${inactive.length})</div>
        ${inactive.map(ruleRowHTML).join('')}
      ` : ''}
    </div>
  `;
}

// ---- POLICY TAB (manager-only) ----
// Top-level view that renders the org-wide policy editor and the custom rules
// list together. Promoted to its own bottom-bar tab in v0.20.
async function renderPolicyView(root) {
  const me = STATE.user;
  if (!['ops_manager','sr_manager','pm'].includes(me.role)) {
    root.innerHTML = `<div class="empty">Manager role required.</div>`;
    return;
  }
  // v0.61 / v0.62 — fetch every dependency the Policy page needs in one shot.
  // Failures degrade silently to empty data (so a broken endpoint doesn't
  // crash the whole tab).
  const [pol, rules, wtCfg, catRules, ccCats, workOrders, woBudgets, workTypes] = await Promise.all([
    api('/policy'),
    api('/rules'),
    api('/settings/work-type-map').catch(() => null),
    api('/category-rules').catch(() => []),
    api('/corp-card/categories?include=archived').catch(() => []),
    api('/workorders').catch(() => []),
    api('/wo-budgets').catch(() => []),
    api('/work-types?include=archived').catch(() => []),
  ]);
  root.innerHTML = `
    ${renderPolicyEditor(pol)}
    ${renderWorkTypesEditor(workTypes)}
    ${renderWorkTypeMapEditor(wtCfg)}
    ${renderRulesEditor(rules)}
    ${renderCategoryRulesEditor(catRules, ccCats)}
    ${renderWoBudgetsEditor(workOrders, woBudgets, ccCats)}
  `;
  bindSavePolicy();
  bindRulesActions('policy');
  bindWorkTypeMapActions();
  bindCategoryRulesActions();
  bindWoBudgetsActions(workOrders, ccCats);
  bindWorkTypesActions();
}

// ---- Work-types editor (v0.62) ----
// Admin-managed list. The four originals (deployment/retrofit/maintenance/repair)
// are seeded at boot and cannot be archived. Custom types added here show up
// in the Work Order add/edit form and in the rule + dashboard work_type
// filters.
function renderWorkTypesEditor(workTypes) {
  const DEFAULTS = new Set(['deployment','retrofit','maintenance','repair']);
  const active   = workTypes.filter(w => !w.archived_at);
  const archived = workTypes.filter(w => w.archived_at);
  return `
    <div class="section-title">Work types</div>
    <div class="card">
      <p class="help" style="margin: 0 0 12px;">
        Add custom work types that show up on the WO add/edit form and in the dashboard + rule filters.
        The four defaults (deployment, retrofit, maintenance, repair) can't be archived because their abbreviations and productivity rates are baked into the app.
      </p>
      ${active.length === 0 ? `<div class="empty" style="padding: 10px;">No work types yet.</div>` : ''}
      ${active.map(w => `
        <div class="attach-item">
          <div class="thumb" style="font-size: 18px;">🛠</div>
          <div class="meta">
            <div class="name">${escapeHTML(w.name)}</div>
            <div class="sub">${w.use_count || 0} WO${w.use_count === 1 ? '' : 's'}${DEFAULTS.has(w.name) ? ' · default' : ''}</div>
          </div>
          <div class="ctrl">
            ${DEFAULTS.has(w.name) ? '' : `<button class="btn btn-ghost btn-sm" data-wt-archive="${w.id}" data-wt-name="${escapeHTML(w.name)}">Archive</button>`}
          </div>
        </div>
      `).join('')}

      <span class="label" style="margin-top: 14px;">Add a new work type</span>
      <div class="flex gap-12">
        <input class="field" id="wtNewName" placeholder="e.g., install_audit" style="flex: 2;" />
        <button class="btn btn-primary" id="wtAddBtn" style="flex: 1;">＋ Add</button>
      </div>
      <div class="help" style="margin-top: -2px;">Lowercase letters, digits, dashes or underscores only.</div>

      ${archived.length ? `
        <div class="section-title" style="margin-top: 14px; font-size: 11px;">Archived (${archived.length})</div>
        ${archived.map(w => `
          <div class="attach-item" style="opacity: 0.7;">
            <div class="thumb" style="font-size: 18px;">📦</div>
            <div class="meta">
              <div class="name" style="text-decoration: line-through;">${escapeHTML(w.name)}</div>
              <div class="sub">${w.use_count || 0} historical WO${w.use_count === 1 ? '' : 's'}</div>
            </div>
            <div class="ctrl">
              <button class="btn btn-ghost btn-sm" data-wt-unarchive="${w.id}">Restore</button>
            </div>
          </div>
        `).join('')}
      ` : ''}
    </div>
  `;
}

function bindWorkTypesActions() {
  $('#wtAddBtn')?.addEventListener('click', async () => {
    const name = ($('#wtNewName')?.value || '').trim();
    if (!name) return toast('Enter a name', 'err');
    try {
      await api('/work-types', { method: 'POST', body: { name } });
      toast('Added ✓', 'ok');
      goto('policy');
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-wt-archive]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`Archive "${b.dataset.wtName}"? Existing WOs keep the label; new WOs can't pick it until restored.`)) return;
    try {
      await api(`/work-types/${b.dataset.wtArchive}`, { method: 'DELETE' });
      toast('Archived ✓', 'ok');
      goto('policy');
    } catch (e) { toast(e.message, 'err'); }
  }));
  $$('[data-wt-unarchive]').forEach(b => b.addEventListener('click', async () => {
    try {
      await api(`/work-types/${b.dataset.wtUnarchive}`, { method: 'PATCH', body: { unarchive: true } });
      toast('Restored ✓', 'ok');
      goto('policy');
    } catch (e) { toast(e.message, 'err'); }
  }));
}

// ---- Per-category rules editor (v0.61) ----
// Every category (corp-card + tech-expense subcategory) gets three editable
// rule rows auto-seeded when the category is created. Admin (ops_manager,
// sr_manager, pm) sets the $ amount inline; blank = rule is off.
const CATEGORY_RULE_LABELS = {
  per_wo_cap:              { label: 'Per-WO $ cap',         help: 'Cap on combined spend in this category per work order. Overspend is flagged on the policy engine.' },
  global_cap:              { label: 'Global $ cap',         help: 'A single $ cap across the whole org for this category. Useful for catch-all limits.' },
  receipt_required_above:  { label: 'Receipt required > $', help: 'Any single charge above this dollar amount must have a receipt attached.' },
};

function renderCategoryRulesEditor(catRules, ccCats) {
  // Bucket rules by (source, key, label).
  const groups = new Map();
  for (const r of catRules) {
    const k = `${r.category_source}|${r.category_key}`;
    if (!groups.has(k)) groups.set(k, { source: r.category_source, key: r.category_key, label: r.category_label, archived: false, rules: {} });
    groups.get(k).rules[r.rule_kind] = r;
  }
  // Mark corp-card archived state for visual hint.
  const archivedSet = new Set(ccCats.filter(c => c.archived_at).map(c => String(c.id)));
  for (const g of groups.values()) {
    if (g.source === 'corp_card' && archivedSet.has(g.key)) g.archived = true;
  }
  // Stable order: corp-card active, then archived; then tech_expense.
  const list = [...groups.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'corp_card' ? -1 : 1;
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return a.label.localeCompare(b.label);
  });

  // v0.62 — rows are collapsed by default; remember last-expanded set in
  // STATE._catRuleOpen so the user's expand state survives a render() call.
  STATE._catRuleOpen = STATE._catRuleOpen || new Set();
  const openSet = STATE._catRuleOpen;

  // Quick summary string so the collapsed header tells you what's configured
  // at a glance.
  function summary(g) {
    const bits = [];
    const r1 = g.rules.per_wo_cap?.amount;
    const r2 = g.rules.global_cap?.amount;
    const r3 = g.rules.receipt_required_above?.amount;
    if (r1 != null) bits.push(`per-WO $${(+r1).toFixed(0)}`);
    if (r2 != null) bits.push(`global $${(+r2).toFixed(0)}`);
    if (r3 != null) bits.push(`receipt >$${(+r3).toFixed(0)}`);
    return bits.length ? bits.join(' · ') : 'no rules set';
  }

  return `
    <div class="section-title">Per-category rules</div>
    <div class="card">
      <p class="help" style="margin: 0 0 10px;">
        Each category has three editable rules — a per-WO $ cap, a global $ cap, and a receipt threshold.
        Click a category to expand. Leave a field blank to turn that rule off. Adding a new corp-card category auto-creates these three rows.
      </p>
      <div style="display: flex; gap: 6px; margin-bottom: 8px;">
        <button class="btn btn-ghost btn-sm" id="catRulesExpandAll" type="button">Expand all</button>
        <button class="btn btn-ghost btn-sm" id="catRulesCollapseAll" type="button">Collapse all</button>
      </div>
      ${list.length === 0 ? `<div class="empty" style="padding: 12px; font-size: 12px;">No categories yet. Add one from the Corp Card tab.</div>` : ''}
      ${list.map(g => {
        const key  = `${g.source}|${g.key}`;
        const open = openSet.has(key);
        return `
        <div class="cat-rule-row" data-cat-key="${escapeHTML(key)}" style="border-top: 1px solid var(--line);">
          <button class="cat-rule-header" type="button" data-cat-toggle="${escapeHTML(key)}"
                  style="display: flex; align-items: center; justify-content: space-between; width: 100%;
                         background: none; border: 0; padding: 10px 0; cursor: pointer; text-align: left;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="display: inline-block; width: 12px; transition: transform 0.15s;">${open ? '▾' : '▸'}</span>
              <span style="font-weight: 600;">${escapeHTML(g.label)}</span>
              <span class="meta" style="font-weight: 400;">${g.source === 'corp_card' ? 'Corp card' : 'Tech expense'}${g.archived ? ' · archived' : ''}</span>
            </div>
            <span class="meta" style="font-size: 11px;">${escapeHTML(summary(g))}</span>
          </button>
          <div class="cat-rule-fields" style="display: ${open ? 'grid' : 'none'}; grid-template-columns: 1fr 1fr 1fr; gap: 8px; padding: 0 0 12px;">
            ${['per_wo_cap','global_cap','receipt_required_above'].map(k => {
              const r = g.rules[k];
              if (!r) return '';
              const meta = CATEGORY_RULE_LABELS[k];
              return `
                <label class="cat-rule-field" style="display: flex; flex-direction: column; gap: 3px;">
                  <span class="label" title="${escapeHTML(meta.help)}" style="font-size: 11px;">${escapeHTML(meta.label)}</span>
                  <input class="field cat-rule-input"
                         type="number" step="0.01" min="0"
                         data-rule-id="${r.id}"
                         value="${r.amount != null ? r.amount : ''}"
                         placeholder="—" />
                </label>
              `;
            }).join('')}
          </div>
        </div>
      `;
      }).join('')}
    </div>
  `;
}

function bindCategoryRulesActions() {
  // Save on blur so the admin doesn't need a Save button per row.
  $$('.cat-rule-input').forEach(inp => {
    inp.addEventListener('blur', async () => {
      const id  = inp.dataset.ruleId;
      const raw = inp.value.trim();
      const amount = raw === '' ? null : Number(raw);
      if (raw !== '' && (!isFinite(amount) || amount < 0)) {
        toast('Amount must be a non-negative number', 'err');
        return;
      }
      try {
        await api(`/category-rules/${id}`, { method: 'PUT', body: { amount } });
        inp.style.outline = '2px solid var(--ic-green-deep)';
        setTimeout(() => { inp.style.outline = ''; }, 800);
      } catch (e) { toast(e.message, 'err'); }
    });
  });

  // v0.62 — collapsible headers. Toggling re-renders the section in-place
  // without losing the rest of the Policy page state.
  STATE._catRuleOpen = STATE._catRuleOpen || new Set();
  $$('[data-cat-toggle]').forEach(btn => btn.addEventListener('click', () => {
    const key = btn.dataset.catToggle;
    if (STATE._catRuleOpen.has(key)) STATE._catRuleOpen.delete(key);
    else STATE._catRuleOpen.add(key);
    // Toggle just the affected row to avoid re-fetching everything.
    const row    = btn.closest('.cat-rule-row');
    const fields = row.querySelector('.cat-rule-fields');
    const caret  = btn.querySelector('span');
    const isOpen = STATE._catRuleOpen.has(key);
    fields.style.display = isOpen ? 'grid' : 'none';
    if (caret) caret.textContent = isOpen ? '▾' : '▸';
  }));

  $('#catRulesExpandAll')?.addEventListener('click', () => {
    $$('[data-cat-toggle]').forEach(btn => {
      if (!STATE._catRuleOpen.has(btn.dataset.catToggle)) btn.click();
    });
  });
  $('#catRulesCollapseAll')?.addEventListener('click', () => {
    $$('[data-cat-toggle]').forEach(btn => {
      if (STATE._catRuleOpen.has(btn.dataset.catToggle)) btn.click();
    });
  });
}

// ---- Per-WO category budgets editor (v0.61) ----
// Pick a WO, set a $ cap per category. Overspend will surface in the
// dashboard sub-tab's over-budget list (and, once wired, as a policy-engine
// flag on the invoice).
function renderWoBudgetsEditor(workOrders, woBudgets, ccCats) {
  const woOpts = (workOrders || []).map(w => `<option value="${w.id}" data-ext="${escapeHTML(w.external_id || '')}">${escapeHTML((w.external_id || `WO #${w.id}`) + (w.store_name ? ` · ${w.store_name}` : ''))}</option>`).join('');
  return `
    <div class="section-title">Per-WO category budgets</div>
    <div class="card">
      <p class="help" style="margin: 0 0 14px;">
        Set a $ cap per category on a specific work order. Spend over the cap is flagged on the corresponding category dashboard.
        Leave a row blank to remove the budget.
      </p>

      <label class="cat-rule-field" style="display: flex; flex-direction: column; gap: 4px;">
        <span class="label">Pick a work order</span>
        <select class="field" id="woBudgetPick">
          <option value="">— Select a WO —</option>
          ${woOpts}
        </select>
      </label>

      <div id="woBudgetEditor" style="margin-top: 12px;"></div>

      ${woBudgets.length ? `
        <div class="section-title" style="margin-top: 18px; font-size: 12px;">Existing budgets (${woBudgets.length})</div>
        <div style="font-size: 12px;">
          ${woBudgets.map(b => `
            <div style="display: flex; justify-content: space-between; padding: 6px 0; border-top: 1px solid var(--line);">
              <span>${escapeHTML(b.wo_external_id || `WO #${b.work_order_id}`)} · ${escapeHTML(b.category_label)}</span>
              <strong>$${b.amount_cap.toFixed(2)}</strong>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function bindWoBudgetsActions(workOrders, ccCats) {
  const sel = $('#woBudgetPick');
  if (!sel) return;
  const editor = $('#woBudgetEditor');

  async function showEditor(woId) {
    if (!woId) { editor.innerHTML = ''; return; }
    const existing = await api(`/wo-budgets?work_order_id=${woId}`).catch(() => []);
    const byKey = {};
    for (const b of existing) byKey[`${b.category_source}|${b.category_key}`] = b;

    const categories = [
      ...(ccCats.filter(c => !c.archived_at).map(c => ({ source: 'corp_card', key: String(c.id), label: c.name }))),
      ...['Meal','Tools','Hotel','Supplies','Misc'].map(s => ({ source: 'tech_expense', key: s, label: s })),
    ];

    editor.innerHTML = `
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        ${categories.map(c => {
          const k = `${c.source}|${c.key}`;
          const cap = byKey[k]?.amount_cap;
          return `
            <label class="cat-rule-field" style="display: flex; flex-direction: column; gap: 3px;">
              <span class="label" style="font-size: 11px;">${escapeHTML(c.label)} <span class="meta">(${c.source === 'corp_card' ? 'CC' : 'TE'})</span></span>
              <input class="field wo-budget-input"
                     type="number" step="0.01" min="0"
                     data-wo="${woId}"
                     data-source="${c.source}"
                     data-key="${escapeHTML(c.key)}"
                     value="${cap != null ? cap : ''}"
                     placeholder="—" />
            </label>
          `;
        }).join('')}
      </div>
    `;

    $$('.wo-budget-input', editor).forEach(inp => {
      inp.addEventListener('blur', async () => {
        const raw = inp.value.trim();
        const amount_cap = raw === '' ? null : Number(raw);
        if (raw !== '' && (!isFinite(amount_cap) || amount_cap < 0)) {
          toast('Cap must be a non-negative number', 'err');
          return;
        }
        try {
          await api('/wo-budgets', { method: 'PUT', body: {
            work_order_id: Number(inp.dataset.wo),
            category_source: inp.dataset.source,
            category_key:    inp.dataset.key,
            amount_cap,
          } });
          inp.style.outline = '2px solid var(--ic-green-deep)';
          setTimeout(() => { inp.style.outline = ''; }, 800);
        } catch (e) { toast(e.message, 'err'); }
      });
    });
  }

  sel.addEventListener('change', () => showEditor(sel.value));
}

// ---- Work-type integration mapping (v0.30) ----
// Manager-configurable. The admin pastes the field name (in MaintainX
// extraFields, or as a Freshdesk cf_*) and a JSON map of source values to
// our 4 enum values. When parse-url runs, the resolver uses ONLY this map —
// no keyword guessing.
function renderWorkTypeMapEditor(cfg) {
  const m = cfg || { maintainx: {}, freshdesk_caperhelp: {} };
  const mxField = m.maintainx?.field || '';
  const mxMap   = m.maintainx?.map   || '';
  const fdField = m.freshdesk_caperhelp?.field || '';
  const fdMap   = m.freshdesk_caperhelp?.map   || '';
  const ENUM = ['deployment','retrofit','maintenance','repair'];
  return `
    <div class="section-title">Work-type integration mapping</div>
    <div class="card">
      <p class="help" style="margin: 0 0 12px;">
        Tells the integration which field on each ticket carries the work type
        (Deployment / Retrofit / Maintenance / Repair) and how to translate raw values
        to our four buckets. <strong>No keyword guessing</strong> — when no mapping
        matches, the user is asked to pick manually.
      </p>

      <div class="section-title" style="margin: 14px 4px 8px;">MaintainX</div>
      <span class="label">Field name (inside <code>extraFields</code>)</span>
      <input class="field" id="wtMxField" value="${escapeHTML(mxField)}" placeholder='e.g. "Type of Work"' />

      <span class="label">Value → work_type (JSON)</span>
      <textarea class="field" id="wtMxMap" rows="6" placeholder='${escapeHTML('{ "Deployment": "deployment", "Retrofit": "retrofit", "Service Call": "maintenance", "Repair": "repair" }')}'>${escapeHTML(mxMap)}</textarea>
      <div class="help" style="margin-top: -8px;">Right-hand side must be one of: <code>${ENUM.join('</code>, <code>')}</code>. Match is case-insensitive.</div>

      <div class="section-title" style="margin: 18px 4px 8px;">Freshdesk — caperhelp</div>
      <span class="label">Field name (custom field key, e.g. <code>cf_request_type</code>)</span>
      <input class="field" id="wtFdField" value="${escapeHTML(fdField)}" placeholder='e.g. "cf_request_type"' />

      <span class="label">Value → work_type (JSON)</span>
      <textarea class="field" id="wtFdMap" rows="6" placeholder='${escapeHTML('{ "Deployment": "deployment", "Retrofit": "retrofit", "Service": "maintenance", "Repair": "repair" }')}'>${escapeHTML(fdMap)}</textarea>

      <button class="btn btn-primary btn-block" id="saveWtMap" style="margin-top: 14px;">Save mapping</button>
      <div id="wtMapStatus" style="margin-top: 10px;"></div>
    </div>
  `;
}

function bindWorkTypeMapActions() {
  $('#saveWtMap')?.addEventListener('click', async () => {
    const body = {
      maintainx: {
        field: $('#wtMxField').value.trim(),
        map:   $('#wtMxMap').value.trim(),
      },
      freshdesk_caperhelp: {
        field: $('#wtFdField').value.trim(),
        map:   $('#wtFdMap').value.trim(),
      },
    };
    try {
      const r = await api('/settings/work-type-map', { method: 'PUT', body });
      $('#wtMapStatus').innerHTML = `<div class="alert ok"><span class="ico">✓</span><div class="body">Saved ✓</div></div>`;
      toast('Work-type mapping saved', 'ok');
    } catch (e) {
      $('#wtMapStatus').innerHTML = `<div class="alert err"><span class="ico">!</span><div class="body">${escapeHTML(e.message)}</div></div>`;
    }
  });
}

// Bind handlers for #savePolicy and the rule add/toggle/delete buttons.
// Idempotent — safe to call from any view that includes the relevant DOM.
function bindSavePolicy() {
  $('#savePolicy')?.addEventListener('click', async () => {
    const body = {
      policy_hourly_rate_default:        $('#pol_hourly')?.value,
      policy_mileage_rate:               $('#pol_mileage')?.value,
      policy_meal_daily_cap:             $('#pol_meal_cap')?.value,
      policy_meal_trip_min_hours:        $('#pol_meal_min')?.value,
      policy_hours_per_10_carts_deployment:  $('#pol_hpc_dpl')?.value,
      policy_hours_per_10_carts_retrofit:    $('#pol_hpc_rtr')?.value,
      policy_hours_per_10_carts_maintenance: $('#pol_hpc_mnt')?.value,
      policy_hours_per_10_carts_repair:      $('#pol_hpc_rpr')?.value,
      policy_ap_email:                       $('#pol_ap_email')?.value,
    };
    // Drop blank fields
    for (const k of Object.keys(body)) if (body[k] == null) delete body[k];
    try {
      await api('/policy', { method: 'PUT', body });
      toast('Policy saved ✓', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
}

function bindRulesActions(returnView = 'policy') {
  $('#addRuleBtn')?.addEventListener('click', openAddRuleSheet);
  $$('[data-rule-toggle]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.ruleToggle;
    const active = b.dataset.active === '1' ? 0 : 1;
    try {
      await api(`/rules/${id}`, { method: 'PATCH', body: { active } });
      goto(returnView);
    } catch (e) { toast(e.message, 'err'); }
  }));
  $$('[data-rule-delete]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this rule?')) return;
    try {
      await api(`/rules/${b.dataset.ruleDelete}`, { method: 'DELETE' });
      toast('Rule removed ✓', 'ok');
      goto(returnView);
    } catch (e) { toast(e.message, 'err'); }
  }));
}

function ruleRowHTML(r) {
  const meta = RULE_TYPES[r.rule_type] || { label: r.rule_type, unit: '', desc: '' };
  const wt = r.work_type_filter ? ` · ${capitalize(r.work_type_filter)} only` : ' · all work types';
  const cat = r.category_filter ? ` · ${r.category_filter}` : '';
  const carts = r.cart_count_min != null ? ` · ≥${r.cart_count_min} carts` : '';
  return `
    <div class="card" style="padding: 12px 14px; background: ${r.active ? '#fff' : '#fafafa'}; opacity: ${r.active ? '1' : '0.7'};">
      <div class="flex between" style="align-items: flex-start;">
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 700;">${escapeHTML(meta.label)}: <span class="amt">${r.threshold}</span> ${escapeHTML(meta.unit)}</div>
          <div class="meta">${escapeHTML(wt)}${escapeHTML(carts)}${escapeHTML(cat)} · ${r.severity}</div>
          ${r.description ? `<div style="font-size: 12px; color: var(--ink-2); margin-top: 4px; font-style: italic;">${escapeHTML(r.description)}</div>` : ''}
        </div>
        <div class="ctrl">
          <button class="btn btn-ghost btn-sm" data-rule-toggle="${r.id}" data-active="${r.active}">${r.active ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-danger btn-sm" data-rule-delete="${r.id}">Delete</button>
        </div>
      </div>
    </div>
  `;
}

async function openAddRuleSheet() {
  // v0.62 — load active work types so the filter dropdown reflects admin-added ones.
  const wtRows = await api('/work-types').catch(() => []);
  const WT_OPTIONS = wtRows.length ? wtRows.map(w => w.name) : ['deployment','retrofit','maintenance','repair'];

  let form = { rule_type: 'max_hours_per_wo', work_type_filter: '', category_filter: '',
               cart_count_min: '', threshold: '', description: '', severity: 'flag' };

  function html() {
    const meta = RULE_TYPES[form.rule_type] || {};
    const showCategoryFilter = !!meta.wantsCategory;
    const showCartFilter     = !!meta.wantsCarts;
    const placeholder = ({
      max_hours_per_wo:        'e.g. 14   (max 14 labor hrs on this WO)',
      max_hours_per_10_carts:  'e.g. 12   (max 12 hrs per 10 carts)',
    })[form.rule_type] || 'e.g. 12';
    return `
      <h3>Add a custom rule</h3>
      <p class="help">Layered on top of built-in policy. Violations show as flags on submitted invoices.</p>

      <span class="label">Rule type</span>
      <select class="field" id="rt">
        ${Object.entries(RULE_TYPES).map(([k, v]) => `<option value="${k}" ${k===form.rule_type?'selected':''}>${v.label}</option>`).join('')}
      </select>
      <div class="help" style="margin-top: -8px;">${escapeHTML(meta.desc || '')}</div>

      <span class="label">Threshold (${escapeHTML(meta.unit || '')})</span>
      <input class="field" id="rThresh" type="number" step="0.01" min="0" value="${form.threshold}" placeholder="${escapeHTML(placeholder)}" />

      <span class="label">Apply to work type</span>
      <select class="field" id="rWt">
        <option value="" ${!form.work_type_filter?'selected':''}>All work types</option>
        ${WT_OPTIONS.map(wt => `<option value="${escapeHTML(wt)}" ${form.work_type_filter===wt?'selected':''}>${escapeHTML(workTypeLabel(wt))} only</option>`).join('')}
      </select>

      ${showCartFilter ? `
        <span class="label">Minimum cart count (optional)</span>
        <input class="field" id="rCarts" type="number" step="1" min="0" value="${form.cart_count_min}" placeholder="e.g. 10  (only WOs with 10+ carts)" />
        <div class="help" style="margin-top: -8px;">Leave blank to apply to every WO regardless of size.</div>
      ` : ''}

      ${showCategoryFilter ? `
        <span class="label">Apply to expense category (optional)</span>
        <select class="field" id="rCat">
          <option value="">All categories</option>
          <option value="mileage"  ${form.category_filter==='mileage'?'selected':''}>Mileage</option>
          <option value="tolls"    ${form.category_filter==='tolls'?'selected':''}>Tolls</option>
          <option value="parking"  ${form.category_filter==='parking'?'selected':''}>Parking</option>
          <option value="vendor"   ${form.category_filter==='vendor'?'selected':''}>Vendor</option>
          <option value="other"    ${form.category_filter==='other'?'selected':''}>Other</option>
        </select>
      ` : ''}

      <span class="label">Severity</span>
      <div class="chips" id="sevChips">
        <span class="chip ${form.severity==='warn'?'selected':''}"  data-sev="warn">Warn</span>
        <span class="chip ${form.severity==='flag'?'selected':''}"  data-sev="flag">Flag (default)</span>
        <span class="chip ${form.severity==='block'?'selected':''}" data-sev="block">Block submit</span>
      </div>

      <span class="label">Description (optional)</span>
      <input class="field" id="rDesc" placeholder="e.g. Per Wakefern contract: max 12 hr shifts" value="${escapeHTML(form.description)}" />

      <div class="actions">
        <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
        <button class="btn btn-primary" id="rSave">Add rule</button>
      </div>
    `;
  }

  showSheet(html(), {
    onMount: (wrap) => {
      const rerender = () => {
        // Preserve user input across re-render when changing rule type
        const t  = $('#rThresh', wrap)?.value;   if (t  != null) form.threshold = t;
        const w  = $('#rWt', wrap)?.value;       if (w  != null) form.work_type_filter = w;
        const cm = $('#rCarts', wrap)?.value;    if (cm != null) form.cart_count_min = cm;
        const ct = $('#rCat', wrap)?.value;      if (ct != null) form.category_filter = ct;
        const d  = $('#rDesc', wrap)?.value;     if (d  != null) form.description = d;
        wrap.querySelector('.sheet').innerHTML = `<div class="sheet-handle"></div>${html()}`;
        bindAll();
      };
      function bindAll() {
        $('#rt', wrap).addEventListener('change', e => { form.rule_type = e.target.value; rerender(); });
        $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
        $$('.chip[data-sev]', wrap).forEach(c => c.addEventListener('click', () => { form.severity = c.dataset.sev; rerender(); }));
        $('#rSave', wrap).addEventListener('click', async () => {
          form.threshold        = $('#rThresh', wrap).value;
          form.work_type_filter = $('#rWt', wrap).value;
          form.category_filter  = $('#rCat', wrap)?.value || '';
          form.cart_count_min   = $('#rCarts', wrap)?.value || '';
          form.description      = $('#rDesc', wrap).value;
          if (!form.threshold || Number(form.threshold) <= 0) return toast('Enter a positive threshold', 'err');
          try {
            await api('/rules', { method: 'POST', body: {
              rule_type:        form.rule_type,
              work_type_filter: form.work_type_filter || null,
              category_filter:  form.category_filter || null,
              cart_count_min:   form.cart_count_min === '' ? null : Number(form.cart_count_min),
              threshold:        Number(form.threshold),
              description:      form.description || null,
              severity:         form.severity,
            }});
            toast('Rule added ✓', 'ok');
            closeSheet();
            goto('policy');
          } catch (e) { toast(e.message, 'err'); }
        });
      }
      bindAll();
    },
  });
}

function renderPolicyEditor(pol) {
  const e = pol.effective;
  const isOver = (k) => pol.overrides && pol.overrides[k] ? `<span style="color: var(--ic-green-deep); font-size: 10px; margin-left: 6px;">customized</span>` : '';
  return `
    <div class="section-title">Policy engine</div>
    <div class="card">
      <p class="help" style="margin: 0 0 14px;">Org-wide rules used when validating expenses and computing invoices. Defaults are hard-coded; overrides saved here take effect immediately for everyone.</p>

      <div class="flex gap-12">
        <div style="flex: 1;">
          <span class="label">Default hourly rate ($)${isOver('policy_hourly_rate_default')}</span>
          <input class="field" id="pol_hourly" type="number" step="0.5" min="0" value="${e.HOURLY_RATE_DEFAULT}" />
        </div>
        <div style="flex: 1;">
          <span class="label">Mileage rate ($/mi)${isOver('policy_mileage_rate')}</span>
          <input class="field" id="pol_mileage" type="number" step="0.001" min="0" value="${e.MILEAGE_RATE}" />
        </div>
      </div>

      <div class="flex gap-12">
        <div style="flex: 1;">
          <span class="label">Meal daily cap ($)${isOver('policy_meal_daily_cap')}</span>
          <input class="field" id="pol_meal_cap" type="number" step="1" min="0" value="${e.MEAL_DAILY_CAP}" />
        </div>
        <div style="flex: 1;"></div>
      </div>
      <p class="help" style="margin-top: 4px;">Hours-overrun thresholds come from the <strong>per-work-type baselines</strong> below (enforced automatically) plus any <strong>custom rules</strong> for finer per-cart-count control. A custom hours rule overrides the baseline for that work type.</p>

      <span class="label">Meal eligibility — minimum trip hours${isOver('policy_meal_trip_min_hours')}</span>
      <input class="field" id="pol_meal_min" type="number" step="0.5" min="0" value="${e.MEAL_TRIP_MIN_HOURS}" />
      <div class="help" style="margin-top: -8px;">Trips shorter than this can't claim a meal.</div>

      <span class="label">AP recipient email${isOver('policy_ap_email')}</span>
      <input class="field" id="pol_ap_email" type="email" value="${escapeHTML(e.AP_EMAIL || '')}" placeholder="ap@instacart.com" />
      <div class="help" style="margin-top: -8px;">Default destination for the &quot;Send to AP&quot; action. Each send can override this.</div>

      <div style="font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; margin: 18px 0 8px; font-weight: 600;">Max hours per 10 carts by work type</div>
      <p class="help" style="margin: 0 0 10px;">Enforced as the default cap per work type — a WO line flags when its actual hrs / 10 carts exceeds this. Add a custom rule below to override the baseline for a specific work type or cart-count band.</p>
      <div class="flex gap-12">
        <div style="flex: 1;">
          <span class="label">Deployment <span style="color:var(--muted);font-weight:400">(hrs / 10 carts)</span>${isOver('policy_hours_per_10_carts_deployment')}</span>
          <input class="field" id="pol_hpc_dpl" type="number" step="0.5" min="0" value="${e.HOURS_PER_10_CARTS.deployment}" />
        </div>
        <div style="flex: 1;">
          <span class="label">Retrofit <span style="color:var(--muted);font-weight:400">(hrs / 10 carts)</span>${isOver('policy_hours_per_10_carts_retrofit')}</span>
          <input class="field" id="pol_hpc_rtr" type="number" step="0.5" min="0" value="${e.HOURS_PER_10_CARTS.retrofit}" />
        </div>
      </div>
      <div class="flex gap-12">
        <div style="flex: 1;">
          <span class="label">Maintenance <span style="color:var(--muted);font-weight:400">(hrs / 10 carts)</span>${isOver('policy_hours_per_10_carts_maintenance')}</span>
          <input class="field" id="pol_hpc_mnt" type="number" step="0.5" min="0" value="${e.HOURS_PER_10_CARTS.maintenance}" />
        </div>
        <div style="flex: 1;">
          <span class="label">Repair <span style="color:var(--muted);font-weight:400">(hrs / 10 carts)</span>${isOver('policy_hours_per_10_carts_repair')}</span>
          <input class="field" id="pol_hpc_rpr" type="number" step="0.5" min="0" value="${e.HOURS_PER_10_CARTS.repair}" />
        </div>
      </div>

      <button class="btn btn-primary btn-block" id="savePolicy" style="margin-top: 14px;">Save policy</button>
    </div>
  `;
}

async function openManualTimeSheet(opts = {}) {
  const wos = await api('/workorders');
  const open = wos.filter(w => ['open','in_progress','completed'].includes(w.status));
  // If we were called from a pinned invoice (e.g. the upload flow), default
  // the date inside its period so the entry attaches to that draft.
  let dISO;
  if (opts.period?.start && opts.period?.end) {
    const today = new Date(); const todayIso = today.toISOString().slice(0,10);
    dISO = (todayIso >= opts.period.start && todayIso <= opts.period.end)
      ? todayIso
      : opts.period.end;
  } else {
    const today = new Date(); const yest = new Date(today); yest.setDate(yest.getDate() - 1);
    dISO = yest.toISOString().slice(0,10);
  }

  showSheet(`
    <h3>Log a past shift${opts.invoiceId ? ` <span style="color: var(--ic-orange); font-size: 12px; font-weight: 400;">(pinned to this invoice)</span>` : ''}</h3>
    <p class="help">Forgot to clock in? Log it retroactively. The hours go to the invoice covering that week (a draft is created automatically if needed).</p>

    ${opts.period ? `
      <div class="alert info" style="margin-bottom: 10px;">
        <span class="ico">📌</span>
        <div class="body" style="font-size: 12px;">Date locked to <strong>${escapeHTML(opts.period.start)} → ${escapeHTML(opts.period.end)}</strong> so this entry lands on the draft you just opened.</div>
      </div>
    ` : ''}

    <span class="label">Work order</span>
    <select class="field" id="mtWO">
      ${open.map(w => `<option value="${w.id}">${escapeHTML(w.external_id)} — ${escapeHTML(w.store_name || '')}</option>`).join('')}
    </select>

    <span class="label">Date</span>
    <input class="field" id="mtDate" type="date" value="${dISO}" max="${todayISO()}"
      ${opts.period?.start ? `min="${escapeHTML(opts.period.start)}"` : ''}
      ${opts.period?.end   ? `max="${escapeHTML(opts.period.end)}"`   : ''} />

    <div class="flex gap-12">
      <div style="flex:1;">
        <span class="label">Start time</span>
        <input class="field" id="mtStart" type="time" value="08:00" />
      </div>
      <div style="flex:1;">
        <span class="label">End time</span>
        <input class="field" id="mtEnd" type="time" value="16:00" />
      </div>
    </div>

    <div class="flex gap-12">
      <div style="flex:1;">
        <span class="label">Hour type</span>
        <select class="field" id="mtMode">
          <option value="work">Labor hours</option>
          <option value="drive">Drive hours</option>
        </select>
      </div>
      <div style="flex:1;">
        <span class="label">Break (min)</span>
        <input class="field" id="mtBreak" type="number" min="0" max="240" value="30" />
      </div>
    </div>

    <span class="label">Notes</span>
    <input class="field" id="mtNotes" placeholder="e.g., logged after the fact" />

    <div class="actions">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      <button class="btn btn-primary" id="mtSave">Save shift</button>
    </div>
  `, {
    onMount: (wrap) => {
      $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);
      $('#mtSave', wrap).addEventListener('click', async () => {
        const wo_id = Number($('#mtWO', wrap).value);
        const date  = $('#mtDate', wrap).value;
        const start = $('#mtStart', wrap).value;
        const end   = $('#mtEnd', wrap).value;
        const breaks = Number($('#mtBreak', wrap).value) || 0;
        const mode   = $('#mtMode',  wrap).value || 'work';
        const notes  = $('#mtNotes', wrap).value || null;
        if (!wo_id || !date || !start || !end) return toast('Fill all fields', 'err');
        const ci = new Date(`${date}T${start}:00`);
        const co = new Date(`${date}T${end}:00`);
        if (co <= ci) return toast('End must be after start', 'err');
        try {
          await api('/timeentries', { method: 'POST', body: {
            work_order_id: wo_id,
            clock_in: ci.toISOString(),
            clock_out: co.toISOString(),
            break_minutes: breaks,
            mode,
            notes,
          }});
          // If the date is in a previous week, make sure that week's invoice exists.
          if (date < weekStartISO()) {
            await api('/invoices/for-week', { method: 'POST', body: { week_of: date } });
          }
          toast('Shift logged ✓', 'ok');
          closeSheet();
          if (opts.invoiceId) goto('invDetail', opts.invoiceId);
          else                goto('mine');
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

function weekStartISO() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  return d.toISOString().slice(0,10);
}

function openRateSheet(currentRate) {
  showSheet(`
    <h3>Hourly labor rate</h3>
    <p class="help">Common rates: $40 (standard contractor), $45 (GlideRite std), $65 (GlideRite accelerated), $20 (Advatix). Saved on your profile and used for all future labor.</p>
    <span class="label">Hourly rate ($)</span>
    <input class="field" id="rateInp" type="number" step="0.50" min="0" max="500" value="${currentRate}" />
    <div class="actions">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      <button class="btn btn-primary" id="rateSave">Save</button>
    </div>
  `, {
    onMount: (wrap) => {
      $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);
      $('#rateSave', wrap).addEventListener('click', async () => {
        const r = Number($('#rateInp', wrap).value);
        if (!isFinite(r) || r < 0) return toast('Enter a valid rate', 'err');
        try {
          await api('/me', { method: 'PATCH', body: { hourly_rate: r } });
          STATE.user = await api('/me');  // refresh
          toast(`Rate set to $${r.toFixed(2)}/hr ✓`, 'ok');
          closeSheet();
          goto('invoice');
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

function invoiceLineHTML(l, allAttachments = []) {
  const attsForExpense = (eid) => allAttachments.filter(a => a.expense_id === eid);
  return `
    <div class="card" data-line="${escapeHTML(l.external_id)}">
      <div class="flex between">
        <div>
          <div class="wo-id">${escapeHTML(l.external_id)}</div>
          <div class="wo-source">${sourceLabel(l.source_system)} · ${workTypeLabel(l.work_type)} · ${l.cart_count} carts</div>
          <div style="font-size:12px;color:var(--ink-2);margin-top:4px">${escapeHTML(l.store_name || '')}</div>
        </div>
        ${l.flags.length ? `<span class="badge flagged">Flagged</span>` : `<span class="badge approved">OK</span>`}
      </div>

      ${l.labor_hours ? `
        <div style="margin-top:10px;">
          <div class="exp-item">
            <div>
              <strong>Labor</strong> <span class="amt">${l.labor_hours} hrs · ${fmt$(l.labor_amount)}</span>
              <div class="meta">${(l.expected_hours || 0).toFixed(1)} hrs expected for ${l.cart_count} carts</div>
            </div>
            <div class="ctrl">
              <button class="btn btn-ghost" data-act="edit-time" data-wo="${escapeHTML(l.external_id)}">Edit</button>
            </div>
          </div>
        </div>
      ` : ''}

      ${l.expenses.length ? l.expenses.map(e => {
        const atts = attsForExpense(e.id);
        return `
          <div class="exp-item" style="flex-wrap:wrap;">
            <div style="flex:1; min-width: 0;">
              <strong>${capitalize(e.category)}${e.subcategory ? ' · ' + escapeHTML(e.subcategory) : ''}</strong> <span class="amt">${fmt$(e.amount)}</span>
              ${e.quantity ? `<span class="meta"> · ${e.quantity}${e.category==='mileage'?' mi':''}</span>` : ''}
              <div class="meta">${fmtDate(e.expense_date)}${e.description ? ` · ${escapeHTML(e.description)}` : ''}${atts.length ? ` · 📎 ${atts.length} receipt${atts.length>1?'s':''}` : ''}</div>
              ${atts.length ? `<div class="exp-thumbs">${atts.map(thumbInlineHTML).join('')}</div>` : ''}
            </div>
            <div class="ctrl">
              <button class="btn btn-ghost" data-act="edit-exp" data-id="${e.id}">Edit</button>
              <button class="btn btn-danger" data-act="del-exp" data-id="${e.id}">×</button>
            </div>
          </div>
        `;
      }).join('') : ''}

      <div class="card-row" style="font-weight:700; padding-top:10px; margin-top:6px;">
        <span>Subtotal</span><span class="amt">${fmt$(l.total)}</span>
      </div>

      ${l.flags.map(f => alertHTML('err', '!', escapeHTML(f.message))).join('')}
    </div>
  `;
}

function bindLineActions(timeEntries, expenses) {
  $$('[data-act="edit-exp"]').forEach(b => b.addEventListener('click', () => {
    const exp = expenses.find(e => e.id === Number(b.dataset.id));
    if (exp) openEditExpenseSheet(exp);
  }));
  $$('[data-act="del-exp"]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this expense?')) return;
    try {
      await api(`/expenses/${b.dataset.id}`, { method: 'DELETE' });
      toast('Deleted ✓', 'ok');
      goto('invoice');
    } catch (e) { toast(e.message, 'err'); }
  }));
  $$('[data-act="edit-time"]').forEach(b => b.addEventListener('click', () => {
    const ext = b.dataset.wo;
    // edit all time entries for this WO (simplest: list + edit one at a time)
    const entries = timeEntries.filter(t => t.external_id === ext);
    openEditTimeSheet(ext, entries);
  }));
}

// ---- EDITABLE LINE ITEMS LIST ----
// Renders every time entry and expense on the invoice as an inline-editable
// row, grouped by date. Used in editable mode (tech-self draft + manager
// proxy mode). Each row has Edit + Delete buttons that hit the existing
// /timeentries/:id and /expenses/:id endpoints.
// v0.64.3 — compact "live preview" panel for the side-by-side manager review.
// Shows the running invoice total + component breakdown so an Ops Manager sees
// how their line-item edits reflect without scrolling to the full invoice.
function renderInvoicePreviewPanel(p) {
  const row = (label, val, strong) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--border);font-size:13px;"><span style="color:var(--secondary-text);">${label}</span><span style="${strong ? 'font-weight:700;' : ''}">${val}</span></div>`;
  return `
    <div class="card" style="margin-top:14px;">
      <div style="font-size:11px;color:var(--secondary-text);text-transform:uppercase;letter-spacing:.5px;">Live invoice total</div>
      <div style="font-size:30px;font-weight:800;color:var(--ic-green-deep,#0a7d4d);margin:2px 0 4px;">${fmt$(p.total)}</div>
      <div style="font-size:11px;color:var(--secondary-text);margin-bottom:8px;">Updates as you edit · ${p.itemCount} line item${p.itemCount === 1 ? '' : 's'}</div>
      ${row('Labour', `${fmtHrs(p.laborHours)} · ${fmt$(p.labor)}`)}
      ${p.mileage > 0 ? row('Mileage', fmt$(p.mileage)) : ''}
      ${p.other > 0.005 ? row('Other expenses', fmt$(p.other)) : ''}
      ${row('Total', fmt$(p.total), true)}
      ${p.flags > 0 ? `<div style="margin-top:10px;padding:8px 10px;border-radius:8px;background:#fdecea;color:#c0392b;font-size:12px;font-weight:600;">⚠ ${p.flags} policy flag${p.flags === 1 ? '' : 's'} on this invoice</div>` : ''}
      <div style="margin-top:10px;font-size:11px;color:var(--secondary-text);">Status: ${escapeHTML(labelForStatus(p.status))}</div>
    </div>`;
}

function renderEditableLineItems(by_date, invoice, opts = {}) {
  if (!by_date || !by_date.length) {
    return `
      <div class="card" style="margin-top: 14px;">
        <div class="section-title" style="margin-top: 0;">Line items (editable)</div>
        <div class="empty" style="padding: 14px; font-size: 12px;">
          No line items on this draft yet. Use the buttons below to add time or expenses, or upload a PDF to auto-import.
        </div>
      </div>
    `;
  }

  return `
    <div class="card" style="margin-top: 14px;">
      <div class="section-title" style="margin-top: 0;">Line items (editable)</div>
      <p class="help" style="margin: 0 0 12px;">Tap any row to edit, or × to delete. Changes save immediately.</p>
      ${by_date.map(d => {
        const labor   = (d.time_entries || []).slice().sort((a,b) => new Date(a.clock_in) - new Date(b.clock_in));
        const drive   = (d.drive_entries || []).slice().sort((a,b) => new Date(a.clock_in) - new Date(b.clock_in));
        const expRows = (d.expense_entries || []);
        if (!labor.length && !drive.length && !expRows.length) return '';
        return `
          <div class="ed-day">
            <div class="ed-day-head">${fmtLongDate(d.date)}</div>
            ${labor.map(t => editTimeRowHTML(t, invoice, false, opts)).join('')}
            ${drive.map(t => editTimeRowHTML(t, invoice, true, opts)).join('')}
            ${expRows.map(e => editExpenseRowHTML(e, invoice, opts)).join('')}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function editTimeRowHTML(t, invoice, isDrive, opts = {}) {
  const start = t.clock_in  ? new Date(t.clock_in ).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) : '';
  const end   = t.clock_out ? new Date(t.clock_out).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) : '';
  const hrs   = t.hours || 0;
  const amt   = isDrive ? 0 : hrs * (invoice.hourly_rate || 40);
  return `
    <div class="ed-row ${isDrive ? 'ed-drive' : ''}">
      <div class="ed-row-icon">${isDrive ? '🚗' : '⏱'}</div>
      <div class="ed-row-body">
        <div class="ed-row-title">
          <strong>${escapeHTML(t.external_id || '')}</strong>
          ${t.store_name ? ` · <span class="meta">${escapeHTML(t.store_name)}</span>` : ''}
        </div>
        <div class="meta">${start} → ${end} · ${hrs.toFixed(2)} hrs ${isDrive ? '(drive, non-billable)' : ''}</div>
        ${t.notes ? `<div class="ed-row-notes">${escapeHTML(t.notes)}</div>` : ''}
        ${(!opts.readOnly && ['ops_manager','sr_manager','pm'].includes(STATE.user?.role)) ? `<div style="margin-top:6px;">${renderUnplannedTagBtn('time_entry', t.id, t.unplanned_tag, t.unplanned_note, amt, t.unplanned_wasted)}</div>${unplannedNoteLine(t.unplanned_tag, t.unplanned_note)}${unplannedSplitLine(t.unplanned_tag, t.unplanned_wasted, amt)}` : ''}
      </div>
      <div class="ed-row-amt">${isDrive ? '—' : fmt$(amt)}</div>
      <div class="ed-row-acts">
        ${(() => {
          // v0.68 — Ops/Sr/PM managers can EDIT a line item's value in the
          // review working copy (where hideTimeEditDelete normally hides the
          // tech-facing edit/delete). Editing recomputes the invoice total and
          // notifies the tech (see PATCH /timeentries). Delete stays draft-only
          // for the tech — managers correct values, they don't remove logged
          // work mid-review (and the server blocks deleting a submitted entry).
          const isMgr = ['ops_manager','sr_manager','pm'].includes(STATE.user?.role);
          const showEdit   = !opts.readOnly && (!opts.hideTimeEditDelete || isMgr);
          const showDelete = !opts.readOnly && !opts.hideTimeEditDelete;
          return `
            ${showEdit   ? `<button class="btn-icon" title="${isMgr ? 'Edit value' : 'Edit'}" data-edit-time="${t.id}">✏️</button>` : ''}
            ${showDelete ? `<button class="btn-icon btn-icon-danger" title="Delete" data-del-time="${t.id}">×</button>` : ''}
          `;
        })()}
      </div>
    </div>
  `;
}

function editExpenseRowHTML(e, invoice, opts = {}) {
  const cat = capitalize(e.category || '');
  const sub = e.subcategory ? ` · ${escapeHTML(e.subcategory)}` : '';
  const qty = e.quantity ? ` · ${e.quantity} ${e.category === 'mileage' ? 'mi' : ''}` : '';
  // v0.59 — render attached receipts inline so the tech can see the image
  // next to the line item right in the draft summary.
  const atts = Array.isArray(e.attachments) ? e.attachments : [];
  const thumbs = atts.length
    ? `<div class="exp-thumbs" style="margin-top:6px;">${atts.map(thumbInlineHTML).join('')}</div>`
    : '';
  return `
    <div class="ed-row ed-expense">
      <div class="ed-row-icon">${({mileage:'🚙',tolls:'🚏',parking:'🅿️',vendor:'🏪',other:'•'})[e.category] || '•'}</div>
      <div class="ed-row-body">
        <div class="ed-row-title">
          <strong>${escapeHTML(cat)}${sub}</strong>
          ${e.external_id ? ` · <span class="meta">${escapeHTML(e.external_id)}</span>` : ''}
        </div>
        <div class="meta">${e.store_name ? escapeHTML(e.store_name) + qty : (qty || '').replace(/^ · /, '')}</div>
        ${e.description ? `<div class="ed-row-notes">${escapeHTML(e.description)}</div>` : ''}
        ${thumbs}
        ${(!opts.readOnly && ['ops_manager','sr_manager','pm'].includes(STATE.user?.role)) ? `<div style="margin-top:6px;">${renderUnplannedTagBtn('expense', e.id, e.unplanned_tag, e.unplanned_note, e.amount, e.unplanned_wasted)}</div>${unplannedNoteLine(e.unplanned_tag, e.unplanned_note)}${unplannedSplitLine(e.unplanned_tag, e.unplanned_wasted, e.amount)}` : ''}
      </div>
      <div class="ed-row-amt">${fmt$(e.amount || 0)}</div>
      <div class="ed-row-acts">
        ${opts.readOnly ? '' : `
        <button class="btn-icon" title="Edit" data-edit-exp="${e.id}">✏️</button>
        <button class="btn-icon btn-icon-danger" title="Delete" data-del-exp="${e.id}">×</button>`}
      </div>
    </div>
  `;
}

// Single-entry edit sheet for one time entry (loads it fresh from the API
// so we always edit the latest values, regardless of what was rendered).
// v0.68 — fetch the entry by id (GET /timeentries/:id) so an Ops Mgr reviewing
// a SUBMITTED invoice can edit a tech's entry — the list endpoint is owner-/
// proxy-scoped and wouldn't return it in review mode. Also adds a direct
// "Hours" field so a manager can set the billable value without reverse-
// engineering the end time; we translate it back to a clock_out the server
// validates and the invoice total recomputes from (PATCH /timeentries).
async function openEditOneTimeSheet(timeEntryId) {
  let t;
  try {
    t = await api(`/timeentries/${timeEntryId}`);
  } catch (e) { return toast(e.message === 'not found' ? 'Time entry not found' : e.message, 'err'); }
  if (!t) return toast('Time entry not found', 'err');

  const dateISO = (t.clock_in || '').slice(0, 10);
  const startT  = (t.clock_in || '').slice(11, 16);
  const endT    = (t.clock_out || '').slice(11, 16);
  // Current billable hours (server returns it computed; fall back to derive).
  const curHours = (t.hours != null && isFinite(+t.hours))
    ? +t.hours
    : (t.clock_in && t.clock_out
        ? Math.max(0, ((new Date(t.clock_out) - new Date(t.clock_in)) - (t.break_minutes || 0) * 60000) / 3600000)
        : 0);
  // Is a manager editing someone else's entry? Drives the "tech is notified" hint.
  const editingOthers = ['ops_manager','sr_manager','pm'].includes(STATE.user?.role)
    && t.user_id !== STATE.user?.id;

  showSheet(`
    <h3>Edit time entry</h3>
    <p class="help" style="margin-top:-4px;">Linked to ${escapeHTML(t.external_id || 'WO')} · ${escapeHTML(t.store_name || '')}</p>
    ${editingOthers ? `<div class="alert" style="margin:0 0 10px;font-size:12px;background:#fff7ef;border:1px solid var(--ic-orange);color:var(--ic-orange-deep);padding:8px 10px;border-radius:8px;">Saving updates the invoice total and notifies the technician that this value changed.</div>` : ''}

    <span class="label">Date</span>
    <input class="field" id="te_date" type="date" value="${dateISO}" />

    <div class="flex gap-12">
      <div style="flex:1;">
        <span class="label">Start</span>
        <input class="field" id="te_start" type="time" value="${startT}" />
      </div>
      <div style="flex:1;">
        <span class="label">End</span>
        <input class="field" id="te_end" type="time" value="${endT}" />
      </div>
    </div>

    <span class="label">Hours${(t.mode||'work')==='drive' ? '' : ' (billable)'}</span>
    <input class="field" id="te_hours" type="number" min="0" max="24" step="0.25" value="${+curHours.toFixed(2)}" />
    <p class="help" style="margin-top:-6px;">Set hours directly — the end time updates to match. Leave the end time to drive it instead.</p>

    <div class="flex gap-12">
      <div style="flex:1;">
        <span class="label">Break (min)</span>
        <input class="field" id="te_break" type="number" min="0" max="240" value="${t.break_minutes || 0}" />
      </div>
      <div style="flex:1;">
        <span class="label">Mode</span>
        <select class="field" id="te_mode">
          <option value="work"  ${(t.mode||'work')==='work'?'selected':''}>Work / labor</option>
          <option value="drive" ${t.mode==='drive'?'selected':''}>Drive</option>
        </select>
      </div>
    </div>

    <span class="label">Notes</span>
    <textarea class="field" id="te_notes" rows="2">${escapeHTML(t.notes || '')}</textarea>

    <div class="actions">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      <button class="btn btn-primary" id="te_save">Save</button>
    </div>
  `, {
    onMount: (wrap) => {
      $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
      // Format a Date as a naive local datetime string — same wall-clock frame
      // as the clock_in we send, so the server computes the duration tz-safely.
      const pad = n => String(n).padStart(2, '0');
      const toNaiveLocal = dt =>
        `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:00`;
      const endDateFromHours = () => {
        const d = $('#te_date', wrap).value, s = $('#te_start', wrap).value;
        const h = parseFloat($('#te_hours', wrap).value);
        const bm = Number($('#te_break', wrap).value) || 0;
        if (!d || !s || !isFinite(h) || h <= 0) return null;
        const start = new Date(`${d}T${s}:00`);
        if (isNaN(start)) return null;
        return new Date(start.getTime() + bm * 60000 + h * 3600000);
      };
      // Two-way sync (setting .value doesn't fire 'input', so no loop).
      $('#te_hours', wrap).addEventListener('input', () => {
        const end = endDateFromHours();
        if (end) $('#te_end', wrap).value = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
      });
      const syncHoursFromTimes = () => {
        const d = $('#te_date', wrap).value, s = $('#te_start', wrap).value, e = $('#te_end', wrap).value;
        const bm = Number($('#te_break', wrap).value) || 0;
        if (!d || !s || !e) return;
        let end = new Date(`${d}T${e}:00`); const start = new Date(`${d}T${s}:00`);
        if (isNaN(end) || isNaN(start)) return;
        if (end <= start) end = new Date(end.getTime() + 24*3600000); // crossed midnight
        const h = Math.max(0, ((end - start) - bm * 60000) / 3600000);
        $('#te_hours', wrap).value = +h.toFixed(2);
      };
      ['te_start','te_end','te_break'].forEach(id =>
        $('#'+id, wrap).addEventListener('input', syncHoursFromTimes));
      $('#te_save', wrap).addEventListener('click', async () => {
        const d  = $('#te_date',  wrap).value;
        const s  = $('#te_start', wrap).value;
        const e  = $('#te_end',   wrap).value;
        const bm = Number($('#te_break', wrap).value) || 0;
        const md = $('#te_mode',  wrap).value;
        const n  = $('#te_notes', wrap).value;
        if (!d || !s) return toast('Date and start time required', 'err');
        // Prefer the explicit Hours value (handles entries that cross midnight);
        // otherwise fall back to the end-time field.
        const hoursStr = $('#te_hours', wrap).value;
        const hoursVal = parseFloat(hoursStr);
        let clockOut;
        if (hoursStr !== '' && isFinite(hoursVal) && hoursVal > 0) {
          const endDt = endDateFromHours();
          if (!endDt) return toast('Could not compute end time from hours', 'err');
          clockOut = toNaiveLocal(endDt);
        } else {
          clockOut = e ? `${d}T${e}:00` : null;
        }
        const body = {
          clock_in:      `${d}T${s}:00`,
          clock_out:     clockOut,
          break_minutes: bm,
          mode:          md,
          notes:         n,
        };
        try {
          await api(`/timeentries/${t.id}`, { method: 'PATCH', body });
          toast(editingOthers ? 'Saved ✓ — technician notified' : 'Saved ✓', 'ok');
          closeSheet();
          goto('invDetail', t.invoice_id);
        } catch (er) { toast(er.message, 'err'); }
      });
    }
  });
}

function openEditExpenseSheet(exp) {
  const isMileage = exp.category === 'mileage';
  // v0.54 — surface labor + drive (hour-based) and keep vendor available for
  // PDF-imported / Ops-Mgr-created expenses (so existing rows can still be
  // edited without losing their category).
  const EDIT_CATS = ['mileage','labor','drive','tolls','parking','meals','tools','vendor','other'];
  showSheet(`
    <h3>Edit expense</h3>
    <span class="label">Category</span>
    <select class="field" id="ecat">
      ${EDIT_CATS.map(c => `<option value="${c}" ${c===exp.category?'selected':''}>${capitalize(c)}</option>`).join('')}
    </select>

    <span class="label">Date</span>
    <input class="field" id="edate" type="date" value="${exp.expense_date}" />

    <div id="amtBlock">
      ${renderAmtBlock(exp.category, exp)}
    </div>

    <span class="label">Description</span>
    <input class="field" id="edesc" value="${escapeHTML(exp.description || '')}" />

    <span class="label" style="margin-top: 6px;">Receipts</span>
    <div id="expAtts" class="attach-list"></div>
    <div id="expAttPicker" style="margin-bottom: 14px;"></div>

    <div class="actions">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      <button class="btn btn-primary" id="saveExp">Save</button>
    </div>
  `, {
    onMount: async (wrap) => {
      function renderBlock(cat) {
        $('#amtBlock', wrap).innerHTML = renderAmtBlock(cat, exp);
      }
      $('#ecat', wrap).addEventListener('change', e => renderBlock(e.target.value));
      $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);

      // Show existing receipts + provide picker for new ones
      const refresh = async () => {
        const list = await api(`/attachments?expense_id=${exp.id}`);
        $('#expAtts', wrap).innerHTML = list.length
          ? list.map(a => attachmentItemHTML(a)).join('')
          : `<div class="attach-empty">No receipts attached yet.</div>`;
      };
      await refresh();
      makeReceiptPicker($('#expAttPicker', wrap), {
        label: '📷 Add receipt',
        onFile: async (payload) => {
          try {
            await uploadReceipt(payload, { expense_id: exp.id });
            toast('Receipt attached ✓', 'ok');
            await refresh();
          } catch (e) { toast(e.message, 'err'); }
        },
      });

      $('#saveExp', wrap).addEventListener('click', async () => {
        const cat = $('#ecat', wrap).value;
        const body = {
          category: cat,
          expense_date: $('#edate', wrap).value,
          description: $('#edesc', wrap).value,
        };
        if (cat === 'mileage') {
          body.quantity = Number($('#eqty', wrap)?.value);
          if (!body.quantity) return toast('Enter miles', 'err');
        } else if (cat === 'labor' || cat === 'drive') {
          body.quantity = Number($('#eqty', wrap)?.value);
          if (!body.quantity) return toast('Enter hours', 'err');
          // server recomputes amount from quantity × hourly rate (labor) or 0 (drive)
        } else {
          body.amount = Number($('#eamt', wrap)?.value);
          if (!body.amount) return toast('Enter amount', 'err');
        }
        try {
          // v0.68.1 — return to the invoice this expense actually belongs to
          // (e.g. a custom-period draft), not always the current week's invoice.
          // Mirrors the time-entry edit (goto invDetail, t.invoice_id). The old
          // goto('invoice') loaded /invoices/current, so editing an expense on a
          // custom-period invoice bounced the user to the current/submitted week
          // — the edit saved fine but appeared to "show the submitted invoice"
          // and never reflected the change on the custom invoice.
          const updated = await api(`/expenses/${exp.id}`, { method: 'PATCH', body });
          toast('Saved ✓', 'ok');
          closeSheet();
          const backInvId = updated?.invoice_id ?? exp.invoice_id;
          if (backInvId) goto('invDetail', backInvId);
          else           goto('invoice');
        } catch (e) { toast(e.message, 'err'); }
      });
    }
  });
}

function renderAmtBlock(cat, exp) {
  if (cat === 'mileage') {
    return `<span class="label">Miles</span>
      <input class="field" id="eqty" type="number" step="0.1" min="0" value="${exp.category==='mileage'?(exp.quantity||''):''}" placeholder="32.4" />
      <div class="help">Auto-computed: miles × $0.725 (locked).</div>`;
  }
  if (cat === 'labor' || cat === 'drive') {
    // v0.55 — both labor and drive are billable hours × hourly rate.
    const seedHrs = (cat === exp.category) ? (exp.quantity || '') : '';
    const hint = cat === 'labor'
      ? `Auto-computed: hours × hourly rate ($${(STATE.user?.hourly_rate || 40).toFixed(2)}/hr). Adds to labor total.`
      : `Auto-computed: hours × hourly rate ($${(STATE.user?.hourly_rate || 40).toFixed(2)}/hr). Adds to billable drive hours.`;
    return `<span class="label">Hours</span>
      <input class="field" id="eqty" type="number" step="0.25" min="0" value="${seedHrs}" placeholder="2.5" />
      <div class="help">${hint}</div>`;
  }
  return `<span class="label">Amount ($)</span>
      <input class="field" id="eamt" type="number" step="0.01" min="0" value="${(exp.category!=='mileage' && exp.category!=='labor' && exp.category!=='drive')?(exp.amount||''):''}" placeholder="0.00" />`;
}

function entriesHaveGps(entries) {
  return entries.some(t => (t.gps_lat_in && t.gps_lng_in) || (t.gps_lat_out && t.gps_lng_out));
}

function drawWoMap(containerId, entries) {
  const el = document.getElementById(containerId);
  if (!el || !window.L) return;
  if (window._woMap) { try { window._woMap.remove(); } catch {} window._woMap = null; }
  const map = L.map(el, { zoomControl: true, scrollWheelZoom: false });
  window._woMap = map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OSM', maxZoom: 19,
  }).addTo(map);

  // Build chronological points (in + out) so we can render multi-stop routes
  const sorted = [...entries].sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in));
  const points = [];
  for (const t of sorted) {
    const mode = t.mode || 'work';
    const dur  = t.clock_out ? ((new Date(t.clock_out) - new Date(t.clock_in)) / 3600000).toFixed(2) : 'running';
    if (t.gps_lat_in != null && t.gps_lng_in != null) {
      points.push({ lat: t.gps_lat_in, lng: t.gps_lng_in, when: t.clock_in, kind: 'in',  mode, dur });
    }
    if (t.gps_lat_out != null && t.gps_lng_out != null) {
      points.push({ lat: t.gps_lat_out, lng: t.gps_lng_out, when: t.clock_out, kind: 'out', mode, dur });
    }
  }

  // Distance summary
  let distM = 0;
  for (let i = 1; i < points.length; i++) distM += haversineKm(points[i-1], points[i]) * 1000;
  const distMi = (distM / 1609.344).toFixed(2);

  // Draw colored polyline segments (color by the mode of the *originating* entry)
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1], q = points[i];
    L.polyline([[p.lat, p.lng], [q.lat, q.lng]], {
      color: p.mode === 'drive' ? '#F36D00' : '#43B02A',
      weight: 4, opacity: 0.85, dashArray: p.mode === 'drive' ? '8 6' : null,
    }).addTo(map);
  }

  // Render markers — number them in chronological order so it's obvious
  // there are multiple stops per shift.
  const bounds = [];
  points.forEach((p, idx) => {
    const label = `${idx + 1}`;
    const klass = p.kind === 'in' ? 'in' : 'out';
    const m = L.marker([p.lat, p.lng], { icon: woMapIcon(label, klass, p.mode) }).addTo(map);
    m.bindPopup(`
      <strong>${p.kind === 'in' ? '⏳ Started' : '✓ Stopped'} ${p.mode === 'drive' ? '🚗 Drive' : '🛠 Work'}</strong><br/>
      ${new Date(p.when).toLocaleString()}<br/>
      Duration: ${p.dur} hrs
    `);
    bounds.push([p.lat, p.lng]);
  });

  if (bounds.length === 1) map.setView(bounds[0], 15);
  else if (bounds.length)  map.fitBounds(bounds, { padding: [40, 40] });
  setTimeout(() => map.invalidateSize(), 100);

  // Render distance overlay/footer outside the map element
  const distEl = document.getElementById(containerId + '-dist');
  if (distEl) {
    const wMin = sorted.filter(t => (t.mode || 'work') === 'work').reduce((s,t) => s + entryMinutes(t), 0);
    const dMin = sorted.filter(t => t.mode === 'drive').reduce((s,t) => s + entryMinutes(t), 0);
    distEl.innerHTML = `
      <span><strong>${(wMin/60).toFixed(2)}</strong> hrs work</span> ·
      <span><strong>${(dMin/60).toFixed(2)}</strong> hrs drive</span> ·
      <span><strong>${distMi}</strong> mi · ${points.length} stop${points.length===1?'':'s'}</span>
    `;
  }
}

function woMapIcon(label, kind, mode) {
  const colorClass = mode === 'drive' ? 'drive' : 'work';
  return L.divIcon({
    className: '',
    html: `<div class="map-marker ${kind} ${colorClass}"><span class="lbl">${label}</span></div>`,
    iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -26],
  });
}

function entryMinutes(t) {
  const start = new Date(t.clock_in).getTime();
  const end   = t.clock_out ? new Date(t.clock_out).getTime() : Date.now();
  return Math.max(0, (end - start) / 60000 - (t.break_minutes || 0));
}
function haversineKm(a, b) {
  const R = 6371, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const aa = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(aa));
}

function openEditTimeSheet(extId, entries) {
  if (!entries.length) {
    toast('No time entries on this WO yet', 'err');
    return;
  }
  showSheet(`
    <h3>Time entries — ${escapeHTML(extId)}</h3>
    <p class="help">Adjust break minutes or notes. Hours are derived from your clock in/out timestamps.</p>
    ${entriesHaveGps(entries) ? `
      <div class="section-title" style="margin-top: 6px;">Route &amp; stops for ${escapeHTML(extId)}</div>
      <div id="woMap" style="height: 280px; border-radius: var(--radius-md); border: 1px solid var(--line); margin-bottom: 6px; overflow: hidden;"></div>
      <div id="woMap-dist" style="font-size: 13px; color: var(--ink-2); text-align: center; padding: 6px 0 12px;"></div>
      <div style="font-size: 11px; color: var(--muted); text-align: center; margin-bottom: 12px;">
        <span style="display:inline-block; width:10px; height:10px; background: var(--ic-green); border-radius:50%; margin-right: 4px;"></span>Work time &nbsp;
        <span style="display:inline-block; width:10px; height:10px; background: var(--ic-orange); border-radius:50%; margin: 0 4px 0 8px;"></span>Drive time
      </div>
    ` : ''}

    ${entries.map(t => `
      <div class="card" style="margin-bottom:10px;">
        <div class="flex between">
          <div>
            <strong>${new Date(t.clock_in).toLocaleDateString()}</strong>
            <div class="meta">${new Date(t.clock_in).toLocaleTimeString()} → ${t.clock_out ? new Date(t.clock_out).toLocaleTimeString() : 'running'}</div>
          </div>
          <span class="badge ${t.clock_out ? 'gray' : 'pending'}">${t.clock_out ? 'Done' : 'Running'}</span>
        </div>
        ${gpsChip(t.gps_lat_in, t.gps_lng_in, t.gps_accuracy_in, 'Clocked in')}
        ${t.clock_out ? gpsChip(t.gps_lat_out, t.gps_lng_out, t.gps_accuracy_out, 'Clocked out') : ''}
        <div style="margin-top:10px;">
          <span class="label">Break (min)</span>
          <input class="field" type="number" min="0" max="240" data-bm="${t.id}" value="${t.break_minutes || 0}" />
          <span class="label">Notes</span>
          <input class="field" data-nt="${t.id}" value="${escapeHTML(t.notes || '')}" placeholder="e.g., shelf damage on 2 carts" />
          <div class="actions">
            <button class="btn btn-danger btn-sm" data-del-time="${t.id}" ${!t.clock_out?'disabled':''}>Delete</button>
            <button class="btn btn-primary btn-sm" data-save-time="${t.id}">Save</button>
          </div>
        </div>
      </div>
    `).join('')}
    <button class="btn btn-ghost btn-block" data-act="sheet-close">Close</button>
  `, {
    onMount: (wrap) => {
      $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
      $$('[data-save-time]', wrap).forEach(b => b.addEventListener('click', async () => {
        const id = b.dataset.saveTime;
        const bm = Number($(`[data-bm="${id}"]`, wrap).value) || 0;
        const nt = $(`[data-nt="${id}"]`, wrap).value;
        try {
          await api(`/timeentries/${id}`, { method: 'PATCH', body: { break_minutes: bm, notes: nt } });
          toast('Saved ✓', 'ok');
          closeSheet();
          goto('invoice');
        } catch (e) { toast(e.message, 'err'); }
      }));
      $$('[data-del-time]', wrap).forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this time entry?')) return;
        try {
          await api(`/timeentries/${b.dataset.delTime}`, { method: 'DELETE' });
          toast('Deleted ✓', 'ok');
          closeSheet();
          goto('invoice');
        } catch (e) { toast(e.message, 'err'); }
      }));
      // Draw the per-WO map if any entries have GPS captured
      if (entriesHaveGps(entries)) drawWoMap('woMap', entries);
    }
  });
}

function capitalize(s) { s = (s == null) ? '' : String(s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function fmtDate(s) { if (!s) return ''; const d = new Date(s); return d.toLocaleDateString(undefined, { month:'short', day:'numeric' }); }
function fmtShortDate(s) { if (!s) return ''; const d = new Date(s); return `${d.getDate()}-${d.toLocaleDateString('en-US', { month: 'short' })}`; }
function fmtMonthDay(s)  { if (!s) return ''; const d = new Date(s); return `${d.getMonth()+1}/${d.getDate()}`; }
function fmtLongDate(s)  { if (!s) return ''; const d = new Date(s); return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }); }
function escapeHTML(s) { return (s || '').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }
function enumerateWeekDays(start, end) {
  const out = []; const d = new Date(start), e = new Date(end);
  while (d <= e) { out.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
  return out;
}
function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b/1024).toFixed(0)} KB`;
  return `${(b/1024/1024).toFixed(1)} MB`;
}

// ---- Attachments / receipts ----
function attachmentURL(att) {
  // v0.35 — pass session token via query param (the auth middleware accepts ?token=).
  const token = localStorage.getItem(STORAGE_TOKEN_KEY) || '';
  return `/api/attachments/${att.id}/download?token=${encodeURIComponent(token)}`;
}
function attachmentItemHTML(att, { canDelete = true } = {}) {
  const isImg = (att.mime_type || '').startsWith('image/');
  return `
    <div class="attach-item" data-att="${att.id}">
      <div class="thumb">${isImg ? `<img src="${attachmentURL(att)}" alt=""/>` : (att.mime_type === 'application/pdf' ? '📄' : '📎')}</div>
      <div class="meta">
        <div class="name">${escapeHTML(att.original_name)}</div>
        <div class="sub">${fmtSize(att.size_bytes)}${att.caption ? ` · ${escapeHTML(att.caption)}` : ''}</div>
      </div>
      <div class="ctrl">
        <a class="btn btn-ghost btn-sm" href="${attachmentURL(att)}" target="_blank" rel="noopener">View</a>
        ${canDelete ? `<button class="btn btn-danger btn-sm" data-act="del-att" data-id="${att.id}">×</button>` : ''}
      </div>
    </div>
  `;
}

// Small inline thumb shown next to a line item
function thumbInlineHTML(att) {
  const isImg = (att.mime_type || '').startsWith('image/');
  return `
    <a class="exp-thumb" href="${attachmentURL(att)}" target="_blank" rel="noopener" title="${escapeHTML(att.original_name)}" data-att-id="${att.id}">
      ${isImg ? `<img src="${attachmentURL(att)}" alt=""/>` : (att.mime_type === 'application/pdf' ? '📄' : '📎')}
    </a>
  `;
}

// Larger gallery thumb (80px) used at top of invoice
function galleryThumbHTML(att, ctx) {
  const isImg = (att.mime_type || '').startsWith('image/');
  return `
    <a class="gthumb" href="${attachmentURL(att)}" target="_blank" rel="noopener" title="${escapeHTML(att.original_name)}">
      ${isImg ? `<img src="${attachmentURL(att)}" alt=""/>` : (att.mime_type === 'application/pdf' ? '📄' : '📎')}
      <span class="lbl">${escapeHTML(ctx)}</span>
    </a>
  `;
}

// Returns a hidden file <input> + the trigger button. Inserts both into `parent`.
// onFile(payload) is called once a file is read and ready to upload.
function makeReceiptPicker(parent, { label = '📷 Attach receipt', accept = 'image/*,application/pdf,.heic', multiple = false, onFile }) {
  const id = `f${Math.random().toString(36).slice(2,9)}`;
  const html = `
    <input type="file" id="${id}" accept="${accept}" ${multiple ? 'multiple' : ''} style="display:none;" />
    <button type="button" class="attach-btn" data-trigger="${id}">${label}</button>
  `;
  parent.insertAdjacentHTML('beforeend', html);
  const input = parent.querySelector(`#${id}`);
  parent.querySelector(`[data-trigger="${id}"]`).addEventListener('click', () => input.click());
  input.addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      const data_b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(',')[1]);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      await onFile({ filename: file.name, mime_type: file.type || 'application/octet-stream', data_b64 });
    }
    input.value = '';
  });
}

async function uploadReceipt({ filename, mime_type, data_b64 }, link) {
  return api('/attachments', { method: 'POST', body: { filename, mime_type, data_b64, ...link } });
}

// Generic delete handler used wherever attachment items are rendered
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act="del-att"]');
  if (!btn) return;
  if (!confirm('Remove this attachment?')) return;
  try {
    await api(`/attachments/${btn.dataset.id}`, { method: 'DELETE' });
    btn.closest('.attach-item')?.remove();
    toast('Removed ✓', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

// ---- MAP (deprecated tab; kept for compatibility, no longer wired in nav) ----
let _leafletInstance;
async function renderMap(root) {
  const all = await api('/timeentries');
  // Only entries with at least one GPS coord captured
  const withGps = all.filter(t => (t.gps_lat_in && t.gps_lng_in) || (t.gps_lat_out && t.gps_lng_out));

  // Filter chips: All / This week / Last 30d
  let scope = 'week';
  const weekStart = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1)); d.setHours(0,0,0,0); return d; })();
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
  const inScope = (t) => {
    const d = new Date(t.clock_in);
    if (scope === 'week') return d >= weekStart;
    if (scope === 'month') return d >= monthAgo;
    return true;
  };

  function html() {
    const filtered = withGps.filter(inScope);
    return `
      <div class="map-wrap">
        <div class="card" style="padding: 10px 12px;">
          <div style="font-size: 12px; color: var(--ink-2); margin-bottom: 8px;">
            ${withGps.length} of ${all.length} time entries have a captured location.
          </div>
          <div class="chips" style="margin-bottom: 0;">
            <span class="chip ${scope==='week'?'selected':''}"  data-scope="week">This week</span>
            <span class="chip ${scope==='month'?'selected':''}" data-scope="month">Last 30 days</span>
            <span class="chip ${scope==='all'?'selected':''}"   data-scope="all">All time</span>
          </div>
        </div>

        ${filtered.length === 0
          ? `<div class="map-empty">📍 No GPS-captured shifts ${scope === 'week' ? 'this week' : 'in this range'} yet.<br/>
              Locations are captured automatically when you clock in/out (browser permission required).</div>`
          : `<div id="leafletMap"></div>`}

        ${filtered.length ? `
          <div class="card" style="padding:10px 12px;">
            <div style="font-size:11px; color: var(--muted); text-transform: uppercase; letter-spacing:0.5px; margin-bottom:6px;">Legend</div>
            <div style="display:flex; gap: 14px; font-size:12px;">
              <span><span style="display:inline-block; width:10px;height:10px;border-radius:50%; background: var(--ic-green); vertical-align:middle; margin-right:5px;"></span>Clock-in</span>
              <span><span style="display:inline-block; width:10px;height:10px;border-radius:50%; background: var(--ic-orange); vertical-align:middle; margin-right:5px;"></span>Clock-out</span>
            </div>
          </div>` : ''}

        ${filtered.length ? `
          <div class="section-title">Shifts on the map</div>
          ${filtered.map(t => {
            const dur = t.clock_out ? ((new Date(t.clock_out) - new Date(t.clock_in)) / 3600000).toFixed(2) : '—';
            return `
              <div class="card" style="padding: 10px 12px;">
                <div class="flex between">
                  <div>
                    <strong>${escapeHTML(t.external_id)}</strong>
                    <div class="meta">${escapeHTML(t.store_name || '')} · ${new Date(t.clock_in).toLocaleString()}</div>
                  </div>
                  <div class="meta">${dur} hrs</div>
                </div>
                ${t.gps_lat_in  ? gpsChip(t.gps_lat_in,  t.gps_lng_in,  t.gps_accuracy_in,  'Clock-in')  : ''}
                ${t.gps_lat_out ? gpsChip(t.gps_lat_out, t.gps_lng_out, t.gps_accuracy_out, 'Clock-out') : ''}
              </div>
            `;
          }).join('')}
        ` : ''}
      </div>
    `;
  }

  function bind() {
    $$('[data-scope]').forEach(c => c.addEventListener('click', () => {
      scope = c.dataset.scope;
      mount();
    }));
  }

  function mount() {
    root.innerHTML = html();
    bind();
    drawMap();
  }

  function drawMap() {
    const el = document.getElementById('leafletMap');
    if (!el || !window.L) return;
    if (_leafletInstance) { _leafletInstance.remove(); _leafletInstance = null; }

    const filtered = withGps.filter(inScope);
    if (!filtered.length) return;

    const map = L.map(el, { zoomControl: true, scrollWheelZoom: true });
    _leafletInstance = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    const bounds = [];
    for (const t of filtered) {
      const dur = t.clock_out ? ((new Date(t.clock_out) - new Date(t.clock_in)) / 3600000).toFixed(2) : 'running';
      if (t.gps_lat_in && t.gps_lng_in) {
        const m = L.marker([t.gps_lat_in, t.gps_lng_in], { icon: customIcon('IN', 'in') }).addTo(map);
        m.bindPopup(`
          <strong>${escapeHTML(t.external_id)}</strong><br/>
          ${escapeHTML(t.store_name || '')}<br/>
          <em>Clocked in</em> ${new Date(t.clock_in).toLocaleString()}<br/>
          Duration: ${dur} hrs
        `);
        bounds.push([t.gps_lat_in, t.gps_lng_in]);
      }
      if (t.gps_lat_out && t.gps_lng_out) {
        const m = L.marker([t.gps_lat_out, t.gps_lng_out], { icon: customIcon('OUT', 'out') }).addTo(map);
        m.bindPopup(`
          <strong>${escapeHTML(t.external_id)}</strong><br/>
          ${escapeHTML(t.store_name || '')}<br/>
          <em>Clocked out</em> ${t.clock_out ? new Date(t.clock_out).toLocaleString() : ''}<br/>
          Duration: ${dur} hrs
        `);
        bounds.push([t.gps_lat_out, t.gps_lng_out]);
        // Connect clock-in to clock-out with a line
        if (t.gps_lat_in && t.gps_lng_in) {
          L.polyline([[t.gps_lat_in, t.gps_lng_in], [t.gps_lat_out, t.gps_lng_out]], {
            color: '#003D29', weight: 2, opacity: 0.6, dashArray: '6 4',
          }).addTo(map);
        }
      }
    }
    if (bounds.length === 1) map.setView(bounds[0], 15);
    else                     map.fitBounds(bounds, { padding: [40, 40] });
  }

  function customIcon(label, kind) {
    return L.divIcon({
      className: '',
      html: `<div class="map-marker ${kind}"><span class="lbl">${label}</span></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 28],
      popupAnchor: [0, -24],
    });
  }

  mount();
}

// ============================================================
// OPS MANAGER / SR MANAGER VIEWS
// ============================================================

// v0.68 — Pending "add work orders to a submitted week" requests, shown at the
// top of the Ops Mgr / Sr Mgr approval queue with approve/deny actions.
function addReqSectionHTML(addReqs) {
  if (!addReqs || !addReqs.length) return '';
  return `
    <div class="card" style="margin-bottom:14px;border-left:4px solid var(--ic-orange);background:#fff8f0;">
      <div class="section-title" style="margin-top:0;">＋ Add-work-order requests (${addReqs.length})</div>
      <p class="help" style="margin:0 0 10px;">A technician asked to add work orders to a week they already submitted. Approve to generate a new supplemental invoice for that week, or deny with a reason — either way the tech is notified.</p>
      ${addReqs.map(rq => `
        <div class="card" style="background:#fff;margin-bottom:10px;">
          <div style="font-weight:700;">${escapeHTML(rq.tech_name || 'Technician')}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px;">${escapeHTML(rq.source_invoice_number || '')} · week ${fmtDate(rq.period_start)} → ${fmtDate(rq.period_end)}</div>
          <div style="font-size:13px;margin-top:6px;"><strong>Work orders:</strong> ${escapeHTML(rq.requested_wos || '')}</div>
          ${rq.note ? `<div style="font-size:12px;color:var(--ink-2);margin-top:4px;">📝 ${escapeHTML(rq.note)}</div>` : ''}
          <div class="actions" style="margin-top:10px;flex-wrap:wrap;">
            <button class="btn btn-danger btn-sm" data-addreq-deny="${rq.id}">Deny</button>
            <button class="btn btn-primary btn-sm" data-addreq-approve="${rq.id}">Approve &amp; create invoice</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function wireAddReqButtons() {
  $$('[data-addreq-approve]').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Approve this request? A new supplemental invoice will be created for that week with the requested work orders.')) return;
    b.disabled = true;
    try {
      const r = await api(`/addition-requests/${b.dataset.addreqApprove}/approve`, { method: 'POST' });
      toast(`Approved ✓ — created ${r.new_invoice?.invoice_number || 'new invoice'}`, 'ok');
      goto('queue');
    } catch (err) { b.disabled = false; toast(err.message, 'err'); }
  }));
  $$('[data-addreq-deny]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = b.dataset.addreqDeny;
    showSheet(`
      <h3>Deny add-work-orders request?</h3>
      <p class="help">The technician will get this reason and a notification.</p>
      <span class="label">Reason (required, min 5 chars)</span>
      <textarea class="field" id="denyReason" rows="4" placeholder="e.g., These WOs belong to next week — file them on that invoice instead."></textarea>
      <div class="actions">
        <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
        <button class="btn btn-danger" id="confirmDeny">Deny &amp; notify tech</button>
      </div>
    `, {
      onMount: (wrap) => {
        $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);
        $('#confirmDeny', wrap).addEventListener('click', async () => {
          const reason = $('#denyReason', wrap).value.trim();
          if (reason.length < 5) return toast('Add a reason (at least 5 chars)', 'err');
          try {
            await api(`/addition-requests/${id}/deny`, { method: 'POST', body: { reason } });
            closeSheet();
            toast('Denied · tech notified', 'ok');
            goto('queue');
          } catch (e2) { toast(e2.message, 'err'); }
        });
      }
    });
  }));
}

// v0.68 — One add-WO request row as the tech sees it (status + decision detail).
function addReqStatusHTML(rq) {
  const badge = rq.status === 'approved'
    ? `<span class="badge" style="background:var(--ok-bg,#e8f6ea);color:var(--ic-green-deep);font-weight:700;">Approved</span>`
    : rq.status === 'denied'
    ? `<span class="badge" style="background:var(--err-bg);color:var(--err-fg);font-weight:700;">Not approved</span>`
    : `<span class="badge" style="background:var(--ic-cream);color:var(--ic-green-deep);font-weight:700;">Pending review</span>`;
  return `
    <div class="card" style="background:#fafafa;margin-bottom:8px;">
      <div class="flex between" style="align-items:center;">
        <span style="font-size:12px;color:var(--muted);">${new Date(rq.created_at).toLocaleDateString()}</span>
        ${badge}
      </div>
      <div style="font-size:13px;margin-top:4px;"><strong>WOs:</strong> ${escapeHTML(rq.requested_wos || '')}</div>
      ${rq.note ? `<div style="font-size:12px;color:var(--ink-2);margin-top:2px;">📝 ${escapeHTML(rq.note)}</div>` : ''}
      ${rq.status === 'approved' && rq.new_invoice_id ? `
        <div style="margin-top:8px;font-size:13px;">✅ New invoice created: <a href="#" data-go-inv="${rq.new_invoice_id}"><strong>${escapeHTML(rq.new_invoice_number || ('#'+rq.new_invoice_id))}</strong></a> — open it to add hours/expenses and submit.</div>
      ` : ''}
      ${rq.status === 'denied' ? `
        <div style="margin-top:8px;font-size:13px;color:var(--err-fg);">✗ Not approved${rq.decided_by_name ? ' by ' + escapeHTML(rq.decided_by_name) : ''}.${rq.decision_reason ? ' Reason: ' + escapeHTML(rq.decision_reason) : ''}</div>
      ` : ''}
    </div>
  `;
}

// v0.68 — Tech sheet: file a request to add work orders to a locked week.
function openRequestAddWoSheet(invoice) {
  showSheet(`
    <h3>Request to add work orders</h3>
    <p class="help">Week of ${fmtDate(invoice.period_start)} → ${fmtDate(invoice.period_end)}. List the work orders you need to add (ticket #s or WO IDs — comma or new-line separated). Your Ops Manager reviews this; if approved, a new invoice is created for this week with these work orders.</p>
    <span class="label">Work orders to add</span>
    <textarea class="field" id="addWoList" rows="3" placeholder="e.g. 12816, 12827   or   MX-RPR-97461873"></textarea>
    <span class="label" style="margin-top:10px;">Note for your manager (optional)</span>
    <textarea class="field" id="addWoNote" rows="2" placeholder="e.g. Two extra stores I covered Friday that weren't on the original invoice."></textarea>
    <div class="actions">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      <button class="btn btn-primary" id="addWoSubmit">Send request</button>
    </div>
  `, {
    onMount: (wrap) => {
      $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);
      $('#addWoSubmit', wrap).addEventListener('click', async () => {
        const wos = $('#addWoList', wrap).value.trim();
        const note = $('#addWoNote', wrap).value.trim();
        if (!wos) return toast('List at least one work order', 'err');
        try {
          await api(`/invoices/${invoice.id}/request-additional-wos`, { method: 'POST', body: { wos, note: note || undefined } });
          closeSheet();
          toast('Request sent ✓ — your Ops Manager will review it', 'ok');
          goto('invDetail', invoice.id);
        } catch (e) { toast(e.message, 'err'); }
      });
    }
  });
}

async function renderApprovalQueue(root) {
  const [queue, addReqs] = await Promise.all([
    api('/approvals/queue'),
    api('/addition-requests/queue').catch(() => []),
  ]);
  // CTA at the top: two buckets — backfill a tech's invoice OR file a 3rd-party vendor invoice.
  const uploadCard = `
    <div class="card" style="background: var(--ic-cream); border: 0; padding: 14px; margin-bottom: 14px;">
      <div style="font-size: 11px; color: var(--ic-green-deep); text-transform: uppercase; letter-spacing: 0.6px; font-weight: 700;">Backfill an invoice</div>
      <div style="font-size: 13px; color: var(--ink-2); margin: 4px 0 10px;">Got a PDF or photo from a contractor? Upload it, edit the line items, and route it through approval.</div>
      <div class="flex gap-12" style="flex-wrap: wrap;">
        <button class="btn btn-warn btn-sm" id="uploadInvBtn">＋ Tech / contractor invoice</button>
        <button class="btn btn-primary btn-sm" id="vendorInvBtn">＋ 3rd-party vendor invoice</button>
      </div>
    </div>
  `;
  const role  = STATE.user.role;
  const isSrView = role === 'sr_manager' || role === 'pm';
  // v0.67 — Sr Mgr / PM keep full visibility of every approved_ops invoice, but
  // only escalated tech invoices + submitted vendor invoices still need their
  // action; the rest are review-only (Ops approval is final).
  const actionCount     = queue.filter(i => i.action_needed).length;
  const reviewOnlyCount = queue.length - actionCount;
  const subjectLabel = role === 'ops_manager' ? 'submitted by your team' :
                       isSrView               ? 'flowing through for your visibility' :
                                                'awaiting sign-off';

  if (!queue.length) {
    root.innerHTML = `
      ${role === 'ops_manager' ? uploadCard : ''}
      ${addReqSectionHTML(addReqs)}
      ${addReqs.length ? '' : `
      <div class="empty">
        <div class="big">✓</div>
        Nothing in the queue right now.<br/>
        <span style="font-size: 12px;">Invoices ${escapeHTML(subjectLabel)} will appear here.</span>
      </div>`}
    `;
    if (role === 'ops_manager') $('#uploadInvBtn')?.addEventListener('click', openUploadInvoiceSheet);
    $('#vendorInvBtn')?.addEventListener('click', openVendorInvoiceSheet);
    wireAddReqButtons();
    return;
  }

  const totalValue = queue.reduce((s, i) => s + (i.total || 0), 0);
  // v0.58 — count invoices with policy-engine flag violations (not just notes).
  // Server now decorates each row with flag_count / flag_rules / flag_preview.
  const flaggedCount = queue.filter(i => (i.flag_count || 0) > 0).length;
  const totalFlags   = queue.reduce((s, i) => s + (i.flag_count || 0), 0);

  root.innerHTML = `
    ${role === 'ops_manager' ? uploadCard : ''}
    ${addReqSectionHTML(addReqs)}
    <div class="card" style="background: var(--ic-green-deep); color: #fff; border: 0;">
      <div class="flex between" style="align-items: center;">
        <div>
          <div class="label" style="color: #b5e8a3;">${escapeHTML(isSrView ? 'Invoices in review' : 'Pending your approval')}</div>
          <div style="font-size: 28px; font-weight: 800; margin-top: 4px;">${queue.length} <span style="font-size: 14px; font-weight: 500; color: #cde9c9;">invoice${queue.length===1?'':'s'}</span></div>
          ${isSrView ? `<div style="font-size: 11px; color: #cde9c9; margin-top: 4px;">${actionCount} need your action · ${reviewOnlyCount} review-only</div>` : ''}
        </div>
        <div style="text-align: right;">
          <div class="label" style="color: #b5e8a3;">Queue value</div>
          <div style="font-size: 22px; font-weight: 700;">${fmt$(totalValue)}</div>
          ${flaggedCount ? `<div style="font-size: 11px; color: #ffc89a; margin-top: 4px;">⚠ ${flaggedCount} invoice${flaggedCount===1?'':'s'} with policy flags · ${totalFlags} total</div>` : ''}
        </div>
      </div>
    </div>

    <div class="card-grid">
      ${queue.map(inv => {
        const ageDays = inv.submitted_at ? Math.floor((Date.now() - new Date(inv.submitted_at)) / 86400000) : 0;
        const aging = ageDays >= 3;
        // v0.58 — surface policy-engine flag annotations on every queue card.
        const hasFlags = (inv.flag_count || 0) > 0;
        const borderColor = hasFlags ? 'var(--err-fg)' : (aging ? 'var(--ic-orange)' : '');
        return `
          <div class="card tap" data-inv="${inv.id}" style="${borderColor ? `border-left: 4px solid ${borderColor};` : ''}">
            <div class="flex between" style="align-items: flex-start;">
              <div style="flex: 1; min-width: 0;">
                <div class="flex" style="align-items: center; gap: 8px; flex-wrap: wrap;">
                  <span style="font-weight: 700; font-size: 15px;">${escapeHTML(inv.tech_name)}</span>
                  ${hasFlags ? `<span class="badge" style="background: var(--err-bg); color: var(--err-fg); font-weight: 700;">⚠ ${inv.flag_count} flag${inv.flag_count===1?'':'s'}</span>` : ''}
                  ${isSrView ? (inv.action_needed
                    ? `<span class="badge" style="background: var(--ic-orange); color: #fff; font-weight: 700;">Action needed</span>`
                    : `<span class="badge" style="background: var(--ic-cream); color: var(--ic-green-deep); font-weight: 700;">Review only</span>`) : ''}
                </div>
                <div style="font-size: 12px; color: var(--muted); margin-top: 4px;">${inv.invoice_number} · ${fmtDate(inv.period_start)} → ${fmtDate(inv.period_end)}</div>
                ${hasFlags ? `
                  <div style="font-size: 11px; color: var(--err-fg); margin-top: 6px; background: var(--err-bg); border-radius: 6px; padding: 6px 8px;">
                    <strong>Policy violations:</strong> ${(inv.flag_rules || []).map(r => r.replace(/_/g, ' ')).join(', ')}
                    ${inv.flag_preview ? `<div style="margin-top: 4px; color: var(--ink-2); font-style: italic;">${escapeHTML(inv.flag_preview)}</div>` : ''}
                  </div>
                ` : ''}
                ${inv.escalated_at ? `<div style="font-size: 11px; color: var(--ic-orange); margin-top: 6px; font-weight: 600;">⤴ Escalated by Ops Mgr — needs your countersign</div>` : ''}
                ${inv.notes ? `<div style="font-size: 12px; color: var(--warn-fg); margin-top: 6px;">📝 ${escapeHTML(inv.notes.slice(0, 120))}${inv.notes.length > 120 ? '…' : ''}</div>` : ''}
                ${aging ? `<div style="font-size: 11px; color: var(--ic-orange); margin-top: 6px; font-weight: 600;">⏰ ${ageDays} days in queue</div>` : ''}
              </div>
              <div style="text-align: right;">
                <div style="font-size: 20px; font-weight: 700;">${fmt$(inv.total)}</div>
                <div class="meta">${inv.tech_worker_type || ''}</div>
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  $$('.card.tap[data-inv]').forEach(c => c.addEventListener('click', () => goto('invDetail', Number(c.dataset.inv))));
  $('#uploadInvBtn')?.addEventListener('click', openUploadInvoiceSheet);
  $('#vendorInvBtn')?.addEventListener('click', openVendorInvoiceSheet);
  wireAddReqButtons();
}

// ---- VENDOR INVOICE UPLOAD (v0.36, manager-only) ----
// 3rd-party vendor invoice. v0.65.2 — any manager (Ops / Sr / PM) can approve
// it (Sr Mgr approval is optional); the creator still can't self-approve.
function openVendorInvoiceSheet() {
  let pendingFile = null;
  function html() {
    const isPdf = pendingFile && /pdf/i.test(pendingFile.mime_type || '') || /\.pdf$/i.test(pendingFile?.filename || '');
    return `
      <h3>+ 3rd-party vendor invoice</h3>
      <p class="help">Upload the vendor's invoice or statement (PDF preferred). We'll parse it for vendor, invoice #, date, and total — you'll review and edit anything that's wrong on the next screen.</p>

      <span class="label">Vendor invoice file (PDF or photo)</span>
      <div id="vnFilePicker"></div>
      ${pendingFile ? `
        <div class="attach-item" style="margin-bottom: 10px;">
          <div class="thumb">${(pendingFile.mime_type || '').startsWith('image/') ? '📷' : '📄'}</div>
          <div class="meta">
            <div class="name">${escapeHTML(pendingFile.filename)}</div>
            <div class="sub">${fmtSize(Math.round(pendingFile.data_b64.length * 3 / 4))} · ${isPdf ? 'will auto-parse' : 'image — fill fields below'}</div>
          </div>
          <button class="btn btn-ghost btn-sm" id="vnClearFile">×</button>
        </div>
      ` : ''}

      <details ${pendingFile ? '' : 'open'} style="margin-top: 14px;">
        <summary style="cursor: pointer; font-weight: 600; font-size: 13px; color: var(--ink-2);">
          ${pendingFile && isPdf ? 'Override extracted values (optional)' : 'Manual entry (skip if uploading a PDF)'}
        </summary>
        <div style="margin-top: 10px; padding: 12px; background: #fafbfc; border-radius: 8px;">
          <span class="label">Vendor name</span>
          <input class="field" id="vnName" placeholder="Sbot Technologies LLC" />

          <div class="flex gap-12" style="margin-top: 8px;">
            <div style="flex:2;">
              <span class="label">Vendor invoice #</span>
              <input class="field" id="vnNum" placeholder="SBOT-0042" />
            </div>
            <div style="flex:1;">
              <span class="label">Invoice date</span>
              <input class="field" id="vnDate" type="date" />
            </div>
          </div>

          <span class="label" style="margin-top: 8px;">Total amount ($)</span>
          <input class="field" id="vnTotal" type="number" step="0.01" min="0" placeholder="3724.93" />

          <p class="help" style="margin-top: 8px; font-size: 11px;">Anything you fill here overrides the PDF. Leave blank to use what we extract.</p>
        </div>
      </details>

      <span class="label" style="margin-top: 12px;">Work category</span>
      <select class="field" id="vnCategory">
        <option value="">— pick one —</option>
        <option value="service">Service</option>
        <option value="deployment">Deployment</option>
        <option value="retrofit">Retrofit</option>
        <option value="repair">Repair</option>
        <option value="parts">Parts / Hardware</option>
        <option value="other">Other</option>
      </select>
      <p class="help" style="margin-top: 4px; font-size: 11px;">Tag the vendor invoice as deployment, retrofit, service, etc. so it rolls up alongside the regular service work in cost reports.</p>

      <span class="label" style="margin-top: 12px;">Notes (optional)</span>
      <textarea class="field" id="vnNotes" rows="2" placeholder="e.g., Apr 11–24 contractor work, aggregated"></textarea>

      <div class="actions">
        <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
        <button class="btn btn-primary" id="vnSave">${pendingFile && isPdf ? '📄 Parse PDF & open preview' : 'Create draft &rarr;'}</button>
      </div>
    `;
  }
  showSheet(html(), {
    onMount: (wrap) => {
      function rerender() { wrap.querySelector('.sheet').innerHTML = `<div class="sheet-handle"></div>${html()}`; bindAll(); }
      function bindAll() {
        $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
        $('#vnClearFile', wrap)?.addEventListener('click', () => { pendingFile = null; rerender(); });
        const fp = $('#vnFilePicker', wrap);
        if (fp && !pendingFile) {
          makeReceiptPicker(fp, {
            label: '📷 Attach vendor invoice (PDF or photo)',
            onFile: (payload) => { pendingFile = payload; rerender(); },
          });
        }
        $('#vnSave', wrap).addEventListener('click', async () => {
          const isPdf = pendingFile && (/pdf/i.test(pendingFile.mime_type || '') || /\.pdf$/i.test(pendingFile.filename));
          const body = {
            vendor_name:           $('#vnName',   wrap).value.trim() || undefined,
            vendor_invoice_number: $('#vnNum',    wrap).value.trim() || undefined,
            vendor_invoice_date:   $('#vnDate',   wrap).value         || undefined,
            total:                 Number($('#vnTotal', wrap).value) || undefined,
            notes:                 $('#vnNotes',  wrap).value.trim() || undefined,
            vendor_category:       $('#vnCategory', wrap).value      || undefined,
            attachment:            pendingFile,
          };
          // If no PDF, manual fields are required.
          if (!isPdf) {
            if (!body.vendor_name)           return toast('Vendor name required (or attach a PDF)', 'err');
            if (!body.vendor_invoice_number) return toast('Invoice # required (or attach a PDF)', 'err');
            if (!body.vendor_invoice_date)   return toast('Invoice date required (or attach a PDF)', 'err');
            if (!(body.total > 0))           return toast('Total required (or attach a PDF)', 'err');
          }
          const btn = $('#vnSave', wrap); btn.disabled = true; btn.textContent = '⏳ Parsing PDF…';
          try {
            const r = await api('/invoices/vendor-upload', { method: 'POST', body });
            const msg = r.auto_extracted
              ? `Parsed PDF ✓ — review extracted values, then submit`
              : `Draft created — review the preview, then submit ✓`;
            toast(msg, 'ok');
            closeSheet();
            goto('invDetail', r.id);
          } catch (e) {
            btn.disabled = false; btn.textContent = isPdf ? '📄 Parse PDF & open preview' : 'Create draft →';
            // If server returned a list of missing fields, give a useful error.
            const detail = e.response?.missing
              ? `Couldn't auto-detect: ${e.response.missing.join(', ')}. Fill them in the Manual entry section.`
              : (e.message || 'Upload failed');
            toast(detail, 'err');
          }
        });
      }
      bindAll();
    },
  });
}

// v0.38 — Edit a vendor invoice draft (vendor name, #, date, total, period, notes).
// PATCHes the row and re-renders invDetail so the preview shows the new values.
function openVendorEditSheet(invoice) {
  showSheet(`
    <h3>Edit vendor invoice details</h3>
    <p class="help" style="margin-bottom: 14px;">Adjust anything that needs fixing. Changes save when you click <strong>Save</strong>.</p>

    <span class="label">Vendor name</span>
    <input class="field" id="veName"  type="text" value="${escapeHTML(invoice.vendor_name || '')}" />

    <div class="flex gap-12" style="margin-top: 8px;">
      <div style="flex:1;">
        <span class="label">Vendor invoice #</span>
        <input class="field" id="veNum" type="text" value="${escapeHTML(invoice.vendor_invoice_number || '')}" />
      </div>
      <div style="flex:1;">
        <span class="label">Invoice date</span>
        <input class="field" id="veDate" type="date" value="${escapeHTML(invoice.vendor_invoice_date || '')}" />
      </div>
    </div>

    <span class="label" style="margin-top: 8px;">Total</span>
    <input class="field" id="veTotal" type="number" step="0.01" min="0" value="${invoice.total || ''}" />

    <span class="label" style="margin-top: 8px;">Work category</span>
    <select class="field" id="veCategory">
      ${[
        ['',           '— pick one —'],
        ['service',    'Service'],
        ['deployment', 'Deployment'],
        ['retrofit',   'Retrofit'],
        ['repair',     'Repair'],
        ['parts',      'Parts / Hardware'],
        ['other',      'Other'],
      ].map(([v,l]) => `<option value="${v}" ${invoice.vendor_category === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select>

    <div class="flex gap-12" style="margin-top: 8px;">
      <div style="flex:1;">
        <span class="label">Period start</span>
        <input class="field" id="vePeriodStart" type="date" value="${escapeHTML(invoice.period_start || '')}" />
      </div>
      <div style="flex:1;">
        <span class="label">Period end</span>
        <input class="field" id="vePeriodEnd" type="date" value="${escapeHTML(invoice.period_end || '')}" />
      </div>
    </div>

    <span class="label" style="margin-top: 8px;">Notes</span>
    <textarea class="field" id="veNotes" rows="3">${escapeHTML(invoice.notes || '')}</textarea>

    <div class="actions" style="margin-top: 14px;">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      <button class="btn btn-primary" id="veSave">💾 Save changes</button>
    </div>
  `, {
    onMount: (wrap) => {
      $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);
      $('#veSave', wrap).addEventListener('click', async () => {
        const body = {
          vendor_name:           $('#veName',         wrap).value.trim(),
          vendor_invoice_number: $('#veNum',          wrap).value.trim(),
          vendor_invoice_date:   $('#veDate',         wrap).value,
          total:                 Number($('#veTotal', wrap).value),
          vendor_category:       $('#veCategory',     wrap).value || null,
          period_start:          $('#vePeriodStart',  wrap).value || undefined,
          period_end:            $('#vePeriodEnd',    wrap).value || undefined,
          notes:                 $('#veNotes',        wrap).value.trim(),
        };
        if (!body.vendor_name)           return toast('Vendor name required', 'err');
        if (!body.vendor_invoice_number) return toast('Vendor invoice # required', 'err');
        if (!body.vendor_invoice_date)   return toast('Invoice date required', 'err');
        if (!(body.total > 0))           return toast('Enter a positive total', 'err');
        try {
          await api(`/invoices/${invoice.id}/vendor-update`, { method: 'PATCH', body });
          toast('Updated ✓', 'ok');
          closeSheet();
          goto('invDetail', invoice.id);
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

// Manager-only: paste invoice text → server extracts ticket candidates →
// manager picks which to Pull from FD/MX → creates WO records linked to this invoice.
// ---- EXTRACTED-FROM-PDF PANEL ----
// Rendered on the invoice detail when /invoices/:id returned an `extracted`
// summary (PDF was parsed at upload time). Shows side-by-side: what the PDF
// said vs what the draft currently totals to, plus actionable Pull&Link
// buttons for every detected ticket id.
function renderExtractedPanel(invoice, ext, extractedAt, computed) {
  const head     = ext.header || {};
  const cands    = ext.candidates || [];
  const items    = ext.line_items || [];
  const mileage  = ext.mileage || [];
  const tolls    = ext.tolls || [];
  const totals   = ext.totals || {};
  const totalMileageMi = mileage.reduce((a,m) => a + (m.total_miles || 0), 0);
  const totalTolls     = tolls.reduce((a,t) => a + (t.amount || 0), 0);
  const ext_total = totals.total ?? 0;
  const cur_total = computed?.total ?? 0;
  const totalDelta = +(ext_total - cur_total).toFixed(2);

  // Highlight period mismatch: the contractor's PDF period vs the invoice's
  // current period_start/end. If different, offer one-click apply.
  const periodMismatch = head.period &&
    (head.period.start !== invoice.period_start || head.period.end !== invoice.period_end);

  return `
    <div class="card extracted-panel" style="margin-top: 14px; border-left: 4px solid var(--ic-orange);">
      <div class="flex between" style="align-items: flex-start; margin-bottom: 8px;">
        <div>
          <div class="section-title" style="margin: 0;">📄 Extracted from PDF</div>
          <div class="meta" style="margin-top: 2px;">${extractedAt ? 'Parsed ' + new Date(extractedAt).toLocaleString() : ''}</div>
        </div>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-ghost btn-sm" id="importPdfBtn" title="Re-create line items from the parsed PDF (idempotent)">↻ Re-import</button>
          <button class="btn btn-ghost btn-sm" id="reextractBtn">↻ Re-parse</button>
        </div>
      </div>

      <p class="help" style="margin: 0 0 12px;">
        Review what we pulled from your PDF below. Fix anything wrong in the
        editable line items further down — hours, ticket #, mileage legs, tolls —
        then hit <strong>Review &amp; submit</strong> to send it to your Ops Manager.
      </p>

      ${head.full_name || head.invoice_number ? `
        <div class="ext-block">
          <div class="ext-block-title">Header detected</div>
          <div class="ext-grid">
            ${head.full_name      ? `<div><span class="ext-k">Name</span><span class="ext-v">${escapeHTML(head.full_name)}</span></div>` : ''}
            ${head.invoice_number ? `<div><span class="ext-k">Invoice #</span><span class="ext-v">${escapeHTML(head.invoice_number)}</span></div>` : ''}
            ${head.invoice_date   ? `<div><span class="ext-k">Invoice date</span><span class="ext-v">${escapeHTML(head.invoice_date)}</span></div>` : ''}
            ${head.phone          ? `<div><span class="ext-k">Phone</span><span class="ext-v">${escapeHTML(head.phone)}</span></div>` : ''}
            ${head.address        ? `<div style="grid-column: 1 / -1;"><span class="ext-k">Address</span><span class="ext-v">${escapeHTML(head.address)}</span></div>` : ''}
            ${head.period         ? `<div style="grid-column: 1 / -1;"><span class="ext-k">Period</span><span class="ext-v">${escapeHTML(head.period.start)} → ${escapeHTML(head.period.end)}</span></div>` : ''}
          </div>
          ${periodMismatch ? `
            <div class="alert warn" style="margin-top: 10px; padding: 10px 12px;">
              <span class="ico">⚠️</span>
              <div class="body">
                <strong>Period mismatch.</strong> PDF says ${escapeHTML(head.period.start)} → ${escapeHTML(head.period.end)},
                but this invoice covers ${escapeHTML(invoice.period_start)} → ${escapeHTML(invoice.period_end)}.
              </div>
              <button class="btn btn-warn btn-sm" id="applyPeriodBtn"
                      data-start="${escapeHTML(head.period.start)}" data-end="${escapeHTML(head.period.end)}">
                Apply PDF period
              </button>
            </div>
          ` : ''}
        </div>
      ` : ''}

      <div class="ext-block">
        <div class="ext-block-title">Totals comparison</div>
        <div class="ext-totals">
          <div class="ext-tot-row"><span>PDF subtotal (labor)</span><strong>${fmt$(totals.subtotal || 0)}</strong></div>
          <div class="ext-tot-row"><span>PDF mileage (${(totals.miles_driven || 0)} mi)</span><strong>${fmt$(totals.mileage_amount || 0)}</strong></div>
          <div class="ext-tot-row"><span>PDF other (tolls/etc)</span><strong>${fmt$(totals.other || 0)}</strong></div>
          <div class="ext-tot-row" style="border-top: 1px solid var(--border); padding-top: 6px; margin-top: 4px;">
            <span><strong>PDF total</strong></span><strong>${fmt$(ext_total)}</strong>
          </div>
          <div class="ext-tot-row"><span>Invoice total now</span><strong>${fmt$(cur_total)}</strong></div>
          <div class="ext-tot-row" style="color: ${Math.abs(totalDelta) < 0.01 ? 'var(--ic-green)' : 'var(--ic-orange)'};">
            <span>Delta</span><strong>${totalDelta >= 0 ? '+' : ''}${fmt$(totalDelta)}</strong>
          </div>
        </div>
      </div>

      ${cands.length ? `
        <div class="ext-block">
          <button class="ext-toggle" data-toggle-extract="ext-cands">▾ ${cands.length} ticket candidate${cands.length===1?'':'s'} detected</button>
          <div id="ext-cands" class="ext-list">
            ${cands.map(c => `
              <div class="ext-item">
                <div style="flex: 1; min-width: 0;">
                  <strong>${c.source_hint === 'maintainx' ? 'MaintainX' : 'Freshdesk'} #${escapeHTML(c.candidate_id)}</strong>
                  ${c.strong ? '<span class="chip chip-ok" style="margin-left: 6px;">strong</span>' : '<span class="chip chip-warn" style="margin-left: 6px;">weak</span>'}
                  <div class="meta" style="margin-top: 2px;">${escapeHTML(c.line.slice(0, 100))}${c.line.length > 100 ? '…' : ''}</div>
                </div>
                <button class="btn btn-primary btn-sm" data-extract-link="${escapeHTML(c.candidate_id)}" data-src="${escapeHTML(c.source_hint)}">Pull &amp; link</button>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      ${items.length ? `
        <div class="ext-block">
          <button class="ext-toggle" data-toggle-extract="ext-items">▸ ${items.length} labor line item${items.length===1?'':'s'} detected</button>
          <div id="ext-items" class="ext-list" style="display: none;">
            ${items.map(it => `
              <div class="ext-item">
                <div style="flex: 1; min-width: 0;">
                  <strong>${escapeHTML(it.date || '?')} · ${it.ticket_id ? '#' + escapeHTML(it.ticket_id) : '<span style="color:var(--muted)">no ticket</span>'}</strong>
                  <div class="meta">${it.start || ''} – ${it.end || ''} · ${it.hours || 0} hrs</div>
                </div>
                <strong>${fmt$(it.amount || 0)}</strong>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      ${mileage.length ? `
        <div class="ext-block">
          <button class="ext-toggle" data-toggle-extract="ext-mileage">▸ ${mileage.length} mileage day${mileage.length===1?'':'s'} · ${totalMileageMi.toFixed(1)} mi total</button>
          <div id="ext-mileage" class="ext-list" style="display: none;">
            ${mileage.map(m => `
              <div class="ext-item">
                <div style="flex: 1;">
                  <strong>${escapeHTML(m.date || m.date_raw || '?')}</strong>
                  <div class="meta">${m.stops.length} stop${m.stops.length===1?'':'s'} · ${m.total_miles} mi</div>
                </div>
                <strong>${fmt$(m.total_amount || 0)}</strong>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      ${tolls.length ? `
        <div class="ext-block">
          <button class="ext-toggle" data-toggle-extract="ext-tolls">▸ ${tolls.length} toll/parking line${tolls.length===1?'':'s'} · ${fmt$(totalTolls)} total</button>
          <div id="ext-tolls" class="ext-list" style="display: none;">
            ${tolls.map(t => `
              <div class="ext-item">
                <div style="flex: 1;">
                  <strong>${escapeHTML(t.date)} · ${escapeHTML(t.vendor)}</strong>
                  <div class="meta">${escapeHTML(t.category)}${t.reimbursable ? ' · reimbursable' : ''}</div>
                </div>
                <strong>${fmt$(t.amount)}</strong>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <p class="help" style="margin-top: 10px;">
        ${cur_total > 0
          ? 'Use the buttons below to pull each ticket from MaintainX/Freshdesk, then add labor + expense entries that mirror the PDF.'
          : 'Tip: link the tickets above first (so each entry has a real WO context), then click "Add a time entry" / "Add an expense" to mirror the PDF lines.'}
      </p>
    </div>
  `;
}

// ---- FORECAST FORMULA EXPLAINER ----
// Plain-English documentation of how both forecast numbers on the dashboard
// are calculated. Opened from the "?" icon on each forecast KPI tile.
function openForecastExplainer() {
  const html = `
    <h3>How are the forecasts calculated?</h3>
    <p class="help">The dashboard shows two independent forecast numbers — one bottoms-up (work-in-flight), one top-down (trend). Both honor whatever filters you have applied (period, tech, store, work type).</p>

    <div class="card" style="background: #fff8f0; border-left: 4px solid var(--ic-orange); padding: 14px 16px; margin: 0 0 14px;">
      <strong>🔮 Forecast: Open work orders</strong>
      <p class="help" style="margin: 6px 0;">Bottoms-up estimate of spend committed to work that is currently open or in-progress.</p>
      <pre class="formula">for each open / in-progress WO in scope:
  estimated_spend = (historical $/cart for this work_type) × cart_count

total = sum of estimated_spend across all open WOs</pre>
      <p class="help" style="margin: 6px 0;">
        <strong>$/cart</strong> is computed from billable invoices in the selected period:
      </p>
      <pre class="formula">$/cart_for_work_type =
    Σ (labor + expenses on WOs of this type)
  ÷ Σ (cart_count of those WOs)</pre>
      <p class="help" style="margin: 6px 0;">
        Concrete example: if retrofits in the last 90 days averaged $42/cart and you have an open retrofit WO with 12 carts, the line item is <code>12 × $42 = $504</code>. The dashboard's Forecast → Open WOs table shows the per-WO breakdown.
      </p>
    </div>

    <div class="card" style="background: #fff8f0; border-left: 4px solid var(--ic-orange); padding: 14px 16px; margin: 0;">
      <strong>📈 Forecast: Next 4 weeks (trend extrapolation)</strong>
      <p class="help" style="margin: 6px 0;">Top-down linear regression on the last 12 weeks of weekly spend.</p>
      <pre class="formula">for each week i in 0..11:
  point = (i, weekly_spend_i)

slope     = (N · Σxy − Σx · Σy) / (N · Σx² − (Σx)²)
intercept = (Σy − slope · Σx) / N

projected_spend(k) = max(0, intercept + slope × (11 + k))   for k = 1..4

total = Σ projected_spend(1..4)</pre>
      <p class="help" style="margin: 6px 0;">
        This catches the trend direction (growing or shrinking) but does <strong>not</strong> model:
        seasonality, planned but un-opened work orders, hiring changes, or holidays.
        For a hard-number budget, lean on the bottoms-up forecast + your own pipeline of upcoming work.
      </p>
    </div>

    <div class="actions" style="margin-top: 14px;">
      <button class="btn btn-primary" data-act="sheet-close">Got it</button>
    </div>
  `;
  showSheet(html, {
    onMount: (wrap) => {
      $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
    },
  });
}

// ---- CHANGE PASSWORD SHEET (v0.35) ----
// Opened from Settings → "Change password" or forced after login when the
// user is on a temp password (`must_change_password=true`). When forced,
// Cancel is hidden and the sheet can't be dismissed without success.
function openChangePasswordSheet(opts = {}) {
  const forced = !!opts.forced;
  const html = `
    <h3>${forced ? 'Set a new password' : 'Change password'}</h3>
    <p class="help">${forced
      ? 'Your administrator issued a temporary password. Pick a permanent one before continuing.'
      : 'Pick a new password (at least 8 characters). You\'ll stay signed in.'}</p>

    ${!forced ? `
      <span class="label">Current password</span>
      <input class="field" id="cpCur" type="password" autocomplete="current-password" required />
    ` : ''}

    <span class="label">New password</span>
    <input class="field" id="cpNew" type="password" autocomplete="new-password" required minlength="8" />

    <span class="label">Confirm new password</span>
    <input class="field" id="cpConfirm" type="password" autocomplete="new-password" required minlength="8" />

    <div id="cpErr" class="alert err hidden" style="margin-bottom: 12px;">
      <span class="ico">!</span><div class="body" id="cpErrMsg"></div>
    </div>

    <div class="actions">
      ${forced ? '' : '<button class="btn btn-ghost" data-act="sheet-close">Cancel</button>'}
      <button class="btn btn-primary" id="cpSave">${forced ? 'Set password & continue' : 'Update password'}</button>
    </div>
  `;
  showSheet(html, {
    dismissable: !forced,
    onMount: (wrap) => {
      $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
      $('#cpSave', wrap).addEventListener('click', async () => {
        const cur     = $('#cpCur', wrap)?.value || '';
        const next    = $('#cpNew', wrap).value;
        const confirm = $('#cpConfirm', wrap).value;
        const err = $('#cpErr', wrap), msg = $('#cpErrMsg', wrap);
        err.classList.add('hidden');
        if (next.length < 8) { msg.textContent = 'Password must be at least 8 characters'; err.classList.remove('hidden'); return; }
        if (next !== confirm) { msg.textContent = 'Passwords don\'t match'; err.classList.remove('hidden'); return; }
        const btn = $('#cpSave', wrap); btn.disabled = true; btn.textContent = 'Saving…';
        try {
          await api('/me/password', { method: 'POST', body: forced
            ? { new_password: next }
            : { current_password: cur, new_password: next }
          });
          toast('Password updated ✓', 'ok');
          closeSheet();
          if (forced) {
            // Refresh /me + boot to land on the right tab
            STATE._mustChangePassword = false;
            STATE.user = await api('/me');
            const isMgr = ['ops_manager','sr_manager','pm'].includes(STATE.user.role);
            goto(isMgr ? 'dashboard' : 'home');
          }
        } catch (e) {
          msg.textContent = e.message;
          err.classList.remove('hidden');
          btn.disabled = false; btn.textContent = forced ? 'Set password & continue' : 'Update password';
        }
      });
    },
  });
}

// ---- SEND TO AP SHEET ----
// Final hand-off after Sr Mgr approval. Opens a quick confirm with the AP
// email pre-filled (defaults to ap@instacart.com). On send, the server
// generates a PDF, logs an outbound notification, and transitions the invoice
// to sent_ap. We then offer the PDF to the user immediately.
async function openSendToApSheet(invoice) {
  // Fetch the rendered preview from the server. The endpoint also tells us
  // the policy's default AP email, so this single call covers pre-fill +
  // subject + body + PDF metadata.
  let preview;
  try {
    preview = await api(`/invoices/${invoice.id}/ap-preview`);
  } catch (e) {
    return toast(e.message, 'err');
  }
  const token = encodeURIComponent(localStorage.getItem(STORAGE_TOKEN_KEY) || '');
  const pdfSrc = `${preview.pdf_url}?token=${token}#toolbar=0&navpanes=0`;

  function html() {
    return `
      <h3>📧 Preview &amp; send to AP</h3>
      <p class="help">Review the email exactly as AP will receive it. The attached PDF is shown below — scroll to inspect every page before sending.</p>

      <span class="label">AP recipient</span>
      <input class="field" id="apEmail" type="email" value="${escapeHTML(preview.recipient)}" />
      <div class="help" style="margin-top: -8px;">Default from <strong>Policy → AP recipient email</strong>. Override here for one-off routing — preview will refresh.</div>

      <div class="email-preview">
        <div class="ep-row"><span class="ep-k">From</span><span class="ep-v">${escapeHTML(preview.sender_name || '')} &lt;${escapeHTML(preview.sender_email || '')}&gt;</span></div>
        <div class="ep-row"><span class="ep-k">To</span>  <span class="ep-v" id="epTo">${escapeHTML(preview.recipient)}</span></div>
        <div class="ep-row"><span class="ep-k">Subject</span><span class="ep-v" id="epSubject"><strong>${escapeHTML(preview.subject)}</strong></span></div>
        <div class="ep-row"><span class="ep-k">Attached</span><span class="ep-v">📄 ${escapeHTML(preview.pdf_filename)}</span></div>
        <div class="ep-body">${escapeHTML(preview.body).replace(/\n/g, '<br/>')}</div>
      </div>

      <div class="pdf-preview">
        <div class="pdf-preview-head">
          <strong>📄 Attachment preview</strong>
          <a class="btn btn-ghost btn-sm" href="${preview.pdf_url}?token=${token}" target="_blank">Open in new tab ↗</a>
        </div>
        <iframe class="pdf-preview-frame" src="${pdfSrc}" title="Invoice PDF preview"></iframe>
        <p class="help" style="text-align: center; margin: 6px 0 0;">If preview doesn't render in your browser, use <strong>Open in new tab</strong>.</p>
      </div>

      ${!preview.can_send ? `
        <div class="alert warn" style="margin-top: 12px;">
          <span class="ico">⚠</span>
          <div class="body">This invoice is currently <code>${escapeHTML(preview.current_status)}</code>. It must be approved (Ops Mgr or Sr Mgr) before sending.</div>
        </div>
      ` : ''}

      <div class="actions">
        <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
        <button class="btn btn-warn" id="confirmSendAp" ${preview.can_send ? '' : 'disabled'}>Generate PDF &amp; Send</button>
      </div>
    `;
  }

  showSheet(html(), {
    onMount: (wrap) => {
      $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));

      // Live update the preview's "To" + Subject when the AP email is edited.
      // We don't re-render the iframe (PDF doesn't depend on recipient), just
      // the visible header chip so what you see matches what you send.
      $('#apEmail', wrap).addEventListener('input', (e) => {
        const v = e.target.value.trim();
        $('#epTo', wrap).textContent = v;
      });

      $('#confirmSendAp', wrap).addEventListener('click', async () => {
        const apEmail = $('#apEmail', wrap).value.trim();
        if (!apEmail) return toast('Enter an AP email', 'err');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(apEmail)) return toast('Enter a valid email address', 'err');
        const btn = $('#confirmSendAp', wrap);
        btn.disabled = true; btn.textContent = 'Sending…';
        try {
          const r = await api(`/invoices/${invoice.id}/send-to-ap`, { method: 'POST', body: { ap_email: apEmail } });
          toast(`Sent to ${r.notification.recipient} ✓ — PDF attached`, 'ok');
          closeSheet();
          goto('invDetail', invoice.id);
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Generate PDF & Send';
          toast(e.message, 'err');
        }
      });
    },
  });
}

// ---- EDIT INVOICE DETAILS SHEET (manager only) ----
function openEditInvoiceDetailsSheet(invoice) {
  const html = `
    <h3>Edit invoice details</h3>
    <p class="help">Update the period this invoice covers and the manager notes. Line items are added separately.</p>

    <span class="label">Period start (Mon)</span>
    <input class="field" id="edPeriodStart" type="date" value="${escapeHTML(invoice.period_start || '')}" />

    <span class="label">Period end (Sun)</span>
    <input class="field" id="edPeriodEnd" type="date" value="${escapeHTML(invoice.period_end || '')}" />

    <span class="label">Notes (visible on the invoice)</span>
    <textarea class="field" id="edNotes" rows="4" placeholder="e.g., Reviewed against MaintainX tickets — all line items reconciled.">${escapeHTML(invoice.notes || '')}</textarea>

    <div class="actions">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      <button class="btn btn-primary" id="edSave">Save</button>
    </div>
  `;
  showSheet(html, {
    onMount: (wrap) => {
      $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
      $('#edSave', wrap).addEventListener('click', async () => {
        const period_start = $('#edPeriodStart', wrap).value;
        const period_end   = $('#edPeriodEnd', wrap).value;
        const notes        = $('#edNotes', wrap).value;
        try {
          await api(`/invoices/${invoice.id}`, { method: 'PUT',
            body: { period_start, period_end, notes } });
          toast('Invoice details updated ✓', 'ok');
          closeSheet();
          goto('invDetail', invoice.id);
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

async function openExtractWoSheet(invoiceId) {
  let candidates = null;

  function html() {
    return `
      <h3>🔎 Extract &amp; link work orders</h3>
      <p class="help">Paste the invoice text (e.g. copied from the PDF) and we'll find ticket numbers, then pull each one from Freshdesk or MaintainX and link it to this invoice.</p>

      <span class="label">Invoice text</span>
      <textarea class="field" id="exText" rows="8" placeholder="[4/13] [Weight Calibration Check] WF 16 ShopRite of Bridge &amp; Harbison - All Carts - 12816&#10;[4/14] [Hall Sensor Replacement] WF 26 - ShopRite of Yardley - 12827&#10;..."></textarea>
      <button class="btn btn-primary btn-block" id="exFind" style="margin-bottom: 14px;">Find tickets</button>

      ${candidates !== null ? (
        candidates.length === 0
          ? `<div class="empty" style="padding: 14px;">No ticket numbers detected. Paste a longer chunk of the invoice and try again.</div>`
          : `
            <div class="section-title" style="margin-top: 0;">Detected ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}</div>
            ${candidates.map(c => `
              <div class="card" style="padding: 12px 14px;">
                <div class="flex between" style="align-items: center; gap: 12px;">
                  <div style="flex: 1; min-width: 0;">
                    <strong>${escapeHTML(c.source_hint === 'maintainx' ? 'MaintainX' : 'Freshdesk')} #${escapeHTML(c.candidate_id)}</strong>
                    <div class="meta" style="margin-top: 4px;">${escapeHTML(c.line.slice(0, 120))}${c.line.length > 120 ? '…' : ''}</div>
                  </div>
                  <button class="btn btn-primary btn-sm" data-link-wo="${escapeHTML(c.candidate_id)}" data-src="${escapeHTML(c.source_hint)}">Pull &amp; link</button>
                </div>
              </div>
            `).join('')}
          `
      ) : ''}

      <div class="actions" style="margin-top: 14px;">
        <button class="btn btn-ghost btn-block" data-act="sheet-close">Close</button>
      </div>
    `;
  }

  showSheet(html(), {
    onMount: (wrap) => {
      function rerender() { wrap.querySelector('.sheet').innerHTML = `<div class="sheet-handle"></div>${html()}`; bindAll(); }
      function bindAll() {
        $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
        $('#exFind', wrap).addEventListener('click', async () => {
          const text = $('#exText', wrap).value.trim();
          if (!text) return toast('Paste some invoice text first', 'err');
          try {
            const r = await api(`/invoices/${invoiceId}/extract-wos`, { method: 'POST', body: { text } });
            candidates = r.candidates || [];
            toast(`Found ${candidates.length} candidate ticket${candidates.length===1?'':'s'}`, 'ok');
            rerender();
          } catch (e) { toast(e.message, 'err'); }
        });
        $$('[data-link-wo]', wrap).forEach(b => b.addEventListener('click', async () => {
          const ticket = b.dataset.linkWo;
          const src    = b.dataset.src;
          b.disabled = true; b.textContent = 'Linking…';
          try {
            const r = await api(`/invoices/${invoiceId}/link-wo`, { method: 'POST', body: { source_system: src, ticket_id: ticket } });
            b.textContent = r.was_existing ? '✓ Already linked' : '✓ Linked';
            toast(`${src} #${ticket} linked${r.was_existing ? ' (already existed)' : ' as new WO'}`, 'ok');
          } catch (e) { b.disabled = false; b.textContent = 'Pull & link'; toast(e.message, 'err'); }
        }));
      }
      bindAll();
    },
  });
}

// Field tech version of the upload-PDF sheet. The server defaults tech_user_id
// to the caller, so the request is identical except we don't need to pick a
// tech. Same auto-extract + auto-import + per-line edit flow on the resulting
// draft, so the tech can clean up the PDF data before submitting.
async function openTechUploadSheet() {
  let pendingFile = null;
  const lastWeekDate = new Date(); lastWeekDate.setDate(lastWeekDate.getDate() - 7);

  function html() {
    return `
      <h3>Upload an old invoice</h3>
      <p class="help">Got a PDF you sent before this app existed? Upload it. We'll parse the line items, mileage, and tolls into a draft you can edit and submit.</p>

      <span class="label">Week the invoice covers (any date in the Mon–Sun)</span>
      <input class="field" id="tuWeek" type="date" value="${lastWeekDate.toISOString().slice(0,10)}" max="${new Date().toISOString().slice(0,10)}" />

      <span class="label">Original PDF (or photo)</span>
      <div id="tuFilePicker"></div>
      ${pendingFile ? `
        <div class="attach-item" style="margin-bottom: 10px;">
          <div class="thumb">${(pendingFile.mime_type || '').startsWith('image/') ? '📷' : '📄'}</div>
          <div class="meta">
            <div class="name">${escapeHTML(pendingFile.filename)}</div>
            <div class="sub">${fmtSize(Math.round(pendingFile.data_b64.length * 3 / 4))} · ready</div>
          </div>
          <button class="btn btn-ghost btn-sm" id="tuClearFile">×</button>
        </div>
      ` : ''}

      <span class="label">Notes (optional)</span>
      <textarea class="field" id="tuNotes" rows="2" placeholder="e.g., Sent this to my manager on 4/28 — want to bring it into the system"></textarea>

      <div class="actions">
        <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
        <button class="btn btn-primary" id="tuSave">Upload &amp; open editor</button>
      </div>
    `;
  }

  showSheet(html(), {
    onMount: (wrap) => {
      function rerender() { wrap.querySelector('.sheet').innerHTML = `<div class="sheet-handle"></div>${html()}`; bindAll(); }
      function bindAll() {
        $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
        $('#tuClearFile', wrap)?.addEventListener('click', () => { pendingFile = null; rerender(); });
        const fp = $('#tuFilePicker', wrap);
        if (fp && !pendingFile) {
          makeReceiptPicker(fp, {
            label: '📷 Attach the original invoice',
            onFile: (payload) => { pendingFile = payload; rerender(); },
          });
        }
        $('#tuSave', wrap).addEventListener('click', async () => {
          const week_of = $('#tuWeek', wrap).value;
          const notes   = $('#tuNotes', wrap).value.trim();
          if (!week_of) return toast('Pick a week', 'err');
          if (!pendingFile) return toast('Attach the PDF first', 'err');
          try {
            const r = await api('/invoices/upload', { method: 'POST', body: {
              week_of, attachment: pendingFile, notes: notes || undefined,
            }});
            const lines = r.import?.created;
            toast(`Draft created ✓${lines ? ` — ${lines.time_entries} entries, ${lines.expenses} expenses` : ''}`, 'ok');
            closeSheet();
            goto('invDetail', r.invoice.id);
          } catch (e) { toast(e.message, 'err'); }
        });
      }
      bindAll();
    },
  });
}

async function openUploadInvoiceSheet() {
  const team = await api('/team');
  if (!team.length) return toast('Add at least one tech to your team first', 'err');
  const lastWeekDate = new Date(); lastWeekDate.setDate(lastWeekDate.getDate() - 7);
  let pendingFile = null;

  function html() {
    return `
      <h3>Upload invoice for a technician</h3>
      <p class="help">Pick the tech and the week the invoice covers. Attach the original PDF/photo. We'll create a draft invoice and drop you straight into the editor so you can fill in line items before approving.</p>

      <span class="label">Technician</span>
      <select class="field" id="upTech">
        ${team.map(t => `<option value="${t.id}">${escapeHTML(t.name)} (${t.worker_type || '?'})</option>`).join('')}
      </select>

      <span class="label">Week (any date in the target Mon–Sun)</span>
      <input class="field" id="upWeek" type="date" value="${lastWeekDate.toISOString().slice(0,10)}" max="${new Date().toISOString().slice(0,10)}" />

      <span class="label">Original file (PDF, JPG, PNG)</span>
      <div id="upFilePicker"></div>
      ${pendingFile ? `
        <div class="attach-item" style="margin-bottom: 10px;">
          <div class="thumb">${(pendingFile.mime_type || '').startsWith('image/') ? '📷' : '📄'}</div>
          <div class="meta">
            <div class="name">${escapeHTML(pendingFile.filename)}</div>
            <div class="sub">${fmtSize(Math.round(pendingFile.data_b64.length * 3 / 4))} · ready to upload</div>
          </div>
          <button class="btn btn-ghost btn-sm" id="upClearFile">×</button>
        </div>
      ` : ''}

      <span class="label">Notes for context (optional)</span>
      <textarea class="field" id="upNotes" rows="2" placeholder="e.g., John emailed this 4/24 — needs new line items added per his hours log"></textarea>

      <div class="actions">
        <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
        <button class="btn btn-primary" id="upSave">Create draft &amp; open</button>
      </div>
    `;
  }

  showSheet(html(), {
    onMount: (wrap) => {
      function rerender() { wrap.querySelector('.sheet').innerHTML = `<div class="sheet-handle"></div>${html()}`; bindAll(); }
      function bindAll() {
        $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
        $('#upClearFile', wrap)?.addEventListener('click', () => { pendingFile = null; rerender(); });
        const fp = $('#upFilePicker', wrap);
        if (fp && !pendingFile) {
          makeReceiptPicker(fp, {
            label: '📷 Attach the original invoice',
            onFile: (payload) => { pendingFile = payload; rerender(); },
          });
        }
        $('#upSave', wrap).addEventListener('click', async () => {
          const tech_user_id = Number($('#upTech', wrap).value);
          const week_of      = $('#upWeek', wrap).value;
          const notes        = $('#upNotes', wrap).value.trim();
          if (!tech_user_id) return toast('Pick a tech', 'err');
          if (!week_of)      return toast('Pick a week', 'err');
          try {
            const r = await api('/invoices/upload', { method: 'POST', body: {
              tech_user_id, week_of,
              attachment: pendingFile,
              notes: notes || undefined,
            }});
            toast('Draft created ✓ — now editing on behalf of the tech', 'ok');
            closeSheet();
            // Switch into proxy-edit mode and open the invoice
            STATE.onBehalfOf = tech_user_id;
            STATE.onBehalfOfName = (await api(`/team`)).find(t => t.id === tech_user_id)?.name || '';
            goto('invDetail', r.invoice.id);
          } catch (e) { toast(e.message, 'err'); }
        });
      }
      bindAll();
    },
  });
}

async function renderTeam(root) {
  const [team, available] = await Promise.all([
    api('/team'),
    api('/team/available'),
  ]);
  root.innerHTML = `
    <div class="card">
      <p class="help" style="margin: 0 0 10px;">Add existing technicians to your approval queue, or create a brand-new technician account.</p>
      <button class="btn btn-primary btn-block" id="newTechBtn">＋ Create new technician</button>
    </div>

    <div class="section-title">My team (${team.length})</div>
    ${team.length === 0
      ? `<div class="empty" style="padding: 20px;">No technicians on your team yet. Add some below.</div>`
      : `<div class="card-grid">${team.map(t => `
          <div class="card" style="padding: 12px 14px;">
            <div class="flex between" style="align-items: center;">
              <div>
                <div style="font-weight: 700;">${escapeHTML(t.name)}</div>
                <div class="meta">${escapeHTML(t.email)} · ${t.worker_type || 'unknown'} · $${(t.hourly_rate || 0).toFixed(0)}/hr</div>
              </div>
              <button class="btn btn-ghost btn-sm" data-remove="${t.id}">Remove</button>
            </div>
          </div>
        `).join('')}</div>`}

    ${available.length ? `
      <div class="section-title">Available to add (${available.length})</div>
      <div class="card-grid">${available.map(t => `
        <div class="card" style="padding: 12px 14px; background: #fafafa;">
          <div class="flex between" style="align-items: center;">
            <div>
              <div style="font-weight: 700;">${escapeHTML(t.name)}</div>
              <div class="meta">${escapeHTML(t.email)} · ${t.worker_type || 'unknown'}</div>
            </div>
            <button class="btn btn-primary btn-sm" data-add="${t.id}">+ Add</button>
          </div>
        </div>
      `).join('')}</div>
    ` : ''}
  `;

  $$('[data-add]').forEach(b => b.addEventListener('click', async () => {
    try {
      await api(`/team/${b.dataset.add}`, { method: 'POST' });
      toast('Tech added ✓', 'ok');
      goto('team');
    } catch (e) { toast(e.message, 'err'); }
  }));
  $$('[data-remove]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Remove this tech from your team?')) return;
    try {
      await api(`/team/${b.dataset.remove}`, { method: 'DELETE' });
      toast('Removed ✓', 'ok');
      goto('team');
    } catch (e) { toast(e.message, 'err'); }
  }));
  $('#newTechBtn')?.addEventListener('click', openNewTechSheet);
}

function openNewTechSheet() {
  showSheet(`
    <h3>Create new technician</h3>
    <p class="help">The new tech is added to your team automatically and can sign in immediately (single-machine prototype mode).</p>
    <span class="label">Full name</span>
    <input class="field" id="ntName" placeholder="John Brennan" />
    <span class="label">Email</span>
    <input class="field" id="ntEmail" type="email" placeholder="john.brennan@instacart.com" />
    <span class="label">Worker type</span>
    <div class="chips">
      <span class="chip selected" data-wt="contractor">Contractor</span>
      <span class="chip" data-wt="fte">FTE</span>
    </div>
    <div class="flex gap-12">
      <div style="flex: 1;">
        <span class="label">Hourly rate ($/hr)</span>
        <input class="field" id="ntRate" type="number" step="0.50" min="0" max="500" value="40" />
      </div>
      <div style="flex: 1.4;">
        <span class="label">Phone (optional)</span>
        <input class="field" id="ntPhone" placeholder="555-0100" />
      </div>
    </div>
    <span class="label">Home address (optional)</span>
    <input class="field" id="ntAddr" placeholder="24 Mayflower Drive, Sicklerville, NJ 08081" />
    <div class="actions">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      <button class="btn btn-primary" id="ntSave">Create technician</button>
    </div>
  `, {
    onMount: (wrap) => {
      let workerType = 'contractor';
      $$('.chip[data-wt]', wrap).forEach(c => c.addEventListener('click', () => {
        workerType = c.dataset.wt;
        $$('.chip[data-wt]', wrap).forEach(x => x.classList.toggle('selected', x === c));
      }));
      $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);
      $('#ntSave', wrap).addEventListener('click', async () => {
        const body = {
          name:         $('#ntName',  wrap).value.trim(),
          email:        $('#ntEmail', wrap).value.trim(),
          worker_type:  workerType,
          hourly_rate:  Number($('#ntRate', wrap).value) || 40,
          home_phone:   $('#ntPhone', wrap).value.trim(),
          home_address: $('#ntAddr',  wrap).value.trim(),
        };
        if (!body.name || !body.email) return toast('Name and email required', 'err');
        try {
          await api('/users', { method: 'POST', body });
          toast(`Created ${body.name} ✓`, 'ok');
          closeSheet();
          goto('team');
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

// All invoices view (manager scope) — shows every invoice the manager can see
// across all statuses, with quick filter buttons. Reads /api/team-invoices.
async function renderAllInvoices(root) {
  const me = STATE.user;
  // v0.67 — Ops Managers don't see the Senior-Manager stage as its own status.
  const isOps = me.role === 'ops_manager';
  const filter = STATE._allInvFilter || 'all';
  const all = await api(`/team-invoices`);
  const counts = all.reduce((m, i) => (m[i.status] = (m[i.status] || 0) + 1, m), {});
  const filtered = filter === 'all' ? all : all.filter(i => i.status === filter);
  const totalValue = filtered.reduce((s, i) => s + (i.total || 0), 0);

  // Status labels + badges come from the shared labelForStatus()/badgeForStatus()
  // helpers so every screen shows identical wording (no divergent local map).

  const filterChip = (key, label, count) => `
    <button class="chip ${filter===key?'selected':''}" data-filter="${key}">
      ${label}${count != null ? ` <span style="opacity:.7">${count}</span>` : ''}
    </button>
  `;

  root.innerHTML = `
    <div class="card" style="background: var(--ic-green-deep); color: #fff; border: 0; margin-bottom: 14px;">
      <div class="flex between" style="align-items: center;">
        <div>
          <div class="label" style="color: #b5e8a3;">${escapeHTML(filter === 'all' ? 'All invoices' : labelForStatusViewer(filter, me.role))}</div>
          <div style="font-size: 28px; font-weight: 800; margin-top: 4px;">${filtered.length} <span style="font-size: 14px; font-weight: 500; color: #cde9c9;">invoice${filtered.length===1?'':'s'}</span></div>
        </div>
        <div style="text-align: right;">
          <div class="label" style="color: #b5e8a3;">Total value</div>
          <div style="font-size: 22px; font-weight: 700;">${fmt$(totalValue)}</div>
        </div>
      </div>
    </div>

    <div class="chips" style="margin-bottom: 14px; flex-wrap: wrap;">
      ${filterChip('all', 'All', all.length)}
      ${Object.entries(counts)
        // v0.67 — Ops Mgr table never exposes a "Sr Mgr approved" filter chip.
        .filter(([k]) => !(isOps && k === 'approved_sr'))
        .map(([k, n]) => filterChip(k, labelForStatusViewer(k, me.role), n)).join('')}
    </div>

    ${filtered.length === 0
      ? `<div class="empty"><div class="big">📊</div>No invoices match this filter.</div>`
      : `<div class="card-grid">${filtered.map(inv => `
          <div class="card tap" data-inv="${inv.id}">
            <div class="flex between" style="align-items: flex-start;">
              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 700; font-size: 15px;">${escapeHTML(inv.tech_name)}</div>
                <div class="meta" style="margin-top: 4px;">${inv.invoice_number} · ${fmtDate(inv.period_start)} → ${fmtDate(inv.period_end)}</div>
                <div style="margin-top: 8px;">
                  <span class="badge ${badgeForStatus(inv.status)}">${escapeHTML(labelForStatusViewer(inv.status, me.role))}</span>
                </div>
              </div>
              <div style="text-align: right;">
                <div style="font-size: 20px; font-weight: 700;">${fmt$(inv.total)}</div>
                <div class="meta">${inv.tech_worker_type || ''}</div>
              </div>
            </div>
          </div>
        `).join('')}</div>`}
  `;

  $$('[data-filter]').forEach(b => b.addEventListener('click', () => {
    STATE._allInvFilter = b.dataset.filter;
    goto('allInv');
  }));
  $$('.card.tap[data-inv]').forEach(c => c.addEventListener('click', () => goto('invDetail', Number(c.dataset.inv))));
}

// ---- ADMIN — user management (v0.35, PM / Sr Mgr only) ----
async function renderAdmin(root) {
  if (!['pm','sr_manager'].includes(STATE.user.role)) {
    root.innerHTML = `<div class="empty">Admin role (PM or Sr Mgr) required.</div>`;
    return;
  }
  const users = await api('/admin/users');
  const groups = [
    { key: 'active',   label: 'Active users',   filter: u => u.status === 'active' },
    { key: 'disabled', label: 'Disabled',       filter: u => u.status === 'disabled' },
  ];
  root.innerHTML = `
    <div class="card" style="display: flex; justify-content: space-between; align-items: center;">
      <div>
        <strong>${users.length}</strong> total · <strong>${users.filter(u => u.status==='active').length}</strong> active
      </div>
      <button class="btn btn-primary btn-sm" id="addUserBtn">＋ Add user</button>
    </div>

    ${groups.map(g => {
      const list = users.filter(g.filter);
      if (!list.length) return '';
      return `
        <div class="section-title">${escapeHTML(g.label)} (${list.length})</div>
        ${list.map(u => `
          <div class="card" style="padding: 14px 16px;${u.status==='disabled'?' opacity:0.6;':''}">
            <div class="flex between" style="align-items: flex-start;">
              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 700;">${escapeHTML(u.name)}</div>
                <div class="meta">
                  <code>${escapeHTML(u.username || '(no username)')}</code> · ${escapeHTML(u.email)}
                </div>
                <div style="margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap;">
                  <span class="role-tag ${u.role}">${escapeHTML(roleLabel(u.role))}</span>
                  ${u.worker_type ? `<span class="role-tag ${u.worker_type}">${u.worker_type}</span>` : ''}
                  ${u.must_change_password ? `<span class="chip-warn" style="font-size: 10px; padding: 2px 6px; border-radius: 8px; background: #fef4e7; color: #b56400;">temp password</span>` : ''}
                  ${!u.has_password ? `<span class="chip-warn" style="font-size: 10px; padding: 2px 6px; border-radius: 8px; background: var(--err-bg); color: var(--err-fg);">no password</span>` : ''}
                </div>
                <div class="meta" style="margin-top: 6px; font-size: 11px;">
                  ${u.last_login_at ? `Last login ${new Date(u.last_login_at).toLocaleString()}` : 'Never logged in'}
                </div>
              </div>
              <div class="ctrl" style="display: flex; gap: 4px; flex-direction: column; align-items: stretch;">
                <button class="btn btn-ghost btn-sm" data-edit-user="${u.id}">Edit</button>
                <button class="btn btn-ghost btn-sm" data-reset-user="${u.id}" data-name="${escapeHTML(u.name)}">Reset password</button>
                ${u.status==='active' && u.id !== STATE.user.id
                  ? `<button class="btn btn-danger btn-sm" data-disable-user="${u.id}" data-name="${escapeHTML(u.name)}">Disable</button>`
                  : (u.status==='disabled' ? `<button class="btn btn-warn btn-sm" data-enable-user="${u.id}">Enable</button>` : '')}
              </div>
            </div>
          </div>
        `).join('')}
      `;
    }).join('')}
  `;

  $('#addUserBtn')?.addEventListener('click', () => openAddUserSheet());
  $$('[data-edit-user]').forEach(b => b.addEventListener('click', () => {
    const u = users.find(x => x.id === Number(b.dataset.editUser));
    openEditUserSheet(u);
  }));
  $$('[data-reset-user]').forEach(b => b.addEventListener('click', () => {
    openResetPasswordSheet(Number(b.dataset.resetUser), b.dataset.name);
  }));
  $$('[data-disable-user]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`Disable ${b.dataset.name}?\n\nThey will be signed out and unable to log in.`)) return;
    try { await api(`/admin/users/${b.dataset.disableUser}`, { method: 'DELETE' }); toast('User disabled ✓', 'ok'); goto('admin'); }
    catch (e) { toast(e.message, 'err'); }
  }));
  $$('[data-enable-user]').forEach(b => b.addEventListener('click', async () => {
    try { await api(`/admin/users/${b.dataset.enableUser}`, { method: 'PATCH', body: { status: 'active' } }); toast('User re-enabled ✓', 'ok'); goto('admin'); }
    catch (e) { toast(e.message, 'err'); }
  }));
}

function openAddUserSheet() {
  const html = `
    <h3>Add user</h3>
    <p class="help">Issues a temporary password. The user will be forced to change it on first login.</p>

    <span class="label">Full name</span>
    <input class="field" id="auName" autofocus />

    <div class="flex gap-12">
      <div style="flex:1;">
        <span class="label">Email</span>
        <input class="field" id="auEmail" type="email" />
      </div>
      <div style="flex:1;">
        <span class="label">Username</span>
        <input class="field" id="auUsername" />
      </div>
    </div>

    <span class="label">Role</span>
    <select class="field" id="auRole">
      <option value="technician">Technician</option>
      <option value="ops_manager">Ops Manager</option>
      <option value="sr_manager">Sr Manager</option>
      <option value="pm">PM</option>
    </select>

    <div id="auTechFields">
      <div class="flex gap-12">
        <div style="flex:1;">
          <span class="label">Worker type</span>
          <select class="field" id="auWorkerType">
            <option value="contractor">Contractor</option>
            <option value="fte">FTE</option>
          </select>
        </div>
        <div style="flex:1;">
          <span class="label">Hourly rate ($)</span>
          <input class="field" id="auRate" type="number" min="0" max="500" value="40" />
        </div>
      </div>
    </div>

    <span class="label">Temporary password</span>
    <input class="field" id="auPwd" type="text" placeholder="8+ characters" />
    <div class="help" style="margin-top: -8px;">User will be forced to change this on first sign-in.</div>

    <div class="actions">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      <button class="btn btn-primary" id="auSave">Add user</button>
    </div>
  `;
  showSheet(html, {
    onMount: (wrap) => {
      $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
      const updateTechFields = () => {
        $('#auTechFields', wrap).style.display = $('#auRole', wrap).value === 'technician' ? '' : 'none';
      };
      $('#auRole', wrap).addEventListener('change', updateTechFields);
      updateTechFields();
      $('#auSave', wrap).addEventListener('click', async () => {
        const body = {
          name:     $('#auName', wrap).value.trim(),
          email:    $('#auEmail', wrap).value.trim(),
          username: $('#auUsername', wrap).value.trim(),
          role:     $('#auRole', wrap).value,
          temp_password: $('#auPwd', wrap).value,
        };
        if (body.role === 'technician') {
          body.worker_type = $('#auWorkerType', wrap).value;
          body.hourly_rate = Number($('#auRate', wrap).value) || 40;
        }
        try {
          await api('/admin/users', { method: 'POST', body });
          toast('User created ✓', 'ok');
          closeSheet();
          goto('admin');
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

function openEditUserSheet(u) {
  const html = `
    <h3>Edit ${escapeHTML(u.name)}</h3>
    <span class="label">Full name</span>
    <input class="field" id="euName" value="${escapeHTML(u.name)}" />
    <div class="flex gap-12">
      <div style="flex:1;">
        <span class="label">Email</span>
        <input class="field" id="euEmail" type="email" value="${escapeHTML(u.email)}" />
      </div>
      <div style="flex:1;">
        <span class="label">Username</span>
        <input class="field" id="euUsername" value="${escapeHTML(u.username || '')}" />
      </div>
    </div>
    <span class="label">Role</span>
    <select class="field" id="euRole">
      <option value="technician"  ${u.role==='technician'?'selected':''}>Technician</option>
      <option value="ops_manager" ${u.role==='ops_manager'?'selected':''}>Ops Manager</option>
      <option value="sr_manager"  ${u.role==='sr_manager'?'selected':''}>Sr Manager</option>
      <option value="pm"          ${u.role==='pm'?'selected':''}>PM</option>
    </select>
    <div class="actions">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      <button class="btn btn-primary" id="euSave">Save</button>
    </div>
  `;
  showSheet(html, {
    onMount: (wrap) => {
      $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
      $('#euSave', wrap).addEventListener('click', async () => {
        try {
          await api(`/admin/users/${u.id}`, { method: 'PATCH', body: {
            name:     $('#euName', wrap).value.trim(),
            email:    $('#euEmail', wrap).value.trim(),
            username: $('#euUsername', wrap).value.trim(),
            role:     $('#euRole', wrap).value,
          }});
          toast('User updated ✓', 'ok');
          closeSheet();
          goto('admin');
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

function openResetPasswordSheet(userId, userName) {
  const html = `
    <h3>Reset password for ${escapeHTML(userName)}</h3>
    <p class="help">Issues a new temporary password and signs the user out everywhere. They'll be forced to change it on next login.</p>

    <span class="label">Temporary password</span>
    <input class="field" id="rpPwd" type="text" placeholder="8+ characters" autofocus />

    <div class="actions">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      <button class="btn btn-warn" id="rpSave">Reset</button>
    </div>
  `;
  showSheet(html, {
    onMount: (wrap) => {
      $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
      $('#rpSave', wrap).addEventListener('click', async () => {
        const pwd = $('#rpPwd', wrap).value;
        if (!pwd || pwd.length < 8) return toast('Password must be at least 8 characters', 'err');
        try {
          await api(`/admin/users/${userId}/reset-password`, { method: 'POST', body: { temp_password: pwd } });
          toast(`${userName}'s password reset ✓`, 'ok');
          closeSheet();
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

// ---- FORECAST (manager-only, v0.33) ----
// All forward-looking metrics live here so the main Dashboard stays clean.
// Reuses the same /api/dashboard payload (so all filters apply) and renders:
//   - Forecast KPIs (next 4 wks via trend, total via open WOs)
//   - Multi-line chart with per-tech actuals + dashed projection
//   - Bottoms-up forecast table (open WOs × historical $/cart)
//   - Inline formula explainer
async function renderForecast(root) {
  const period      = STATE._dashPeriod || 'last_90';
  const techFilter  = STATE._dashTech   || '';
  const storeFilter = STATE._dashStore  || '';
  const wtFilter    = STATE._dashWt     || '';
  const qs = new URLSearchParams({ period });
  if (techFilter)  qs.set('tech',      techFilter);
  if (storeFilter) qs.set('store',     storeFilter);
  if (wtFilter)    qs.set('work_type', wtFilter);
  const r = await api(`/dashboard?${qs.toString()}`);
  if (r.meta?.empty) {
    root.innerHTML = `<div class="empty"><div class="big">📈</div>${escapeHTML(r.meta.message)}</div>`;
    return;
  }

  const PERIODS = [
    ['mtd', 'MTD'], ['last_30','Last 30d'], ['last_90','Last 90d'],
    ['qtd','QTD'], ['ytd','YTD'], ['all','All time'],
  ];

  root.innerHTML = `
    <div class="dash-toolbar">
      <div class="chips" style="margin: 0; flex-wrap: wrap;">
        ${PERIODS.map(([k, label]) => `<span class="chip ${period===k?'selected':''}" data-period="${k}">${label}</span>`).join('')}
      </div>
      <div class="meta">${escapeHTML(r.meta.period_label)} ${techFilter || storeFilter || wtFilter ? `· <span style="color: var(--ic-orange);">⚙ Filtered</span>` : ''}</div>
    </div>

    <div class="kpi-grid" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));">
      ${kpiTile('Open WOs forecast',     fmt$(r.summary.forecast_open_wos),    'bottoms-up: open carts × $/cart',   'forecast', true)}
      ${kpiTile('Next 4 weeks (trend)',  fmt$(r.summary.forecast_next_4_weeks_trend), 'linear extrapolation',       'forecast', true)}
    </div>

    ${renderMultiLineCard('Spend trajectory by technician (with 4-week projection)', r.trend_by_tech, r.trend, r.projection)}

    ${renderForecastCard(r.forecast_open_wos_detail, r.summary.forecast_open_wos)}

    <div class="card" style="margin-top: 14px;">
      <div class="section-title" style="margin-top: 0;">How are these calculated?</div>
      <p class="help">Two independent forecasts. Both honor the period / tech / store / work-type filters at the top.</p>

      <div class="card" style="background: #fff8f0; border-left: 4px solid var(--ic-orange); padding: 14px 16px; margin: 0 0 14px;">
        <strong>🔮 Open work orders (bottoms-up)</strong>
        <pre class="formula">for each open / in-progress WO in scope:
  estimated_spend = (historical $/cart for this work_type) × cart_count

total = sum of estimated_spend across all open WOs

$/cart_for_work_type =
    Σ (labor + expenses on WOs of this type)
  ÷ Σ (cart_count of those WOs)</pre>
      </div>

      <div class="card" style="background: #fff8f0; border-left: 4px solid var(--ic-orange); padding: 14px 16px; margin: 0;">
        <strong>📈 Next 4 weeks (trend extrapolation)</strong>
        <pre class="formula">linear regression over the last 12 weeks of weekly spend:
  slope     = (N · Σxy − Σx · Σy) / (N · Σx² − (Σx)²)
  intercept = (Σy − slope · Σx) / N

projected_spend(k) = max(0, intercept + slope × (11 + k))   for k = 1..4
total = Σ projected_spend(1..4)</pre>
        <p class="help" style="margin: 6px 0 0;">Catches the trend direction (growing / shrinking) but does <strong>not</strong> model: seasonality, planned-but-unopened WOs, hiring changes, holidays.</p>
      </div>
    </div>
  `;

  $$('[data-period]').forEach(b => b.addEventListener('click', () => { STATE._dashPeriod = b.dataset.period; goto('forecast'); }));
}

// ---- COST TRACKER (manager-only, v0.42 — actuals only + editable) ----
// Dedicated tab that mirrors the FY26 Deployment & Retrofit Cost Tracker
// Excel template page-for-page so the Ops team has the same view in the
// app as in the export. Three sections (matching the workbook's tabs):
//   1) DASHBOARD     — month × service-type forecast vs actual + variance
//   2) COST TRACKER MAIN — one row per work order, all 24 columns
//   3) Assumptions   — the editable rate inputs the formulas use
async function renderCostTracker(root) {
  const period      = STATE._dashPeriod || 'last_90';
  const techFilter  = STATE._dashTech   || '';
  const storeFilter = STATE._dashStore  || '';
  const wtFilter    = STATE._dashWt     || '';
  const qs = new URLSearchParams({ period });
  if (techFilter)  qs.set('tech',      techFilter);
  if (storeFilter) qs.set('store',     storeFilter);
  if (wtFilter)    qs.set('work_type', wtFilter);

  const r = await api(`/cost-tracker?${qs.toString()}`);

  const PERIODS = [
    ['mtd', 'MTD'], ['last_30','Last 30d'], ['last_90','Last 90d'],
    ['qtd','QTD'], ['ytd','YTD'], ['all','All time'],
  ];

  // v0.45 — exportQs no longer carries the bearer token; the click handler
  // mints a one-time download token via downloadWithToken().
  const exportQs = new URLSearchParams({ period });
  if (techFilter)  exportQs.set('tech',      techFilter);
  if (storeFilter) exportQs.set('store',     storeFilter);
  if (wtFilter)    exportQs.set('work_type', wtFilter);

  const monthly = r.monthly || { rows: [], totals: { actual: 0, wo_count: 0 } };
  const rows    = r.rows    || [];
  const inflightVisits = r.by_store_invoices || { visits: [], grand_total: 0, grand_count: 0 };

  // Filter / sort / paginate
  if (typeof STATE._trackerSearch !== 'string') STATE._trackerSearch = '';
  if (typeof STATE._trackerPage   !== 'number') STATE._trackerPage = 0;
  if (typeof STATE._trackerOnlyMissing !== 'boolean') STATE._trackerOnlyMissing = false;
  // v0.62.3 — new filters so completed/in-progress WOs are easy to find.
  if (typeof STATE._trackerStatus !== 'string') STATE._trackerStatus = '';   // '', 'completed', 'in_progress', 'open', 'cancelled'
  if (!STATE._trackerSort) STATE._trackerSort = { col: 'service_date', dir: 'desc' };

  const search = STATE._trackerSearch.toLowerCase();
  let filteredRows = rows;
  if (search) filteredRows = filteredRows.filter(row =>
    (row.store_name   || '').toLowerCase().includes(search) ||
    (row.tech_names   || '').toLowerCase().includes(search) ||
    (row.service_type || '').toLowerCase().includes(search) ||
    (row.notes        || '').toLowerCase().includes(search) ||
    (row.invoice_link || '').toLowerCase().includes(search) ||
    (row.pm_dri       || '').toLowerCase().includes(search) ||
    (row.ops_manager  || '').toLowerCase().includes(search));
  if (STATE._trackerOnlyMissing) filteredRows = filteredRows.filter(row => row.missing_data);
  if (STATE._trackerStatus)      filteredRows = filteredRows.filter(row => (row.status || 'open') === STATE._trackerStatus);

  const { col, dir } = STATE._trackerSort;
  const sortedRows = [...filteredRows].sort((x, y) => {
    let xv = x[col], yv = y[col];
    if (typeof xv === 'string') xv = xv.toLowerCase();
    if (typeof yv === 'string') yv = yv.toLowerCase();
    if (xv === yv) return 0;
    return (xv > yv ? 1 : -1) * (dir === 'asc' ? 1 : -1);
  });

  const PAGE_SIZE = 25;
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  if (STATE._trackerPage >= pageCount) STATE._trackerPage = 0;
  const slice = sortedRows.slice(STATE._trackerPage * PAGE_SIZE, (STATE._trackerPage + 1) * PAGE_SIZE);
  const sortIco = (c) => col === c ? (dir === 'asc' ? ' ▲' : ' ▼') : '';

  const missingCount = r.meta?.missing_count || 0;
  const editedCount  = r.meta?.edited_count  || 0;

  root.innerHTML = `
    <div class="dash-toolbar">
      <div class="chips" style="margin: 0; flex-wrap: wrap;">
        ${PERIODS.map(([k, label]) => `<span class="chip ${period===k?'selected':''}" data-period="${k}">${label}</span>`).join('')}
      </div>
      <div class="meta">
        ${escapeHTML(r.meta.period_label)} · ${rows.length} work orders
        ${missingCount > 0 ? `<span style="color: var(--ic-orange); margin-left: 6px;">⚠ ${missingCount} missing data</span>` : ''}
        ${editedCount  > 0 ? `<span style="color: var(--ic-green-deep); margin-left: 6px;">✏ ${editedCount} edited</span>` : ''}
      </div>
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-ghost btn-sm dash-export-btn" data-export-qs="${escapeHTML(exportQs.toString())}">📥 Excel</button>
        <button class="btn btn-ghost btn-sm" id="trackerPushDriveBtn">📤 Push to Drive</button>
      </div>
    </div>

    <p class="help" style="margin: 4px 0 12px;">
      Actuals only — what was actually spent on each work order. Click any row to edit it (fill in PM DRI / Ops Mgr / hours / 3P vendor / notes / etc.).
      Rows with <span style="color: var(--ic-orange);">⚠</span> have no underlying time entries or expenses recorded yet — those need manual entry.
    </p>

    <!-- ============ DASHBOARD section (actuals by month) ============ -->
    <div class="card" style="margin-top: 14px;">
      <div class="section-title" style="margin-top: 0;">DASHBOARD · Actual cost by month</div>
      ${monthly.rows.length === 0 ? `<div class="empty">No work orders in this period.</div>` : `
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
            <thead>
              <tr style="background: #f4f5f7; text-align: right;">
                <th style="padding: 8px 10px; text-align: left;">Month</th>
                <th style="padding: 8px 10px;">Deployment</th>
                <th style="padding: 8px 10px;">Retrofit</th>
                <th style="padding: 8px 10px;">Other</th>
                <th style="padding: 8px 10px;">Grand Total</th>
                <th style="padding: 8px 10px;"># WOs</th>
              </tr>
            </thead>
            <tbody>
              ${monthly.rows.map(m => `
                <tr style="border-top: 1px solid var(--line); text-align: right;">
                  <td style="padding: 8px 10px; text-align: left;"><strong>${escapeHTML(m.month)}</strong></td>
                  <td style="padding: 8px 10px;">${fmt$(m.actual_deployment)}</td>
                  <td style="padding: 8px 10px;">${fmt$(m.actual_retrofit)}</td>
                  <td style="padding: 8px 10px;">${fmt$(m.actual_other)}</td>
                  <td style="padding: 8px 10px; font-weight: 700;">${fmt$(m.actual_total)}</td>
                  <td style="padding: 8px 10px; color: var(--muted);">${m.wo_count}</td>
                </tr>
              `).join('')}
              <tr style="border-top: 2px solid var(--ic-green-deep); background: #f4faf6; text-align: right; font-weight: 800;">
                <td style="padding: 10px;">Grand Total</td>
                <td style="padding: 10px;" colspan="3"></td>
                <td style="padding: 10px;">${fmt$(monthly.totals.actual)}</td>
                <td style="padding: 10px;">${monthly.totals.wo_count}</td>
              </tr>
            </tbody>
          </table>
        </div>
      `}
    </div>

    <!-- ============ VISITS IN AP PIPELINE (submitted + approved) ============ -->
    <!-- v0.57 — one row per visit: invoice × work-order. A store visited
         three times shows up as three separate rows so Ops Mgrs can see
         every visit individually. Drafts excluded; only submitted /
         approved / paid-out statuses surface. Honors the period / store /
         work-type filters above. Click any row to open the invoice. -->
    <div class="card" style="margin-top: 14px;">
      <div class="flex between" style="align-items: center;">
        <div class="section-title" style="margin: 0;">VISITS IN AP PIPELINE · ${inflightVisits.grand_count} visit${inflightVisits.grand_count === 1 ? '' : 's'} · ${fmt$(inflightVisits.grand_total)}</div>
        <span class="meta" style="font-size: 11px;">One row per WO / vendor invoice · submitted + approved only</span>
      </div>
      ${inflightVisits.visits.length === 0 ? `
        <div class="empty" style="padding: 14px; font-size: 12px;">No submitted or approved invoices in this period.</div>
      ` : `
        <div style="overflow-x: auto; margin-top: 8px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 11.5px;">
            <thead>
              <tr style="background: #f4f5f7;">
                <th style="padding: 6px 8px; text-align: left;">Store</th>
                <th style="padding: 6px 8px; text-align: left;">Work Order</th>
                <th style="padding: 6px 8px; text-align: left;">Type</th>
                <th style="padding: 6px 8px; text-align: right;">Carts</th>
                <th style="padding: 6px 8px; text-align: left;">Service date</th>
                <th style="padding: 6px 8px; text-align: left;">Submitted by</th>
                <th style="padding: 6px 8px; text-align: right;">Labor</th>
                <th style="padding: 6px 8px; text-align: right;">Drive</th>
                <th style="padding: 6px 8px; text-align: right;">Expenses</th>
                <th style="padding: 6px 8px; text-align: left;">Invoice #</th>
                <th style="padding: 6px 8px; text-align: left;">Status</th>
                <th style="padding: 6px 8px; text-align: right;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${inflightVisits.visits.map(v => v.type === 'vendor' ? `
                <tr style="border-top: 1px solid var(--line); cursor: pointer; background: #fcf8ff;" data-tracker-inv="${v.invoice_id}">
                  <td style="padding: 6px 8px;"><strong>${escapeHTML(v.vendor_name || '— vendor —')}</strong></td>
                  <td style="padding: 6px 8px; color: var(--muted);">— (vendor invoice ${escapeHTML(v.vendor_invoice_number || '')})</td>
                  <td style="padding: 6px 8px;">${escapeHTML(v.vendor_category || '—')}</td>
                  <td style="padding: 6px 8px;"></td>
                  <td style="padding: 6px 8px;">${v.vendor_invoice_date ? fmtDate(v.vendor_invoice_date) : ''}</td>
                  <td style="padding: 6px 8px; color: var(--muted);">Ops Mgr</td>
                  <td style="padding: 6px 8px; text-align: right; color: var(--muted);">—</td>
                  <td style="padding: 6px 8px; text-align: right; color: var(--muted);">—</td>
                  <td style="padding: 6px 8px; text-align: right; font-weight: 600;">${fmt$(v.visit_total)}</td>
                  <td style="padding: 6px 8px; font-family: monospace; font-size: 10.5px;">${escapeHTML(v.invoice_number)}</td>
                  <td style="padding: 6px 8px;"><span class="badge ${badgeForStatus(v.status)}">${labelForStatus(v.status)}</span></td>
                  <td style="padding: 6px 8px; text-align: right; font-weight: 700;">${fmt$(v.visit_total)}</td>
                </tr>
              ` : `
                <tr style="border-top: 1px solid var(--line); cursor: pointer;" data-tracker-inv="${v.invoice_id}">
                  <td style="padding: 6px 8px;"><strong>${escapeHTML(v.store_name || '—')}</strong></td>
                  <td style="padding: 6px 8px; font-family: monospace; font-size: 10.5px;">${escapeHTML(v.wo_external_id)}</td>
                  <td style="padding: 6px 8px;">${escapeHTML(v.work_type || '—')}</td>
                  <td style="padding: 6px 8px; text-align: right;">${v.cart_count || ''}</td>
                  <td style="padding: 6px 8px;">${v.scheduled_date ? fmtDate(v.scheduled_date) : ''}</td>
                  <td style="padding: 6px 8px;">${escapeHTML(v.tech_name || '—')}</td>
                  <td style="padding: 6px 8px; text-align: right;">${v.labor_subtotal ? fmt$(v.labor_subtotal) : '<span style="color:var(--muted);">—</span>'}</td>
                  <td style="padding: 6px 8px; text-align: right;">${v.drive_subtotal ? fmt$(v.drive_subtotal) : '<span style="color:var(--muted);">—</span>'}</td>
                  <td style="padding: 6px 8px; text-align: right;">${v.expense_subtotal ? fmt$(v.expense_subtotal) : '<span style="color:var(--muted);">—</span>'}</td>
                  <td style="padding: 6px 8px; font-family: monospace; font-size: 10.5px;">${escapeHTML(v.invoice_number)}</td>
                  <td style="padding: 6px 8px;"><span class="badge ${badgeForStatus(v.status)}">${labelForStatus(v.status)}</span></td>
                  <td style="padding: 6px 8px; text-align: right; font-weight: 700;">${fmt$(v.visit_total)}</td>
                </tr>
              `).join('')}
              <tr style="border-top: 2px solid var(--ic-green-deep); background: #f4faf6; font-weight: 800;">
                <td colspan="11" style="padding: 10px;">Grand Total · ${inflightVisits.grand_count} visit${inflightVisits.grand_count === 1 ? '' : 's'}</td>
                <td style="padding: 10px; text-align: right;">${fmt$(inflightVisits.grand_total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      `}
    </div>

    <!-- ============ COST TRACKER MAIN section ============ -->
    <div class="card" style="margin-top: 14px;">
      <div class="flex between" style="align-items: center; flex-wrap: wrap; gap: 8px;">
        <div class="section-title" style="margin: 0;">COST TRACKER MAIN · ${rows.length} rows</div>
        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
          <select class="field" id="trackerStatus" style="width: 160px; padding: 6px 10px; font-size: 12px;">
            <option value=""             ${!STATE._trackerStatus ? 'selected' : ''}>All statuses</option>
            <option value="open"         ${STATE._trackerStatus === 'open' ? 'selected' : ''}>Open</option>
            <option value="in_progress"  ${STATE._trackerStatus === 'in_progress' ? 'selected' : ''}>In progress</option>
            <option value="completed"    ${STATE._trackerStatus === 'completed' ? 'selected' : ''}>Completed</option>
            <option value="cancelled"    ${STATE._trackerStatus === 'cancelled' ? 'selected' : ''}>Cancelled</option>
          </select>
          <label style="font-size: 12px; display: flex; gap: 6px; align-items: center; cursor: pointer;">
            <input type="checkbox" id="trackerOnlyMissing" ${STATE._trackerOnlyMissing ? 'checked' : ''} />
            Only missing data ${missingCount > 0 ? `(${missingCount})` : ''}
          </label>
          <input class="field" id="trackerSearch" type="search" placeholder="🔎 Filter…" value="${escapeHTML(STATE._trackerSearch)}" style="width: 220px; padding: 6px 10px; font-size: 12px;" />
        </div>
      </div>
      ${rows.length === 0 ? `<div class="empty">No work orders yet. Run the demo seed or assign techs to work orders.</div>` : `
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse; font-size: 11.5px; min-width: 1500px;">
            <thead>
              <tr style="background: #f4f5f7;">
                <th style="padding: 6px 8px;"></th>
                <th class="ts" data-sort="status" style="padding: 6px 8px; cursor: pointer;">Status${sortIco('status')}</th>
                <th style="padding: 6px 8px;">Reconciled</th>
                <th class="ts" data-sort="store_name"   style="padding: 6px 8px; cursor: pointer;">Store${sortIco('store_name')}</th>
                <th style="padding: 6px 8px;">PM DRI</th>
                <th style="padding: 6px 8px;">Ops Mgr</th>
                <th class="ts" data-sort="service_type" style="padding: 6px 8px; cursor: pointer;">Type${sortIco('service_type')}</th>
                <th class="ts" data-sort="cart_count"   style="padding: 6px 8px; cursor: pointer; text-align: right;"># Carts${sortIco('cart_count')}</th>
                <th style="padding: 6px 8px;">Service Month</th>
                <th class="ts" data-sort="service_date" style="padding: 6px 8px; cursor: pointer;">Completion${sortIco('service_date')}</th>
                <th style="padding: 6px 8px; text-align: right;"># Techs</th>
                <th style="padding: 6px 8px;">Technicians</th>
                <th class="ts" data-sort="actual_labor"  style="padding: 6px 8px; cursor: pointer; text-align: right;">Act Labor${sortIco('actual_labor')}</th>
                <th class="ts" data-sort="actual_travel" style="padding: 6px 8px; cursor: pointer; text-align: right;">Act Travel${sortIco('actual_travel')}</th>
                <th class="ts" data-sort="actual_expenses" style="padding: 6px 8px; cursor: pointer; text-align: right;">Act Expenses${sortIco('actual_expenses')}</th>
                <th style="padding: 6px 8px;">Delay</th>
                <th style="padding: 6px 8px;">3P Vendor</th>
                <th style="padding: 6px 8px; text-align: right;">3P Cost</th>
                <th class="ts" data-sort="actual_total" style="padding: 6px 8px; cursor: pointer; text-align: right;">Act Total${sortIco('actual_total')}</th>
                <th style="padding: 6px 8px;">Invoice</th>
                <th style="padding: 6px 8px;">Notes</th>
                <th style="padding: 6px 8px;"></th>
              </tr>
            </thead>
            <tbody>
              ${slice.map(row => {
                const rowBg = row.missing_data ? 'background: #fff8f0;' : '';
                const flag  = row.missing_data ? '<span title="No actuals data — needs manual entry" style="color: var(--ic-orange); font-weight: 800;">⚠</span>' :
                              row.is_edited    ? '<span title="Edited by Ops Mgr" style="color: var(--ic-green-deep); font-weight: 800;">✏</span>' : '';
                return `
                  <tr style="border-top: 1px solid var(--line); cursor: pointer; ${rowBg}" data-edit-wo="${row.wo_id}">
                    <td style="padding: 6px 8px; text-align: center;">${flag}</td>
                    <td style="padding: 6px 8px;">${(() => {
                      const s = row.status || 'open';
                      const color = s === 'completed' ? 'var(--ic-green-deep)'
                                  : s === 'in_progress' ? 'var(--ic-orange)'
                                  : s === 'cancelled' ? 'var(--muted)'
                                  : 'var(--ink-2)';
                      return `<span style="font-size: 10px; font-weight: 700; color: ${color}; text-transform: uppercase; letter-spacing: 0.4px;">${escapeHTML(labelForStatus(s))}</span>`;
                    })()}</td>
                    <td style="padding: 6px 8px;">${row.cost_reconciled === 'Yes' ? '<span style="color: var(--ic-green-deep);">✓</span>' : ''}</td>
                    <td style="padding: 6px 8px;"><strong>${escapeHTML(row.store_name || '')}</strong></td>
                    <td style="padding: 6px 8px; color: ${row.pm_dri ? 'inherit' : 'var(--muted)'};">${escapeHTML(row.pm_dri || '—')}</td>
                    <td style="padding: 6px 8px; color: ${row.ops_manager ? 'inherit' : 'var(--muted)'};">${escapeHTML(row.ops_manager || '—')}</td>
                    <td style="padding: 6px 8px;">${escapeHTML(row.service_type || '')}</td>
                    <td style="padding: 6px 8px; text-align: right;">${row.cart_count || ''}</td>
                    <td style="padding: 6px 8px;">${escapeHTML(row.service_month || '')}</td>
                    <td style="padding: 6px 8px;">${row.service_date ? fmtDate(row.service_date) : ''}</td>
                    <td style="padding: 6px 8px; text-align: right;">${row.num_techs || ''}</td>
                    <td style="padding: 6px 8px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHTML(row.tech_names || '')}">${escapeHTML(row.tech_names || '—')}</td>
                    <td style="padding: 6px 8px; text-align: right;">${row.actual_labor  ? fmt$(row.actual_labor)  : '<span style="color: var(--muted);">—</span>'}</td>
                    <td style="padding: 6px 8px; text-align: right;">${row.actual_travel ? fmt$(row.actual_travel) : '<span style="color: var(--muted);">—</span>'}</td>
                    <td style="padding: 6px 8px; text-align: right;">${row.actual_expenses ? fmt$(row.actual_expenses) : '<span style="color: var(--muted);">—</span>'}</td>
                    <td style="padding: 6px 8px; color: var(--muted);">${escapeHTML(row.service_delay || 'None')}</td>
                    <td style="padding: 6px 8px;">${row.has_third_party ? `${escapeHTML(row.third_party_vendor || 'Yes')}` : 'No'}</td>
                    <td style="padding: 6px 8px; text-align: right;">${row.third_party_cost ? fmt$(row.third_party_cost) : ''}</td>
                    <td style="padding: 6px 8px; text-align: right; font-weight: 700;">${fmt$(row.actual_total)}</td>
                    <td style="padding: 6px 8px; color: var(--muted); font-family: monospace; font-size: 10px;">${escapeHTML(row.invoice_link || '')}</td>
                    <td style="padding: 6px 8px; color: var(--muted); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHTML(row.notes || '')}">${escapeHTML(row.notes || '')}</td>
                    <td style="padding: 6px 8px; text-align: right; white-space: nowrap;">
                      <button class="btn btn-ghost btn-sm" data-open-wo="${row.wo_id}" title="Open full work order (view & tag line items)">↗ WO</button>
                      <button class="btn btn-ghost btn-sm" data-edit-btn="${row.wo_id}" title="Edit row / tag unplanned">✏️</button>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
        ${pageCount > 1 ? `
          <div class="flex between" style="margin-top: 12px; align-items: center;">
            <button class="btn btn-ghost btn-sm" id="trackerPrev" ${STATE._trackerPage === 0 ? 'disabled' : ''}>‹ Prev</button>
            <span class="meta">Page ${STATE._trackerPage + 1} of ${pageCount} · ${sortedRows.length} row${sortedRows.length === 1 ? '' : 's'}</span>
            <button class="btn btn-ghost btn-sm" id="trackerNext" ${STATE._trackerPage === pageCount - 1 ? 'disabled' : ''}>Next ›</button>
          </div>
        ` : ''}
      `}
    </div>
  `;

  $$('[data-period]').forEach(b => b.addEventListener('click', () => { STATE._dashPeriod = b.dataset.period; goto('tracker'); }));
  $('#trackerSearch')?.addEventListener('input', (ev) => {
    STATE._trackerSearch = ev.target.value || '';
    STATE._trackerPage = 0;
    renderCostTracker(root);
  });
  $('#trackerOnlyMissing')?.addEventListener('change', (ev) => {
    STATE._trackerOnlyMissing = !!ev.target.checked;
    STATE._trackerPage = 0;
    renderCostTracker(root);
  });
  $('#trackerStatus')?.addEventListener('change', (ev) => {
    STATE._trackerStatus = ev.target.value || '';
    STATE._trackerPage = 0;
    renderCostTracker(root);
  });
  $$('.ts[data-sort]').forEach(th => th.addEventListener('click', () => {
    const c = th.dataset.sort;
    STATE._trackerSort = STATE._trackerSort.col === c
      ? { col: c, dir: STATE._trackerSort.dir === 'asc' ? 'desc' : 'asc' }
      : { col: c, dir: 'asc' };
    renderCostTracker(root);
  }));
  $('#trackerPrev')?.addEventListener('click', () => { STATE._trackerPage--; renderCostTracker(root); });
  $('#trackerNext')?.addEventListener('click', () => { STATE._trackerPage++; renderCostTracker(root); });
  // Click row OR explicit edit button → open edit sheet
  $$('[data-edit-wo]').forEach(tr => tr.addEventListener('click', (ev) => {
    if (ev.target.closest('button')) return; // let the button handle its own click
    openCostTrackerEditSheet(Number(tr.dataset.editWo), rows, () => renderCostTracker(root));
  }));
  $$('[data-edit-btn]').forEach(btn => btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openCostTrackerEditSheet(Number(btn.dataset.editBtn), rows, () => renderCostTracker(root));
  }));
  // v0.64 — jump straight to the full work-order detail (where managers can
  // review each tech's labor/expenses and tag individual line items).
  $$('[data-open-wo]').forEach(btn => btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    goto('woDetail', Number(btn.dataset.openWo));
  }));
  // v0.57 — clicking an invoice row in the "by store" rollup opens the
  // invoice detail page so the Ops Mgr can review / approve from there.
  $$('[data-tracker-inv]').forEach(tr => tr.addEventListener('click', () => {
    goto('invDetail', Number(tr.dataset.trackerInv));
  }));
  // v0.45 — wire the Excel button on the Cost Tracker tab to the secure
  // download-token flow (no bearer token in URL).
  $$('.dash-export-btn').forEach(b => b.addEventListener('click', () => {
    downloadWithToken('/api/dashboard/export', b.dataset.exportQs || '');
  }));
  $('#trackerPushDriveBtn')?.addEventListener('click', async () => {
    const btn = $('#trackerPushDriveBtn');
    btn.disabled = true; btn.textContent = '⏳ Checking…';
    try {
      const status = await api('/dashboard/drive-status');
      if (!status.configured) {
        btn.disabled = false; btn.textContent = '📤 Push to Drive';
        toast('Google Sheets not configured — see DEPLOY-GOOGLE.md', 'err');
        return;
      }
      btn.textContent = '⏳ Pushing…';
      const out = await api(`/dashboard/push-to-drive?${qs.toString()}`, { method: 'POST' });
      btn.disabled = false; btn.textContent = '📤 Push to Drive';
      toast(`Pushed ${out.tabs.length} tabs · ${out.rows_written} rows ✓`, 'ok');
      window.open(out.sheet_url, '_blank', 'noopener');
    } catch (e) {
      btn.disabled = false; btn.textContent = '📤 Push to Drive';
      toast(e.message || 'Push failed', 'err');
    }
  });
}

// v0.42 — Edit sheet for a single Cost Tracker row. Persists via PATCH
// /api/cost-tracker/:wo_id which writes to cost_tracker_overrides. Empty
// fields fall back to the computed defaults (so "clear" = "use computed").
function openCostTrackerEditSheet(woId, rows, onSaved) {
  const row = rows.find(r => r.wo_id === woId);
  if (!row) return toast('Row not found', 'err');

  showSheet(`
    <h3>Edit · ${escapeHTML(row.store_name || '(no store)')}</h3>
    <p class="help" style="margin-bottom: 12px;">
      ${escapeHTML(row.service_type || '')} · ${row.cart_count || 0} carts · ${row.service_date ? fmtDate(row.service_date) : 'no date'}
      ${row.missing_data ? `<br/><span style="color: var(--ic-orange);">⚠ No actuals data on this WO yet — fill in what you know.</span>` : ''}
    </p>

    <div style="margin: 4px 0 14px; padding: 10px 12px; border: 1px solid var(--ic-orange); border-radius: 8px; background: #fff7ef;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
        <div>
          <div style="font-size: 13px; font-weight: 700; color: var(--ic-orange-deep);">Unplanned / wasted labour</div>
          <div style="font-size: 11px; color: var(--muted);">Flags this WO for leadership reporting. Backend only — never shown on the AP invoice.</div>
        </div>
        <div id="ctEdUnplanned"><span style="font-size:11px;color:var(--muted);">Loading…</span></div>
      </div>
      <button class="btn btn-ghost btn-sm" id="ctEdOpenWo" style="margin-top: 10px;">Open full work order → tag individual labor & expenses</button>
    </div>

    <span class="label">Cost Reconciled</span>
    <select class="field" id="ctEdReconciled">
      <option value="No"  ${row.cost_reconciled !== 'Yes' ? 'selected' : ''}>No</option>
      <option value="Yes" ${row.cost_reconciled === 'Yes' ? 'selected' : ''}>Yes</option>
    </select>

    <div class="flex gap-12" style="margin-top: 8px;">
      <div style="flex:1;">
        <span class="label">PM DRI</span>
        <input class="field" id="ctEdPmDri" type="text" value="${escapeHTML(row.pm_dri || '')}" placeholder="e.g., Andrew" />
      </div>
      <div style="flex:1;">
        <span class="label">Ops Manager</span>
        <input class="field" id="ctEdOps" type="text" value="${escapeHTML(row.ops_manager || '')}" placeholder="e.g., Keenan" />
      </div>
    </div>

    <div class="flex gap-12" style="margin-top: 8px;">
      <div style="flex:1;">
        <span class="label"># Techs</span>
        <input class="field" id="ctEdNumTechs" type="number" min="0" step="1" value="${row.num_techs || ''}" placeholder="${row.computed?.num_techs || 1}" />
      </div>
      <div style="flex:2;">
        <span class="label">Technician(s)</span>
        <input class="field" id="ctEdTechNames" type="text" value="${escapeHTML(row.tech_names || '')}" placeholder="${escapeHTML(row.computed?.tech_names || 'Comma-separated names')}" />
      </div>
    </div>

    <div class="flex gap-12" style="margin-top: 8px;">
      <div style="flex:1;">
        <span class="label">Actual Labor ($)</span>
        <input class="field" id="ctEdLabor" type="number" min="0" step="0.01" value="${row.actual_labor != null ? row.actual_labor : ''}" placeholder="${row.computed?.actual_labor || 0}" />
        <div style="font-size: 10px; color: var(--muted); margin-top: 2px;">Computed from time entries: ${fmt$(row.computed?.actual_labor || 0)}</div>
      </div>
      <div style="flex:1;">
        <span class="label">Actual Travel ($)</span>
        <input class="field" id="ctEdTravel" type="number" min="0" step="0.01" value="${row.actual_travel != null ? row.actual_travel : ''}" placeholder="${row.computed?.actual_travel || 0}" />
        <div style="font-size: 10px; color: var(--muted); margin-top: 2px;">Drive time + travel: ${fmt$(row.computed?.actual_travel || 0)}</div>
      </div>
      <div style="flex:1;">
        <span class="label">Actual Expenses ($)</span>
        <input class="field" id="ctEdExpenses" type="number" min="0" step="0.01" value="${row.actual_expenses != null ? row.actual_expenses : ''}" placeholder="${row.computed?.actual_expenses || 0}" />
        <div style="font-size: 10px; color: var(--muted); margin-top: 2px;">Materials / other: ${fmt$(row.computed?.actual_expenses || 0)}</div>
      </div>
    </div>

    <span class="label" style="margin-top: 8px;">Service Delay</span>
    <select class="field" id="ctEdDelay">
      ${['None','Tech delay','Customer delay','Weather','Parts','Schedule','Other'].map(o =>
        `<option ${row.service_delay === o ? 'selected' : ''}>${o}</option>`).join('')}
    </select>

    <label style="margin-top: 8px; display: flex; gap: 6px; align-items: center; cursor: pointer; font-size: 13px;">
      <input type="checkbox" id="ctEdHas3p" ${row.has_third_party ? 'checked' : ''} />
      Third-party vendor was involved
    </label>
    <div id="ctEd3pBlock" style="${row.has_third_party ? '' : 'display: none;'} margin-top: 6px;">
      <div class="flex gap-12">
        <div style="flex:2;">
          <span class="label">Vendor name</span>
          <input class="field" id="ctEd3pVendor" type="text" value="${escapeHTML(row.third_party_vendor || '')}" placeholder="e.g., GlideRite" />
        </div>
        <div style="flex:1;">
          <span class="label">3P Cost ($)</span>
          <input class="field" id="ctEd3pCost" type="number" min="0" step="0.01" value="${row.third_party_cost || ''}" placeholder="0.00" />
        </div>
      </div>
    </div>

    <span class="label" style="margin-top: 8px;">Notes</span>
    <textarea class="field" id="ctEdNotes" rows="2" placeholder="Anything noteworthy about this WO…">${escapeHTML(row.notes || '')}</textarea>

    <div class="actions" style="margin-top: 14px;">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      ${row.is_edited ? `<button class="btn btn-danger" id="ctEdReset">Reset to computed</button>` : ''}
      <button class="btn btn-primary" id="ctEdSave">💾 Save</button>
    </div>
  `, {
    onMount: (wrap) => {
      $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);
      // v0.64 — load the WO's current unplanned tag state, then render + wire a
      // prominent "Tag as unplanned" button. Also wire "open full work order".
      (async () => {
        let woTag = null, woNote = null;
        try { const wo = await api(`/workorders/${woId}`); woTag = wo.unplanned_tag; woNote = wo.unplanned_note; } catch (_) {}
        const holder = $('#ctEdUnplanned', wrap);
        if (holder) {
          holder.innerHTML = renderUnplannedTagBtn('work_order', woId, woTag, woNote);
          wireUnplannedTagBtns(holder);
        }
      })();
      $('#ctEdOpenWo', wrap)?.addEventListener('click', () => { closeSheet(); goto('woDetail', woId); });
      $('#ctEdHas3p', wrap).addEventListener('change', (ev) => {
        $('#ctEd3pBlock', wrap).style.display = ev.target.checked ? '' : 'none';
      });
      $('#ctEdReset', wrap)?.addEventListener('click', async () => {
        if (!confirm('Clear all manual edits on this row and revert to computed values?')) return;
        try {
          await api(`/cost-tracker/${woId}/override`, { method: 'DELETE' });
          toast('Reset to computed ✓', 'ok');
          closeSheet();
          onSaved?.();
        } catch (e) { toast(e.message, 'err'); }
      });
      $('#ctEdSave', wrap).addEventListener('click', async () => {
        const has3p = $('#ctEdHas3p', wrap).checked;
        const body = {
          cost_reconciled:    $('#ctEdReconciled', wrap).value,
          pm_dri:             $('#ctEdPmDri',      wrap).value.trim(),
          ops_manager:        $('#ctEdOps',        wrap).value.trim(),
          num_techs:          $('#ctEdNumTechs',   wrap).value === '' ? null : Number($('#ctEdNumTechs', wrap).value),
          tech_names:         $('#ctEdTechNames',  wrap).value.trim(),
          actual_labor:       $('#ctEdLabor',      wrap).value === '' ? null : Number($('#ctEdLabor',  wrap).value),
          actual_travel:      $('#ctEdTravel',     wrap).value === '' ? null : Number($('#ctEdTravel', wrap).value),
          actual_expenses:    $('#ctEdExpenses',   wrap).value === '' ? null : Number($('#ctEdExpenses', wrap).value),
          service_delay:      $('#ctEdDelay',      wrap).value,
          has_third_party:    has3p,
          third_party_vendor: has3p ? $('#ctEd3pVendor', wrap).value.trim() : null,
          third_party_cost:   has3p ? Number($('#ctEd3pCost', wrap).value || 0) : null,
          notes:              $('#ctEdNotes',      wrap).value.trim(),
        };
        try {
          await api(`/cost-tracker/${woId}`, { method: 'PATCH', body });
          toast('Saved ✓', 'ok');
          closeSheet();
          onSaved?.();
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

// ---- CORP CARD LEDGER (manager-only, v0.60) ----
// A separate ledger for corporate-card spend filed by Ops/Sr managers on
// behalf of techs (or for events / software at the Sr-Mgr level). Lives
// outside the tech invoice flow so corp-card amounts are NEVER mixed into
// reimbursable tech invoice totals — strongest double-count protection.

// Session-scoped filter state so flipping between tabs preserves the view.
const CC_STATE = {
  scope: 'mtd',                  // 'mtd' | 'ytd' | 'all' | 'custom'
  from: '', to: '',              // only used when scope='custom'
  category_id: '',               // '' = all
  tech_id: '',                   // '' = all
};

function ccPeriodBounds() {
  const now = new Date();
  const y   = now.getUTCFullYear();
  const m   = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d   = String(now.getUTCDate()).padStart(2, '0');
  const today = `${y}-${m}-${d}`;
  if (CC_STATE.scope === 'mtd')   return { from: `${y}-${m}-01`, to: today, label: `Month-to-date · ${y}-${m}` };
  if (CC_STATE.scope === 'ytd')   return { from: `${y}-01-01`,   to: today, label: `Year-to-date · ${y}` };
  if (CC_STATE.scope === 'all')   return { from: '1970-01-01',   to: today, label: 'All time' };
  return { from: CC_STATE.from || `${y}-${m}-01`, to: CC_STATE.to || today, label: `${CC_STATE.from || '—'} → ${CC_STATE.to || '—'}` };
}

async function renderCorpCard(root) {
  // Gate at the UI level too (the API gates server-side regardless).
  if (!['ops_manager','sr_manager','pm'].includes(STATE.user?.role)) {
    root.innerHTML = `<div class="empty"><div class="big">🔒</div>Corp Card is manager-only.</div>`;
    return;
  }

  const { from, to, label } = ccPeriodBounds();
  const [summary, exps, cats, wos, allUsers] = await Promise.all([
    api(`/corp-card/summary?from=${from}&to=${to}`),
    api(`/corp-card/expenses?from=${from}&to=${to}` +
        (CC_STATE.category_id ? `&category_id=${CC_STATE.category_id}` : '') +
        (CC_STATE.tech_id     ? `&tech_id=${CC_STATE.tech_id}`         : '')),
    api('/corp-card/categories'),
    api('/workorders').catch(() => []),
    api('/admin/users').catch(() => null),  // optional; falls back to /team if forbidden
  ]);

  // v0.62.1 — the on-behalf-of picker on the Add Corp-Card sheet now accepts
  // any active teammate (technician OR manager), not just techs. Operations
  // managers sometimes need to file a corp-card charge on behalf of another
  // manager (e.g., a Sr Mgr's flight). Backend already validates any user_id.
  let techs = [];
  if (allUsers && Array.isArray(allUsers)) {
    techs = allUsers
      .filter(u => u.status !== 'disabled')
      .map(u => ({ id: u.id, name: u.name, role: u.role }));
  } else {
    try {
      const team = await api('/team');
      const rows = (team.team || team || []).filter(t => t && (t.id || t.tech_user_id));
      techs = rows.map(t => ({
        id:   t.id || t.tech_user_id,
        name: t.name || t.tech_name,
        role: t.role || 'technician',
      }));
    } catch (_) { techs = []; }
  }
  // Sort technicians first (most common case for corp-card on-behalf-of), then
  // by name within each group.
  techs.sort((a, b) => {
    if ((a.role === 'technician') !== (b.role === 'technician')) {
      return a.role === 'technician' ? -1 : 1;
    }
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  root.innerHTML = `
    <!-- Header band: period scope + filters + primary actions -->
    <div class="card" style="padding: 12px 14px; margin-bottom: 12px;">
      <div class="flex between" style="align-items: center; gap: 10px; flex-wrap: wrap;">
        <div>
          <div class="section-title" style="margin: 0;">Corporate-card ledger</div>
          <div class="meta" style="margin-top: 2px;">${escapeHTML(label)} · ${summary.totals.count_in_period} charge${summary.totals.count_in_period === 1 ? '' : 's'}</div>
        </div>
        <div class="flex gap-12">
          <button class="btn btn-ghost btn-sm" id="ccManageCats">⚙ Manage categories</button>
          <button class="btn btn-primary btn-sm" id="ccAddBtn">＋ Add corp-card expense</button>
        </div>
      </div>

      <div class="chips" style="margin-top: 12px;">
        ${['mtd','ytd','all','custom'].map(s => `
          <span class="chip ${CC_STATE.scope === s ? 'selected' : ''}" data-scope="${s}">
            ${s === 'mtd' ? 'Month' : s === 'ytd' ? 'YTD' : s === 'all' ? 'All' : 'Custom'}
          </span>
        `).join('')}
      </div>

      ${CC_STATE.scope === 'custom' ? `
        <div class="flex gap-12" style="margin-top: 8px;">
          <input class="field" type="date" id="ccFrom" value="${escapeHTML(CC_STATE.from || from)}" />
          <input class="field" type="date" id="ccTo"   value="${escapeHTML(CC_STATE.to   || to)}" />
        </div>
      ` : ''}
    </div>

    <!-- Headline total — what the user came here to see -->
    <div class="card" style="padding: 18px 20px; margin-bottom: 12px; background: linear-gradient(135deg, var(--ic-cream) 0%, #fff 80%); border-left: 4px solid var(--ic-green-deep);">
      <div style="font-size: 11px; color: var(--ic-green-deep); text-transform: uppercase; letter-spacing: 0.6px; font-weight: 700;">
        Total corp-card spend · ${escapeHTML(label)}
      </div>
      <div style="font-size: 36px; font-weight: 800; color: var(--ic-green-deep); margin-top: 4px;">
        ${fmt$(summary.totals.in_period)}
      </div>
      <div class="meta" style="margin-top: 4px;">
        MTD ${fmt$(summary.totals.mtd)} · YTD ${fmt$(summary.totals.ytd)} · All-time ${fmt$(summary.totals.all_time)} (${summary.totals.all_time_count} charges).
        Lives separately from tech invoices — never double-counted into reimbursement.
      </div>
    </div>

    <!-- Filters row (category + tech) -->
    <div class="card" style="padding: 10px 14px; margin-bottom: 12px;">
      <div class="flex gap-12" style="flex-wrap: wrap;">
        <div style="flex: 1; min-width: 160px;">
          <span class="label">Category</span>
          <select class="field" id="ccFilterCat">
            <option value="">All categories</option>
            ${cats.filter(c => !c.archived_at).map(c => `
              <option value="${c.id}" ${String(CC_STATE.category_id) === String(c.id) ? 'selected' : ''}>${escapeHTML(c.name)}</option>
            `).join('')}
          </select>
        </div>
        <div style="flex: 1; min-width: 160px;">
          <span class="label">On behalf of</span>
          <select class="field" id="ccFilterTech">
            <option value="">All teammates (incl. unassigned)</option>
            <option value="__none__" ${CC_STATE.tech_id === '__none__' ? 'selected' : ''}>Unassigned (Sr-Mgr events)</option>
            ${(() => {
              const techList = techs.filter(t => t.role === 'technician');
              const teamList = techs.filter(t => t.role !== 'technician');
              const techOpts = techList.map(t => `<option value="${t.id}" ${String(CC_STATE.tech_id) === String(t.id) ? 'selected' : ''}>${escapeHTML(t.name)}</option>`).join('');
              const teamOpts = teamList.map(t => `<option value="${t.id}" ${String(CC_STATE.tech_id) === String(t.id) ? 'selected' : ''}>${escapeHTML(t.name)} (${escapeHTML(roleLabel(t.role))})</option>`).join('');
              return `${techList.length ? `<optgroup label="Technicians">${techOpts}</optgroup>` : ''}${teamList.length ? `<optgroup label="Managers / teammates">${teamOpts}</optgroup>` : ''}`;
            })()}
          </select>
        </div>
      </div>
    </div>

    <!-- Breakdown cards: by category + by tech -->
    <div class="dash-grid-2" style="margin-bottom: 12px;">
      <div class="card">
        <div class="section-title" style="margin-top: 0;">By category</div>
        ${summary.by_category.length ? `
          <table class="cc-table">
            ${summary.by_category.map(c => {
              const pct = summary.totals.in_period > 0 ? (c.total / summary.totals.in_period) * 100 : 0;
              return `
                <tr>
                  <td><strong>${escapeHTML(c.category_name)}</strong></td>
                  <td class="r"><span class="meta">${c.count}</span></td>
                  <td class="r"><strong>${fmt$(c.total)}</strong></td>
                  <td style="width: 80px;"><div class="cc-bar"><div class="cc-bar-fill" style="width: ${pct.toFixed(1)}%"></div></div></td>
                </tr>
              `;
            }).join('')}
          </table>
        ` : `<div class="empty" style="padding: 12px;">No spend in this period.</div>`}
      </div>
      <div class="card">
        <div class="section-title" style="margin-top: 0;">By tech / owner</div>
        ${summary.by_tech.length ? `
          <table class="cc-table">
            ${summary.by_tech.map(t => `
              <tr>
                <td><strong>${escapeHTML(t.tech_name)}</strong>${t.tech_role && t.tech_role !== 'technician' ? ` <span class="meta">· ${escapeHTML(t.tech_role)}</span>` : ''}</td>
                <td class="r"><span class="meta">${t.count}</span></td>
                <td class="r"><strong>${fmt$(t.total)}</strong></td>
              </tr>
            `).join('')}
          </table>
        ` : `<div class="empty" style="padding: 12px;">No spend in this period.</div>`}
      </div>
    </div>

    <!-- Line-item list -->
    <div class="card">
      <div class="section-title" style="margin-top: 0;">Charges (${exps.length})</div>
      ${exps.length === 0 ? `
        <div class="empty" style="padding: 14px;">No corp-card charges match these filters.</div>
      ` : `
        <table class="cc-exp-table">
          <thead>
            <tr>
              <th>Date</th><th>Category</th><th>Tech</th><th>Work order · Store</th><th>Description</th>
              <th>Filed by</th><th>Unplanned</th><th class="r">Amount</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${exps.map(e => `
              <tr data-cc-id="${e.id}">
                <td>${fmtShortDate(e.expense_date)}</td>
                <td><span class="cc-cat-pill">${escapeHTML(e.category_name)}</span></td>
                <td>${e.on_behalf_of_name ? escapeHTML(e.on_behalf_of_name) : '<span class="meta">—</span>'}</td>
                <td>
                  ${e.wo_external_id ? `<strong>${escapeHTML(e.wo_external_id)}</strong>` : '<span class="meta">—</span>'}
                  ${e.store_name ? `<div class="meta">${escapeHTML(e.store_name)}</div>` : ''}
                </td>
                <td>${e.description ? escapeHTML(e.description) : '<span class="meta">—</span>'}</td>
                <td>${escapeHTML(e.created_by_name)}<div class="meta">${escapeHTML(e.created_by_role)}</div></td>
                <td>${renderUnplannedTagBtn('corp_card_expense', e.id, e.unplanned_tag, e.unplanned_note, e.amount, e.unplanned_wasted)}${unplannedSplitLine(e.unplanned_tag, e.unplanned_wasted, e.amount)}</td>
                <td class="r amt-pos"><strong>${fmt$(e.amount)}</strong></td>
                <td class="r">
                  <button class="btn-icon" title="Edit"   data-cc-edit="${e.id}">✏️</button>
                  <button class="btn-icon btn-icon-danger" title="Delete" data-cc-del="${e.id}">×</button>
                </td>
              </tr>
            `).join('')}
            <tr class="cc-total-row">
              <td colspan="7" class="r"><strong>Subtotal</strong></td>
              <td class="r amt-total"><strong>${fmt$(exps.reduce((s, e) => s + e.amount, 0))}</strong></td>
              <td></td>
            </tr>
          </tbody>
        </table>
      `}
    </div>
  `;

  // ---- bindings ---------------------------------------------------------
  $$('#tabbar .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'corpcard'));

  $$('.chip[data-scope]').forEach(c => c.addEventListener('click', () => {
    CC_STATE.scope = c.dataset.scope;
    if (CC_STATE.scope !== 'custom') { CC_STATE.from = ''; CC_STATE.to = ''; }
    renderCorpCard(root);
  }));
  $('#ccFrom')?.addEventListener('change', e => { CC_STATE.from = e.target.value; renderCorpCard(root); });
  $('#ccTo')  ?.addEventListener('change', e => { CC_STATE.to   = e.target.value; renderCorpCard(root); });
  $('#ccFilterCat') ?.addEventListener('change', e => { CC_STATE.category_id = e.target.value; renderCorpCard(root); });
  $('#ccFilterTech')?.addEventListener('change', e => { CC_STATE.tech_id     = e.target.value; renderCorpCard(root); });

  $('#ccAddBtn').addEventListener('click', () => openCorpCardAddSheet(cats, wos, techs, () => renderCorpCard(root)));
  $('#ccManageCats').addEventListener('click', () => openCorpCardCategoriesSheet(() => renderCorpCard(root)));

  // Per-row edit / delete
  $$('[data-cc-edit]').forEach(b => b.addEventListener('click', async () => {
    const id  = Number(b.dataset.ccEdit);
    const row = await api(`/corp-card/expenses/${id}`);
    openCorpCardAddSheet(cats, wos, techs, () => renderCorpCard(root), row);
  }));
  $$('[data-cc-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this corp-card charge?')) return;
    try {
      await api(`/corp-card/expenses/${b.dataset.ccDel}`, { method: 'DELETE' });
      toast('Deleted ✓', 'ok');
      renderCorpCard(root);
    } catch (err) { toast(err.message, 'err'); }
  }));

  // v0.63 — every corp-card charge is taggable as unplanned (wasted_labour /
  // ad_hoc / unexpected), so corp-card spend rolls into the leadership summary
  // alongside labor, tech expenses, and WO-level tags.
  wireUnplannedTagBtns(root);
}

// Add / Edit a corp-card charge.
//   editing === a full expense row → edit mode; else creation.
function openCorpCardAddSheet(categories, workorders, techs, onSaved, editing = null) {
  const activeCats = categories.filter(c => !c.archived_at);
  const sel = {
    id:                   editing?.id            || null,
    category_id:          editing?.category_id   || activeCats[0]?.id || '',
    expense_date:         editing?.expense_date  || todayISO(),
    amount:               editing?.amount        || '',
    description:          editing?.description   || '',
    work_order_id:        editing?.work_order_id || '',
    on_behalf_of_user_id: editing?.on_behalf_of_user_id || '',
    wo_search:            '',
  };
  const openWos = workorders.filter(w => ['open','in_progress','done'].includes(w.status));

  function woFiltered() {
    const q = (sel.wo_search || '').toLowerCase();
    return q
      ? openWos.filter(w => (w.external_id + ' ' + (w.store_name||'') + ' ' + (w.work_type||'')).toLowerCase().includes(q))
      : openWos;
  }

  showSheet(`
    <h3>${editing ? 'Edit corp-card charge' : 'New corp-card charge'}</h3>
    <p class="help" style="margin-top:-4px;">Charged to a corporate card · does NOT appear on the tech's reimbursable invoice.</p>

    <span class="label">Category</span>
    <select class="field" id="ccCat">
      ${activeCats.map(c => `<option value="${c.id}" ${String(sel.category_id) === String(c.id) ? 'selected' : ''}>${escapeHTML(c.name)}</option>`).join('')}
    </select>

    <span class="label">Date</span>
    <input class="field" type="date" id="ccDate" value="${sel.expense_date}" />

    <span class="label">Amount ($)</span>
    <input class="field" type="number" step="0.01" min="0" id="ccAmt" placeholder="0.00" value="${escapeHTML(String(sel.amount || ''))}" />

    <span class="label">On behalf of (optional — tech or teammate)</span>
    <select class="field" id="ccTech">
      <option value="">— Not tied to a specific person —</option>
      ${(() => {
        const techList = techs.filter(t => t.role === 'technician');
        const teamList = techs.filter(t => t.role !== 'technician');
        const techOpts = techList.map(t => `<option value="${t.id}" ${String(sel.on_behalf_of_user_id) === String(t.id) ? 'selected' : ''}>${escapeHTML(t.name)}</option>`).join('');
        const teamOpts = teamList.map(t => `<option value="${t.id}" ${String(sel.on_behalf_of_user_id) === String(t.id) ? 'selected' : ''}>${escapeHTML(t.name)} (${escapeHTML(roleLabel(t.role))})</option>`).join('');
        return `${techList.length ? `<optgroup label="Technicians">${techOpts}</optgroup>` : ''}${teamList.length ? `<optgroup label="Managers / teammates">${teamOpts}</optgroup>` : ''}`;
      })()}
    </select>

    <span class="label">Work order (optional — links to store)</span>
    <input class="field" id="ccWoSearch" placeholder="🔎 Search by ID, store, type…" style="margin-bottom:6px;" />
    <select class="field" id="ccWo" size="${Math.min(5, Math.max(2, openWos.length || 2))}">
      <option value="">— No work order / store linkage —</option>
      ${woFiltered().map(w => `
        <option value="${w.id}" ${String(sel.work_order_id) === String(w.id) ? 'selected' : ''}>
          ${escapeHTML(w.external_id)} — ${escapeHTML(w.store_name || '')} (${workTypeLabel(w.work_type)})
        </option>
      `).join('')}
    </select>

    <span class="label">Description</span>
    <input class="field" id="ccDesc" placeholder="e.g., Marriott Edgewater — 2 nights" value="${escapeHTML(sel.description || '')}" />

    <div class="actions">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      <button class="btn btn-primary" id="ccSave">${editing ? 'Save changes' : 'Add charge'}</button>
    </div>
  `, {
    onMount: (wrap) => {
      $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);
      $('#ccWoSearch', wrap).addEventListener('input', e => {
        sel.wo_search = e.target.value;
        const list = woFiltered();
        $('#ccWo', wrap).innerHTML = `
          <option value="">— No work order / store linkage —</option>
          ${list.map(w => `<option value="${w.id}">${escapeHTML(w.external_id)} — ${escapeHTML(w.store_name || '')} (${workTypeLabel(w.work_type)})</option>`).join('')}
        `;
      });
      $('#ccSave', wrap).addEventListener('click', async () => {
        const body = {
          category_id:  Number($('#ccCat',  wrap).value),
          expense_date: $('#ccDate', wrap).value,
          amount:       Number($('#ccAmt',  wrap).value),
          description:  $('#ccDesc', wrap).value || null,
        };
        const tech = $('#ccTech', wrap).value;
        const wo   = $('#ccWo',   wrap).value;
        body.on_behalf_of_user_id = tech ? Number(tech) : null;
        body.work_order_id        = wo   ? Number(wo)   : null;

        if (!body.category_id) return toast('Pick a category', 'err');
        if (!body.expense_date) return toast('Enter a date', 'err');
        if (!body.amount || !(body.amount > 0)) return toast('Enter an amount > 0', 'err');

        try {
          if (sel.id) {
            await api(`/corp-card/expenses/${sel.id}`, { method: 'PATCH', body });
            toast('Charge updated ✓', 'ok');
          } else {
            await api('/corp-card/expenses', { method: 'POST', body });
            toast('Charge added ✓', 'ok');
          }
          closeSheet();
          onSaved?.();
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

// Manage the category list (add / archive). Both ops_manager and sr_manager
// are allowed; the server is the authority.
function openCorpCardCategoriesSheet(onChange) {
  async function refresh(wrap) {
    const cats = await api('/corp-card/categories?include=archived');
    const active   = cats.filter(c => !c.archived_at);
    const archived = cats.filter(c => c.archived_at);

    $('#ccCatList', wrap).innerHTML = `
      ${active.length === 0 ? `<div class="empty" style="padding: 10px;">No active categories. Add one below.</div>` : ''}
      ${active.map(c => `
        <div class="attach-item">
          <div class="thumb" style="font-size: 18px;">💳</div>
          <div class="meta">
            <div class="name">${escapeHTML(c.name)}</div>
            <div class="sub">${c.use_count} charge${c.use_count === 1 ? '' : 's'} · added by ${escapeHTML(c.created_by_name || '—')}</div>
          </div>
          <div class="ctrl">
            <button class="btn btn-ghost btn-sm" data-cc-cat-archive="${c.id}" data-cc-cat-name="${escapeHTML(c.name)}">Archive</button>
          </div>
        </div>
      `).join('')}
      ${archived.length ? `
        <div class="section-title" style="margin-top: 14px; font-size: 11px;">Archived (${archived.length})</div>
        ${archived.map(c => `
          <div class="attach-item" style="opacity: 0.7;">
            <div class="thumb" style="font-size: 18px;">📦</div>
            <div class="meta">
              <div class="name" style="text-decoration: line-through;">${escapeHTML(c.name)}</div>
              <div class="sub">${c.use_count} historical charge${c.use_count === 1 ? '' : 's'}</div>
            </div>
            <div class="ctrl">
              <button class="btn btn-ghost btn-sm" data-cc-cat-unarchive="${c.id}">Restore</button>
            </div>
          </div>
        `).join('')}
      ` : ''}
    `;

    // Re-bind row actions every refresh.
    $$('[data-cc-cat-archive]', wrap).forEach(b => b.addEventListener('click', async () => {
      if (!confirm(`Archive category "${b.dataset.ccCatName}"? Historical charges keep this label; new charges can't pick it until it's restored.`)) return;
      try {
        await api(`/corp-card/categories/${b.dataset.ccCatArchive}`, { method: 'DELETE' });
        toast('Archived ✓', 'ok');
        await refresh(wrap);
        onChange?.();
      } catch (e) { toast(e.message, 'err'); }
    }));
    $$('[data-cc-cat-unarchive]', wrap).forEach(b => b.addEventListener('click', async () => {
      try {
        await api(`/corp-card/categories/${b.dataset.ccCatUnarchive}`, { method: 'PATCH', body: { unarchive: true } });
        toast('Restored ✓', 'ok');
        await refresh(wrap);
        onChange?.();
      } catch (e) { toast(e.message, 'err'); }
    }));
  }

  showSheet(`
    <h3>Corp-card categories</h3>
    <p class="help" style="margin-top:-4px;">Both Ops Mgr and Sr Mgr can add or archive items. Archiving is soft — historical charges keep the label.</p>

    <div id="ccCatList"></div>

    <span class="label" style="margin-top: 14px;">Add a new category</span>
    <div class="flex gap-12">
      <input class="field" id="ccNewCat" placeholder="e.g., Conferences" style="flex: 2;" />
      <button class="btn btn-primary" id="ccAddCat" style="flex: 1;">＋ Add</button>
    </div>

    <div class="actions" style="margin-top: 14px;">
      <button class="btn btn-ghost btn-block" data-act="sheet-close">Done</button>
    </div>
  `, {
    onMount: async (wrap) => {
      $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);
      $('#ccAddCat', wrap).addEventListener('click', async () => {
        const name = ($('#ccNewCat', wrap).value || '').trim();
        if (!name) return toast('Enter a name', 'err');
        try {
          await api('/corp-card/categories', { method: 'POST', body: { name } });
          $('#ccNewCat', wrap).value = '';
          toast('Added ✓', 'ok');
          await refresh(wrap);
          onChange?.();
        } catch (e) { toast(e.message, 'err'); }
      });
      await refresh(wrap);
    },
  });
}

// ---- LAUNCH ACTUALS (manager-only, v0.37) ----
// Weekly per-store hours submission to a Google Form. Pulls hours from
// time_entries → builds a prefilled Google Form URL → tracks submission
// status locally so the user knows what's outstanding.
async function renderLaunchActuals(root) {
  const today = new Date();
  const dow   = today.getDay();
  const offsetToLastSunday = dow === 0 ? 7 : dow;
  const lastSun = new Date(today); lastSun.setDate(today.getDate() - offsetToLastSunday);
  const defaultWeekEnd = lastSun.toISOString().slice(0, 10);

  const weekEnd = STATE._launchWeek || defaultWeekEnd;

  // Pull stores + this user's already-saved submissions for the chosen week.
  const [storesResp, mineResp] = await Promise.all([
    api(`/launch-actuals/stores?week_ending=${weekEnd}`),
    api(`/launch-actuals?week_ending=${weekEnd}`),
  ]);

  const submittedByStore = {};
  for (const r of mineResp || []) {
    submittedByStore[r.store_name] = r;
  }

  // Build the previous 6 weeks for a quick switcher (Sundays only).
  const weekOptions = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(defaultWeekEnd);
    d.setDate(d.getDate() - 7 * i);
    weekOptions.push(d.toISOString().slice(0, 10));
  }

  root.innerHTML = `
    <div class="dash-toolbar">
      <div class="chips" style="margin: 0; flex-wrap: wrap;">
        ${weekOptions.map(w => `<span class="chip ${w===weekEnd?'selected':''}" data-week="${w}">Wk ending ${fmtDate(w)}</span>`).join('')}
      </div>
      <div class="meta">Hours pulled from time entries · Submission goes to Launch Actuals form</div>
    </div>

    <div class="card" style="margin-bottom: 14px; background: #f4faf6; border-left: 4px solid var(--ic-green-deep);">
      <div style="font-size: 13px; line-height: 1.5;">
        <strong>How this works:</strong> Pick a store, review the auto-pulled hours, fill in your role / supporting type, and click <em>Open prefilled form</em>.
        Google opens with most fields already filled — review, click <em>Submit</em>, then come back and tap <em>✓ Mark submitted</em> here so this app knows it's done.
      </div>
    </div>

    <div class="card">
      <div class="section-title" style="margin-top: 0;">Stores with activity · week ending ${fmtDate(weekEnd)}</div>
      ${storesResp.stores.length === 0
        ? `<div class="empty" style="padding: 16px;">No store activity recorded for this week.</div>`
        : `
        <table class="store-table" style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <thead>
            <tr style="background: #f4f5f7; text-align: left;">
              <th style="padding: 10px 12px;">Store</th>
              <th style="padding: 10px 12px; text-align:right;">WOs</th>
              <th style="padding: 10px 12px; text-align:right;">Carts</th>
              <th style="padding: 10px 12px; text-align:right;">Hours</th>
              <th style="padding: 10px 12px;">Status</th>
              <th style="padding: 10px 12px; text-align:right;">Action</th>
            </tr>
          </thead>
          <tbody>
            ${storesResp.stores.map(s => {
              const sub = submittedByStore[s.store_name];
              const status = sub
                ? (sub.status === 'submitted'
                    ? `<span style="color: var(--ic-green-deep); font-weight:700;">✓ Submitted</span>`
                    : `<span style="color: var(--ic-orange); font-weight:700;">📝 Draft saved</span>`)
                : `<span style="color: var(--muted);">— not started —</span>`;
              const btnLabel = sub
                ? (sub.status === 'submitted' ? 'View / re-open' : 'Resume')
                : 'Prepare submission';
              return `
                <tr style="border-top: 1px solid var(--line);" data-store="${escapeHTML(s.store_name)}" data-id="${s.store_id || ''}" data-hours="${s.hours_spent}">
                  <td style="padding: 10px 12px;"><strong>${escapeHTML(s.store_name)}</strong>${s.store_id ? `<div style="color:var(--muted);font-size:11px;">${escapeHTML(s.store_id)}</div>` : ''}</td>
                  <td style="padding: 10px 12px; text-align:right;">${s.wo_count}</td>
                  <td style="padding: 10px 12px; text-align:right;">${s.cart_count}</td>
                  <td style="padding: 10px 12px; text-align:right;"><strong>${s.hours_spent.toFixed(2)}</strong></td>
                  <td style="padding: 10px 12px;">${status}</td>
                  <td style="padding: 10px 12px; text-align:right;">
                    <button class="btn btn-ghost btn-sm" data-prep>${btnLabel}</button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
        `
      }
    </div>

    ${mineResp.length ? `
      <div class="card" style="margin-top: 14px;">
        <div class="section-title" style="margin-top: 0;">My recent Launch Actuals submissions</div>
        <div style="font-size: 12px; color: var(--muted); margin-bottom: 8px;">Across all weeks. Click a row to re-open or copy values.</div>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <thead><tr style="background:#f4f5f7;text-align:left;">
            <th style="padding:8px 10px;">Week</th><th style="padding:8px 10px;">Store</th><th style="padding:8px 10px;">Hours</th><th style="padding:8px 10px;">Status</th>
          </tr></thead>
          <tbody>
            ${mineResp.slice(0,15).map(la => `
              <tr style="border-top: 1px solid var(--line);" data-la-id="${la.id}">
                <td style="padding:8px 10px;">${fmtDate(la.week_ending)}</td>
                <td style="padding:8px 10px;">${escapeHTML(la.store_name)}</td>
                <td style="padding:8px 10px;">${(la.hours_spent + la.additional_hours).toFixed(2)}</td>
                <td style="padding:8px 10px;">${la.status === 'submitted' ? '✓ Submitted' : '📝 Draft'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : ''}
  `;

  $$('[data-week]').forEach(b => b.addEventListener('click', () => {
    STATE._launchWeek = b.dataset.week; goto('launch');
  }));
  $$('[data-prep]').forEach(b => b.addEventListener('click', (ev) => {
    const tr = ev.currentTarget.closest('tr');
    const storeName = tr.dataset.store;
    const storeId   = tr.dataset.id;
    const existing  = submittedByStore[storeName] || null;
    openLaunchActualSheet(weekEnd, storeId, storeName, existing);
  }));
}

// Open the prepare-submission sheet for a given week + store. Auto-fetches
// the store-detail (work orders, hours, suggested supporting type) and
// renders an editable form. On Save, the server saves the draft and returns
// a Google Form prefill URL we open in a new tab.
async function openLaunchActualSheet(weekEnd, storeId, storeName, existing) {
  const qs = new URLSearchParams({ week_ending: weekEnd, store_name: storeName });
  const detail = await api(`/launch-actuals/store-detail?${qs.toString()}`);

  const computedHours = +detail.total_hours.toFixed(2);
  const seed = existing || {
    role:              'Ops Manager',
    supporting:        detail.supporting_suggestion,
    hours_spent:       computedHours,
    additional_hours:  0,
    hours_type:        'Regular',
    brief_description: detail.work_type_breakdown.length
      ? `Supporting ${detail.work_type_breakdown.map(b => `${b.work_type} (${b.hours.toFixed(1)} hrs)`).join(', ')}`
      : '',
    notes: '',
  };

  const wtChips = detail.work_type_breakdown.map(b => `
    <span class="chip" style="background: var(--ic-tan-light); color: var(--ic-green-deep);">
      ${b.work_type}: ${b.hours.toFixed(1)} hrs
    </span>
  `).join('');

  showSheet(`
    <h3>Launch Actuals · ${escapeHTML(storeName)}</h3>
    <p class="help" style="margin-bottom: 14px;">Week ending <strong>${fmtDate(weekEnd)}</strong> · ${detail.work_orders.length} work orders, ${detail.time_entries.length} time entries</p>

    ${wtChips ? `<div class="chips" style="margin-bottom: 12px;">${wtChips}</div>` : ''}

    <div class="grid-2" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
      <div>
        <span class="label">Role (Team)</span>
        <select class="field" id="laRole">
          <option ${seed.role==='Ops Manager'?'selected':''}>Ops Manager</option>
          <option ${seed.role==='Sr Manager'?'selected':''}>Sr Manager</option>
          <option ${seed.role==='Project Manager'?'selected':''}>Project Manager</option>
          <option ${seed.role==='Field Technician'?'selected':''}>Field Technician</option>
          <option ${seed.role==='Vendor / Contractor'?'selected':''}>Vendor / Contractor</option>
        </select>
      </div>
      <div>
        <span class="label">What are you supporting?</span>
        <select class="field" id="laSupporting">
          <option ${seed.supporting==='New Store Launch'?'selected':''}>New Store Launch</option>
          <option ${seed.supporting==='Retrofit'?'selected':''}>Retrofit</option>
          <option ${seed.supporting==='Service & Support'?'selected':''}>Service & Support</option>
          <option ${seed.supporting==='Repair / Break-fix'?'selected':''}>Repair / Break-fix</option>
          <option ${seed.supporting==='Pilot / R&D'?'selected':''}>Pilot / R&D</option>
        </select>
      </div>
      <div>
        <span class="label">Hours spent (auto-pulled)</span>
        <input class="field" id="laHours" type="number" step="0.25" min="0" value="${seed.hours_spent}">
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">From time entries: ${computedHours.toFixed(2)} hrs</div>
      </div>
      <div>
        <span class="label">Additional hours (off-system)</span>
        <input class="field" id="laAddHours" type="number" step="0.25" min="0" value="${seed.additional_hours}">
        <div style="font-size:11px;color:var(--muted);margin-top:4px;">Travel, planning, calls, etc.</div>
      </div>
      <div style="grid-column: 1 / -1;">
        <span class="label">What type of hours</span>
        <select class="field" id="laHoursType">
          <option ${seed.hours_type==='Regular'?'selected':''}>Regular</option>
          <option ${seed.hours_type==='Overtime'?'selected':''}>Overtime</option>
        </select>
      </div>
      <div style="grid-column: 1 / -1;">
        <span class="label">Brief description</span>
        <input class="field" id="laBrief" type="text" maxlength="200" value="${escapeHTML(seed.brief_description || '')}">
      </div>
      <div style="grid-column: 1 / -1;">
        <span class="label">Notes</span>
        <textarea class="field" id="laNotes" rows="3">${escapeHTML(seed.notes || '')}</textarea>
      </div>
    </div>

    <div class="actions" style="margin-top: 14px;">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      <button class="btn btn-primary" id="laSaveOpen">💾 Save &amp; Open form</button>
    </div>
  `, {
    onMount: (wrap) => {
      $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);
      $('#laSaveOpen', wrap).addEventListener('click', async () => {
        const body = {
          week_ending:        weekEnd,
          store_id:           storeId || null,
          store_name:         storeName,
          role:               $('#laRole', wrap).value,
          supporting:         $('#laSupporting', wrap).value,
          hours_spent:        Number($('#laHours', wrap).value || 0),
          additional_hours:   Number($('#laAddHours', wrap).value || 0),
          hours_type:         $('#laHoursType', wrap).value,
          brief_description:  $('#laBrief', wrap).value.trim(),
          notes:              $('#laNotes', wrap).value.trim(),
        };
        try {
          const saved = await api('/launch-actuals', { method: 'POST', body });
          closeSheet();
          openLaunchActualReviewSheet(saved);
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

// After saving, show a small review sheet with: a copy-each-value table
// (so the user can paste into Google manually if entry IDs aren't wired up
// yet), an "Open form" button, and a "Mark submitted" button.
function openLaunchActualReviewSheet(la) {
  const fm = la.field_map || { configured_count: 0, total_count: 12, fields: {} };
  const isFullyPrefilled = fm.configured_count === fm.total_count;
  const isPartiallyPrefilled = fm.configured_count > 0 && fm.configured_count < fm.total_count;

  const rows = [
    ['Email',                   la.email],
    ['Week Ending',             la.week_ending],
    ['Store ID',                la.store_id || ''],
    ['Retailer (Store Name)',   la.store_name],
    ['Which Team',              la.team],
    ['Role',                    la.role],
    ['What are you supporting', la.supporting],
    ['Hours Spent',             la.hours_spent],
    ['Additional Hours',        la.additional_hours],
    ['What type of hours',      la.hours_type],
    ['Brief Description',       la.brief_description || ''],
    ['Notes',                   la.notes || ''],
  ];

  showSheet(`
    <h3>Submit to Launch Actuals form</h3>
    <p class="help">Copy these values to the Google Form, or open the prefilled link below.</p>

    ${isFullyPrefilled ? `
      <div class="card" style="background: #ecfaf2; border-left: 4px solid var(--ic-green-deep); padding: 10px 14px; margin-bottom: 12px; font-size: 13px;">
        ✓ All ${fm.total_count} fields will be prefilled in Google Forms.
      </div>
    ` : isPartiallyPrefilled ? `
      <div class="card" style="background: #fff8e8; border-left: 4px solid var(--ic-orange); padding: 10px 14px; margin-bottom: 12px; font-size: 13px;">
        ⚠ ${fm.configured_count} of ${fm.total_count} fields are prefilled. Use the values below for the rest.
      </div>
    ` : `
      <div class="card" style="background: #fff8e8; border-left: 4px solid var(--ic-orange); padding: 10px 14px; margin-bottom: 12px; font-size: 13px;">
        ⚠ The Google Form's entry IDs aren't wired up yet — the form will open without prefilled values. Use the table below to fill in each field. Ask the admin to populate <code>LAUNCH_FORM_FIELD_*</code> env vars to enable prefill.
      </div>
    `}

    <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 14px;">
      <tbody>
        ${rows.map(([k, v]) => `
          <tr style="border-bottom: 1px solid var(--line);">
            <td style="padding: 8px 10px; color: var(--muted); width: 40%;">${escapeHTML(k)}</td>
            <td style="padding: 8px 10px;"><strong>${escapeHTML(String(v))}</strong></td>
            <td style="padding: 8px 10px; width: 50px; text-align: right;">
              <button class="btn btn-ghost btn-sm" data-copy="${escapeHTML(String(v))}">Copy</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <div class="actions" style="display: flex; flex-wrap: wrap; gap: 8px;">
      <button class="btn btn-ghost" data-act="sheet-close">Close</button>
      <a class="btn btn-primary" target="_blank" rel="noopener" href="${escapeHTML(la.prefill_url)}" id="laOpenForm">↗ Open prefilled form</a>
      <button class="btn ${la.status === 'submitted' ? 'btn-ghost' : 'btn-warn'}" id="laMarkSubmitted">
        ${la.status === 'submitted' ? '✓ Already marked submitted' : '✓ Mark as submitted'}
      </button>
    </div>
  `, {
    onMount: (wrap) => {
      $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);
      $$('[data-copy]', wrap).forEach(b => b.addEventListener('click', () => {
        navigator.clipboard?.writeText(b.dataset.copy);
        b.textContent = '✓';
        setTimeout(() => { b.textContent = 'Copy'; }, 1200);
      }));
      $('#laMarkSubmitted', wrap).addEventListener('click', async () => {
        if (la.status === 'submitted') return;
        try {
          await api(`/launch-actuals/${la.id}/mark-submitted`, { method: 'POST' });
          toast('Marked submitted ✓', 'ok');
          closeSheet();
          if (STATE.view === 'launch') goto('launch');
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

// ---- DASHBOARD (manager-only) ----
// v0.61 — Dashboard now has a sub-tab strip: 'Overview' (the existing
// aggregate view) + one tab per category. Category tabs read from
// /api/category-dashboard which returns spend totals + over-budget WOs for
// every category, including soft-archived corp-card categories.
// ============================================================
// 3RD PARTY (VENDOR) INVOICES — review tab (v0.65)
// ============================================================
// Read-only review surface for the manager-uploaded 3rd-party vendor invoice
// flow (invoice_type='vendor'). Mirrors the Corp Card tab's period-scope +
// headline + breakdown layout. The question it answers: "how much are we
// spending with 3rd-party vendors, and with whom" — so the primary breakdown
// is BY VENDOR. Consumes the existing /vendor-invoices(+ /summary) endpoints;
// no new server state.
const TP_STATE = {
  scope: 'mtd',          // 'mtd' | 'ytd' | 'all' | 'custom'
  from: '', to: '',      // only used when scope='custom'
  vendor: '',            // vendor-name contains filter ('' = all)
  status: '',            // status filter ('' = all)
};

function tpPeriodBounds() {
  const now = new Date();
  const y   = now.getUTCFullYear();
  const m   = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d   = String(now.getUTCDate()).padStart(2, '0');
  const today = `${y}-${m}-${d}`;
  if (TP_STATE.scope === 'mtd') return { from: `${y}-${m}-01`, to: today, label: `Month-to-date · ${y}-${m}` };
  if (TP_STATE.scope === 'ytd') return { from: `${y}-01-01`,   to: today, label: `Year-to-date · ${y}` };
  if (TP_STATE.scope === 'all') return { from: '1970-01-01',   to: today, label: 'All time' };
  return { from: TP_STATE.from || `${y}-${m}-01`, to: TP_STATE.to || today, label: `${TP_STATE.from || '—'} → ${TP_STATE.to || '—'}` };
}

// Humanize the invoice lifecycle statuses for the filter + list badges.
const TP_STATUS_LABELS = {
  draft: 'Draft', submitted: 'Submitted', approved_ops: 'Approved (Ops)',
  approved_sr: 'Approved (Sr)', approved: 'Approved', sent_ap: 'Sent to AP',
  rejected: 'Rejected', paid: 'Paid',
};
const tpStatusLabel = (s) => TP_STATUS_LABELS[s] || (s ? String(s).replace(/_/g, ' ') : '—');

async function renderThirdParty(root) {
  // Gate at the UI level too (the API gates server-side regardless).
  if (!['ops_manager','sr_manager','pm'].includes(STATE.user?.role)) {
    root.innerHTML = `<div class="empty"><div class="big">🔒</div>3rd Party invoices are manager-only.</div>`;
    return;
  }

  const { from, to, label } = tpPeriodBounds();
  const qList = `/vendor-invoices?from=${from}&to=${to}`
    + (TP_STATE.vendor ? `&vendor=${encodeURIComponent(TP_STATE.vendor)}` : '')
    + (TP_STATE.status ? `&status=${encodeURIComponent(TP_STATE.status)}` : '');
  const [summary, list] = await Promise.all([
    api(`/vendor-invoices/summary?from=${from}&to=${to}`),
    api(qList),
  ]);

  const listTotal = list.reduce((s, r) => s + (r.total || 0), 0);

  root.innerHTML = `
    <!-- Header band: period scope + primary action -->
    <div class="card" style="padding: 12px 14px; margin-bottom: 12px;">
      <div class="flex between" style="align-items: center; gap: 10px; flex-wrap: wrap;">
        <div>
          <div class="section-title" style="margin: 0;">3rd-party vendor invoices</div>
          <div class="meta" style="margin-top: 2px;">${escapeHTML(label)} · ${summary.totals.count_in_period} invoice${summary.totals.count_in_period === 1 ? '' : 's'}</div>
        </div>
        <div class="flex gap-12">
          <button class="btn btn-primary btn-sm" id="tpAddBtn">＋ 3rd-party vendor invoice</button>
        </div>
      </div>

      <div class="chips" style="margin-top: 12px;">
        ${['mtd','ytd','all','custom'].map(s => `
          <span class="chip ${TP_STATE.scope === s ? 'selected' : ''}" data-scope="${s}">
            ${s === 'mtd' ? 'Month' : s === 'ytd' ? 'YTD' : s === 'all' ? 'All' : 'Custom'}
          </span>
        `).join('')}
      </div>

      ${TP_STATE.scope === 'custom' ? `
        <div class="flex gap-12" style="margin-top: 8px;">
          <input class="field" type="date" id="tpFrom" value="${escapeHTML(TP_STATE.from || from)}" />
          <input class="field" type="date" id="tpTo"   value="${escapeHTML(TP_STATE.to   || to)}" />
        </div>
      ` : ''}
    </div>

    <!-- Headline total — what the user came here to see -->
    <div class="card" style="padding: 18px 20px; margin-bottom: 12px; background: linear-gradient(135deg, var(--ic-cream) 0%, #fff 80%); border-left: 4px solid var(--ic-green-deep);">
      <div style="font-size: 11px; color: var(--ic-green-deep); text-transform: uppercase; letter-spacing: 0.6px; font-weight: 700;">
        Total 3rd-party spend · ${escapeHTML(label)}
      </div>
      <div style="font-size: 36px; font-weight: 800; color: var(--ic-green-deep); margin-top: 4px;">
        ${fmt$(summary.totals.in_period)}
      </div>
      <div class="meta" style="margin-top: 4px;">
        MTD ${fmt$(summary.totals.mtd)} · YTD ${fmt$(summary.totals.ytd)} · All-time ${fmt$(summary.totals.all_time)} (${summary.totals.all_time_count} invoice${summary.totals.all_time_count === 1 ? '' : 's'}).
        Uploaded by managers and routed to Sr-Mgr sign-off — tracked separately from tech-labor invoices.
      </div>
    </div>

    <!-- Filters row (vendor + status) -->
    <div class="card" style="padding: 10px 14px; margin-bottom: 12px;">
      <div class="flex gap-12" style="flex-wrap: wrap;">
        <div style="flex: 2; min-width: 180px;">
          <span class="label">Vendor</span>
          <input class="field" id="tpFilterVendor" type="text" placeholder="Filter by vendor name…" value="${escapeHTML(TP_STATE.vendor)}" />
        </div>
        <div style="flex: 1; min-width: 150px;">
          <span class="label">Status</span>
          <select class="field" id="tpFilterStatus">
            <option value="">All statuses</option>
            ${summary.by_status.map(s => `<option value="${escapeHTML(s.status)}" ${TP_STATE.status === s.status ? 'selected' : ''}>${escapeHTML(tpStatusLabel(s.status))} (${s.count})</option>`).join('')}
          </select>
        </div>
      </div>
    </div>

    <!-- Breakdown cards: by vendor (primary) + by status -->
    <div class="dash-grid-2" style="margin-bottom: 12px;">
      <div class="card">
        <div class="section-title" style="margin-top: 0;">By vendor</div>
        ${summary.by_vendor.length ? `
          <table class="cc-table">
            ${summary.by_vendor.map(v => {
              const pct = summary.totals.in_period > 0 ? (v.total / summary.totals.in_period) * 100 : 0;
              return `
                <tr>
                  <td><strong>${escapeHTML(v.vendor_name)}</strong></td>
                  <td class="r"><span class="meta">${v.count}</span></td>
                  <td class="r"><strong>${fmt$(v.total)}</strong></td>
                  <td style="width: 80px;"><div class="cc-bar"><div class="cc-bar-fill" style="width: ${pct.toFixed(1)}%"></div></div></td>
                </tr>
              `;
            }).join('')}
          </table>
        ` : `<div class="empty" style="padding: 12px;">No 3rd-party spend in this period.</div>`}
      </div>
      <div class="card">
        <div class="section-title" style="margin-top: 0;">By status</div>
        ${summary.by_status.length ? `
          <table class="cc-table">
            ${summary.by_status.map(s => `
              <tr>
                <td><strong>${escapeHTML(tpStatusLabel(s.status))}</strong></td>
                <td class="r"><span class="meta">${s.count}</span></td>
                <td class="r"><strong>${fmt$(s.total)}</strong></td>
              </tr>
            `).join('')}
          </table>
        ` : `<div class="empty" style="padding: 12px;">No 3rd-party spend in this period.</div>`}
      </div>
    </div>

    <!-- Itemized list -->
    <div class="card">
      <div class="section-title" style="margin-top: 0;">Invoices (${list.length})</div>
      ${list.length === 0 ? `
        <div class="empty" style="padding: 14px;">No 3rd-party invoices match these filters.</div>
      ` : `
        <table class="cc-exp-table">
          <thead>
            <tr><th>Date</th><th>Vendor</th><th>Invoice #</th><th>Category</th><th>Status</th><th>Filed by</th><th class="r">Total</th></tr>
          </thead>
          <tbody>
            ${list.map(r => `
              <tr class="tap" data-tp-inv="${r.id}" style="cursor: pointer;">
                <td>${fmtShortDate(r.vendor_invoice_date || (r.created_at || '').slice(0, 10))}</td>
                <td><strong>${escapeHTML(r.vendor_name || '— unnamed —')}</strong></td>
                <td>${r.vendor_invoice_number ? escapeHTML(r.vendor_invoice_number) : '<span class="meta">—</span>'}</td>
                <td>${r.vendor_category ? `<span class="cc-cat-pill">${escapeHTML(capitalize(r.vendor_category))}</span>` : '<span class="meta">—</span>'}</td>
                <td><span class="meta">${escapeHTML(tpStatusLabel(r.status))}</span></td>
                <td>${escapeHTML(r.created_by_name || '—')}</td>
                <td class="r amt-pos"><strong>${fmt$(r.total)}</strong></td>
              </tr>
            `).join('')}
            <tr class="cc-total-row">
              <td colspan="6" class="r"><strong>Subtotal</strong></td>
              <td class="r amt-total"><strong>${fmt$(listTotal)}</strong></td>
            </tr>
          </tbody>
        </table>
      `}
    </div>
  `;

  // ---- bindings ---------------------------------------------------------
  $$('#tabbar .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'thirdparty'));

  $$('.chip[data-scope]').forEach(c => c.addEventListener('click', () => {
    TP_STATE.scope = c.dataset.scope;
    if (TP_STATE.scope !== 'custom') { TP_STATE.from = ''; TP_STATE.to = ''; }
    renderThirdParty(root);
  }));
  $('#tpFrom')?.addEventListener('change', e => { TP_STATE.from = e.target.value; renderThirdParty(root); });
  $('#tpTo')  ?.addEventListener('change', e => { TP_STATE.to   = e.target.value; renderThirdParty(root); });
  $('#tpFilterVendor')?.addEventListener('change', e => { TP_STATE.vendor = e.target.value.trim(); renderThirdParty(root); });
  $('#tpFilterStatus')?.addEventListener('change', e => { TP_STATE.status = e.target.value; renderThirdParty(root); });

  // Reuse the existing manager upload sheet; on submit it navigates to the
  // invoice preview (invDetail), same as the Queue tab's entry point.
  $('#tpAddBtn')?.addEventListener('click', () => openVendorInvoiceSheet());

  // Row → invoice preview/detail (where the vendor invoice can be edited).
  $$('[data-tp-inv]').forEach(tr => tr.addEventListener('click', () => goto('invDetail', Number(tr.dataset.tpInv))));
}

async function renderDashboard(root) {
  const isManager = ['ops_manager','sr_manager','pm'].includes(STATE.user?.role);
  // v0.64 — Unplanned work is now a sub-section of the Dashboard (previously its
  // own left-nav tab). Managers get an Overview | Unplanned toggle up top.
  const section = (isManager && STATE._dashSection === 'unplanned') ? 'unplanned' : 'overview';
  const sectionToggle = isManager ? `
    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <button data-dashsection="overview" class="btn btn-sm ${section === 'overview' ? 'btn-primary' : 'btn-ghost'}">Overview</button>
      <button data-dashsection="unplanned" class="btn btn-sm ${section === 'unplanned' ? 'btn-primary' : 'btn-ghost'}">⚠ Unplanned work</button>
    </div>` : '';

  if (section === 'unplanned') {
    root.innerHTML = `${sectionToggle}<div id="dashBody"></div>`;
    bindDashSectionToggle();
    return renderUnplanned($('#dashBody'));
  }

  const tab = STATE._dashCatTab || 'overview';
  // Fetch the category list/data once. We always need it for the strip,
  // even on the Overview tab. Fail silently for non-managers (403).
  const catDash = isManager ? await api('/category-dashboard').catch(() => []) : [];

  root.innerHTML = `
    ${sectionToggle}
    ${renderDashCatStrip(catDash, tab)}
    <div id="dashBody"></div>
  `;
  bindDashSectionToggle();
  bindDashCatStrip();

  const body = $('#dashBody');
  if (tab === 'overview') {
    return renderDashboardOverview(body);
  }
  // Category tab: cat key = "<source>:<key>", e.g. "corp_card:3" or "tech_expense:Hotel".
  const [source, ...rest] = tab.split(':');
  const key = rest.join(':');
  const data = catDash.find(c => c.source === source && c.key === key);
  return renderCategoryDashTab(body, data, source, key);
}

// v0.62 — dropdown replacement for the v0.61 chip strip. Categories are
// grouped (corp-card → tech-expense → archived corp-card) inside <optgroup>s
// so the menu stays scannable as the category list grows.
function renderDashCatStrip(catDash, activeTab) {
  const groups = {
    corp_card_active:   catDash.filter(c => c.source === 'corp_card'   && !c.archived),
    tech_expense:       catDash.filter(c => c.source === 'tech_expense'),
    corp_card_archived: catDash.filter(c => c.source === 'corp_card'   &&  c.archived),
  };
  const opt = (c) => {
    const id    = `${c.source}:${c.key}`;
    const over  = c.over_budget_wos?.length ? ` ⚠ ${c.over_budget_wos.length}` : '';
    const sel   = activeTab === id ? 'selected' : '';
    return `<option value="${escapeHTML(id)}" ${sel}>${escapeHTML(c.label)}${over}</option>`;
  };
  return `
    <div class="dash-cat-filter" style="display: flex; align-items: center; gap: 10px; margin: 0 0 12px;">
      <label class="label" for="dashCatSelect" style="margin: 0; font-size: 12px;">View by category</label>
      <select id="dashCatSelect" class="field" style="flex: 1; max-width: 360px;">
        <option value="overview" ${activeTab === 'overview' ? 'selected' : ''}>Overview (all categories)</option>
        ${groups.corp_card_active.length ? `
          <optgroup label="Corp-card categories">
            ${groups.corp_card_active.map(opt).join('')}
          </optgroup>` : ''}
        ${groups.tech_expense.length ? `
          <optgroup label="Tech-expense subcategories">
            ${groups.tech_expense.map(opt).join('')}
          </optgroup>` : ''}
        ${groups.corp_card_archived.length ? `
          <optgroup label="Archived corp-card">
            ${groups.corp_card_archived.map(opt).join('')}
          </optgroup>` : ''}
      </select>
    </div>
  `;
}

function bindDashCatStrip() {
  const sel = $('#dashCatSelect');
  if (!sel) return;
  sel.addEventListener('change', () => {
    STATE._dashCatTab = sel.value;
    goto('dashboard');
  });
}

// v0.64 — Overview | Unplanned sub-section toggle at the top of the Dashboard.
function bindDashSectionToggle() {
  $$('[data-dashsection]').forEach(b => b.addEventListener('click', () => {
    STATE._dashSection = b.dataset.dashsection;
    goto('dashboard');
  }));
}

// Per-category dashboard panel — totals, current rules, and any
// over-budget WOs for this category.
function renderCategoryDashTab(root, data, source, key) {
  if (!data) {
    root.innerHTML = `<div class="empty">Category not found.</div>`;
    return;
  }
  const t = data.totals || {};
  const rules = data.rules || {};
  const fmt = (n) => `$${(n || 0).toFixed(2)}`;
  const ruleRow = (label, amount) => `
    <div style="display: flex; justify-content: space-between; padding: 6px 0; border-top: 1px solid var(--line); font-size: 13px;">
      <span class="meta">${escapeHTML(label)}</span>
      <strong>${amount != null ? fmt(amount) : '—'}</strong>
    </div>
  `;
  root.innerHTML = `
    <div class="meta" style="margin-bottom: 12px;">
      ${escapeHTML(data.label)} · ${source === 'corp_card' ? 'Corp-card category' : 'Tech-expense subcategory'}${data.archived ? ' · archived' : ''}
    </div>

    <div class="dash-kpi-grid" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px;">
      <div class="card"><div class="meta">MTD</div><div style="font-size: 22px; font-weight: 600;">${fmt(t.mtd)}</div></div>
      <div class="card"><div class="meta">YTD</div><div style="font-size: 22px; font-weight: 600;">${fmt(t.ytd)}</div></div>
      <div class="card"><div class="meta">All time</div><div style="font-size: 22px; font-weight: 600;">${fmt(t.all_time)}</div></div>
      <div class="card"><div class="meta">Charges</div><div style="font-size: 22px; font-weight: 600;">${t.count || 0}</div></div>
    </div>

    <div class="section-title">Rules</div>
    <div class="card">
      ${ruleRow('Per-WO $ cap',     rules.per_wo_cap)}
      ${ruleRow('Global $ cap',     rules.global_cap)}
      ${ruleRow('Receipt required above', rules.receipt_required_above)}
      <div style="font-size: 11px; color: var(--muted); margin-top: 10px;">Edit values on the Policy tab → Per-category rules.</div>
    </div>

    <div class="section-title">Per-WO budgets (${(data.budgets || []).length})</div>
    <div class="card">
      ${(data.budgets || []).length === 0 ? `<div class="empty" style="padding: 8px; font-size: 12px;">No per-WO budgets set for this category yet.</div>` : `
        ${data.budgets.map(b => {
          const over = b.spent > b.amount_cap;
          return `
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-top: 1px solid var(--line); ${over ? 'color: var(--ic-orange-deep);' : ''}">
              <div>
                <div>${escapeHTML(b.external_id || `WO #${b.work_order_id}`)}</div>
                <div class="meta" style="font-size: 11px;">${escapeHTML(b.store_name || '—')}</div>
              </div>
              <div style="text-align: right;">
                <div><strong>${fmt(b.spent)}</strong> of ${fmt(b.amount_cap)}</div>
                ${over ? `<div style="font-size: 11px;">over by ${fmt(b.spent - b.amount_cap)}</div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      `}
    </div>

    ${data.over_budget_wos && data.over_budget_wos.length ? `
      <div class="section-title" style="color: var(--ic-orange-deep);">⚠ Over-budget WOs (${data.over_budget_wos.length})</div>
      <div class="card">
        ${data.over_budget_wos.map(w => `
          <div style="display: flex; justify-content: space-between; padding: 6px 0; border-top: 1px solid var(--line);">
            <span>${escapeHTML(w.external_id || `WO #${w.work_order_id}`)} · ${escapeHTML(w.store_name || '—')}</span>
            <strong style="color: var(--ic-orange-deep);">over by ${fmt(w.overage)}</strong>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;
}

async function renderDashboardOverview(root) {
  const period      = STATE._dashPeriod || 'last_90';
  const techFilter  = STATE._dashTech   || '';
  const storeFilter = STATE._dashStore  || '';
  const wtFilter    = STATE._dashWt     || '';
  const qs = new URLSearchParams({ period });
  if (techFilter)  qs.set('tech',      techFilter);
  if (storeFilter) qs.set('store',     storeFilter);
  if (wtFilter)    qs.set('work_type', wtFilter);
  // v0.60 — fetch the dashboard data alongside the corp-card MTD summary so
  // we can render the new "Corp card" widget without an extra round-trip.
  // Corp-card endpoint is manager-only — if it 403s, we silently degrade.
  const [r, ccSummary] = await Promise.all([
    api(`/dashboard?${qs.toString()}`),
    ['ops_manager','sr_manager','pm'].includes(STATE.user?.role)
      ? api('/corp-card/summary').catch(() => null)
      : Promise.resolve(null),
  ]);
  const PERIODS = [
    ['mtd',     'MTD'],
    ['last_30', 'Last 30d'],
    ['last_90', 'Last 90d'],
    ['qtd',     'QTD'],
    ['ytd',     'YTD'],
    ['all',     'All time'],
  ];

  if (r.meta?.empty) {
    root.innerHTML = `
      <div class="empty"><div class="big">📊</div>${escapeHTML(r.meta.message)}</div>
    `;
    return;
  }

  // Pre-compute helpers
  const maxOf = (arr, k) => arr.reduce((m, x) => Math.max(m, x[k] || 0), 0);
  const fmtPct = (x) => (x * 100).toFixed(0) + '%';

  // v0.45 — exportQs no longer carries the bearer token; the click handler
  // mints a one-time download token via downloadWithToken().
  const exportQs = new URLSearchParams({ period });
  if (techFilter)  exportQs.set('tech',      techFilter);
  if (storeFilter) exportQs.set('store',     storeFilter);
  if (wtFilter)    exportQs.set('work_type', wtFilter);

  // Resolve the current tech filter value (id) → display name for the input
  const techDisplay = techFilter
    ? (r.meta.available_techs.find(t => String(t.id) === String(techFilter))?.name || '')
    : '';
  const anyFilter = !!(techFilter || storeFilter || wtFilter);

  root.innerHTML = `
    <div class="dash-toolbar">
      <div class="chips" style="margin: 0; flex-wrap: wrap;">
        ${PERIODS.map(([k, label]) => `<span class="chip ${period===k?'selected':''}" data-period="${k}">${label}</span>`).join('')}
      </div>
      <div class="dash-filters">
        <div class="combo-wrap">
          <input class="field dash-select" id="dashTech" list="dashTechList" placeholder="🔎 Tech…" value="${escapeHTML(techDisplay)}" autocomplete="off" />
          <datalist id="dashTechList">
            ${r.meta.available_techs.map(t => `<option data-id="${t.id}" value="${escapeHTML(t.name)}"></option>`).join('')}
          </datalist>
          ${techFilter ? `<button class="combo-clear" data-clear="tech" title="Clear">×</button>` : ''}
        </div>
        <div class="combo-wrap">
          <input class="field dash-select" id="dashStore" list="dashStoreList" placeholder="🔎 Store…" value="${escapeHTML(storeFilter)}" autocomplete="off" />
          <datalist id="dashStoreList">
            ${r.meta.available_stores.map(s => `<option value="${escapeHTML(s)}"></option>`).join('')}
          </datalist>
          ${storeFilter ? `<button class="combo-clear" data-clear="store" title="Clear">×</button>` : ''}
        </div>
        <div class="combo-wrap">
          <input class="field dash-select" id="dashWt" list="dashWtList" placeholder="🔎 Work type…" value="${escapeHTML(wtFilter)}" autocomplete="off" />
          <datalist id="dashWtList">
            ${(r.meta.available_work_types || []).map(w => `<option value="${escapeHTML(w)}"></option>`).join('')}
          </datalist>
          ${wtFilter ? `<button class="combo-clear" data-clear="wt" title="Clear">×</button>` : ''}
        </div>
        <button class="btn btn-ghost btn-sm dash-export-btn" data-export-qs="${escapeHTML(exportQs.toString())}">📥 Excel</button>
        <button class="btn btn-ghost btn-sm" id="dashPushDriveBtn">📤 Push to Drive</button>
      </div>
    </div>

    <div class="meta" style="margin-bottom: 14px;">
      ${escapeHTML(r.meta.scope === 'team' ? `Team scope · ${r.meta.scope_size} techs` : 'All techs')} · ${escapeHTML(r.meta.period_label)}
      ${anyFilter ? `
        <span style="color: var(--ic-orange); margin-left: 8px;">⚙ Filtered:</span>
        ${techFilter ? `<span class="filter-pill" data-clear="tech">tech=${escapeHTML(techDisplay)} ×</span>` : ''}
        ${storeFilter ? `<span class="filter-pill" data-clear="store">store=${escapeHTML(storeFilter)} ×</span>` : ''}
        ${wtFilter ? `<span class="filter-pill" data-clear="wt">type=${escapeHTML(wtFilter)} ×</span>` : ''}
        <button class="btn btn-ghost btn-sm" id="dashClearAll" style="margin-left: 6px;">Clear all</button>
      ` : ''}
    </div>

    ${renderKpiTiles(r.summary)}

    ${ccSummary ? (() => {
      // v0.60 — Corporate-card spend widget. Shows MTD/YTD/all-time totals
      // and the top two categories, with a link to the full Corp Card tab.
      // Lives separately from tech invoice totals — never mixed in.
      const top = (ccSummary.by_category || []).slice(0, 3);
      const mtdLabel = ccSummary.period?.label || '';
      return `
      <div class="card cc-widget" style="margin-top: 14px; padding: 14px 16px;">
        <div class="flex between" style="align-items: flex-start; gap: 12px;">
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 11px; color: var(--ic-green-deep); text-transform: uppercase; letter-spacing: 0.6px; font-weight: 700;">
              💳 Corporate-card spend · MTD
            </div>
            <div style="font-size: 28px; font-weight: 800; color: var(--ic-green-deep); margin-top: 2px;">
              ${fmt$(ccSummary.totals.mtd)}
            </div>
            <div class="meta" style="margin-top: 2px;">
              YTD ${fmt$(ccSummary.totals.ytd)} · All-time ${fmt$(ccSummary.totals.all_time)} (${ccSummary.totals.all_time_count} charges)
              · separate from tech invoices.
            </div>
            ${top.length ? `
              <div style="margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px;">
                ${top.map(c => `
                  <span class="cc-cat-pill">
                    ${escapeHTML(c.category_name)} · ${fmt$(c.total)}
                  </span>
                `).join('')}
              </div>
            ` : ''}
          </div>
          <button class="btn btn-ghost btn-sm" id="dashGoToCorpCard" style="flex-shrink: 0;">Open Corp Card →</button>
        </div>
      </div>
    `; })() : ''}

    ${(() => {
      // v0.65 — 3rd-party vendor spend widget. Surfaces the manager-uploaded
      // vendor invoice flow (invoice_type='vendor') on the Dashboard, broken
      // out BY VENDOR, with a jump to the full 3rd Party tab. Uses data already
      // in the dashboard payload (summary.vendor_* + by_vendor, period-scoped &
      // billable-only) — no extra round-trip. Hidden when there's no activity.
      const s = r.summary || {};
      const topV = (r.by_vendor || []).slice(0, 3);
      const hasActivity = (s.vendor_spend || 0) > 0 || (s.vendor_pending_count || 0) > 0 || topV.length > 0;
      if (!hasActivity) return '';
      return `
      <div class="card" style="margin-top: 14px; padding: 14px 16px; border-left: 4px solid var(--ic-orange);">
        <div class="flex between" style="align-items: flex-start; gap: 12px;">
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 11px; color: var(--ic-green-deep); text-transform: uppercase; letter-spacing: 0.6px; font-weight: 700;">
              🧾 3rd-party vendor spend · ${escapeHTML(r.meta.period_label)}
            </div>
            <div style="font-size: 28px; font-weight: 800; color: var(--ic-green-deep); margin-top: 2px;">
              ${fmt$(s.vendor_spend || 0)}
            </div>
            <div class="meta" style="margin-top: 2px;">
              ${s.vendor_invoice_count || 0} invoice${(s.vendor_invoice_count || 0) === 1 ? '' : 's'} · ${s.vendor_unique || 0} vendor${(s.vendor_unique || 0) === 1 ? '' : 's'}${(s.vendor_pending_count || 0) > 0 ? ` · <span style="color: var(--ic-orange); font-weight: 600;">${s.vendor_pending_count} pending (${fmt$(s.vendor_pending_value || 0)})</span>` : ''} · separate from tech invoices.
            </div>
            ${topV.length ? `
              <div style="margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px;">
                ${topV.map(v => `
                  <span class="cc-cat-pill">
                    ${escapeHTML(v.vendor_name || '— unnamed —')} · ${fmt$(v.total)}
                  </span>
                `).join('')}
              </div>
            ` : ''}
          </div>
          <button class="btn btn-ghost btn-sm" id="dashGoToThirdParty" style="flex-shrink: 0;">Open 3rd Party →</button>
        </div>
      </div>
    `; })()}

    ${r.cost_tracker_row_count ? (() => {
      // v0.45 — BUG-011 fix: render the callout whenever there are work
      // orders, even if actuals total $0 (so Ops Mgrs see the "Open Cost
      // Tracker" CTA on slow weeks). Numbers reflect the v0.42 actuals-
      // only data shape — no forecast / variance fields.
      const t = r.cost_tracker_monthly?.totals || { actual: 0, wo_count: 0 };
      const isEmpty = !t.actual;
      return `
      <div class="card" style="margin-top: 14px; background: ${isEmpty ? '#fafbfc' : '#f4faf6'}; border-left: 4px solid ${isEmpty ? 'var(--line)' : 'var(--ic-green-deep)'};">
        <div class="flex between" style="align-items: center;">
          <div>
            <div style="font-size: 13px; font-weight: 700;">Cost Tracker · ${r.cost_tracker_row_count} work order${r.cost_tracker_row_count === 1 ? '' : 's'}</div>
            <div style="font-size: 12px; color: var(--muted); margin-top: 2px;">
              ${isEmpty
                ? `No actuals logged in this period yet — open the tracker to fill them in.`
                : `Actual ${fmt$(t.actual)} across ${t.wo_count} work order${t.wo_count === 1 ? '' : 's'}`}
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" id="dashGoToTracker">Open Cost Tracker →</button>
        </div>
      </div>
    `; })() : ''}

    <div class="dash-grid-2">
      ${renderDonutCard('Work-type mix', r.by_work_type, 'work_type', 'total',
        (t) => `${t.wo_count} WOs · ${fmt$(t.dollars_per_cart)}/cart`)}
      ${renderStackedTechCard('Tech × Work-type comparison', r.by_tech_work_type)}
    </div>

    ${renderMultiLineCard('Weekly spend by technician', r.trend_by_tech, r.trend, null)}

    <div class="dash-grid-2">
      ${renderColumnCard('Spend by cart-count bucket', r.by_cart_bucket)}
      ${renderVerticalBarCard('Top stores by spend', r.by_store, 'store_name', 'total',
        (s) => `${s.wo_count} ${s.wo_count===1?'visit':'visits'} · avg ${fmt$(s.total / Math.max(1, s.wo_count))}/visit`,
        { drillKey: 'store', drillValue: (s) => s.store_name, maxBars: 10 })}
    </div>

    <!-- Store-focused metrics (v0.33) -->
    <div class="section-title">Store metrics</div>
    <div class="dash-grid-2">
      ${renderBarCard('Most active stores', [...r.by_store].sort((a,b) => b.wo_count - a.wo_count).slice(0, 10),
        'store_name', 'wo_count', Math.max(1, ...r.by_store.map(s => s.wo_count)),
        (s) => `${fmt$(s.total)} total · ${fmt$(s.total / Math.max(1, s.wo_count))} per visit`,
        { drillKey: 'store', drillValue: (s) => s.store_name, valueFmt: (n) => `${n} visit${n===1?'':'s'}` })}
      ${renderBarCard('Highest $ per visit', [...r.by_store].map(s => ({...s, per_visit: s.total / Math.max(1, s.wo_count)}))
          .sort((a,b) => b.per_visit - a.per_visit).slice(0, 10),
        'store_name', 'per_visit', Math.max(1, ...r.by_store.map(s => s.total / Math.max(1, s.wo_count))),
        (s) => `${s.wo_count} ${s.wo_count===1?'visit':'visits'} · ${fmt$(s.total)} total`,
        { drillKey: 'store', drillValue: (s) => s.store_name, valueFmt: (n) => fmt$(n) })}
    </div>

    ${(r.trend_by_store || []).length ? renderMultiLineStoresCard('Spend trend per store (top 5)', r.trend_by_store) : ''}

    ${r.aging.length ? `
      <div class="card" style="margin-top: 14px; border-left: 4px solid var(--ic-orange);">
        <div class="section-title" style="margin-top: 0;">⏰ Aging in queue (${r.aging.length})</div>
        <p class="help" style="margin: 0 0 10px;">Submitted &gt; 3 days ago. Take action to keep the AP cycle on schedule.</p>
        ${r.aging.map(a => `
          <div class="dash-list-row tap" data-inv="${a.id}">
            <div style="flex: 1; min-width: 0;">
              <strong>${escapeHTML(a.tech_name)}</strong>
              <div class="meta">${escapeHTML(a.invoice_number)} · ${a.days_in_queue} days waiting</div>
            </div>
            <strong>${fmt$(a.total)}</strong>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${r.top_invoices.length ? `
      <div class="card" style="margin-top: 14px;">
        <div class="section-title" style="margin-top: 0;">Top invoices in period</div>
        ${r.top_invoices.map(inv => `
          <div class="dash-list-row tap" data-inv="${inv.id}">
            <div style="flex: 1; min-width: 0;">
              <strong>${escapeHTML(inv.tech_name)}</strong>
              <div class="meta">${escapeHTML(inv.invoice_number)} · ${escapeHTML(labelForStatus(inv.status))} · ${fmtDate(inv.period_start)} → ${fmtDate(inv.period_end)}</div>
            </div>
            <strong>${fmt$(inv.total)}</strong>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;

  $$('[data-period]').forEach(b => b.addEventListener('click', () => { STATE._dashPeriod = b.dataset.period; goto('dashboard'); }));

  // Tech combobox: typed value resolves to id via the datalist; if blank, clears the filter
  $('#dashTech')?.addEventListener('change',  e => {
    const typed = e.target.value.trim();
    if (!typed) { STATE._dashTech = ''; goto('dashboard'); return; }
    const match = r.meta.available_techs.find(t => t.name.toLowerCase() === typed.toLowerCase());
    if (match) { STATE._dashTech = String(match.id); goto('dashboard'); }
    else toast(`No tech named "${typed}"`, 'err');
  });
  $('#dashStore')?.addEventListener('change', e => { STATE._dashStore = e.target.value.trim(); goto('dashboard'); });
  $('#dashWt')?.addEventListener('change',    e => {
    const v = e.target.value.trim().toLowerCase();
    const allowed = new Set((r.meta.available_work_types || []).map(s => String(s).toLowerCase()));
    if (v && !allowed.has(v)) {
      return toast(`Type one of: ${[...allowed].join(', ')}`, 'err');
    }
    STATE._dashWt = v; goto('dashboard');
  });

  // Filter pills + clear-all
  $$('[data-clear]').forEach(el => el.addEventListener('click', () => {
    const k = el.dataset.clear;
    if (k === 'tech')  STATE._dashTech  = '';
    if (k === 'store') STATE._dashStore = '';
    if (k === 'wt')    STATE._dashWt    = '';
    goto('dashboard');
  }));
  $('#dashClearAll')?.addEventListener('click', () => {
    STATE._dashTech = ''; STATE._dashStore = ''; STATE._dashWt = '';
    goto('dashboard');
  });

  // v0.37 — Push to Drive. Asks the server whether Google Sheets is configured;
  // if yes, push the current slice; if no, show a sheet explaining how to set it up.
  $('#dashGoToTracker')?.addEventListener('click', () => goto('tracker'));
  // v0.60 — corp-card widget on the dashboard.
  $('#dashGoToCorpCard')?.addEventListener('click', () => goto('corpcard'));
  $('#dashGoToThirdParty')?.addEventListener('click', () => goto('thirdparty'));
  // v0.45 — Excel button uses secure download-token flow.
  $$('.dash-export-btn').forEach(b => b.addEventListener('click', () => {
    downloadWithToken('/api/dashboard/export', b.dataset.exportQs || '');
  }));

  $('#dashPushDriveBtn')?.addEventListener('click', async () => {
    const btn = $('#dashPushDriveBtn');
    btn.disabled = true; btn.textContent = '⏳ Checking…';
    try {
      const status = await api('/dashboard/drive-status');
      if (!status.configured) {
        btn.disabled = false; btn.textContent = '📤 Push to Drive';
        showSheet(`
          <h3>Push to Google Drive — not configured yet</h3>
          <p class="help">To enable automatic push of the dashboard to a Google Sheet, your admin needs to do a one-time setup:</p>
          <ol style="font-size: 13px; line-height: 1.6;">
            <li>Create a Google service account (Cloud Console → IAM &amp; Admin → Service Accounts).</li>
            <li>Enable the Google Sheets API for that project.</li>
            <li>Download the service-account JSON key.</li>
            <li>Save it as <code>data/google-service-account.json</code> in the app folder.</li>
            <li>Set <code>GOOGLE_SHEET_ID</code> in <code>.env</code> to the target sheet's ID.</li>
            <li>Share the sheet (Editor) with the service account's <code>client_email</code>.</li>
            <li>Restart the server.</li>
          </ol>
          <p class="help">Detailed walkthrough is in <code>DEPLOY-GOOGLE.md</code>.</p>
          <div class="actions">
            <button class="btn btn-ghost" data-act="sheet-close">Got it</button>
          </div>
        `, { onMount: (wrap) => $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet) });
        return;
      }

      btn.textContent = '⏳ Pushing…';
      const qs = new URLSearchParams({ period });
      if (techFilter)  qs.set('tech',      techFilter);
      if (storeFilter) qs.set('store',     storeFilter);
      if (wtFilter)    qs.set('work_type', wtFilter);
      const out = await api(`/dashboard/push-to-drive?${qs.toString()}`, { method: 'POST' });
      btn.disabled = false; btn.textContent = '📤 Push to Drive';
      toast(`Pushed ${out.tabs.length} tabs to Drive ✓`, 'ok');
      window.open(out.sheet_url, '_blank', 'noopener');
    } catch (e) {
      btn.disabled = false; btn.textContent = '📤 Push to Drive';
      toast(e.message || 'Push failed', 'err');
    }
  });

  // Drill-down: clicking a chart bar applies its dimension as a filter.
  function drill(el) {
    const k = el.dataset.drill;
    const v = el.dataset.value;
    if (k === 'tech')  STATE._dashTech  = v;
    if (k === 'store') STATE._dashStore = v;
    if (k === 'wt')    STATE._dashWt    = v;
    goto('dashboard');
  }
  // Drill-down hooks — applies to bars, stacked rows, donut slices, donut legend, and store-trend pills
  $$('.bar-row[data-drill], .stack-row[data-drill], .donut-svg [data-drill], .donut-legend-row[data-drill], .legend-pill[data-drill], .vbar-row[data-drill]').forEach(el => {
    el.addEventListener('click', () => drill(el));
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drill(el); } });
  });

  // Forecast formula explainer
  $('#forecastHelpBtn')?.addEventListener('click', openForecastExplainer);

  $$('.dash-list-row[data-inv]').forEach(r => r.addEventListener('click', () => goto('invDetail', Number(r.dataset.inv))));
}

function renderKpiTiles(s) {
  // v0.33 — actuals-only. Forecast tiles moved to the Forecast tab.
  return `
    <div class="kpi-grid">
      ${kpiTile('Spend in period',       fmt$(s.total_spend),    `${s.invoice_count} invoice${s.invoice_count===1?'':'s'}`)}
      ${kpiTile('Avg invoice',           fmt$(s.avg_invoice),    '')}
      ${kpiTile('Pending in queue',      fmt$(s.pending_value),  `${s.pending_count} waiting${s.pending_avg_age_days ? ` · avg ${s.pending_avg_age_days}d` : ''}`, s.pending_count > 0 ? 'warn' : '')}
      ${kpiTile('Drafts (not yet sent)', fmt$(s.draft_value),    `${s.draft_count} draft${s.draft_count===1?'':'s'}`)}
    </div>
  `;
}

function kpiTile(label, value, sub, variant, withHelp) {
  return `
    <div class="kpi-tile${variant ? ' kpi-' + variant : ''}">
      <div class="kpi-label">
        ${escapeHTML(label)}
        ${withHelp ? '<button id="forecastHelpBtn" class="kpi-help" title="How is this calculated?">?</button>' : ''}
      </div>
      <div class="kpi-value">${value}</div>
      ${sub ? `<div class="kpi-sub">${escapeHTML(sub)}</div>` : ''}
    </div>
  `;
}

// ---- v0.31 chart helpers ----
// Color palette for work types — kept consistent across donut, stacked bar,
// and multi-line chart so the eye reads the same color for the same category.
const WT_COLORS = {
  deployment: '#43B02A',  // Instacart green
  retrofit:   '#1A56B0',  // blue
  maintenance: '#F36D00',  // Instacart orange
  repair:     '#C0392B',  // red
};
const WT_ORDER = ['deployment','retrofit','maintenance','repair'];
const TECH_COLORS = ['#43B02A', '#F36D00', '#1A56B0', '#7F47C2', '#C0392B', '#0CA678'];

// v0.40 — Cost Tracker monthly summary card (forecast vs actual by service
// type by month). Mirrors the DASHBOARD tab in the team's Excel template
// so the in-app view matches what the Excel export looks like.
function renderCostTrackerCard(monthly) {
  if (!monthly || !monthly.rows || !monthly.rows.length) return '';
  const rows = monthly.rows;
  const t    = monthly.totals;
  const fmtVar = (v) => {
    if (v === 0) return '<span style="color: var(--muted);">—</span>';
    if (v > 0)   return `<span style="color: #C0392B;">+${fmt$(v)}</span>`;
    return            `<span style="color: var(--ic-green-deep);">${fmt$(v)}</span>`;
  };
  return `
    <div class="card" style="margin-top: 14px;">
      <div class="section-title" style="margin-top: 0; display: flex; justify-content: space-between; align-items: baseline;">
        <span>Cost Tracker — Forecast vs Actual by month</span>
        <span style="font-size: 11px; font-weight: normal; color: var(--muted);">matches the Excel <em>DASHBOARD</em> tab</span>
      </div>
      <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
        <thead>
          <tr style="background: #f4f5f7; text-align: right;">
            <th style="padding: 8px 10px; text-align: left;">Month</th>
            <th style="padding: 8px 10px;" colspan="3">Forecast</th>
            <th style="padding: 8px 10px;">Total Forecast</th>
            <th style="padding: 8px 10px;" colspan="3">Actual</th>
            <th style="padding: 8px 10px;">Total Actual</th>
            <th style="padding: 8px 10px;">Variance</th>
          </tr>
          <tr style="background: #f4f5f7; font-size: 10px; color: var(--muted); text-align: right;">
            <th></th>
            <th style="padding: 4px 8px;">Deploy</th>
            <th style="padding: 4px 8px;">Retrofit</th>
            <th style="padding: 4px 8px;">Other</th>
            <th></th>
            <th style="padding: 4px 8px;">Deploy</th>
            <th style="padding: 4px 8px;">Retrofit</th>
            <th style="padding: 4px 8px;">Other</th>
            <th></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr style="border-top: 1px solid var(--line); text-align: right;">
              <td style="padding: 8px 10px; text-align: left;"><strong>${escapeHTML(r.month)}</strong></td>
              <td style="padding: 8px 10px;">${fmt$(r.forecast_deployment)}</td>
              <td style="padding: 8px 10px;">${fmt$(r.forecast_retrofit)}</td>
              <td style="padding: 8px 10px;">${fmt$(r.forecast_other)}</td>
              <td style="padding: 8px 10px; font-weight: 700;">${fmt$(r.forecast_total)}</td>
              <td style="padding: 8px 10px;">${fmt$(r.actual_deployment)}</td>
              <td style="padding: 8px 10px;">${fmt$(r.actual_retrofit)}</td>
              <td style="padding: 8px 10px;">${fmt$(r.actual_other)}</td>
              <td style="padding: 8px 10px; font-weight: 700;">${fmt$(r.actual_total)}</td>
              <td style="padding: 8px 10px; font-weight: 700;">${fmtVar(r.variance)}</td>
            </tr>
          `).join('')}
          <tr style="border-top: 2px solid var(--ic-green-deep); background: #f4faf6; text-align: right; font-weight: 800;">
            <td style="padding: 10px;">Total</td>
            <td style="padding: 10px;" colspan="3"></td>
            <td style="padding: 10px;">${fmt$(t.forecast)}</td>
            <td style="padding: 10px;" colspan="3"></td>
            <td style="padding: 10px;">${fmt$(t.actual)}</td>
            <td style="padding: 10px;">${fmtVar(t.variance)}</td>
          </tr>
        </tbody>
      </table>
      <div style="font-size: 11px; color: var(--muted); margin-top: 8px;">
        Forecast: Deployment uses $40 per cart; Retrofit uses 0.7 hrs × $40 × #techs per cart; Travel = 40 mi × $0.70 × #techs per WO. Tunable in the <code>Assumptions</code> tab of the export.
      </div>
    </div>
  `;
}

// Donut chart with center total + legend on the right. Click-to-filter on
// each slice (drillKey defaults to 'wt' since this card is work-type centric).
function renderDonutCard(title, rows, labelKey, valueKey, subFn) {
  const data = rows.filter(r => r[valueKey] > 0);
  const total = data.reduce((s, r) => s + r[valueKey], 0);
  if (!data.length || !total) {
    return `<div class="card dash-card"><div class="section-title" style="margin-top:0;">${escapeHTML(title)}</div><div class="empty" style="padding:14px;font-size:12px;">No data in this period yet.</div></div>`;
  }
  const cx = 90, cy = 90, r = 72, ir = 48;
  // Build SVG arcs.
  let acc = 0;
  const slices = data.map(d => {
    const v = d[valueKey];
    const start = acc / total * Math.PI * 2;
    acc += v;
    const end = acc / total * Math.PI * 2;
    const large = end - start > Math.PI ? 1 : 0;
    const sx = cx + r * Math.sin(start),  sy = cy - r * Math.cos(start);
    const ex = cx + r * Math.sin(end),    ey = cy - r * Math.cos(end);
    const isx = cx + ir * Math.sin(end),  isy = cy - ir * Math.cos(end);
    const iex = cx + ir * Math.sin(start), iey = cy - ir * Math.cos(start);
    const path = `M${sx},${sy} A${r},${r} 0 ${large} 1 ${ex},${ey} L${isx},${isy} A${ir},${ir} 0 ${large} 0 ${iex},${iey} Z`;
    const color = WT_COLORS[d[labelKey]] || '#9ca3af';
    return { d, path, color, pct: v / total };
  });
  return `
    <div class="card dash-card">
      <div class="section-title" style="margin-top: 0;">${escapeHTML(title)} <span class="bar-help">Click a slice to filter</span></div>
      <div class="donut-row">
        <svg viewBox="0 0 180 180" class="donut-svg">
          ${slices.map(s => `
            <path d="${s.path}" fill="${s.color}" data-drill="wt" data-value="${escapeHTML(s.d[labelKey])}" role="button" tabindex="0">
              <title>${escapeHTML(s.d[labelKey])}: ${fmt$(s.d[valueKey])} (${(s.pct*100).toFixed(1)}%)</title>
            </path>
          `).join('')}
          <text x="${cx}" y="${cy - 4}" class="donut-center-label" text-anchor="middle">${escapeHTML('Total')}</text>
          <text x="${cx}" y="${cy + 14}" class="donut-center-value" text-anchor="middle">${fmt$(total)}</text>
        </svg>
        <div class="donut-legend">
          ${slices.map(s => `
            <div class="donut-legend-row" data-drill="wt" data-value="${escapeHTML(s.d[labelKey])}" role="button" tabindex="0">
              <span class="swatch" style="background: ${s.color};"></span>
              <div class="ll-body">
                <div class="ll-name">${escapeHTML(capitalize(s.d[labelKey]))}</div>
                <div class="ll-sub">${(s.pct*100).toFixed(0)}% · ${subFn ? escapeHTML(subFn(s.d)) : ''}</div>
              </div>
              <strong>${fmt$(s.d[valueKey])}</strong>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

// Horizontal stacked-bar chart for tech × work-type comparison.
// One bar per tech; each bar's segments use the WT colors so direct
// comparison is visual (longer green = more deployment, etc).
function renderStackedTechCard(title, rows) {
  const data = (rows || []).filter(t => t.total > 0);
  if (!data.length) {
    return `<div class="card dash-card"><div class="section-title" style="margin-top:0;">${escapeHTML(title)}</div><div class="empty" style="padding:14px;font-size:12px;">No data in this period yet.</div></div>`;
  }
  const max = Math.max(...data.map(t => t.total), 1);
  return `
    <div class="card dash-card">
      <div class="section-title" style="margin-top: 0;">${escapeHTML(title)} <span class="bar-help">Hover a segment for details · click row to drill</span></div>
      <div class="stacked-legend">
        ${WT_ORDER.map(wt => `
          <span class="legend-pill"><span class="swatch" style="background: ${WT_COLORS[wt]};"></span>${capitalize(wt)}</span>
        `).join('')}
      </div>
      ${data.map(t => {
        const widthPct = (t.total / max) * 100;
        const segments = WT_ORDER.map(wt => {
          const v = t.totals[wt] || 0;
          if (v <= 0) return '';
          const inner = (v / t.total) * 100;
          return `<div class="stack-seg" style="width:${inner}%; background:${WT_COLORS[wt]};" title="${capitalize(wt)}: ${fmt$(v)}"></div>`;
        }).join('');
        return `
          <div class="stack-row" data-drill="tech" data-value="${escapeHTML(String(t.user_id))}" role="button" tabindex="0">
            <div class="stack-row-head">
              <span class="bar-label">${escapeHTML(t.name)}</span>
              <strong>${fmt$(t.total)}</strong>
            </div>
            <div class="stack-track" style="width:${widthPct}%;">${segments}</div>
            <div class="bar-sub">${WT_ORDER.filter(wt => t.totals[wt] > 0).map(wt => `${capitalize(wt)} ${fmt$(t.totals[wt])}`).join(' · ')}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Multi-line chart: one line per tech across last 12 weeks. Optionally
// overlays an aggregate "team total" dashed line and a 4-week projection
// (Forecast tab only — Dashboard passes null/null and shows actuals only).
function renderMultiLineCard(title, techSeries, aggregateTrend, projection) {
  const series = (techSeries || []).filter(s => s.total > 0);
  if (!series.length || !aggregateTrend?.length) {
    return `<div class="card dash-card-wide" style="margin: 14px 0;"><div class="section-title" style="margin-top:0;">${escapeHTML(title)}</div><div class="empty" style="padding:14px;font-size:12px;">No data in this period yet.</div></div>`;
  }
  const showAggregate = !!projection;   // aggregate team line shows ONLY when projection is in play (Forecast tab)
  const W = 720, H = 220, padL = 44, padR = 16, padT = 16, padB = 36;
  const cols = aggregateTrend.length + (projection?.length || 0);
  const allValues = [
    ...series.flatMap(s => s.points.map(p => p.spend)),
    ...aggregateTrend.map(t => t.spend),
    ...((projection || []).map(t => t.projected_spend)),
  ];
  const maxY = Math.max(1, ...allValues);
  const xAt = (i) => padL + (i / (cols - 1)) * (W - padL - padR);
  const yAt = (v) => H - padB - (v / maxY) * (H - padT - padB);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(p => Math.round(p * maxY));
  const xLabels = [...aggregateTrend.map(w => w.week_start.slice(5)), ...((projection||[]).map(w => w.week_start.slice(5)))];

  const techLines = series.map((s, idx) => {
    const color = TECH_COLORS[idx % TECH_COLORS.length];
    const pts = s.points.map((p, i) => [xAt(i), yAt(p.spend)]);
    const d = pts.map(([x,y], i) => (i===0 ? `M${x},${y}` : `L${x},${y}`)).join(' ');
    const dots = pts.map(([x,y]) => `<circle cx="${x}" cy="${y}" r="3" fill="${color}" />`).join('');
    return { name: s.name, color, total: s.total, d, dots };
  });

  let teamD = '', projD = '';
  if (showAggregate) {
    const teamPts = aggregateTrend.map((t, i) => [xAt(i), yAt(t.spend)]);
    teamD = teamPts.map(([x,y], i) => (i===0 ? `M${x},${y}` : `L${x},${y}`)).join(' ');
    const projPts = (projection || []).map((t, i) => [xAt(aggregateTrend.length + i), yAt(t.projected_spend)]);
    projD = projPts.length ? `M${teamPts[teamPts.length-1][0]},${teamPts[teamPts.length-1][1]} ${projPts.map(([x,y]) => `L${x},${y}`).join(' ')}` : '';
  }

  return `
    <div class="card dash-card-wide" style="margin: 14px 0;">
      <div class="section-title" style="margin-top: 0;">${escapeHTML(title)} <span class="bar-help">${showAggregate ? '12-week history per tech + 4-week projection' : '12-week history per tech'}</span></div>

      <div class="multiline-wrap">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="multiline-svg">
          ${yTicks.map((v) => {
            const y = yAt(v);
            return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#eef0f4" stroke-width="1"/>
                    <text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="#888">${fmt$(v)}</text>`;
          }).join('')}
          ${teamD ? `<path d="${teamD}" stroke="#cbd2dc" stroke-width="1.5" fill="none" stroke-dasharray="2 3" />` : ''}
          ${projD ? `<path d="${projD}" stroke="#F36D00" stroke-width="1.5" fill="none" stroke-dasharray="3 4" opacity="0.7" />` : ''}
          ${techLines.map(l => `
            <path d="${l.d}" stroke="${l.color}" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round" />
            ${l.dots}
          `).join('')}
        </svg>
        <div class="multiline-x">${xLabels.map(l => `<span>${escapeHTML(l)}</span>`).join('')}</div>
      </div>

      <div class="multiline-legend">
        ${techLines.map(l => `
          <span class="legend-pill"><span class="swatch" style="background:${l.color};"></span>${escapeHTML(l.name)} <span style="color:var(--muted);font-weight:400;">${fmt$(l.total)}</span></span>
        `).join('')}
        ${showAggregate ? `<span class="legend-pill"><span class="swatch" style="background:#cbd2dc; border:1px dashed #888;"></span>Team total</span>` : ''}
        ${projection?.length ? `<span class="legend-pill"><span class="swatch" style="background:#F36D00; opacity:0.6;"></span>Projection</span>` : ''}
      </div>
    </div>
  `;
}

// Per-store multi-line. Reuses the same SVG approach as renderMultiLineCard
// but takes a flat series array (no aggregate/projection). Good for comparing
// the burn rate of the top stores against each other.
function renderMultiLineStoresCard(title, series) {
  const filtered = (series || []).filter(s => s.total > 0);
  if (!filtered.length) return '';
  const W = 720, H = 220, padL = 44, padR = 16, padT = 16, padB = 36;
  const cols = filtered[0].points.length;
  const allValues = filtered.flatMap(s => s.points.map(p => p.spend));
  const maxY = Math.max(1, ...allValues);
  const xAt = (i) => padL + (i / (cols - 1)) * (W - padL - padR);
  const yAt = (v) => H - padB - (v / maxY) * (H - padT - padB);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(p => Math.round(p * maxY));
  const xLabels = filtered[0].points.map(p => p.week_start.slice(5));

  const lines = filtered.map((s, idx) => {
    const color = TECH_COLORS[idx % TECH_COLORS.length];
    const pts = s.points.map((p, i) => [xAt(i), yAt(p.spend)]);
    const d = pts.map(([x,y], i) => (i===0 ? `M${x},${y}` : `L${x},${y}`)).join(' ');
    const dots = pts.map(([x,y], i) => s.points[i].spend > 0
      ? `<circle cx="${x}" cy="${y}" r="3" fill="${color}" />` : '').join('');
    return { name: s.name, color, total: s.total, d, dots };
  });

  return `
    <div class="card dash-card-wide" style="margin: 14px 0;">
      <div class="section-title" style="margin-top: 0;">${escapeHTML(title)} <span class="bar-help">12-week comparison · click below to filter</span></div>
      <div class="multiline-wrap">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="multiline-svg">
          ${yTicks.map(v => {
            const y = yAt(v);
            return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#eef0f4" stroke-width="1"/>
                    <text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="#888">${fmt$(v)}</text>`;
          }).join('')}
          ${lines.map(l => `<path d="${l.d}" stroke="${l.color}" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round" />${l.dots}`).join('')}
        </svg>
        <div class="multiline-x">${xLabels.map(l => `<span>${escapeHTML(l)}</span>`).join('')}</div>
      </div>
      <div class="multiline-legend">
        ${lines.map(l => `
          <span class="legend-pill" data-drill="store" data-value="${escapeHTML(l.name)}" role="button" tabindex="0" style="cursor:pointer;">
            <span class="swatch" style="background:${l.color};"></span>${escapeHTML(l.name)}
            <span style="color:var(--muted);font-weight:400;">${fmt$(l.total)}</span>
          </span>
        `).join('')}
      </div>
    </div>
  `;
}

// Vertical column chart for cart-count buckets. Same drill-down hooks as
// horizontal bars but with a fresh look.
function renderColumnCard(title, rows) {
  const data = (rows || []).filter(r => r.total > 0);
  if (!data.length) {
    return `<div class="card dash-card"><div class="section-title" style="margin-top:0;">${escapeHTML(title)}</div><div class="empty" style="padding:14px;font-size:12px;">No data in this period yet.</div></div>`;
  }
  const max = Math.max(...data.map(r => r.total), 1);
  const W = 320, H = 200, padL = 32, padR = 8, padT = 12, padB = 28;
  const colW = (W - padL - padR) / data.length;
  return `
    <div class="card dash-card">
      <div class="section-title" style="margin-top:0;">${escapeHTML(title)}</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="column-svg">
        ${[0, 0.5, 1].map(p => {
          const y = H - padB - p * (H - padT - padB);
          return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#eef0f4"/>
                  <text x="${padL - 4}" y="${y + 3}" text-anchor="end" font-size="9" fill="#888">${fmt$(p * max)}</text>`;
        }).join('')}
        ${data.map((r, i) => {
          const cx = padL + i * colW + colW / 2;
          const barH = (r.total / max) * (H - padT - padB);
          const y = H - padB - barH;
          const w = Math.min(40, colW * 0.7);
          return `
            <g>
              <rect x="${cx - w/2}" y="${y}" width="${w}" height="${barH}"
                    fill="#43B02A" rx="3" opacity="0.92">
                <title>${escapeHTML(r.bucket)}: ${fmt$(r.total)} (${r.wo_count} WOs)</title>
              </rect>
              <text x="${cx}" y="${H - padB + 14}" text-anchor="middle" font-size="10" font-weight="600" fill="#3a3a3a">${escapeHTML(r.bucket)}</text>
              <text x="${cx}" y="${H - padB + 26}" text-anchor="middle" font-size="9" fill="#888">${r.wo_count} WOs</text>
            </g>
          `;
        }).join('')}
      </svg>
    </div>
  `;
}

// Vertical bar chart for stores (or any rows with long labels). Mirrors the
// look of renderColumnCard but with rotated x-axis labels so long store
// names ("ShopRite of Bridge & Harbison") fit without wrapping.
// v0.46 — replaces horizontal bars on "Top stores by spend" per design ask.
//
// `rows`     — array of objects, sorted desc by `valueKey`
// `labelKey` — field name for the bar label (e.g. 'store_name')
// `valueKey` — numeric field for the bar height (e.g. 'total')
// `subFn(row)` — returns a small per-bar tooltip string (e.g. "12 visits")
// `opts.drillKey` + `opts.drillValue(row)` — click a bar to filter dashboard
// `opts.valueFmt` — custom value formatter (defaults to fmt$)
// `opts.maxBars` — cap N bars (default 10)
function renderVerticalBarCard(title, rows, labelKey, valueKey, subFn, opts = {}) {
  const fmtV = opts.valueFmt || ((v) => fmt$(v));
  const maxBars = opts.maxBars || 10;
  const data = (rows || []).filter(r => r[valueKey] > 0).slice(0, maxBars);
  if (!data.length) {
    return `<div class="card dash-card"><div class="section-title" style="margin-top:0;">${escapeHTML(title)}</div><div class="empty" style="padding:14px;font-size:12px;">No data in this period yet.</div></div>`;
  }
  const max  = Math.max(...data.map(r => r[valueKey]), 1);

  // Layout: wider canvas + tall bottom padding to fit rotated labels.
  const W = 640, H = 360, padL = 56, padR = 12, padT = 24, padB = 110;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const colW  = plotW / data.length;
  const barW  = Math.min(48, colW * 0.62);

  // Y-axis ticks at 0 / 25 / 50 / 75 / 100 % of max.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(p => ({ p, val: p * max, y: padT + plotH * (1 - p) }));

  // Trim long labels — full name is in title tooltip + secondary text.
  // Rotated -40° labels can fit ~24 chars without overlapping the next bar.
  const truncate = (s, n) => (s && s.length > n) ? s.slice(0, n - 1) + '…' : (s || '');
  const LABEL_MAX = 24;

  const helpText = opts.drillKey ? '<span class="bar-help">Tap a bar to filter the dashboard.</span>' : '';

  return `
    <div class="card dash-card">
      <div class="section-title" style="margin-top:0;">${escapeHTML(title)} ${helpText}</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="vbar-svg" style="width:100%;height:auto;display:block;">
        <defs>
          <linearGradient id="vbar-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"  stop-color="#43B02A" stop-opacity="0.95"/>
            <stop offset="100%" stop-color="#1F7A1F" stop-opacity="1"/>
          </linearGradient>
        </defs>

        <!-- y-axis grid + labels -->
        ${ticks.map(t => `
          <line x1="${padL}" y1="${t.y}" x2="${W - padR}" y2="${t.y}" stroke="#eef0f4" stroke-width="1"/>
          <text x="${padL - 8}" y="${t.y + 3}" text-anchor="end" font-size="10" fill="#888">${fmtV(t.val)}</text>
        `).join('')}

        <!-- x-axis baseline -->
        <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#d6dae0" stroke-width="1"/>

        <!-- bars -->
        ${data.map((r, i) => {
          const cx = padL + i * colW + colW / 2;
          const v  = r[valueKey];
          const barH = (v / max) * plotH;
          const y = padT + plotH - barH;
          const labelText = truncate(String(r[labelKey] || ''), LABEL_MAX);
          const drillAttrs = opts.drillKey
            ? `data-drill="${opts.drillKey}" data-value="${escapeHTML(opts.drillValue ? opts.drillValue(r) : r[labelKey])}" role="button" tabindex="0" style="cursor:pointer;"`
            : '';
          const sub = subFn ? subFn(r) : '';
          return `
            <g class="vbar-row" ${drillAttrs}>
              <!-- click target: full column -->
              <rect x="${cx - colW/2}" y="${padT}" width="${colW}" height="${plotH}" fill="transparent"></rect>
              <rect x="${cx - barW/2}" y="${y}" width="${barW}" height="${Math.max(barH, 2)}"
                    fill="url(#vbar-grad)" rx="4" class="vbar-bar">
                <title>${escapeHTML(String(r[labelKey] || ''))}: ${fmtV(v)}${sub ? ' · ' + sub : ''}</title>
              </rect>
              <!-- value label above bar -->
              <text x="${cx}" y="${y - 6}" text-anchor="middle" font-size="11" font-weight="700" fill="#1F4E1F">${fmtV(v)}</text>
              <!-- rotated x-axis label -->
              <text x="${cx}" y="${padT + plotH + 12}" text-anchor="end" font-size="11" font-weight="600" fill="#3a3a3a"
                    transform="rotate(-40 ${cx} ${padT + plotH + 12})">${escapeHTML(labelText)}</text>
            </g>
          `;
        }).join('')}
      </svg>
      ${data.length > 5 ? `<div style="font-size: 11px; color: var(--muted); text-align: right; margin-top: 4px;">Showing top ${data.length} of ${rows.length}</div>` : ''}
    </div>
  `;
}

// Horizontal bar chart card. `rows` is an array of objects, `labelKey` and
// `valueKey` are field names. `subLineFn(row)` returns a small meta string.
// `opts.drillKey` + `opts.drillValue(row)` make each bar clickable to filter
// the dashboard by that field (one of: tech, store, wt).
function renderBarCard(title, rows, labelKey, valueKey, max, subLineFn, opts = {}) {
  const helpText = opts.drillKey ? '<span class="bar-help">Tap a row to filter the dashboard.</span>' : '';
  const fmtV = opts.valueFmt || ((v) => fmt$(v));
  if (!rows.length || !max) {
    return `
      <div class="card dash-card">
        <div class="section-title" style="margin-top: 0;">${escapeHTML(title)}</div>
        <div class="empty" style="padding: 14px; font-size: 12px;">No data in this period yet.</div>
      </div>
    `;
  }
  return `
    <div class="card dash-card">
      <div class="section-title" style="margin-top: 0;">${escapeHTML(title)}${helpText}</div>
      ${rows.map(r => {
        const label = r[labelKey] || '—';
        const v     = r[valueKey] || 0;
        const pct   = max > 0 ? Math.max(2, (v / max) * 100) : 0;
        const drillAttrs = opts.drillKey
          ? `data-drill="${escapeHTML(opts.drillKey)}" data-value="${escapeHTML(String(opts.drillValue(r) ?? ''))}" role="button" tabindex="0"`
          : '';
        return `
          <div class="bar-row ${opts.drillKey ? 'bar-clickable' : ''}" ${drillAttrs}>
            <div class="bar-row-head">
              <span class="bar-label">${escapeHTML(String(label))}</span>
              <strong>${fmtV(v)}</strong>
            </div>
            <div class="bar-track"><div class="bar-fill" style="width: ${pct}%;"></div></div>
            ${subLineFn ? `<div class="bar-sub">${escapeHTML(subLineFn(r))}</div>` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// SVG sparkline-style trend chart with projected bars on the right.
function renderTrendCard(trend, projection) {
  if (!trend.length) return '';
  const all = [...trend.map(w => w.spend), ...projection.map(w => w.projected_spend)];
  const max = Math.max(1, ...all);
  const W = 700, H = 160, pad = 24;
  const totalCols = trend.length + projection.length;
  const colW = (W - pad * 2) / totalCols;
  const xy = (i, v) => [pad + i * colW + colW / 2, H - pad - (v / max) * (H - pad * 2)];
  const trendPts = trend.map((w, i) => xy(i, w.spend));
  const allPts = [...trendPts, ...projection.map((w, i) => xy(trend.length + i, w.projected_spend))];
  const trendLine = trendPts.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(' ');
  const projLine = allPts.slice(trend.length - 1).map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(' ');

  const xLabels = trend.map(w => w.week_start.slice(5)).concat(projection.map(w => w.week_start.slice(5)));
  return `
    <div class="card dash-card-wide" style="margin-top: 14px;">
      <div class="section-title" style="margin-top: 0;">12-week trend + 4-week projection</div>
      <p class="help" style="margin: 0 0 12px;">Bars are weekly spend; orange line is the linear projection of the next 4 weeks.</p>
      <div class="trend-svg-wrap">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="trend-svg">
          <line x1="${pad}" y1="${H-pad}" x2="${W-pad}" y2="${H-pad}" stroke="#e5e8ee" stroke-width="1"/>
          ${trend.map((w, i) => {
            const [cx, cy] = xy(i, w.spend);
            const barH = (H - pad) - cy;
            return `<rect x="${cx - colW * 0.4}" y="${cy}" width="${colW * 0.8}" height="${Math.max(0,barH)}" fill="#43B02A" opacity="0.85" rx="2" />`;
          }).join('')}
          ${projection.map((w, i) => {
            const [cx, cy] = xy(trend.length + i, w.projected_spend);
            const barH = (H - pad) - cy;
            return `<rect x="${cx - colW * 0.4}" y="${cy}" width="${colW * 0.8}" height="${Math.max(0,barH)}" fill="#F36D00" opacity="0.45" rx="2" />`;
          }).join('')}
          <path d="${trendLine}" stroke="#1a5e0d" stroke-width="2" fill="none" stroke-linecap="round" />
          <path d="${projLine}" stroke="#F36D00" stroke-width="2" fill="none" stroke-linecap="round" stroke-dasharray="4 4" />
        </svg>
        <div class="trend-x-axis">${xLabels.map(l => `<span>${l}</span>`).join('')}</div>
      </div>
      <div class="trend-legend">
        <span><span class="swatch" style="background:#43B02A;"></span>Actual</span>
        <span><span class="swatch" style="background:#F36D00;"></span>Projected (linear)</span>
      </div>
    </div>
  `;
}

function renderForecastCard(items, total) {
  if (!items.length) return '';
  return `
    <div class="card dash-card-wide" style="margin-top: 14px;">
      <div class="flex between" style="align-items: flex-start;">
        <div>
          <div class="section-title" style="margin: 0;">🔮 Forecast — open work orders</div>
          <p class="help" style="margin: 4px 0 12px;">Each open / in-progress WO × the historical $/cart for its work type. Use to budget the next sprint of cart work.</p>
        </div>
        <div style="text-align:right;">
          <div class="meta">Total estimated</div>
          <div style="font-size: 22px; font-weight: 700; color: var(--ic-orange);">${fmt$(total)}</div>
        </div>
      </div>
      <table class="dash-table">
        <thead><tr><th>Work order</th><th>Type</th><th class="r">Carts</th><th class="r">$/cart</th><th class="r">Estimated</th></tr></thead>
        <tbody>
          ${items.map(it => `
            <tr>
              <td><strong>${escapeHTML(it.external_id)}</strong>${it.store_name ? `<div class="meta">${escapeHTML(it.store_name)}</div>` : ''}</td>
              <td>${escapeHTML(it.work_type || '—')}</td>
              <td class="r">${it.cart_count}</td>
              <td class="r">${fmt$(it.rate_per_cart)}</td>
              <td class="r"><strong>${fmt$(it.estimated_spend)}</strong></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ---- SETTINGS ----
async function renderSettings(root) {
  const me = STATE.user;
  const isManager = ['ops_manager','sr_manager','pm'].includes(me.role);
  // Policy + custom rules moved to their own bottom-bar tab in v0.20.
  const s = await api('/settings/integrations');

  function statusPill(cfg) {
    if (cfg.configured) return `<span class="badge approved">Configured ✓</span>`;
    if (cfg.from_env)   return `<span class="badge approved">From env ✓</span>`;
    return `<span class="badge gray">Not set</span>`;
  }

  root.innerHTML = `
    <div class="section-title">Your profile</div>
    <div class="card">
      <p class="help" style="margin: 0 0 12px;">Used as the bill-from header on your formal invoice.</p>
      <span class="label">Full name</span>
      <input class="field" id="profName" value="${escapeHTML(STATE.user.name || '')}" disabled />
      <span class="label">Email</span>
      <input class="field" id="profEmail" value="${escapeHTML(STATE.user.email || '')}" disabled />
      <span class="label">Home address</span>
      <input class="field" id="profAddr" placeholder="24 Mayflower Drive, Sicklerville, NJ 08081" value="${escapeHTML(STATE.user.home_address || '')}" />
      <span class="label">Phone</span>
      <input class="field" id="profPhone" placeholder="856-725-2298" value="${escapeHTML(STATE.user.home_phone || '')}" />
      <button class="btn btn-primary btn-block" id="profSave">Save profile</button>
      <button class="btn btn-ghost btn-block" id="profChangePwd" style="margin-top: 8px;">🔒 Change password</button>
    </div>

    <div class="section-title">Integrations</div>
    <div class="card">
      <p class="meta" style="margin:0;">Org-level API credentials. Configured here, used by every technician's "Paste ticket URL" feature on Add Work Order.</p>
    </div>

    <div class="section-title">Freshdesk</div>
    <div class="card">
      <div class="flex between" style="margin-bottom: 10px;">
        <div>
          <strong>Status</strong>
          ${s.freshdesk.domain ? `<div class="meta">Domain: ${escapeHTML(s.freshdesk.domain)}.freshdesk.com</div>` : ''}
          ${s.freshdesk.key_masked ? `<div class="meta">Key: <code>${s.freshdesk.key_masked}</code></div>` : ''}
        </div>
        ${statusPill(s.freshdesk)}
      </div>
      <span class="label">Subdomain</span>
      <input class="field" id="fdDomain" placeholder="acme  (from https://acme.freshdesk.com)" value="${escapeHTML(s.freshdesk.domain || '')}" />
      <span class="label">API key</span>
      <input class="field" id="fdKey" type="password" placeholder="${s.freshdesk.key_masked ? 'leave blank to keep · enter new to replace · clear to remove' : 'paste API key from Profile Settings'}" />
      <div class="help">Get from Freshdesk: profile picture (top right) → Profile Settings → "Show your API Key".</div>
      <div class="actions">
        <button class="btn btn-ghost" data-test="freshdesk">Test connection</button>
        <button class="btn btn-primary" data-save="freshdesk">Save</button>
      </div>
    </div>

    <div class="section-title">MaintainX</div>
    <div class="card">
      <div class="flex between" style="margin-bottom: 10px;">
        <div>
          <strong>Status</strong>
          ${s.maintainx.key_masked  ? `<div class="meta">Token: <code>${s.maintainx.key_masked}</code></div>` : ''}
          <div class="meta">
            Org ID: <code>${escapeHTML(s.maintainx.organization_id_effective || '—')}</code>
            ${s.maintainx.organization_id_is_default ? `<span style="color: var(--ic-green-deep); font-size: 11px; margin-left: 4px;">(default · Instacart/Caper)</span>` : ''}
          </div>
        </div>
        ${statusPill(s.maintainx)}
      </div>
      <span class="label">API token</span>
      <input class="field" id="mxKey" type="password" placeholder="${s.maintainx.key_masked ? 'leave blank to keep · enter new to replace · clear to remove' : 'paste token (read-only is fine)'}" />
      <div class="help">Get from MaintainX: org name (bottom left) → Settings → Integrations → API Tokens → Create.</div>

      <span class="label">Organization ID <span style="color: var(--muted); font-weight: 400;">(default: 477835 / Instacart/Caper)</span></span>
      <input class="field" id="mxOrg" placeholder="477835" value="${escapeHTML(s.maintainx.organization_id || '')}" />
      <div class="help">Default <code>477835</code> (Instacart/Caper) is baked in — leave blank and it just works. Override here only if you need a different org. Tap <strong>Discover orgs</strong> to list all orgs your token can access.</div>

      <div class="actions" style="flex-wrap: wrap;">
        <button class="btn btn-ghost btn-sm" data-act="discover-orgs">🔎 Discover orgs</button>
        <button class="btn btn-ghost" data-test="maintainx">Test connection</button>
        <button class="btn btn-primary" data-save="maintainx">Save</button>
      </div>
      <div id="orgPickResult" style="margin-top: 10px;"></div>
    </div>

    <div class="alert info">
      <span class="ico">🔒</span>
      <div class="body">Stored once at the org level. Every technician using the app gets the benefit of auto-fill — no per-user setup. Keys are masked everywhere they appear in the UI.</div>
      <button class="close" data-act="dismiss">×</button>
    </div>

    ${isManager ? `
      <div class="card" style="margin-top: 14px; background: #f0f7f3; border-left: 4px solid var(--ic-green);">
        <strong>Policy &amp; custom rules</strong> moved to their own tab — open the <strong>Policy</strong> tab from the bottom navigation.
      </div>
    ` : ''}
  `;

  $('#profChangePwd')?.addEventListener('click', () => openChangePasswordSheet({ forced: false }));

  $('#profSave')?.addEventListener('click', async () => {
    try {
      const updated = await api('/me', { method: 'PATCH', body: {
        home_address: $('#profAddr').value.trim(),
        home_phone:   $('#profPhone').value.trim(),
      }});
      STATE.user = { ...STATE.user, ...updated };
      toast('Profile saved ✓', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });

  $$('[data-test]').forEach(b => b.addEventListener('click', async () => {
    const source = b.dataset.test;
    try {
      toast(`Testing ${source} connection…`);
      const r = await api('/settings/integrations/test', { method: 'POST', body: { source } });
      toast(r.message || 'Connected ✓', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }));

  // Discover orgs from MaintainX
  $$('[data-act="discover-orgs"]').forEach(b => b.addEventListener('click', async () => {
    const out = $('#orgPickResult');
    out.innerHTML = `<div class="meta">Querying MaintainX…</div>`;
    try {
      const r = await api('/settings/integrations/maintainx-orgs');
      if (!r.orgs || !r.orgs.length) {
        out.innerHTML = `
          <div class="alert warn">
            <span class="ico">⚠</span>
            <div class="body">
              <strong>No orgs returned.</strong> Tried:<br/>
              <code style="font-size: 11px;">${r.tried.map(t => `${t.url} → ${t.status || 'err'} ${t.found != null ? '(' + t.found + ' orgs)' : t.error || t.note || ''}`).join('<br/>')}</code><br/>
              You may need to copy the org ID from MaintainX directly.
            </div>
          </div>`;
        return;
      }
      out.innerHTML = `
        <div class="alert ok"><span class="ico">✓</span><div class="body">Found ${r.orgs.length} org${r.orgs.length === 1 ? '' : 's'}. Tap one to use it:</div></div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          ${r.orgs.map(o => `
            <button type="button" class="card tap" style="text-align: left; padding: 12px 14px; cursor: pointer; border: 1.5px solid var(--line); margin: 0;" data-org-id="${escapeHTML(o.id)}">
              <div class="flex between">
                <div>
                  <strong>${escapeHTML(o.name)}</strong>
                  <div class="meta">ID: <code>${escapeHTML(o.id)}</code></div>
                </div>
                <div style="color: var(--ic-green-deep); font-size: 22px;">›</div>
              </div>
            </button>
          `).join('')}
        </div>`;
      $$('[data-org-id]').forEach(btn => btn.addEventListener('click', () => {
        $('#mxOrg').value = btn.dataset.orgId;
        toast(`Org set — tap Save to persist, then Test connection`, 'ok');
      }));
    } catch (e) { out.innerHTML = `<div class="alert err"><span class="ico">!</span><div class="body">${escapeHTML(e.message)}</div></div>`; }
  }));

  // (Policy + rules now live on the dedicated Policy tab — see renderPolicyView.)

  $$('[data-save]').forEach(b => b.addEventListener('click', async () => {
    const which = b.dataset.save;
    const body = {};
    if (which === 'freshdesk') {
      body.freshdesk_domain  = $('#fdDomain').value.trim();
      const k = $('#fdKey').value.trim();
      if (k) body.freshdesk_api_key = k;
    }
    if (which === 'maintainx') {
      const k = $('#mxKey').value.trim();
      if (k) body.maintainx_api_key = k;
      const o = $('#mxOrg').value.trim();
      // Send org id even if empty so user can clear it
      body.maintainx_organization_id = o;
    }
    if (!Object.keys(body).length) return toast('Nothing to save', 'err');
    try {
      await api('/settings/integrations', { method: 'PUT', body });
      toast('Saved ✓', 'ok');
      goto('settings');
    } catch (e) { toast(e.message, 'err'); }
  }));
}

// ---- INVOICES TAB ----
// Single tab consolidating: this-week's draft (prominent at top with quick action),
// + New Invoice CTA, then the complete log of all other invoices.
async function renderMine(root) {
  const [all, myAddReqs] = await Promise.all([
    api('/invoices'),
    api('/addition-requests/mine').catch(() => []),
  ]);
  // v0.68 — surface add-work-order requests: pending ones + anything decided in
  // the last 14 days, so the tech sees the manager's decision (and the link to
  // the new invoice on approval, or the reason on denial) right here.
  const _addReqCutoff = Date.now() - 14 * 86400000;
  const addReqNotices = (myAddReqs || []).filter(rq =>
    rq.status === 'pending' ||
    (rq.decided_at && new Date(rq.decided_at).getTime() >= _addReqCutoff)
  );
  const thisWeekStart = (() => {
    const d = new Date();
    d.setDate(d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1));
    return d.toISOString().slice(0,10);
  })();
  const currentDraft = all.find(i => i.status === 'draft' && i.period_start === thisWeekStart);
  const others = all.filter(i => i.id !== (currentDraft && currentDraft.id));
  // v0.67 — invoices the Ops Mgr approved that now await this tech's final step:
  // verify the details and send to AP.
  const awaitingSend = all.filter(readyToSendToAp);

  let filter = 'all';
  let page = 0;   // v0.34 — paginated 10/page; resets when filter changes
  function match(inv) {
    if (filter === 'all')       return true;
    if (filter === 'drafts')    return inv.status === 'draft';
    if (filter === 'submitted') return ['submitted','in_review','approved_ops','approved_sr','queued_ap'].includes(inv.status);
    if (filter === 'paid')      return inv.status === 'sent_ap';
    if (filter === 'rejected')  return inv.status === 'rejected';
    return true;
  }

  function html() {
    const filtered = others.filter(match);
    return `
      <!-- v0.67 — Verify & send notification. Ops approval is the final approval;
           once approved, the tech does the AP hand-off themselves. -->
      ${awaitingSend.length ? `
        <div class="card" style="border-left: 4px solid var(--ic-orange); background: #fff8e7; padding: 14px; margin-bottom: 14px;">
          <div style="font-weight: 700; font-size: 14px; color: var(--ic-green-deep);">🔔 ${awaitingSend.length} invoice${awaitingSend.length===1?'':'s'} approved — verify &amp; send to AP</div>
          <div style="font-size: 12px; color: var(--ink-2); margin-top: 4px;">Your Ops Manager approved ${awaitingSend.length===1?'it':'them'}. Review the details, then send to Accounts Payable.</div>
          <div style="margin-top: 10px; display: flex; flex-direction: column; gap: 6px;">
            ${awaitingSend.slice(0, 5).map(inv => `
              <button class="btn btn-warn btn-sm" data-send-inv="${inv.id}" style="display:flex; justify-content: space-between; align-items:center;">
                <span>${escapeHTML(inv.invoice_number)} · ${fmtDate(inv.period_start)} → ${fmtDate(inv.period_end)}</span>
                <span>${fmt$(inv.total)} →</span>
              </button>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <!-- v0.68 — Add-work-order request decisions (notification surface). -->
      ${addReqNotices.length ? `
        <div class="card" style="border-left: 4px solid var(--ic-orange); background: #fff8f0; padding: 14px; margin-bottom: 14px;">
          <div style="font-weight: 700; font-size: 14px;">🔔 Add-work-order request${addReqNotices.length===1?'':'s'}</div>
          <div style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;">
            ${addReqNotices.map(rq => {
              if (rq.status === 'approved') {
                return `<div style="font-size: 13px;">✅ Approved — new invoice <a href="#" data-go-inv="${rq.new_invoice_id}"><strong>${escapeHTML(rq.new_invoice_number || ('#'+rq.new_invoice_id))}</strong></a> created for ${fmtDate(rq.period_start)} → ${fmtDate(rq.period_end)}. Open it to add hours/expenses and submit.</div>`;
              }
              if (rq.status === 'denied') {
                return `<div style="font-size: 13px; color: var(--err-fg);">✗ Not approved (week ${fmtDate(rq.period_start)} → ${fmtDate(rq.period_end)})${rq.decided_by_name ? ' · by ' + escapeHTML(rq.decided_by_name) : ''}.${rq.decision_reason ? ' Reason: ' + escapeHTML(rq.decision_reason) : ''}</div>`;
              }
              return `<div style="font-size: 13px; color: var(--ink-2);">⏳ Pending Ops Mgr review (week ${fmtDate(rq.period_start)} → ${fmtDate(rq.period_end)}) · WOs: ${escapeHTML(rq.requested_wos || '')}</div>`;
            }).join('')}
          </div>
        </div>
      ` : ''}

      <!-- THIS WEEK card (always shown, prominent) -->
      <div class="section-title">This week</div>
      ${currentDraft
        ? `<div class="card tap" id="openCurrent" style="border-left: 4px solid var(--ic-green); padding: 16px;">
             <div class="flex between" style="align-items: flex-start;">
               <div>
                 <div style="font-size: 11px; color: var(--ic-green-deep); text-transform: uppercase; letter-spacing: 0.6px; font-weight: 700;">Current invoice · ${fmtDate(currentDraft.period_start)} → ${fmtDate(currentDraft.period_end)}</div>
                 <div style="font-size: 18px; font-weight: 700; margin-top: 4px;">${currentDraft.invoice_number}</div>
               </div>
               <div style="text-align: right;">
                 <span class="badge draft">Draft</span>
                 <div style="font-size: 22px; font-weight: 700; margin-top: 8px;">${fmt$(currentDraft.total)}</div>
               </div>
             </div>
             <div style="font-size: 12px; color: var(--muted); margin-top: 8px;">Tap to edit · add expenses · review &amp; submit</div>
           </div>`
        : `<div class="card" style="border-left: 4px solid var(--ic-orange); padding: 16px; background: #fff8f0;">
             <div style="font-size: 14px; font-weight: 600;">No invoice for this week yet</div>
             <div style="font-size: 12px; color: var(--ink-2); margin-top: 4px;">Clock in or add an expense and a draft will be created automatically. Or tap below to start one now.</div>
             <button class="btn btn-primary btn-sm" id="openCurrentNew" style="margin-top: 12px;">Open current week invoice</button>
           </div>`}

      <!-- + New Invoice options + Upload PDF -->
      <div class="flex gap-12" style="margin: 14px 0; flex-wrap: wrap;">
        <button class="btn btn-warn" style="flex:1; min-width: 160px;" id="newInvBtn">＋ Past week</button>
        <button class="btn btn-warn" style="flex:1; min-width: 160px;" id="customInvBtn">📅 Custom period (up to 1 month)</button>
        <button class="btn btn-primary" style="flex:1; min-width: 160px;" id="techUploadInvBtn">📄 Upload an old invoice</button>
      </div>

      <!-- All invoices log -->
      <div class="section-title">All invoices (${others.length})</div>
      ${others.length === 0
        ? `<div class="empty"><div class="big">📋</div>No previous invoices yet.<br/>Submitted invoices show up here.</div>`
        : `
          <div class="chips" style="margin-bottom: 14px;">
            <span class="chip ${filter==='all'?'selected':''}"        data-filter="all">All (${others.length})</span>
            ${others.some(i => i.status === 'draft') ? `<span class="chip ${filter==='drafts'?'selected':''}" data-filter="drafts">Drafts (${others.filter(i => i.status === 'draft').length})</span>` : ''}
            <span class="chip ${filter==='submitted'?'selected':''}"  data-filter="submitted">Pending (${others.filter(i => ['submitted','in_review','approved_ops','approved_sr','queued_ap'].includes(i.status)).length})</span>
            <span class="chip ${filter==='paid'?'selected':''}"       data-filter="paid">Sent to AP (${others.filter(i => i.status === 'sent_ap').length})</span>
            ${others.some(i => i.status === 'rejected') ? `<span class="chip ${filter==='rejected'?'selected':''}" data-filter="rejected">Rejected</span>` : ''}
          </div>
          ${filtered.length === 0
            ? `<div class="empty">No invoices in this filter.</div>`
            : (() => {
                // v0.34 — paginate at 10/page so techs don't have a wall of cards.
                const total = filtered.length;
                const pages = Math.max(1, Math.ceil(total / 10));
                if (page >= pages) page = pages - 1;
                const slice = filtered.slice(page * 10, page * 10 + 10);
                return `
                  ${slice.map(inv => `
                    <div class="card tap" data-inv="${inv.id}">
                      <div class="flex between" style="align-items: center;">
                        <div>
                          <strong>${inv.invoice_number}</strong>
                          <div style="font-size:12px;color:var(--muted);margin-top:4px">${fmtDate(inv.period_start)} → ${fmtDate(inv.period_end)}</div>
                        </div>
                        <div style="text-align: right;">
                          <span class="badge ${badgeForStatus(inv.status)}">${labelForStatus(inv.status)}</span>
                          <div style="font-size: 16px; font-weight: 700; margin-top: 6px;">${fmt$(inv.total)}</div>
                        </div>
                      </div>
                      ${inv.submitted_at ? `<div style="font-size: 11px; color: var(--muted); margin-top: 6px;">Submitted ${new Date(inv.submitted_at).toLocaleDateString()}</div>` : ''}
                      <div class="trail">${trailFor(inv)}</div>
                    </div>
                  `).join('')}
                  ${pages > 1 ? `
                    <div class="flex between" style="margin-top: 14px; align-items: center;">
                      <button class="btn btn-ghost btn-sm" id="pagePrev" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>
                      <span class="meta">Page ${page + 1} of ${pages} · ${total} invoice${total===1?'':'s'}</span>
                      <button class="btn btn-ghost btn-sm" id="pageNext" ${page === pages - 1 ? 'disabled' : ''}>Next ›</button>
                    </div>
                  ` : ''}
                `;
              })()}
        `}
    `;
  }

  function bind() {
    $('#openCurrent')?.addEventListener('click', () => goto('invoice'));
    $('#openCurrentNew')?.addEventListener('click', () => goto('invoice'));
    $$('[data-send-inv]').forEach(b => b.addEventListener('click', () => goto('invDetail', Number(b.dataset.sendInv))));
    $$('[data-go-inv]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); goto('invDetail', Number(a.dataset.goInv)); }));
    $('#newInvBtn')?.addEventListener('click', openPastInvoiceSheet);
    $('#customInvBtn')?.addEventListener('click', openCustomPeriodSheet);
    $('#techUploadInvBtn')?.addEventListener('click', openTechUploadSheet);
    $$('[data-filter]').forEach(c => c.addEventListener('click', () => { filter = c.dataset.filter; page = 0; root.innerHTML = html(); bind(); }));
    $$('.card.tap[data-inv]').forEach(c => c.addEventListener('click', () => goto('invDetail', Number(c.dataset.inv))));
    $('#pagePrev')?.addEventListener('click', () => { page = Math.max(0, page - 1); root.innerHTML = html(); bind(); });
    $('#pageNext')?.addEventListener('click', () => { page = page + 1; root.innerHTML = html(); bind(); });
  }

  root.innerHTML = html();
  bind();
}

// v0.58 — Pre-submit warning sheet. Field tech (or manager proxy) sees every
// policy violation grouped by WO, can fix items first (Cancel) or knowingly
// justify and submit (Submit anyway). The justification text becomes the
// invoice notes so Ops Mgr review sees the same context the tech wrote.
function openFlagSubmitSheet({ invoice, flags, proxy }) {
  const byWO = {};
  for (const f of flags) {
    (byWO[f.wo] ||= { wo: f.wo, store: f.store, flags: [] }).flags.push(f);
  }
  showSheet(`
    <h3 style="color: var(--err-fg);">⚠ ${flags.length} policy violation${flags.length === 1 ? '' : 's'} on this invoice</h3>
    <p class="help" style="margin-top: -4px;">
      ${proxy ? 'Before submitting on behalf of this tech, ' : 'Before submitting, '}
      review each flag below. You can <strong>Cancel</strong> to fix the underlying time entries / expenses,
      or add a justification and <strong>Submit anyway</strong> — Ops Mgr review will see your note.
    </p>

    <div style="max-height: 320px; overflow-y: auto; border: 1px solid var(--line); border-radius: 10px; padding: 4px; margin-bottom: 12px;">
      ${Object.values(byWO).map(g => `
        <div style="padding: 10px 12px; border-bottom: 1px solid var(--line);">
          <div style="font-size: 12px; font-weight: 700; color: var(--ic-green-deep);">
            ${escapeHTML(g.wo)}${g.store ? ' · ' + escapeHTML(g.store) : ''}
          </div>
          ${g.flags.map(f => `
            <div style="margin-top: 6px; font-size: 12px;">
              <span class="badge" style="background: var(--err-bg); color: var(--err-fg); font-weight: 700;">${escapeHTML(f.rule.replace(/_/g, ' '))}</span>
              <div style="color: var(--ink-2); margin-top: 3px;">${escapeHTML(f.message)}</div>
            </div>
          `).join('')}
        </div>
      `).join('')}
    </div>

    <span class="label">Justification (required when submitting with flags)</span>
    <textarea class="field" id="flagJustify" rows="3"
      placeholder="e.g., 14-hr shift was a backfill deployment after the day-shift no-call no-show — confirmed with on-site Ops Mgr."></textarea>

    <div class="actions">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel — let me fix it</button>
      <button class="btn btn-warn" id="flagSubmitAnyway">Submit anyway →</button>
    </div>
  `, {
    onMount: (wrap) => {
      $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
      $('#flagSubmitAnyway', wrap).addEventListener('click', async () => {
        const note = $('#flagJustify', wrap).value.trim();
        if (!note) return toast('Justification is required when submitting with policy flags', 'err');
        try {
          await api(`/invoices/${invoice.id}/submit`, { method: 'POST', body: { notes: note } });
          toast(proxy ? 'Submitted ✓ — flags visible in your queue' : 'Submitted ✓ — Ops Mgr will see your justification', 'ok');
          closeSheet();
          if (proxy) { STATE.onBehalfOf = null; STATE.onBehalfOfName = null; goto('queue'); }
          else        goto('mine');
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

// v0.52 — Sheet: pick a custom period (up to 31 days) and a set of work orders,
// then create a draft invoice that pulls orphan time entries + expenses from
// those WOs in that range. Lets contractors bill bi-weekly or monthly when
// their cadence doesn't fit a Mon–Sun week.
async function openCustomPeriodSheet() {
  const wos = await api('/workorders');
  // Only show WOs the tech has actually touched recently or is assigned to;
  // hide cancelled ones to keep the list short.
  const available = wos.filter(w => w.status !== 'cancelled');

  // Defaults: last full calendar month
  const today = new Date();
  const firstOfThis = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastOfPrev  = new Date(firstOfThis.getTime() - 86400000);
  const firstOfPrev = new Date(lastOfPrev.getFullYear(), lastOfPrev.getMonth(), 1);
  const defStart = firstOfPrev.toISOString().slice(0,10);
  const defEnd   = lastOfPrev.toISOString().slice(0,10);
  const todayIso = today.toISOString().slice(0,10);
  // Track which WOs are selected. Default = all available (most common case
  // is "everything in this period", so opt-out is easier than opt-in).
  const picked = new Set(available.map(w => w.id));

  function html() {
    const allOn = picked.size === available.length;
    return `
      <h3>Create custom-period invoice</h3>
      <p class="help">Bill a stretch longer than one week (up to 31 days). We'll pull every untyped time entry and expense in this range from the work orders you select.</p>

      <div class="flex gap-12">
        <div style="flex:1;">
          <span class="label">Start date</span>
          <input class="field" id="cpStart" type="date" value="${defStart}" max="${todayIso}" />
        </div>
        <div style="flex:1;">
          <span class="label">End date</span>
          <input class="field" id="cpEnd" type="date" value="${defEnd}" max="${todayIso}" />
        </div>
      </div>
      <div class="help" id="cpDuration" style="margin: -6px 0 12px;">Period length will appear here.</div>

      <div class="flex between" style="align-items: center; margin-top: 4px;">
        <span class="label" style="margin: 0;">Work orders to include (${picked.size} of ${available.length})</span>
        <button class="btn btn-ghost btn-sm" id="cpToggleAll">${allOn ? 'Clear all' : 'Select all'}</button>
      </div>
      <div id="cpWoList" style="max-height: 260px; overflow-y: auto; border: 1px solid var(--line); border-radius: 10px; padding: 4px;">
        ${available.length === 0 ? `<div class="empty" style="padding: 14px;">No work orders found.</div>` : available.map(w => `
          <label class="cp-wo-row" style="display:flex; align-items:center; gap:10px; padding:8px 10px; border-bottom:1px solid var(--line); cursor:pointer;">
            <input type="checkbox" class="cp-wo-check" data-id="${w.id}" ${picked.has(w.id) ? 'checked' : ''} style="transform: scale(1.2);" />
            <div style="flex:1; min-width:0;">
              <div style="font-weight:600; font-size:13px;">${escapeHTML(w.external_id)} · ${escapeHTML(w.store_name || '')}</div>
              <div style="font-size:11px; color: var(--ink-2);">${sourceLabel(w.source_system)} · ${workTypeLabel(w.work_type)} · ${w.cart_count || 0} carts · ${escapeHTML((w.description || '').slice(0, 70))}</div>
            </div>
            <span class="badge ${w.status === 'in_progress' ? 'progress' : (w.status === 'completed' ? 'ok' : '')}" style="font-size: 9px;">${w.status}</span>
          </label>
        `).join('')}
      </div>

      <div class="actions" style="margin-top: 14px;">
        <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
        <button class="btn btn-primary" id="cpCreate">Create invoice draft &rarr;</button>
      </div>
    `;
  }

  showSheet(html(), {
    onMount: (wrap) => {
      function updateDuration() {
        const s = $('#cpStart', wrap).value;
        const e = $('#cpEnd', wrap).value;
        const out = $('#cpDuration', wrap);
        if (!s || !e) { out.textContent = 'Pick both dates.'; return; }
        if (e < s) { out.innerHTML = `<span style="color: var(--err-fg);">End must be on or after start.</span>`; return; }
        const days = Math.round((new Date(e) - new Date(s)) / 86400000) + 1;
        if (days > 31) { out.innerHTML = `<span style="color: var(--err-fg);">${days} days — over the 31-day cap.</span>`; return; }
        out.textContent = `${days} day${days === 1 ? '' : 's'} · ${Math.ceil(days/7)} week-equivalent${Math.ceil(days/7) === 1 ? '' : 's'}.`;
      }
      function rebindAll() {
        $$('[data-act="sheet-close"]', wrap).forEach(b => b.addEventListener('click', closeSheet));
        $('#cpStart', wrap).addEventListener('change', updateDuration);
        $('#cpEnd',   wrap).addEventListener('change', updateDuration);
        $$('.cp-wo-check', wrap).forEach(c => c.addEventListener('change', () => {
          const id = Number(c.dataset.id);
          if (c.checked) picked.add(id); else picked.delete(id);
          // Update the count label without a full re-render.
          const lbl = wrap.querySelector('.label[style*="margin: 0"]');
          if (lbl) lbl.textContent = `Work orders to include (${picked.size} of ${available.length})`;
          const tog = $('#cpToggleAll', wrap);
          if (tog) tog.textContent = (picked.size === available.length) ? 'Clear all' : 'Select all';
        }));
        $('#cpToggleAll', wrap).addEventListener('click', () => {
          if (picked.size === available.length) picked.clear();
          else available.forEach(w => picked.add(w.id));
          wrap.querySelector('.sheet').innerHTML = `<div class="sheet-handle"></div>${html()}`;
          rebindAll();
        });
        $('#cpCreate', wrap).addEventListener('click', async () => {
          const period_start = $('#cpStart', wrap).value;
          const period_end   = $('#cpEnd',   wrap).value;
          if (!period_start || !period_end) return toast('Pick both dates', 'err');
          if (period_end < period_start)    return toast('End must be on or after start', 'err');
          if (picked.size === 0)            return toast('Select at least one work order (or pick all)', 'err');
          const days = Math.round((new Date(period_end) - new Date(period_start)) / 86400000) + 1;
          if (days > 31) return toast('Period cannot exceed 31 days', 'err');
          try {
            // If the tech selected every WO, send empty array so the server
            // treats it as "all WOs" — keeps the call idempotent if WOs change.
            const work_order_ids = picked.size === available.length ? [] : [...picked];
            const r = await api('/invoices/custom-period', { method: 'POST', body: { period_start, period_end, work_order_ids } });
            const att = r.attached || { time_entries: 0, expenses: 0 };
            toast(`Draft created · ${att.time_entries} time entries, ${att.expenses} expenses attached`, 'ok');
            closeSheet();
            goto('invDetail', r.invoice.id);
          } catch (e) { toast(e.message, 'err'); }
        });
      }
      rebindAll();
      updateDuration();
    },
  });
}

// Sheet: pick a past week, create a draft invoice for it
function openPastInvoiceSheet() {
  // Default to last week
  const lastWeekMon = new Date();
  lastWeekMon.setDate(lastWeekMon.getDate() - (lastWeekMon.getDay() === 0 ? 13 : lastWeekMon.getDay() + 6));
  const defaultDate = lastWeekMon.toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  showSheet(`
    <h3>Create invoice for past week</h3>
    <p class="help">Pick any date in the week you want to create an invoice for. The invoice will cover the Mon–Sun containing that date. Add time entries via "Log a past shift" on the Timer tab.</p>
    <span class="label">Any date in the target week</span>
    <input class="field" id="pastWeekDate" type="date" value="${defaultDate}" max="${today}" />
    <div class="actions">
      <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
      <button class="btn btn-primary" id="createPastInv">Create draft invoice</button>
    </div>
  `, {
    onMount: (wrap) => {
      $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);
      $('#createPastInv', wrap).addEventListener('click', async () => {
        const d = $('#pastWeekDate', wrap).value;
        if (!d) return toast('Pick a date', 'err');
        try {
          const r = await api('/invoices/for-week', { method: 'POST', body: { week_of: d } });
          toast(`Draft created: ${r.invoice.invoice_number}`, 'ok');
          closeSheet();
          goto('invDetail', r.invoice.id);
        } catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

// ---- INVOICE DETAIL / PREVIEW (contractor-style) ----
async function renderInvoiceDetail(root, invoiceId) {
  if (!invoiceId) return goto('mine');

  const [r, list, notices, addReqs] = await Promise.all([
    api(`/invoices/${invoiceId}`),
    api('/invoices').catch(() => []),    // managers may not have a personal invoice list
    api(`/invoices/${invoiceId}/notices`).catch(() => []),   // v0.64.3 — manager edit notices
    api(`/invoices/${invoiceId}/addition-requests`).catch(() => []),   // v0.68 — add-WO requests
  ]);
  const { invoice, lines, summary, by_date = [], extracted = null, extracted_at = null, tech_user = null } = r;
  const me = STATE.user;
  const isManagerProxy = STATE.onBehalfOf && STATE.onBehalfOf === invoice.user_id;
  const isManagerView  = ['ops_manager','sr_manager','pm'].includes(me.role) && invoice.user_id !== me.id;
  // The contractor invoice's "bill from" header always reflects the tech the
  // invoice belongs to (not the viewer). When a manager opens a tech's
  // invoice, the header shows the tech's name/address — never the manager's.
  const billFrom = tech_user || me;

  // v0.68 — "Add work orders to this already-submitted week". The owning tech
  // can file a request on a locked (post-draft) tech-labor invoice; everyone who
  // can see the invoice sees the request history + the manager's decision.
  const canRequestAddWo = invoice.user_id === me.id
    && invoice.invoice_type !== 'vendor'
    && ['submitted','in_review','approved_ops','approved_sr','queued_ap','sent_ap'].includes(invoice.status);
  const addWoCardHTML = (canRequestAddWo || (addReqs && addReqs.length)) ? `
    <div class="card" style="margin-top: 14px; border-left: 4px solid var(--ic-orange);">
      <div class="section-title" style="margin-top: 0;">Add work orders to this week</div>
      ${canRequestAddWo ? `
        <p class="help" style="margin: 0 0 10px;">This invoice is already submitted, so it's locked. Missed some work orders for this week (${fmtDate(invoice.period_start)} → ${fmtDate(invoice.period_end)})? Request to add them — your Ops Manager reviews it, and if approved a new invoice is created for this same week with those work orders.</p>
        <button class="btn btn-warn btn-block" id="reqAddWoBtn">＋ Request to add work orders</button>
      ` : ''}
      ${(addReqs && addReqs.length) ? `
        <div class="section-title" style="font-size: 12px;">Requests</div>
        ${addReqs.map(rq => addReqStatusHTML(rq)).join('')}
      ` : ''}
    </div>
  ` : '';

  // prev/next ordering — newest first. v0.54: when the viewer is on a draft
  // ("open") invoice, scope the prev/next to other drafts the tech still has
  // open, so they can quickly hop between multiple in-progress invoices
  // (current week, past-week backfill, custom period, etc.). On a submitted
  // / approved / paid invoice we fall back to the full chronological list so
  // historical browsing still works.
  const navList = invoice.status === 'draft'
    ? list.filter(i => i.status === 'draft')
    : list;
  const idx = navList.findIndex(i => i.id === invoice.id);
  const newer = idx > 0 ? navList[idx - 1] : null;
  const older = idx >= 0 && idx < navList.length - 1 ? navList[idx + 1] : null;

  // Roll up by-day rows from the API response into the contractor format.
  // Each by_date row already carries time_entries[] + expense_entries[], so we
  // can render multi-line "details" cells exactly like the John Brennan invoice.
  const totalLabor    = summary.labor_amount;
  const totalMiles    = (by_date || []).reduce((s, d) => {
    return s + (d.expense_entries || []).filter(e => e.category === 'mileage').reduce((a, e) => a + (e.quantity || 0), 0);
  }, 0);
  const mileageRate   = 0.725;
  const totalMileage  = totalMiles * mileageRate;
  const totalDrive    = +(summary.drive_amount || 0).toFixed(2);
  const totalOther    = +(summary.total - totalLabor - totalDrive - totalMileage).toFixed(2);
  const grandTotal    = summary.total;

  // v0.64.4 — two-page review: snapshot the invoice "as submitted" the FIRST
  // time a manager opens it, so edits don't overwrite the left-hand reference.
  const isMgrReview = invoice.invoice_type !== 'vendor' && isManagerView && !isManagerProxy
    && ['draft','submitted','in_review'].includes(invoice.status);
  if (isMgrReview) {
    STATE._invBaseline = STATE._invBaseline || {};
    if (!STATE._invBaseline[invoiceId]) {
      STATE._invBaseline[invoiceId] = { by_date: JSON.parse(JSON.stringify(by_date)), total: grandTotal };
    }
  }
  const baseline = isMgrReview ? STATE._invBaseline[invoiceId] : null;

  // Day rows for the main line table — one row per day even if no work
  // (matches the contractor convention of showing the whole week).
  const allDays = enumerateWeekDays(invoice.period_start, invoice.period_end);
  const dayMap = {};
  for (const d of by_date) dayMap[d.date] = d;

  // Mileage report data — group expense_entries[category=mileage] by date with the WO/store as the "stop"
  const mileageByDay = (by_date || []).map(d => ({
    date: d.date,
    stops: (d.expense_entries || [])
      .filter(e => e.category === 'mileage')
      .map(e => ({ store: e.store_name || e.external_id, miles: e.quantity || 0, amount: e.amount || 0, desc: e.description || '' })),
  })).filter(d => d.stops.length > 0);

  root.innerHTML = `
    ${notices && notices.length ? `
      <div style="margin-bottom:12px;background:#eef4ff;border:1px solid #b9d0ff;border-radius:8px;padding:10px 12px;">
        <div style="font-weight:600;font-size:13px;margin-bottom:4px;">ℹ️ ${notices.length} manager edit${notices.length === 1 ? '' : 's'} on this invoice</div>
        <div style="font-size:12px;color:var(--secondary-text);line-height:1.5;">${notices.slice(0, 3).map(n => escapeHTML(n.body)).join('<br>')}</div>
        <div style="font-size:11px;color:var(--secondary-text);margin-top:4px;">Informational — no action needed unless the invoice is rejected and returned for resubmission.</div>
      </div>` : ''}
    ${isManagerProxy ? `
      <div class="alert warn" style="margin-bottom: 12px;">
        <span class="ico">✏️</span>
        <div class="body">
          <strong>Editing on behalf of ${escapeHTML(STATE.onBehalfOfName || 'tech')}.</strong>
          New time entries and expenses will be saved to their account. The original file is attached to this invoice for reference.
        </div>
        <button class="close" id="exitProxy">Exit</button>
      </div>
    ` : ''}
    ${navList.length > 1 ? `
      <div class="flex between" style="margin-bottom:8px; align-items: center;">
        <button class="btn btn-ghost btn-sm" id="prevInv" ${!newer ? 'disabled' : ''}>‹ Newer</button>
        <span style="font-size:11px; color:var(--muted)">
          ${invoice.status === 'draft' ? `Open invoice ${idx + 1} of ${navList.length}` : `${idx + 1} of ${navList.length}`}
        </span>
        <button class="btn btn-ghost btn-sm" id="nextInv" ${!older ? 'disabled' : ''}>Older ›</button>
      </div>
    ` : ''}

    <!-- v0.58 — Top-of-page policy-engine flag banner. As soon as a draft
         (or submitted invoice in review) trips any custom rule, every role
         that opens the invoice sees the full violation list right at the
         top instead of having to scan each WO line for the inline badge. -->
    ${(summary?.flag_count > 0 && lines?.some(l => l.flags?.length)) ? (() => {
      const allFlags = lines.flatMap(l => (l.flags || []).map(f => ({ ...f, wo: l.external_id, store: l.store_name })));
      return `
        <div class="card" style="margin-bottom: 14px; background: var(--err-bg); color: var(--err-fg); border: 0; border-left: 4px solid var(--err-fg); padding: 14px 16px;">
          <div style="font-size: 13px; font-weight: 800; margin-bottom: 6px;">
            ⚠ ${summary.flag_count} policy violation${summary.flag_count === 1 ? '' : 's'} on this invoice
          </div>
          <p class="help" style="color: var(--err-fg); margin: 0 0 10px; font-size: 12px;">
            ${invoice.status === 'draft'
              ? 'Fix or justify before submitting. Lines below show the specific rule violations.'
              : invoice.status === 'submitted'
              ? 'Ops Mgr review required. Approve only if violations are acceptable; otherwise reject or escalate.'
              : 'Captured at submission time. Visible for audit.'}
          </p>
          <details>
            <summary style="cursor: pointer; font-size: 12px; font-weight: 700; color: var(--err-fg);">View all violations</summary>
            <div style="margin-top: 10px; display: flex; flex-direction: column; gap: 6px;">
              ${allFlags.map(f => `
                <div style="background: #fff; border-radius: 6px; padding: 8px 10px; font-size: 12px; color: var(--ink);">
                  <strong style="color: var(--err-fg);">${escapeHTML(f.rule.replace(/_/g, ' '))}</strong>
                  <span style="color: var(--muted); margin-left: 6px;">${escapeHTML(f.wo)}${f.store ? ' · ' + escapeHTML(f.store) : ''}</span>
                  <div style="margin-top: 3px;">${escapeHTML(f.message)}</div>
                </div>
              `).join('')}
            </div>
          </details>
        </div>
      `;
    })() : ''}

    <!-- v0.56 — Top-of-page Send-to-AP banner. As soon as Ops Mgr approves
         (status=approved_ops, or Sr Mgr countersign=approved_sr), the tech
         sees a prominent "ready to send" card with the action button right
         here, instead of having to scroll past the entire invoice doc to
         find it. The existing card lower on the page still renders for the
         workflow context. -->
    ${readyToSendToAp(invoice) && (
        invoice.user_id === me.id ||
        ['sr_manager','pm'].includes(me.role) ||
        (me.role === 'ops_manager' && isManagerView)
      ) ? `
      <div class="card" style="margin-bottom: 14px; background: linear-gradient(135deg, #fff8e7 0%, #fff 80%); border: 0; border-left: 4px solid var(--ic-orange); padding: 16px;">
        <div class="flex between" style="align-items: center; gap: 12px;">
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 13px; font-weight: 700; color: var(--ic-green-deep);">
              ✅ ${invoice.status === 'approved_sr' ? 'Approved — verify & send to AP' : 'Ops Mgr approved — verify & send to AP'}
            </div>
            <div style="font-size: 12px; color: var(--ink-2); margin-top: 4px;">
              ${invoice.user_id === me.id
                ? 'Review the details below, then send to Accounts Payable — we generate the PDF and email it for you.'
                : 'Hand-off ready. Verify the details, then send the PDF to AP.'}
            </div>
          </div>
          <button class="btn btn-warn" id="sendToApBtnTop" style="flex-shrink: 0;">📧 Send to AP →</button>
        </div>
      </div>
    ` : ''}

    <!-- ===== Page 1: Invoice ===== -->
    ${invoice.invoice_type === 'vendor' ? (() => {
      // v0.43 — pull line items from the parsed PDF summary so we can
      // render an invoice-style itemized table (mirrors the field-tech
      // invoice view).
      let extractedLineItems = [];
      try {
        const ext = invoice.extracted_summary ? JSON.parse(invoice.extracted_summary) : null;
        if (ext && Array.isArray(ext.line_items)) extractedLineItems = ext.line_items;
      } catch (_) {}
      const linesSubtotal = extractedLineItems.reduce((s, li) => s + (li.amount || 0), 0);
      const linesMatch = Math.abs(linesSubtotal - (invoice.total || 0)) < 0.5;

      return `
      <!-- v0.43 — vendor invoice header + itemized line-item table -->
      <div class="invoice-doc">
        <div class="inv-head">
          <div class="inv-from">
            <div class="inv-row"><div class="inv-label">Vendor</div><div><strong>${escapeHTML(invoice.vendor_name || '— missing —')}</strong></div></div>
            <div class="inv-row"><div class="inv-label">Vendor invoice #</div><div>${escapeHTML(invoice.vendor_invoice_number || '— missing —')}</div></div>
            <div class="inv-row"><div class="inv-label">Invoice date</div><div>${escapeHTML(invoice.vendor_invoice_date || '— missing —')}</div></div>
            ${invoice.vendor_category ? `<div class="inv-row"><div class="inv-label">Category</div><div><span class="badge" style="background: var(--ic-cream); color: var(--ic-green-deep); padding: 2px 8px;">${escapeHTML(capitalize(invoice.vendor_category))}</span></div></div>` : ''}
            <div class="inv-row"><div class="inv-label">Filed by</div><div>${escapeHTML(STATE.user.id === invoice.created_by ? 'You' : 'Ops Manager')}</div></div>
            <div class="inv-row"><div class="inv-label">Bill to</div><div>Maplebear Inc. dba Instacart<br><span style="font-size:11px;color:var(--muted);">50 Beale St, Suite 600, San Francisco CA 94105</span></div></div>
          </div>
          <div class="inv-num">
            <div class="inv-num-tag" style="background: #1A56B0;">VENDOR INVOICE</div>
            <div class="inv-num-date">${fmtDate(invoice.vendor_invoice_date || invoice.period_end)}</div>
            ${invoice.extracted_at ? `<div style="font-size: 10px; color: var(--ic-green-deep); margin-top: 6px;">📄 Auto-parsed</div>` : ''}
          </div>
        </div>

        <!-- Line items table — same look as the contractor invoice -->
        ${extractedLineItems.length > 0 ? `
          <table class="inv-table" style="width: 100%; border-collapse: collapse; font-size: 12px;">
            <thead>
              <tr style="background: #f4f5f7; text-align: left;">
                <th style="padding: 8px 12px;">Date</th>
                <th style="padding: 8px 12px;">Reference #</th>
                <th style="padding: 8px 12px;">Description</th>
                ${extractedLineItems.some(li => li.qty != null) ? `<th style="padding: 8px 12px; text-align: right;">Qty</th>` : ''}
                ${extractedLineItems.some(li => li.unit_price != null) ? `<th style="padding: 8px 12px; text-align: right;">Unit price</th>` : ''}
                <th style="padding: 8px 12px; text-align: right;">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${extractedLineItems.map(li => `
                <tr style="border-top: 1px solid var(--line);">
                  <td style="padding: 8px 12px; color: var(--ink-2); white-space: nowrap;">${li.date ? fmtDate(li.date) : '—'}</td>
                  <td style="padding: 8px 12px; font-family: monospace; font-size: 11px;">${escapeHTML(li.reference || '—')}</td>
                  <td style="padding: 8px 12px;">${escapeHTML(li.description || '')}</td>
                  ${extractedLineItems.some(x => x.qty != null) ? `<td style="padding: 8px 12px; text-align: right;">${li.qty != null ? li.qty : ''}</td>` : ''}
                  ${extractedLineItems.some(x => x.unit_price != null) ? `<td style="padding: 8px 12px; text-align: right;">${li.unit_price != null ? fmt$(li.unit_price) : ''}</td>` : ''}
                  <td style="padding: 8px 12px; text-align: right; font-weight: 600;">${fmt$(li.amount || 0)}</td>
                </tr>
              `).join('')}
              <tr style="background: #fafbfc; border-top: 2px solid var(--line); font-size: 12px;">
                <td colspan="${3 + (extractedLineItems.some(li => li.qty != null) ? 1 : 0) + (extractedLineItems.some(li => li.unit_price != null) ? 1 : 0)}" style="padding: 8px 12px; text-align: right; color: var(--ink-2);">
                  Subtotal (${extractedLineItems.length} line item${extractedLineItems.length === 1 ? '' : 's'})
                </td>
                <td style="padding: 8px 12px; text-align: right; font-weight: 700;">${fmt$(linesSubtotal)}</td>
              </tr>
              ${!linesMatch ? `
                <tr style="background: #fff8e8; font-size: 11px; color: var(--ic-orange);">
                  <td colspan="${3 + (extractedLineItems.some(li => li.qty != null) ? 1 : 0) + (extractedLineItems.some(li => li.unit_price != null) ? 1 : 0) + 1}" style="padding: 8px 12px;">
                    ⚠ Subtotal of parsed line items (${fmt$(linesSubtotal)}) doesn't match the invoice total (${fmt$(invoice.total)}). The PDF likely has additional fees / taxes / past-due balances rolled in. Review the attached file.
                  </td>
                </tr>
              ` : ''}
            </tbody>
          </table>
        ` : `
          <div style="padding: 18px 20px; background: #fafbfc; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--muted);">
            <strong>No line items detected in this PDF.</strong> The total below is what the Ops Manager confirmed during upload — review the attached file for the full breakdown.
          </div>
        `}

        <div class="inv-billto-row" style="padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; background: #f4faf6;">
          <div>
            <div style="font-size: 11px; color: var(--ic-green-deep); text-transform: uppercase; letter-spacing: 0.6px; font-weight: 700;">Total Due</div>
            ${extractedLineItems.length > 0 ? `<div style="font-size: 11px; color: var(--muted); margin-top: 2px;">From PDF · ${extractedLineItems.length} line item${extractedLineItems.length === 1 ? '' : 's'}</div>` : ''}
          </div>
          <div style="font-size: 36px; font-weight: 800; color: var(--ic-green-deep);">${fmt$(invoice.total)}</div>
        </div>

        ${invoice.notes ? `
          <div style="padding: 12px 20px; border-top: 1px solid var(--line); font-size: 13px; color: var(--ink-2); line-height: 1.5; font-style: italic;">
            <strong style="font-style: normal; color: var(--ink);">Notes:</strong> ${escapeHTML(invoice.notes)}
          </div>
        ` : ''}
      </div>

      ${(r.attachments || []).length ? `
        <div class="invoice-doc" style="margin-top: 14px;">
          <div style="font-size: 14px; font-weight: 700; padding: 10px 14px; background: #f4f5f7; border-bottom: 1px solid var(--line);">
            Original vendor invoice file
          </div>
          <div style="padding: 14px;">
            <div class="gallery">
              ${r.attachments.map(a => galleryThumbHTML(a, 'Vendor invoice')).join('')}
            </div>
          </div>
        </div>
      ` : ''}
    `;
    })() : ''}

    <div class="invoice-doc"${invoice.invoice_type === 'vendor' ? ' style="display:none;"' : ''}>
      <div class="inv-head">
        <div class="inv-from">
          <div class="inv-row"><div class="inv-label">Full Name</div><div><strong>${escapeHTML(billFrom.name)}</strong></div></div>
          <div class="inv-row"><div class="inv-label">Home Address</div><div>${escapeHTML(billFrom.home_address || '— set in Settings —')}</div></div>
          <div class="inv-row"><div class="inv-label">Phone Number</div><div>${escapeHTML(billFrom.home_phone || '— set in Settings —')}</div></div>
        </div>
        <div class="inv-num">
          <div class="inv-num-tag">INVOICE #${escapeHTML(invoice.invoice_number.replace(/\D/g,'').slice(-4) || invoice.id)}</div>
          <div class="inv-num-date">${fmtDate(invoice.period_end)}</div>
        </div>
      </div>

      <div class="inv-billto-row">
        <div class="inv-billto">
          <div class="inv-billto-label">Invoice To:</div>
          <div><strong>Instacart, Inc.</strong></div>
          <div>Hardware Operations Caper — AP</div>
          <div>50 Beale St</div>
          <div>San Francisco, CA 94105</div>
        </div>
        <div class="inv-for">
          <div class="inv-for-label">FOR</div>
          <div>Hourly Services</div>
        </div>
      </div>

      <table class="inv-table">
        <thead>
          <tr>
            <th>Date</th><th>Details / Purpose</th>
            <th class="r">Start</th><th class="r">End</th><th class="r">Hours</th><th class="r">Rate</th><th class="r">AMOUNT</th>
          </tr>
        </thead>
        <tbody>
          ${allDays.map(date => {
            const day = dayMap[date];
            if (!day || (!day.time_entries.length && !day.expense_entries.length)) {
              return `
                <tr class="inv-empty-row">
                  <td>${fmtShortDate(date)}</td><td></td>
                  <td class="r"></td><td class="r"></td>
                  <td class="r"><strong>0.00</strong></td>
                  <td class="r">$${(invoice.hourly_rate || 40).toFixed(2)}</td>
                  <td class="r amt-zero">$0.00</td>
                </tr>`;
            }
            // For each labor row of this day produce a multi-line cell with WO meta + retailer + location + notes.
            // v0.62.2 — labor (and drive) can be entered EITHER as time entries
            // (Timer flow) OR as expenses with category='labor'/'drive' (Add
            // Expense flow). Both contribute to summary.labor_hours, so both
            // need to appear as rows here or the totals won't reconcile.
            const laborExpRows = (day.expense_entries || [])
              .filter(e => e.category === 'labor' || e.category === 'drive')
              .map(e => ({
                _from_expense: true,
                id:           'exp-' + e.id,
                external_id:  e.external_id,
                store_name:   e.store_name,
                work_type:    e.work_type,
                clock_in:     e.expense_date, // for sort + date column
                clock_out:    null,
                hours:        Number(e.quantity || 0),
                notes:        e.description || '',
                mode:         e.category === 'drive' ? 'drive' : 'work',
              }));
            const allEntries = [
              ...day.time_entries,
              ...(day.drive_entries || []),
              ...laborExpRows,
            ].sort((a, b) => new Date(a.clock_in || 0) - new Date(b.clock_in || 0));
            return allEntries.map(t => {
              const start = t._from_expense ? '' : (t.clock_in  ? new Date(t.clock_in ).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) : '');
              const end   = t._from_expense ? '' : (t.clock_out ? new Date(t.clock_out).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) : '');
              const isDrive = t.mode === 'drive';
              const wtTag   = t._from_expense
                ? (isDrive ? '[🚗 Drive · logged]' : `[${workTypeLabel(t.work_type || 'labor')} · logged]`)
                : (isDrive ? '[🚗 Drive]' : `[${workTypeLabel(t.work_type)}]`);
              const meta    = `[${fmtMonthDay(t.clock_in || date)}] ${wtTag} ${t.external_id}`;
              return `
                <tr ${isDrive ? 'class="inv-drive-row"' : ''}>
                  <td>${fmtShortDate(date)}</td>
                  <td class="inv-details">
                    <div class="inv-meta">${escapeHTML(meta)}</div>
                    ${t.store_name ? `<div><strong>Retailer:</strong> ${escapeHTML(t.store_name)}</div>` : ''}
                    ${t.notes ? `<div class="inv-notes">${escapeHTML(t.notes)}</div>` : ''}
                  </td>
                  <td class="r">${escapeHTML(start) || '—'}</td>
                  <td class="r">${escapeHTML(end)   || '—'}</td>
                  <td class="r"><strong>${t.hours.toFixed(2)}</strong></td>
                  <td class="r">$${(invoice.hourly_rate || 40).toFixed(2)}</td>
                  <td class="r amt-pos">${fmt$(+((t.hours || 0) * (invoice.hourly_rate || 40)).toFixed(2))}</td>
                </tr>`;
            }).join('');
          }).join('')}

          <tr class="inv-totals-row">
            <td colspan="4" class="inv-totals-label">Total Work Hours</td>
            <td class="r"><strong>${summary.labor_hours.toFixed(2)}</strong></td>
            <td class="r inv-subtotal-cell">SUBTOTAL</td>
            <td class="r amt-total">${fmt$(totalLabor)}</td>
          </tr>
          ${summary.drive_hours > 0 ? `
            <tr style="background: #fff8f0;">
              <td colspan="4" style="text-align: right; padding: 4px; color: var(--ic-orange); font-weight: 600;">Total Drive Hours <span style="color: var(--muted); font-weight: 400; font-size: 9px;">(billable · tracked separately)</span></td>
              <td class="r" style="color: var(--ic-orange);"><strong>${summary.drive_hours.toFixed(2)}</strong></td>
              <td class="r inv-subtotal-cell">SUBTOTAL</td>
              <td class="r amt-total">${fmt$(totalDrive)}</td>
            </tr>
          ` : ''}
          ${totalMiles > 0 ? `
            <tr>
              <td>Miles Driven</td><td></td><td></td><td class="r">${totalMiles.toFixed(0)}</td><td></td>
              <td class="r inv-subtotal-cell">Mileage</td>
              <td class="r amt-pos">${fmt$(totalMileage)}</td>
            </tr>
          ` : ''}
          ${totalOther > 0.005 ? `
            <tr>
              <td colspan="5"></td>
              <td class="r inv-subtotal-cell">Other</td>
              <td class="r amt-pos">${fmt$(totalOther)}</td>
            </tr>
          ` : ''}
          <tr class="inv-grand-row">
            <td colspan="5"></td>
            <td class="r"><strong>TOTAL</strong></td>
            <td class="r amt-grand">${fmt$(grandTotal)}</td>
          </tr>
        </tbody>
      </table>

      <div class="inv-footer">
        <div>Payable in USD to <strong>${escapeHTML(billFrom.name)}</strong></div>
        <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">If you have any questions concerning this invoice, use the following contact information:</div>
        <div style="margin-top: 4px;"><strong>Email:</strong> ${escapeHTML(billFrom.email)}${billFrom.home_phone ? ` · <strong>Mobile:</strong> ${escapeHTML(billFrom.home_phone)}` : ''}</div>
      </div>
    </div>

    ${mileageByDay.length > 0 ? `
      <div class="invoice-doc" style="margin-top: 18px;">
        <div class="mileage-header">
          <div class="mileage-title">MILEAGE REIMBURSEMENT REPORT</div>
          <div class="mileage-sub">${escapeHTML(me.name)} · Invoice ${invoice.invoice_number} · ${fmtDate(invoice.period_start)} – ${fmtDate(invoice.period_end)} · Rate: $${mileageRate.toFixed(3)} / mile</div>
        </div>
        ${mileageByDay.map(d => {
          const dayTotalMi  = d.stops.reduce((s, x) => s + x.miles,  0);
          const dayTotalAmt = d.stops.reduce((s, x) => s + x.amount, 0);
          return `
            <div class="mileage-day-band">
              <div>${fmtLongDate(d.date)}</div>
              <div>Total: ${dayTotalMi.toFixed(1)} mi · ${fmt$(dayTotalAmt)}</div>
            </div>
            <table class="mileage-table">
              ${me.home_address ? `
                <tr class="mileage-start"><td class="m-icon">■ START</td><td>${escapeHTML(me.home_address)}</td><td class="r">—</td><td class="r">—</td></tr>
              ` : ''}
              ${d.stops.map((s, i) => `
                <tr>
                  <td class="m-icon stop">■ Stop ${i + 1}</td>
                  <td><strong>${escapeHTML(s.store)}</strong>${s.desc ? `<div style="font-size:10px; color:var(--muted)">${escapeHTML(s.desc)}</div>` : ''}</td>
                  <td class="r"><strong>${s.miles.toFixed(1)}</strong></td>
                  <td class="r"><strong>${fmt$(s.amount)}</strong></td>
                </tr>
              `).join('')}
              ${me.home_address ? `
                <tr class="mileage-end"><td class="m-icon">■ END</td><td>${escapeHTML(me.home_address)}</td><td class="r">—</td><td class="r">—</td></tr>
              ` : ''}
            </table>
          `;
        }).join('')}
        <div class="mileage-total-band">
          <div>TOTAL MILEAGE &amp; REIMBURSEMENT</div>
          <div><strong>${totalMiles.toFixed(1)} miles</strong> × $${mileageRate.toFixed(3)} = <strong>${fmt$(totalMileage)}</strong></div>
        </div>
      </div>
    ` : ''}

    ${(() => {
      // v0.59 — Itemized expense receipts table. Shows each expense line on
      // the invoice with the attached image rendered inline, so the summary
      // view tells you at a glance which receipt belongs to which line.
      // Mileage rows are intentionally excluded (they already have their own
      // mileage reimbursement report above).
      if (invoice.invoice_type === 'vendor') return '';
      const expRows = (by_date || []).flatMap(d =>
        (d.expense_entries || [])
          .filter(e => e.category !== 'mileage' && e.category !== 'labor' && e.category !== 'drive')
          .map(e => ({ ...e, date: d.date }))
      );
      if (!expRows.length) return '';
      return `
        <div class="invoice-doc" style="margin-top: 18px;">
          <div style="font-size: 14px; font-weight: 700; padding: 10px 14px; background: #f4f5f7; border-bottom: 1px solid var(--line);">
            Expense receipts (${expRows.length})
          </div>
          <table class="inv-table" style="width:100%;">
            <thead>
              <tr>
                <th>Date</th>
                <th>Category</th>
                <th>Description</th>
                <th>Receipt</th>
                <th class="r">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${expRows.map(e => {
                const cat = capitalize(e.category || '') + (e.subcategory ? ` · ${escapeHTML(e.subcategory)}` : '');
                const atts = Array.isArray(e.attachments) ? e.attachments : [];
                const thumbCell = atts.length
                  ? `<div class="exp-thumbs">${atts.map(thumbInlineHTML).join('')}</div>`
                  : `<span style="color: var(--muted); font-size: 11px;">— no receipt —</span>`;
                return `
                  <tr>
                    <td>${fmtShortDate(e.date)}</td>
                    <td>${cat}${e.external_id ? `<div class="inv-meta">${escapeHTML(e.external_id)}</div>` : ''}</td>
                    <td class="inv-details">${e.description ? escapeHTML(e.description) : '<span style="color:var(--muted);">—</span>'}${e.store_name ? `<div class="inv-meta">${escapeHTML(e.store_name)}</div>` : ''}</td>
                    <td>${thumbCell}</td>
                    <td class="r amt-pos">${fmt$(e.amount || 0)}</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    })()}

    ${(r.attachments || []).length && invoice.invoice_type !== 'vendor' ? `
      <div class="invoice-doc" style="margin-top: 18px;">
        <div style="font-size: 14px; font-weight: 700; padding: 10px 14px; background: #f4f5f7; border-bottom: 1px solid var(--line);">
          Attached Receipts &amp; Documents (${r.attachments.length})
        </div>
        <div style="padding: 14px;">
          <div class="gallery">
            ${r.attachments.map(a => {
              const ctx = a.expense_category
                ? `${capitalize(a.expense_category)} · ${fmt$(a.expense_amount || 0)}`
                : (a.time_entry_id ? 'Time' : 'Invoice');
              return galleryThumbHTML(a, ctx);
            }).join('')}
          </div>
          <div style="font-size: 10px; color: var(--muted); margin-top: 8px;">Tap any thumbnail to view full file.</div>
        </div>
      </div>
    ` : ''}

    ${invoice.notes && invoice.invoice_type !== 'vendor' ? `
      <div class="card" style="margin-top: 14px;">
        <div class="label">Justification / Notes</div>
        <div style="font-size:13px; line-height: 1.5;">${escapeHTML(invoice.notes)}</div>
      </div>
    ` : ''}

    <div class="section-title">Approval trail</div>
    <div class="card">
      <div class="trail">${trailFor(invoice)}</div>
    </div>

    ${addWoCardHTML}

    ${invoice.status === 'draft' && extracted && invoice.invoice_type !== 'vendor'
       && (invoice.user_id === me.id || isManagerProxy || isManagerView)
       ? renderExtractedPanel(invoice, extracted, extracted_at, summary) : ''}

    ${invoice.invoice_type === 'vendor' && invoice.status === 'draft' &&
      (me.id === invoice.user_id || ['sr_manager','pm'].includes(me.role)) ? (() => {
        // v0.39 — flag any required field that's still missing so the
        // user can see at a glance what they need to fix before submit.
        const ext = (() => { try { return invoice.extracted_summary ? JSON.parse(invoice.extracted_summary) : null; } catch (_) { return null; } })();
        const wasExtracted = !!invoice.extracted_at;
        const missing = [];
        if (!invoice.vendor_name)           missing.push('Vendor name');
        if (!invoice.vendor_invoice_number) missing.push('Invoice #');
        if (!invoice.vendor_invoice_date)   missing.push('Invoice date');
        if (!(invoice.total > 0))           missing.push('Total');
        return `
      <!-- v0.38 — vendor draft preview / edit / submit panel -->
      <div class="card" style="margin-top: 14px; border-left: 4px solid var(--ic-orange); background: #fff8f0;">
        <div class="section-title" style="margin-top: 0;">📝 Draft preview · review before submitting to Sr Mgr</div>

        ${wasExtracted ? `
          <div class="card" style="background: #ecfaf2; border-left: 4px solid var(--ic-green-deep); padding: 10px 14px; margin-bottom: 12px; font-size: 13px;">
            <strong>📄 Auto-parsed from PDF</strong> · extracted ${new Date(invoice.extracted_at).toLocaleString()}
            <div style="margin-top: 6px; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; font-size: 12px;">
              <div>Vendor: <code>${ext?.vendor_name ? escapeHTML(ext.vendor_name) : '<em style="color: var(--muted);">not detected</em>'}</code></div>
              <div>Invoice #: <code>${ext?.vendor_invoice_number ? escapeHTML(ext.vendor_invoice_number) : '<em style="color: var(--muted);">not detected</em>'}</code></div>
              <div>Date: <code>${ext?.vendor_invoice_date ? escapeHTML(ext.vendor_invoice_date) : '<em style="color: var(--muted);">not detected</em>'}</code></div>
              <div>Total: <code>${ext?.total ? fmt$(ext.total) : '<em style="color: var(--muted);">not detected</em>'}</code></div>
            </div>
          </div>
        ` : ''}

        ${missing.length ? `
          <div class="alert warn" style="margin-bottom: 12px;">
            <span class="ico">⚠</span>
            <div class="body">
              <strong>${missing.length} field${missing.length === 1 ? '' : 's'} still need${missing.length === 1 ? 's' : ''} attention:</strong> ${missing.join(', ')}.
              Tap <em>Edit vendor details</em> to fill them in before submitting.
            </div>
          </div>
        ` : ''}

        <p class="help" style="margin-bottom: 12px;">Confirm the vendor name, invoice number, date, and total against the attached PDF above. Edit anything that needs fixing. When everything matches, click <strong>Submit to Sr Mgr</strong>.</p>
        <button class="btn btn-ghost btn-block" id="vendorEditBtn" style="margin-bottom: 8px;">✏️ Edit vendor details (name, #, date, total, notes)</button>
        <div class="flex gap-12" style="margin-top: 8px;">
          <button class="btn btn-danger" style="flex:1;" id="vendorDiscardBtn">🗑 Discard draft</button>
          <button class="btn btn-primary" style="flex:2;" id="vendorSubmitBtn" ${missing.length ? 'disabled title="Fill in missing fields first"' : ''}>Submit to Sr Mgr →</button>
        </div>
      </div>
    `; })() : ''}

    ${invoice.invoice_type === 'vendor' && invoice.status === 'submitted' &&
      ['sr_manager','pm'].includes(me.role) ? `
      <div class="card" style="margin-top: 14px; border-left: 4px solid var(--ic-green); padding: 16px;">
        <strong>Senior Manager review · vendor invoice</strong>
        <p class="help" style="margin: 6px 0 12px;">This 3rd-party vendor invoice was filed by ${escapeHTML(invoice.user_id === me.id ? 'you' : 'an Ops Mgr')}. Approve to mark ready-for-AP, or reject back to the uploader.</p>
        <div class="actions" style="flex-wrap: wrap;">
          <button class="btn btn-danger" id="rejectBtn">Reject</button>
          <button class="btn btn-primary" id="approveBtn">Approve vendor invoice</button>
        </div>
      </div>
    ` : ''}

    ${invoice.invoice_type !== 'vendor' && invoice.status === 'draft' && (me.role === 'technician' || isManagerProxy) ? `
      ${renderEditableLineItems(by_date, invoice)}
      <div class="card" style="margin-top: 14px;">
        <div class="section-title" style="margin-top: 0;">Edit this draft invoice</div>
        <button class="btn btn-ghost btn-block" id="addExpProxy" style="margin-bottom: 8px;">＋ Add an expense</button>
        <button class="btn btn-ghost btn-block" id="addTimeProxy" style="margin-bottom: 8px;">＋ Add a time entry (manual)</button>
        <button class="btn btn-ghost btn-block" id="editInvDetailsBtn" style="margin-bottom: 8px;">✏️ Edit invoice details (period, notes)</button>
        <button class="btn btn-warn btn-block" id="extractWoBtn" style="margin-bottom: 8px;">🔎 Extract &amp; link work orders from invoice text</button>
        <button class="btn btn-primary btn-block" id="submitDraftBtn">
          ${isManagerProxy
            ? `Submit invoice on behalf of ${escapeHTML(STATE.onBehalfOfName || 'tech')}`
            : 'Review &amp; submit this invoice'}
        </button>
      </div>
    ` : ''}

    ${isMgrReview ? `
      <div class="card" style="margin-top: 14px; border-left: 4px solid var(--ic-orange); background: #fff7ef;">
        <div class="section-title" style="margin-top: 0; color: var(--ic-orange-deep);">Review · submitted vs working copy</div>
        <p class="help" style="margin: 0;">Left is the invoice <strong>as submitted</strong> by the technician. Edit on the <strong>right</strong> — adjust labor hours, drive time, and expense amounts; the working total updates as you save each change and the technician is notified that their values changed. You can also tag work as unplanned and split it into wasted vs actual. Tags are backend-only; they never appear on the AP invoice.</p>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;">
        <div style="flex:1;min-width:320px;">
          <div class="card" style="margin-top:14px;padding:10px 14px;background:var(--surface-2,#f8f8f8);">
            <div style="display:flex;justify-content:space-between;align-items:baseline;">
              <span style="font-weight:700;">As submitted</span>
              <span style="font-weight:700;">${fmt$(baseline.total)}</span>
            </div>
            <div style="font-size:11px;color:var(--secondary-text);">Read-only snapshot</div>
          </div>
          ${renderEditableLineItems(baseline.by_date, invoice, { readOnly: true })}
        </div>
        <div style="flex:1;min-width:320px;">
          <div class="card" style="margin-top:14px;padding:10px 14px;border:1px solid var(--ic-orange);">
            <div style="display:flex;justify-content:space-between;align-items:baseline;">
              <span style="font-weight:700;color:var(--ic-orange-deep);">Working copy (live)</span>
              <span style="font-weight:700;">${fmt$(grandTotal)}</span>
            </div>
            <div style="font-size:11px;color:var(--secondary-text);">${(() => { const d = +(grandTotal - baseline.total).toFixed(2); if (Math.abs(d) < 0.005) return 'No changes yet'; return d > 0 ? `▲ ${fmt$(d)} vs submitted` : `▼ ${fmt$(Math.abs(d))} vs submitted`; })()}</div>
          </div>
          ${renderEditableLineItems(by_date, invoice, { hideTimeEditDelete: true })}
          ${renderInvoicePreviewPanel({
            total: grandTotal, labor: totalLabor, laborHours: summary.labor_hours || 0,
            mileage: totalMileage, other: totalOther, flags: summary.flag_count || 0,
            itemCount: (by_date || []).reduce((a, d) => a + (d.time_entries?.length || 0) + (d.drive_entries?.length || 0) + (d.expense_entries?.length || 0), 0),
            status: invoice.status,
          })}
        </div>
      </div>
    ` : ''}

    ${invoice.invoice_type !== 'vendor' && (
       (me.role === 'ops_manager' && invoice.status === 'submitted') ||
       // v0.67 — Sr Mgr only acts on ESCALATED invoices (countersign). Ops
       // approval is final for everything else, so the action card no longer
       // appears for normal approved_ops invoices.
       ((me.role === 'sr_manager' || me.role === 'pm') && invoice.status === 'approved_ops' && invoice.escalated_at)
      ) ? `
        <div class="card" style="margin-top: 14px; border-left: 4px solid var(--ic-green); padding: 16px;">
          <strong>${me.role === 'ops_manager' ? 'Ops Manager review' : 'Senior Manager countersign'}</strong>
          <p class="help" style="margin: 6px 0 12px;">${me.role === 'ops_manager'
            ? (summary.flag_count > 0
                ? 'This invoice has flagged lines. You can approve, reject, or escalate to Sr Mgr for secondary approval.'
                : 'Approve to mark ready-for-AP, or reject back to the technician with a reason.')
            : 'This invoice was escalated by the Ops Manager — your countersign is required before it can be sent to AP.'}</p>
          <div class="actions" style="flex-wrap: wrap;">
            <button class="btn btn-danger" id="rejectBtn">Reject</button>
            ${me.role === 'ops_manager' ? `
              <button class="btn btn-warn" id="escalateBtn">⤴ Escalate to Sr Mgr</button>
            ` : ''}
            <button class="btn btn-primary" id="approveBtn">${me.role === 'ops_manager' ? 'Approve' : 'Countersign'}</button>
          </div>
        </div>
      ` : ''}

    <!-- v0.67 — Sr Mgr review-only. Ops approval is final, so for a normal
         (non-escalated) approved_ops invoice the Senior Manager keeps full
         visibility but is NOT an approval gate — no action is required. -->
    ${invoice.invoice_type !== 'vendor'
      && (me.role === 'sr_manager' || me.role === 'pm')
      && invoice.status === 'approved_ops'
      && !invoice.escalated_at ? `
        <div class="card" style="margin-top: 14px; border-left: 4px solid var(--ic-green-deep); padding: 16px; background: var(--ic-cream);">
          <strong>✅ Approved by Ops — no Sr Mgr sign-off required</strong>
          <p class="help" style="margin: 6px 0 0;">Ops approval is final for this invoice. It's shown here for your visibility; the technician will verify and send it to AP. No action is needed from you.</p>
        </div>
      ` : ''}

    ${invoice.escalated_at ? `
      <div class="alert warn" style="margin-top: 14px;">
        <span class="ico">⤴</span>
        <div class="body">
          <strong>Escalated to Sr Mgr by Ops</strong> on ${new Date(invoice.escalated_at).toLocaleDateString()} —
          Sr Mgr countersign is required before this invoice can be sent to AP.
          ${invoice.escalation_note ? `<div style="margin-top: 4px; font-size: 12px;">Note: ${escapeHTML(invoice.escalation_note)}</div>` : ''}
        </div>
      </div>
    ` : ''}

    ${readyToSendToAp(invoice) && (
        invoice.user_id === me.id ||
        ['sr_manager','pm'].includes(me.role) ||
        (me.role === 'ops_manager' && isManagerView)
      ) ? `
        <div class="card" style="margin-top: 14px; border-left: 4px solid var(--ic-orange); padding: 16px; background: #fff8f0;">
          <strong>✅ ${invoice.status === 'approved_sr' ? 'Approved — verify & send to AP' : 'Ops Mgr approved — verify & send to AP'}</strong>
          <p class="help" style="margin: 6px 0 12px;">
            ${invoice.user_id === me.id
              ? 'This invoice is approved and ready. Verify the details above, then send it to Accounts Payable — we generate the PDF and email it.'
              : 'Approval is complete. Verify the details, then send: we generate a PDF, attach it to this invoice, and email it to AP.'}
          </p>
          <div class="actions">
            <button class="btn btn-warn" id="sendToApBtn">📧 Send to AP</button>
          </div>
        </div>
      ` : ''}

    ${invoice.status === 'sent_ap' ? `
        <div class="card" style="margin-top: 14px; border-left: 4px solid var(--ic-green); padding: 16px;">
          <strong>📧 Sent to AP</strong>
          <div class="meta" style="margin-top: 4px;">
            ${invoice.sent_to_ap_at ? `Delivered ${new Date(invoice.sent_to_ap_at).toLocaleString()}` : ''}
            ${invoice.ap_email_to ? ` · to <code>${escapeHTML(invoice.ap_email_to)}</code>` : ''}
          </div>
          <div class="actions" style="margin-top: 12px;">
            <button class="btn btn-ghost pdf-download-btn" data-pdf-id="${invoice.id}">📄 Download / view PDF</button>
          </div>
        </div>
      ` : ''}

    <!-- v0.48 — Expensify export, FTE-only -->
    ${invoice.invoice_type !== 'vendor'
      && invoice.owner_worker_type === 'fte'
      && ['submitted','approved_ops','approved_sr','queued_ap','sent_ap'].includes(invoice.status)
      && (invoice.user_id === me.id || ['sr_manager','pm'].includes(me.role) || (me.role === 'ops_manager' && isManagerView))
      ? (invoice.expensify_report_id ? `
        <div class="card" style="margin-top: 14px; border-left: 4px solid #6A4FB6; background: #f7f4fc;">
          <strong style="color: #4B2E94;">💜 Sent to Expensify</strong>
          <div class="meta" style="margin-top: 4px;">
            Report <code>${escapeHTML(invoice.expensify_report_id)}</code>
            ${invoice.expensify_sent_at ? ` · ${new Date(invoice.expensify_sent_at).toLocaleString()}` : ''}
            ${invoice.expensify_report_id.startsWith('R-STUB-') ? ` · <span style="color: var(--ic-orange);">⚠ stub mode</span>` : ''}
          </div>
          <div class="actions" style="margin-top: 12px;">
            <a class="btn btn-ghost" href="${escapeHTML(invoice.expensify_report_url || '#')}" target="_blank" rel="noopener">↗ Open in Expensify</a>
          </div>
        </div>
      ` : `
        <div class="card" style="margin-top: 14px; border-left: 4px solid #6A4FB6; background: #f7f4fc;">
          <strong style="color: #4B2E94;">💜 Expensify — employee approval flow</strong>
          <p class="help" style="margin: 6px 0 12px;">
            You're an FTE, so this invoice can also be routed through Expensify for your manager to approve in the standard Instacart expense-approval workflow.
            Sending creates a new Expensify report from your line items + mileage and emails your approver. It doesn't affect the Bread approval path.
          </p>
          <div class="actions">
            <button class="btn btn-ghost" id="sendToExpensifyBtn">📤 Send to Expensify</button>
          </div>
        </div>
      `) : ''}
  `;

  $('#prevInv')?.addEventListener('click', () => { if (newer) goto('invDetail', newer.id); });
  $('#nextInv')?.addEventListener('click', () => { if (older) goto('invDetail', older.id); });
  $('#exitProxy')?.addEventListener('click', () => {
    STATE.onBehalfOf = null; STATE.onBehalfOfName = null;
    toast('Exited proxy mode');
    goto('queue');
  });
  // When adding from a specific draft (e.g. the upload flow), pin the target
  // invoice so the new expense/time-entry attaches to THAT draft, not the
  // tech's current week.
  $('#addExpProxy')?.addEventListener('click', () => {
    STATE._addToInvoiceId = invoice.id;
    STATE._addToInvoicePeriod = { start: invoice.period_start, end: invoice.period_end };
    goto('add');
  });
  $('#addTimeProxy')?.addEventListener('click', () => openManualTimeSheet({
    invoiceId: invoice.id,
    period: { start: invoice.period_start, end: invoice.period_end },
  }));
  $('#extractWoBtn')?.addEventListener('click', () => openExtractWoSheet(invoice.id));
  // Edit/Delete buttons on individual line items in the editable list.
  $$('[data-edit-time]').forEach(b => b.addEventListener('click', () => openEditOneTimeSheet(Number(b.dataset.editTime))));
  $$('[data-del-time]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this time entry?')) return;
    try {
      await api(`/timeentries/${b.dataset.delTime}`, { method: 'DELETE' });
      toast('Deleted ✓', 'ok');
      goto('invDetail', invoice.id);
    } catch (e) { toast(e.message, 'err'); }
  }));
  $$('[data-edit-exp]').forEach(b => b.addEventListener('click', async () => {
    try {
      const exp = await api(`/expenses/${b.dataset.editExp}`);
      openEditExpenseSheet(exp);
    } catch (e) { toast(e.message, 'err'); }
  }));
  $$('[data-del-exp]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this expense?')) return;
    try {
      await api(`/expenses/${b.dataset.delExp}`, { method: 'DELETE' });
      toast('Deleted ✓', 'ok');
      goto('invDetail', invoice.id);
    } catch (e) { toast(e.message, 'err'); }
  }));
  // v0.64 — "Tag as unplanned" buttons on invoice line items (managers only).
  // Re-render after a tag so the saved note shows with the line-item details.
  wireUnplannedTagBtns(root, () => goto('invDetail', invoice.id));
  $('#importPdfBtn')?.addEventListener('click', async () => {
    const btn = $('#importPdfBtn');
    btn.disabled = true; btn.textContent = 'Importing…';
    try {
      const r = await api(`/invoices/${invoice.id}/import-pdf`, { method: 'POST' });
      const c = r.import.created;
      toast(`Imported ${c.time_entries} entries, ${c.expenses} expenses, ${c.work_orders} WOs`, 'ok');
      goto('invDetail', invoice.id);
    } catch (e) { btn.disabled = false; btn.textContent = '↻ Re-import line items from PDF'; toast(e.message, 'err'); }
  });
  $('#editInvDetailsBtn')?.addEventListener('click', () => openEditInvoiceDetailsSheet(invoice));
  $('#reextractBtn')?.addEventListener('click', async () => {
    const btn = $('#reextractBtn');
    btn.disabled = true; btn.textContent = 'Re-extracting…';
    try {
      await api(`/invoices/${invoice.id}/reextract`, { method: 'POST' });
      toast('Re-extracted ✓', 'ok');
      goto('invDetail', invoice.id);
    } catch (e) { btn.disabled = false; btn.textContent = '↻ Re-extract from PDF'; toast(e.message, 'err'); }
  });
  $('#applyPeriodBtn')?.addEventListener('click', async () => {
    const start = $('#applyPeriodBtn').dataset.start;
    const end   = $('#applyPeriodBtn').dataset.end;
    try {
      await api(`/invoices/${invoice.id}`, { method: 'PUT', body: { period_start: start, period_end: end } });
      toast('Period updated ✓', 'ok');
      goto('invDetail', invoice.id);
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-extract-link]').forEach(b => b.addEventListener('click', async () => {
    const ticket = b.dataset.extractLink;
    const src    = b.dataset.src;
    b.disabled = true; b.textContent = 'Linking…';
    try {
      const r = await api(`/invoices/${invoice.id}/link-wo`, { method: 'POST', body: { source_system: src, ticket_id: ticket } });
      b.textContent = r.was_existing ? '✓ Already linked' : '✓ Linked';
      toast(`${src} #${ticket} linked${r.was_existing ? ' (existing)' : ' as new WO'}`, 'ok');
    } catch (e) { b.disabled = false; b.textContent = 'Pull & link'; toast(e.message, 'err'); }
  }));
  $$('[data-toggle-extract]').forEach(t => t.addEventListener('click', () => {
    const target = document.getElementById(t.dataset.toggleExtract);
    if (target) {
      const open = target.style.display !== 'none';
      target.style.display = open ? 'none' : '';
      t.textContent = t.textContent.replace(open ? '▾' : '▸', open ? '▸' : '▾');
    }
  }));
  // Same submit flow for techs + manager proxy mode. The api() helper attaches
  // the x-on-behalf-of header automatically when STATE.onBehalfOf is set.
  // v0.58 — when the policy engine has fired any flags, show a confirmation
  // sheet listing every violation BEFORE the tech can submit, so they can
  // either fix it or knowingly justify it.
  $('#submitDraftBtn')?.addEventListener('click', async () => {
    const proxy = STATE.onBehalfOf && STATE.onBehalfOf === invoice.user_id;
    const flags = (lines || []).flatMap(l => (l.flags || []).map(f => ({ ...f, wo: l.external_id, store: l.store_name })));
    if (flags.length > 0) {
      openFlagSubmitSheet({ invoice, flags, proxy });
      return;
    }
    const promptText = proxy
      ? `Submit invoice on behalf of ${STATE.onBehalfOfName || 'tech'}?\n\nAdd an optional note:`
      : `Submit invoice ${invoice.invoice_number} ($${invoice.total.toFixed(2)})?\n\nAdd an optional note:`;
    const note = prompt(promptText, '') ?? null;
    if (note === null) return; // user cancelled
    try {
      await api(`/invoices/${invoice.id}/submit`, { method: 'POST', body: { notes: note || undefined } });
      toast(proxy ? 'Submitted ✓ — now in your approval queue' : 'Submitted ✓ — now awaiting Ops Mgr review', 'ok');
      if (proxy) { STATE.onBehalfOf = null; STATE.onBehalfOfName = null; goto('queue'); }
      else        goto('mine');
    } catch (e) { toast(e.message, 'err'); }
  });

  // v0.38 — vendor draft handlers
  $('#vendorEditBtn')?.addEventListener('click', () => openVendorEditSheet(invoice));
  $('#vendorSubmitBtn')?.addEventListener('click', async () => {
    if (!confirm(`Submit ${invoice.vendor_name || 'vendor'} invoice ${invoice.vendor_invoice_number || invoice.invoice_number} for ${fmt$(invoice.total)} to Sr Mgr?`)) return;
    try {
      await api(`/invoices/${invoice.id}/vendor-submit`, { method: 'POST' });
      toast('Submitted to Sr Mgr ✓', 'ok');
      goto('queue');
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#vendorDiscardBtn')?.addEventListener('click', async () => {
    if (!confirm(`Discard this vendor draft? This can't be undone.`)) return;
    try {
      await api(`/invoices/${invoice.id}`, { method: 'DELETE' });
      toast('Draft discarded', 'ok');
      goto('queue');
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#sendToApBtn')?.addEventListener('click', () => openSendToApSheet(invoice));
  $('#sendToApBtnTop')?.addEventListener('click', () => openSendToApSheet(invoice));
  // v0.68 — request to add work orders to this already-submitted week + open the
  // supplemental invoice link once a request is approved.
  $('#reqAddWoBtn')?.addEventListener('click', () => openRequestAddWoSheet(invoice));
  $$('[data-go-inv]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); goto('invDetail', Number(a.dataset.goInv)); }));
  // v0.45 — PDF download via secure download token
  $$('.pdf-download-btn').forEach(b => b.addEventListener('click', () => {
    downloadWithToken(`/api/invoices/${b.dataset.pdfId}/pdf`, '');
  }));
  // v0.48 — Send to Expensify (FTE-only). Confirms first, then POSTs.
  $('#sendToExpensifyBtn')?.addEventListener('click', async () => {
    if (!confirm(`Send invoice ${invoice.invoice_number} to Expensify for ${invoice.owner_email || 'this employee'}?\n\nThis creates a new Expensify report from the time entries + expenses on this invoice. Your manager will be notified to approve in Expensify.`)) return;
    const btn = $('#sendToExpensifyBtn');
    btn.disabled = true; btn.textContent = '⏳ Sending to Expensify…';
    try {
      const r = await api(`/invoices/${invoice.id}/send-to-expensify`, { method: 'POST' });
      const stub = (r.reportID || '').startsWith('R-STUB-');
      toast(stub
        ? `Stub report created (${r.transaction_count} txns) — configure Expensify creds to send for real`
        : `Sent to Expensify ✓ — ${r.transaction_count} transactions`, 'ok');
      goto('invDetail', invoice.id);
    } catch (e) {
      btn.disabled = false; btn.textContent = '📤 Send to Expensify';
      toast(e.message || 'Expensify send failed', 'err');
    }
  });

  $('#escalateBtn')?.addEventListener('click', async () => {
    const note = prompt('Add a note for Sr Mgr (optional but helpful):', '') ?? null;
    if (note === null) return;
    try {
      await api(`/invoices/${invoice.id}/escalate`, { method: 'POST', body: { note } });
      toast('Escalated to Sr Mgr ✓', 'ok');
      goto('queue');
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#approveBtn')?.addEventListener('click', async () => {
    if (!confirm(`Approve invoice ${invoice.invoice_number} for ${fmt$(invoice.total)}?`)) return;
    try {
      await api(`/invoices/${invoice.id}/approve`, { method: 'POST' });
      toast('Approved ✓', 'ok');
      goto('queue');
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#rejectBtn')?.addEventListener('click', () => {
    showSheet(`
      <h3>Reject invoice ${invoice.invoice_number}?</h3>
      <p class="help">The tech will get this reason and can fix the issue and re-submit.</p>
      <span class="label">Reason (required, min 5 chars)</span>
      <textarea class="field" id="rejReason" rows="4" placeholder="e.g., Cart count on WO #127 doesn't match the work performed; please double-check and re-submit."></textarea>
      <div class="actions">
        <button class="btn btn-ghost" data-act="sheet-close">Cancel</button>
        <button class="btn btn-danger" id="confirmReject">Reject &amp; Return to tech</button>
      </div>
    `, {
      onMount: (wrap) => {
        $('[data-act="sheet-close"]', wrap).addEventListener('click', closeSheet);
        $('#confirmReject', wrap).addEventListener('click', async () => {
          const reason = $('#rejReason', wrap).value.trim();
          if (reason.length < 5) return toast('Add a reason (at least 5 chars)', 'err');
          try {
            await api(`/invoices/${invoice.id}/reject`, { method: 'POST', body: { reason } });
            toast('Rejected · returned to tech', 'ok');
            closeSheet();
            goto('queue');
          } catch (e) { toast(e.message, 'err'); }
        });
      },
    });
  });
}

function trailFor(inv) {
  // v0.67 — Ops approval is the FINAL approval in the standard tech-labor flow:
  //   Submitted → Ops Manager approved → Sent to AP
  // The Senior Manager step is no longer part of the normal path; it appears
  // only when an Ops Mgr ESCALATED the invoice for an optional second look (the
  // escalation safety valve). We track the lifecycle up to the AP hand-off only.
  const escalated   = !!inv.escalated_at;
  const opsApproved = !!inv.approved_ops_at;
  const srApproved  = !!inv.approved_sr_at;
  const sent        = inv.status === 'sent_ap';
  // Cleared for the tech to send once approval is complete: ops-approved
  // (normal) or Sr Mgr-countersigned (escalated), and not yet sent.
  const readyToSend = !sent && (
    inv.status === 'queued_ap' ||
    inv.status === 'approved_sr' ||
    (inv.status === 'approved_ops' && !escalated)
  );

  const steps = [
    { who: 'Submitted', done: !!inv.submitted_at, when: inv.submitted_at },
    {
      who: opsApproved ? 'Ops Manager approved' : (escalated ? 'Escalated to Sr Mgr by Ops' : 'Ops Manager review'),
      done: opsApproved || ['approved_ops','approved_sr','queued_ap','sent_ap'].includes(inv.status),
      cur: inv.status === 'submitted',
      when: inv.approved_ops_at || inv.escalated_at,
    },
  ];

  // Escalation valve — only surfaced when the invoice was escalated to Sr Mgr.
  if (escalated) {
    steps.push({
      who: 'Sr Mgr review (escalated)',
      done: srApproved || ['approved_sr','queued_ap','sent_ap'].includes(inv.status),
      cur: !srApproved && inv.status === 'approved_ops',   // awaiting Sr Mgr countersign
      when: inv.approved_sr_at,
    });
  }

  steps.push({ who: 'Sent to AP', done: sent, cur: readyToSend, when: inv.sent_to_ap_at });

  return `
    ${steps.map((s, i) => `
      <div class="trail-step ${s.done ? 'done' : (s.cur ? 'cur' : '')}">
        <span class="dot">${s.done ? '✓' : (i+1)}</span>
        <span class="who">${s.who}</span>
        <span class="when">${s.when ? new Date(s.when).toLocaleDateString() : ''}</span>
      </div>
    `).join('')}
    ${inv.status === 'rejected' || inv.rejection_reason ? `
      <div class="trail-step" style="margin-top: 6px;">
        <span class="dot" style="background: var(--err-fg);">✗</span>
        <span class="who" style="color: var(--err-fg);">Rejected: ${escapeHTML((inv.rejection_reason || '').slice(0, 80))}${(inv.rejection_reason || '').length > 80 ? '…' : ''}</span>
        <span class="when">${inv.rejected_at ? new Date(inv.rejected_at).toLocaleDateString() : ''}</span>
      </div>
    ` : ''}
  `;
}

// ---- Accessibility: centralized post-render enhancements ----
// (A11Y-07) associate visual .label spans with their field via aria-labelledby;
// (A11Y-09) make clickable cards/chips/rows keyboard-operable. Runs on any DOM
// change so every dynamically-rendered view and sheet is covered without having
// to edit each template by hand.
let _a11ySeq = 0;
function wireLabels(root) {
  root.querySelectorAll('span.label:not([data-lblwired])').forEach(lab => {
    let field = null, n = lab.nextElementSibling, hops = 0;
    while (n && hops < 3 && !field) {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName)) field = n;
      else if (n.querySelector) field = n.querySelector('input,select,textarea');
      n = n.nextElementSibling; hops++;
    }
    lab.setAttribute('data-lblwired', '1');
    if (!field) return;
    if (!lab.id) lab.id = 'l_a11y_' + (++_a11ySeq);
    const ex = field.getAttribute('aria-labelledby') || '';
    if (!ex.split(' ').includes(lab.id)) field.setAttribute('aria-labelledby', (ex ? ex + ' ' : '') + lab.id);
  });
}
const A11Y_TAP_SEL = '.card.tap, .chip[data-status], [data-inv], [data-edit-wo], [data-tracker-inv], [data-cc-id], [data-wo-go], [data-wo-roll], [data-uptag], [data-upwt], [data-upstore], .dash-list-row, th.ts';
function wireInteractives(root) {
  root.querySelectorAll(A11Y_TAP_SEL).forEach(el => {
    if (el.dataset.kbdwired || el.tagName === 'BUTTON' || el.tagName === 'A') return;
    el.dataset.kbdwired = '1';
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
  });
}
let _a11yPending = false;
function runA11y() { _a11yPending = false; try { wireLabels(document); wireInteractives(document); } catch (_) {} }
function initA11y() {
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target;
    if (el && el.getAttribute && el.getAttribute('role') === 'button' && el.tagName !== 'BUTTON' && el.tagName !== 'A') {
      e.preventDefault(); el.click();
    }
  });
  const obs = new MutationObserver(() => { if (!_a11yPending) { _a11yPending = true; requestAnimationFrame(runA11y); } });
  obs.observe(document.body, { childList: true, subtree: true });
  runA11y();
}

// ---- Wire global events ----
document.addEventListener('DOMContentLoaded', () => {
  $$('.tab-btn').forEach(b => b.addEventListener('click', () => { if (STATE.onBehalfOf) exitProxy({ silent: true }); goto(b.dataset.tab); }));
  document.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'exit-proxy') { exitProxy(); render(); return; }
    if (act === 'logout')   {
      // v0.35 — call /logout to delete the server session, then clear local state
      api('/logout', { method: 'POST' }).catch(() => {});
      localStorage.removeItem(STORAGE_TOKEN_KEY);
      localStorage.removeItem(STORAGE_USER_KEY);
      location.reload();
    }
    if (act === 'change-password') openChangePasswordSheet({ forced: false });
    if (act === 'settings') { goto('settings'); }
    if (act === 'back')     {
      if (STATE.view === 'woAdd')     return goto('woPick');
      if (STATE.view === 'woDetail')  return goto('home');
      if (STATE.view === 'invDetail') return goto('mine');
      if (STATE.view === 'settings')  return goto('home');
      goto('home');
    }
  });
  // v0.65.1 (F-M7) — guard against accidental double-submits: swallow a second
  // click on the same button within 500ms (capture phase, before handlers run).
  let _lastClick = { el: null, t: 0 };
  document.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('button, .btn');
    if (!btn || btn.dataset.act === 'dismiss') return;
    const now = Date.now();
    if (_lastClick.el === btn && now - _lastClick.t < 500) { e.stopImmediatePropagation(); e.preventDefault(); return; }
    _lastClick = { el: btn, t: now };
  }, true);
  initA11y();
  boot();
});

// ═══════════════════════════════════════════════════════════════════════════
// v0.63.1 — UNPLANNED WORK DASHBOARD
// Tags are multi-select JSON arrays. An item keeps its existing work type /
// expense category and ALSO carries one or more unplanned reasons.
// ═══════════════════════════════════════════════════════════════════════════

// ---- Tag definitions -------------------------------------------------------
const UNPLANNED_TAGS = {
  wasted_labour: { label: 'Wasted Labour', color: '#c0392b', bg: '#fdecea' },
  ad_hoc:        { label: 'Ad-hoc',        color: '#d35400', bg: '#fef3e2' },
  unexpected:    { label: 'Unexpected',    color: '#7d3c98', bg: '#f5eef8' },
};

// Parse stored value (JSON array or legacy single string) → string[]
function parseUnplannedTags(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter(t => UNPLANNED_TAGS[t]);
  } catch (_) {}
  return UNPLANNED_TAGS[raw] ? [raw] : [];
}

// One or more badge chips from a tag array or stored JSON string
function unplannedBadges(rawOrArray) {
  const tags = Array.isArray(rawOrArray) ? rawOrArray : parseUnplannedTags(rawOrArray);
  if (!tags.length) return '';
  return tags.map(tag => {
    const t = UNPLANNED_TAGS[tag];
    if (!t) return '';
    return `<span style="display:inline-block;padding:2px 7px;border-radius:12px;font-size:11px;font-weight:600;color:${t.color};background:${t.bg};border:1px solid ${t.color}33;margin-right:3px;">${t.label}</span>`;
  }).join('');
}
// Legacy alias used in a few inline spots
function unplannedBadge(raw) { return unplannedBadges(raw); }

// ---- Multi-select tag-picker sheet -----------------------------------------
// currentTagsRaw: the stored JSON string (or legacy single string) from the row
function openUnplannedTagSheet(entityType, entityId, currentTagsRaw, currentNote, onSave, originalAmount, currentWasted) {
  const activeTags = parseUnplannedTags(currentTagsRaw);
  const hasAmount  = typeof originalAmount === 'number' && isFinite(originalAmount) && originalAmount > 0;
  const wastedDefault = (currentWasted != null && currentWasted !== '' && isFinite(+currentWasted)) ? +currentWasted : 0;
  const opts = [
    { v: 'wasted_labour', l: 'Wasted Labour', desc: 'Rework, preventable re-visits, duplicate effort' },
    { v: 'ad_hoc',        l: 'Ad-hoc',        desc: 'Reactive / unscheduled work not in the plan' },
    { v: 'unexpected',    l: 'Unexpected',     desc: 'Unforeseen circumstances (equipment failure, etc.)' },
  ];

  const checkboxes = opts.map(o => {
    const t = UNPLANNED_TAGS[o.v];
    const checked = activeTags.includes(o.v) ? 'checked' : '';
    return `
    <label style="display:flex;align-items:flex-start;gap:10px;padding:10px;border-radius:8px;cursor:pointer;margin-bottom:6px;border:1px solid ${checked ? t.color : 'var(--border)'};background:${checked ? t.bg : 'transparent'};" id="upLabel_${o.v}">
      <input type="checkbox" name="uptag" value="${o.v}" ${checked}
             style="margin-top:3px;accent-color:${t.color};"
             onchange="document.getElementById('upLabel_${o.v}').style.borderColor=this.checked?'${t.color}':'var(--border)';document.getElementById('upLabel_${o.v}').style.background=this.checked?'${t.bg}':'transparent';">
      <span>
        <strong style="display:block;color:${t.color};">${o.l}</strong>
        <span style="font-size:12px;color:var(--secondary-text);">${o.desc}</span>
      </span>
    </label>`;
  }).join('');

  showSheet(`
    <div style="padding:20px;">
      <div style="font-weight:700;font-size:16px;margin-bottom:4px;">Tag as Unplanned Work</div>
      <div style="font-size:13px;color:var(--secondary-text);margin-bottom:4px;">
        Select one or more reasons. The item keeps its existing work type and category — these tags are additive.
      </div>
      <div style="font-size:12px;color:var(--secondary-text);margin-bottom:14px;">Uncheck all to remove the unplanned flag.</div>
      <form id="upTagForm">
        ${checkboxes}
        ${hasAmount ? `
        <div style="margin-top:14px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2,#f8f8f8);">
          <div style="font-size:13px;font-weight:600;margin-bottom:4px;">How much of this was wasted?</div>
          <div style="font-size:12px;color:var(--secondary-text);margin-bottom:8px;">Reported total <strong>${fmt$(originalAmount)}</strong>. Defaults to <strong>$0</strong> wasted — set the wasted portion; the rest stays as actual.</div>
          <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
            <label style="font-size:12px;font-weight:600;color:var(--danger,#c0392b);">Wasted $
              <input id="upTagWasted" type="number" min="0" max="${originalAmount}" step="0.01" value="${wastedDefault}" style="width:110px;font-size:13px;border:1px solid var(--border);border-radius:6px;padding:6px;margin-left:4px;">
            </label>
            <div style="font-size:12px;color:var(--secondary-text);">Actual (kept): <strong id="upTagActual">${fmt$(Math.max(0, originalAmount - wastedDefault))}</strong></div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px;">
            <span style="font-size:11px;color:var(--secondary-text);">Quick set:</span>
            ${[['None',0],['25%',0.25],['50%',0.5],['75%',0.75],['All',1]].map(([l,f]) =>
              `<button type="button" class="btn upWastedPreset" data-frac="${f}" style="font-size:11px;padding:3px 8px;">${l}</button>`).join('')}
          </div>
        </div>` : ''}
        <label style="display:block;font-size:13px;font-weight:600;margin-top:14px;margin-bottom:4px;">Note (optional)</label>
        <textarea id="upTagNote" rows="2" placeholder="e.g. Cart battery failure caused extra trip" style="width:100%;box-sizing:border-box;font-size:13px;border:1px solid var(--border);border-radius:6px;padding:8px;">${escapeHTML(currentNote || '')}</textarea>
        <div style="display:flex;gap:10px;margin-top:16px;">
          <button type="submit" class="btn btn-primary" style="flex:1;">Save</button>
          <button type="button" id="upTagCancel" class="btn" style="flex:0 0 80px;">Cancel</button>
        </div>
      </form>
    </div>
  `);

  $('#upTagCancel')?.addEventListener('click', closeSheet);
  const clampWasted = () => {
    let w = Number($('#upTagWasted')?.value);
    if (!isFinite(w) || w < 0) w = 0;
    if (w > originalAmount) w = originalAmount;
    return +w.toFixed(2);
  };
  $('#upTagWasted')?.addEventListener('input', () => {
    $('#upTagActual').textContent = fmt$(Math.max(0, originalAmount - clampWasted()));
  });
  $$('.upWastedPreset').forEach(b => b.addEventListener('click', () => {
    const w = +(originalAmount * Number(b.dataset.frac)).toFixed(2);
    const wIn = $('#upTagWasted'); if (wIn) wIn.value = w;
    $('#upTagActual').textContent = fmt$(Math.max(0, originalAmount - w));
  }));
  $('#upTagForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const selected = [...document.querySelectorAll('input[name="uptag"]:checked')].map(el => el.value);
    const note = $('#upTagNote')?.value.trim() || null;
    const wasted = hasAmount ? clampWasted() : null;
    try {
      await api('/unplanned/tag', {
        method: 'PATCH',
        body: { entity_type: entityType, entity_id: entityId, tags: selected, note, wasted },
      });
      closeSheet();
      const labelStr = selected.length ? selected.map(t => UNPLANNED_TAGS[t]?.label).join(' + ') : 'removed';
      toast(selected.length ? `Tagged: ${labelStr}` : 'Unplanned tag removed');
      onSave && onSave(selected.length ? JSON.stringify(selected) : null, note);
    } catch (err) {
      toast('Error: ' + err.message, 'err');
    }
  });
}

// ---- Inline tag button (renders current tags + edit affordance) -------------
// currentTagsRaw: the raw stored value (JSON string or null)
function unplannedBtnInner(tags) {
  return tags.length
    ? tags.map(t => `<span style="color:${UNPLANNED_TAGS[t]?.color};font-size:11px;font-weight:700;">● ${UNPLANNED_TAGS[t]?.label}</span>`).join(' ')
        + ` <span style="font-size:10px;color:var(--secondary-text);font-weight:500;">✎&nbsp;edit</span>`
    : `<span style="font-size:12px;font-weight:600;">🏷 Tag as unplanned</span>`;
}

// Inline "Note: …" line shown next to a tagged item so the reason note is
// visible with the line-item details. Renders nothing when untagged/no note.
function unplannedNoteLine(rawTag, note) {
  if (!note || !parseUnplannedTags(rawTag).length) return '';
  return `<div style="margin-top:4px;font-size:11px;color:var(--secondary-text);font-style:italic;">Note: ${escapeHTML(note)}</div>`;
}

// Inline "Wasted $X · Actual $Y of $Z" line for a tagged item carrying a split.
function unplannedSplitLine(rawTag, wasted, original) {
  if (!parseUnplannedTags(rawTag).length) return '';
  if (typeof original !== 'number' || !isFinite(original) || original <= 0) return '';
  const w = (wasted != null && wasted !== '' && isFinite(+wasted)) ? Math.min(+wasted, original) : 0;
  if (w <= 0) return '';   // default 0 wasted → nothing to show
  const a = Math.max(0, original - w);
  return `<div style="margin-top:2px;font-size:11px;"><span style="color:var(--danger,#c0392b);font-weight:600;">Wasted ${fmt$(w)}</span> · <span style="color:var(--secondary-text);">Actual ${fmt$(a)} of ${fmt$(original)}</span></div>`;
}

function renderUnplannedTagBtn(entityType, entityId, currentTagsRaw, currentNote, originalAmount, currentWasted) {
  const tags = parseUnplannedTags(currentTagsRaw);
  const amtAttr = (typeof originalAmount === 'number' && isFinite(originalAmount)) ? originalAmount : '';
  const wAttr   = (currentWasted != null && currentWasted !== '' && isFinite(+currentWasted)) ? +currentWasted : '';
  return `<button data-upbtn="1" data-et="${entityType}" data-eid="${entityId}"
            data-tag="${escapeHTML(currentTagsRaw || '')}" data-note="${escapeHTML(currentNote || '')}"
            data-amount="${amtAttr}" data-wasted="${wAttr}"
            title="Tag as unplanned / wasted-labour for leadership reporting (backend only — never shown on the AP invoice)"
            style="background:#fff7ef;border:1px solid var(--ic-orange);color:var(--ic-orange-deep);border-radius:6px;padding:4px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;font-weight:600;">
            ${unplannedBtnInner(tags)}
          </button>`;
}

// Wire all [data-upbtn] buttons inside a container
function wireUnplannedTagBtns(container, onSave) {
  container.querySelectorAll('[data-upbtn]').forEach(btn => {
    btn.addEventListener('click', () => {
      const et   = btn.dataset.et;
      const eid  = Number(btn.dataset.eid);
      const raw  = btn.dataset.tag || null;
      const note = btn.dataset.note || null;
      const amount = btn.dataset.amount !== '' ? Number(btn.dataset.amount) : undefined;
      const wasted = btn.dataset.wasted !== '' ? Number(btn.dataset.wasted) : null;
      openUnplannedTagSheet(et, eid, raw, note, (newRaw, newNote) => {
        btn.dataset.tag  = newRaw || '';
        btn.dataset.note = newNote || '';
        const newTags  = parseUnplannedTags(newRaw);
        btn.innerHTML = unplannedBtnInner(newTags);
        onSave && onSave();
      }, amount, wasted);
    });
  });
}

// ---- Main Unplanned dashboard view ----------------------------------------
async function renderUnplanned(root) {
  const period = STATE._unplannedPeriod || 'last_90';
  root.innerHTML = `<div style="padding:16px;max-width:900px;margin:0 auto;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:16px;">
      <div>
        <div style="font-size:20px;font-weight:700;">Unplanned Work</div>
        <div style="font-size:13px;color:var(--secondary-text);">Leadership view of unforecasted costs &amp; time</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${['last_30','last_90','ytd','all'].map(p =>
          `<button data-upperiod="${p}" class="btn ${period===p?'btn-primary':''}" style="font-size:12px;padding:5px 10px;">${
            {last_30:'30d',last_90:'90d',ytd:'YTD',all:'All'}[p]}</button>`
        ).join('')}
      </div>
    </div>
    <div id="unplannedBody"><div style="padding:40px;text-align:center;color:var(--secondary-text);">Loading…</div></div>
  </div>`;

  $$('[data-upperiod]').forEach(b => b.addEventListener('click', () => {
    STATE._unplannedPeriod = b.dataset.upperiod;
    renderUnplanned(root);
  }));

  let data;
  try {
    data = await api(`/unplanned/summary?period=${period}`);
  } catch (e) {
    $('#unplannedBody').innerHTML = alertHTML('err', '!', e.message);
    return;
  }

  const s = data.summary;
  const fmtH = h => `${(+h).toFixed(1)}h`;

  // KPI tiles
  const kpis = [
    { label: 'Total Wasted Cost',       val: fmt$(s.total_cost),          sub: `of ${fmt$(s.total_original_cost != null ? s.total_original_cost : s.total_cost)} tagged`, hi: true },
    { label: 'Actual (within tagged)',  val: fmt$(s.total_actual_cost || 0), sub: 'legitimate portion' },
    { label: 'Wasted Labour',           val: fmtH(s.total_labor_hours),   sub: fmt$(s.total_labor_cost) + ' wasted' },
    { label: 'Wasted Expenses',         val: fmt$(s.total_expense_cost),  sub: 'tech-paid items' },
    { label: 'Wasted Corp Card',        val: fmt$(s.total_cc_cost),       sub: 'corp card items' },
    { label: 'Tagged Work Orders',      val: s.tagged_wo_count,           sub: 'WOs flagged' },
  ];

  // By-tag breakdown
  const tagBreakdown = Object.entries(UNPLANNED_TAGS).map(([k, t]) => {
    const d = data.by_tag[k] || {};
    const total = (d.labor_cost||0) + (d.expense_cost||0) + (d.cc_cost||0);
    return `
      <div data-uptag="${k}" title="Filter detail by ${t.label}" style="cursor:pointer;border:1px solid ${t.color}44;border-radius:10px;padding:14px;background:${t.bg};">
        <div style="font-weight:700;color:${t.color};margin-bottom:6px;">${t.label}</div>
        <div style="font-size:22px;font-weight:700;">${fmt$(total)}</div>
        <div style="font-size:12px;color:var(--secondary-text);margin-top:4px;">
          ${fmtH(d.labor_hours||0)} labour · ${fmt$(d.expense_cost||0)} expenses · ${fmt$(d.cc_cost||0)} corp card
        </div>
        <div style="font-size:12px;color:var(--secondary-text);">${d.wo_count||0} WOs tagged</div>
      </div>`;
  }).join('');

  // By work type table — unplanned slice vs the type's full cost. Click to filter.
  const wtRows = Object.entries(data.by_work_type || {})
    .sort(([,a],[,b]) => (b.unplanned_cost ?? b.total_cost) - (a.unplanned_cost ?? a.total_cost))
    .map(([wt, d]) => {
      const unplanned = d.unplanned_cost != null ? d.unplanned_cost : d.total_cost;
      const total = d.total_all_cost != null ? d.total_all_cost : unplanned;
      const pct = d.unplanned_pct != null ? d.unplanned_pct : (total > 0 ? Math.round(unplanned/total*100) : 0);
      return `
      <tr data-upwt="${escapeHTML(wt)}" style="cursor:pointer;" title="Filter detail by ${escapeHTML(wt)}">
        <td style="padding:6px 8px;text-transform:capitalize;">${escapeHTML(wt)}</td>
        <td style="padding:6px 8px;text-align:right;font-weight:700;color:var(--danger,#c0392b);">${fmt$(unplanned)}</td>
        <td style="padding:6px 8px;text-align:right;color:var(--secondary-text);">${fmt$(total)}</td>
        <td style="padding:6px 8px;text-align:right;">${pct}%</td>
        <td style="padding:6px 8px;text-align:right;">${d.count}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" style="padding:12px;text-align:center;color:var(--secondary-text);">No data</td></tr>';

  // By store table (top 10). Click to filter.
  const storeRows = Object.entries(data.by_store || {})
    .sort(([,a],[,b]) => b.total_cost - a.total_cost)
    .slice(0, 10)
    .map(([store, d]) => `
      <tr data-upstore="${escapeHTML(store)}" style="cursor:pointer;" title="Filter detail by this store">
        <td style="padding:6px 8px;">${escapeHTML(store)}</td>
        <td style="padding:6px 8px;text-align:right;">${fmt$(d.total_cost)}</td>
        <td style="padding:6px 8px;text-align:right;">${d.count}</td>
      </tr>`).join('') || '<tr><td colspan="3" style="padding:12px;text-align:center;color:var(--secondary-text);">No data</td></tr>';

  // By work order — unplanned cost vs the WO's total cost. Click a row to open
  // the full work-order detail (drill-down).
  const woRoll = data.by_work_order || [];
  const woRollRows = woRoll.map(w => `
      <tr data-wo-roll="${w.wo_id}" style="cursor:pointer;" title="Open work order ${escapeHTML(w.external_id)}">
        <td style="padding:6px 8px;font-size:12px;color:var(--secondary-text);white-space:nowrap;">${escapeHTML((w.date||'').slice(0,10) || '—')}</td>
        <td style="padding:6px 8px;max-width:230px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><span style="color:var(--primary);font-weight:600;">${escapeHTML(w.external_id)}</span>${w.title ? ` <span style="font-size:11px;color:var(--secondary-text);">${escapeHTML(w.title)}</span>` : ''}</td>
        <td style="padding:6px 8px;text-transform:capitalize;color:var(--secondary-text);">${escapeHTML(w.work_type||'')}</td>
        <td style="padding:6px 8px;">${escapeHTML(w.store_name||'')}</td>
        <td style="padding:6px 8px;text-align:right;font-weight:700;color:var(--danger,#c0392b);">${fmt$(w.unplanned_cost)}</td>
        <td style="padding:6px 8px;text-align:right;color:var(--secondary-text);">${fmt$(w.total_cost)}</td>
        <td style="padding:6px 8px;text-align:right;">${w.unplanned_pct}%</td>
      </tr>`).join('') || '<tr><td colspan="7" style="padding:12px;text-align:center;color:var(--secondary-text);">No tagged work orders</td></tr>';

  // Unified, filterable list of every tagged line item (drill-down table).
  const fmtDateShort = (d) => d ? String(d).slice(0, 10) : '';
  const upItems = [];
  for (const r of (data.detail?.time_entries || [])) upItems.push({ kind:'Labor', date:r.clock_in, tags:r.tags||parseUnplannedTags(r.unplanned_tag), work_type:r.work_type||'', store:r.store_name||'', wo_id:r.wo_id, wo:r.wo_external_id||'', wo_title:r.wo_title||'', who:r.tech_name||'', cost:+r.cost||0, original:+r.original_cost||+r.cost||0, what:fmtH(r.hours||0)+' wasted labour', note:r.note||'' });
  for (const r of (data.detail?.expenses || [])) upItems.push({ kind:'Expense', date:r.expense_date, tags:r.tags||parseUnplannedTags(r.unplanned_tag), work_type:r.work_type||'', store:r.store_name||'', wo_id:r.wo_id, wo:r.wo_external_id||'', wo_title:r.wo_title||'', who:r.tagged_by_name||'', cost:+r.wasted||0, original:+r.original||+r.amount||0, what:(r.category||'')+(r.subcategory?(' / '+r.subcategory):''), note:r.note||'' });
  for (const r of (data.detail?.corp_card_expenses || [])) upItems.push({ kind:'Corp card', date:r.expense_date, tags:r.tags||parseUnplannedTags(r.unplanned_tag), work_type:r.work_type||'', store:r.store_name||'', wo_id:r.wo_id, wo:r.wo_external_id||'', wo_title:r.wo_title||'', who:r.tagged_by_name||'', cost:+r.wasted||0, original:+r.original||+r.amount||0, what:'Corp card: '+(r.category||''), note:r.note||'' });
  for (const r of (data.detail?.work_orders || [])) upItems.push({ kind:'Work order', date:r.tagged_at, tags:r.tags||parseUnplannedTags(r.unplanned_tag), work_type:r.work_type||'', store:r.store_name||'', wo_id:r.id, wo:r.external_id||'', wo_title:r.title||'', who:r.tagged_by_name||'', cost:0, what:'Whole work order', note:r.note||'', woLevel:true });
  const wtOpts    = [...new Set(upItems.map(i => i.work_type).filter(Boolean))].sort();
  const storeOpts = [...new Set(upItems.map(i => i.store).filter(Boolean))].sort();

  // Weekly trend sparkline (simple bar chart with divs)
  const trend = data.weekly_trend || [];
  const maxCost = Math.max(...trend.map(r => r.cost), 1);
  const sparkBars = trend.map(r => {
    const pct = Math.round((r.cost / maxCost) * 80);
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;min-width:28px;">
      <div style="font-size:9px;color:var(--secondary-text);">${fmt$(r.cost)}</div>
      <div style="width:100%;background:var(--primary);border-radius:3px 3px 0 0;height:${pct}px;"></div>
      <div style="font-size:9px;color:var(--secondary-text);writing-mode:vertical-rl;transform:rotate(180deg);">${r.week}</div>
    </div>`;
  }).join('');

  // Detailed items tabs — multi-badge, work type / category always shown
  const teRows = (data.detail?.time_entries || []).slice(0, 50).map(r => `
    <tr>
      <td style="padding:5px 8px;">${unplannedBadges(r.tags || r.unplanned_tag)}</td>
      <td style="padding:5px 8px;font-size:12px;">${escapeHTML(r.wo_external_id||'')} — ${escapeHTML(r.wo_title||'')}</td>
      <td style="padding:5px 8px;font-size:12px;text-transform:capitalize;color:var(--secondary-text);">${escapeHTML(r.work_type||'')}</td>
      <td style="padding:5px 8px;font-size:12px;">${escapeHTML(r.store_name||'')}</td>
      <td style="padding:5px 8px;font-size:12px;text-align:right;">${fmtH(r.hours)}</td>
      <td style="padding:5px 8px;font-size:12px;text-align:right;">${fmt$(r.cost)}</td>
      <td style="padding:5px 8px;font-size:12px;color:var(--secondary-text);">${escapeHTML(r.tech_name||'')}</td>
      <td style="padding:5px 8px;font-size:12px;color:var(--secondary-text);">${escapeHTML(r.note||'')}</td>
    </tr>`).join('') || '<tr><td colspan="8" style="padding:12px;text-align:center;color:var(--secondary-text);">No tagged time entries</td></tr>';

  const expRows2 = (data.detail?.expenses || []).slice(0, 50).map(r => `
    <tr>
      <td style="padding:5px 8px;">${unplannedBadges(r.tags || r.unplanned_tag)}</td>
      <td style="padding:5px 8px;font-size:12px;">${escapeHTML(r.wo_external_id||'')} — ${escapeHTML(r.wo_title||'')}</td>
      <td style="padding:5px 8px;font-size:12px;text-transform:capitalize;color:var(--secondary-text);">${escapeHTML(r.work_type||'')}</td>
      <td style="padding:5px 8px;font-size:12px;">${escapeHTML(r.store_name||'')}</td>
      <td style="padding:5px 8px;font-size:12px;font-weight:600;">${escapeHTML(r.category||'')}${r.subcategory ? ` <span style="font-weight:400;">/ ${escapeHTML(r.subcategory)}</span>` : ''}</td>
      <td style="padding:5px 8px;font-size:12px;text-align:right;">${fmt$(r.amount)}</td>
      <td style="padding:5px 8px;font-size:12px;color:var(--secondary-text);">${escapeHTML(r.note||'')}</td>
    </tr>`).join('') || '<tr><td colspan="7" style="padding:12px;text-align:center;color:var(--secondary-text);">No tagged expenses</td></tr>';

  const woDetailRows = (data.detail?.work_orders || []).slice(0, 50).map(r => `
    <tr>
      <td style="padding:5px 8px;">${unplannedBadges(r.tags || r.unplanned_tag)}</td>
      <td style="padding:5px 8px;font-size:12px;">${escapeHTML(r.external_id||'')} — ${escapeHTML(r.title||'')}</td>
      <td style="padding:5px 8px;font-size:12px;text-transform:capitalize;font-weight:600;">${escapeHTML(r.work_type||'')}</td>
      <td style="padding:5px 8px;font-size:12px;">${escapeHTML(r.store_name||'')}</td>
      <td style="padding:5px 8px;font-size:12px;color:var(--secondary-text);">${escapeHTML(r.tagged_by_name||'')}</td>
      <td style="padding:5px 8px;font-size:12px;color:var(--secondary-text);">${escapeHTML(r.note||'')}</td>
    </tr>`).join('') || '<tr><td colspan="6" style="padding:12px;text-align:center;color:var(--secondary-text);">No tagged WOs</td></tr>';

  const thStyle = 'padding:6px 8px;text-align:left;font-size:12px;font-weight:600;border-bottom:2px solid var(--border);background:var(--surface-2,#f8f8f8);';
  const thR     = thStyle.replace('text-align:left','text-align:right');

  $('#unplannedBody').innerHTML = `
    <!-- KPI strip -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px;">
      ${kpis.map(k => `
        <div style="background:var(--surface,#fff);border:1px solid var(--border);border-radius:10px;padding:14px;">
          <div style="font-size:12px;color:var(--secondary-text);margin-bottom:4px;">${k.label}</div>
          <div style="font-size:${k.hi ? '24px' : '20px'};font-weight:700;${k.hi ? 'color:var(--danger,#c0392b)' : ''}">${k.val}</div>
          <div style="font-size:11px;color:var(--secondary-text);">${k.sub}</div>
        </div>`).join('')}
    </div>

    <!-- By tag breakdown -->
    <div style="font-weight:700;font-size:15px;margin-bottom:8px;">By Tag Type</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:24px;">
      ${tagBreakdown}
    </div>

    <!-- Weekly trend -->
    ${trend.length ? `
    <div style="font-weight:700;font-size:15px;margin-bottom:8px;">Weekly Trend</div>
    <div style="background:var(--surface,#fff);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:24px;">
      <div style="display:flex;align-items:flex-end;gap:4px;height:100px;overflow-x:auto;">${sparkBars}</div>
    </div>` : ''}

    <!-- By work type -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;">
      <div style="background:var(--surface,#fff);border:1px solid var(--border);border-radius:10px;padding:16px;">
        <div style="font-weight:700;font-size:14px;margin-bottom:10px;">By Work Type</div>
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr>
            <th style="${thStyle}">Type</th>
            <th style="${thR}">Unplanned</th>
            <th style="${thR}">Total</th>
            <th style="${thR}">%</th>
            <th style="${thR}">Items</th>
          </tr></thead>
          <tbody>${wtRows}</tbody>
        </table>
      </div>
      <div style="background:var(--surface,#fff);border:1px solid var(--border);border-radius:10px;padding:16px;">
        <div style="font-weight:700;font-size:14px;margin-bottom:10px;">Top Stores (by cost)</div>
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr>
            <th style="${thStyle}">Store</th>
            <th style="${thR}">Cost</th>
            <th style="${thR}">Items</th>
          </tr></thead>
          <tbody>${storeRows}</tbody>
        </table>
      </div>
    </div>

    <!-- By work order: unplanned vs total cost (drill-down, earliest → latest) -->
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
      <div style="font-weight:700;font-size:15px;">By Work Order — unplanned vs total cost</div>
      <div style="font-size:12px;color:var(--secondary-text);">${woRoll.length} work order${woRoll.length === 1 ? '' : 's'} · earliest → latest${woRoll.length > 20 ? ' · scroll for more' : ''}</div>
    </div>
    <div style="background:var(--surface,#fff);border:1px solid var(--border);border-radius:10px;overflow:auto;margin-bottom:24px;max-height:640px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr>
          <th style="${thStyle}position:sticky;top:0;z-index:1;">Date</th>
          <th style="${thStyle}position:sticky;top:0;z-index:1;">Work Order</th>
          <th style="${thStyle}position:sticky;top:0;z-index:1;">Type</th>
          <th style="${thStyle}position:sticky;top:0;z-index:1;">Store</th>
          <th style="${thR}position:sticky;top:0;z-index:1;">Unplanned</th>
          <th style="${thR}position:sticky;top:0;z-index:1;">Total</th>
          <th style="${thR}position:sticky;top:0;z-index:1;">%</th>
        </tr></thead>
        <tbody>${woRollRows}</tbody>
      </table>
    </div>

    <!-- Filterable tagged-items detail (drill to WO) -->
    <div id="upItemsAnchor"></div>
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
      <div style="font-weight:700;font-size:15px;">Tagged Items <span style="font-weight:400;color:var(--secondary-text);font-size:13px;">— click a row to open its work order</span></div>
      <div id="upItemsSubtotal" style="font-size:13px;color:var(--secondary-text);"></div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px;">
      <div style="display:flex;gap:4px;flex-wrap:wrap;">
        <button data-upreason="" class="btn" style="font-size:12px;padding:4px 10px;">All reasons</button>
        ${Object.entries(UNPLANNED_TAGS).map(([k,t]) => `<button data-upreason="${k}" class="btn" style="font-size:12px;padding:4px 10px;">${t.label}</button>`).join('')}
      </div>
      <select id="upfWt" class="field" style="font-size:12px;padding:4px 8px;max-width:160px;"><option value="">All work types</option>${wtOpts.map(w=>`<option value="${escapeHTML(w)}">${escapeHTML(w)}</option>`).join('')}</select>
      <select id="upfStore" class="field" style="font-size:12px;padding:4px 8px;max-width:180px;"><option value="">All stores</option>${storeOpts.map(w=>`<option value="${escapeHTML(w)}">${escapeHTML(w)}</option>`).join('')}</select>
      <select id="upfKind" class="field" style="font-size:12px;padding:4px 8px;max-width:130px;"><option value="">All kinds</option><option>Labor</option><option>Expense</option><option>Corp card</option><option>Work order</option></select>
      <input id="upfQ" class="field" placeholder="Search WO / store / note…" style="font-size:12px;padding:4px 8px;flex:1;min-width:140px;" />
      <button id="upfClear" class="btn" style="font-size:12px;padding:4px 10px;">Clear</button>
    </div>
    <div style="background:var(--surface,#fff);border:1px solid var(--border);border-radius:10px;overflow:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr>
          <th style="${thStyle}">Date</th>
          <th style="${thStyle}">Reason(s)</th>
          <th style="${thStyle}">Kind</th>
          <th style="${thStyle}">Work Order</th>
          <th style="${thStyle}">Type</th>
          <th style="${thStyle}">Store</th>
          <th style="${thStyle}">Detail</th>
          <th style="${thStyle}">Who</th>
          <th style="${thR}">Cost</th>
        </tr></thead>
        <tbody id="upItemsBody"></tbody>
      </table>
    </div>
  `;

  // ── Drill-down + filtering for the tagged-items table ────────────────────
  STATE._upFilter = STATE._upFilter || { reason:'', work_type:'', store:'', kind:'', q:'' };
  const f = STATE._upFilter;
  const matchF = (i) =>
       (!f.reason    || (i.tags||[]).includes(f.reason))
    && (!f.work_type || i.work_type === f.work_type)
    && (!f.store     || i.store === f.store)
    && (!f.kind      || i.kind === f.kind)
    && (!f.q         || `${i.wo} ${i.wo_title} ${i.store} ${i.who} ${i.what} ${i.note}`.toLowerCase().includes(f.q.toLowerCase()));

  function syncUpControls() {
    $$('[data-upreason]').forEach(b => b.classList.toggle('btn-primary', (b.dataset.upreason||'') === (f.reason||'')));
    if ($('#upfWt'))    $('#upfWt').value = f.work_type || '';
    if ($('#upfStore')) $('#upfStore').value = f.store || '';
    if ($('#upfKind'))  $('#upfKind').value = f.kind || '';
    if ($('#upfQ') && document.activeElement !== $('#upfQ')) $('#upfQ').value = f.q || '';
  }
  function paintUpItems() {
    const rows = upItems.filter(matchF);
    const subtotal = rows.reduce((a, i) => a + (i.cost || 0), 0);
    $('#upItemsBody').innerHTML = rows.map(i => `
      <tr ${i.wo_id ? `data-wo-go="${i.wo_id}" style="cursor:pointer;"` : ''}>
        <td style="padding:5px 8px;font-size:12px;color:var(--secondary-text);">${escapeHTML(fmtDateShort(i.date))}</td>
        <td style="padding:5px 8px;">${unplannedBadges(i.tags)}</td>
        <td style="padding:5px 8px;font-size:12px;">${escapeHTML(i.kind)}</td>
        <td style="padding:5px 8px;font-size:12px;">${i.wo ? `<span style="color:var(--primary);font-weight:600;">${escapeHTML(i.wo)}</span>` : '—'}</td>
        <td style="padding:5px 8px;font-size:12px;text-transform:capitalize;color:var(--secondary-text);">${escapeHTML(i.work_type)}</td>
        <td style="padding:5px 8px;font-size:12px;">${escapeHTML(i.store)}</td>
        <td style="padding:5px 8px;font-size:12px;">${escapeHTML(i.what)}${i.note ? `<div style="font-size:11px;color:var(--secondary-text);font-style:italic;">${escapeHTML(i.note)}</div>` : ''}</td>
        <td style="padding:5px 8px;font-size:12px;color:var(--secondary-text);">${escapeHTML(i.who)}</td>
        <td style="padding:5px 8px;font-size:12px;text-align:right;">${i.woLevel ? '—' : `${fmt$(i.cost)}${(i.original != null && Math.abs(i.original - i.cost) > 0.005) ? `<div style="font-size:10px;color:var(--secondary-text);">of ${fmt$(i.original)}</div>` : ''}`}</td>
      </tr>`).join('') || '<tr><td colspan="9" style="padding:14px;text-align:center;color:var(--secondary-text);">No items match these filters.</td></tr>';
    $('#upItemsSubtotal').textContent = `${rows.length} item${rows.length === 1 ? '' : 's'} · ${fmt$(subtotal)}`;
    $$('#upItemsBody [data-wo-go]').forEach(tr => tr.addEventListener('click', () => goto('woDetail', Number(tr.dataset.woGo))));
  }
  const scrollUpItems = () => $('#upItemsAnchor')?.scrollIntoView({ behavior:'smooth', block:'start' });

  $$('[data-upreason]').forEach(b => b.addEventListener('click', () => { f.reason = b.dataset.upreason; syncUpControls(); paintUpItems(); }));
  $('#upfWt')?.addEventListener('change',   e => { f.work_type = e.target.value; paintUpItems(); });
  $('#upfStore')?.addEventListener('change', e => { f.store = e.target.value; paintUpItems(); });
  $('#upfKind')?.addEventListener('change',  e => { f.kind = e.target.value; paintUpItems(); });
  $('#upfQ')?.addEventListener('input',      e => { f.q = e.target.value; paintUpItems(); });
  $('#upfClear')?.addEventListener('click', () => { f.reason=''; f.work_type=''; f.store=''; f.kind=''; f.q=''; if ($('#upfQ')) $('#upfQ').value=''; syncUpControls(); paintUpItems(); });

  // Drill from overview breakdowns → set the matching filter + jump to the table.
  $$('[data-uptag]').forEach(el => el.addEventListener('click', () => { f.reason = el.dataset.uptag; syncUpControls(); paintUpItems(); scrollUpItems(); }));
  $$('[data-upwt]').forEach(el => el.addEventListener('click', () => { f.work_type = el.dataset.upwt; syncUpControls(); paintUpItems(); scrollUpItems(); }));
  $$('[data-upstore]').forEach(el => el.addEventListener('click', () => { f.store = el.dataset.upstore; syncUpControls(); paintUpItems(); scrollUpItems(); }));
  // Work-order rollup rows → open the full WO detail.
  $$('[data-wo-roll]').forEach(tr => tr.addEventListener('click', () => goto('woDetail', Number(tr.dataset.woRoll))));

  syncUpControls();
  paintUpItems();
}

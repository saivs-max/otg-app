// ── Money is stored as integer cents end-to-end (QA review F-H5: float money errors) ──
export const money = (cents, { sign = false } = {}) => {
  const v = (cents || 0) / 100
  const s = v.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  return sign && v > 0 ? `+${s}` : s
}
export const num = (n, d = 1) => (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

export const fmtDate = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
export const fmtDateLong = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
export const weekLabel = (mondayIso) => {
  const a = new Date(mondayIso + 'T00:00:00')
  const b = new Date(a); b.setDate(a.getDate() + 6)
  const f = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${f(a)} – ${f(b)}`
}

// ── ONE shared, human-readable status vocabulary (QA review UX #1) ──
// Used by every screen and persona. Tone = plain language, never raw enum.
export const STATUS = {
  draft:        { label: 'Draft',              tone: 'neutral', tech: 'Open this week',          help: 'Still collecting time & expenses. Editable.' },
  submitted:    { label: 'Pending Ops review', tone: 'info',    tech: 'Sent to your manager',     help: 'Waiting for your Ops Manager to review.' },
  in_review:    { label: 'In review',          tone: 'info',    tech: 'Being reviewed',           help: 'Your Ops Manager has opened it.' },
  needs_fixes:  { label: 'Needs fixes',         tone: 'danger',  tech: 'Needs your changes',       help: 'Returned with a reason. Edit and resubmit.' },
  awaiting_sr:  { label: 'Awaiting Sr review',  tone: 'warning', tech: 'With senior manager',      help: 'Flagged or over threshold — needs a second sign-off.' },
  approved:     { label: 'Approved',            tone: 'success', tech: 'Approved',                 help: 'Cleared all approvals. Headed to Accounts Payable.' },
  queued_ap:    { label: 'Queued for AP',       tone: 'info',    tech: 'Queued for payment',       help: 'In the next AP export batch.' },
  sent_ap:      { label: 'Sent to AP',          tone: 'ap',      tech: 'Sent to payroll/AP',       help: 'In a transmitted batch. Not yet paid.' },
  paid:         { label: 'Paid',                tone: 'success', tech: 'Paid', solid: true,        help: 'Payment issued.' },
}
export const statusOf = (k) => STATUS[k] || STATUS.draft

// Pipeline order, for the approval trail / stepper
export const PIPELINE = ['submitted', 'in_review', 'approved', 'queued_ap', 'sent_ap', 'paid']

export const toneClass = {
  neutral: 'bg-surface-2 text-ink-2 ring-line',
  info:    'bg-info-bg text-info-fg ring-info-fg/20',
  success: 'bg-success-bg text-success-fg ring-success-fg/20',
  warning: 'bg-warning-bg text-warning-fg ring-warning-fg/20',
  danger:  'bg-danger-bg text-danger-fg ring-danger-fg/20',
  ap:      'bg-ap-bg text-ap-fg ring-ap-fg/20',
}

export const initials = (name) => name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()

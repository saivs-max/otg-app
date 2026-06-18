// Purpose: information architecture & user flows — how 14 flat destinations
// collapsed into two focused surfaces, the resulting sitemap, the five core
// journeys as step chains, and the rules that govern navigation across them.
import Icon from '../../lib/icons.jsx'
import { Card, CardHeader } from '../../components/ui.jsx'

const BEFORE_TECH = ['Home', 'Timer', 'Add', 'Invoices']
const BEFORE_MGR = ['Dashboard', 'Forecast', 'Tracker', 'Queue', 'Launch', 'Team', 'Invoices', 'Corp Card', 'Policy', 'Admin']

const AFTER_FIELD = ['Today', 'Time', 'Expenses', 'Invoices']
const AFTER_OPERATE = ['Overview', 'Approvals', 'Invoices', 'Corp card', 'Spend & forecast', 'Team']
const AFTER_ADMIN = [
  { label: 'Policy', gate: 'Sr / PM' },
  { label: 'Users', gate: 'PM' },
  { label: 'AP export', gate: 'PM' },
  { label: 'Settings', gate: null },
]

const SITEMAP = `Caper CostWise
│
├─ Field App  ·  Technician (mobile)
│   ├─ Today            (home: clock-in, this week, flags)
│   ├─ Time             (tracker + history)
│   ├─ Expenses         (add / list receipts)
│   ├─ Invoices         (my invoices → detail & trail)
│   └─ Profile          (in header: settings, sign out)
│
└─ Console  ·  Ops / Sr / PM (desktop)
    ├─ Operate
    │   ├─ Overview         (dashboard / KPIs)
    │   ├─ Approvals        (flagged-first queue → detail)
    │   ├─ Invoices         (all invoices)
    │   ├─ Corp card        (ledger / reconciliation)
    │   ├─ Spend & forecast
    │   └─ Team
    └─ Administer
        ├─ Policy           (Sr / PM)
        ├─ Users            (PM)
        ├─ AP export        (PM)
        └─ Settings`

const FLOWS = [
  {
    title: 'Technician — time → invoice',
    steps: ['Sign in (SSO)', 'Onboarding', 'Clock in (1 tap)', 'Work auto-tracked + GPS', 'Add expenses', 'Week auto-rolls into invoice', 'Resolve flags inline', 'Submit', 'Track status to Paid'],
    why: "Why it's better: the invoice builds itself from real activity, so submitting is a confirmation — not data entry.",
  },
  {
    title: 'Ops Manager — clean approve',
    steps: ['New submission lands', 'Queue (flagged-first)', 'Clean invoice', 'One-tap approve', 'Queued for AP'],
    why: "Why it's better: clean work clears in one tap, so attention goes to the invoices that actually need it.",
  },
  {
    title: 'Ops Manager — flagged',
    steps: ['Flagged invoice', 'Open detail', 'See flag + WO context', 'Request changes (reason)', 'Back to tech', 'Tech fixes & resubmits'],
    why: "Why it's better: the flag, its reason, and the work-order context sit together, so the fix is specific and fast.",
  },
  {
    title: 'Senior Manager — sign-off',
    steps: ['Over $5k or flagged', 'Sr queue (exceptions only)', 'Read Ops note', 'Sign off', 'Queued for AP'],
    why: "Why it's better: only true exceptions reach the Sr queue, so sign-off takes seconds.",
  },
  {
    title: 'PM — AP export',
    steps: ['Approved invoices accrue', 'Weekly batch (Fri 5pm)', 'Auto-emailed to AP', 'Mark paid (v1)'],
    why: "Why it's better: payout is a scheduled batch, not a manual scramble — predictable for techs and AP alike.",
  },
]

const NAV_RULES = [
  ['Role-gating', 'Sections appear only for roles that own them — Administer is Sr/PM, Users & AP export are PM-only. Techs never see the Console.'],
  ['Persistent proxy banner', "Whenever someone acts on another person's behalf, a fixed 'acting on behalf of' banner stays visible until they exit."],
  ['Back & breadcrumb behavior', 'Detail views return to the exact queue/list and scroll position they came from; the desktop Console shows a breadcrumb trail.'],
  ['One status vocabulary', 'Every list, detail, and notification uses the same plain-language status set — no raw enums, no per-screen wording drift.'],
]

const H2 = ({ children }) => <h2 className="text-2xl font-bold text-ink">{children}</h2>

/* A pill used in the before/after lists. */
const NavPill = ({ children, tone = 'neutral', icon }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm ring-1 ${tone === 'good' ? 'bg-brand-50 text-brand-800 ring-brand-700/20' : 'bg-surface-2 text-ink-2 ring-line'}`}>
    {icon && <Icon name={icon} size={14} />}{children}
  </span>
)

/* Flow — a titled horizontal chain of step pills separated by arrows. */
function Flow({ title, steps, why }) {
  return (
    <Card className="p-5">
      <h3 className="font-semibold text-ink">{title}</h3>
      <ol className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-2">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-1">
            <span className="inline-flex items-center rounded-md bg-surface ring-1 ring-line px-2.5 py-1.5 text-sm text-ink-2">{s}</span>
            {i < steps.length - 1 && <span className="text-muted" aria-hidden="true"><Icon name="arrow-right" size={16} /></span>}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-sm text-muted">{why}</p>
    </Card>
  )
}

export default function IAFlows() {
  return (
    <div className="max-w-content mx-auto p-8 space-y-12">
      <header className="space-y-2">
        <h1 className="text-4xl font-bold text-ink tracking-tight">IA &amp; user flows</h1>
        <p className="text-lg text-ink-2 max-w-2xl">
          How the information architecture and the core journeys were reshaped around two surfaces and one vocabulary.
        </p>
      </header>

      {/* ── Before / after ── */}
      <section className="space-y-5">
        <H2>From 14 flat destinations to 2 focused surfaces</H2>
        <div className="grid md:grid-cols-2 gap-4">
          {/* Before */}
          <Card>
            <CardHeader title="Before" sub="One mobile frame, stretched to fit everyone" icon="alert" />
            <div className="p-4 pt-2 space-y-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-muted mb-2">Technician tabs</div>
                <div className="flex flex-wrap gap-2">{BEFORE_TECH.map((t) => <NavPill key={t}>{t}</NavPill>)}</div>
              </div>
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-muted mb-2">Manager — 10 flat bottom tabs</div>
                <div className="flex flex-wrap gap-2">{BEFORE_MGR.map((t) => <NavPill key={t}>{t}</NavPill>)}</div>
              </div>
              <p className="text-sm text-danger-fg flex items-start gap-1.5">
                <Icon name="alert-circle" size={15} className="mt-0.5 shrink-0" />
                10 flat tabs, no grouping; managers forced into a phone frame; hidden actions.
              </p>
            </div>
          </Card>

          {/* After */}
          <Card>
            <CardHeader title="After" sub="Mobile-first field app + desktop-first Console" icon="check-circle" />
            <div className="p-4 pt-2 space-y-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-muted mb-2">Field App · Technician — 4 tabs (+ Profile in header)</div>
                <div className="flex flex-wrap gap-2">{AFTER_FIELD.map((t) => <NavPill key={t} tone="good" icon="check">{t}</NavPill>)}</div>
              </div>
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-muted mb-2">Console · Operate</div>
                <div className="flex flex-wrap gap-2">{AFTER_OPERATE.map((t) => <NavPill key={t} tone="good" icon="check">{t}</NavPill>)}</div>
              </div>
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-muted mb-2">Console · Administer</div>
                <div className="flex flex-wrap gap-2">
                  {AFTER_ADMIN.map((t) => (
                    <NavPill key={t.label} tone="good" icon="check">
                      {t.label}{t.gate && <span className="ml-1 text-2xs font-semibold text-muted">({t.gate})</span>}
                    </NavPill>
                  ))}
                </div>
              </div>
            </div>
          </Card>
        </div>
      </section>

      {/* ── Sitemap ── */}
      <section className="space-y-4">
        <H2>Sitemap</H2>
        <Card className="p-5 overflow-x-auto">
          <pre className="text-sm leading-relaxed text-ink-2 font-mono whitespace-pre">{SITEMAP}</pre>
        </Card>
      </section>

      {/* ── User flows ── */}
      <section className="space-y-4">
        <H2>User flows</H2>
        <div className="space-y-4">
          {FLOWS.map((f) => <Flow key={f.title} {...f} />)}
        </div>
      </section>

      {/* ── Navigation rules ── */}
      <section className="space-y-4">
        <H2>Navigation rules</H2>
        <Card className="divide-y divide-line">
          {NAV_RULES.map(([title, body]) => (
            <div key={title} className="flex gap-3 p-4">
              <span className="shrink-0 text-brand-700 mt-0.5"><Icon name="check-circle" size={18} /></span>
              <div className="min-w-0">
                <span className="font-semibold text-ink">{title}</span>
                <span className="text-ink-2"> — {body}</span>
              </div>
            </div>
          ))}
        </Card>
      </section>
    </div>
  )
}

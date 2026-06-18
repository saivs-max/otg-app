// Purpose: the redesign strategy at a glance — what we fixed, the principles
// behind it, who it serves, and the success metrics — with two doors into the
// live prototype (Field app for technicians, Console for managers/PM).
import Icon from '../../lib/icons.jsx'
import { Button, Card, Avatar } from '../../components/ui.jsx'

const FIXES = [
  { icon: 'shield', title: 'Accessibility 2/10 → WCAG 2.1 AA',
    body: 'Every text & UI color pair re-tuned to pass AA; zoom re-enabled; keyboard focus, focus traps, and live regions throughout; 48px targets.' },
  { icon: 'list', title: 'One status vocabulary',
    body: 'Draft → Pending → In review → Approved → Queued → Sent to AP → Paid — the same plain-language labels on every screen, for every persona.' },
  { icon: 'grid', title: 'Two surfaces, not one',
    body: 'Technicians get a fast mobile app; managers get a real desktop Console with wide tables — no more cramming approvals into a phone frame.' },
  { icon: 'alert-circle', title: 'Errors caught at entry',
    body: 'Policy (rates, caps, expected hours) is checked as you type and shown inline with the exact fix — not bounced back days later.' },
  { icon: 'clock', title: 'Fewer taps',
    body: 'One-tap clock-in, auto-rolling weekly invoice, one-tap approve for clean invoices, flagged-first queue.' },
  { icon: 'history', title: 'Trust & auditability',
    body: "Clear approval trail, a persistent 'acting on behalf of' banner, and visibly distinct 'Sent to AP' vs 'Paid' states." },
  { icon: 'sparkles', title: 'Onboarding & help',
    body: 'A first-run tour, a plain-language glossary, and friendly empty/error/success states everywhere.' },
  { icon: 'check-circle', title: 'No duplicate submits',
    body: 'Primary actions disable & show progress during requests; destructive actions use named confirm dialogs with undo.' },
]

const PRINCIPLES = [
  { title: 'One vocabulary', body: 'A single plain-language status set, shared by every screen and every persona.' },
  { title: 'Two surfaces', body: 'Mobile-first for the field, desktop-first for the office — each shaped to its job.' },
  { title: 'Fewer taps & less load', body: 'Defaults, automation, and one-tap paths remove busywork from the common case.' },
  { title: 'Prevent errors at entry', body: 'Validate against policy as people type, with the exact fix shown inline.' },
  { title: 'Accessible by default', body: 'AA contrast, keyboard support, live regions, and large targets are the baseline, not an add-on.' },
  { title: 'Trust & auditability', body: 'Every state change is legible, attributable, and reversible where it should be.' },
]

const PEOPLE = [
  { name: 'Field Technician', tone: 'brand', job: 'Log time & expenses with zero friction, get paid fast' },
  { name: 'Ops Manager', tone: 'brand', job: 'Approve clean invoices fast, catch outliers' },
  { name: 'Senior Manager', tone: 'info', job: 'Sign off exceptions in seconds' },
  { name: 'Program Manager', tone: 'info', job: 'Dashboard, policy, AP export — oversight not data entry' },
  { name: 'Accounts Payable', tone: 'carrot', job: 'Receive a clean weekly batch' },
]

const METRICS = [
  { value: '≤7 days', label: 'work → AP', sub: 'was ~14' },
  { value: '≥95%', label: 'invoices via app', sub: 'self-service' },
  { value: '<5 min', label: 'spend → dashboard', sub: 'near real-time' },
  { value: 'AA', label: 'accessibility pass', sub: 'WCAG 2.1' },
  { value: '0', label: 'duplicate submits', sub: 'by design' },
]

export default function Overview({ go, setRole }) {
  return (
    <div className="max-w-content mx-auto p-8 space-y-12">
      {/* ── Hero ── */}
      <header className="space-y-5">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 text-brand-700 text-xs font-semibold px-3 py-1 ring-1 ring-brand-700/20">
          <Icon name="sparkles" size={13} /> Redesign · v1.0
        </span>
        <h1 className="text-4xl font-bold text-ink tracking-tight max-w-3xl leading-tight">Caper CostWise, redesigned</h1>
        <p className="text-lg text-ink-2 max-w-2xl">
          A single system of record for Instacart Cart Tech field costs — from clock-in to AP payment.
          Rebuilt mobile-first for technicians and desktop-first for managers, accessible by default.
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Button size="lg" icon="home" onClick={() => { go('field', 'today'); setRole('technician') }}>Open the Field app</Button>
          <Button size="lg" variant="secondary" icon="grid" onClick={() => { go('console', 'dashboard'); setRole('pm') }}>Open the Console</Button>
        </div>
      </header>

      {/* ── What this redesign fixes ── */}
      <section className="space-y-5">
        <div>
          <h2 className="text-2xl font-bold text-ink">What this redesign fixes</h2>
          <p className="text-muted mt-1">Each card maps a real prior problem to the fix that retires it.</p>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {FIXES.map((f) => (
            <Card key={f.title} className="p-5">
              <span className="inline-grid place-items-center w-11 h-11 rounded-md bg-brand-50 text-brand-700">
                <Icon name={f.icon} size={22} />
              </span>
              <h3 className="mt-3 font-semibold text-ink leading-snug">{f.title}</h3>
              <p className="mt-1.5 text-sm text-ink-2 leading-relaxed">{f.body}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* ── Design principles ── */}
      <section className="space-y-5">
        <h2 className="text-2xl font-bold text-ink">Design principles</h2>
        <ol className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {PRINCIPLES.map((p, i) => (
            <li key={p.title}>
              <Card className="p-5 h-full flex gap-4">
                <span className="shrink-0 inline-grid place-items-center w-9 h-9 rounded-full bg-brand-900 text-white font-bold tnum text-sm">{i + 1}</span>
                <div className="min-w-0">
                  <h3 className="font-semibold text-ink">{p.title}</h3>
                  <p className="mt-1 text-sm text-ink-2 leading-relaxed">{p.body}</p>
                </div>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Who it's for ── */}
      <section className="space-y-5">
        <h2 className="text-2xl font-bold text-ink">Who it's for</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {PEOPLE.map((p) => (
            <Card key={p.name} className="p-5 flex flex-col items-start gap-3">
              <Avatar name={p.name} size={44} tone={p.tone} />
              <div>
                <h3 className="font-semibold text-ink leading-tight">{p.name}</h3>
                <p className="mt-1.5 text-sm text-muted leading-relaxed">{p.job}</p>
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* ── Success metrics ── */}
      <section className="space-y-5">
        <h2 className="text-2xl font-bold text-ink">Success metrics</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {METRICS.map((m) => (
            <Card key={m.label} className="p-5">
              <div className="text-3xl font-bold text-brand-700 tnum tracking-tight">{m.value}</div>
              <div className="mt-1.5 font-semibold text-ink text-sm">{m.label}</div>
              <div className="text-xs text-muted mt-0.5">{m.sub}</div>
            </Card>
          ))}
        </div>
      </section>

      {/* ── Footer note ── */}
      <footer className="border-t border-line pt-5">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Icon name="chevron-left" size={15} /> Explore every screen from the left rail.
        </p>
      </footer>
    </div>
  )
}

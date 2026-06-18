// Purpose: the living design system — the evolved Instacart/Caper brand tuned to
// WCAG AA. Color, type, spacing/radius, the shared status vocabulary, a live
// component gallery, and the iconography set, all rendered from real tokens.
import Icon from '../../lib/icons.jsx'
import {
  Button, Card, CardHeader, Field, TextInput, StatusPill, Badge, Flag,
  KPIStat, InlineAlert, ApprovalTrail, Avatar, Divider,
} from '../../components/ui.jsx'
import { STATUS } from '../../lib/format.js'

/* Swatch — the one place we use raw hex (inline) to SHOW the palette. */
function Swatch({ hex, name, note, dark }) {
  return (
    <div className="rounded-md ring-1 ring-line overflow-hidden bg-surface">
      <div className="h-16" style={{ backgroundColor: hex }} aria-hidden="true" />
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-ink text-sm">{name}</span>
          <code className="text-xs text-muted tnum">{hex}</code>
        </div>
        {note && <p className="mt-1 text-xs text-muted leading-snug">{note}</p>}
        {dark && <p className="mt-0.5 text-2xs text-carrot-600 font-semibold">Fills/illustration only</p>}
      </div>
    </div>
  )
}

const TYPE = [
  { sample: 'Bread', label: 'Display · 36 / Bold', cls: 'text-4xl font-bold' },
  { sample: 'Approvals queue', label: 'Title · 24 / Bold', cls: 'text-2xl font-bold' },
  { sample: 'Spend by category', label: 'Heading · 20 / Semibold', cls: 'text-xl font-semibold' },
  { sample: 'The quick brown technician logs time and expenses.', label: 'Body · 16 / Regular', cls: 'text-base' },
  { sample: 'Receipts over $50 need a photo to clear policy.', label: 'Small · 13', cls: 'text-sm' },
  { sample: '80% confidence interval ±6%', label: 'Caption · 12', cls: 'text-xs' },
]

const SPACING = [4, 8, 12, 16, 24, 32]
const RADII = [
  { name: 'sm', px: 8, cls: 'rounded-sm' },
  { name: 'md', px: 12, cls: 'rounded-md' },
  { name: 'lg', px: 16, cls: 'rounded-lg' },
  { name: 'xl', px: 20, cls: 'rounded-xl' },
]

const STATUS_TINTS = [
  { cls: 'bg-info-bg text-info-fg', label: 'Info' },
  { cls: 'bg-success-bg text-success-fg', label: 'Success' },
  { cls: 'bg-warning-bg text-warning-fg', label: 'Warning' },
  { cls: 'bg-danger-bg text-danger-fg', label: 'Danger' },
  { cls: 'bg-ap-bg text-ap-fg', label: 'Sent to AP' },
]

const ICONS = [
  'home', 'clock', 'plus', 'receipt', 'file', 'map-pin', 'check-circle', 'alert',
  'info', 'search', 'filter', 'settings', 'user', 'users', 'shield', 'card',
  'trending', 'bar-chart', 'pie-chart', 'calendar', 'flag', 'paid', 'inbox', 'bell',
]

const TRAIL = [
  { title: 'Submitted', meta: 'Jun 9', state: 'done' },
  { title: 'Approved by Ops', meta: 'Jun 10', state: 'done' },
  { title: 'Awaiting Sr review', meta: '4 days', state: 'current' },
  { title: 'Paid', state: 'todo' },
]

const H2 = ({ children }) => <h2 className="text-2xl font-bold text-ink">{children}</h2>
const SubH = ({ children }) => <h3 className="text-sm font-bold uppercase tracking-wider text-muted mb-3">{children}</h3>

export default function DesignSystem() {
  return (
    <div className="max-w-content mx-auto p-8 space-y-12">
      <header className="space-y-2">
        <h1 className="text-4xl font-bold text-ink tracking-tight">Design system</h1>
        <p className="text-lg text-ink-2 max-w-2xl">
          Evolved Instacart/Caper brand, tuned to WCAG AA. Every pair below was contrast-verified.
        </p>
      </header>

      {/* ── Color ── */}
      <section className="space-y-6">
        <H2>Color</H2>

        <div>
          <SubH>Brand green</SubH>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Swatch hex="#04372A" name="brand-900" note="Chrome / headlines — 13.3:1 on white" />
            <Swatch hex="#0B6E4F" name="brand-700" note="Primary buttons & text — 6.25:1" />
            <Swatch hex="#0E7A56" name="brand-600" note="Hover / large text — 5.33:1" />
            <Swatch hex="#43B02A" name="brand-400" note="Bright brand — fails as text" dark />
          </div>
        </div>

        <div>
          <SubH>Carrot accent</SubH>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Swatch hex="#F36D00" name="carrot-400" note="Fills / illustration only" dark />
            <Swatch hex="#B4530A" name="carrot-600" note="Accessible accent text/links — 5.0:1" />
          </div>
        </div>

        <div>
          <SubH>Surfaces</SubH>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Swatch hex="#FBF8F3" name="bg" note="App background (warm)" />
            <Swatch hex="#FFFFFF" name="surface" note="Cards & sheets" />
            <Swatch hex="#F4F1EA" name="surface-2" note="Inset / subtle fills" />
            <Swatch hex="#E4E0D8" name="line" note="Hairlines & rings" />
          </div>
        </div>

        <div>
          <SubH>Text</SubH>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Swatch hex="#13231D" name="ink" note="Primary text — 16.3:1" />
            <Swatch hex="#3A4843" name="ink-2" note="Secondary text — 9.6:1" />
            <Swatch hex="#5B6B64" name="muted" note="Tertiary / hints — 5.6:1" />
          </div>
        </div>

        <div>
          <SubH>Status tints</SubH>
          <div className="flex flex-wrap gap-3">
            {STATUS_TINTS.map((s) => (
              <span key={s.label} className={`inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold ring-1 ring-line ${s.cls}`}>
                {s.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Typography ── */}
      <section className="space-y-4">
        <H2>Typography</H2>
        <p className="text-muted">System font stack; tabular-nums for all money.</p>
        <Card className="divide-y divide-line">
          {TYPE.map((t) => (
            <div key={t.label} className="flex items-baseline justify-between gap-6 p-4">
              <span className={`${t.cls} text-ink truncate`}>{t.sample}</span>
              <span className="shrink-0 text-xs text-muted tnum">{t.label}</span>
            </div>
          ))}
        </Card>
      </section>

      {/* ── Spacing & radius ── */}
      <section className="space-y-6">
        <H2>Spacing &amp; radius</H2>
        <div className="grid md:grid-cols-2 gap-6">
          <Card className="p-5">
            <SubH>Spacing scale</SubH>
            <div className="space-y-3">
              {SPACING.map((px) => (
                <div key={px} className="flex items-center gap-3">
                  <span className="w-12 shrink-0 text-xs text-muted tnum">{px}px</span>
                  <div className="h-4 rounded bg-brand-400" style={{ width: px * 4 }} aria-hidden="true" />
                </div>
              ))}
            </div>
          </Card>
          <Card className="p-5">
            <SubH>Radius tokens</SubH>
            <div className="flex flex-wrap items-end gap-5">
              {RADII.map((r) => (
                <div key={r.name} className="text-center">
                  <div className={`w-16 h-16 bg-surface-2 ring-1 ring-line ${r.cls}`} aria-hidden="true" />
                  <div className="mt-2 text-xs font-semibold text-ink">{r.name}</div>
                  <div className="text-2xs text-muted tnum">{r.px}px</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </section>

      {/* ── Status vocabulary ── */}
      <section className="space-y-4">
        <H2>Status vocabulary</H2>
        <p className="text-muted">The one shared status set — same meaning for every persona, only the wording adapts.</p>
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wide text-muted border-b border-line">
                <th className="px-4 py-3">Key</th>
                <th className="px-4 py-3">Manager sees</th>
                <th className="px-4 py-3">Technician sees</th>
                <th className="px-4 py-3">What it means</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(STATUS).map(([key, s]) => (
                <tr key={key} className="border-b border-line last:border-0 align-top">
                  <td className="px-4 py-3"><code className="text-xs text-ink-2">{key}</code></td>
                  <td className="px-4 py-3"><StatusPill status={key} persona="manager" /></td>
                  <td className="px-4 py-3"><StatusPill status={key} persona="tech" /></td>
                  <td className="px-4 py-3 text-ink-2 max-w-md">{s.help}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      {/* ── Components gallery ── */}
      <section className="space-y-4">
        <H2>Components gallery</H2>
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardHeader title="Buttons" sub="Variants, sizes, and a busy state" icon="grid" />
            <div className="p-4 pt-2 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary">Primary</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="subtle">Subtle</Button>
                <Button variant="danger">Danger</Button>
                <Button variant="carrot">Carrot</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm">Small</Button>
                <Button size="md">Medium</Button>
                <Button size="lg">Large</Button>
                <Button busy>Submitting</Button>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Badges, flag & status pills" icon="flag" />
            <div className="p-4 pt-2 space-y-3">
              <div className="flex flex-wrap gap-2">
                <Badge tone="neutral">Neutral</Badge>
                <Badge tone="info">Info</Badge>
                <Badge tone="success">Success</Badge>
                <Badge tone="warning" icon="flag">Warning</Badge>
                <Badge tone="danger">Danger</Badge>
                <Badge tone="ap">Sent to AP</Badge>
              </div>
              <div><Flag>Over $50 — needs photo</Flag></div>
              <div className="flex flex-wrap gap-2">
                <StatusPill status="submitted" />
                <StatusPill status="approved" />
                <StatusPill status="sent_ap" />
                <StatusPill status="paid" />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Form field" sub="Inline hint and inline error" icon="edit" />
            <div className="p-4 pt-2 space-y-4">
              <Field label="Hours worked" htmlFor="ds-hours" hint="Expected 8.0 for a full day">
                <TextInput id="ds-hours" defaultValue="8.0" />
              </Field>
              <Field label="Receipt amount" htmlFor="ds-amt" required error="Receipts over $50 need a photo">
                <TextInput id="ds-amt" defaultValue="62.40" error />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="KPI stat" icon="trending" />
            <div className="p-4 pt-2">
              <KPIStat label="Avg approval time" value="6 hrs" delta="−31%" deltaTone="success" sub="was 27 hrs" icon="clock" />
            </div>
          </Card>

          <Card>
            <CardHeader title="Inline alerts" sub="All four tones" icon="info" />
            <div className="p-4 pt-2 space-y-2.5">
              <InlineAlert tone="info" title="Heads up">Your weekly invoice rolls over tonight.</InlineAlert>
              <InlineAlert tone="warning" title="One flag to resolve">Mileage exceeds the daily cap.</InlineAlert>
              <InlineAlert tone="success" title="Approved">Cleared all approvals — headed to AP.</InlineAlert>
              <InlineAlert tone="danger" title="Returned for changes">Receipt photo is missing.</InlineAlert>
            </div>
          </Card>

          <Card>
            <CardHeader title="Approval trail" sub="Accessible stepper" icon="history" />
            <div className="p-4 pt-2"><ApprovalTrail steps={TRAIL} /></div>
          </Card>

          <Card>
            <CardHeader title="Avatar" icon="user" />
            <div className="p-4 pt-2 flex items-center gap-3">
              <Avatar name="Maria Lopez" tone="brand" />
              <Avatar name="Sam Park" tone="info" />
              <Avatar name="Dana Reed" tone="carrot" />
              <Avatar name="Lee Vance" size={56} tone="brand" />
            </div>
          </Card>
        </div>
      </section>

      {/* ── Iconography ── */}
      <section className="space-y-4">
        <H2>Iconography</H2>
        <Card className="p-5">
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
            {ICONS.map((name) => (
              <div key={name} className="flex flex-col items-center gap-2 text-center">
                <span className="inline-grid place-items-center w-12 h-12 rounded-md bg-surface-2 text-ink-2"><Icon name={name} size={22} /></span>
                <span className="text-2xs text-muted truncate w-full">{name}</span>
              </div>
            ))}
          </div>
          <Divider className="my-4" />
          <p className="text-sm text-muted">Outline icons (24px, 2px stroke, round caps) for nav/actions; filled only for status.</p>
        </Card>
      </section>
    </div>
  )
}

import { useState } from 'react'
import { Card, CardHeader, KPIStat, Button, IconButton, Badge, Segmented, Field, Select, MoneyInput, Textarea, Sheet, InlineAlert, useToast } from '../../components/ui.jsx'
import { VBarRows } from '../../components/charts.jsx'
import { money, fmtDate } from '../../lib/format.js'
import { CORP_CARD, CATEGORIES, USERS, WORK_ORDERS } from '../../data/mock.js'

// Purpose: corporate-card ledger — managers file spend on behalf of techs.
// Tracked separately from reimbursable invoices (no double-count). Period totals →
// category/owner breakdowns → itemized table; "File a charge" sheet writes new rows.
export default function CorpCard({ role, nav }) {
  const toast = useToast()
  const [period, setPeriod] = useState('MTD')
  const [filing, setFiling] = useState(false)
  const [managing, setManaging] = useState(false)
  const canManage = role === 'sr_manager' || role === 'pm'

  const technicians = Object.values(USERS).filter((u) => u.role === 'technician')
  const periodTotal = { MTD: CORP_CARD.mtdCents, YTD: CORP_CARD.ytdCents, All: CORP_CARD.allCents, Custom: CORP_CARD.mtdCents }[period]

  return (
    <div className="p-5 space-y-4 max-w-content">
      {/* Period + primary action */}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented value={period} onChange={setPeriod} options={['MTD', 'YTD', 'All', 'Custom']} size="sm" />
        <div className="ml-auto flex gap-2">
          {canManage && <Button variant="secondary" size="sm" icon="settings" onClick={() => setManaging(true)}>Manage categories</Button>}
          <Button size="sm" icon="plus" onClick={() => setFiling(true)}>File a charge</Button>
        </div>
      </div>

      <InlineAlert tone="info" title="Tracked separately from invoices">
        Corporate-card spend is recorded here on behalf of technicians and never rolls into reimbursable invoices — so charges are counted once, not twice.
      </InlineAlert>

      {/* KPI strip */}
      <div className="grid grid-cols-3 gap-3">
        <KPIStat label="Spend · MTD" value={money(CORP_CARD.mtdCents)} sub="month to date" icon="card" />
        <KPIStat label="Spend · YTD" value={money(CORP_CARD.ytdCents)} sub="year to date" icon="trending" />
        <KPIStat label="All time" value={money(CORP_CARD.allCents)} sub="lifetime" icon="history" />
      </div>

      {/* Breakdowns */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="By category" sub={`${period} corporate-card spend`} icon="pie-chart" />
          <div className="p-4 pt-2"><VBarRows data={CORP_CARD.byCategory} /></div>
        </Card>
        <Card>
          <CardHeader title="By owner" sub="Who filed the charge" icon="users" />
          <div className="p-4 pt-2"><VBarRows data={CORP_CARD.byOwner} /></div>
        </Card>
      </div>

      {/* Itemized ledger */}
      <Card>
        <CardHeader title="Itemized charges" sub={`${money(periodTotal)} · ${period}`} icon="receipt" />
        <div className="px-2 pb-1 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Tech</th>
                <th className="px-3 py-2">Work order</th>
                <th className="px-3 py-2">Note</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {CORP_CARD.items.map((it) => (
                <tr key={it.id} className="border-t border-line hover:bg-surface-2">
                  <td className="px-3 py-2.5 text-ink-2 tnum whitespace-nowrap">{fmtDate(it.date)}</td>
                  <td className="px-3 py-2.5"><Badge tone="ap">{it.cat}</Badge></td>
                  <td className="px-3 py-2.5 text-ink-2 truncate">{it.tech}</td>
                  <td className="px-3 py-2.5 text-muted tnum">{it.wo}</td>
                  <td className="px-3 py-2.5 text-ink-2 truncate max-w-xs">{it.note}</td>
                  <td className="px-3 py-2.5 text-right tnum font-semibold text-ink">{money(it.amountCents)}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex gap-1 justify-end">
                      <IconButton icon="edit" label={`Edit ${it.id}`} size={32} onClick={() => toast('Editing charge', 'info')} />
                      <IconButton icon="trash" label={`Delete ${it.id}`} size={32} variant="danger" onClick={() => toast('Charge removed', 'info')} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* File-a-charge sheet */}
      <Sheet open={filing} onClose={() => setFiling(false)} title="File a charge" side="right"
        footer={<Button size="block" icon="check" onClick={() => { toast('Charge filed to corporate card'); setFiling(false) }}>Save charge</Button>}>
        <div className="space-y-4">
          <Field label="Category" htmlFor="cc-cat" required>
            <Select id="cc-cat">{CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Select>
          </Field>
          <Field label="Technician" htmlFor="cc-tech" hint="Who the spend is on behalf of">
            <Select id="cc-tech"><option value="">Unassigned</option>{technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
          </Field>
          <Field label="Work order" htmlFor="cc-wo">
            <Select id="cc-wo"><option value="">None</option>{WORK_ORDERS.map((w) => <option key={w.id} value={w.id}>{w.id} · {w.store}</option>)}</Select>
          </Field>
          <Field label="Amount" htmlFor="cc-amt" required>
            <MoneyInput id="cc-amt" placeholder="0.00" />
          </Field>
          <Field label="Note" htmlFor="cc-note" hint="What was purchased and why">
            <Textarea id="cc-note" placeholder="e.g. Flights — onsite deployment" />
          </Field>
        </div>
      </Sheet>

      {/* Manage-categories sheet (Sr / PM only) */}
      <Sheet open={managing} onClose={() => setManaging(false)} title="Manage categories" side="right">
        <p className="text-sm text-muted mb-3">Archive a category to hide it from new charges. Existing charges keep their label.</p>
        <ul className="space-y-2">
          {CORP_CARD.byCategory.map((c) => (
            <li key={c.label} className="flex items-center justify-between gap-3 py-2.5 px-3 rounded-md bg-surface-2">
              <span className="font-medium text-ink">{c.label}</span>
              <Button variant="ghost" size="sm" icon="trash" onClick={() => toast(`${c.label} archived`, 'info')}>Archive</Button>
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  )
}

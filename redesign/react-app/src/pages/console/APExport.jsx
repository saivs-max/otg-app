import { useState } from 'react'
import Icon from '../../lib/icons.jsx'
import { Card, CardHeader, KPIStat, Button, StatusPill, InlineAlert, ConfirmDialog, useToast } from '../../components/ui.jsx'
import { money, num } from '../../lib/format.js'
import { AP_BATCH } from '../../data/mock.js'

// Purpose: the weekly Accounts Payable batch run. Confirm the next run, fire it
// off, and review what's queued. The export schema is the AP-team contract
// (PRD §4.9) — described as a definition list so AP can verify columns at a glance.
const FORMAT_COLS = [
  { code: 'GL code', desc: 'General-ledger account the spend posts to' },
  { code: 'Cost center', desc: 'Region / program cost center for the charge' },
  { code: 'Payee ID', desc: 'Vendor / contractor record in AP' },
  { code: 'Amount', desc: 'Total in USD (integer cents → 2-decimal)' },
  { code: 'Work order', desc: 'Source MaintainX / Freshdesk reference' },
]
const RECENT = [
  { id: 'AP-218', date: 'Jun 12', count: 6, totalCents: 358400, status: 'sent_ap' },
  { id: 'AP-217', date: 'Jun 5', count: 5, totalCents: 291050, status: 'paid' },
  { id: 'AP-216', date: 'May 29', count: 7, totalCents: 412900, status: 'paid' },
]

export default function APExport({ role, nav }) {
  const toast = useToast()
  const [confirm, setConfirm] = useState(false)

  const batchTotal = AP_BATCH.invoices.reduce((s, i) => s + i.totalCents, 0)
  const count = AP_BATCH.invoices.length

  return (
    <div className="p-5 space-y-4 max-w-content">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-ink">AP export</h2>
        <p className="text-sm text-muted">The weekly batch that hands approved invoices to Accounts Payable</p>
      </div>

      {/* Next run */}
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid sm:grid-cols-4 gap-x-8 gap-y-3 flex-1 min-w-0">
            <Detail label="Next run" value={AP_BATCH.runAt} icon="calendar" />
            <Detail label="Cadence" value={AP_BATCH.cadence} icon="refresh" />
            <Detail label="Destination" value={AP_BATCH.to} icon="send" />
            <Detail label="Format" value={AP_BATCH.format} icon="file" />
          </div>
          <div className="flex gap-2 shrink-0">
            <Button variant="secondary" size="sm" icon="calendar" onClick={() => toast('Schedule editor opened', 'info')}>Edit schedule</Button>
            <Button size="sm" icon="send" onClick={() => setConfirm(true)}>Run export now</Button>
          </div>
        </div>
      </Card>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPIStat label="Batch total" value={money(batchTotal)} sub={AP_BATCH.id} icon="card" />
        <KPIStat label="Invoices" value={num(count, 0)} sub="queued for AP" icon="receipt" />
        <KPIStat label="This month" value={num(18, 0)} sub="sent across 3 batches" icon="paid" />
        <KPIStat label="Avg days to AP" value="2.4" sub="approval → batch" icon="clock" />
      </div>

      {/* Batch contents */}
      <Card>
        <CardHeader title="Batch contents" sub={`${AP_BATCH.id} · ${count} invoices ready to transmit`} icon="inbox" />
        <div className="px-2 pb-1 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">Technician</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {AP_BATCH.invoices.map((inv) => (
                <tr key={inv.id} className="border-t border-line hover:bg-surface-2">
                  <td className="px-3 py-2.5 font-semibold text-ink tnum">{inv.id}</td>
                  <td className="px-3 py-2.5 text-ink-2">{inv.tech}</td>
                  <td className="px-3 py-2.5 text-right tnum font-semibold text-ink">{money(inv.totalCents)}</td>
                  <td className="px-3 py-2.5"><StatusPill status="queued_ap" size="sm" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 border-t border-line text-sm text-muted">
          <span className="tnum text-ink-2 font-medium">{count}</span> invoices · <span className="tnum text-ink-2 font-medium">{money(batchTotal)}</span> total
        </div>
      </Card>

      {/* Format / schema */}
      <Card>
        <CardHeader title="Format" sub={AP_BATCH.format} icon="file" />
        <div className="px-4 pb-4 space-y-4">
          <dl className="divide-y divide-line">
            {FORMAT_COLS.map((c) => (
              <div key={c.code} className="flex items-start justify-between gap-4 py-2.5">
                <dt className="font-semibold text-ink shrink-0 w-32">{c.code}</dt>
                <dd className="text-sm text-muted text-right flex-1">{c.desc}</dd>
              </div>
            ))}
          </dl>
          <InlineAlert tone="info">
            The exact column schema is confirmed jointly with the AP team (PRD §4.9) — don't change it without sign-off.
          </InlineAlert>
        </div>
      </Card>

      {/* Recent batches */}
      <Card>
        <CardHeader title="Recent batches" sub="Transmitted and paid runs" icon="history" />
        <div className="px-2 pb-1 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2">Batch</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2 text-right">Invoices</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {RECENT.map((b) => (
                <tr key={b.id} className="border-t border-line hover:bg-surface-2">
                  <td className="px-3 py-2.5 font-semibold text-ink tnum">{b.id}</td>
                  <td className="px-3 py-2.5 tnum text-ink-2 whitespace-nowrap">{b.date}</td>
                  <td className="px-3 py-2.5 text-right tnum text-ink-2">{b.count}</td>
                  <td className="px-3 py-2.5 text-right tnum font-semibold text-ink">{money(b.totalCents)}</td>
                  <td className="px-3 py-2.5"><StatusPill status={b.status} size="sm" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Run confirm */}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => { setConfirm(false); toast('Batch AP-219 generated & emailed to AP') }}
        title="Run export now?"
        body={`This generates ${AP_BATCH.id} (${count} invoices, ${money(batchTotal)}) and emails it to Accounts Payable. It runs ahead of the scheduled time.`}
        confirmLabel="Run export now"
        tone="primary"
        itemName={`${AP_BATCH.id} → ${AP_BATCH.to}`}
      />
    </div>
  )
}

const Detail = ({ label, value, icon }) => (
  <div className="min-w-0">
    <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-muted">
      <Icon name={icon} size={13} />{label}
    </div>
    <div className="mt-1 font-medium text-ink break-words">{value}</div>
  </div>
)

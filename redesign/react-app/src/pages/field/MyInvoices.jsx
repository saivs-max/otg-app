import { useState } from 'react'
import { Card, StatusPill, Segmented, EmptyState, Button } from '../../components/ui.jsx'
import { money, weekLabel, num } from '../../lib/format.js'
import { useData } from '../../data/DataProvider.jsx'

// Purpose: see every invoice and exactly where it is in the approval chain.
// "Sent to AP" and "Paid" are visibly distinct (QA review UX #9).
const ACTIVE = ['draft', 'submitted', 'in_review', 'needs_fixes', 'awaiting_sr']
export default function MyInvoices({ me, nav }) {
  const { invoices } = useData()
  const [tab, setTab] = useState('active')
  // API already scopes to the current user; still filter by me.id when present.
  const mine = (invoices || []).filter((i) => (me?.id ? i.techId === me.id : true))
  const list = mine.filter((i) => (tab === 'active' ? ACTIVE.includes(i.status) : !ACTIVE.includes(i.status)))

  return (
    <div className="p-4 space-y-3.5 pb-6">
      <Segmented value={tab} onChange={setTab} options={[{ value: 'active', label: `Active · ${mine.filter((i) => ACTIVE.includes(i.status)).length}` }, { value: 'history', label: 'History' }]} />
      {list.length === 0 ? (
        <EmptyState icon="file" title="Nothing here yet" body="Submitted and paid invoices will show up here." />
      ) : list.map((inv) => (
        <Card key={inv.id} as="button" className="w-full text-left p-4 hover:shadow-card-hover transition-shadow" onClick={() => nav('detail', { id: inv.numId })}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-ink">Week of {weekLabel(inv.week)}</span>
            <StatusPill status={inv.status} persona="tech" size="sm" />
          </div>
          <div className="mt-1 flex items-end justify-between">
            <span className="text-sm text-muted tnum">{inv.id} · {num(inv.hours || 0)} hrs</span>
            <span className="text-xl font-bold text-ink tnum">{money(inv.totalCents)}</span>
          </div>
          {inv.status === 'needs_fixes' && <p className="mt-2 text-sm text-danger-fg font-medium">Tap to see what to fix →</p>}
          {inv.status === 'paid' && <p className="mt-2 text-sm text-success-fg font-medium">Paid {inv.paidAt && `· ${inv.paidAt}`}</p>}
        </Card>
      ))}
    </div>
  )
}

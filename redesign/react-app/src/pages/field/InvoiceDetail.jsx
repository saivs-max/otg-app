import { useEffect, useState } from 'react'
import { Card, CardHeader, StatusPill, ApprovalTrail, InlineAlert, Button, Row, Divider, Flag, Skeleton } from '../../components/ui.jsx'
import { money, num, weekLabel } from '../../lib/format.js'
import { useData } from '../../data/DataProvider.jsx'

// Purpose: show exactly where the invoice is, who has it, how long it's sat,
// and — if returned — precisely what to fix.
export default function InvoiceDetail({ me, nav, params }) {
  const { getInvoice } = useData()
  const [inv, setInv] = useState(null)

  useEffect(() => {
    let alive = true
    setInv(null)
    getInvoice(params?.id).then((r) => { if (alive) setInv(r) }).catch(() => { if (alive) setInv(null) })
    return () => { alive = false }
  }, [params?.id])

  if (!inv) return (
    <div className="p-4 space-y-3.5 pb-6">
      <Card className="p-4 space-y-3"><Skeleton className="h-5 w-32" /><Skeleton className="h-9 w-40" /></Card>
      <Skeleton className="h-20 w-full" />
      <Card className="p-4 space-y-3"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-2/3" /></Card>
    </div>
  )

  const warn = inv.status === 'awaiting_sr' || inv.flags > 0
  return (
    <div className="p-4 space-y-3.5 pb-6">
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted">{inv.id}</p>
            <h2 className="text-xl font-bold text-ink">Week of {weekLabel(inv.week)}</h2>
          </div>
          <StatusPill status={inv.status} persona="tech" />
        </div>
        <Divider className="my-3" />
        <div className="flex items-center justify-between">
          <span className="font-semibold text-ink">Total</span>
          <span className="text-2xl font-bold text-brand-700 tnum">{money(inv.totalCents)}</span>
        </div>
        <p className="text-sm text-muted tnum mt-0.5">{num(inv.hours)} hrs · {inv.miles} mi</p>
      </Card>

      {warn ? (
        <InlineAlert tone="warning" title="With your senior manager">
          Flagged or over the $5,000 threshold. Your Ops Manager already approved it — this is just a second sign-off.
        </InlineAlert>
      ) : (
        <p className="text-sm text-muted px-1">{`Status: ${inv.id} is currently ${weekLabel(inv.week)}’s invoice.`}</p>
      )}

      <CardHeader title="Approval status" icon="check-circle" />
      <Card className="p-4"><ApprovalTrail steps={inv.trail || []} /></Card>

      <CardHeader title="Work orders" />
      {(inv.lines || []).map((l, i) => (
        <Card key={i} className="p-3.5">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-ink">{l.store}</span>
            <span className="tnum font-semibold">{money(l.amountCents)}</span>
          </div>
          <p className="text-sm text-muted">{l.wo} · {l.type} · {num(l.hours)} hrs</p>
          {l.flag && <div className="mt-2"><Flag>{l.flag}</Flag></div>}
        </Card>
      ))}

      <Button variant="secondary" size="block" icon="file">Download invoice PDF</Button>
    </div>
  )
}

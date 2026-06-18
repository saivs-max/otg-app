import { useEffect, useState } from 'react'
import Icon from '../../lib/icons.jsx'
import { Card, CardHeader, Button, StatusPill, Flag, Avatar, Field, Textarea, InlineAlert, ApprovalTrail, Row, Divider, Skeleton, useToast, Segmented } from '../../components/ui.jsx'
import { money, num, weekLabel } from '../../lib/format.js'
import { useData } from '../../data/DataProvider.jsx'

// Purpose: everything needed to decide in one view — the document on the left,
// the decision (approve / request changes) on the right, with the WO context,
// policy checks, and trail inline so the reviewer never opens Freshdesk/MaintainX.
export default function ConsoleInvoiceDetail({ role, nav, params }) {
  const toast = useToast()
  const { getInvoice, actions } = useData()
  const [inv, setInv] = useState(null)
  const [mode, setMode] = useState(null) // 'reject'
  const [reason, setReason] = useState('')
  const [approving, setApproving] = useState(false)
  const [rejecting, setRejecting] = useState(false)

  useEffect(() => {
    let alive = true
    setInv(null)
    getInvoice(params?.id).then((r) => { if (alive) setInv(r) }).catch(() => { if (alive) setInv(null) })
    return () => { alive = false }
  }, [params?.id])

  if (!inv) return (
    <div className="p-5 grid lg:grid-cols-[1fr_360px] gap-4 max-w-content items-start">
      <div className="space-y-4">
        <Card className="p-5 space-y-3"><Skeleton className="h-12 w-12 rounded-full" /><Skeleton className="h-5 w-48" /><Skeleton className="h-16 w-full" /></Card>
        <Card className="p-5 space-y-3"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-3/4" /></Card>
      </div>
      <Card className="p-4 space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></Card>
    </div>
  )

  const tech = inv.tech || { name: '—', type: '' }

  const doApprove = async () => {
    setApproving(true)
    try {
      await actions.approve(inv.numId)
      toast(`${inv.id} ${role === 'sr_manager' ? 'signed off' : 'approved'} → queued for AP`)
      nav('approvals')
    } catch (err) {
      toast(err.message, 'danger')
    } finally {
      setApproving(false)
    }
  }

  const doReject = async () => {
    setRejecting(true)
    try {
      await actions.reject(inv.numId, reason)
      toast('Returned to technician with your note')
      nav('approvals')
    } catch (err) {
      toast(err.message, 'danger')
    } finally {
      setRejecting(false)
    }
  }

  return (
    <div className="p-5 grid lg:grid-cols-[1fr_360px] gap-4 max-w-content items-start">
      {/* Document */}
      <div className="space-y-4">
        <Card className="p-5">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <Avatar name={tech.name} size={48} />
              <div>
                <h2 className="text-lg font-bold">{tech.name}</h2>
                <p className="text-sm text-muted">{tech.type} · {inv.id} · Week of {weekLabel(inv.week)}</p>
              </div>
            </div>
            <StatusPill status={inv.status} />
          </div>
          <Divider className="my-4" />
          <div className="grid grid-cols-3 gap-4 text-center">
            <Metric label="Labor" value={money(inv.laborCents)} sub={`${num(inv.hours)} hrs`} />
            <Metric label="Expenses" value={money(inv.expenseCents)} sub={`${inv.miles} mi`} />
            <Metric label="Total" value={money(inv.totalCents)} strong />
          </div>
        </Card>

        <Card>
          <CardHeader title="Work orders" sub="Source, store & expected hours shown inline" icon="briefcase" />
          <div className="px-2 pb-2">
            {(inv.lines || []).map((l, i) => (
              <div key={i} className="px-3 py-3 border-t border-line first:border-0">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{l.store}</span>
                  <span className="tnum font-semibold">{money(l.amountCents)}</span>
                </div>
                <div className="text-sm text-muted">{l.wo} · {l.type} · {num(l.hours)} hrs</div>
                {l.flag && <div className="mt-2 flex items-center gap-2"><Flag>{l.flag}</Flag></div>}
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          <CardHeader title="Policy checks" icon="shield" />
          <div className="px-1">
            <Check ok label="Mileage at locked IRS rate ($0.725)" />
            <Check ok label="Receipts attached where required" />
            <Check label="Total exceeds $5,000 → needs senior sign-off" tone="warning" />
          </div>
        </Card>
      </div>

      {/* Decision panel (sticky) */}
      <div className="space-y-4 lg:sticky lg:top-4">
        {inv.opsNote && <InlineAlert tone="info" title="Ops Manager note">{inv.opsNote}</InlineAlert>}
        <Card className="p-4">
          <CardHeader title={role === 'sr_manager' ? 'Your sign-off' : 'Your decision'} />
          {!mode ? (
            <div className="space-y-2 px-1 pb-1">
              <Button size="block" icon="check" busy={approving} onClick={doApprove}>
                {role === 'sr_manager' ? 'Sign off & queue for AP' : 'Approve'}
              </Button>
              <Button variant="secondary" size="block" icon="edit" onClick={() => setMode('reject')}>Request changes</Button>
              <p className="text-2xs text-muted text-center pt-1">SLA: 3 business days · 4 days elapsed</p>
            </div>
          ) : (
            <div className="space-y-3 px-1 pb-1">
              <Field label="What needs fixing?" required hint="Min 10 characters — goes straight to the technician."
                error={reason.length > 0 && reason.trim().length < 10 ? 'A bit more detail helps the tech fix it fast.' : ''}>
                <Textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Please attach the toll receipt for the $16.50 GSP charge." />
              </Field>
              <Button variant="danger" size="block" busy={rejecting} disabled={reason.trim().length < 10} onClick={doReject}>Send back to {tech.name.split(' ')[0]}</Button>
              <Button variant="ghost" size="block" onClick={() => setMode(null)}>Cancel</Button>
            </div>
          )}
        </Card>

        <Card className="p-4">
          <CardHeader title="Approval trail" />
          <div className="px-1"><ApprovalTrail steps={inv.trail || []} /></div>
        </Card>
      </div>
    </div>
  )
}
const Metric = ({ label, value, sub, strong }) => (
  <div>
    <div className="text-2xs uppercase tracking-wide text-muted">{label}</div>
    <div className={`tnum font-bold ${strong ? 'text-2xl text-brand-700' : 'text-lg text-ink'}`}>{value}</div>
    {sub && <div className="text-2xs text-muted tnum">{sub}</div>}
  </div>
)
const Check = ({ ok, label, tone }) => (
  <div className="flex items-center gap-2 py-1.5 text-sm">
    <Icon name={ok ? 'check-circle' : 'alert'} size={16} className={ok ? 'text-success-fg' : 'text-warning-fg'} fill={ok} />
    <span className={tone === 'warning' ? 'text-warning-fg' : 'text-ink-2'}>{label}</span>
  </div>
)

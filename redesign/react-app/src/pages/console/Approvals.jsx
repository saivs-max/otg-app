import { useState } from 'react'
import Icon from '../../lib/icons.jsx'
import { Card, Button, StatusPill, Flag, Badge, Avatar, Tabs, InlineAlert, useToast, ConfirmDialog, Segmented } from '../../components/ui.jsx'
import { money, num, weekLabel } from '../../lib/format.js'
import { useData } from '../../data/DataProvider.jsx'

// Purpose: clear the queue fast. Flagged & aging float to the top; clean invoices
// get a one-tap approve; flagged ones open the detail. Sr Manager sees only the
// skip-level sign-offs (their judgment, not every clean invoice — PRD §3.3).
export default function Approvals({ role, nav }) {
  const toast = useToast()
  const { queue, actions } = useData()
  const [tab, setTab] = useState('pending')
  const [confirm, setConfirm] = useState(null)

  const all = queue || []
  const visible = role === 'sr_manager' ? all.filter((i) => i.status === 'awaiting_sr') : all
  // flagged + oldest first
  const sorted = [...visible].sort((a, b) => ((b.flags || 0) - (a.flags || 0)) || ((b.ageDays || 0) - (a.ageDays || 0)))
  const agingCount = sorted.filter((i) => (i.ageDays || 0) >= 3).length
  const cleanCount = sorted.filter((i) => !i.flags).length

  const approveAllClean = async () => {
    const clean = sorted.filter((i) => !i.flags)
    if (!clean.length) { toast('No clean invoices to approve'); return }
    try {
      for (const i of clean) await actions.approve(i.numId)
      toast(`${clean.length} clean invoice${clean.length > 1 ? 's' : ''} approved → queued for AP`)
    } catch (err) {
      toast(err.message, 'danger')
    }
  }

  const doApprove = async () => {
    const item = confirm
    setConfirm(null)
    try {
      await actions.approve(item.numId)
      toast(`${item.id} approved → queued for AP`)
    } catch (err) {
      toast(err.message, 'danger')
    }
  }

  return (
    <div className="p-5 space-y-4 max-w-content">
      {role === 'sr_manager'
        ? <InlineAlert tone="info" title="Senior sign-off queue">You only see invoices that were flagged or exceed $5,000 — the ones that need your judgment. Everything clean was already approved by Ops.</InlineAlert>
        : <div className="flex items-center gap-3">
            <Tabs value={tab} onChange={setTab} tabs={[{ value: 'pending', label: 'Pending', count: sorted.length }, { value: 'aging', label: 'Aging', count: agingCount }, { value: 'all', label: 'All' }]} />
            <div className="ml-auto"><Button variant="secondary" size="sm" icon="check" onClick={approveAllClean}>Approve all clean ({cleanCount})</Button></div>
          </div>}

      {sorted.map((item) => {
        const aging = (item.ageDays || 0) >= 3
        const clean = !item.flags
        return (
          <Card key={item.numId} className="p-4">
            <div className="flex items-start gap-4">
              <Avatar name={item.techName || '—'} size={44} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-ink">{item.techName}</span>
                  <Badge tone="neutral">{item.techType}</Badge>
                  <StatusPill status={item.status} size="sm" />
                  {item.flags > 0 && <Flag size="sm">{item.flags} flag{item.flags > 1 ? 's' : ''}</Flag>}
                  {aging && <Badge tone="danger" icon="clock">{item.ageDays}d in queue</Badge>}
                </div>
                <div className="mt-1 text-sm text-muted tnum">{item.id}</div>
                {item.flags > 0 && item.flagPreview && (
                  <p className="mt-1.5 text-sm text-warning-fg flex items-center gap-1.5"><Icon name="alert" size={14} />{item.flagPreview}</p>
                )}
                {item.opsNote && <p className="mt-1.5 text-sm text-ink-2 bg-surface-2 rounded-md p-2">Ops note: {item.opsNote}</p>}
              </div>
              <div className="text-right shrink-0">
                <div className="text-xl font-bold text-ink tnum">{money(item.totalCents)}</div>
                <div className="mt-2 flex gap-2 justify-end">
                  <Button variant="secondary" size="sm" onClick={() => nav('invoiceDetail', { id: item.numId })}>Review</Button>
                  {clean
                    ? <Button size="sm" icon="check" onClick={() => setConfirm(item)}>Approve</Button>
                    : role === 'sr_manager'
                      ? <Button size="sm" icon="check" onClick={() => setConfirm(item)}>Sign off</Button>
                      : null}
                </div>
              </div>
            </div>
          </Card>
        )
      })}

      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} tone="primary" confirmLabel="Approve"
        title="Approve invoice?" itemName={confirm && `${confirm.techName} · ${money(confirm.totalCents)}`}
        body={confirm?.flags ? 'This will sign off the flagged invoice and queue it for AP.' : 'Clean invoice — this routes straight to the AP queue.'}
        onConfirm={doApprove} />
    </div>
  )
}

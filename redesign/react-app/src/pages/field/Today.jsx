import { useEffect, useState } from 'react'
import Icon from '../../lib/icons.jsx'
import { Card, CardHeader, Button, StatusPill, Flag, InlineAlert, EmptyState, Row } from '../../components/ui.jsx'
import { money, weekLabel } from '../../lib/format.js'
import { useData } from '../../data/DataProvider.jsx'

// Purpose: a glanceable home. Active timer + this week's running total + things
// that need attention, with one-tap access to clock-in and add-expense.
export default function Today({ me, nav }) {
  const { current, activeTimers, workOrders } = useData()
  const draft = current
  const t = (activeTimers || [])[0]
  const wo = t ? (workOrders || []).find((w) => w.numId === t.woNumId || w.id === t.woId) : null
  const elapsed = useElapsed(t?.startedAt)
  const hrs = elapsed / 3600

  return (
    <div className="p-4 space-y-3.5 pb-6">
      <div>
        <p className="text-muted text-sm">Good morning,</p>
        <h2 className="text-2xl font-bold text-ink">{me.name.split(' ')[0]} 👋</h2>
      </div>

      {/* This week summary */}
      {draft ? (
        <Card className="p-4 bg-brand-900 text-white ring-brand-900">
          <div className="flex items-center justify-between">
            <span className="text-sm text-brand-100">This week · {weekLabel(draft.week)}</span>
            <StatusPill status={draft.status} persona="tech" />
          </div>
          <div className="mt-1 text-4xl font-bold tnum">{money(draft.totalCents)}</div>
          <div className="mt-1 text-sm text-brand-100 tnum">{draft.hours} hrs · {draft.miles} mi · {draft.lines.length} work orders</div>
          <Button variant="carrot" size="block" className="mt-3" iconRight="arrow-right" onClick={() => nav('invoice')}>Review &amp; submit invoice</Button>
        </Card>
      ) : (
        <Card className="p-4">
          <EmptyState icon="file" title="No open invoice this week" body="Clock in to a work order or add an expense to start this week’s invoice." />
        </Card>
      )}

      {/* Active timer — the most important live object */}
      {t ? (
        <Card className="p-4 ring-2 ring-brand-400">
          <div className="flex items-center gap-2 text-success-fg text-sm font-semibold">
            <span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse" /> Clocked in
          </div>
          <div className="mt-1 font-mono text-4xl font-bold text-ink tnum">{fmtClock(elapsed)}</div>
          <p className="mt-1 text-ink-2 font-medium">{wo?.store || t.store}</p>
          <p className="text-sm text-muted">{wo?.id || t.woId} · {wo?.type || t.type} · {(wo?.carts ?? t.carts) || 0} carts</p>
          <div className="mt-2 text-sm bg-surface-2 rounded-md p-2 text-ink-2 flex items-center gap-2">
            <Icon name="gauge" size={15} className="text-brand-700" />
            Expected ~{wo?.expHrs ?? '—'} hrs for this job{wo?.expHrs && hrs > wo.expHrs ? ' · you’re over — that’s fine, just confirm at submit' : ''}
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" size="block" icon="map-pin">Open job</Button>
            <Button variant="danger" size="block" icon="square" onClick={() => nav('timer')}>Clock out</Button>
          </div>
        </Card>
      ) : (
        <Card className="p-4">
          <EmptyState icon="clock" title="Not clocked in" body="Start the clock when you arrive at a work order — we’ll capture GPS." />
          <Button size="block" icon="clock" className="mt-3" onClick={() => nav('timer')}>Clock in</Button>
        </Card>
      )}

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-3">
        <QuickAction icon="clock" label="Clock in" sub="to a work order" onClick={() => nav('timer')} />
        <QuickAction icon="receipt" label="Add expense" sub="mileage, tolls…" onClick={() => nav('add')} />
      </div>

      {/* Needs attention — error prevention before submit */}
      {draft && draft.flags > 0 && (
        <>
          <CardHeader title="Before you submit" sub={`${draft.flags} ${draft.flags === 1 ? 'thing needs' : 'things need'} a quick fix`} />
          <InlineAlert tone="warning" title="Receipt missing" action={<Button size="sm" variant="secondary" onClick={() => nav('add')}>Add receipt</Button>}>
            Tools &amp; Supplies — {money(8900)} is over the $50 receipt limit.
          </InlineAlert>
          <InlineAlert tone="warning" title="Labor over expected" action={<Button size="sm" variant="secondary" onClick={() => nav('invoice')}>Add a note</Button>}>
            Hackensack retrofit ran 11.2 hrs vs ~7 expected. A one-line note clears it.
          </InlineAlert>
        </>
      )}
    </div>
  )
}

function QuickAction({ icon, label, sub, onClick }) {
  return (
    <button onClick={onClick} className="bg-surface rounded-lg ring-1 ring-line shadow-card p-4 text-left hover:shadow-card-hover transition-shadow">
      <span className="grid place-items-center w-10 h-10 rounded-lg bg-brand-50 text-brand-700"><Icon name={icon} size={22} /></span>
      <div className="mt-2 font-semibold text-ink">{label}</div>
      <div className="text-sm text-muted">{sub}</div>
    </button>
  )
}

function useElapsed(startIso) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i) }, [])
  if (!startIso) return 0
  return Math.max(0, Math.floor((now - new Date(startIso).getTime()) / 1000)) % (12 * 3600) + 8160
}
function fmtClock(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

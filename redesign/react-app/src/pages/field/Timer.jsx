import { useState } from 'react'
import Icon from '../../lib/icons.jsx'
import { Card, Button, Sheet, Field, TextInput, Select, SearchInput, Badge, InlineAlert, useToast, ConfirmDialog } from '../../components/ui.jsx'
import { money, fmtDateLong, num } from '../../lib/format.js'
import { WORK_ORDERS, WEEK_TIME } from '../../data/mock.js'
import { useData } from '../../data/DataProvider.jsx'

// Purpose: clock in/out against a work order, see today's entries, and log a
// past shift if they forgot. WO picker shows source/type/expected hrs up front.
export default function Timer({ me, nav }) {
  const toast = useToast()
  const { workOrders, activeTimers, actions } = useData()
  const [pick, setPick] = useState(false)
  const [past, setPast] = useState(false)
  const [confirmOut, setConfirmOut] = useState(false)
  const t = (activeTimers || [])[0]
  const activeWo = t ? (workOrders || []).find((w) => w.numId === t.woNumId || w.id === t.woId) : null

  const onPick = async (w) => {
    try {
      await actions.clockIn(w.numId)
      setPick(false)
      toast('Clocked in · GPS captured')
    } catch (err) {
      toast(err.message, 'danger')
    }
  }

  const onClockOut = async () => {
    setConfirmOut(false)
    try {
      await actions.clockOut(t.id, {})
      toast('Clocked out · hours added')
    } catch (err) {
      toast(err.message, 'danger')
    }
  }

  return (
    <div className="p-4 space-y-3.5 pb-6">
      {/* Running timer */}
      {t && (
        <Card className="p-4 ring-2 ring-brand-400">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-success-fg text-sm font-semibold"><span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse" />Running</span>
            <Badge tone="success" icon="map-pin">GPS captured</Badge>
          </div>
          <div className="mt-1 font-mono text-4xl font-bold tnum text-ink">2:16:40</div>
          <p className="mt-1 font-medium text-ink-2">{activeWo?.store || t.store}</p>
          <p className="text-sm text-muted">{activeWo?.id || t.woId} · {activeWo?.type || t.type}</p>
          <Button variant="danger" size="block" className="mt-3" icon="square" onClick={() => setConfirmOut(true)}>Clock out</Button>
        </Card>
      )}

      {/* Primary actions */}
      <Button variant="primary" size="block" icon="clock" onClick={() => setPick(true)}>{t ? 'Clock in to another work order' : 'Clock in'}</Button>
      <button onClick={() => setPast(true)} className="w-full flex items-center justify-center gap-2 text-brand-700 font-semibold py-2.5 text-sm">
        <Icon name="history" size={16} /> Forgot to clock in? Log a past shift
      </button>

      {/* This week's entries */}
      <h3 className="font-semibold text-ink pt-2">This week</h3>
      {WEEK_TIME.map((e) => {
        const wo = WORK_ORDERS.find((w) => w.id === e.woId)
        return (
          <Card key={e.id} className="p-3.5">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="font-medium text-ink truncate">{wo.store}</p>
                <p className="text-sm text-muted">{fmtDateLong(e.date)} · {wo.id}</p>
              </div>
              <div className="text-right shrink-0">
                <div className="tnum font-semibold text-ink">{e.running ? 'Running' : `${num(e.hours)} hrs`}</div>
                {e.expHrs && !e.running && <div className="text-2xs text-muted tnum">exp ~{e.expHrs}</div>}
              </div>
            </div>
            {e.flag && <div className="mt-2"><InlineAlert tone="warning">{e.flag}</InlineAlert></div>}
          </Card>
        )
      })}

      {/* WO picker */}
      <WoPickerSheet open={pick} onClose={() => setPick(false)} workOrders={workOrders} onPick={onPick} />

      {/* Log past shift */}
      <Sheet open={past} onClose={() => setPast(false)} title="Log a past shift"
        footer={<Button size="block" onClick={() => { setPast(false); toast('Past shift added to this week’s invoice') }}>Save shift</Button>}>
        <div className="space-y-3">
          <InlineAlert tone="info">No GPS for past shifts — they’re marked “manually entered” for your manager.</InlineAlert>
          <Field label="Work order" required><Select><option>MX-RTR-2406-127 · Whole Foods Edgewater</option>{WORK_ORDERS.map((w) => <option key={w.id}>{w.id} · {w.store}</option>)}</Select></Field>
          <Field label="Date" required><TextInput type="date" defaultValue="2026-06-16" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start" required><TextInput type="time" defaultValue="08:30" /></Field>
            <Field label="End" required><TextInput type="time" defaultValue="13:00" /></Field>
          </div>
          <Field label="Break (min)" hint="Breaks over 30 min auto-deduct."><TextInput type="number" defaultValue="30" /></Field>
        </div>
      </Sheet>

      <ConfirmDialog open={confirmOut} onClose={() => setConfirmOut(false)} tone="primary" confirmLabel="Clock out"
        title="Clock out?" itemName={activeWo ? `${activeWo.store} · 2:16 elapsed` : (t ? `${t.store} · 2:16 elapsed` : '')} body="We’ll capture your GPS location and add these hours to this week’s invoice."
        onConfirm={onClockOut} />
    </div>
  )
}

export function WoPickerSheet({ open, onClose, onPick, workOrders }) {
  const [q, setQ] = useState('')
  const all = workOrders && workOrders.length ? workOrders : WORK_ORDERS
  const list = all.filter((w) => (w.store + w.id + w.type).toLowerCase().includes(q.toLowerCase()))
  return (
    <Sheet open={open} onClose={onClose} title="Pick a work order">
      <SearchInput placeholder="Search store, WO ID, type…" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
      <div className="space-y-2">
        {list.map((w) => (
          <button key={w.id} onClick={() => onPick(w)} className="w-full text-left bg-surface ring-1 ring-line rounded-lg p-3 hover:ring-brand-700 hover:bg-brand-50/40">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink truncate">{w.store}</span>
              <Badge tone={w.source === 'MaintainX' ? 'info' : 'ap'}>{w.source}</Badge>
            </div>
            <div className="text-sm text-muted mt-0.5">{w.id} · {w.type} · {w.carts} carts</div>
            <div className="text-sm text-ink-2 mt-1 line-clamp-1">{w.desc}</div>
            <div className="mt-1.5 flex items-center gap-2 text-2xs text-muted"><Icon name="gauge" size={13} className="text-brand-700" />Expected ~{w.expHrs} hrs · {fmtDateLong(w.date)}</div>
          </button>
        ))}
        <button className="w-full text-brand-700 font-semibold text-sm py-3">+ Work order not listed? Paste a ticket URL</button>
      </div>
    </Sheet>
  )
}

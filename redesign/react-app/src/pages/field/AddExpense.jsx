import { useState } from 'react'
import Icon from '../../lib/icons.jsx'
import { Card, Button, Field, TextInput, MoneyInput, Select, Textarea, Badge, InlineAlert, useToast, Row } from '../../components/ui.jsx'
import { money, fmtDate } from '../../lib/format.js'
import { CATEGORIES, WORK_ORDERS } from '../../data/mock.js'
import { useData } from '../../data/DataProvider.jsx'

const RATE = 0.725
// Map the UI category key → the API expense payload shape.
const CAT_BODY = {
  mileage: (miles) => ({ category: 'mileage', quantity: Number(miles) }),
  tolls:   () => ({ category: 'tolls' }),
  parking: () => ({ category: 'parking' }),
  meals:   () => ({ category: 'other', subcategory: 'Meal' }),
  tools:   () => ({ category: 'other', subcategory: 'Tools' }),
  other:   () => ({ category: 'other', subcategory: 'Misc' }),
}
// Purpose: log one expense with as little friction as possible. Category-aware
// form, live computed amount, receipt rule enforced inline, preview before save.
export default function AddExpense({ me, nav }) {
  const toast = useToast()
  const { workOrders, current, actions } = useData()
  const wos = workOrders && workOrders.length ? workOrders : WORK_ORDERS
  const [cat, setCat] = useState('mileage')
  const [miles, setMiles] = useState('')
  const [amount, setAmount] = useState('')
  const [wo, setWo] = useState(wos[0]?.numId ?? wos[0]?.id)
  const [date, setDate] = useState('2026-06-17')
  const [note, setNote] = useState('')
  const [receipt, setReceipt] = useState(false)
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [touched, setTouched] = useState(false)

  const c = CATEGORIES.find((x) => x.key === cat)
  const computed = cat === 'mileage' ? Math.round((parseFloat(miles) || 0) * RATE * 100) : Math.round((parseFloat(amount) || 0) * 100)
  const needsReceipt = computed > 5000 && !receipt
  const valid = computed > 0 && !needsReceipt
  const weekExpenses = current?.expenses || []

  const onSave = async () => {
    setSaving(true)
    try {
      const body = {
        ...CAT_BODY[cat](miles),
        work_order_id: Number(wo),
        expense_date: date,
        amount: computed / 100,
        description: note,
      }
      await actions.addExpense(body)
      toast('Expense added to this week’s invoice')
      nav('invoice')
    } catch (err) {
      toast(err.message, 'danger')
    } finally {
      setSaving(false)
    }
  }

  if (preview) return <Preview {...{ c, cat, wo, wos, computed, miles, receipt, saving }} onEdit={() => setPreview(false)} onSave={onSave} />

  return (
    <div className="p-4 space-y-4 pb-6">
      {/* Invoice context banner — they always know where this lands */}
      <div className="flex items-center gap-2 text-sm bg-brand-50 text-brand-800 rounded-md p-2.5 ring-1 ring-brand-100">
        <Icon name="file" size={16} /> Posting to <strong>this week’s invoice</strong> · INV-2480
      </div>

      <Field label="Category">
        <div className="grid grid-cols-3 gap-2">
          {CATEGORIES.map((x) => (
            <button key={x.key} onClick={() => setCat(x.key)}
              className={`flex flex-col items-center gap-1 rounded-lg py-3 ring-1 text-sm ${cat === x.key ? 'bg-brand-50 ring-brand-700 text-brand-800 font-semibold' : 'bg-surface ring-line text-ink-2'}`}>
              <Icon name={x.icon} size={20} />{x.label.split(' ')[0]}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Work order" required>
        <Select value={wo} onChange={(e) => setWo(e.target.value)}>
          {wos.map((w) => <option key={w.numId ?? w.id} value={w.numId ?? w.id}>{w.id} · {w.store}</option>)}
        </Select>
      </Field>

      {cat === 'mileage' ? (
        <Field label="Miles driven" required hint={`Auto-calculated at IRS ${RATE.toFixed(3)}/mi`} error={touched && !miles ? 'Enter the miles you drove' : ''}>
          <TextInput inputMode="decimal" placeholder="42" value={miles} onChange={(e) => { setMiles(e.target.value); setTouched(true) }} />
        </Field>
      ) : (
        <Field label="Amount" required error={touched && !amount ? 'Enter an amount' : ''}>
          <MoneyInput placeholder="0.00" value={amount} onChange={(e) => { setAmount(e.target.value); setTouched(true) }} />
          {c.cap && <p className="mt-1.5 text-sm text-muted">{c.cap}</p>}
        </Field>
      )}

      <Field label="Date"><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Note" hint={cat === 'other' ? 'Required for “Other”.' : 'Optional'}><Textarea placeholder="What was this for?" value={note} onChange={(e) => setNote(e.target.value)} /></Field>

      {/* Receipt — rule enforced inline, not after submit */}
      <Field label="Receipt" error={needsReceipt ? 'Charges over $50 need a receipt before you can save.' : ''}>
        {receipt ? (
          <div className="flex items-center gap-3 bg-surface-2 rounded-md p-3">
            <span className="w-12 h-12 rounded-md bg-brand-100 grid place-items-center text-brand-700"><Icon name="receipt" size={22} /></span>
            <span className="flex-1 text-sm text-ink-2">receipt_0617.jpg</span>
            <button onClick={() => setReceipt(false)} className="text-danger-fg" aria-label="Remove receipt"><Icon name="trash" size={18} /></button>
          </div>
        ) : (
          <button onClick={() => setReceipt(true)} className="w-full flex items-center justify-center gap-2 h-12 rounded-md ring-1 ring-dashed ring-line text-ink-2 hover:bg-surface-2">
            <Icon name="camera" size={18} /> Take photo or upload
          </button>
        )}
      </Field>

      {/* Live computed amount */}
      <Card className="p-4 flex items-center justify-between">
        <span className="text-muted">Amount</span>
        <span className="text-2xl font-bold text-brand-700 tnum">{money(computed)}</span>
      </Card>

      <Button size="block" iconRight="eye" disabled={!valid} onClick={() => valid ? setPreview(true) : setTouched(true)}>Preview</Button>

      {/* This week list */}
      <h3 className="font-semibold text-ink pt-2">Added this week</h3>
      <Card className="p-4">
        {weekExpenses.map((e) => (
          <Row key={e.id} label={CATEGORIES.find((c) => c.key === e.cat)?.label || e.cat} sub={`${fmtDate(e.date)} · ${e.desc}`} value={money(e.amountCents)} />
        ))}
      </Card>
    </div>
  )
}

function Preview({ c, wo, wos, computed, miles, receipt, saving, onEdit, onSave }) {
  const list = wos && wos.length ? wos : WORK_ORDERS
  const w = list.find((x) => (x.numId ?? x.id) === wo) || list[0]
  return (
    <div className="p-4 space-y-4">
      <InlineAlert tone="info" title="Review before saving">Check the details — you can edit anything.</InlineAlert>
      <Card className="p-4 space-y-1">
        <Row label="Category" value={c.label} strong />
        <Row label="Work order" value={w?.id} sub={w?.store} />
        {c.key === 'mileage' && <Row label="Miles" value={`${miles || 0} mi`} />}
        <Row label="Receipt" value={receipt ? 'Attached' : '—'} />
        <div className="flex items-center justify-between pt-3">
          <span className="text-muted">Amount</span><span className="text-2xl font-bold text-brand-700 tnum">{money(computed)}</span>
        </div>
      </Card>
      <div className="flex gap-3">
        <Button variant="subtle" size="block" icon="chevron-left" onClick={onEdit}>Edit</Button>
        <Button size="block" icon="check" busy={saving} onClick={onSave}>Save to invoice</Button>
      </div>
    </div>
  )
}

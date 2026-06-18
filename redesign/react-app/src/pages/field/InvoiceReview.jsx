import { useState } from 'react'
import Icon from '../../lib/icons.jsx'
import { Card, CardHeader, Button, Sheet, Field, Textarea, Flag, StatusPill, InlineAlert, EmptyState, Row, Divider, useToast, ConfirmDialog } from '../../components/ui.jsx'
import { money, num, weekLabel } from '../../lib/format.js'
import { CATEGORIES } from '../../data/mock.js'
import { useData } from '../../data/DataProvider.jsx'

// Purpose: review the auto-rolled weekly invoice and submit. Flags are explained
// in plain language with the exact fix; submit is blocked until they're resolved
// or justified — error prevention, not after-the-fact rejection.
export default function InvoiceReview({ me, nav }) {
  const toast = useToast()
  const { current, actions } = useData()
  const inv = current
  const [justify, setJustify] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [editLine, setEditLine] = useState(null)

  if (!inv) return (
    <div className="p-4 pb-6">
      <Card className="p-4"><EmptyState icon="file" title="No draft invoice" body="There’s nothing to review yet. Clock in or add an expense to start this week’s invoice." /></Card>
    </div>
  )

  const expenses = inv.expenses || []
  const flaggedLines = inv.lines.filter((l) => l.flag)

  const doSubmit = async () => {
    setSubmitting(true)
    try {
      await actions.submit(inv.numId, justify)
      setSubmitOpen(false)
      toast('Invoice submitted — your manager has been notified')
      nav('detail', { id: inv.numId })
    } catch (err) {
      toast(err.message, 'danger')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-4 space-y-3.5 pb-28">
      {/* Header */}
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted">{inv.id}</p>
            <h2 className="text-xl font-bold text-ink">Week of {weekLabel(inv.week)}</h2>
          </div>
          <StatusPill status="draft" persona="tech" />
        </div>
        <Divider className="my-3" />
        <Row label="Labor" sub={`${num(inv.hours)} hrs`} value={money(inv.laborCents)} />
        <Row label="Expenses" sub={`${expenses.length} items · ${inv.miles} mi`} value={money(inv.expenseCents)} />
        <div className="flex items-center justify-between pt-3">
          <span className="font-semibold text-ink">Total</span>
          <span className="text-2xl font-bold text-brand-700 tnum">{money(inv.totalCents)}</span>
        </div>
      </Card>

      {/* Flags to resolve */}
      {flaggedLines.length > 0 && (
        <InlineAlert tone="warning" title={`${inv.flags} ${inv.flags === 1 ? 'flag' : 'flags'} to clear before submit`}>
          We caught these so your manager doesn’t bounce the invoice back. Add a note or fix the line.
        </InlineAlert>
      )}

      {/* Line items by work order */}
      <CardHeader title="Work orders" sub="Tap a line to edit hours or add a note" />
      {inv.lines.map((l, i) => (
        <Card key={i} className="p-3.5">
          <button className="w-full text-left" onClick={() => setEditLine(l)}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink truncate">{l.store}</span>
              <span className="tnum font-semibold text-ink shrink-0">{money(l.amountCents)}</span>
            </div>
            <div className="text-sm text-muted">{l.wo} · {l.type} · {num(l.hours)} hrs</div>
            {l.flag && <div className="mt-2"><Flag>{l.flag}</Flag></div>}
          </button>
        </Card>
      ))}

      {/* Expenses */}
      <CardHeader title="Expenses" />
      <Card className="p-4">
        {expenses.map((e) => (
          <Row key={e.id} label={CATEGORIES.find((c) => c.key === e.cat)?.label || e.cat} sub={e.desc} value={money(e.amountCents)} />
        ))}
      </Card>

      {/* Sticky submit bar */}
      <div className="fixed bottom-16 inset-x-0 px-4 pb-2">
        <div className="max-w-phone mx-auto">
          <Button size="block" icon="send" onClick={() => setSubmitOpen(true)} className="shadow-pop">
            Submit for approval · {money(inv.totalCents)}
          </Button>
        </div>
      </div>

      {/* Submit sheet — requires justification when flagged */}
      <Sheet open={submitOpen} onClose={() => setSubmitOpen(false)} title="Submit invoice"
        footer={
          <Button size="block" icon="send" busy={submitting} disabled={flaggedLines.length > 0 && justify.trim().length < 10}
            onClick={doSubmit}>Submit for approval</Button>
        }>
        <div className="space-y-3">
          <Row label="Total" value={money(inv.totalCents)} strong />
          <Row label="Goes to" value="Maitland Kelly" sub="Your Ops Manager" />
          {flaggedLines.length > 0 ? (
            <Field label="Why is this OK?" required hint="Min 10 characters. This goes to your manager so they can approve without bouncing it back."
              error={justify.length > 0 && justify.trim().length < 10 ? 'A little more detail, please.' : ''}>
              <Textarea rows={3} placeholder="e.g. Hackensack retrofit needed extra battery rework — confirmed with store manager." value={justify} onChange={(e) => setJustify(e.target.value)} />
            </Field>
          ) : (
            <InlineAlert tone="success" title="No flags">Clean invoice — this should approve fast.</InlineAlert>
          )}
        </div>
      </Sheet>

      {/* Edit line sheet */}
      <Sheet open={!!editLine} onClose={() => setEditLine(null)} title={editLine?.store || ''}
        footer={<Button size="block" onClick={() => { setEditLine(null); toast('Line updated') }}>Save changes</Button>}>
        {editLine && (
          <div className="space-y-3">
            <Field label="Hours"><Textarea rows={1} defaultValue={num(editLine.hours)} /></Field>
            {editLine.flag && <InlineAlert tone="warning">{editLine.flag}</InlineAlert>}
            <Field label="Note for your manager"><Textarea placeholder="Add context…" /></Field>
          </div>
        )}
      </Sheet>
    </div>
  )
}

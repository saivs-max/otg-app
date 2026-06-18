import { useState } from 'react'
import Icon from '../../lib/icons.jsx'
import { Card, CardHeader, Button, Badge, Field, TextInput, InlineAlert, Sheet, useToast } from '../../components/ui.jsx'
import { POLICY } from '../../data/mock.js'

// Purpose: edit the rates & thresholds the policy engine enforces at entry —
// "enforce at entry, not policed later." Changes apply to new entries
// immediately and every change is audit-logged (see Change log below).
const CHANGE_LOG = [
  { date: 'Jun 2', who: 'Sai V.', what: 'Meals cap $80 → $100 / day' },
  { date: 'May 19', who: 'Reshmi Chowdhury', what: 'Sr. routing threshold $7,500 → $5,000' },
  { date: 'May 4', who: 'Sai V.', what: 'Receipt required above $75 → $50' },
]

export default function Policy({ role, nav }) {
  const toast = useToast()
  const [editing, setEditing] = useState(null) // the policy being edited
  const [draft, setDraft] = useState('')

  const openEdit = (p) => { setEditing(p); setDraft(p.value) }
  const save = () => {
    setEditing(null)
    toast('Policy updated · applies to new entries')
  }

  return (
    <div className="p-5 space-y-4 max-w-content">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-ink">Policy</h2>
        <p className="text-sm text-muted">Rates & thresholds the entry engine enforces in real time</p>
      </div>

      <InlineAlert tone="info" title="Enforced at entry, not policed later">
        Changes apply to <span className="font-semibold">new entries immediately</span> — open drafts keep the rate they were created under. Every edit is recorded in the change log below.
      </InlineAlert>

      {/* Policy rules */}
      <Card>
        <CardHeader title="Active rules" sub="The engine blocks or flags submissions against these" icon="shield" />
        <div className="px-4 pb-2">
          {POLICY.map((p) => (
            <div key={p.key} className="flex items-start justify-between gap-4 py-3.5 border-t border-line first:border-0">
              <div className="min-w-0">
                <div className="font-semibold text-ink flex items-center gap-2">
                  {p.label}
                  {p.locked && <span className="inline-flex items-center gap-1 text-2xs font-semibold text-muted"><Icon name="lock" size={12} />Locked</span>}
                </div>
                <p className="text-sm text-muted mt-0.5">{p.desc}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <Badge tone={p.locked ? 'neutral' : 'info'}>{p.value}</Badge>
                <Button variant="secondary" size="sm" icon={p.locked ? 'lock' : 'edit'}
                  disabled={p.locked} onClick={() => openEdit(p)}>
                  {p.locked ? 'Locked' : 'Edit'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Change log */}
      <Card>
        <CardHeader title="Change log" sub="Recent policy edits · audit trail" icon="history" />
        <div className="px-2 pb-1 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Changed by</th>
                <th className="px-3 py-2">What changed</th>
              </tr>
            </thead>
            <tbody>
              {CHANGE_LOG.map((c, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="px-3 py-2.5 tnum text-ink-2 whitespace-nowrap">{c.date}</td>
                  <td className="px-3 py-2.5 text-ink-2">{c.who}</td>
                  <td className="px-3 py-2.5 text-ink">{c.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Edit sheet */}
      <Sheet open={!!editing} onClose={() => setEditing(null)} side="right"
        title={editing ? `Edit · ${editing.label}` : 'Edit policy'}
        footer={
          <div className="flex gap-3">
            <Button variant="subtle" size="block" onClick={() => setEditing(null)}>Cancel</Button>
            <Button size="block" icon="check" onClick={save}>Save</Button>
          </div>
        }>
        {editing && (
          <div className="space-y-3">
            <Field label={editing.label} htmlFor="policy-value" hint={editing.desc}>
              <TextInput id="policy-value" value={draft} onChange={(e) => setDraft(e.target.value)} />
            </Field>
            <InlineAlert tone="info">
              Saving applies this to new entries immediately and writes an audit-log entry.
            </InlineAlert>
          </div>
        )}
      </Sheet>
    </div>
  )
}

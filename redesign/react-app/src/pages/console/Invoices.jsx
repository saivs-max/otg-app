import { useMemo, useState } from 'react'
import Icon from '../../lib/icons.jsx'
import { Card, CardHeader, KPIStat, Button, StatusPill, Flag, Avatar, SearchInput, Segmented, EmptyState } from '../../components/ui.jsx'
import { money, num, weekLabel } from '../../lib/format.js'
import { INVOICES, USERS } from '../../data/mock.js'

// Purpose: find any invoice fast across every tech & lifecycle state (QA "bulk /
// cross-invoice search"). KPI strip → filter row → one scannable table → footer total.
const GROUPS = {
  All: () => true,
  Pending: (i) => ['submitted', 'in_review', 'needs_fixes', 'awaiting_sr'].includes(i.status),
  Approved: (i) => ['approved', 'queued_ap', 'sent_ap'].includes(i.status),
  Paid: (i) => i.status === 'paid',
}

export default function Invoices({ role, nav }) {
  const [group, setGroup] = useState('All')
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return INVOICES.filter(GROUPS[group]).filter((i) => {
      if (!needle) return true
      const tech = USERS[i.techId]?.name || ''
      const wos = i.lines.map((l) => `${l.wo} ${l.store} ${l.type}`).join(' ')
      return `${i.id} ${tech} ${wos}`.toLowerCase().includes(needle)
    })
  }, [group, q])

  const totalCents = rows.reduce((s, i) => s + i.totalCents, 0)
  const allValue = INVOICES.reduce((s, i) => s + i.totalCents, 0)
  const pendingCount = INVOICES.filter(GROUPS.Pending).length
  const paidMonth = INVOICES.filter((i) => i.status === 'paid').reduce((s, i) => s + i.totalCents, 0)

  return (
    <div className="p-5 space-y-4 max-w-content">
      {/* KPI strip — computed from INVOICES */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPIStat label="All invoices" value={num(INVOICES.length, 0)} sub="this org" icon="receipt" />
        <KPIStat label="Total value" value={money(allValue)} sub="all states" icon="card" />
        <KPIStat label="Pending" value={num(pendingCount, 0)} sub="need review" icon="inbox" deltaTone="muted" />
        <KPIStat label="Paid this month" value={money(paidMonth)} sub="issued" icon="paid" />
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented value={group} onChange={setGroup} options={Object.keys(GROUPS)} size="sm" />
        <Filter label="All techs" /><Filter label="All work types" />
        <div className="ml-auto w-full sm:w-72"><SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search invoice, tech, store, WO…" aria-label="Search invoices" /></div>
      </div>

      {/* All-invoices table */}
      <Card>
        <CardHeader title="All invoices" sub={`${group} · search across every technician`} icon="receipt" />
        <div className="px-2 pb-1 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">Technician</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">Flags</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const tech = USERS[inv.techId]
                return (
                  <tr key={inv.id} className="border-t border-line hover:bg-surface-2">
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-ink tnum">{inv.id}</div>
                      <div className="text-2xs text-muted tnum">Week of {weekLabel(inv.week)}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <Avatar name={tech.name} size={26} />
                        <span className="truncate text-ink-2">{tech.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tnum font-semibold text-ink">{money(inv.totalCents)}</td>
                    <td className="px-3 py-2.5">{inv.flags > 0 ? <Flag size="sm">{inv.flags} flag{inv.flags > 1 ? 's' : ''}</Flag> : <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-2.5"><StatusPill status={inv.status} size="sm" /></td>
                    <td className="px-3 py-2.5 text-right">
                      <Button variant="secondary" size="sm" onClick={() => nav('invoiceDetail')}>Review</Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <EmptyState icon="search" title="No invoices match" body="Try a different status group or clear your search." />
          )}
        </div>
        {rows.length > 0 && (
          <div className="px-4 py-3 border-t border-line text-sm text-muted">
            Showing <span className="tnum text-ink-2 font-medium">{rows.length}</span> invoice{rows.length !== 1 ? 's' : ''} · <span className="tnum text-ink-2 font-medium">{money(totalCents)}</span> total
          </div>
        )}
      </Card>
    </div>
  )
}

const Filter = ({ label }) => (
  <button className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-surface ring-1 ring-line text-ink-2 text-sm hover:bg-surface-2">
    {label}<Icon name="chevron-down" size={15} />
  </button>
)

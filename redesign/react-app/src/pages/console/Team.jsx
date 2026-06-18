import { Card, CardHeader, KPIStat, Button, IconButton, Badge, Avatar, useToast } from '../../components/ui.jsx'
import { Sparkline } from '../../components/charts.jsx'
import { money, num } from '../../lib/format.js'
import { DASH, USERS } from '../../data/mock.js'

// Purpose: team management for the Ops Manager — each tech's status, spend and flag
// rate, plus reassign. KPI strip → per-tech profile cards (with mini trend) → full table.
export default function Team({ role, nav }) {
  const toast = useToast()
  const technicians = Object.values(USERS).filter((u) => u.role === 'technician')
  const statByName = Object.fromEntries(DASH.byTech.map((t) => [t.tech, t]))
  const trend = DASH.kpis.trend.slice(-8)

  const teamSpend = DASH.byTech.reduce((s, t) => s + t.totalCents, 0)
  const avgFlag = DASH.byTech.reduce((s, t) => s + t.flagRate, 0) / (DASH.byTech.length || 1)

  return (
    <div className="p-5 space-y-4 max-w-content">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Your team</h2>
          <p className="text-sm text-muted">{technicians.length} technicians mapped to Maitland Kelly</p>
        </div>
        <div className="ml-auto">
          <Button variant="secondary" size="sm" icon="plus" onClick={() => toast('Invite sent', 'info')}>Add technician</Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-3 gap-3">
        <KPIStat label="Active techs" value={num(technicians.length, 0)} sub="reporting to you" icon="users" />
        <KPIStat label="Team spend · MTD" value={money(teamSpend)} sub="month to date" icon="card" />
        <KPIStat label="Avg flag rate" value={`${num(avgFlag, 0)}%`} sub="across team" icon="flag" deltaTone="muted" />
      </div>

      {/* Per-tech profile cards */}
      <div className="grid md:grid-cols-3 gap-4">
        {technicians.map((t) => {
          const st = statByName[t.name]
          return (
            <Card key={t.id} className="p-4">
              <div className="flex items-start gap-3">
                <Avatar name={t.name} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-ink truncate">{t.name}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge tone="neutral">{t.type}</Badge>
                    <span className="text-xs text-muted">{t.region}</span>
                  </div>
                </div>
                <IconButton icon="more-vertical" label={`Manage ${t.name}`} size={32} onClick={() => toast('Opening profile', 'info')} />
              </div>
              <p className="mt-3 text-xs text-muted">Mapped to Maitland Kelly</p>
              <div className="mt-2"><Sparkline points={trend} /></div>
              <div className="mt-2 flex items-center justify-between text-xs text-muted">
                <span>Weekly hours · 8 wk</span>
                {st && <span className="tnum text-ink-2 font-medium">{money(st.totalCents)} MTD</span>}
              </div>
            </Card>
          )
        })}
      </div>

      {/* Full table */}
      <Card>
        <CardHeader title="Technicians" sub="This month · hours, miles, spend and flag rate" icon="users" />
        <div className="px-2 pb-1 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2">Technician</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2 text-right">Hours</th>
                <th className="px-3 py-2 text-right">Miles</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-right">Flag rate</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {technicians.map((t) => {
                const st = statByName[t.name] || { hours: 0, miles: 0, totalCents: 0, flagRate: 0 }
                return (
                  <tr key={t.id} className="border-t border-line hover:bg-surface-2">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <Avatar name={t.name} size={26} />
                        <span className="truncate font-medium text-ink">{t.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5"><Badge tone="neutral">{t.type}</Badge></td>
                    <td className="px-3 py-2.5 text-right tnum">{num(st.hours, 0)}</td>
                    <td className="px-3 py-2.5 text-right tnum text-ink-2">{num(st.miles, 0)}</td>
                    <td className="px-3 py-2.5 text-right tnum font-semibold text-ink">{money(st.totalCents)}</td>
                    <td className={`px-3 py-2.5 text-right tnum ${st.flagRate > 10 ? 'text-warning-fg font-semibold' : 'text-muted'}`}>{st.flagRate}%</td>
                    <td className="px-3 py-2.5 text-right">
                      <IconButton icon="more-vertical" label={`Manage ${t.name}`} size={32} onClick={() => toast('Opening profile', 'info')} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

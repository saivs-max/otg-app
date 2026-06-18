import { useState } from 'react'
import Icon from '../../lib/icons.jsx'
import { Card, CardHeader, KPIStat, Button, Segmented, Badge, Row } from '../../components/ui.jsx'
import { VBarRows, Donut, LineChart, Sparkline } from '../../components/charts.jsx'
import { money, num } from '../../lib/format.js'
import { useData } from '../../data/DataProvider.jsx'

// Purpose: answer "where is our spend going?" live. KPI strip → category/work-type
// breakdowns → unit economics (top stores $/cart) → per-tech table → 13-wk trend.
export default function Dashboard({ role, nav }) {
  const { dash } = useData()
  const k = dash.kpis
  const [period, setPeriod] = useState('MTD')
  return (
    <div className="p-5 space-y-4 max-w-content">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented value={period} onChange={setPeriod} options={['MTD', 'QTD', 'YTD', 'Custom']} size="sm" />
        <Filter label="All regions" /><Filter label="All work types" /><Filter label="All techs" />
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" size="sm" icon="download">CSV</Button>
          <Button variant="secondary" size="sm" icon="grid">PNG for MBR</Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPIStat label="Spend · MTD" value={money(k.mtdSpend)} delta="+8.2%" deltaTone="danger" sub="vs last month" icon="card" />
        <KPIStat label="EOM forecast" value={money(k.eomForecast)} sub="80% CI ±6%" icon="trending" hint="Within budget of $15.0M" />
        <KPIStat label="Avg approval time" value={`${k.avgApprovalHrs} hrs`} delta="−31%" deltaTone="success" sub="was 27 hrs" icon="clock" />
        <KPIStat label="Pending queue" value={money(k.pendingValueCents)} sub={`${k.pendingCount} invoices · ${k.agingCount} aging`} icon="inbox" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Spend by category */}
        <Card>
          <CardHeader title="Spend by category" sub="Month to date" icon="bar-chart" />
          <div className="p-4 pt-2"><VBarRows data={dash.byCategory} /></div>
        </Card>
        {/* Spend by work type */}
        <Card>
          <CardHeader title="Spend by work type" icon="pie-chart" />
          <div className="p-4 pt-2"><Donut data={dash.byWorkType} /></div>
        </Card>
      </div>

      {/* Top stores by $/cart — unit economics with outlier flag */}
      <Card>
        <CardHeader title="Top stores by $ / cart" sub="The unit-economics metric — outliers flagged" icon="building" />
        <div className="px-2 pb-2">
          <table className="w-full">
            <thead><tr className="text-left text-2xs uppercase tracking-wide text-muted">
              <th className="px-3 py-2">Store</th><th className="px-3 py-2 text-right">Carts</th><th className="px-3 py-2 text-right">$ / cart</th><th className="px-3 py-2"></th>
            </tr></thead>
            <tbody>
              {dash.topStores.map((s) => (
                <tr key={s.store} className="border-t border-line">
                  <td className="px-3 py-2.5 font-medium">{s.store}</td>
                  <td className="px-3 py-2.5 text-right tnum text-ink-2">{s.carts}</td>
                  <td className="px-3 py-2.5 text-right tnum font-semibold">{money(s.perCart)}</td>
                  <td className="px-3 py-2.5">{s.outlier && <Badge tone="warning" icon="flag">2.1σ outlier</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Spend by tech */}
        <Card>
          <CardHeader title="Spend by technician" icon="users" />
          <div className="px-2 pb-2">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-2xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2">Tech</th><th className="px-3 py-2 text-right">Hrs</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">Flag %</th>
              </tr></thead>
              <tbody>
                {dash.byTech.map((t) => (
                  <tr key={t.tech} className="border-t border-line">
                    <td className="px-3 py-2.5 font-medium truncate">{t.tech}</td>
                    <td className="px-3 py-2.5 text-right tnum">{t.hours}</td>
                    <td className="px-3 py-2.5 text-right tnum font-semibold">{money(t.totalCents)}</td>
                    <td className={`px-3 py-2.5 text-right tnum ${t.flagRate > 10 ? 'text-warning-fg font-semibold' : 'text-muted'}`}>{t.flagRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        {/* Trend */}
        <Card>
          <CardHeader title="Weekly spend · 13 weeks" sub="Carrot dashes = budget" icon="trending" action={<Badge tone="info">$/wk</Badge>} />
          <div className="p-4 pt-2">
            <LineChart height={170} series={[{ points: k.trend.map((y) => ({ y })), color: '#0B6E4F' }]} budget={88} />
          </div>
        </Card>
      </div>

      {/* Approval funnel */}
      <Card>
        <CardHeader title="Approval funnel" sub="Where invoices sit right now" icon="inbox" action={<Button size="sm" onClick={() => nav('approvals')} iconRight="arrow-right">Open queue</Button>} />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-line">
          {[['Submitted', 4, 'info'], ['In review', 1, 'info'], ['Aging > 3d', 2, 'warning'], ['Awaiting Sr', 1, 'warning']].map(([l, n, tone]) => (
            <div key={l} className="bg-surface p-4 text-center">
              <div className={`text-3xl font-bold tnum ${tone === 'warning' ? 'text-warning-fg' : 'text-ink'}`}>{n}</div>
              <div className="text-xs text-muted mt-1">{l}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
const Filter = ({ label }) => (
  <button className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-surface ring-1 ring-line text-ink-2 text-sm hover:bg-surface-2">
    {label}<Icon name="chevron-down" size={15} />
  </button>
)

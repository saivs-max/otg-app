import { Card, CardHeader, KPIStat, Button, Badge, InlineAlert } from '../../components/ui.jsx'
import { LineChart } from '../../components/charts.jsx'
import { money, num } from '../../lib/format.js'
import { DASH } from '../../data/mock.js'

// Purpose: spend & forecast + anomaly review (cost tracker + forecast + launch
// actuals). KPI strip → 90-day forecast line (actual→dashed forecast + 80% band) →
// predicted labor hrs/cart → flagged anomalies that route into invoice detail.
const LABOR_HRS = [
  { label: 'Deployment', value: 0.42 },
  { label: 'Retrofit', value: 0.39 },
  { label: 'Service', value: 0.50 },
  { label: 'Repair', value: 0.83 },
]

export default function Forecast({ role, nav }) {
  const k = DASH.kpis
  const f = DASH.forecast
  // Actual (solid) joins forecast (dashed) at the seam so the line reads continuous.
  const actualSeries = { points: f.actual, color: '#0B6E4F' }
  const forecastSeries = { points: [f.actual[f.actual.length - 1], ...f.points], color: '#0B6E4F', dashed: true }
  const variance = k.eomForecast - f.budget * 100000

  return (
    <div className="p-5 space-y-4 max-w-content">
      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPIStat label="EOM forecast" value={money(k.eomForecast)} sub="80% CI ±6%" icon="trending" />
        <KPIStat label="MTD actuals" value={money(k.mtdSpend)} sub="month to date" icon="card" />
        <KPIStat label="Budget" value="$15.0M" sub="this month" icon="gauge" />
        <KPIStat label="Variance to budget" value={money(15000000 - k.eomForecast, { sign: true })} delta="under" deltaTone="success" sub="forecast vs plan" icon="bar-chart" />
      </div>

      {/* 90-day spend forecast */}
      <Card>
        <CardHeader title="90-day spend forecast" sub="Actual to date, then projected — shaded 80% confidence band" icon="trending" />
        <div className="p-4 pt-2">
          <LineChart height={210} series={[actualSeries, forecastSeries]} band={f.band} budget={f.budget} />
          {/* Legend */}
          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted">
            <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 rounded bg-brand-700" />Actual</span>
            <span className="flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-brand-700" />Forecast</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-brand-500/20 ring-1 ring-brand-500/30" />80% band</span>
            <span className="flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-carrot-400" />Budget</span>
          </div>
          <p className="mt-2 text-xs text-muted">Projection blends 13-week trend with open work orders. The band widens further out — treat the edges as scenarios, not precision.</p>
        </div>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Predicted labor hours by work type */}
        <Card>
          <CardHeader title="Predicted labor hours by work type" sub="Model estimate · hours per cart" icon="gauge" />
          <div className="px-2 pb-1">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-2xs uppercase tracking-wide text-muted">
                  <th className="px-3 py-2">Work type</th>
                  <th className="px-3 py-2 text-right">Expected hrs / cart</th>
                </tr>
              </thead>
              <tbody>
                {LABOR_HRS.map((w) => (
                  <tr key={w.label} className="border-t border-line">
                    <td className="px-3 py-2.5 font-medium text-ink">{w.label}</td>
                    <td className="px-3 py-2.5 text-right tnum font-semibold text-ink">{num(w.value, 2)} hrs</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Anomalies this month */}
        <Card>
          <CardHeader title="Anomalies this month" sub="Lines that deviate from the statistical baseline" icon="alert" action={<Badge tone="warning" icon="flag">{DASH.anomalies.length}</Badge>} />
          <div className="p-2 pt-0">
            {DASH.anomalies.map((a) => (
              <div key={a.inv} className="flex items-start gap-3 p-2.5 rounded-md hover:bg-surface-2">
                <Badge tone="warning">{num(a.sigma, 1)}σ</Badge>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-ink tnum">{a.inv} · <span className="font-normal text-ink-2">{a.tech}</span></div>
                  <p className="text-sm text-muted">{a.detail}</p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => nav('invoiceDetail')}>Review</Button>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <InlineAlert tone="info" title="How the model works">
        Forecasts use transparent statistical baselines (rolling medians and seasonal trend), retrained weekly — not a black box. Projections are suppressed for any store or tech with fewer than 3–4 weeks of data, so a thin history never produces a confident-looking number.
      </InlineAlert>
    </div>
  )
}

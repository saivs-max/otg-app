// Dependency-free SVG charts. Colors come from verified tokens. Decorative SVG
// is aria-hidden; each chart card pairs with a real data table for screen readers.
import { money } from '../lib/format.js'

const C = { brand: '#0B6E4F', brand2: '#43B02A', carrot: '#F36D00', info: '#175CD3', ap: '#6941C6', warn: '#9A5B00', line: '#E4E0D8', muted: '#5B6B64' }
const PALETTE = ['#0B6E4F', '#43B02A', '#F36D00', '#175CD3', '#6941C6', '#9A5B00', '#0E7A56', '#B4530A']

export function BarChart({ data, height = 180, money: asMoney = true, color = C.brand }) {
  const max = Math.max(...data.map((d) => d.value), 1)
  const bw = 100 / data.length
  return (
    <svg viewBox={`0 0 100 ${height / 3}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden="true">
      {data.map((d, i) => {
        const h = (d.value / max) * (height / 3 - 14)
        return (
          <g key={i}>
            <rect x={i * bw + bw * 0.18} y={height / 3 - 10 - h} width={bw * 0.64} height={Math.max(h, 0.5)} rx="1.5" fill={d.color || color} />
            <text x={i * bw + bw / 2} y={height / 3 - 2} textAnchor="middle" fontSize="3" fill={C.muted}>{d.label}</text>
          </g>
        )
      })}
    </svg>
  )
}

export function VBarRows({ data, money: asMoney = true }) {
  const max = Math.max(...data.map((d) => d.value), 1)
  return (
    <div className="space-y-2.5">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-3 text-sm">
          <span className="w-28 shrink-0 text-ink-2 truncate">{d.label}</span>
          <div className="flex-1 h-5 rounded bg-surface-2 overflow-hidden">
            <div className="h-full rounded" style={{ width: `${(d.value / max) * 100}%`, background: d.color || PALETTE[i % PALETTE.length] }} />
          </div>
          <span className="w-20 shrink-0 text-right tnum font-semibold text-ink">{asMoney ? money(d.value) : d.value}</span>
        </div>
      ))}
    </div>
  )
}

export function LineChart({ series, band, height = 200, budget }) {
  const all = series.flatMap((s) => s.points.map((p) => p.y)).concat(band ? band.flatMap((b) => [b.hi, b.lo]) : []).concat(budget != null ? [budget] : [])
  const max = Math.max(...all, 1) * 1.1, min = 0
  const W = 300, H = 120, pad = 4
  const X = (i, n) => pad + (i / (n - 1)) * (W - pad * 2)
  const Y = (v) => H - pad - ((v - min) / (max - min)) * (H - pad * 2)
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(i, pts.length)},${Y(p.y)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} aria-hidden="true">
      {budget != null && <line x1={pad} x2={W - pad} y1={Y(budget)} y2={Y(budget)} stroke={C.carrot} strokeWidth="1" strokeDasharray="4 3" />}
      {band && <path d={`${band.map((b, i) => `${i ? 'L' : 'M'}${X(i, band.length)},${Y(b.hi)}`).join(' ')} ${band.slice().reverse().map((b, i) => `L${X(band.length - 1 - i, band.length)},${Y(b.lo)}`).join(' ')} Z`} fill={C.brand} opacity="0.12" />}
      {series.map((s, si) => (
        <g key={si}>
          <path d={path(s.points)} fill="none" stroke={s.color || PALETTE[si]} strokeWidth="2" strokeDasharray={s.dashed ? '5 4' : ''} strokeLinejoin="round" />
          {s.points.map((p, i) => <circle key={i} cx={X(i, s.points.length)} cy={Y(p.y)} r="2" fill={s.color || PALETTE[si]} />)}
        </g>
      ))}
    </svg>
  )
}

export function Donut({ data, size = 150, thickness = 22 }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1
  const r = (size - thickness) / 2, cx = size / 2, cy = size / 2, circ = 2 * Math.PI * r
  let off = 0
  return (
    <div className="flex items-center gap-5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="shrink-0">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.line} strokeWidth={thickness} />
        {data.map((d, i) => {
          const len = (d.value / total) * circ
          const el = <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={d.color || PALETTE[i % PALETTE.length]} strokeWidth={thickness}
            strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-off} transform={`rotate(-90 ${cx} ${cy})`} strokeLinecap="butt" />
          off += len; return el
        })}
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize="13" fontWeight="700" fill={C.brand}>{money(total)}</text>
        <text x={cx} y={cy + 13} textAnchor="middle" fontSize="8" fill={C.muted}>total</text>
      </svg>
      <ul className="text-sm space-y-1.5 min-w-0">
        {data.map((d, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: d.color || PALETTE[i % PALETTE.length] }} />
            <span className="text-ink-2 truncate">{d.label}</span>
            <span className="ml-auto tnum text-muted">{Math.round((d.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Sparkline({ points, color = C.brand, height = 36 }) {
  const max = Math.max(...points, 1), min = Math.min(...points, 0), W = 100
  const X = (i) => (i / (points.length - 1)) * W
  const Y = (v) => height - ((v - min) / (max - min || 1)) * height
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden="true">
      <path d={points.map((p, i) => `${i ? 'L' : 'M'}${X(i)},${Y(p)}`).join(' ')} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export { PALETTE }

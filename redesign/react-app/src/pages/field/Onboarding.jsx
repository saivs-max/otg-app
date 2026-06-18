import { useState } from 'react'
import Icon from '../../lib/icons.jsx'
import { Button } from '../../components/ui.jsx'

// Purpose: first-run orientation (QA review: no onboarding existed). Three quick
// value slides + a location-permission prime so GPS mileage works in the field.
const STEPS = [
  { icon: 'clock', title: 'One-tap time tracking', body: 'Clock in to a work order and we capture the time and place. No notebook, no remembering.' },
  { icon: 'receipt', title: 'Log expenses on the spot', body: 'Snap a receipt, pick a category, done. We do the math and check policy as you go.' },
  { icon: 'paid', title: 'Get paid faster', body: 'Your week rolls into one invoice automatically. Submit in a tap and watch it move to Paid.' },
  { icon: 'map-pin', title: 'Allow location?', body: 'We use your location only at clock-in and clock-out to verify mileage. Never in the background.', perm: true },
]
export default function Onboarding({ onDone }) {
  const [i, setI] = useState(0)
  const s = STEPS[i]
  const last = i === STEPS.length - 1
  return (
    <div className="h-full flex flex-col bg-bg p-6">
      <div className="flex justify-end"><button onClick={onDone} className="text-muted text-sm font-semibold">Skip</button></div>
      <div className="flex-1 flex flex-col items-center justify-center text-center">
        <div className="w-24 h-24 rounded-3xl bg-brand-50 text-brand-700 grid place-items-center"><Icon name={s.icon} size={48} /></div>
        <h1 className="mt-6 text-2xl font-bold text-ink">{s.title}</h1>
        <p className="mt-2 text-ink-2 max-w-xs">{s.body}</p>
      </div>
      <div className="flex justify-center gap-2 mb-5">
        {STEPS.map((_, n) => <span key={n} className={`h-2 rounded-full transition-all ${n === i ? 'w-6 bg-brand-700' : 'w-2 bg-line'}`} />)}
      </div>
      {s.perm ? (
        <div className="space-y-2">
          <Button size="block" icon="map-pin" onClick={onDone}>Allow location</Button>
          <Button variant="ghost" size="block" onClick={onDone}>Not now</Button>
        </div>
      ) : (
        <Button size="block" iconRight="arrow-right" onClick={() => setI(i + 1)}>Continue</Button>
      )}
    </div>
  )
}

import { Button } from '../../components/ui.jsx'
import { Logo } from '../../App.jsx'

// Purpose: real SSO sign-in (QA review: replace the spoofable user-picker with
// verified identity). Single tap, no passwords to remember in the field.
export default function Login({ onDone }) {
  return (
    <div className="h-full flex flex-col bg-brand-900 text-white p-6">
      <div className="flex-1 flex flex-col items-center justify-center text-center">
        <div className="w-20 h-20 rounded-2xl bg-white grid place-items-center shadow-pop"><Logo size={56} /></div>
        <h1 className="mt-5 text-3xl font-bold">Bread</h1>
        <p className="mt-1 text-brand-100">Track time, log expenses, get paid faster.</p>
      </div>
      <div className="space-y-3">
        <Button variant="carrot" size="block" icon="shield" onClick={onDone}>Sign in with Instacart SSO</Button>
        <p className="text-center text-xs text-brand-100/80">Single sign-on via Okta · Your session is verified server-side.</p>
      </div>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { api, token, setUnauthorizedHandler, ApiError } from './data/api.js'
import { c } from './data/adapters.js'
import { DataProvider } from './data/DataProvider.jsx'
import { ToastHost, Button, Field, TextInput, InlineAlert, Spinner } from './components/ui.jsx'
import { Logo } from './App.jsx'
import FieldApp from './pages/field/FieldApp.jsx'
import Console from './pages/console/Console.jsx'

// The INTEGRATED product (served by Express at /v2). Real login → role-based
// entry into the Field app (technician) or Console (manager/PM), backed by the
// live API through DataProvider.
const shapeMe = (m) => ({ id: m.id, name: m.name, role: m.role,
  type: m.worker_type === 'fte' ? 'FTE' : 'Contractor', rateCents: c(m.hourly_rate), region: 'Northeast', mgrName: m.ops_manager_name })

export default function Product() {
  const [me, setMe] = useState(null)
  const [booting, setBooting] = useState(true)
  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null))
    if (token.get()) api.me().then(setMe).catch(() => token.clear()).finally(() => setBooting(false))
    else setBooting(false)
  }, [])

  if (booting) return <Splash />
  if (!me) return <LoginReal onLogin={setMe} />

  const isMgr = ['ops_manager', 'sr_manager', 'pm'].includes(me.role)
  const logout = () => { api.logout(); token.clear(); setMe(null) }

  return (
    <DataProvider me={shapeMe(me)}>
      <ToastHost>
        {isMgr
          ? <div className="h-screen"><Console screen="dashboard" role={me.role} onLogout={logout} /></div>
          : <div className="h-screen w-full max-w-phone mx-auto bg-surface shadow-pop"><FieldApp screen="today" onLogout={logout} /></div>}
      </ToastHost>
    </DataProvider>
  )
}

function Splash() {
  return (
    <div className="h-screen grid place-items-center bg-brand-900 text-white">
      <div className="text-center"><div className="w-16 h-16 rounded-2xl bg-white grid place-items-center mx-auto"><Logo size={44} /></div>
        <div className="mt-4 flex items-center gap-2 justify-center text-brand-100"><Spinner /> Loading…</div></div>
    </div>
  )
}

function LoginReal({ onLogin }) {
  const [u, setU] = useState(''); const [p, setP] = useState('')
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      const res = await api.login(u.trim(), p)
      token.set(res.token); onLogin(res.user)
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Sign-in failed — check your connection.') }
    finally { setBusy(false) }
  }
  return (
    <div className="h-screen flex flex-col items-center justify-center bg-brand-900 text-white p-6">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-20 h-20 rounded-2xl bg-white grid place-items-center shadow-pop"><Logo size={56} /></div>
          <h1 className="mt-5 text-3xl font-bold">Caper CostWise</h1>
          <p className="mt-1 text-brand-100">Field Cost &amp; Operations</p>
        </div>
        <form onSubmit={submit} className="bg-surface text-ink rounded-2xl p-5 shadow-pop space-y-3">
          {err && <InlineAlert tone="danger">{err}</InlineAlert>}
          <Field label="Username"><TextInput value={u} onChange={(e) => setU(e.target.value)} autoFocus placeholder="e.g. aramiwale" autoCapitalize="none" /></Field>
          <Field label="Password"><TextInput type="password" value={p} onChange={(e) => setP(e.target.value)} placeholder="••••••••" /></Field>
          <Button size="block" busy={busy} type="submit">Sign in</Button>
          <p className="text-center text-xs text-muted">Demo: <strong>aramiwale</strong> / <strong>maitland</strong> / <strong>sai</strong> · password <strong>password123</strong></p>
        </form>
        <p className="text-center text-xs text-brand-100/80 mt-4">Sessions are verified server-side (Bearer token).</p>
      </div>
    </div>
  )
}

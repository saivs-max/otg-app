import { useState } from 'react'
import Icon from '../../lib/icons.jsx'
import { IconButton } from '../../components/ui.jsx'
import { USERS } from '../../data/mock.js'
import Login from './Login.jsx'
import Onboarding from './Onboarding.jsx'
import Today from './Today.jsx'
import Timer from './Timer.jsx'
import AddExpense from './AddExpense.jsx'
import InvoiceReview from './InvoiceReview.jsx'
import MyInvoices from './MyInvoices.jsx'
import InvoiceDetail from './InvoiceDetail.jsx'
import Profile from './Profile.jsx'

const TABS = [
  { id: 'today', label: 'Today', icon: 'home' },
  { id: 'timer', label: 'Time', icon: 'clock' },
  { id: 'add', label: 'Expenses', icon: 'receipt' },
  { id: 'mine', label: 'Invoices', icon: 'file' },
]
const TITLES = { today: 'Today', timer: 'Time tracker', add: 'Add expense', invoice: 'This week', mine: 'My invoices', detail: 'Invoice', profile: 'Profile' }
// Which bottom tab is highlighted for sub-screens
const TAB_OF = { today: 'today', timer: 'timer', add: 'add', invoice: 'mine', mine: 'mine', detail: 'mine', profile: null }

export default function FieldApp({ screen = 'today', go }) {
  const me = USERS.aramiwale
  const [active, setActive] = useState(screen)
  const nav = (s) => { setActive(s); go && go(s) }

  // Full-bleed screens (no chrome)
  if (active === 'login') return <Login onDone={() => nav('onboarding')} />
  if (active === 'onboarding') return <Onboarding onDone={() => nav('today')} />

  const screens = {
    today: <Today me={me} nav={nav} />,
    timer: <Timer me={me} nav={nav} />,
    add: <AddExpense me={me} nav={nav} />,
    invoice: <InvoiceReview me={me} nav={nav} />,
    mine: <MyInvoices me={me} nav={nav} />,
    detail: <InvoiceDetail me={me} nav={nav} />,
    profile: <Profile me={me} nav={nav} />,
  }
  const activeTab = TAB_OF[active]

  return (
    <div className="relative h-full flex flex-col bg-bg">
      {/* Header */}
      <header className="shrink-0 h-14 bg-brand-900 text-white flex items-center justify-between px-2 pt-6 pb-2" style={{ height: 60 }}>
        {['detail', 'invoice', 'profile'].includes(active)
          ? <IconButton icon="chevron-left" label="Back" variant="chrome" onClick={() => nav(active === 'detail' ? 'mine' : 'today')} />
          : <span className="w-10" />}
        <h1 className="font-semibold text-lg">{TITLES[active]}</h1>
        <div className="flex gap-1">
          <IconButton icon="bell" label="Notifications" variant="chrome" />
          <IconButton icon="user" label="Profile" variant="chrome" onClick={() => nav('profile')} />
        </div>
      </header>

      {/* Scroll area */}
      <main className="flex-1 overflow-y-auto no-scrollbar">{screens[active]}</main>

      {/* Bottom tabs */}
      <nav className="shrink-0 bg-surface border-t border-line flex pb-2" style={{ height: 64 }} aria-label="Primary">
        {TABS.map((t) => {
          const on = activeTab === t.id
          return (
            <button key={t.id} onClick={() => nav(t.id)} aria-current={on ? 'page' : undefined}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 relative ${on ? 'text-brand-700' : 'text-muted'}`}>
              {on && <span className="absolute top-0 w-10 h-0.5 bg-brand-700 rounded-full" />}
              <Icon name={t.icon} size={24} fill={on} />
              <span className={`text-2xs ${on ? 'font-semibold' : ''}`}>{t.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}

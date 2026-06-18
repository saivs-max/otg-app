import { useState } from 'react'
import Icon from '../../lib/icons.jsx'
import { Logo } from '../../App.jsx'
import { Avatar, IconButton, Badge, SearchInput, Segmented } from '../../components/ui.jsx'
import { USERS, ROLE_LABEL } from '../../data/mock.js'
import Dashboard from './Dashboard.jsx'
import Approvals from './Approvals.jsx'
import ConsoleInvoiceDetail from './ConsoleInvoiceDetail.jsx'
import Invoices from './Invoices.jsx'
import CorpCard from './CorpCard.jsx'
import Forecast from './Forecast.jsx'
import Team from './Team.jsx'
import Policy from './Policy.jsx'
import Admin from './Admin.jsx'
import APExport from './APExport.jsx'
import Settings from './Settings.jsx'

// Console IA: 10 flat bottom-tabs (old app) → a grouped left sidebar. Items are
// gated by role: Ops sees operations; Sr adds Policy; PM adds Users + AP Export.
const NAV = [
  { group: 'Operate', items: [
    ['dashboard', 'Overview', 'grid'],
    ['approvals', 'Approvals', 'inbox', true],
    ['invoices', 'Invoices', 'file'],
    ['corpcard', 'Corp card', 'card'],
    ['forecast', 'Spend & forecast', 'trending'],
    ['team', 'Team', 'users'],
  ]},
  { group: 'Administer', items: [
    ['policy', 'Policy', 'shield', false, ['pm', 'sr_manager']],
    ['admin', 'Users', 'user', false, ['pm']],
    ['apexport', 'AP export', 'send', false, ['pm']],
    ['settings', 'Settings', 'settings'],
  ]},
]
const TITLES = { dashboard: 'Overview', approvals: 'Approvals', invoiceDetail: 'Invoice', invoices: 'Invoices', corpcard: 'Corporate card', forecast: 'Spend & forecast', team: 'Team', policy: 'Policy', admin: 'Users & roles', apexport: 'AP export', settings: 'Settings' }

export default function Console({ screen = 'dashboard', role = 'pm', go }) {
  const me = USERS[role === 'pm' ? 'sai' : role === 'sr_manager' ? 'reshmi' : 'maitland']
  const [active, setActive] = useState(screen)
  const nav = (s) => { setActive(s); go && go(s) }
  const can = (roles) => !roles || roles.includes(role)

  const pages = {
    dashboard: <Dashboard role={role} nav={nav} />,
    approvals: <Approvals role={role} nav={nav} />,
    invoiceDetail: <ConsoleInvoiceDetail role={role} nav={nav} />,
    invoices: <Invoices role={role} nav={nav} />,
    corpcard: <CorpCard role={role} nav={nav} />,
    forecast: <Forecast role={role} nav={nav} />,
    team: <Team role={role} nav={nav} />,
    policy: <Policy role={role} nav={nav} />,
    admin: <Admin role={role} nav={nav} />,
    apexport: <APExport role={role} nav={nav} />,
    settings: <Settings role={role} nav={nav} />,
  }

  return (
    <div className="h-full flex bg-bg text-ink text-sm">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 bg-surface border-r border-line flex flex-col">
        <div className="h-14 flex items-center gap-2 px-4 border-b border-line">
          <Logo size={30} /><span className="font-bold">Bread</span>
          <span className="ml-auto text-2xs text-muted">Console</span>
        </div>
        <nav className="flex-1 overflow-y-auto p-2 no-scrollbar">
          {NAV.map((grp) => {
            const items = grp.items.filter(([, , , , roles]) => can(roles))
            if (!items.length) return null
            return (
              <div key={grp.group}>
                <div className="px-3 pt-3 pb-1 text-2xs font-bold uppercase tracking-wider text-muted">{grp.group}</div>
                {items.map(([id, label, icon, badge]) => {
                  const on = active === id || (id === 'invoices' && active === 'invoiceDetail')
                  return (
                    <button key={id} onClick={() => nav(id)}
                      className={`w-full flex items-center gap-2.5 rounded-md px-3 py-2 mb-0.5 text-left ${on ? 'bg-brand-50 text-brand-800 font-semibold' : 'text-ink-2 hover:bg-surface-2'}`}>
                      <Icon name={icon} size={18} />{label}
                      {badge && <Badge tone="danger" className="ml-auto">7</Badge>}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </nav>
        <div className="p-3 border-t border-line flex items-center gap-2.5">
          <Avatar name={me.name} size={36} />
          <div className="min-w-0">
            <div className="font-semibold truncate">{me.name}</div>
            <div className="text-2xs text-muted">{ROLE_LABEL[me.role]}</div>
          </div>
          <IconButton icon="logout" label="Sign out" size={32} className="ml-auto" />
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-14 shrink-0 bg-surface border-b border-line flex items-center gap-3 px-5">
          <h1 className="text-lg font-bold">{TITLES[active]}</h1>
          <div className="ml-auto w-72"><SearchInput placeholder="Search invoices, techs, work orders…" /></div>
          <IconButton icon="bell" label="Notifications" />
        </header>
        <div className="flex-1 overflow-y-auto">{pages[active]}</div>
      </div>
    </div>
  )
}

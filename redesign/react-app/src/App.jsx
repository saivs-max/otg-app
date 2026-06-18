import { useState } from 'react'
import Icon from './lib/icons.jsx'
import { PhoneFrame, DesktopFrame } from './components/frames.jsx'
import { ToastHost } from './components/ui.jsx'
import FieldApp from './pages/field/FieldApp.jsx'
import Console from './pages/console/Console.jsx'
import Overview from './pages/system/Overview.jsx'
import DesignSystem from './pages/system/DesignSystem.jsx'
import IAFlows from './pages/system/IAFlows.jsx'

const FIELD_SCREENS = [
  ['login', 'Sign in (SSO)'], ['onboarding', 'First-run onboarding'], ['today', 'Today (home)'],
  ['timer', 'Time tracker'], ['add', 'Add expense'], ['invoice', 'Invoice — review & submit'],
  ['mine', 'My invoices'], ['detail', 'Invoice detail & trail'], ['profile', 'Profile & settings'],
]
const CONSOLE_SCREENS = [
  ['dashboard', 'Overview / dashboard'], ['approvals', 'Approvals queue'], ['invoiceDetail', 'Invoice detail & approve'],
  ['invoices', 'All invoices'], ['corpcard', 'Corp-card ledger'], ['forecast', 'Spend & forecast'],
  ['team', 'Team'], ['policy', 'Policy'], ['admin', 'Admin / users'], ['apexport', 'AP export'], ['settings', 'Settings'],
]

export default function App() {
  const [view, setView] = useState('overview')
  const [fieldScreen, setFieldScreen] = useState('today')
  const [consoleScreen, setConsoleScreen] = useState('dashboard')
  const [role, setRole] = useState('pm')

  const RailLink = ({ active, onClick, icon, children, indent }) => (
    <button onClick={onClick}
      className={`w-full flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-left transition-colors ${indent ? 'pl-9' : ''} ${active ? 'bg-brand-50 text-brand-800 font-semibold' : 'text-ink-2 hover:bg-surface-2'}`}>
      {icon && <Icon name={icon} size={16} />}{children}
    </button>
  )
  const Group = ({ children }) => <div className="px-2.5 pt-4 pb-1 text-2xs font-bold uppercase tracking-wider text-muted">{children}</div>

  return (
    <div className="min-h-screen flex bg-bg text-ink">
      {/* ── Explorer rail (prototype chrome, not part of the product) ── */}
      <aside className="w-72 shrink-0 border-r border-line bg-surface h-screen sticky top-0 overflow-y-auto no-scrollbar">
        <div className="p-4 flex items-center gap-2.5 border-b border-line">
          <Logo />
          <div>
            <div className="font-bold text-ink leading-tight">Bread</div>
            <div className="text-xs text-muted">Redesign · v1.0</div>
          </div>
        </div>
        <nav className="p-2">
          <Group>Strategy &amp; spec</Group>
          <RailLink icon="sparkles" active={view === 'overview'} onClick={() => setView('overview')}>Redesign overview</RailLink>
          <RailLink icon="grid" active={view === 'design'} onClick={() => setView('design')}>Design system</RailLink>
          <RailLink icon="trending" active={view === 'ia'} onClick={() => setView('ia')}>IA &amp; user flows</RailLink>

          <Group>Field app · Technician</Group>
          {FIELD_SCREENS.map(([id, label]) => (
            <RailLink key={id} indent active={view === 'field' && fieldScreen === id}
              onClick={() => { setView('field'); setFieldScreen(id); setRole('technician') }}>{label}</RailLink>
          ))}

          <Group>Console · Manager &amp; PM</Group>
          <div className="px-2 pb-1.5 flex gap-1">
            {[['ops_manager', 'Ops'], ['sr_manager', 'Sr'], ['pm', 'PM']].map(([r, l]) => (
              <button key={r} onClick={() => { setRole(r); setView('console') }}
                className={`flex-1 rounded-md py-1.5 text-xs font-semibold ${role === r && view === 'console' ? 'bg-brand-700 text-white' : 'bg-surface-2 text-ink-2'}`}>{l}</button>
            ))}
          </div>
          {CONSOLE_SCREENS.map(([id, label]) => (
            <RailLink key={id} indent active={view === 'console' && consoleScreen === id}
              onClick={() => { setView('console'); setConsoleScreen(id) }}>{label}</RailLink>
          ))}
        </nav>
      </aside>

      {/* ── Stage ── */}
      <main className="flex-1 min-w-0 overflow-y-auto h-screen">
        {view === 'overview' && <Overview go={(v, s) => { setView(v); s && (v === 'field' ? setFieldScreen(s) : setConsoleScreen(s)) }} setRole={setRole} />}
        {view === 'design' && <DesignSystem />}
        {view === 'ia' && <IAFlows />}
        {view === 'field' && (
          <div className="p-8 grid place-items-center min-h-full bg-grocery">
            <ToastHost><PhoneFrame label="Field App · iPhone · Technician"><FieldApp key={fieldScreen} screen={fieldScreen} go={setFieldScreen} /></PhoneFrame></ToastHost>
          </div>
        )}
        {view === 'console' && (
          <div className="p-8 bg-grocery min-h-full">
            <ToastHost><DesktopFrame label={`Console · ${role === 'pm' ? 'Program Manager' : role === 'sr_manager' ? 'Senior Manager' : 'Ops Manager'}`}>
              <Console key={consoleScreen + role} screen={consoleScreen} role={role} go={setConsoleScreen} />
            </DesktopFrame></ToastHost>
          </div>
        )}
      </main>
    </div>
  )
}

export function Logo({ size = 34 }) {
  return (
    <span style={{ width: size, height: size }} className="grid place-items-center rounded-lg bg-carrot-50 shrink-0">
      <svg viewBox="0 0 64 64" width={size * 0.72} height={size * 0.72} aria-hidden="true">
        <defs>
          <linearGradient id="loaf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#F4C06A" /><stop offset="1" stopColor="#B4530A" /></linearGradient>
        </defs>
        {/* loaf of bread */}
        <path d="M8 41C8 27 19 20 32 20C45 20 56 27 56 41C56 46 52 49 47 49L17 49C12 49 8 46 8 41Z" fill="url(#loaf)" />
        <path d="M14 31C20 25 44 25 50 31" fill="none" stroke="#FFE3B0" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
        <path d="M24 30L20 39M33 29L29 38M42 30L38 39" stroke="#8A3D06" strokeWidth="2.4" strokeLinecap="round" opacity="0.85" />
      </svg>
    </span>
  )
}

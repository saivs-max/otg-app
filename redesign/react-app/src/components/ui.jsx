import { useEffect, useRef, useState, createContext, useContext, useCallback } from 'react'
import Icon from '../lib/icons.jsx'
import { statusOf, toneClass } from '../lib/format.js'

/* ───────────────────────── Button ─────────────────────────
   QA fix F-M7: `busy` disables the button + shows progress so impatient
   taps can't create duplicate submissions. */
const BTN = {
  primary:   'bg-brand-700 text-white hover:bg-brand-600 active:bg-brand-800 shadow-card',
  secondary: 'bg-surface text-brand-700 ring-1 ring-brand-700/30 hover:bg-brand-50',
  ghost:     'bg-transparent text-ink-2 hover:bg-surface-2',
  subtle:    'bg-surface-2 text-ink-2 hover:bg-line',
  danger:    'bg-danger-fg text-white hover:opacity-90',
  carrot:    'bg-carrot-400 text-white hover:bg-carrot-600 shadow-card',
}
const SIZE = { sm: 'h-9 px-3 text-sm gap-1.5', md: 'h-11 px-4 text-base gap-2', lg: 'h-12 px-5 text-base gap-2', block: 'h-12 px-5 w-full text-base gap-2' }

export function Button({ variant = 'primary', size = 'md', icon, iconRight, busy, children, className = '', ...rest }) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-md font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${BTN[variant]} ${SIZE[size]} ${className}`}
      disabled={busy || rest.disabled} aria-busy={busy || undefined} {...rest}
    >
      {busy ? <Spinner /> : icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} />}
      {children}
      {!busy && iconRight && <Icon name={iconRight} size={size === 'sm' ? 16 : 18} />}
    </button>
  )
}

export function IconButton({ icon, label, size = 40, variant = 'ghost', className = '', ...rest }) {
  const styles = { ghost: 'text-ink-2 hover:bg-surface-2', chrome: 'text-white/90 bg-white/10 hover:bg-white/20', danger: 'text-danger-fg hover:bg-danger-bg' }
  return (
    <button aria-label={label} title={label} style={{ width: size, height: size }}
      className={`inline-flex items-center justify-center rounded-md shrink-0 ${styles[variant]} ${className}`} {...rest}>
      <Icon name={icon} size={Math.round(size * 0.5)} />
    </button>
  )
}

export const Spinner = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity=".25" />
    <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
)

/* ───────────────────────── Cards ───────────────────────── */
export function Card({ children, className = '', as: As = 'div', ...rest }) {
  return <As className={`bg-surface rounded-lg shadow-card ring-1 ring-line ${className}`} {...rest}>{children}</As>
}
export function CardHeader({ title, sub, action, icon }) {
  return (
    <div className="flex items-start justify-between gap-3 p-4 pb-2">
      <div className="flex items-start gap-2.5 min-w-0">
        {icon && <span className="mt-0.5 text-brand-700"><Icon name={icon} size={18} /></span>}
        <div className="min-w-0">
          <h3 className="font-semibold text-ink leading-tight">{title}</h3>
          {sub && <p className="text-sm text-muted mt-0.5">{sub}</p>}
        </div>
      </div>
      {action}
    </div>
  )
}
export function Row({ label, value, sub, strong, onClick }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag onClick={onClick}
      className={`w-full flex items-center justify-between gap-3 py-3 border-b border-line last:border-0 text-left ${onClick ? 'hover:bg-surface-2 -mx-4 px-4' : ''}`}>
      <div className="min-w-0">
        <div className="text-ink truncate">{label}</div>
        {sub && <div className="text-sm text-muted truncate">{sub}</div>}
      </div>
      <div className={`tnum shrink-0 ${strong ? 'font-semibold text-ink' : 'text-ink-2'}`}>{value}</div>
    </Tag>
  )
}

/* ───────────── Status pill — the ONE shared vocabulary ───────────── */
export function StatusPill({ status, persona = 'manager', size = 'md', dot = true }) {
  const s = statusOf(status)
  const label = persona === 'tech' ? s.tech : s.label
  const solid = s.solid
  const cls = solid ? 'bg-brand-700 text-white ring-brand-700' : toneClass[s.tone]
  return (
    <span title={s.help}
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold ring-1 ${cls} ${size === 'sm' ? 'text-2xs px-2 py-0.5' : 'text-xs px-2.5 py-1'}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${solid ? 'bg-white' : 'bg-current'}`} />}
      {label}
    </span>
  )
}

export function Badge({ tone = 'neutral', icon, children, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full text-xs font-semibold px-2 py-0.5 ring-1 ${toneClass[tone]} ${className}`}>
      {icon && <Icon name={icon} size={12} />}{children}
    </span>
  )
}

/* Flag chip — used wherever a policy flag appears (amber, with reason) */
export function Flag({ children, size = 'md' }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md bg-warning-bg text-warning-fg font-semibold ring-1 ring-warning-fg/20 ${size === 'sm' ? 'text-2xs px-1.5 py-0.5' : 'text-xs px-2 py-1'}`}>
      <Icon name="flag" size={12} fill />{children}
    </span>
  )
}

/* ───────────────────────── Form fields ───────────────────────── */
export function Field({ label, htmlFor, hint, error, required, children, className = '' }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="block text-sm font-semibold text-ink-2 mb-1.5">
        {label}{required && <span className="text-danger-fg ml-0.5" aria-hidden="true">*</span>}
      </label>
      {children}
      {/* QA fix UX#3: persistent inline error, not a transient toast */}
      {error
        ? <p className="mt-1.5 flex items-center gap-1.5 text-sm text-danger-fg" role="alert"><Icon name="alert-circle" size={14} />{error}</p>
        : hint && <p className="mt-1.5 text-sm text-muted">{hint}</p>}
    </div>
  )
}
const inputCls = (error) => `w-full h-12 px-3.5 rounded-md bg-surface text-ink ring-1 ${error ? 'ring-danger-fg' : 'ring-line'} focus:ring-2 focus:ring-brand-600 outline-none placeholder:text-muted`
export const TextInput = ({ error, className = '', ...p }) => <input className={`${inputCls(error)} ${className}`} aria-invalid={!!error} {...p} />
export const Textarea = ({ error, className = '', rows = 3, ...p }) => <textarea rows={rows} className={`${inputCls(error)} h-auto py-2.5 ${className}`} aria-invalid={!!error} {...p} />
export const Select = ({ error, className = '', children, ...p }) => (
  <div className="relative">
    <select className={`${inputCls(error)} appearance-none pr-10 ${className}`} aria-invalid={!!error} {...p}>{children}</select>
    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"><Icon name="chevron-down" size={18} /></span>
  </div>
)
export function MoneyInput({ value, onChange, error, ...p }) {
  return (
    <div className="relative">
      <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted">$</span>
      <input inputMode="decimal" value={value} onChange={onChange} className={`${inputCls(error)} pl-7 tnum`} aria-invalid={!!error} {...p} />
    </div>
  )
}
export function SearchInput({ className = '', ...p }) {
  return (
    <div className={`relative ${className}`}>
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"><Icon name="search" size={18} /></span>
      <input type="search" className="w-full h-11 pl-10 pr-3 rounded-md bg-surface ring-1 ring-line focus:ring-2 focus:ring-brand-600 outline-none placeholder:text-muted" {...p} />
    </div>
  )
}

/* ───────── Segmented control & Tabs ───────── */
export function Segmented({ options, value, onChange, size = 'md' }) {
  return (
    <div role="tablist" className="inline-flex bg-surface-2 rounded-lg p-1 gap-1">
      {options.map((o) => {
        const v = o.value ?? o, label = o.label ?? o
        const on = v === value
        return (
          <button key={v} role="tab" aria-selected={on} onClick={() => onChange(v)}
            className={`rounded-md font-semibold transition-colors ${size === 'sm' ? 'px-2.5 h-8 text-sm' : 'px-3.5 h-9 text-sm'} ${on ? 'bg-surface text-brand-700 shadow-card' : 'text-muted hover:text-ink-2'}`}>
            {label}
          </button>
        )
      })}
    </div>
  )
}
export function Tabs({ tabs, value, onChange }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line overflow-x-auto no-scrollbar">
      {tabs.map((t) => {
        const v = t.value ?? t, label = t.label ?? t, on = v === value
        return (
          <button key={v} role="tab" aria-selected={on} onClick={() => onChange(v)}
            className={`relative px-3.5 py-2.5 text-sm font-semibold whitespace-nowrap ${on ? 'text-brand-700' : 'text-muted hover:text-ink-2'}`}>
            {label}{t.count != null && <span className="ml-1.5 text-2xs rounded-full bg-surface-2 px-1.5 py-0.5 tnum">{t.count}</span>}
            {on && <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-brand-700 rounded-full" />}
          </button>
        )
      })}
    </div>
  )
}

/* ───────── KPI stat ───────── */
export function KPIStat({ label, value, sub, delta, deltaTone = 'success', icon, hint }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted">{label}</span>
        {icon && <span className="text-brand-700/70"><Icon name={icon} size={18} /></span>}
      </div>
      <div className="mt-1.5 text-3xl font-bold text-ink tnum tracking-tight">{value}</div>
      <div className="mt-1 flex items-center gap-2 text-sm">
        {delta && <span className={`font-semibold ${deltaTone === 'success' ? 'text-success-fg' : deltaTone === 'danger' ? 'text-danger-fg' : 'text-muted'}`}>{delta}</span>}
        {sub && <span className="text-muted">{sub}</span>}
      </div>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  )
}

/* ───────── Empty / error states ───────── */
export function EmptyState({ icon = 'inbox', title, body, action }) {
  return (
    <div className="text-center py-12 px-6">
      <div className="mx-auto w-14 h-14 rounded-2xl bg-brand-50 text-brand-700 grid place-items-center"><Icon name={icon} size={26} /></div>
      <h3 className="mt-4 font-semibold text-ink text-lg">{title}</h3>
      {body && <p className="mt-1 text-muted max-w-sm mx-auto">{body}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  )
}
export function InlineAlert({ tone = 'info', title, children, icon, onClose, action }) {
  const ic = icon || { info: 'info', success: 'check-circle', warning: 'alert', danger: 'alert-circle' }[tone]
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`flex gap-3 rounded-md p-3.5 ring-1 ${toneClass[tone]}`}>
      <Icon name={ic} size={18} className="shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-sm opacity-90">{children}</div>}
        {action && <div className="mt-2">{action}</div>}
      </div>
      {onClose && <button onClick={onClose} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><Icon name="x" size={16} /></button>}
    </div>
  )
}

/* ───────── Avatar ───────── */
export function Avatar({ name, size = 40, tone = 'brand' }) {
  const tones = { brand: 'bg-brand-100 text-brand-800', carrot: 'bg-carrot-50 text-carrot-700', info: 'bg-info-bg text-info-fg' }
  const init = name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()
  return <span style={{ width: size, height: size, fontSize: size * 0.36 }} className={`inline-grid place-items-center rounded-full font-bold shrink-0 ${tones[tone]}`}>{init}</span>
}

/* ───────── ShareBar (breakdown bars) ───────── */
export function ShareBar({ pct, tone = 'brand' }) {
  const c = { brand: 'bg-brand-500', carrot: 'bg-carrot-400', info: 'bg-info-fg' }[tone]
  return <div className="h-2 rounded-full bg-surface-2 overflow-hidden"><div className={`h-full rounded-full ${c}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>
}

/* ───────── Approval trail (accessible stepper) ───────── */
export function ApprovalTrail({ steps }) {
  return (
    <ol className="space-y-0">
      {steps.map((s, i) => {
        const done = s.state === 'done', cur = s.state === 'current'
        return (
          <li key={i} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className={`w-7 h-7 grid place-items-center rounded-full ring-2 ${done ? 'bg-brand-700 text-white ring-brand-700' : cur ? 'bg-surface text-brand-700 ring-brand-700 animate-pulse' : 'bg-surface text-muted ring-line'}`}>
                {done ? <Icon name="check" size={15} /> : <span className="text-xs font-bold tnum">{i + 1}</span>}
              </span>
              {i < steps.length - 1 && <span className={`w-0.5 flex-1 my-1 ${done ? 'bg-brand-700' : 'bg-line'}`} style={{ minHeight: 22 }} />}
            </div>
            <div className="pb-4 -mt-0.5 min-w-0">
              <p className={`font-semibold ${cur ? 'text-brand-700' : done ? 'text-ink' : 'text-muted'}`}>{s.title}</p>
              {s.meta && <p className="text-sm text-muted">{s.meta}</p>}
              {s.note && <p className="text-sm text-ink-2 mt-1 bg-surface-2 rounded-md p-2">{s.note}</p>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/* ───────── Accessible Sheet / Dialog ─────────
   QA fixes: role=dialog, aria-modal, focus trap, Esc to close, focus restore,
   styled (replaces native confirm()/prompt()). */
export function Sheet({ open, onClose, title, children, footer, side = 'bottom', size = 'md' }) {
  const ref = useRef(null), prevFocus = useRef(null)
  useEffect(() => {
    if (!open) return
    prevFocus.current = document.activeElement
    const el = ref.current
    const focusables = () => el.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')
    const first = focusables()[0]; first && first.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab') {
        const f = focusables(); if (!f.length) return
        const a = f[0], b = f[f.length - 1]
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus() }
        else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); prevFocus.current && prevFocus.current.focus() }
  }, [open, onClose])
  if (!open) return null
  const panel = side === 'bottom'
    ? 'absolute inset-x-0 bottom-0 rounded-t-2xl max-h-[88%] animate-sheet-up'
    : `absolute inset-y-0 right-0 w-full ${size === 'lg' ? 'sm:max-w-xl' : 'sm:max-w-md'} sm:rounded-l-2xl`
  return (
    <div className="absolute inset-0 z-50 flex" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="absolute inset-0 bg-ink/40 animate-fade-in" />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title}
        className={`relative bg-surface shadow-sheet flex flex-col ${panel} mx-auto w-full`}>
        <div className="flex items-center justify-between gap-3 p-4 border-b border-line shrink-0">
          <h2 className="font-semibold text-lg text-ink">{title}</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        <div className="overflow-y-auto p-4 flex-1">{children}</div>
        {footer && <div className="p-4 border-t border-line shrink-0 bg-surface">{footer}</div>}
      </div>
    </div>
  )
}

export function ConfirmDialog({ open, onClose, onConfirm, title, body, confirmLabel = 'Confirm', tone = 'danger', itemName }) {
  return (
    <Sheet open={open} onClose={onClose} title={title} side="bottom"
      footer={
        <div className="flex gap-3">
          <Button variant="subtle" size="block" onClick={onClose}>Cancel</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} size="block" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      }>
      <p className="text-ink-2">{body}</p>
      {itemName && <p className="mt-2 font-semibold text-ink bg-surface-2 rounded-md p-3">{itemName}</p>}
    </Sheet>
  )
}

/* ───────── Toast (global, polite live region) ───────── */
const ToastCtx = createContext(null)
export const useToast = () => useContext(ToastCtx)
export function ToastHost({ children }) {
  const [toasts, set] = useState([])
  const push = useCallback((msg, tone = 'success') => {
    const id = Math.random().toString(36).slice(2)
    set((t) => [...t, { id, msg, tone }])
    setTimeout(() => set((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none absolute inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`pointer-events-auto flex items-center gap-2 rounded-full px-4 py-2.5 shadow-pop ring-1 text-sm font-semibold animate-fade-in ${toneClass[t.tone]}`}>
            <Icon name={t.tone === 'success' ? 'check-circle' : t.tone === 'danger' ? 'alert-circle' : 'info'} size={16} />{t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export function Skeleton({ className = '' }) { return <div className={`animate-pulse rounded-md bg-surface-2 ${className}`} /> }
export const Divider = ({ className = '' }) => <hr className={`border-0 border-t border-line ${className}`} />

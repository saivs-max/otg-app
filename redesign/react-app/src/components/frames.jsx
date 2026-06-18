// Device frames for the prototype. In production these wrappers are dropped —
// FieldApp renders full-screen on phones; Console fills the desktop viewport.

export function PhoneFrame({ children, label }) {
  return (
    <div className="flex flex-col items-center">
      {label && <p className="mb-3 text-sm font-semibold text-muted">{label}</p>}
      <div className="relative w-[390px] h-[800px] rounded-[44px] bg-brand-900 p-3 shadow-pop shrink-0">
        <div className="relative w-full h-full rounded-[34px] overflow-hidden bg-bg">
          {/* notch */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-brand-900 rounded-b-2xl z-50" />
          <div className="absolute inset-0 overflow-hidden">{children}</div>
        </div>
      </div>
    </div>
  )
}

export function DesktopFrame({ children, label, url = 'costwise.instacart.com/console' }) {
  return (
    <div className="flex flex-col">
      {label && <p className="mb-3 text-sm font-semibold text-muted">{label}</p>}
      <div className="rounded-xl overflow-hidden shadow-pop ring-1 ring-line bg-surface">
        <div className="flex items-center gap-2 px-4 h-10 bg-surface-2 border-b border-line">
          <span className="w-3 h-3 rounded-full bg-[#FF5F57]" /><span className="w-3 h-3 rounded-full bg-[#FEBC2E]" /><span className="w-3 h-3 rounded-full bg-[#28C840]" />
          <div className="ml-3 flex-1 max-w-md h-6 rounded-md bg-surface ring-1 ring-line flex items-center px-3 text-xs text-muted">{url}</div>
        </div>
        <div className="h-[760px] overflow-hidden">{children}</div>
      </div>
    </div>
  )
}

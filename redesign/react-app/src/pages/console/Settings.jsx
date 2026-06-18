import { useState } from 'react'
import Icon from '../../lib/icons.jsx'
import { Card, CardHeader, Button, Badge, Field, TextInput, Segmented, InlineAlert, Divider, useToast } from '../../components/ui.jsx'

// Purpose: org-level configuration — integrations, notifications, work-order sync
// and appearance. Surface every setting clearly (QA). Keys are masked and stored
// once at org level; PM-only controls are disabled for other roles.
const NOTIFS = [
  { key: 'submission', label: 'New submission', desc: 'When a technician submits an invoice' },
  { key: 'aging', label: 'Aging > 3 days', desc: 'Reminder when an approval passes SLA' },
  { key: 'flagged', label: 'Flagged routed to Sr', desc: 'When an invoice escalates to senior sign-off' },
  { key: 'paid', label: 'Paid', desc: 'When a batch is marked paid by AP' },
]

export default function Settings({ role, nav }) {
  const toast = useToast()
  const isPM = role === 'pm'
  const [notifs, setNotifs] = useState({ submission: 'On', aging: 'On', flagged: 'On', paid: 'Off' })

  return (
    <div className="p-5 space-y-4 max-w-content">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-ink">Settings</h2>
        <p className="text-sm text-muted">Integrations, notifications and org-level configuration</p>
      </div>

      {!isPM && (
        <InlineAlert tone="info" title="Some settings are Program Manager–only">
          Integrations and sync are managed by a PM and shown here read-only. Your notification preferences are still editable.
        </InlineAlert>
      )}

      {/* Integrations */}
      <Card>
        <CardHeader title="Integrations" sub="Work-order sources · keys are masked & stored once at the org level" icon="link" />
        <div className="px-4 pb-4 space-y-5">
          {/* Freshdesk */}
          <div>
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2 font-semibold text-ink"><Icon name="receipt" size={18} className="text-brand-700" />Freshdesk</div>
              <Badge tone="success" icon="check-circle">Connected</Badge>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Subdomain" htmlFor="fd-sub">
                <TextInput id="fd-sub" defaultValue="instacart-field" disabled={!isPM} />
              </Field>
              <Field label="API key" htmlFor="fd-key" hint="Masked — entered once, never shown again">
                <TextInput id="fd-key" type="password" defaultValue="fd_live_xxxxxxxxxxxx" disabled={!isPM} />
              </Field>
            </div>
            <div className="mt-3">
              <Button variant="secondary" size="sm" icon="refresh" disabled={!isPM} onClick={() => toast('Freshdesk connection OK', 'success')}>Test connection</Button>
            </div>
          </div>

          <Divider />

          {/* MaintainX */}
          <div>
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-2 font-semibold text-ink"><Icon name="briefcase" size={18} className="text-brand-700" />MaintainX</div>
              <Badge tone="success" icon="check-circle">Connected</Badge>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="API token" htmlFor="mx-token" hint="Masked — entered once, never shown again">
                <TextInput id="mx-token" type="password" defaultValue="mx_tok_xxxxxxxxxxxx" disabled={!isPM} />
              </Field>
            </div>
            <div className="mt-3">
              <Button variant="secondary" size="sm" icon="refresh" disabled={!isPM} onClick={() => toast('MaintainX connection OK', 'success')}>Test connection</Button>
            </div>
          </div>
        </div>
      </Card>

      {/* Notifications */}
      <Card>
        <CardHeader title="Notifications" sub="What lands in your inbox" icon="bell" />
        <div className="px-4 pb-2">
          {NOTIFS.map((n) => (
            <div key={n.key} className="flex items-center justify-between gap-4 py-3 border-t border-line first:border-0">
              <div className="min-w-0">
                <div className="font-medium text-ink">{n.label}</div>
                <p className="text-sm text-muted">{n.desc}</p>
              </div>
              <Segmented size="sm" options={['On', 'Off']} value={notifs[n.key]}
                onChange={(v) => { setNotifs((s) => ({ ...s, [n.key]: v })); toast('Notification preference saved') }} />
            </div>
          ))}
        </div>
      </Card>

      {/* Sync */}
      <Card>
        <CardHeader title="Sync" sub="Work orders pull from the source systems" icon="refresh" />
        <div className="px-4 pb-4">
          <div className="flex items-center justify-between gap-4 py-1">
            <div className="min-w-0">
              <div className="font-medium text-ink">Work orders sync every 15 min (read-only)</div>
              <p className="text-sm text-muted">Last synced 4 min ago · MaintainX + Freshdesk</p>
            </div>
            <Button variant="secondary" size="sm" icon="refresh" disabled={!isPM} onClick={() => toast('Sync started', 'info')}>Sync now</Button>
          </div>
        </div>
      </Card>

      {/* Appearance */}
      <Card>
        <CardHeader title="Appearance" sub="How the console looks on this device" icon="settings" />
        <div className="px-4 pb-4 space-y-3">
          <Field label="Theme" htmlFor="theme">
            <Segmented options={['System', 'Light']} value="System" onChange={() => toast('Theme updated')} />
          </Field>
          <p className="text-sm text-muted">Text size respects your device accessibility settings.</p>
        </div>
      </Card>
    </div>
  )
}

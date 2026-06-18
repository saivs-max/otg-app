import { useState } from 'react'
import { Card, CardHeader, KPIStat, Button, IconButton, Badge, Avatar, Field, TextInput, Select, InlineAlert, Tabs, Sheet, ConfirmDialog, useToast } from '../../components/ui.jsx'
import { num } from '../../lib/format.js'
import { USERS, ROLE_LABEL } from '../../data/mock.js'

// Purpose: manage users, roles and the technician → manager mapping. Invite flow
// + Active/Disabled tabs + a scannable roster. Last-admin protection guards the
// final Program Manager from being disabled.
const ROLE_TONE = { technician: 'neutral', ops_manager: 'info', sr_manager: 'warning', pm: 'ap' }
const email = (u) => (u.id === 'priya' || u.id === 'sai') ? `${u.name.split(' ')[0].toLowerCase()}@instacartroot.com` : `${u.id}@instacartroot.com`

export default function Admin({ role, nav }) {
  const toast = useToast()
  const users = Object.values(USERS)
  const [tab, setTab] = useState('active')
  const [invite, setInvite] = useState(false)
  const [disabling, setDisabling] = useState(null) // user pending disable

  const total = users.length
  const techs = users.filter((u) => u.role === 'technician').length
  const managers = users.filter((u) => ['ops_manager', 'sr_manager', 'pm'].includes(u.role)).length

  return (
    <div className="p-5 space-y-4 max-w-content">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Users & roles</h2>
          <p className="text-sm text-muted">Accounts, roles and technician → manager mapping</p>
        </div>
        <div className="ml-auto">
          <Button icon="plus" onClick={() => setInvite(true)}>Invite user</Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-3 gap-3">
        <KPIStat label="Total users" value={num(total, 0)} sub="this org" icon="users" />
        <KPIStat label="Technicians" value={num(techs, 0)} sub="in the field" icon="user" />
        <KPIStat label="Managers" value={num(managers, 0)} sub="Ops · Sr · PM" icon="shield" />
      </div>

      <InlineAlert tone="warning" title="Last-admin protection">
        You can't disable the last Program Manager — at least one PM must always retain admin access.
      </InlineAlert>

      {/* Roster */}
      <Card>
        <CardHeader title="Roster" sub="Roles, type and reporting line" icon="users" />
        <div className="px-4 pt-1">
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'active', label: 'Active', count: total }, { value: 'disabled', label: 'Disabled', count: 0 }]} />
        </div>
        <div className="px-2 pb-1 overflow-x-auto">
          {tab === 'active' ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-2xs uppercase tracking-wide text-muted">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Manager</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-line hover:bg-surface-2">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <Avatar name={u.name} size={26} />
                        <span className="truncate font-medium text-ink">{u.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-ink-2">{email(u)}</td>
                    <td className="px-3 py-2.5"><Badge tone={ROLE_TONE[u.role]}>{ROLE_LABEL[u.role]}</Badge></td>
                    <td className="px-3 py-2.5 text-ink-2">{u.role === 'technician' ? u.type : '—'}</td>
                    <td className="px-3 py-2.5 text-ink-2">{USERS[u.mgr]?.name || '—'}</td>
                    <td className="px-3 py-2.5"><Badge tone="success">Active</Badge></td>
                    <td className="px-3 py-2.5 text-right">
                      <IconButton icon="more-vertical" label={`Manage ${u.name}`} size={32} onClick={() => setDisabling(u)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="px-1 py-10 text-center text-muted text-sm">No disabled users.</div>
          )}
        </div>
      </Card>

      {/* Invite sheet */}
      <Sheet open={invite} onClose={() => setInvite(false)} side="right" title="Invite user"
        footer={
          <div className="flex gap-3">
            <Button variant="subtle" size="block" onClick={() => setInvite(false)}>Cancel</Button>
            <Button size="block" icon="send" onClick={() => { setInvite(false); toast('Invitation sent') }}>Send invite</Button>
          </div>
        }>
        <div className="space-y-3">
          <Field label="Full name" htmlFor="inv-name" required>
            <TextInput id="inv-name" placeholder="e.g. Jordan Lee" />
          </Field>
          <Field label="Email" htmlFor="inv-email" required>
            <TextInput id="inv-email" type="email" placeholder="name@instacartroot.com" />
          </Field>
          <Field label="Role" htmlFor="inv-role">
            <Select id="inv-role" defaultValue="technician">
              <option value="technician">Technician</option>
              <option value="ops_manager">Ops Manager</option>
              <option value="sr_manager">Senior Manager</option>
              <option value="pm">Program Manager</option>
            </Select>
          </Field>
          <Field label="Type" htmlFor="inv-type">
            <Select id="inv-type" defaultValue="Contractor">
              <option value="Contractor">Contractor</option>
              <option value="FTE">FTE</option>
            </Select>
          </Field>
          <Field label="Manager" htmlFor="inv-mgr" hint="Who this user reports to">
            <Select id="inv-mgr" defaultValue="maitland">
              {Object.values(USERS).filter((u) => u.role !== 'technician').map((m) => (
                <option key={m.id} value={m.id}>{m.name} · {ROLE_LABEL[m.role]}</option>
              ))}
            </Select>
          </Field>
        </div>
      </Sheet>

      {/* Disable confirm */}
      <ConfirmDialog
        open={!!disabling}
        onClose={() => setDisabling(null)}
        onConfirm={() => { const n = disabling?.name; setDisabling(null); toast(`${n} disabled`, 'info') }}
        title="Disable user"
        body="Disabled users lose access immediately but their history is preserved. You can re-enable them later."
        confirmLabel="Disable user"
        itemName={disabling ? `${disabling.name} · ${ROLE_LABEL[disabling.role]}` : ''}
      />
    </div>
  )
}

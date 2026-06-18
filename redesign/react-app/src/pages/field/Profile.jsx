import { Card, CardHeader, Row, Avatar, Button, Badge, Divider } from '../../components/ui.jsx'
import { money } from '../../lib/format.js'

// Purpose: one place for the actions that used to be hidden (QA review UX #6):
// hourly rate, password, notifications, help, sign out.
export default function Profile({ me, nav }) {
  return (
    <div className="p-4 space-y-3.5 pb-6">
      <Card className="p-4 flex items-center gap-3">
        <Avatar name={me.name} size={56} />
        <div>
          <div className="font-bold text-ink text-lg">{me.name}</div>
          <div className="flex items-center gap-2 text-sm text-muted"><Badge tone="info">{me.type}</Badge> {me.region}</div>
        </div>
      </Card>

      <CardHeader title="Pay" icon="paid" />
      <Card className="p-4">
        <Row label="Hourly rate" value={money(me.rateCents)} sub="Tap to request a change" onClick={() => {}} />
        <Row label="Mileage rate" value="$0.725 / mi" sub="Set by policy" />
        <Row label="Payment terms" value="Net 7 (pilot)" />
      </Card>

      <CardHeader title="Account" icon="settings" />
      <Card className="p-4">
        <Row label="Notifications" value="On" onClick={() => {}} />
        <Row label="Change password" value="" onClick={() => {}} />
        <Row label="Help & glossary" value="" sub="What do these terms mean?" onClick={() => {}} />
      </Card>

      <Button variant="subtle" size="block" icon="logout" onClick={() => nav('login')}>Sign out</Button>
      <p className="text-center text-2xs text-muted">Caper CostWise · v1.0 · Field Cost &amp; Operations</p>
    </div>
  )
}

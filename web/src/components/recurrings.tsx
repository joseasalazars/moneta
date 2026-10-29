import { useState } from 'react'
import { CalendarClockIcon } from 'lucide-react'
import { CategoryBadge } from '@/components/badges'
import { BillsCalendar } from '@/components/bills-calendar'
import { TxnRow } from '@/components/txn-row'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { type Recurring, api, money, money0, monthLabel, shortDate, thisMonth, todayISO } from '@/lib/api'
import { useData } from '@/lib/data'

// Two kinds of schedule. "Add it for me": the app adds the payment on each due date (e.g. a laptop paid in full, spread
// over 12 months), then stops. "I pay it myself": nothing is added; the app finds your bank's payment by name, counts
// it under this category, and reminds you on each due date until it shows up (a store-card plan you pay by hand).
function ScheduleForm({ onDone }: { onDone: () => void }) {
  const { accounts, categories, reload } = useData()
  const [f, setF] = useState({ name: '', amount: '', account: '', category: '', type: 'regular', frequency: 'monthly', start_date: todayISO(), count: '12', match: '' })
  const [paidBy, setPaidBy] = useState<'added' | 'bill'>('added')
  const [affectsBalance, setAffectsBalance] = useState(true)
  const [error, setError] = useState('')
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))

  async function save() {
    try {
      if (paidBy === 'bill' && !f.match.trim()) throw new Error('Say how your bank names the payment, so it can be found')
      await api('/api/schedules', paidBy === 'bill' ? { ...f, type: 'regular', match: f.match.trim() } : { ...f, match: null, affects_balance: affectsBalance })
      await reload()
      onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5 sm:max-w-md">
        <Label>How is it paid?</Label>
        <Select value={paidBy} onValueChange={(v) => setPaidBy(v as 'added' | 'bill')}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="added">The app adds it for me on each date</SelectItem>
            <SelectItem value="bill">I pay it myself: find my payment and remind me</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5"><Label>Name</Label><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Laptop" /></div>
        <div className="grid gap-1.5"><Label>Amount each time</Label><Input type="number" step="0.01" value={f.amount} onChange={(e) => set('amount', e.target.value)} /></div>
        <div className="grid gap-1.5">
          <Label>{paidBy === 'bill' ? 'Paid to (the card or loan)' : 'Account'}</Label>
          <Input list="schedule-accounts" value={f.account} onChange={(e) => set('account', e.target.value)} placeholder="Apple Card" />
          <datalist id="schedule-accounts">{accounts.map((a) => <option key={a.account_id} value={a.name} />)}</datalist>
        </div>
        <div className="grid gap-1.5">
          <Label>Category</Label>
          <Input list="schedule-categories" value={f.category} onChange={(e) => set('category', e.target.value)} />
          <datalist id="schedule-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </div>
        {paidBy === 'bill' && (
          <div className="grid gap-1.5">
            <Label>Your bank calls the payment</Label>
            <Input value={f.match} onChange={(e) => set('match', e.target.value)} placeholder="PAYPAL INST XFER" />
          </div>
        )}
        {paidBy === 'added' && <div className="grid gap-1.5">
          <Label>Type</Label>
          <Select value={f.type} onValueChange={(v) => set('type', v)}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="regular">Expense</SelectItem>
              <SelectItem value="income">Income (use a negative amount)</SelectItem>
              <SelectItem value="internal transfer">Transfer / card payment</SelectItem>
            </SelectContent>
          </Select>
        </div>}
        <div className="grid gap-1.5">
          <Label>Every</Label>
          <Select value={f.frequency} onValueChange={(v) => set('frequency', v)}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="weekly">Week</SelectItem>
              <SelectItem value="biweekly">2 weeks</SelectItem>
              <SelectItem value="monthly">Month</SelectItem>
              <SelectItem value="annually">Year</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5"><Label>First payment</Label><Input type="date" value={f.start_date} onChange={(e) => set('start_date', e.target.value)} /></div>
          <div className="grid gap-1.5"><Label>Payments</Label><Input type="number" min="1" value={f.count} onChange={(e) => set('count', e.target.value)} placeholder="No end" /></div>
        </div>
      </div>
      {paidBy === 'bill' ? (
        <p className="text-muted-foreground text-xs">
          Each payment from your bank whose name contains that text (from half the amount up to the amount) counts as this
          category, in date order, up to the number of payments. The bell reminds you from the day before each due date.
        </p>
      ) : <div className="flex items-center gap-2">
        <Switch id="affects" checked={affectsBalance} onCheckedChange={setAffectsBalance} />
        {/* Off for budgeting-only spreads like a laptop paid over months: the money already left in one real charge. */}
        <Label htmlFor="affects">Changes the account balance (turn off for a purchase you are only spreading over months)</Label>
      </div>}
      {error && <p className="text-destructive text-sm">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={save}>Create schedule</Button>
        <Button variant="outline" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  )
}

function ScheduleBadge({ r }: { r: Recurring }) {
  if (!r.schedule) return null
  const text = r.schedule.remaining == null ? 'Auto' : r.schedule.remaining > 0 ? `${r.schedule.remaining} left` : 'Done'
  return <Badge variant="outline" className="gap-1"><CalendarClockIcon className="size-3" aria-hidden />{text}</Badge>
}

// Recurring = transactions sharing a recurring name; assign one from the transaction editor to start tracking it.
export function Recurrings() {
  const { recurrings, ledger, reload } = useData()
  const [selected, setSelected] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const month = thisMonth()
  const active = recurrings.filter((r) => r.active && r.lastAmount > 0)
  const paid = active.filter((r) => r.lastDate.startsWith(month))
  const upcoming = active.filter((r) => !r.lastDate.startsWith(month) && r.nextDate.startsWith(month))
  const inactive = recurrings.filter((r) => !r.active)
  const current = recurrings.find((r) => r.name === selected) ?? active[0]
  const rows = ledger?.rows.filter((t) => t.recurring === current?.name) ?? []

  const List = ({ title, items }: { title: string; items: Recurring[] }) => items.length > 0 && (
    <div className="grid gap-1">
      <h3 className="text-muted-foreground mt-2 text-xs font-medium uppercase">{title}</h3>
      {items.map((r) => (
        <button
          key={r.name}
          type="button"
          onClick={() => setSelected(r.name)}
          className={`hover:bg-muted/60 flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm ${current?.name === r.name ? 'bg-muted' : ''} ${r.active ? '' : 'opacity-60'}`}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{r.name}</div>
            <div className="text-muted-foreground text-xs">
              {shortDate(r.active && !r.lastDate.startsWith(month) ? r.nextDate : r.lastDate)} · {r.frequency}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ScheduleBadge r={r} />
            <CategoryBadge name={r.category} />
            <span className="w-20 text-right tabular-nums">{money(r.lastAmount)}</span>
          </div>
        </button>
      ))}
    </div>
  )

  const leftToPay = upcoming.reduce((s, r) => s + r.lastAmount, 0)
  // Includes credits (e.g. a monthly reimbursement), matching Copilot's total.
  const paidSoFar = recurrings.filter((r) => r.active).reduce((s, r) => s + r.monthPaid, 0)

  async function stopSchedule(id: number) {
    if (!confirm('Stop this schedule? Payments already added stay.')) return
    await api('/api/schedules/delete', { id })
    await reload()
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="grid content-start gap-4 lg:col-span-3">
        <div className="grid grid-cols-2 gap-4">
          <Card><CardHeader><CardDescription>Left to pay this month</CardDescription><CardTitle className="text-2xl tabular-nums">{money0(leftToPay)}</CardTitle></CardHeader></Card>
          <Card><CardHeader><CardDescription>Paid so far</CardDescription><CardTitle className="text-2xl tabular-nums">{money0(paidSoFar)}</CardTitle></CardHeader></Card>
        </div>
        <BillsCalendar />
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <CardTitle>{monthLabel(month)}</CardTitle>
            {!adding && <Button variant="outline" onClick={() => setAdding(true)}>New scheduled payment</Button>}
          </CardHeader>
          <CardContent className="grid gap-2">
            {adding && <ScheduleForm onDone={() => setAdding(false)} />}
            <List title="Upcoming this month" items={upcoming} />
            <List title="Paid this month" items={paid} />
            <List title="Later" items={active.filter((r) => !paid.includes(r) && !upcoming.includes(r))} />
            <List title="Inactive or finished" items={inactive} />
          </CardContent>
        </Card>
      </div>

      {current && (
        <Card className="h-fit min-w-0 lg:sticky lg:top-4 lg:col-span-2">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CategoryBadge name={current.category} />
              <span className="text-muted-foreground text-sm">{current.frequency} · {current.account}</span>
            </div>
            <CardTitle className="text-xl">{current.name}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div><div className="text-muted-foreground text-xs">Next</div>{current.active ? shortDate(current.nextDate) : 'None'}</div>
              <div><div className="text-muted-foreground text-xs">Average</div>{money(current.avgAmount)}</div>
              <div><div className="text-muted-foreground text-xs">Last 12 mo.</div>{money0(current.yearTotal)}</div>
            </div>
            {current.schedule && (
              <div className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
                <span>
                  {current.schedule.bill ? 'You pay this yourself, alert on the due date' : 'Added automatically'}
                  {current.schedule.remaining != null && current.schedule.endDate && ` · ${current.schedule.remaining} left, last on ${shortDate(current.schedule.endDate)} ${current.schedule.endDate.slice(0, 4)}`}
                </span>
                <Button size="sm" variant="outline" onClick={() => stopSchedule(current.schedule!.id)}>Stop</Button>
              </div>
            )}
            {!current.schedule && current.nextDate < todayISO() && current.active && (
              <p className="text-sm text-amber-700 dark:text-amber-400">Expected {shortDate(current.nextDate)}, not seen yet.</p>
            )}
            <div className="grid min-w-0">{rows.slice(0, 15).map((t) => <TxnRow key={t.id} t={t} compact />)}</div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

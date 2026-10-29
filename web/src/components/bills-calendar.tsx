import { useMemo, useState } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, CircleCheckIcon, CircleDashedIcon, CircleXIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type Recurring, money, money0, monthLabel, prevMonth, shortDate, thisMonth, todayISO } from '@/lib/api'
import { categoryStyle } from '@/lib/categories'
import { useData } from '@/lib/data'

type Bill = { date: string; name: string; amount: number; category: string; status: 'paid' | 'upcoming' | 'missed' }

const nextMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7)
}
const STEP: Record<string, [months: number, days: number]> = {
  Weekly: [0, 7], Biweekly: [0, 14], Monthly: [1, 0], Bimonthly: [2, 0], Quarterly: [3, 0], Semiannually: [6, 0], Annually: [12, 0],
}
// Same day-of-month clamping as the server's addMonths (Jan 31 + 1 month = Feb 28).
function step(date: string, [months, days]: [number, number]) {
  if (days) return new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10)
  const d = new Date(`${date}T00:00:00Z`), day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()))
  return d.toISOString().slice(0, 10)
}

// Paid = this month's real charges linked to a recurring; upcoming = each active recurring projected from its next
// date (a schedule stops at its last payment); missed = an active one whose next date has already passed.
function billsFor(month: string, recurrings: Recurring[], rows: { date: string; name: string; amount: number; category: string; recurring: string | null }[], today: string) {
  const out: Bill[] = []
  for (const t of rows) if (t.recurring && t.date.startsWith(month)) out.push({ date: t.date, name: t.recurring, amount: t.amount, category: t.category, status: 'paid' })
  for (const r of recurrings) {
    if (!r.active || !STEP[r.frequency]) continue
    const end = r.schedule?.endDate ?? '9999-12-31'
    if (r.nextDate < today && r.nextDate.startsWith(month)) out.push({ date: r.nextDate, name: r.name, amount: r.avgAmount, category: r.category, status: 'missed' })
    for (let d = r.nextDate, i = 0; d <= `${month}-31` && d <= end && i < 60; d = step(d, STEP[r.frequency]), i++) {
      if (d >= today && d.startsWith(month)) out.push({ date: d, name: r.name, amount: r.lastAmount, category: r.category, status: 'upcoming' })
    }
  }
  return out
}

// Cents only where rounding would show $0 (Daily Cash is $0.30).
const small = (n: number) => (n < 10 ? money(n) : money0(n))

const ICON = { paid: CircleCheckIcon, upcoming: CircleDashedIcon, missed: CircleXIcon }
const WORD = { paid: 'Paid', upcoming: 'Upcoming', missed: 'Not seen yet' }
const COLOR = { paid: 'var(--status-good)', upcoming: 'var(--muted-foreground)', missed: 'var(--status-critical)' }

export function BillsCalendar() {
  const { recurrings, ledger } = useData()
  const today = todayISO()
  const [month, setMonth] = useState(thisMonth())
  const [day, setDay] = useState<string | null>(today)
  const bills = useMemo(() => billsFor(month, recurrings, ledger?.rows ?? [], today), [month, recurrings, ledger, today])
  const byDay = new Map<string, Bill[]>()
  for (const b of bills) byDay.set(b.date, [...(byDay.get(b.date) ?? []), b])
  const first = new Date(`${month}-01T12:00:00`)
  const lead = first.getDay()
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)]
  const outflow = (list: Bill[]) => list.filter((b) => b.amount > 0).reduce((s, b) => s + b.amount, 0)
  const picked: Bill[] = day?.startsWith(month) ? (byDay.get(day) ?? []) : []
  const min = prevMonth(prevMonth(thisMonth())), max = nextMonth(nextMonth(nextMonth(thisMonth())))

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div className="grid gap-1">
          <CardTitle>Bills calendar</CardTitle>
          <CardDescription>{money0(outflow(bills))} in {monthLabel(month)} · {money0(outflow(bills.filter((b) => b.status !== 'paid')))} still to come</CardDescription>
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" aria-label="Previous month" disabled={month <= min} onClick={() => setMonth(prevMonth(month))}><ChevronLeftIcon /></Button>
          <Button size="sm" variant="ghost" onClick={() => { setMonth(thisMonth()); setDay(today) }}>Today</Button>
          <Button size="icon" variant="ghost" aria-label="Next month" disabled={month >= max} onClick={() => setMonth(nextMonth(month))}><ChevronRightIcon /></Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border bg-border text-xs">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="bg-card text-muted-foreground py-1.5 text-center">{d}</div>)}
          {cells.map((d, i) => {
            if (!d) return <div key={`x${i}`} className="bg-muted/40" />
            const list = byDay.get(d) ?? []
            const out = outflow(list), income = -list.filter((b) => b.amount < 0).reduce((s, b) => s + b.amount, 0)
            return (
              <button key={d} type="button" onClick={() => setDay(d)} aria-label={`${shortDate(d)}: ${list.length} bills`}
                className={`bg-card hover:bg-muted grid min-h-16 content-between gap-1 p-1.5 text-left ${day === d ? 'ring-primary ring-2 ring-inset' : ''}`}>
                <span className={`size-5 rounded-full text-center leading-5 ${d === today ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>{Number(d.slice(8))}</span>
                <span className="flex flex-wrap gap-0.5" aria-hidden>
                  {list.slice(0, 3).map((b, j) => <span key={j} className={b.status === 'paid' ? 'opacity-50' : ''}>{categoryStyle(b.category).emoji}</span>)}
                  {list.length > 3 && <span className="text-muted-foreground">+{list.length - 3}</span>}
                </span>
                {out > 0 && <span className="truncate tabular-nums">{small(out)}</span>}
                {income > 0 && <span className="truncate tabular-nums" style={{ color: 'var(--status-good)' }}>+{small(income)}</span>}
              </button>
            )
          })}
        </div>
        <div className="grid gap-1">
          <h3 className="text-muted-foreground text-xs font-medium uppercase">{day?.startsWith(month) ? shortDate(day) : 'Pick a day'}</h3>
          {day?.startsWith(month) && picked.length === 0 && <p className="text-muted-foreground text-sm">Nothing due.</p>}
          {picked.map((b, i) => {
            const Icon = ICON[b.status]
            return (
              <div key={i} className="flex items-center justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <Icon className="size-4 shrink-0" style={{ color: COLOR[b.status] }} aria-hidden />
                  <span className="truncate">{b.name}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">{WORD[b.status]}</span>
                </span>
                <span className="tabular-nums" style={b.amount < 0 ? { color: 'var(--status-good)' } : undefined}>{b.amount < 0 ? `+${money(-b.amount)}` : money(b.amount)}</span>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, daysIn, isIncome, isSpend, money0, monthLabel, prevMonth, thisMonth, todayISO } from '@/lib/api'
import { useData } from '@/lib/data'


// A 270° ring: the track is the whole budget, the fill what's spent. Over budget, the fill is full and turns critical
// (with words underneath, never color alone).
function Ring({ pct, over }: { pct: number; over: boolean }) {
  const r = 70, c = 2 * Math.PI * r, arc = c * 0.75
  const fill = arc * Math.min(1, Math.max(0, pct))
  return (
    <svg viewBox="0 0 180 180" className="size-44" aria-hidden>
      <circle cx="90" cy="90" r={r} fill="none" stroke="var(--muted)" strokeWidth="12" strokeLinecap="round"
        strokeDasharray={`${arc} ${c}`} transform="rotate(135 90 90)" />
      {fill > 0 && (
        <circle cx="90" cy="90" r={r} fill="none" stroke={over ? 'var(--status-critical)' : 'var(--chart-1)'} strokeWidth="12"
          strokeLinecap="round" strokeDasharray={`${fill} ${c}`} transform="rotate(135 90 90)" />
      )}
    </svg>
  )
}

function Line({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 text-sm">
      <span>{label}</span>
      <span className="tabular-nums">{sub && <span className="text-muted-foreground mr-2 text-xs">{sub}</span>}{value}</span>
    </div>
  )
}

export function LeftToSpend({ month }: { month: string }) {
  const { ledger, recurrings } = useData()
  const [budget, setBudget] = useState(0)
  // What you save each month is the sum of your goals; the budget is what's meant to be left after them.
  const [goals, setGoals] = useState<{ name: string; monthly: number }[]>([])
  useEffect(() => {
    api<{ amount: number }[]>('/api/budgets').then((b) => setBudget(b.reduce((s, x) => s + x.amount, 0)))
    api<{ name: string; monthly: number }[]>('/api/goals').then(setGoals)
  }, [])
  const SAVE = goals.reduce((s, g) => s + g.monthly, 0)
  const rows = ledger?.rows ?? []
  const isCurrent = month === thisMonth()
  const today = todayISO()
  const end = `${month}-${String(daysIn(month)).padStart(2, '0')}`

  const s = useMemo(() => {
    const cur = rows.filter((t) => t.date.startsWith(month))
    const spend = cur.filter(isSpend)
    const spent = spend.reduce((a, t) => a + t.amount, 0)
    const fixed = spend.filter((t) => t.recurring).reduce((a, t) => a + t.amount, 0)
    // Typical income: the three months before this one, so a paycheck that hasn't landed yet doesn't read as zero.
    const before = [prevMonth(month), prevMonth(prevMonth(month)), prevMonth(prevMonth(prevMonth(month)))]
    const typical = before.reduce((a, m) => a - rows.filter((t) => t.date.startsWith(m) && isIncome(t)).reduce((x, t) => x + t.amount, 0), 0) / 3
    const income = -cur.filter(isIncome).reduce((a, t) => a + t.amount, 0)
    // Bills still to come this month: they're already spoken for, so they come out of what's free to spend.
    const due = isCurrent ? recurrings.filter((r) => r.active && r.lastAmount > 0 && r.nextDate > today && r.nextDate <= end
      && !['Transfer', 'Income'].includes(r.category)) : []
    return { spent, fixed, typical, income, due, dueTotal: due.reduce((a, r) => a + r.lastAmount, 0) }
  }, [rows, recurrings, month, isCurrent, today, end])

  if (!budget) return null
  const left = budget - s.spent
  const free = left - s.dueTotal
  const daysLeft = isCurrent ? daysIn(month) - Number(today.slice(8, 10)) + 1 : 0
  // Pacing on flexible spending only: rent and other bills land early in the month and would always read as "ahead".
  const flexBudget = Math.max(0, budget - s.fixed - s.dueTotal)
  const flexSpent = s.spent - s.fixed
  const expected = isCurrent ? flexBudget * (Number(today.slice(8, 10)) / daysIn(month)) : flexBudget
  const pace = flexSpent - expected

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isCurrent ? 'Left to spend' : `${monthLabel(month)} budget`}</CardTitle>
        <CardDescription>{money0(budget)} monthly budget · saving {money0(SAVE)}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="relative mx-auto">
          <Ring pct={s.spent / budget} over={left < 0} />
          <div className="absolute inset-0 grid place-content-center text-center">
            <span className="text-muted-foreground text-xs">{left < 0 ? 'Over budget' : isCurrent ? 'Left' : 'Under budget'}</span>
            <span className="text-2xl font-semibold tabular-nums">{money0(Math.abs(left))}</span>
            <span className="text-muted-foreground text-xs">spent {money0(s.spent)}</span>
          </div>
        </div>
        {isCurrent && left > 0 && (
          <p className="text-center text-sm">
            {free > 0
              ? <>After {money0(s.dueTotal)} in bills still due, <span className="font-medium">{money0(free)}</span> is free · about {money0(free / daysLeft)} a day</>
              : <>The {money0(s.dueTotal)} in bills still due take the rest of the budget.</>}
          </p>
        )}
        {isCurrent && flexBudget > 0 && (
          <p className="text-muted-foreground text-center text-xs">
            Day-to-day spending {money0(flexSpent)} of {money0(flexBudget)}: {Math.abs(pace) < 25 ? 'on pace' : `${money0(Math.abs(pace))} ${pace > 0 ? 'ahead of' : 'behind'} pace`}
          </p>
        )}
        <div className="divide-y rounded-md border px-3">
          <Line label="Income" value={money0(s.income)} sub={isCurrent ? `usually ${money0(s.typical)}` : undefined} />
          <Line label="Save" value={money0(SAVE)} sub={goals.map((g) => g.name).join(' + ') || 'no goals yet'} />
          <Line label="Budget" value={money0(budget)} />
          {isCurrent
            ? <Line label="Left over" value={money0(s.typical - SAVE - budget)} sub="usual income, on budget" />
            : <Line label="Left over" value={money0(s.income - s.spent - SAVE)} sub="after saving" />}
        </div>
      </CardContent>
    </Card>
  )
}

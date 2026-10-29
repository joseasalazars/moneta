import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { ArrowDownRightIcon, ArrowUpRightIcon } from 'lucide-react'
import { Bar, TagBadge } from '@/components/badges'
import { HealthCard } from '@/components/health'
import { LeftToSpend } from '@/components/left-to-spend'
import { NetWorthCard } from '@/components/net-worth'
import { TxnRow } from '@/components/txn-row'
import {
  type Txn, addDaysISO, daysIn, isIncome, isSpend, money, money0, monthLabel, prevMonth, shortDate, thisMonth, todayISO,
} from '@/lib/api'
import { categoryStyle } from '@/lib/categories'
import { useData } from '@/lib/data'

const sum = (list: Txn[]) => list.reduce((s, t) => s + t.amount, 0)
const round = (n: number) => Math.round(n * 100) / 100

function Kpi({ title, value, hint }: { title: string; value: string; hint?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint && <CardContent className="text-muted-foreground -mt-2 text-sm">{hint}</CardContent>}
    </Card>
  )
}

// First run: nothing linked, nothing typed in. Say how to start instead of a dashboard full of $0.
function Welcome() {
  const steps: [string, React.ReactNode][] = [
    ['Connect a bank', <>Use <span className="font-medium">Connect account</span> at the top right. It needs Plaid keys in <code>.env</code> (free sandbox keys at dashboard.plaid.com); with sandbox keys, pick any test bank and sign in with <code>user_good</code> / <code>pass_good</code>.</>],
    ['Add an account by hand', <>For anything Plaid can't reach (cash, a store card, an HSA, Bitcoin or gold): <a className="underline" href="#accounts">Accounts → Add manual account</a>.</>],
    ['Coming from Copilot Money?', <>Import your Copilot CSV export to keep your history, categories and tags. The README explains how.</>],
    ['Just looking around?', <>Run <code>npm run demo</code> instead to explore with a made-up person's data.</>],
  ]
  return (
    <Card className="mx-auto w-full max-w-2xl">
      <CardHeader>
        <CardTitle className="text-xl">Welcome to Moneta</CardTitle>
        <CardDescription>Everything stays on this computer. Start with any of these:</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {steps.map(([title, text], i) => (
          <div key={title} className="flex gap-3">
            <span className="bg-muted grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium">{i + 1}</span>
            <div className="grid gap-0.5 text-sm"><span className="font-medium">{title}</span><span className="text-muted-foreground">{text}</span></div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export function Dashboard({ month }: { month: string }) {
  const { ledger, recurrings, networth, accounts } = useData()
  const rows = ledger?.rows ?? []
  const prev = prevMonth(month)
  const isCurrent = month === thisMonth()
  const today = new Date().getDate()

  const stats = useMemo(() => {
    const cur = rows.filter((t) => t.date.startsWith(month))
    const last = rows.filter((t) => t.date.startsWith(prev))
    const spend = cur.filter(isSpend), lastSpend = last.filter(isSpend)

    // Cumulative spend by day of month, this month vs last; future days left empty.
    const byDay = (list: Txn[], n: number) => {
      const daily = Array<number>(n + 1).fill(0)
      for (const t of list) daily[Number(t.date.slice(8, 10))] += t.amount
      let run = 0
      return daily.map((v) => (run += v))
    }
    const curDays = byDay(spend, daysIn(month)), lastDays = byDay(lastSpend, daysIn(prev))
    const series = Array.from({ length: Math.max(daysIn(month), daysIn(prev)) }, (_, i) => {
      const day = i + 1
      return {
        day,
        current: day <= daysIn(month) && (!isCurrent || day <= today) ? round(curDays[day]) : undefined,
        previous: day <= daysIn(prev) ? round(lastDays[day]) : undefined,
      }
    })

    const categories = new Map<string, { current: number; previous: number }>()
    for (const [list, key] of [[spend, 'current'], [lastSpend, 'previous']] as const) {
      for (const t of list) {
        const c = categories.get(t.category) ?? { current: 0, previous: 0 }
        c[key] += t.amount
        categories.set(t.category, c)
      }
    }
    const topCategories = [...categories].filter(([, c]) => c.current > 0).sort((a, b) => b[1].current - a[1].current).slice(0, 8)

    // Tags overlap (one charge can be Essential and Partner), so each tag is its own share of the month, never a stack.
    const tags = new Map<string, { current: number; previous: number }>()
    for (const [list, key] of [[spend, 'current'], [lastSpend, 'previous']] as const) {
      for (const t of list) {
        for (const tag of t.tags) {
          const c = tags.get(tag) ?? { current: 0, previous: 0 }
          c[key] += t.amount
          tags.set(tag, c)
        }
      }
    }

    // Same point last month, so a partial month isn't compared with a full one.
    const lastToDate = isCurrent ? round(lastDays[Math.min(today, daysIn(prev))]) : round(sum(lastSpend))
    return {
      spent: sum(spend), lastToDate, income: -sum(cur.filter(isIncome)), lastIncome: -sum(last.filter(isIncome)),
      series, topCategories, tags,
    }
  }, [rows, month, prev, isCurrent, today])

  const nw = networth.at(-1)
  const delta = stats.spent - stats.lastToDate
  const maxCategory = stats.topCategories[0]?.[1].current ?? 1
  const soon = addDaysISO(todayISO(), 30)
  const upcoming = recurrings.filter((r) => r.active && r.lastAmount > 0 && r.nextDate >= todayISO() && r.nextDate <= soon)
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate))
  const toReview = rows.filter((t) => !t.reviewed).length

  if (!accounts.length && !rows.length) return <Welcome />

  const chartConfig = {
    current: { label: monthLabel(month), color: 'var(--chart-1)' },
    previous: { label: monthLabel(prev), color: 'var(--chart-2)' },
  } satisfies ChartConfig

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          title={`Spent in ${monthLabel(month)}`}
          value={money0(stats.spent)}
          hint={
            // Status color always paired with an arrow and words, never color alone.
            <span className="inline-flex items-center gap-1" style={{ color: delta > 0 ? 'var(--status-critical)' : 'var(--status-good)' }}>
              {delta > 0 ? <ArrowUpRightIcon className="size-4" aria-hidden /> : <ArrowDownRightIcon className="size-4" aria-hidden />}
              <span className="text-muted-foreground">{money0(Math.abs(delta))} {delta > 0 ? 'more' : 'less'} than {isCurrent ? 'this point ' : ''}last month</span>
            </span>
          }
        />
        <Kpi title="Income" value={money0(stats.income)} hint={`${money0(stats.lastIncome)} last month`} />
        <Kpi title="Net cash flow" value={money0(stats.income - stats.spent)} hint="Income minus spending" />
        <Kpi title="Net worth" value={nw ? money0(nw.assets - nw.debt) : '…'} hint="All accounts; not-yet-linked ones from the Copilot export" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <LeftToSpend month={month} />
        <Card>
          <CardHeader>
            <CardTitle>Spending</CardTitle>
            <CardDescription>Cumulative this month vs last month</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col">
            <ChartContainer config={chartConfig} className="aspect-auto min-h-72 w-full flex-1">
              <AreaChart data={stats.series} margin={{ left: 0, right: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="day" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => money0(v)} />
                <ChartTooltip content={<ChartTooltipContent indicator="line" labelFormatter={(_, p) => `Day ${p?.[0]?.payload?.day}`} formatter={(v, name) => (
                  <div className="flex w-full justify-between gap-4"><span className="text-muted-foreground">{chartConfig[name as keyof typeof chartConfig]?.label}</span><span className="font-medium tabular-nums">{money(Number(v))}</span></div>
                )} />} />
                <Area dataKey="previous" type="monotone" stroke="var(--color-previous)" strokeDasharray="4 4" fill="none" strokeWidth={2} />
                <Area dataKey="current" type="monotone" stroke="var(--color-current)" fill="var(--color-current)" fillOpacity={0.15} strokeWidth={2} />
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <NetWorthCard />
        <HealthCard />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top categories</CardTitle>
            <CardDescription>{monthLabel(month)}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {stats.topCategories.length === 0 && <p className="text-muted-foreground text-sm">No spending this month.</p>}
            {stats.topCategories.map(([name, c]) => {
              const { emoji, color } = categoryStyle(name)
              return (
                <div key={name} className="grid gap-1.5">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate font-medium"><span aria-hidden className="mr-1.5">{emoji}</span>{name}</span>
                    <span className="tabular-nums">{money0(c.current)}</span>
                  </div>
                  <Bar value={(c.current / maxCategory) * 100} color={color} />
                  <span className="text-muted-foreground text-xs">{money0(c.previous)} last month</span>
                </div>
              )
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Spending by tag</CardTitle>
            <CardDescription>Share of {money0(stats.spent)} this month · tags overlap</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {[...stats.tags].sort((a, b) => b[1].current - a[1].current).map(([tag, c]) => (
              <a key={tag} href="#transactions" className="grid gap-1.5">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <TagBadge name={tag} />
                  <span className="tabular-nums">{money0(c.current)} <span className="text-muted-foreground text-xs">{stats.spent > 0 ? Math.round((c.current / stats.spent) * 100) : 0}%</span></span>
                </div>
                <Bar value={stats.spent > 0 ? (c.current / stats.spent) * 100 : 0} color="var(--chart-1)" />
                <span className="text-muted-foreground text-xs">{money0(c.previous)} last month</span>
              </a>
            ))}
          </CardContent>
        </Card>


      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <CardTitle>Recent transactions</CardTitle>
            {toReview > 0 && <a href="#review"><Badge>{toReview} to review</Badge></a>}
          </CardHeader>
          <CardContent className="grid">
            {rows.filter((t) => !t.pairedWith).slice(0, 8).map((t) => <TxnRow key={t.id} t={t} />)}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Coming up</CardTitle>
            <CardDescription>{money0(upcoming.reduce((s, r) => s + r.lastAmount, 0))} in bills over the next 30 days</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-2">
            {upcoming.length === 0 && <p className="text-muted-foreground text-sm">Nothing due.</p>}
            {upcoming.slice(0, 10).map((r) => (
              <a key={r.name} href="#recurrings" className="flex justify-between gap-3 text-sm">
                <span className="truncate"><span className="text-muted-foreground inline-block w-14">{shortDate(r.nextDate)}</span>{r.name}</span>
                <span className="tabular-nums">{money(r.lastAmount)}</span>
              </a>
            ))}
            <a href="#recurrings" className="text-muted-foreground mt-auto pt-2 text-sm hover:underline">See the bills calendar →</a>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

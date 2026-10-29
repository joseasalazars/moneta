import { useMemo, useState } from 'react'
import { ArrowDownRightIcon, ArrowUpRightIcon } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { type Txn, isIncome, isSpend, money, money0, monthLabel, todayISO } from '@/lib/api'
import { GROUPS, type Group, categoryStyle } from '@/lib/categories'
import { useData } from '@/lib/data'

type Period = { key: string; label: string; start: string; end: string }

const shiftYear = (d: string, n: number) => `${Number(d.slice(0, 4)) + n}${d.slice(4)}`
const nextMonth = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 7)
const shortMonth = (m: string, withYear: boolean) =>
  new Date(`${m}-01T12:00:00`).toLocaleString('en-US', withYear ? { month: 'short', year: '2-digit' } : { month: 'short' })
const dateLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

// Income is money in (negative amounts); spending is regular, non-excluded rows net of refunds.
function totals(rows: Txn[]) {
  let income = 0, spend = 0
  for (const t of rows) {
    if (isIncome(t)) income -= t.amount
    else if (isSpend(t)) spend += t.amount
  }
  return { income, spend, net: income - spend, rate: income > 0 ? (income - spend) / income : null }
}

// Direction comes from the arrow and the words; color only reinforces whether that's good.
function Versus({ now, before, goodWhenUp, label }: { now: number; before: number; goodWhenUp: boolean; label: string }) {
  const delta = now - before
  if (Math.abs(delta) < 0.5) return <span className="text-muted-foreground">Same as {label}</span>
  const up = delta > 0
  const Icon = up ? ArrowUpRightIcon : ArrowDownRightIcon
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1">
      <span className="inline-flex items-center gap-0.5" style={{ color: up === goodWhenUp ? 'var(--status-good)' : 'var(--status-critical)' }}>
        <Icon className="size-3.5" aria-hidden />{money0(Math.abs(delta))} {up ? 'more' : 'less'}
      </span>
      <span className="text-muted-foreground">than {label} ({money0(before)})</span>
    </span>
  )
}

// Saved vs overspent can cross zero, so the change reads better/worse and the comparison says which it was.
function NetVersus({ now, before, label }: { now: number; before: number; label: string }) {
  const d = now - before
  if (Math.abs(d) < 0.5) return <span className="text-muted-foreground">Same as {label}</span>
  const Icon = d > 0 ? ArrowUpRightIcon : ArrowDownRightIcon
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1">
      <span className="inline-flex items-center gap-0.5" style={{ color: d > 0 ? 'var(--status-good)' : 'var(--status-critical)' }}>
        <Icon className="size-3.5" aria-hidden />{money0(Math.abs(d))} {d > 0 ? 'better' : 'worse'}
      </span>
      <span className="text-muted-foreground">than {label} ({before >= 0 ? 'saved' : 'overspent'} {money0(Math.abs(before))})</span>
    </span>
  )
}

function RatePoints({ now, before, label }: { now: number; before: number; label: string }) {
  const d = Math.round((now - before) * 100)
  if (!d) return <span className="text-muted-foreground">Same as {label}</span>
  const Icon = d > 0 ? ArrowUpRightIcon : ArrowDownRightIcon
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1">
      <span className="inline-flex items-center gap-0.5" style={{ color: d > 0 ? 'var(--status-good)' : 'var(--status-critical)' }}>
        <Icon className="size-3.5" aria-hidden />{Math.abs(d)} {Math.abs(d) === 1 ? 'point' : 'points'} {d > 0 ? 'higher' : 'lower'}
      </span>
      <span className="text-muted-foreground">than {label} ({Math.round(before * 100)}%)</span>
    </span>
  )
}

function Kpi({ title, value, children }: { title: string; value: string; children?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="gap-1">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        {children && <div className="text-xs">{children}</div>}
      </CardHeader>
    </Card>
  )
}

const groupKeys = Object.keys(GROUPS) as Group[]
const spendConfig = Object.fromEntries(groupKeys.map((g) => [g, { label: GROUPS[g].label, color: GROUPS[g].color }])) satisfies ChartConfig
const netConfig = { net: { label: 'Net' } } satisfies ChartConfig
const incomeConfig = { income: { label: 'Income', color: 'var(--chart-1)' } } satisfies ChartConfig

export function CashFlow() {
  const { ledger } = useData()
  const rows = ledger?.rows ?? []
  const today = todayISO()
  const firstDate = rows.reduce((min, t) => (t.date < min ? t.date : min), today)

  const periods = useMemo<Period[]>(() => {
    const year = Number(today.slice(0, 4))
    const list: Period[] = [
      { key: 'ytd', label: 'This year', start: `${year}-01-01`, end: today },
      { key: '12m', label: 'Last 12 months', start: `${nextMonth(shiftYear(today, -1).slice(0, 7))}-01`, end: today },
    ]
    for (let y = year - 1; y >= Number(firstDate.slice(0, 4)); y--) list.push({ key: String(y), label: String(y), start: `${y}-01-01`, end: `${y}-12-31` })
    list.push({ key: 'all', label: 'All time', start: firstDate, end: today })
    return list
  }, [today, firstDate])
  const [key, setKey] = useState('ytd')
  const period = periods.find((p) => p.key === key) ?? periods[0]

  const data = useMemo(() => {
    const inRange = (t: Txn, start: string, end: string) => t.date >= start && t.date <= end
    const cur = rows.filter((t) => inRange(t, period.start, period.end))
    // Same stretch of dates one year earlier, so a partial year compares to the same days of the year before.
    const before = period.key === 'all' ? null : rows.filter((t) => inRange(t, shiftYear(period.start, -1), shiftYear(period.end, -1)))

    const months: string[] = []
    for (let m = period.start.slice(0, 7); m <= period.end.slice(0, 7); m = nextMonth(m)) months.push(m)
    const withYear = months.length > 12 || months[0].slice(0, 4) !== months.at(-1)!.slice(0, 4)
    const monthly = months.map((m) => {
      const list = cur.filter((t) => t.date.startsWith(m))
      const byGroup = Object.fromEntries(groupKeys.map((g) => [g, 0])) as Record<Group, number>
      for (const t of list) if (isSpend(t)) byGroup[categoryStyle(t.category).group as Group] += t.amount
      return { month: m, label: shortMonth(m, withYear), ...totals(list), ...byGroup }
    })
    return { now: totals(cur), before: before && totals(before), monthly }
  }, [rows, period])

  const { now, before, monthly } = data
  const vsLabel = `the same days of ${Number(period.start.slice(0, 4)) - 1}`
  const usedGroups = groupKeys.filter((g) => monthly.some((m) => Math.abs(m[g]) > 0.5))

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={key} onValueChange={setKey}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>{periods.map((p) => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}</SelectContent>
        </Select>
        <span className="text-muted-foreground text-sm">{dateLabel(period.start)} – {dateLabel(period.end)}</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi title="Income" value={money(now.income)}>{before && <Versus now={now.income} before={before.income} goodWhenUp label={vsLabel} />}</Kpi>
        <Kpi title="Spending" value={money(now.spend)}>{before && <Versus now={now.spend} before={before.spend} goodWhenUp={false} label={vsLabel} />}</Kpi>
        {/* Overspent compares how much was overspent, so "less" reads as good. */}
        <Kpi title={now.net >= 0 ? 'Saved' : 'Overspent'} value={money(Math.abs(now.net))}>
          {before && <NetVersus now={now.net} before={before.net} label={vsLabel} />}
        </Kpi>
        <Kpi title="Savings rate" value={now.rate == null ? '—' : `${Math.round(now.rate * 100)}%`}>
          {before?.rate != null && now.rate != null && <RatePoints now={now.rate} before={before.rate} label={vsLabel} />}
        </Kpi>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Net income by month</CardTitle>
          <CardDescription>Income minus spending. Transfers between your accounts don't count.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={netConfig} className="h-64 w-full">
            <BarChart data={monthly} margin={{ left: 0, right: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={8} />
              <YAxis tickLine={false} axisLine={false} width={72} tickFormatter={(v: number) => money0(v)} />
              <ReferenceLine y={0} stroke="var(--border)" />
              <ChartTooltip content={<ChartTooltipContent hideIndicator labelFormatter={(_, p) => monthLabel(p?.[0]?.payload?.month)}
                formatter={(_, __, item) => (
                  <div className="grid gap-0.5 tabular-nums">
                    <span>Income {money(item.payload.income)}</span>
                    <span>Spending {money(item.payload.spend)}</span>
                    <span className="font-medium">Net {money(item.payload.net)}</span>
                  </div>
                )} />} />
              <Bar dataKey="net" radius={4} maxBarSize={36}>
                {monthly.map((m) => <Cell key={m.month} fill={m.net >= 0 ? 'var(--status-good)' : 'var(--status-critical)'} />)}
              </Bar>
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Spending</CardTitle><CardDescription>By category group, net of refunds</CardDescription></CardHeader>
          <CardContent>
            <ChartContainer config={spendConfig} className="h-72 w-full">
              <BarChart data={monthly} margin={{ left: 0, right: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={8} />
                <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => money0(v)} />
                <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => monthLabel(p?.[0]?.payload?.month)} formatter={(v, name) => (
                  <div className="flex w-full justify-between gap-4"><span>{spendConfig[name as Group]?.label}</span><span className="tabular-nums">{money(Number(v))}</span></div>
                )} />} />
                <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1 [&>div]:whitespace-nowrap" />} />
                {usedGroups.map((g, i) => (
                  <Bar key={g} dataKey={g} stackId="spend" fill={`var(--color-${g})`} stroke="var(--card)" strokeWidth={1}
                    radius={i === usedGroups.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={36} />
                ))}
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Income</CardTitle><CardDescription>Paychecks, HSA contributions, refunds of income</CardDescription></CardHeader>
          <CardContent>
            <ChartContainer config={incomeConfig} className="h-72 w-full">
              <BarChart data={monthly} margin={{ left: 0, right: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={8} />
                <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => money0(v)} />
                <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => monthLabel(p?.[0]?.payload?.month)} formatter={(v) => <span className="tabular-nums">{money(Number(v))}</span>} />} />
                <Bar dataKey="income" fill="var(--color-income)" radius={4} maxBarSize={36} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>By month</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead className="text-right">Income</TableHead>
                <TableHead className="text-right">Spending</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Savings rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...monthly].reverse().map((m) => (
                <TableRow key={m.month}>
                  <TableCell>{monthLabel(m.month)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money0(m.income)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money0(m.spend)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{m.net < 0 ? '−' : ''}{money0(Math.abs(m.net))}</TableCell>
                  <TableCell className="text-muted-foreground hidden text-right tabular-nums sm:table-cell">{m.rate == null ? '—' : `${Math.round(m.rate * 100)}%`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

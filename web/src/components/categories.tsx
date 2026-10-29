import { useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, XAxis, YAxis } from 'recharts'
import { TxnRow } from '@/components/txn-row'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Input } from '@/components/ui/input'
import { type Txn, api, daysIn, isSpend, money, money0, monthLabel, prevMonth, thisMonth, todayISO } from '@/lib/api'
import { GROUPS, type Group, categoryStyle } from '@/lib/categories'
import { useData } from '@/lib/data'

type Budget = { category: string; amount: number }
const ALL = '__all'
const chartConfig = { spent: { label: 'Spent' } } satisfies ChartConfig

// Budget cell: shows the amount, turns into an input on click; Enter or leaving the field saves, Escape cancels.
function BudgetCell({ category, amount, onSaved }: { category: string; amount: number | undefined; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  async function save() {
    setEditing(false)
    if (value === String(amount ?? '')) return
    await api('/api/budgets', { category, amount: value })
    await onSaved()
  }
  if (editing) {
    return (
      <Input autoFocus type="number" min="0" step="1" aria-label={`${category} budget`} className="h-7 w-24 text-right" value={value}
        onChange={(e) => setValue(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditing(false) }} />
    )
  }
  return (
    <button type="button" className="hover:bg-muted text-muted-foreground w-24 rounded px-1 text-right tabular-nums"
      onClick={() => { setValue(amount ? String(amount) : ''); setEditing(true) }} aria-label={`Edit ${category} budget`}>
      {amount ? money0(amount) : 'Set'}
    </button>
  )
}

// Spent vs budget. Over budget is a state, so it takes the status color plus the words "over"; otherwise the group hue.
function Progress({ spent, budget, color }: { spent: number; budget: number | undefined; color: string }) {
  const over = budget ? spent > budget : false
  const pct = budget ? Math.min(100, (spent / budget) * 100) : 0
  return (
    <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
      {budget ? <div className="h-full rounded-full" style={{ width: `${pct}%`, background: over ? 'var(--status-critical)' : color }} /> : null}
    </div>
  )
}

function Left({ spent, budget }: { spent: number; budget: number | undefined }) {
  if (!budget) return <span className="text-muted-foreground">—</span>
  const left = budget - spent
  return left >= 0
    ? <span className="tabular-nums">{money0(left)} left</span>
    : <span className="tabular-nums" style={{ color: 'var(--status-critical)' }}>{money0(-left)} over</span>
}

// Average per month in a year: full months for past years, months elapsed (with today's fraction) for this one, and only
// from the first month with data.
function monthsIn(year: string, first: string) {
  const today = todayISO()
  const startMonth = first.slice(0, 4) === year ? Number(first.slice(5, 7)) : 1
  if (year !== today.slice(0, 4)) return 13 - startMonth
  const m = Number(today.slice(5, 7))
  return m - startMonth + Number(today.slice(8, 10)) / daysIn(today.slice(0, 7))
}

export function Categories({ month }: { month: string }) {
  const { ledger } = useData()
  const rows = useMemo(() => (ledger?.rows ?? []).filter(isSpend), [ledger])
  const [budgets, setBudgets] = useState<Budget[]>([])
  const loadBudgets = async () => setBudgets(await api<Budget[]>('/api/budgets'))
  useEffect(() => { loadBudgets() }, [])
  const [selected, setSelected] = useState(ALL)

  const budgetOf = new Map(budgets.map((b) => [b.category, b.amount]))
  const totalBudget = budgets.reduce((s, b) => s + b.amount, 0)

  const { spentBy, shown, totalSpent } = useMemo(() => {
    const spentBy = new Map<string, number>()
    for (const t of rows) if (t.date.startsWith(month)) spentBy.set(t.category, (spentBy.get(t.category) ?? 0) + t.amount)
    // Categories worth listing: spent this month, budgeted, or used in the 12 months before.
    let since = month
    for (let i = 0; i < 12; i++) since = prevMonth(since)
    const recent = new Set(rows.filter((t) => t.date.slice(0, 7) >= since && t.date.slice(0, 7) <= month).map((t) => t.category))
    const shown = [...new Set([...spentBy.keys(), ...budgets.map((b) => b.category), ...recent])]
    return { spentBy, shown, totalSpent: [...spentBy.values()].reduce((s, v) => s + v, 0) }
  }, [rows, month, budgets])

  const groups = (Object.keys(GROUPS) as Group[]).map((g) => {
    const cats = shown.filter((c) => categoryStyle(c).group === g)
      .map((c) => ({ name: c, spent: spentBy.get(c) ?? 0, budget: budgetOf.get(c) }))
      .sort((a, b) => b.spent - a.spent || (b.budget ?? 0) - (a.budget ?? 0))
    return { g, cats, spent: cats.reduce((s, c) => s + c.spent, 0) }
  }).filter((x) => x.cats.length)

  // Detail for the selected category (or everything): 24 months of spending ending at the selected month.
  const detail = useMemo(() => {
    const pick = (t: Txn) => selected === ALL || t.category === selected
    const months: string[] = [month]
    while (months.length < 24) months.unshift(prevMonth(months[0]))
    const series = months.map((m) => ({
      month: m, label: new Date(`${m}-01T12:00:00`).toLocaleString('en-US', { month: 'narrow' }),
      spent: Math.round(rows.filter((t) => pick(t) && t.date.startsWith(m)).reduce((s, t) => s + t.amount, 0)),
    }))
    const mine = rows.filter(pick)
    const first = rows.reduce((min, t) => (t.date < min ? t.date : min), todayISO())
    const years = [...new Set(mine.map((t) => t.date.slice(0, 4)))].sort().reverse().map((y) => {
      const spent = mine.filter((t) => t.date.startsWith(y)).reduce((s, t) => s + t.amount, 0)
      return { year: y, spent, avg: spent / monthsIn(y, first) }
    })
    const txns = mine.filter((t) => t.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date))
    return { series, years, txns }
  }, [rows, selected, month])

  const selBudget = selected === ALL ? totalBudget || undefined : budgetOf.get(selected)
  const selSpent = selected === ALL ? totalSpent : spentBy.get(selected) ?? 0
  const selStyle = selected === ALL ? { emoji: '', color: 'var(--chart-1)' } : categoryStyle(selected)
  const monthName = month === thisMonth() ? 'this month' : `in ${monthLabel(month)}`

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div className="grid gap-4">
        <Card>
          <CardHeader className="gap-1">
            <CardDescription>Spent {monthName}</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {money(totalSpent)} <span className="text-muted-foreground text-base font-normal">of {money0(totalBudget)} budget</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <Progress spent={totalSpent} budget={totalBudget || undefined} color="var(--chart-1)" />
            <Left spent={totalSpent} budget={totalBudget || undefined} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Categories</CardTitle>
            <CardDescription>Click a budget to change it. Click a category for its history.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <button type="button" onClick={() => setSelected(ALL)}
              className={`-mx-2 rounded-md px-2 py-1 text-left text-sm ${selected === ALL ? 'bg-muted font-medium' : 'hover:bg-muted/60'}`}>
              All categories
            </button>
            {groups.map(({ g, cats, spent }) => (
              <div key={g} className="grid gap-1">
                <div className="text-muted-foreground flex items-center justify-between text-xs font-medium uppercase tracking-wide">
                  <span className="flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: GROUPS[g].color }} aria-hidden />{GROUPS[g].label}</span>
                  <span className="tabular-nums">{money0(spent)}</span>
                </div>
                {cats.map((c) => {
                  const st = categoryStyle(c.name)
                  return (
                    <div key={c.name} className={`-mx-2 grid grid-cols-[minmax(0,1fr)_4.5rem_6.5rem] items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-sm sm:grid-cols-[minmax(0,10rem)_4.5rem_minmax(4rem,1fr)_6.5rem_6rem] ${selected === c.name ? 'bg-muted' : 'hover:bg-muted/60'}`}>
                      <button type="button" className="truncate text-left" onClick={() => setSelected(c.name)}>
                        <span aria-hidden>{st.emoji}</span> {c.name}
                      </button>
                      <span className={`text-right tabular-nums ${c.spent ? '' : 'text-muted-foreground'}`}>{money0(c.spent)}</span>
                      <div className="col-span-3 sm:col-span-1 sm:col-start-3 sm:row-start-1"><Progress spent={c.spent} budget={c.budget} color={st.color} /></div>
                      <BudgetCell category={c.name} amount={c.budget} onSaved={loadBudgets} />
                      <span className="hidden w-24 text-right text-xs sm:block"><Left spent={c.spent} budget={c.budget} /></span>
                    </div>
                  )
                })}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:sticky lg:top-4">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="grid gap-1">
              <CardDescription>{monthLabel(month)}</CardDescription>
              <CardTitle className="text-xl">{selStyle.emoji} {selected === ALL ? 'All categories' : selected}</CardTitle>
            </div>
            <div className="grid justify-items-end gap-0.5 text-sm">
              <span className="text-lg font-semibold tabular-nums">{money(selSpent)}</span>
              <Left spent={selSpent} budget={selBudget} />
            </div>
          </CardHeader>
          <CardContent className="grid gap-6">
            <ChartContainer config={chartConfig} className="h-48 w-full">
              <BarChart data={detail.series} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} interval={0} fontSize={10} />
                <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => money0(v)} />
                <ChartTooltip content={<ChartTooltipContent hideIndicator labelFormatter={(_, p) => monthLabel(p?.[0]?.payload?.month)}
                  formatter={(v) => <span className="tabular-nums">Spent {money(Number(v))}{selBudget ? ` of ${money0(selBudget)}` : ''}</span>} />} />
                {selBudget && <ReferenceLine y={selBudget} stroke="var(--foreground)" strokeDasharray="4 4" strokeOpacity={0.5}
                  label={{ value: `Budget ${money0(selBudget)}`, position: 'insideBottomLeft', fontSize: 11, fill: 'var(--muted-foreground)' }} />}
                <Bar dataKey="spent" radius={[4, 4, 0, 0]} maxBarSize={18}>
                  {detail.series.map((m) => (
                    <Cell key={m.month} fill={selBudget && m.spent > selBudget ? 'var(--status-critical)' : selStyle.color}
                      fillOpacity={m.month === month ? 1 : 0.55} />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>

            <div className="grid gap-1 text-sm">
              <div className="text-muted-foreground grid grid-cols-3 text-xs font-medium"><span>Year</span><span className="text-right">Spent</span><span className="text-right">Avg / month</span></div>
              {detail.years.map((y) => (
                <div key={y.year} className="grid grid-cols-3 tabular-nums">
                  <span>{y.year}</span><span className="text-right">{money0(y.spent)}</span><span className="text-right">{money0(y.avg)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Transactions</CardTitle><CardDescription>{detail.txns.length} {monthName}</CardDescription></CardHeader>
          {/* Scrolls on its own so a busy category doesn't stretch the page past the category list. */}
          <CardContent className="grid max-h-[28rem] overflow-y-auto">
            {detail.txns.length ? detail.txns.slice(0, 50).map((t) => <TxnRow key={t.id} t={t} compact />) : <p className="text-muted-foreground text-sm">Nothing yet.</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

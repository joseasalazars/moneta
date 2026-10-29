import { useEffect, useMemo, useState } from 'react'
import { ArrowDownRightIcon, ArrowUpRightIcon, CircleCheckIcon, CircleDashedIcon } from 'lucide-react'
import { isIncomeKind, isMoneyMove, newMoney, useActivity } from '@/components/activity'
import { TagBadge } from '@/components/badges'
import { TxnRow } from '@/components/txn-row'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { type Txn, api, isIncome, isSpend, money0, monthLabel, prevMonth, thisMonth } from '@/lib/api'
import { categoryStyle } from '@/lib/categories'
import { useData } from '@/lib/data'

type Budget = { category: string; amount: number }
type Goal = { id: number; name: string; monthly: number; accounts: string[] }

const sum = (list: Txn[]) => list.reduce((s, t) => s + t.amount, 0)
const byCategory = (list: Txn[]) => {
  const m = new Map<string, number>()
  for (const t of list) m.set(t.category, (m.get(t.category) ?? 0) + t.amount)
  return m
}

// Up/down in words plus an arrow; color only says whether that direction is good.
function Change({ now, before, goodWhenUp }: { now: number; before: number; goodWhenUp: boolean }) {
  const d = now - before
  if (Math.abs(d) < 1) return <span className="text-muted-foreground">same as the month before</span>
  const up = d > 0
  const Icon = up ? ArrowUpRightIcon : ArrowDownRightIcon
  return (
    <span className="inline-flex items-center gap-0.5" style={{ color: up === goodWhenUp ? 'var(--status-good)' : 'var(--status-critical)' }}>
      <Icon className="size-3.5" aria-hidden />{money0(Math.abs(d))} {up ? 'more' : 'less'} <span className="text-muted-foreground ml-1">than the month before</span>
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

export function Report({ month: initial }: { month: string | null }) {
  const { ledger, networth } = useData()
  const activity = useActivity()
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  useEffect(() => {
    api<Budget[]>('/api/budgets').then(setBudgets)
    api<Goal[]>('/api/goals').then(setGoals)
  }, [])

  const rows = ledger?.rows ?? []
  const months = useMemo(() => [...new Set(rows.map((t) => t.date.slice(0, 7)))].filter((m) => m < thisMonth()).sort().reverse(), [rows])
  const month = initial && months.includes(initial) ? initial : months[0] ?? prevMonth(thisMonth())
  const before = prevMonth(month)

  const r = useMemo(() => {
    const cur = rows.filter((t) => t.date.startsWith(month)), prev = rows.filter((t) => t.date.startsWith(before))
    const spend = cur.filter(isSpend), prevSpend = prev.filter(isSpend)
    const income = -sum(cur.filter(isIncome)), prevIncome = -sum(prev.filter(isIncome))
    const spent = sum(spend), prevSpent = sum(prevSpend)
    const cats = byCategory(spend), prevCats = byCategory(prevSpend)
    const budgetOf = new Map(budgets.map((b) => [b.category, b.amount]))
    const scorecard = [...new Set([...cats.keys(), ...budgetOf.keys()])]
      .map((c) => ({ category: c, spent: cats.get(c) ?? 0, budget: budgetOf.get(c), before: prevCats.get(c) ?? 0 }))
      .filter((c) => c.spent || c.budget)
      .sort((a, b) => (b.spent - (b.budget ?? 0)) - (a.spent - (a.budget ?? 0)))
    // Net worth at the end of the month vs the end of the month before (last point on or before each date).
    const at = (m: string) => [...networth].reverse().find((p) => p.date.slice(0, 7) <= m)
    const end = at(month), start = at(before)
    const netWorth = end && start ? { end: end.assets - end.debt, change: end.assets - end.debt - (start.assets - start.debt) } : null
    const inv = activity.filter((t) => t.date.startsWith(month))
    // Top tags by spending (tags overlap, so these don't add up to the total).
    const tagSums = new Map<string, number>()
    for (const t of spend) for (const tag of t.tags) tagSums.set(tag, (tagSums.get(tag) ?? 0) + t.amount)
    const tags = [...tagSums].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 6)
    const biggest = [...spend].filter((t) => t.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 5)
    const movers = [...cats.keys()].map((c) => ({ c, d: (cats.get(c) ?? 0) - (prevCats.get(c) ?? 0) })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 3)
    return {
      income, prevIncome, spent, prevSpent, saved: income - spent, prevSaved: prevIncome - prevSpent, scorecard, netWorth, biggest, movers,
      invested: -inv.filter(isMoneyMove).reduce((s, t) => s + t.amount, 0), earned: -inv.filter(isIncomeKind).reduce((s, t) => s + t.amount, 0),
      tags, count: spend.length,
    }
  }, [rows, month, before, budgets, networth, activity])

  const totalBudget = budgets.reduce((s, b) => s + b.amount, 0)
  const target = goals.reduce((s, g) => s + g.monthly, 0)
  const over = r.scorecard.filter((c) => c.budget && c.spent > c.budget)
  const goalFill = (g: Goal) => newMoney(activity, g.accounts, month)

  // Plain-language highlights, built from the numbers above.
  const highlights = [
    target ? (r.saved >= target ? `You saved ${money0(r.saved)}, which beats the ${money0(target)} goal.` : r.saved >= 0
      ? `You saved ${money0(r.saved)}, ${money0(target - r.saved)} short of the ${money0(target)} goal.`
      : `You spent ${money0(-r.saved)} more than you earned.`) : null,
    totalBudget ? (r.spent <= totalBudget ? `Spending stayed ${money0(totalBudget - r.spent)} under the ${money0(totalBudget)} budget.`
      : `Spending went ${money0(r.spent - totalBudget)} over the ${money0(totalBudget)} budget${over.length ? `, mostly ${over.slice(0, 3).map((c) => c.category).join(', ')}` : ''}.`) : null,
    ...r.movers.filter((m) => Math.abs(m.d) >= 100).map((m) => `${m.c} ${m.d > 0 ? 'rose' : 'fell'} ${money0(Math.abs(m.d))} from ${monthLabel(before)}.`),
    r.netWorth ? `Net worth ${r.netWorth.change >= 0 ? 'grew' : 'dropped'} ${money0(Math.abs(r.netWorth.change))} to ${money0(r.netWorth.end)}.` : null,
  ].filter(Boolean) as string[]

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={month} onValueChange={(m) => { location.hash = `report/${m}` }}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>{months.map((m) => <SelectItem key={m} value={m}>{monthLabel(m)}</SelectItem>)}</SelectContent>
        </Select>
        <span className="text-muted-foreground text-sm">{r.count} purchases · compared with {monthLabel(before)}</span>
      </div>

      <Card>
        <CardHeader><CardTitle>{monthLabel(month)} in a few lines</CardTitle></CardHeader>
        <CardContent>
          <ul className="grid list-disc gap-1.5 pl-5 text-sm">{highlights.map((h) => <li key={h}>{h}</li>)}</ul>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi title="Saved" value={`${r.saved < 0 ? '−' : ''}${money0(Math.abs(r.saved))}`}><Change now={r.saved} before={r.prevSaved} goodWhenUp /></Kpi>
        <Kpi title="Income" value={money0(r.income)}><Change now={r.income} before={r.prevIncome} goodWhenUp /></Kpi>
        <Kpi title="Spending" value={money0(r.spent)}><Change now={r.spent} before={r.prevSpent} goodWhenUp={false} /></Kpi>
        <Kpi title="Net worth" value={r.netWorth ? money0(r.netWorth.end) : '—'}>
          {r.netWorth && <Change now={r.netWorth.end} before={r.netWorth.end - r.netWorth.change} goodWhenUp />}
        </Kpi>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader><CardTitle>Budget scorecard</CardTitle><CardDescription>{money0(r.spent)} of {money0(totalBudget)} · worst first</CardDescription></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Spent</TableHead>
                  <TableHead className="text-right">Budget</TableHead>
                  <TableHead className="text-right">Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.scorecard.map((c) => {
                  const diff = (c.budget ?? 0) - c.spent
                  return (
                    <TableRow key={c.category}>
                      <TableCell><span aria-hidden>{categoryStyle(c.category).emoji}</span> {c.category}</TableCell>
                      <TableCell className="text-right tabular-nums">{money0(c.spent)}</TableCell>
                      <TableCell className="text-muted-foreground text-right tabular-nums">{c.budget ? money0(c.budget) : '—'}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {!c.budget ? <span className="text-muted-foreground">no budget</span>
                          : diff >= 0 ? <span>{money0(diff)} under</span>
                          : <span style={{ color: 'var(--status-critical)' }}>{money0(-diff)} over</span>}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader><CardTitle>Goals</CardTitle><CardDescription>{money0(target)} a month</CardDescription></CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {goals.map((g) => {
                const v = goalFill(g), met = v >= g.monthly
                const Icon = met ? CircleCheckIcon : CircleDashedIcon
                return (
                  <div key={g.id} className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-2"><Icon className="size-4" style={{ color: met ? 'var(--status-good)' : undefined }} aria-label={met ? 'met' : 'not met'} />{g.name}</span>
                    <span className="tabular-nums">{money0(Math.max(v, 0))} of {money0(g.monthly)}</span>
                  </div>
                )
              })}
              <div className="text-muted-foreground flex justify-between gap-3 border-t pt-2"><span>Into investments, net</span><span className="tabular-nums">{money0(r.invested)}</span></div>
              <div className="text-muted-foreground flex justify-between gap-3"><span>Dividends and interest</span><span className="tabular-nums">{money0(r.earned)}</span></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Tags</CardTitle><CardDescription>Tags overlap, so they don't add up</CardDescription></CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {r.tags.length === 0 && <p className="text-muted-foreground">No tagged spending.</p>}
              {r.tags.map(([tag, v]) => (
                <div key={tag} className="flex justify-between"><TagBadge name={tag} /><span className="tabular-nums">{money0(v)}</span></div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Biggest purchases</CardTitle></CardHeader>
            <CardContent className="grid">{r.biggest.map((t) => <TxnRow key={t.id} t={t} compact />)}</CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { CircleCheckIcon, CircleDashedIcon } from 'lucide-react'
import { newMoney, useActivity } from '@/components/activity'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { type Holding, type InvTxn, api, isIncome, isSpend, money0, monthLabel, prevMonth, thisMonth } from '@/lib/api'
import { useData } from '@/lib/data'

type Goal = { id: number; name: string; monthly: number; accounts: string[]; cash_target: number | null }

const lastMonths = (n: number) => {
  const out = [thisMonth()]
  while (out.length < n) out.unshift(prevMonth(out[0]))
  return out
}
// Cash to rebuild before the monthly money goes back into stocks. Deposits are counted from next month.
function CashCushion({ cash, target, monthly }: { cash: number; target: number; monthly: number }) {
  const left = Math.max(0, target - cash)
  const months = Math.ceil(left / monthly)
  const d = new Date()
  const by = new Date(d.getFullYear(), d.getMonth() + months, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })
  return (
    <div className="grid gap-2 rounded-md border p-3 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="tabular-nums">Cash <span className="font-semibold">{money0(cash)}</span> of {money0(target)}</span>
        <span className="text-muted-foreground">{left ? `${money0(left)} to go · about ${by}` : 'Reached'}</span>
      </div>
      <Meter value={cash} target={target} />
      <p className="text-muted-foreground text-xs">
        {left ? `Rebuilding the cash first. Once it's back at ${money0(target)}, this money goes to stocks again.` : 'Cash is back at the target: this money goes to stocks now.'}
      </p>
    </div>
  )
}

const short = (m: string) => new Date(`${m}-01T12:00:00`).toLocaleString('en-US', { month: 'short' })

// New money into a goal's accounts. Moves between the goal's own accounts cancel (traditional IRA → Roth), and so do
// moves from another linked brokerage (see newMoney), so only money from outside your investments counts.
const filled = (activity: InvTxn[], accounts: string[], month: string) => newMoney(activity, accounts, month)

// Progress toward a target. Reaching it is a state, so it gets the status color plus a check icon and words.
function Meter({ value, target }: { value: number; target: number }) {
  const done = value >= target
  return (
    <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
      <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, (value / target) * 100))}%`, background: done ? 'var(--status-good)' : 'var(--chart-1)' }} />
    </div>
  )
}

function MonthDots({ values, target, months }: { values: number[]; target: number; months: string[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {months.map((m, i) => {
        const met = values[i] >= target
        const Icon = met ? CircleCheckIcon : CircleDashedIcon
        return (
          <span key={m} className="text-muted-foreground inline-flex items-center gap-1 text-xs" title={`${monthLabel(m)}: ${money0(values[i])} of ${money0(target)}`}>
            <Icon className="size-3.5" style={{ color: met ? 'var(--status-good)' : undefined }} aria-label={met ? 'met' : 'not met'} />
            {short(m)}
          </span>
        )
      })}
    </div>
  )
}

function GoalForm({ goal, onDone }: { goal?: Goal; onDone: () => Promise<void> }) {
  const { accounts } = useData()
  const [name, setName] = useState(goal?.name ?? '')
  const [monthly, setMonthly] = useState(goal ? String(goal.monthly) : '')
  const [cashTarget, setCashTarget] = useState(goal?.cash_target ? String(goal.cash_target) : '')
  const [picked, setPicked] = useState<string[]>(goal?.accounts ?? [])
  const [error, setError] = useState('')
  const invest = accounts.filter((a) => a.type === 'investment' && !a.manual && !a.excluded)

  async function save() {
    try {
      await api('/api/goals', { id: goal?.id, name, monthly, accounts: picked, cash_target: cashTarget })
      await onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  async function remove() {
    if (!goal || !confirm(`Delete the goal "${goal.name}"?`)) return
    await api('/api/goals/delete', { id: goal.id })
    await onDone()
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Roth IRA" /></div>
        <div className="grid gap-1.5"><Label>Every month</Label><Input type="number" min="0" step="50" value={monthly} onChange={(e) => setMonthly(e.target.value)} /></div>
        <div className="grid gap-1.5"><Label>Rebuild cash to (optional)</Label><Input type="number" min="0" step="1000" value={cashTarget} onChange={(e) => setCashTarget(e.target.value)} placeholder="20000" /></div>
      </div>
      <div className="grid gap-1.5">
        <Label>Counts new money arriving in</Label>
        {invest.map((a) => (
          <label key={a.account_id} className="flex items-center gap-2 text-sm">
            <Checkbox checked={picked.includes(a.account_id)}
              onCheckedChange={(v) => setPicked(v === true ? [...picked, a.account_id] : picked.filter((x) => x !== a.account_id))} />
            {a.name}{a.mask && ` ••${a.mask}`} <span className="text-muted-foreground">· {a.institution}</span>
          </label>
        ))}
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={save}>Save</Button>
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        {goal && <Button variant="ghost" onClick={remove}>Delete goal</Button>}
      </div>
    </div>
  )
}

export function Goals() {
  const { ledger, accounts } = useData()
  const activity = useActivity()
  const [goals, setGoals] = useState<Goal[]>([])
  const [budget, setBudget] = useState(0)
  useEffect(() => { api<{ amount: number }[]>('/api/budgets').then((b) => setBudget(b.reduce((s, x) => s + x.amount, 0))) }, [])
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [holdings, setHoldings] = useState<Holding[]>([])
  const load = async () => setGoals(await api<Goal[]>('/api/goals'))
  useEffect(() => { load(); api<Holding[]>('/api/holdings').then(setHoldings) }, [])
  const cashIn = (ids: string[]) => holdings.filter((h) => h.type === 'cash' && ids.includes(h.account_id)).reduce((s, h) => s + h.value, 0)
  const done = async () => { setEditing(null); await load() }

  const months = lastMonths(6)
  const month = thisMonth()
  const target = goals.reduce((s, g) => s + g.monthly, 0)

  // Saved from paychecks: income minus spending (transfers between your accounts don't count either way).
  const saved = useMemo(() => months.map((m) => {
    let v = 0
    for (const t of ledger?.rows ?? []) {
      if (!t.date.startsWith(m)) continue
      if (isIncome(t)) v -= t.amount
      else if (isSpend(t)) v -= t.amount
    }
    return v
  }), [ledger, months.join()])

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardDescription>Saved from paychecks in {monthLabel(month)} · income minus spending</CardDescription>
          <CardTitle className="text-2xl tabular-nums">
            {saved.at(-1)! < 0 ? '−' : ''}{money0(Math.abs(saved.at(-1)!))} <span className="text-muted-foreground text-base font-normal">of {money0(target)} goal</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Meter value={saved.at(-1)!} target={target || 1} />
          <MonthDots values={saved} target={target} months={months} />
          <p className="text-muted-foreground text-xs">
            The month's goal is the sum of the goals below.{budget > 0 && ` Staying within the ${money0(budget)} budget is what leaves this much over.`}
          </p>
        </CardContent>
      </Card>

      {goals.map((g) => {
        const values = months.map((m) => filled(activity, g.accounts, m))
        const now = values.at(-1)!
        const names = g.accounts.map((id) => accounts.find((a) => a.account_id === id)?.name).filter(Boolean).join(', ')
        return (
          <Card key={g.id}>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div className="grid gap-1">
                <CardTitle>{g.name}</CardTitle>
                <CardDescription>{money0(g.monthly)} every month · into {names || 'no accounts yet'}</CardDescription>
              </div>
              {editing !== g.id && <Button size="sm" variant="outline" onClick={() => setEditing(g.id)}>Edit</Button>}
            </CardHeader>
            <CardContent className="grid gap-3">
              {editing === g.id ? <GoalForm goal={g} onDone={done} /> : (
                <>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="tabular-nums"><span className="text-lg font-semibold">{money0(Math.max(now, 0))}</span> of {money0(g.monthly)} this month</span>
                    <span className="text-muted-foreground">{now >= g.monthly ? 'Done for the month' : `${money0(g.monthly - Math.max(now, 0))} to go`}</span>
                  </div>
                  <Meter value={now} target={g.monthly} />
                  <MonthDots values={values} target={g.monthly} months={months} />
                  {g.cash_target && <CashCushion cash={cashIn(g.accounts)} target={g.cash_target} monthly={g.monthly} />}
                </>
              )}
            </CardContent>
          </Card>
        )
      })}

      <Card>
        <CardContent>
          {editing === 'new' ? <GoalForm onDone={done} /> : <Button variant="outline" onClick={() => setEditing('new')}>Add a goal</Button>}
        </CardContent>
      </Card>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type InvTxn, api, money, shortDate } from '@/lib/api'
import { useData } from '@/lib/data'

const shares = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 })

// Plaid's type/subtype in plain words. Fidelity books an RSU vest as a $0 buy.
export function activityKind(t: InvTxn) {
  const money_in = t.amount < 0
  if (t.type === 'buy') return t.subtype === 'dividend reinvestment' ? 'Reinvested dividend' : t.price === 0 && t.amount === 0 ? 'RSU vest' : 'Buy'
  if (t.type === 'sell') return 'Sell'
  if (t.type === 'fee') return 'Fee'
  if (t.subtype === 'dividend' || t.subtype === 'qualified dividend') return 'Dividend'
  if (t.subtype === 'interest') return 'Interest'
  if (t.subtype === 'contribution') return 'Contribution'
  if (t.type === 'transfer' || t.subtype === 'deposit' || t.subtype === 'withdrawal') return money_in ? 'Deposit' : t.name.includes('RSU') ? 'RSU tax withheld' : 'Withdrawal'
  return t.subtype || t.type
}

// Money moved into investment accounts from outside (deposits, 401k contributions) minus money taken out.
// Moves between two linked brokerages cancel out (Fidelity's ACAT out = Robinhood's transfer in).
export const isMoneyMove = (t: InvTxn) => t.type === 'transfer' || ['deposit', 'withdrawal', 'contribution'].includes(t.subtype)
// New money into the given accounts in a month: deposits and contributions, minus withdrawals, leaving out moves
// between linked investment accounts (a brokerage's ACAT transfer out = the other brokerage's transfer in, same day), so selling
// one investment to fund another doesn't count as saving from the paycheck.
const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000
export function newMoney(activity: InvTxn[], accounts: string[], month: string) {
  const moves = activity.filter(isMoneyMove)
  const mirrored = (t: InvTxn) => moves.some((o) => o.account_id !== t.account_id && Math.round((o.amount + t.amount) * 100) === 0 && days(o.date, t.date) <= 5)
  return moves.filter((t) => accounts.includes(t.account_id) && t.date.startsWith(month) && !mirrored(t)).reduce((s, t) => s - t.amount, 0)
}

export const isIncomeKind = (t: InvTxn) => ['dividend', 'qualified dividend', 'interest'].includes(t.subtype)

export function useActivity() {
  const { accounts } = useData()
  const [rows, setRows] = useState<InvTxn[]>([])
  useEffect(() => { api<InvTxn[]>('/api/investments/activity').then(setRows) }, [accounts])
  return rows
}

export function ActivityList({ rows, showAccount }: { rows: InvTxn[]; showAccount: boolean }) {
  const { accounts } = useData()
  const name = (id: string) => accounts.find((a) => a.account_id === id)?.name ?? ''
  if (!rows.length) return <p className="text-muted-foreground text-sm">No activity in the last 24 months.</p>
  return (
    <div className="grid">
      {rows.map((t) => {
        const cash = -t.amount
        const kind = activityKind(t)
        return (
          <div key={t.id} className="-mx-2 flex min-w-0 items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{kind}{t.symbol && ` · ${t.symbol}`}</div>
              <div className="text-muted-foreground truncate text-xs">
                {shortDate(t.date)}{showAccount && ` · ${name(t.account_id)}`}{t.quantity ? ` · ${shares.format(Math.abs(t.quantity))} sh` : ''}{t.price ? ` @ ${money(t.price)}` : ''}
              </div>
            </div>
            <span className={`shrink-0 text-right tabular-nums ${cash > 0 ? 'text-[color:var(--status-good)]' : ''}`}>
              {cash === 0 ? '—' : `${cash > 0 ? '+' : '−'}${money(Math.abs(cash))}`}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function AccountActivity({ accountId }: { accountId: string }) {
  const rows = useActivity().filter((t) => t.account_id === accountId)
  const [all, setAll] = useState(false)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>Deposits, buys, sells, dividends and interest, from the last 24 months. + is cash into the account.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <ActivityList rows={all ? rows : rows.slice(0, 15)} showAccount={false} />
        {rows.length > 15 && (
          <button type="button" className="text-muted-foreground justify-self-start text-sm underline underline-offset-2" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${rows.length}`}
          </button>
        )}
      </CardContent>
    </Card>
  )
}

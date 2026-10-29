import { useEffect, useState } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ACCOUNT_GROUPS, groupOf } from '@/components/app-sidebar'
import { AccountActivity } from '@/components/activity'
import { AccountPositions } from '@/components/investments'
import { NetWorthCard } from '@/components/net-worth'
import { TxnRow } from '@/components/txn-row'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { TriangleAlertIcon } from 'lucide-react'
import { type Account, ASSET_LABEL, LIABILITY, ago, api, money, money0, shortDate, statementPaid } from '@/lib/api'
import { useData } from '@/lib/data'

type Unlinked = { name: string; mask: string | null; type: string; institution: string; balance: number; date: string }
const chartConfig = { balance: { label: 'Balance', color: 'var(--chart-1)' } } satisfies ChartConfig
const RANGES: [string, number][] = [['1M', 30], ['3M', 91], ['1Y', 365], ['ALL', 99999]]

function ManualAccountForm({ account, onDone }: { account?: Account; onDone: () => void }) {
  const { reload } = useData()
  const [name, setName] = useState(account?.name ?? '')
  const [type, setType] = useState(account?.type ?? 'depository')
  const [balance, setBalance] = useState(account ? String(account.balance ?? 0) : '')
  const [asset, setAsset] = useState<string>(account?.asset ?? 'none')
  const [quantity, setQuantity] = useState(account?.quantity != null ? String(account.quantity) : '')
  const [error, setError] = useState('')

  async function save() {
    try {
      const priced = asset !== 'none'
      await api('/api/manual/account', { id: account?.account_id, name, type, balance: priced ? undefined : balance, asset: priced ? asset : null, quantity: priced ? quantity : null })
      await reload()
      onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="grid gap-3 sm:grid-cols-5 sm:items-end">
      <div className="grid gap-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Apple Card" /></div>
      <div className="grid gap-1.5">
        <Label>Type</Label>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{ACCOUNT_GROUPS.map(([t, label]) => <SelectItem key={t} value={t}>{label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label>Value from</Label>
        <Select value={asset} onValueChange={setAsset}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Balance I enter</SelectItem>
            <SelectItem value="BTC">Bitcoin price</SelectItem>
            <SelectItem value="XAU">Gold price (grams)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {asset === 'none' ? (
        <div className="grid gap-1.5">
          <Label>{LIABILITY.has(type) ? 'Amount owed' : 'Balance'}</Label>
          <Input type="number" step="0.01" value={balance} onChange={(e) => setBalance(e.target.value)} />
        </div>
      ) : (
        <div className="grid gap-1.5">
          <Label>Quantity ({ASSET_LABEL[asset as 'BTC' | 'XAU']})</Label>
          <Input type="number" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
      )}
      <div className="flex gap-2">
        <Button onClick={save}>Save</Button>
        <Button variant="outline" onClick={onDone}>Cancel</Button>
      </div>
      {error && <p className="text-destructive text-sm sm:col-span-5">{error}</p>}
    </div>
  )
}

// Statement details from Plaid Liabilities. Paid/due is spelled out; color only backs it up.
function StatementCard({ account: a }: { account: Account }) {
  if (!a.statement_date) return null
  const paid = statementPaid(a)
  const late = !paid && (a.overdue === 1 || (a.due_date ?? '') < new Date().toLocaleDateString('en-CA'))
  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex justify-between gap-4 text-sm"><span className="text-muted-foreground">{label}</span><span className="tabular-nums">{value}</span></div>
  )
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="grid gap-1">
          <CardTitle>Statement</CardTitle>
          <CardDescription>Closed {shortDate(a.statement_date)}</CardDescription>
        </div>
        <span className="text-sm font-medium" style={{ color: paid ? 'var(--status-good)' : late ? 'var(--status-critical)' : undefined }}>
          {paid ? 'Paid in full' : late ? 'Overdue' : `Due ${shortDate(a.due_date ?? '')}`}
        </span>
      </CardHeader>
      <CardContent className="grid gap-2">
        <Row label="Statement balance" value={money(a.statement_balance ?? 0)} />
        <Row label="Minimum payment" value={money(a.minimum ?? 0)} />
        {a.due_date && <Row label="Next due date" value={shortDate(a.due_date)} />}
        {a.last_payment_date && <Row label="Last payment" value={`${money(a.last_payment ?? 0)} on ${shortDate(a.last_payment_date)}`} />}
        {a.apr != null && <Row label="Purchase APR" value={`${a.apr.toFixed(2)}%`} />}
      </CardContent>
    </Card>
  )
}

// When the numbers were last current: Plaid's last reach of the bank, or the last balance typed in. A login that needs
// fixing, or data older than 3 days (linked) / 30 days (typed in), gets a warning icon plus words.
function Freshness({ a }: { a: Account }) {
  const icon = (color: string) => <TriangleAlertIcon className="size-3.5 shrink-0" style={{ color }} aria-hidden />
  if (a.item_error) {
    return <span className="inline-flex items-center gap-1">{icon('var(--status-critical)')}{a.item_error === 'ITEM_LOGIN_REQUIRED' ? 'needs reconnecting' : 'last sync failed'}</span>
  }
  if (a.asset) return <span>priced hourly</span>
  const at = a.manual ? a.updated_at : a.bank_update ?? a.updated_at
  if (!at) return null
  const stale = Date.now() - Date.parse(at) > (a.manual ? 30 : 3) * 86400000
  return <span className="inline-flex items-center gap-1">{stale && icon('var(--status-warning)')}{a.manual ? 'balance entered' : 'updated'} {ago(at)}</span>
}

function AccountDetail({ account }: { account: Account }) {
  const { ledger, reload } = useData()
  const [points, setPoints] = useState<{ date: string; balance: number }[]>([])
  const [range, setRange] = useState(365)
  const [listed, setListed] = useState(100)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    api<{ date: string; balance: number }[]>(`/api/balances?account=${encodeURIComponent(account.account_id)}`).then(setPoints)
  }, [account.account_id, account.balance])

  const key = account.mask || account.name
  const rows = ledger?.rows.filter((t) => (t.mask || t.account) === key) ?? []
  const cutoff = new Date(Date.now() - range * 86400000).toISOString().slice(0, 10)
  const shown = points.filter((p) => p.date >= cutoff)

  async function setCounted(counted: boolean) {
    await api('/api/accounts/exclude', { id: account.account_id, excluded: !counted })
    await reload()
  }

  async function remove() {
    if (!confirm(`Delete manual account "${account.name}"?`)) return
    await api('/api/manual/account/delete', { id: account.account_id })
    await reload()
    location.hash = 'accounts'
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <CardDescription>
              {account.institution}{account.mask && ` ••${account.mask}`} · {account.subtype ?? account.type} · <Freshness a={account} />
              {account.asset && account.price != null && ` · ${account.quantity} ${ASSET_LABEL[account.asset]} × ${money(account.price)}, updated hourly`}
            </CardDescription>
            <CardTitle className="text-2xl tabular-nums">{account.name} · {money(account.balance ?? 0)}</CardTitle>
          </div>
          <div className="flex gap-1">
            {RANGES.map(([label, d]) => (
              <Button key={label} size="sm" variant={range === d ? 'secondary' : 'ghost'} onClick={() => setRange(d)}>{label}</Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          {shown.length > 1 ? (
            <ChartContainer config={chartConfig} className="h-64 w-full">
              <AreaChart data={shown} margin={{ left: 0, right: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={40} tickFormatter={shortDate} />
                <YAxis tickLine={false} axisLine={false} width={72} tickFormatter={(v: number) => money0(v)} domain={['auto', 'auto']} />
                <ChartTooltip content={<ChartTooltipContent indicator="line" labelFormatter={(_, p) => p?.[0]?.payload?.date} />} />
                <Area dataKey="balance" type="monotone" stroke="var(--color-balance)" fill="var(--color-balance)" fillOpacity={0.12} strokeWidth={2} />
              </AreaChart>
            </ChartContainer>
          ) : (
            <p className="text-muted-foreground text-sm">Not enough balance history yet. It grows with every sync.</p>
          )}
          <div className="flex items-center gap-2 text-sm">
            <Switch id="counted" checked={!account.excluded} onCheckedChange={setCounted} />
            <Label htmlFor="counted">Count in net worth</Label>
            {account.excluded && <span className="text-muted-foreground">Shown here, left out of net worth and totals.</span>}
          </div>
          {account.manual === 1 && (editing
            ? <ManualAccountForm account={account} onDone={() => setEditing(false)} />
            : (
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setEditing(true)}>{account.asset ? 'Edit holding' : 'Update balance'}</Button>
                <Button variant="ghost" onClick={remove}>Delete account</Button>
              </div>
            ))}
        </CardContent>
      </Card>
      <StatementCard account={account} />
      {account.type === 'investment' && <AccountPositions account={account} />}
      {account.type === 'investment' && !account.manual && <AccountActivity accountId={account.account_id} />}
      {/* Brokerage accounts have no spending transactions; only show the card when there's something in it. */}
      {(account.type !== 'investment' || rows.length > 0) && (
        <Card>
          <CardHeader><CardTitle>Transactions</CardTitle><CardDescription>{rows.length} total</CardDescription></CardHeader>
          <CardContent className="grid">
            {rows.slice(0, listed).map((t) => <TxnRow key={t.id} t={t} showAccount={false} />)}
            {rows.length > listed && (
              <Button variant="outline" className="mt-3 justify-self-center" onClick={() => setListed(listed + 200)}>
                Show more ({rows.length - listed} older)
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export function Accounts({ selected }: { selected: string | null }) {
  const { accounts } = useData()
  const [adding, setAdding] = useState(false)
  const [unlinked, setUnlinked] = useState<Unlinked[]>([])
  const loadUnlinked = () => api<Unlinked[]>('/api/accounts/unlinked').then(setUnlinked)
  useEffect(() => { loadUnlinked() }, [accounts])
  async function close(u: Unlinked) {
    if (!confirm(`Mark ${u.name} as closed? It leaves this list; its past balances and transactions stay.`)) return
    await api('/api/accounts/unlinked/close', { name: u.name, mask: u.mask })
    await loadUnlinked()
  }

  const account = accounts.find((a) => a.account_id === selected)
  if (account) return <AccountDetail account={account} />


  return (
    <div className="grid gap-4">
      <NetWorthCard />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle>Accounts</CardTitle>
          {!adding && <Button variant="outline" onClick={() => setAdding(true)}>Add manual account</Button>}
        </CardHeader>
        <CardContent className="grid gap-5">
          {adding && <ManualAccountForm onDone={() => setAdding(false)} />}
          {ACCOUNT_GROUPS.map(([type, label]) => {
            const list = accounts.filter((a) => groupOf(a.type) === type)
            if (!list.length) return null
            return (
              <div key={type} className="grid gap-1">
                <div className="flex justify-between text-sm font-medium">
                  <span>{label}</span>
                  <span className="tabular-nums">{money(list.filter((a) => !a.excluded).reduce((s, a) => s + (a.balance ?? 0), 0))}</span>
                </div>
                {list.map((a) => (
                  <a key={a.account_id} href={`#accounts/${a.account_id}`} className="hover:bg-muted/60 -mx-2 flex justify-between gap-3 rounded-md px-2 py-1.5 text-sm">
                    <span className="truncate">
                      {a.name}{a.mask && ` ••${a.mask}`} <span className="text-muted-foreground">· {a.institution} · <Freshness a={a} /></span>
                      {a.statement_date && !statementPaid(a) && a.due_date && <span className="text-muted-foreground"> · due {shortDate(a.due_date)}</span>}
                    </span>
                    <span className={`tabular-nums ${a.excluded ? 'text-muted-foreground line-through' : ''}`}>{money(a.balance ?? 0)}</span>
                  </a>
                ))}
              </div>
            )
          })}
        </CardContent>
      </Card>

      {unlinked.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Not linked yet</CardTitle>
            <CardDescription>From your Copilot export. Connect them through Plaid, add them as manual accounts, or mark them closed.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-1">
            {unlinked.map((u) => (
              <div key={`${u.name}${u.mask}`} className="text-muted-foreground flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{u.name}{u.mask && ` ••${u.mask}`} · {u.institution}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="tabular-nums">{money(u.balance)} <span className="text-xs">({shortDate(u.date)})</span></span>
                  <Button size="sm" variant="ghost" onClick={() => close(u)}>Closed</Button>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

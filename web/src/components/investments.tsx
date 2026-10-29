import { useEffect, useMemo, useState } from 'react'
import { ArrowDownRightIcon, ArrowUpRightIcon } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ActivityList, isIncomeKind, isMoneyMove, useActivity } from '@/components/activity'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { type Account, type Holding, ASSET_LABEL, api, money, moneyHidden } from '@/lib/api'
import { useData } from '@/lib/data'

// Asset classes take the validated categorical slots in fixed order (same tokens as category groups).
const CLASSES: [string, string, string][] = [
  ['equity', 'Stocks', 'var(--group-home)'],
  ['etf', 'ETFs', 'var(--group-food)'],
  ['mutual fund', 'Funds', 'var(--group-transport)'],
  ['cryptocurrency', 'Crypto', 'var(--group-fun)'],
  ['gold', 'Gold', 'var(--group-shopping)'],
  ['cash', 'Cash', 'var(--group-other)'],
]
const classOf = (type: string) => (CLASSES.some(([t]) => t === type) ? type : 'equity')

type Row = Holding & { manualAsset?: boolean }

const shares = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 })
const price = (n: number) => (n < 1 && !moneyHidden ? `$${n.toPrecision(4)}` : money(n))

// Gold and BTC manual accounts are a single position priced by the app, so they show up here too.
function assetRow(a: Account): Row {
  return {
    account_id: a.account_id, symbol: a.asset === 'XAU' ? 'Gold' : 'BTC', name: a.asset === 'XAU' ? 'Gold (grams)' : 'Bitcoin',
    type: a.asset === 'XAU' ? 'gold' : 'cryptocurrency', quantity: a.quantity ?? 0, cost_basis: null, price: a.price ?? 0,
    value: a.balance ?? 0, manual: 1, live: a.price ?? 0, prev: null, liveValue: a.balance ?? 0, quoted_at: null, manualAsset: true,
  }
}

// Fidelity keeps uninvested cash in the balance but not as a position, so the gap shows up as a Cash row.
function rowsFor(a: Account, holdings: Holding[]): Row[] {
  if (a.asset) return [assetRow(a)]
  const rows: Row[] = holdings.filter((h) => h.account_id === a.account_id)
  const gap = (a.balance ?? 0) - rows.reduce((s, h) => s + h.liveValue, 0)
  if (!a.manual && rows.length && gap > 0.5) {
    rows.push({ account_id: a.account_id, symbol: 'Cash', name: null, type: 'cash', quantity: gap, cost_basis: null, price: 1, value: gap,
      manual: 0, live: 1, prev: null, liveValue: gap, quoted_at: null })
  }
  return rows.sort((x, y) => y.liveValue - x.liveValue)
}

const dayChange = (h: Row) => (h.prev && h.type !== 'cash' ? h.quantity * (h.live - h.prev) : 0)

// Direction is carried by the arrow and the sign; color only reinforces it.
function Delta({ value, base, className = '' }: { value: number; base: number; className?: string }) {
  if (Math.abs(value) < 0.005) return <span className={`text-muted-foreground ${className}`}>—</span>
  const up = value > 0
  const Icon = up ? ArrowUpRightIcon : ArrowDownRightIcon
  return (
    <span className={`inline-flex items-center justify-end gap-0.5 tabular-nums ${className}`} style={{ color: up ? 'var(--status-good)' : 'var(--status-critical)' }}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {up ? '+' : '−'}{money(Math.abs(value))}
      {base > 0 && <span className="text-muted-foreground ml-1">{(Math.abs(value / base) * 100).toFixed(2)}%</span>}
    </span>
  )
}

function Stat({ label, children, sub }: { label: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="gap-1">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{children}</CardTitle>
        {sub && <div className="text-sm">{sub}</div>}
      </CardHeader>
    </Card>
  )
}

function AddPosition({ account, onSaved }: { account: Account; onSaved: () => Promise<void> }) {
  const [symbol, setSymbol] = useState('')
  const [quantity, setQuantity] = useState('')
  const [cost, setCost] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    setError('')
    try {
      await api('/api/holdings', { account_id: account.account_id, symbol, quantity, cost_basis: cost })
      setSymbol(''); setQuantity(''); setCost('')
      await onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-center">
      <Input aria-label="Ticker" placeholder="Ticker (VFIAX)" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
      <Input aria-label="Shares" placeholder="Shares" type="number" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      <Input aria-label="Cost basis" placeholder="Cost basis (optional)" type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
      <Button onClick={save} disabled={saving || !symbol || !quantity}>{saving ? 'Checking…' : 'Add position'}</Button>
      {error && <p className="text-destructive text-sm sm:col-span-4">{error}</p>}
    </div>
  )
}

// One account's positions. On the Investments page it's titled by the account; on the account's own page (title set)
// it sits under the balance chart, where transactions would be for a bank account.
function AccountCard({ account, rows, total, title, onSaved, onPick }: {
  account: Account; rows: Row[]; total?: number; title?: string; onSaved: () => Promise<void>; onPick: (h: Row) => void
}) {
  const value = rows.reduce((s, h) => s + h.liveValue, 0)
  const today = rows.reduce((s, h) => s + dayChange(h), 0)
  const editable = account.manual === 1 && !account.asset

  async function remove(h: Row) {
    if (!confirm(`Remove ${h.symbol} from ${account.name}?`)) return
    await api('/api/holdings', { account_id: account.account_id, symbol: h.symbol, quantity: 0 })
    await onSaved()
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="grid gap-1">
          {title ? (
            <>
              <CardTitle>{title}</CardTitle>
              <CardDescription>{rows.length} {rows.length === 1 ? 'position' : 'positions'} · live prices, updated every 15 minutes</CardDescription>
            </>
          ) : (
            <>
              <CardTitle><a href={`#accounts/${account.account_id}`} className="hover:underline">{account.name}</a></CardTitle>
              <CardDescription>{account.institution}{account.mask && ` ••${account.mask}`} · {total ? ((value / total) * 100).toFixed(1) : 0}% of investments</CardDescription>
            </>
          )}
        </div>
        <div className="grid justify-items-end gap-0.5">
          <span className="text-lg font-semibold tabular-nums">{money(rows.length ? value : account.balance ?? 0)}</span>
          {rows.length > 0 && <Delta value={today} base={value - today} className="text-xs" />}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {editable
              ? `No positions yet: valued at the balance you entered (${money(account.balance ?? 0)}). Add each fund and its shares to price it live.`
              : 'No positions right now.'}
          </p>
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>Position</TableHead>
                <TableHead className="hidden w-28 text-right sm:table-cell">Shares</TableHead>
                <TableHead className="hidden w-28 text-right sm:table-cell">Price</TableHead>
                <TableHead className="hidden w-36 text-right sm:table-cell">Today</TableHead>
                <TableHead className="w-32 text-right">Value</TableHead>
                <TableHead className="hidden w-40 text-right md:table-cell">Total gain</TableHead>
                <TableHead className="hidden w-24 md:table-cell"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((h) => {
                const cls = CLASSES.find(([t]) => t === classOf(h.type))!
                const pickable = charted(h)
                return (
                  <TableRow key={h.symbol} className={pickable ? 'cursor-pointer' : undefined} onClick={pickable ? () => onPick(h) : undefined}>
                    <TableCell className="max-w-40 sm:max-w-56">
                      <div className="flex items-center gap-2">
                        <span className="size-2 shrink-0 rounded-full" style={{ background: cls[2] }} aria-hidden />
                        {pickable
                          ? <button type="button" className="font-medium hover:underline" onClick={(e) => { e.stopPropagation(); onPick(h) }}>{h.symbol}</button>
                          : <span className="font-medium">{h.type === 'cash' ? 'Cash' : h.symbol}</span>}
                      </div>
                      {h.type !== 'cash' && <div className="text-muted-foreground truncate pl-4 text-xs">{h.name}</div>}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">
                      {h.type === 'cash' ? '' : `${shares.format(h.quantity)}${h.manualAsset && h.type === 'gold' ? ` ${ASSET_LABEL.XAU}` : ''}`}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">{h.type === 'cash' ? '' : price(h.live)}</TableCell>
                    <TableCell className="hidden text-right text-xs sm:table-cell">
                      {h.prev ? <Delta value={dayChange(h)} base={h.quantity * h.prev} /> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{money(h.liveValue)}</TableCell>
                    <TableCell className="hidden text-right text-xs md:table-cell">
                      {h.cost_basis != null && h.type !== 'cash' ? <Delta value={h.liveValue - h.cost_basis} base={h.cost_basis} /> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="hidden text-right md:table-cell">
                      {editable && <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); remove(h) }}>Remove</Button>}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
        {editable && <AddPosition account={account} onSaved={onSaved} />}
      </CardContent>
    </Card>
  )
}

// Plaid names some funds "Issuer Fund - Issuer Fund"; show it once.
const fundName = (name: string | null) => {
  const [a, b] = (name ?? '').split(' - ')
  return a && a === b ? a : name
}

// Cash has no price to chart. Gold grams chart gold's price per gram.
const charted = (h: Row) => h.type !== 'cash'
const unit = (h: Row) => (h.type === 'gold' ? ' g' : ' shares')

const RANGES = ['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL'] as const
type Range = (typeof RANGES)[number]
type History = { points: { t: number; price: number }[]; prevClose: number | null; name: string }
const chartConfig = { price: { label: 'Price', color: 'var(--chart-1)' } } satisfies ChartConfig

function PriceChart({ pick }: { pick: Row }) {
  const [range, setRange] = useState<Range>('1D')
  const [state, setState] = useState<{ key: string; data?: History; error?: string }>({ key: '' })
  const key = `${pick.symbol} ${pick.type} ${range}`
  useEffect(() => {
    let live = true
    api<History>(`/api/history?${new URLSearchParams({ symbol: pick.symbol, type: pick.type, range })}`)
      .then((data) => live && setState({ key, data }), (e) => live && setState({ key, error: (e as Error).message }))
    return () => { live = false }
  }, [key])
  const data = state.key === key ? state.data : undefined
  const points = data?.points ?? []
  // 1D compares with yesterday's close; longer ranges with their first point.
  const from = range === '1D' && data?.prevClose ? data.prevClose : points[0]?.price
  const to = points.at(-1)?.price
  const intraday = range === '1D' || range === '1W'
  const label = (t: number) => new Date(t).toLocaleString('en-US', intraday
    ? { month: range === '1W' ? 'short' : undefined, day: range === '1W' ? 'numeric' : undefined, hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: range === 'ALL' || range === '1Y' ? '2-digit' : undefined })

  return (
    <div className="grid gap-3">
      <div className="flex min-h-5 items-center justify-between text-sm">
        <span className="text-muted-foreground">{range === '1D' ? 'Today' : `Past ${range === 'ALL' ? 'all time' : range}`}</span>
        {from != null && to != null && <Delta value={(to - from) * pick.quantity} base={from * pick.quantity} className="text-xs" />}
      </div>
      <div className="h-56">
        {state.key !== key ? <p className="text-muted-foreground pt-20 text-center text-sm">Loading…</p>
          : state.error || points.length < 2 ? <p className="text-muted-foreground pt-20 text-center text-sm">No price history for {pick.symbol} here.</p>
          : (
            <ChartContainer config={chartConfig} className="h-56 w-full">
              <AreaChart data={points} margin={{ left: 0, right: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickLine={false} axisLine={false} minTickGap={48} tickFormatter={label} />
                <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => price(v)} domain={['auto', 'auto']} />
                <ChartTooltip content={<ChartTooltipContent indicator="line" labelFormatter={(_, p) => label(p?.[0]?.payload?.t)} formatter={(v) => price(Number(v))} />} />
                <Area dataKey="price" type="monotone" stroke="var(--color-price)" fill="var(--color-price)" fillOpacity={0.12} strokeWidth={2} isAnimationActive={false} />
              </AreaChart>
            </ChartContainer>
          )}
      </div>
      <div className="flex flex-wrap justify-center gap-1">
        {RANGES.map((r) => <Button key={r} size="sm" variant={range === r ? 'secondary' : 'ghost'} onClick={() => setRange(r)}>{r}</Button>)}
      </div>
      <p className="text-muted-foreground text-xs">
        {pick.type === 'gold' ? 'Chart shows gold per gram (COMEX futures); your value uses the PAXG spot price, updated hourly.' : `Chart shows ${pick.symbol}'s price; the change above is for your shares.`} Prices from Yahoo Finance.
      </p>
    </div>
  )
}

// One position across every account that holds it: live price, chart, and your shares in each account.
function PositionSheet({ pick, rows, accounts, onClose }: { pick: Row | null; rows: Row[]; accounts: Account[]; onClose: () => void }) {
  const held = pick ? rows.filter((h) => h.symbol === pick.symbol && h.type === pick.type) : []
  const qty = held.reduce((s, h) => s + h.quantity, 0)
  const value = held.reduce((s, h) => s + h.liveValue, 0)
  const withCost = held.filter((h) => h.cost_basis != null)
  const cost = withCost.reduce((s, h) => s + (h.cost_basis ?? 0), 0)
  const costQty = withCost.reduce((s, h) => s + h.quantity, 0)
  const today = held.reduce((s, h) => s + dayChange(h), 0)
  const total = { ...pick!, quantity: qty }
  const name = (id: string) => accounts.find((a) => a.account_id === id)
  return (
    <Sheet open={!!pick} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg" onOpenAutoFocus={(e) => e.preventDefault()}>
        {pick && (
          <>
            <SheetHeader>
              <Badge variant="outline" className="w-fit">{CLASSES.find(([t]) => t === classOf(pick.type))![1]}</Badge>
              <SheetTitle className="text-xl">{pick.symbol} {!pick.name?.startsWith(pick.symbol) && <span className="text-muted-foreground font-normal">{fundName(pick.name)}</span>}</SheetTitle>
              <SheetDescription asChild>
                <div className="grid gap-0.5">
                  <span className="text-foreground text-2xl font-semibold tabular-nums">{price(pick.live)}</span>
                  {pick.prev ? <Delta value={pick.live - pick.prev} base={pick.prev} className="justify-start text-xs" /> : <span className="text-xs">Last price</span>}
                </div>
              </SheetDescription>
            </SheetHeader>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-6 px-4 pb-6">
              <PriceChart key={`${pick.symbol} ${pick.type}`} pick={total} />
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div><div className="text-muted-foreground text-xs">{pick.type === 'gold' ? 'Grams' : 'Shares'}</div><div className="tabular-nums">{shares.format(qty)}</div></div>
                <div><div className="text-muted-foreground text-xs">Value</div><div className="font-medium tabular-nums">{money(value)}</div></div>
                <div><div className="text-muted-foreground text-xs">Today</div>{pick.prev ? <Delta value={today} base={value - today} className="justify-start" /> : '—'}</div>
                <div><div className="text-muted-foreground text-xs">Average cost</div><div className="tabular-nums">{costQty ? price(cost / costQty) : '—'}</div></div>
                <div className="col-span-2"><div className="text-muted-foreground text-xs">Total gain</div>
                  {withCost.length ? <Delta value={withCost.reduce((s, h) => s + h.liveValue, 0) - cost} base={cost} className="justify-start" /> : <span className="text-muted-foreground">No cost basis recorded</span>}
                </div>
              </div>
              <div className="grid gap-2">
                <h3 className="text-sm font-medium">Positions</h3>
                {held.map((h) => {
                  const a = name(h.account_id)
                  return (
                    <a key={h.account_id} href={`#accounts/${h.account_id}`} onClick={onClose} className="hover:bg-muted flex items-center justify-between gap-3 rounded-md p-2 text-sm">
                      <span className="min-w-0 truncate">{a?.name}{a?.mask && <span className="text-muted-foreground"> ••{a.mask}</span>}</span>
                      <span className="text-muted-foreground shrink-0 tabular-nums">{shares.format(h.quantity)}{unit(h)}</span>
                      <span className="w-24 shrink-0 text-right font-medium tabular-nums">{money(h.liveValue)}</span>
                    </a>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

// A one-day price line for a mover card. Direction is in the arrow and sign next to it; the color only reinforces.
function Sparkline({ h }: { h: Row }) {
  const [pts, setPts] = useState<number[] | null>(null)
  useEffect(() => {
    api<History>(`/api/history?${new URLSearchParams({ symbol: h.symbol, type: h.type, range: '1D' })}`)
      .then((d) => setPts(d.points.map((p) => p.price)), () => setPts([]))
  }, [h.symbol, h.type])
  if (!pts) return <div className="h-10" />
  if (pts.length < 2) return <div className="text-muted-foreground grid h-10 place-content-center text-xs">Priced once a day</div>
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1
  const d = pts.map((p, i) => `${(i / (pts.length - 1)) * 100},${38 - ((p - min) / span) * 36}`).join(' ')
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-10 w-full" aria-hidden>
      <polyline points={d} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke"
        stroke={h.live >= (h.prev ?? h.live) ? 'var(--status-good)' : 'var(--status-critical)'} />
    </svg>
  )
}

// Today's biggest moves among what you hold (by %), positions under $50 left out so dust coins don't crowd it.
function TopMovers({ rows, onPick }: { rows: Row[]; onPick: (h: Row) => void }) {
  const bySymbol = new Map<string, Row>()
  for (const h of rows) {
    if (!h.prev || !charted(h) || h.type === 'gold') continue
    const k = `${h.symbol} ${h.type}`
    const cur = bySymbol.get(k)
    bySymbol.set(k, cur ? { ...cur, quantity: cur.quantity + h.quantity, liveValue: cur.liveValue + h.liveValue } : h)
  }
  const movers = [...bySymbol.values()].filter((h) => h.liveValue >= 50)
    .sort((a, b) => Math.abs(b.live / b.prev! - 1) - Math.abs(a.live / a.prev! - 1)).slice(0, 5)
  if (!movers.length) return null
  return (
    <Card>
      <CardHeader><CardTitle>Top movers today</CardTitle><CardDescription>Your positions, by today's % change</CardDescription></CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {movers.map((h) => {
          const change = h.live / h.prev! - 1
          const Icon = change >= 0 ? ArrowUpRightIcon : ArrowDownRightIcon
          return (
            <button key={`${h.symbol} ${h.type}`} type="button" onClick={() => onPick(h)} className="hover:bg-muted grid gap-2 rounded-lg border p-3 text-left">
              <div className="min-w-0">
                <div className="font-medium">{h.symbol}</div>
                <div className="text-muted-foreground truncate text-xs">{fundName(h.name)}</div>
              </div>
              <Sparkline h={h} />
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="tabular-nums">{price(h.live)}</span>
                <span className="inline-flex items-center gap-0.5 tabular-nums" style={{ color: change >= 0 ? 'var(--status-good)' : 'var(--status-critical)' }}>
                  <Icon className="size-3.5" aria-hidden />{change >= 0 ? '+' : '−'}{Math.abs(change * 100).toFixed(2)}%
                </span>
              </div>
            </button>
          )
        })}
      </CardContent>
    </Card>
  )
}

export function AccountPositions({ account }: { account: Account }) {
  const { accounts, reload } = useData()
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [pick, setPick] = useState<Row | null>(null)
  const load = async () => setHoldings(await api<Holding[]>('/api/holdings'))
  useEffect(() => { load() }, [account.balance])
  const all = accounts.filter((a) => a.type === 'investment').flatMap((a) => rowsFor(a, holdings))
  return (
    <>
      <AccountCard account={account} rows={rowsFor(account, holdings)} title="Positions" onSaved={async () => { await reload(); await load() }} onPick={setPick} />
      <PositionSheet pick={pick} rows={all} accounts={accounts} onClose={() => setPick(null)} />
    </>
  )
}

export function Investments() {
  const { accounts, reload } = useData()
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [pick, setPick] = useState<Row | null>(null)
  const load = async () => setHoldings(await api<Holding[]>('/api/holdings'))
  useEffect(() => { load() }, [accounts])
  const refresh = async () => { await reload(); await load() }

  const shownAccounts = accounts.filter((a) => a.type === 'investment')
  // Excluded accounts (unvested RSUs) get a card but stay out of every total.
  const invest = shownAccounts.filter((a) => !a.excluded)
  const byAccount = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const a of invest) m.set(a.account_id, rowsFor(a, holdings))
    return m
  }, [invest, holdings])
  const excludedAccounts = shownAccounts.filter((a) => a.excluded)

  const all = [...byAccount.values()].flat()
  // Accounts without positions (an HSA entered as a balance) still count toward the total.
  const unpriced = invest.filter((a) => !byAccount.get(a.account_id)?.length).reduce((s, a) => s + (a.balance ?? 0), 0)
  const total = all.reduce((s, h) => s + h.liveValue, 0) + unpriced
  const today = all.reduce((s, h) => s + dayChange(h), 0)
  const withCost = all.filter((h) => h.cost_basis != null && h.type !== 'cash')
  const cost = withCost.reduce((s, h) => s + (h.cost_basis ?? 0), 0)
  const gain = withCost.reduce((s, h) => s + h.liveValue, 0) - cost
  const cash = all.filter((h) => h.type === 'cash').reduce((s, h) => s + h.liveValue, 0)
  const lastQuote = holdings.map((h) => h.quoted_at).filter(Boolean).sort().at(-1)

  const mix = CLASSES.map(([type, label, color]) => ({
    type, label, color, value: all.filter((h) => classOf(h.type) === type).reduce((s, h) => s + h.liveValue, 0),
  }))
  if (unpriced) mix.push({ type: 'unpriced', label: 'Not itemized', color: 'var(--muted-foreground)', value: unpriced })
  const shown = mix.filter((m) => m.value > 0.5)

  const order = [...invest].sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0))

  // This year's activity across accounts. Excluded accounts (unvested RSUs) don't count.
  const activity = useActivity().filter((t) => !shownAccounts.find((a) => a.account_id === t.account_id)?.excluded)
  const year = new Date().getFullYear().toString()
  const ytd = activity.filter((t) => t.date.startsWith(year))
  const moneyIn = ytd.filter(isMoneyMove).reduce((s, t) => s - t.amount, 0)
  const earned = ytd.filter(isIncomeKind).reduce((s, t) => s - t.amount, 0)
  const fees = ytd.filter((t) => t.type === 'fee').reduce((s, t) => s + t.amount, 0)

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Investments" sub={<span className="text-muted-foreground">{invest.length} accounts</span>}>{money(total)}</Stat>
        <Stat label="Today" sub={<span className="text-muted-foreground">Crypto: last 24 hours</span>}><Delta value={today} base={total - today} /></Stat>
        <Stat label="Total gain" sub={<span className="text-muted-foreground">On {money(cost)} cost basis</span>}><Delta value={gain} base={cost} /></Stat>
        <Stat label="Cash in brokerage" sub={<span className="text-muted-foreground">{total > 0 ? ((cash / total) * 100).toFixed(1) : 0}% of investments</span>}>{money(cash)}</Stat>
      </div>

      <TopMovers rows={all} onPick={setPick} />

      <Card>
        <CardHeader>
          <CardTitle>Allocation</CardTitle>
          <CardDescription>
            Prices update every 15 minutes{lastQuote && `, last at ${new Date(lastQuote).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}.
            Mutual funds price once a day after the close.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label="Allocation by asset class">
            {shown.map((m) => <div key={m.type} style={{ width: `${(m.value / total) * 100}%`, background: m.color }} title={`${m.label} ${money(m.value)}`} />)}
          </div>
          <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((m) => (
              <div key={m.type} className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ background: m.color }} aria-hidden />{m.label}</span>
                <span className="tabular-nums">{money(m.value)} <span className="text-muted-foreground">{((m.value / total) * 100).toFixed(1)}%</span></span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:items-start">
        <Card>
          <CardHeader><CardTitle>{year} so far</CardTitle><CardDescription>From your brokerages' own records</CardDescription></CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <div className="flex justify-between"><span>Money put in, net of withdrawals</span><span className="font-medium tabular-nums">{money(moneyIn)}</span></div>
            <div className="flex justify-between"><span>Dividends and interest</span><span className="font-medium tabular-nums">{money(earned)}</span></div>
            <div className="flex justify-between"><span>Fees</span><span className="font-medium tabular-nums">{money(fees)}</span></div>
            <p className="text-muted-foreground text-xs">Includes 401k contributions. Moving money between two linked brokerages cancels out.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Recent activity</CardTitle><CardDescription>+ is cash into an investment account</CardDescription></CardHeader>
          <CardContent><ActivityList rows={activity.slice(0, 10)} showAccount /></CardContent>
        </Card>
      </div>

      {order.map((a) => <AccountCard key={a.account_id} account={a} rows={byAccount.get(a.account_id) ?? []} total={total} onSaved={refresh} onPick={setPick} />)}
      <PositionSheet pick={pick} rows={all} accounts={accounts} onClose={() => setPick(null)} />
      {excludedAccounts.map((a) => (
        <Card key={a.account_id}>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="grid gap-1">
              <CardTitle><a href={`#accounts/${a.account_id}`} className="hover:underline">{a.name}</a></CardTitle>
              <CardDescription>{a.institution}{a.mask && ` ••${a.mask}`} · not counted in net worth or these totals</CardDescription>
            </div>
            <span className="text-muted-foreground text-lg font-semibold tabular-nums">{money(a.balance ?? 0)}</span>
          </CardHeader>
        </Card>
      ))}
    </div>
  )
}

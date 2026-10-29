import { useMemo } from 'react'
import { ArrowDownRightIcon, ArrowUpRightIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { Bar } from '@/components/badges'
import { TxnRow } from '@/components/txn-row'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type Txn, addDaysISO, isSpend, money, money0, shortDate, todayISO } from '@/lib/api'
import { categoryStyle } from '@/lib/categories'
import { useData } from '@/lib/data'

// Weeks run Monday to Sunday. The default is the last finished week.
export const weekStart = (d: string) => addDaysISO(d, -((new Date(`${d}T12:00:00`).getDay() + 6) % 7))
const lastFullWeek = () => addDaysISO(weekStart(todayISO()), -7)
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const sum = (list: Txn[]) => list.reduce((s, t) => s + t.amount, 0)

// Up/down in words plus an arrow; color only says whether that direction is good.
function Change({ d, goodWhenUp, than }: { d: number; goodWhenUp: boolean; than: string }) {
  if (Math.abs(d) < 1) return <span className="text-muted-foreground text-sm">same as {than}</span>
  const up = d > 0
  const Icon = up ? ArrowUpRightIcon : ArrowDownRightIcon
  return (
    <span className="inline-flex items-center gap-0.5 text-sm" style={{ color: up === goodWhenUp ? 'var(--status-good)' : 'var(--status-critical)' }}>
      <Icon className="size-4" aria-hidden />{money0(Math.abs(d))} {up ? 'more' : 'less'}<span className="text-muted-foreground ml-1">than {than}</span>
    </span>
  )
}

export function Recap({ week }: { week: string | null }) {
  const { ledger, networth, recurrings } = useData()
  const start = week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? weekStart(week) : lastFullWeek()
  const end = addDaysISO(start, 6)
  const rows = ledger?.rows ?? []

  const s = useMemo(() => {
    const spend = rows.filter(isSpend)
    const inWeek = (t: Txn, from: string) => t.date >= from && t.date <= addDaysISO(from, 6)
    const cur = spend.filter((t) => inWeek(t, start))
    // Usual week: the eight weeks before this one.
    const prior = Array.from({ length: 8 }, (_, i) => sum(spend.filter((t) => inWeek(t, addDaysISO(start, -7 * (i + 1))))))
    const byDay = DAYS.map((_, i) => sum(cur.filter((t) => t.date === addDaysISO(start, i))))
    const cats = new Map<string, number>()
    for (const t of cur) cats.set(t.category, (cats.get(t.category) ?? 0) + t.amount)
    return {
      spent: sum(cur), usual: prior.reduce((a, b) => a + b, 0) / 8, byDay,
      cats: [...cats].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5),
      biggest: [...cur].sort((a, b) => b.amount - a.amount).slice(0, 5),
    }
  }, [rows, start])

  const nwAt = (d: string) => { const p = [...networth].reverse().find((x) => x.date <= d); return p ? p.assets - p.debt : null }
  const nwEnd = nwAt(end), nwStart = nwAt(addDaysISO(start, -1))
  const nextFrom = addDaysISO(end, 1), nextTo = addDaysISO(end, 7)
  const coming = recurrings.filter((r) => r.active && r.lastAmount > 0 && r.nextDate >= nextFrom && r.nextDate <= nextTo)
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate))
  const maxDay = Math.max(...s.byDay, 1)
  const isLast = start >= lastFullWeek()

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Week of {shortDate(start)} – {shortDate(end)}</h2>
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" aria-label="Previous week" onClick={() => (location.hash = `recap/${addDaysISO(start, -7)}`)}><ChevronLeftIcon /></Button>
          <Button size="icon" variant="ghost" aria-label="Next week" disabled={isLast} onClick={() => (location.hash = `recap/${addDaysISO(start, 7)}`)}><ChevronRightIcon /></Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="gap-1">
            <CardDescription>Spent this week</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{money0(s.spent)}</CardTitle>
            <Change d={s.spent - s.usual} goodWhenUp={false} than={`your usual ${money0(s.usual)} a week`} />
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="gap-1">
            <CardDescription>Net worth</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{nwEnd != null ? money0(nwEnd) : '…'}</CardTitle>
            {nwEnd != null && nwStart != null && <Change d={nwEnd - nwStart} goodWhenUp than="the week before" />}
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Day by day</CardTitle><CardDescription>Stronger color means more spent that day</CardDescription></CardHeader>
        <CardContent>
          {/* One hue, light to dark, with the amount written on every cell so the shade is never the only cue. */}
          <div className="grid grid-cols-7 gap-1.5">
            {s.byDay.map((v, i) => (
              <div key={i} className="grid gap-1 text-center">
                <span className="text-muted-foreground text-xs">{DAYS[i]}</span>
                <div className="relative grid h-16 place-content-center overflow-hidden rounded-md border">
                  <div className="absolute inset-0" style={{ background: 'var(--chart-1)', opacity: v > 0 ? 0.12 + 0.6 * (v / maxDay) : 0 }} />
                  <span className={`relative text-xs tabular-nums ${v / maxDay > 0.6 ? 'font-semibold' : ''}`}>{v > 0 ? money0(v) : '—'}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className={`grid gap-4 ${isLast ? 'lg:grid-cols-2' : ''}`}>
        <Card>
          <CardHeader><CardTitle>Where it went</CardTitle><CardDescription>Top categories this week</CardDescription></CardHeader>
          <CardContent className="grid gap-3">
            {s.cats.length === 0 && <p className="text-muted-foreground text-sm">No spending this week.</p>}
            {s.cats.map(([name, v]) => {
              const { emoji, color } = categoryStyle(name)
              return (
                <div key={name} className="grid gap-1.5">
                  <div className="flex justify-between text-sm"><span><span aria-hidden className="mr-1.5">{emoji}</span>{name}</span><span className="tabular-nums">{money0(v)}</span></div>
                  <Bar value={(v / s.cats[0][1]) * 100} color={color} />
                </div>
              )
            })}
          </CardContent>
        </Card>
        {isLast && <Card>
          <CardHeader><CardTitle>Coming up</CardTitle><CardDescription>Bills {shortDate(nextFrom)} – {shortDate(nextTo)}</CardDescription></CardHeader>
          <CardContent className="flex flex-1 flex-col gap-2">
            {coming.length === 0 && <p className="text-muted-foreground text-sm">Nothing due.</p>}
            {coming.map((r) => (
              <div key={r.name} className="flex justify-between gap-3 text-sm">
                <span className="truncate"><span className="text-muted-foreground inline-block w-14">{shortDate(r.nextDate)}</span>{r.name}</span>
                <span className="tabular-nums">{money(r.lastAmount)}</span>
              </div>
            ))}
            <a href="#recurrings" className="text-muted-foreground mt-auto pt-2 text-sm hover:underline">See the bills calendar →</a>
          </CardContent>
        </Card>}
      </div>

      <Card>
        <CardHeader><CardTitle>Biggest purchases</CardTitle></CardHeader>
        <CardContent className="grid">
          {s.biggest.length === 0 && <p className="text-muted-foreground text-sm">None.</p>}
          {s.biggest.map((t) => <TxnRow key={t.id} t={t} />)}
        </CardContent>
      </Card>
    </div>
  )
}

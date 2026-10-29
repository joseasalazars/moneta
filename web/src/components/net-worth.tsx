import { useState } from 'react'
import { ArrowDownRightIcon, ArrowUpRightIcon } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { money0, shortDate } from '@/lib/api'
import { useData } from '@/lib/data'

const RANGES = ['1W', '1M', '3M', 'YTD', '1Y', 'ALL'] as const
type Range = (typeof RANGES)[number]
const chartConfig = { net: { label: 'Net worth', color: 'var(--chart-1)' } } satisfies ChartConfig

function since(range: Range, end: string) {
  if (range === 'ALL') return ''
  if (range === 'YTD') return `${end.slice(0, 4)}-01-01`
  const days = { '1W': 7, '1M': 30, '3M': 91, '1Y': 365 }[range]
  return new Date(Date.parse(end) - days * 86400000).toISOString().slice(0, 10)
}

// Change over the range: an arrow and words carry the direction; the status color only reinforces it.
// No percentage from a tiny base (ALL starts at ~$50 of assets), where it would read as thousands of %.
function Change({ from, to, goodWhenUp }: { from: number; to: number; goodWhenUp: boolean }) {
  const delta = to - from
  if (Math.abs(delta) < 0.5) return <span className="text-muted-foreground text-xs">no change</span>
  const up = delta > 0
  const good = up === goodWhenUp
  const Icon = up ? ArrowUpRightIcon : ArrowDownRightIcon
  return (
    <span className="inline-flex items-center gap-0.5 text-xs" style={{ color: good ? 'var(--status-good)' : 'var(--status-critical)' }}>
      <Icon className="size-3.5" aria-hidden />
      <span className="text-muted-foreground">{money0(Math.abs(delta))}{Math.abs(from) >= 1000 && Math.abs(delta) < 10 * Math.abs(from) && ` (${Math.abs((delta / Math.abs(from)) * 100).toFixed(1)}%)`}</span>
    </span>
  )
}

export function NetWorthCard({ className = '' }: { className?: string }) {
  const { networth } = useData()
  const [range, setRange] = useState<Range>('1Y')
  if (networth.length < 2) return null

  const end = networth.at(-1)!.date
  const points = networth.filter((p) => p.date >= since(range, end)).map((p) => ({ ...p, net: p.assets - p.debt }))
  const first = points[0], last = points.at(-1)!

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <CardDescription>Net worth</CardDescription>
          <CardTitle className="text-2xl tabular-nums">{money0(last.net)}</CardTitle>
          <Change from={first.net} to={last.net} goodWhenUp />
        </div>
        <div className="flex gap-6 text-sm">
          <div className="grid gap-0.5"><span className="text-muted-foreground text-xs">Assets</span><span className="tabular-nums">{money0(last.assets)}</span><Change from={first.assets} to={last.assets} goodWhenUp /></div>
          <div className="grid gap-0.5"><span className="text-muted-foreground text-xs">Debt</span><span className="tabular-nums">{money0(last.debt)}</span><Change from={first.debt} to={last.debt} goodWhenUp={false} /></div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <ChartContainer config={chartConfig} className="aspect-auto min-h-56 w-full flex-1">
          <AreaChart data={points} margin={{ left: 0, right: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={48} tickFormatter={shortDate} />
            <YAxis tickLine={false} axisLine={false} width={72} tickFormatter={(v: number) => money0(v)} domain={['auto', 'auto']} />
            <ChartTooltip content={<ChartTooltipContent indicator="line" labelFormatter={(_, p) => p?.[0]?.payload?.date} />} />
            <Area dataKey="net" type="monotone" stroke="var(--color-net)" fill="var(--color-net)" fillOpacity={0.12} strokeWidth={2} />
          </AreaChart>
        </ChartContainer>
        <div className="flex justify-center gap-1">
          {RANGES.map((r) => (
            <Button key={r} size="sm" variant={range === r ? 'secondary' : 'ghost'} onClick={() => setRange(r)}>{r}</Button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

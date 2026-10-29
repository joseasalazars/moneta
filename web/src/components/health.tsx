import { useEffect, useState } from 'react'
import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, money0, monthLabel } from '@/lib/api'
import { useData } from '@/lib/data'

type Check = { id: string; ok: boolean; state: 'working' | 'ignored' | null; actual: number; target?: number; share?: number | null; month?: string; move?: number; yearly?: number; cards?: string[] }

const pct = (n?: number | null) => `${Math.round((n ?? 0) * 100)}%`

// Words for each check (numbers come from buildHealth in ledger.js). Amounts go through money0, so the eye hides them.
const text = (idle: { name: string; apy: number }): Record<string, { title: string; link: string; say: (c: Check) => string }> => ({
  save: { title: 'Saving your monthly goal', link: 'goals', say: (c) => `${money0(c.actual)} a month left after spending (last 3 months); goal ${money0(c.target!)}` },
  earn: { title: 'Spending less than you earn', link: 'cashflow', say: (c) => `${monthLabel(c.month!)}: spent ${money0(c.actual)} of ${money0(c.target!)} income` },
  budget: { title: "Within this month's budget", link: 'categories', say: (c) => `${money0(c.actual)} of ${money0(c.target!)}${c.ok ? '' : `, over by ${money0(c.actual - c.target!)}`}` },
  housing: { title: 'Rent under 30% of income', link: 'categories', say: (c) => `${money0(c.actual)} rent is ${pct(c.share)} of your average income` },
  car: { title: 'Car costs under 20% of income', link: 'categories', say: (c) => `${money0(c.actual)} a month is ${pct(c.share)} of income` },
  cushion: { title: '3 months of spending in cash', link: 'goals', say: (c) => `${money0(c.actual)} in bank and brokerage cash; 3 months is ${money0(c.target!)}` },
  idle: {
    title: 'No idle cash in checking', link: 'accounts',
    say: (c) => (c.ok ? `${money0(c.actual)} in checking, about a month of spending` : `Move ${money0(c.move!)} to ${idle.name} (${+(idle.apy * 100).toFixed(2)}%): about ${money0(c.yearly!)} a year`),
  },
  cards: { title: 'Card statements paid on time', link: 'accounts', say: (c) => (c.ok ? 'Nothing past due' : `Past due: ${c.cards!.join(', ')}`) },
})

export function HealthCard({ className = '' }: { className?: string }) {
  const { ledger, settings } = useData()
  const TEXT = text(settings.idle_cash)
  const [checks, setChecks] = useState<Check[]>([])
  const load = () => api<Check[]>('/api/health').then(setChecks)
  useEffect(() => { load() }, [ledger])
  if (!checks.length) return null
  const mark = async (id: string, state: Check['state']) => { await api('/api/health/state', { id, state }); await load() }

  // "Doesn't apply to me" takes a check out of the score; "Working on it" keeps it counted, below the open actions.
  const counted = checks.filter((c) => c.state !== 'ignored')
  const ignored = checks.filter((c) => c.state === 'ignored' && TEXT[c.id])
  const rank = (c: Check) => (c.ok ? 2 : c.state === 'working' ? 1 : 0)
  const sorted = [...counted].sort((a, b) => rank(a) - rank(b))
  const passed = counted.filter((c) => c.ok).length
  const open = counted.length - passed

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Financial health</CardTitle>
        <CardDescription>{passed} of {counted.length} checks pass · {open} {open === 1 ? 'action' : 'actions'}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {/* One segment per check, failing ones first; the list below says which is which. */}
        <div className="flex h-2 gap-0.5" role="img" aria-label={`${passed} of ${counted.length} checks pass`}>
          {sorted.map((c) => <div key={c.id} className="flex-1 rounded-full" style={{ background: c.ok ? 'var(--status-good)' : 'var(--status-critical)' }} />)}
        </div>
        <div className="grid gap-1">
          {sorted.map((c) => {
            const t = TEXT[c.id]
            if (!t) return null
            const Icon = c.ok ? CircleCheckIcon : CircleAlertIcon
            return (
              <div key={c.id} className={`-mx-2 flex gap-2.5 rounded-md px-2 ${c.ok ? 'py-1' : 'py-2'}`}>
                <Icon className="mt-0.5 size-4 shrink-0" style={{ color: c.ok ? 'var(--status-good)' : 'var(--status-critical)' }} aria-label={c.ok ? 'Pass' : 'Needs action'} />
                <div className="grid min-w-0 gap-0.5">
                  <a href={`#${t.link}`} title={c.ok ? t.say(c) : undefined} className={`hover:underline ${c.ok ? 'text-sm' : 'text-sm font-medium'}`}>
                    {t.title}
                    {c.state === 'working' && !c.ok && <Badge variant="secondary" className="ml-2 align-middle">In progress</Badge>}
                  </a>
                  {!c.ok && <span className="text-muted-foreground text-xs">{t.say(c)}</span>}
                  {!c.ok && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => mark(c.id, c.state === 'working' ? null : 'working')}>
                        {c.state === 'working' ? 'Not working on it' : 'Working on it'}
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => mark(c.id, 'ignored')}>Doesn't apply to me</Button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {ignored.length > 0 && (
          <p className="text-muted-foreground text-xs">
            Not counted: {ignored.map((c, i) => (
              <span key={c.id}>{i > 0 && ', '}{TEXT[c.id].title} (<button type="button" className="underline" onClick={() => mark(c.id, null)}>count it again</button>)</span>
            ))}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

import { useState } from 'react'
import { AlertTriangleIcon, BellIcon, CircleCheckIcon, FileTextIcon, OctagonAlertIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, shortDate } from '@/lib/api'
import { useData } from '@/lib/data'

// Severity is carried by the icon shape and the words; the status color only reinforces it.
const SEVERITY = {
  critical: { Icon: OctagonAlertIcon, color: 'var(--status-critical)', label: 'Needs attention' },
  warning: { Icon: AlertTriangleIcon, color: 'var(--status-warning)', label: 'Heads up' },
  info: { Icon: FileTextIcon, color: 'var(--chart-1)', label: 'For you' },
} as const

// The usual place for notifications: a bell in the top bar with a count, opening a panel anchored to it.
// Each alert links to where you act on it and can be dismissed; new ones also arrive as Mac notifications after a sync.
export function AlertsBell() {
  const { alerts, reload } = useData()
  const [open, setOpen] = useState(false)
  const critical = alerts.some((a) => a.severity === 'critical')

  async function dismiss(ids: string[]) {
    for (const id of ids) await api('/api/alerts/dismiss', { id })
    await reload()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={alerts.length ? `Alerts, ${alerts.length} active` : 'Alerts, none'}>
          <BellIcon className="size-5" />
          {alerts.length > 0 && (
            <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold text-white tabular-nums"
              style={{ background: critical ? 'var(--status-critical)' : 'var(--foreground)' }} aria-hidden>
              {alerts.length > 9 ? '9+' : alerts.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="font-medium">Alerts</span>
          {alerts.length > 0 && <Button size="sm" variant="ghost" className="h-7" onClick={() => dismiss(alerts.map((a) => a.id))}>Dismiss all</Button>}
        </div>
        {alerts.length === 0 ? (
          <div className="text-muted-foreground grid justify-items-center gap-2 px-4 py-8 text-sm">
            <CircleCheckIcon className="size-6" style={{ color: 'var(--status-good)' }} aria-hidden />
            You're all caught up.
          </div>
        ) : (
          <ul className="max-h-[70vh] overflow-y-auto py-1">
            {alerts.map((a) => {
              const { Icon, color, label } = SEVERITY[a.severity]
              return (
                <li key={a.id} className="hover:bg-muted/60 group flex items-start gap-3 px-4 py-2.5">
                  <Icon className="mt-0.5 size-4 shrink-0" style={{ color }} aria-label={label} />
                  <a href={`#${a.link}`} onClick={() => setOpen(false)} className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{a.title}</div>
                    <div className="text-muted-foreground text-xs">{a.detail}</div>
                    <div className="text-muted-foreground text-xs">{shortDate(a.date)}</div>
                  </a>
                  <Button size="icon" variant="ghost" className="size-7 opacity-60 group-hover:opacity-100" onClick={() => dismiss([a.id])} aria-label={`Dismiss: ${a.title}`}>
                    <XIcon className="size-4" />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
        <p className="text-muted-foreground border-t px-4 py-2 text-xs">Budgets, unusual charges, price changes and missing bills. New ones also show as Mac notifications after a sync.</p>
      </PopoverContent>
    </Popover>
  )
}

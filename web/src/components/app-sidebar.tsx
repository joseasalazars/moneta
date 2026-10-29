import { useState } from 'react'
import { ArrowLeftRightIcon, ChevronRightIcon, SettingsIcon, CalendarRangeIcon, ChartLineIcon, ChartPieIcon, CheckCheckIcon, FileTextIcon, LandmarkIcon, LayoutDashboardIcon, RepeatIcon, TargetIcon, WalletIcon } from 'lucide-react'
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu,
  SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar'
import { money0 } from '@/lib/api'
import { useData } from '@/lib/data'

export type Page = 'dashboard' | 'transactions' | 'cashflow' | 'categories' | 'goals' | 'recap' | 'report' | 'accounts' | 'investments' | 'recurrings' | 'review' | 'settings'

const NAV: [Page, string, typeof LayoutDashboardIcon][] = [
  ['dashboard', 'Dashboard', LayoutDashboardIcon],
  ['transactions', 'Transactions', ArrowLeftRightIcon],
  ['cashflow', 'Cash flow', LandmarkIcon],
  ['categories', 'Categories', ChartPieIcon],
  ['goals', 'Goals', TargetIcon],
  ['recap', 'Weekly recap', CalendarRangeIcon],
  ['report', 'Monthly report', FileTextIcon],
  ['accounts', 'Accounts', WalletIcon],
  ['investments', 'Investments', ChartLineIcon],
  ['recurrings', 'Recurrings', RepeatIcon],
  ['review', 'Review', CheckCheckIcon],
  ['settings', 'Settings', SettingsIcon],
]

export const ACCOUNT_GROUPS: [string, string][] = [
  ['credit', 'Credit cards'], ['depository', 'Cash'], ['investment', 'Investments'], ['loan', 'Loans'], ['other', 'Other'],
]
export const groupOf = (type: string) => (ACCOUNT_GROUPS.some(([t]) => t === type) ? type : 'other')

// Account groups you've folded away, remembered per browser.
const CLOSED_KEY = 'ledger:sidebar-closed'
const readClosed = () => { try { return new Set<string>(JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]')) } catch { return new Set<string>() } }

export function AppSidebar({ page, go }: { page: string; go: (p: string) => void }) {
  const { ledger, accounts } = useData()
  const [closed, setClosed] = useState(readClosed)
  const toggle = (type: string) => setClosed((prev) => {
    const next = new Set(prev)
    if (!next.delete(type)) next.add(type)
    try { localStorage.setItem(CLOSED_KEY, JSON.stringify([...next])) } catch { /* private window: this session only */ }
    return next
  })
  const toReview = ledger?.rows.filter((t) => !t.reviewed && !t.pairedWith).length ?? 0

  return (
    <Sidebar>
      <SidebarHeader className="gap-0 border-b p-0">
        <div className="px-4 pt-4 pb-1 text-lg font-semibold tracking-tight">Moneta</div>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map(([id, label, Icon]) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton isActive={page === id} onClick={() => go(id)}>
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                  {id === 'review' && toReview > 0 && <SidebarMenuBadge>{toReview}</SidebarMenuBadge>}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarHeader>
      <SidebarContent>
        {ACCOUNT_GROUPS.map(([type, label]) => {
          const list = accounts.filter((a) => groupOf(a.type) === type)
          if (!list.length) return null
          const open = !closed.has(type)
          const total = list.filter((a) => !a.excluded).reduce((s, a) => s + (a.balance ?? 0), 0)
          return (
            <SidebarGroup key={type}>
              <SidebarGroupLabel asChild>
                <button type="button" onClick={() => toggle(type)} aria-expanded={open} className="hover:bg-sidebar-accent w-full gap-1 text-left">
                  <ChevronRightIcon className={`transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
                  <span>{label}</span>
                  <span className="ml-auto tabular-nums">{money0(total)}</span>
                </button>
              </SidebarGroupLabel>
              {open && <SidebarGroupContent>
                <SidebarMenu>
                  {list.map((a) => (
                    <SidebarMenuItem key={a.account_id}>
                      <SidebarMenuButton isActive={page === `accounts/${a.account_id}`} onClick={() => go(`accounts/${a.account_id}`)}
                        title={a.excluded ? `${a.name}: not counted in net worth` : a.name}>
                        {/* Two accounts with one name (Robinhood individual) are told apart by their last digits. */}
                        <span className="min-w-0 truncate">{a.name}{a.mask && list.filter((b) => b.name === a.name).length > 1 && ` ••${a.mask}`}</span>
                        <span className={`text-muted-foreground ml-auto shrink-0 text-xs tabular-nums ${a.excluded ? 'line-through' : ''}`}>{money0(a.balance ?? 0)}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>}
            </SidebarGroup>
          )
        })}
      </SidebarContent>
    </Sidebar>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { EyeIcon, EyeOffIcon, LockIcon } from 'lucide-react'
import { Accounts } from '@/components/accounts'
import { AlertsBell } from '@/components/alerts'
import { AppSidebar } from '@/components/app-sidebar'
import { ConnectButton } from '@/components/connect-button'
import { CashFlow } from '@/components/cash-flow'
import { Categories } from '@/components/categories'
import { Dashboard } from '@/components/dashboard'
import { Goals } from '@/components/goals'
import { LockGate, lockNow } from '@/components/lock'
import { Recap } from '@/components/recap'
import { SettingsPage } from '@/components/settings'
import { Report } from '@/components/report'
import { Investments } from '@/components/investments'
import { Recurrings } from '@/components/recurrings'
import { Review } from '@/components/review'
import { ThemeToggle } from '@/components/theme-toggle'
import { TransactionSheet } from '@/components/transaction-sheet'
import { Transactions } from '@/components/transactions'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { type SyncResult, api, moneyHidden, monthLabel, setMoneyHidden, thisMonth } from '@/lib/api'
import { DataProvider, useData } from '@/lib/data'

const ALL = 'all'
const TITLES: Record<string, string> = {
  dashboard: 'Dashboard', transactions: 'Transactions', cashflow: 'Cash flow', categories: 'Categories', goals: 'Goals', recap: 'Weekly recap', report: 'Monthly report', accounts: 'Accounts', investments: 'Investments', recurrings: 'Recurrings', review: 'Review', settings: 'Settings',
}

// The page lives in the URL hash (#transactions, #accounts/<id>) so reload and back button work without a router.
function useHashPage() {
  const read = () => decodeURIComponent(location.hash.slice(1)) || 'dashboard'
  const [page, setPage] = useState(read)
  useEffect(() => {
    const onHash = () => setPage(read())
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])
  return [page, (p: string) => { location.hash = p }] as const
}

function Shell() {
  const { ledger, reload, status, setStatus } = useData()
  const [page, go] = useHashPage()
  const [month, setMonth] = useState(thisMonth())
  const [syncing, setSyncing] = useState(false)
  const [hidden, setHidden] = useState(moneyHidden)
  useEffect(() => {
    const on = () => setHidden(moneyHidden)
    addEventListener('ledger:privacy', on)
    return () => removeEventListener('ledger:privacy', on)
  }, [])
  const [section, accountId] = page.split('/') as [string, string | undefined]

  const sync = useCallback(async () => {
    setSyncing(true)
    setStatus('') // the button already says Syncing…
    try {
      const results = await api<SyncResult[]>('/api/sync', {})
      // Right after linking Plaid may report NOT_READY with 0 transactions; sync again in a minute.
      const added = results.reduce((n, r) => n + (r.added ?? 0), 0)
      const failed = results.filter((r) => r.error).map((r) => r.institution)
      const pending = results.filter((r) => r.status && r.status !== 'HISTORICAL_UPDATE_COMPLETE').map((r) => r.institution)
      setStatus(failed.length ? `Error: couldn't reach ${failed.join(', ')}. The other banks synced; see Accounts.`
        : !results.length ? 'No accounts linked yet'
        : pending.length ? `Still pulling history from ${pending.join(', ')}. Sync again in a minute.`
        : added ? `Synced · ${added} new transaction${added === 1 ? '' : 's'}` : 'Synced · everything is up to date')
      await reload()
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`)
    } finally {
      setSyncing(false)
    }
  }, [reload, setStatus])

  // Confirmations fade after a few seconds; errors stay until dismissed.
  const isError = /error/i.test(status)
  useEffect(() => {
    if (!status || isError) return
    const t = setTimeout(() => setStatus(''), 4000)
    return () => clearTimeout(t)
  }, [status, isError, setStatus])

  const months = useMemo(() => {
    const set = new Set([thisMonth(), ...(ledger?.rows ?? []).map((t) => t.date.slice(0, 7))])
    return [...set].sort().reverse()
  }, [ledger])
  const report = ledger?.report
  const showMonth = section === 'dashboard' || section === 'transactions' || section === 'categories'

  return (
    <SidebarProvider key={String(hidden)}>
      <AppSidebar page={page} go={go} />
      <SidebarInset>
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <h1 className="text-lg font-semibold">{TITLES[section] ?? 'Moneta'}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {showMonth && (
              <Select value={month} onValueChange={setMonth}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {section === 'transactions' && <SelectItem value={ALL}>All months</SelectItem>}
                  {months.map((m) => <SelectItem key={m} value={m}>{monthLabel(m)}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <Button variant="ghost" size="icon" onClick={() => setMoneyHidden(!hidden)} aria-pressed={hidden}
              aria-label={hidden ? 'Show amounts' : 'Hide amounts'} title={hidden ? 'Show amounts' : 'Hide amounts'}>
              {hidden ? <EyeOffIcon className="size-5" /> : <EyeIcon className="size-5" />}
            </Button>
            <ThemeToggle />
            <AlertsBell />
            <Button variant="ghost" size="icon" onClick={() => lockNow(true)} aria-label="Lock Moneta" title="Lock"><LockIcon className="size-5" /></Button>
            <Button variant="outline" onClick={sync} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync'}</Button>
            <ConnectButton onLinked={sync} onStatus={setStatus} />
          </div>
        </header>

        <main className="mx-auto grid w-full max-w-7xl gap-4 p-4 sm:p-6">
          {status && (
            <div role="status" className={`-mt-1 flex items-center gap-2 text-sm ${isError ? 'text-destructive' : 'text-muted-foreground'}`}>
              <span>{status}</span>
              {isError && <button type="button" className="underline underline-offset-2" onClick={() => setStatus('')}>Dismiss</button>}
            </div>
          )}
          {report && report.unknownAccounts.length > 0 && (
            <p className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm">
              Linked accounts not found in the Copilot export: {report.unknownAccounts.join(', ')}.
              Their older Copilot history may be double counted until they are mapped.
            </p>
          )}
          {!ledger ? <p className="text-muted-foreground">Loading…</p> : (
            <>
              {section === 'dashboard' && <Dashboard month={month === ALL ? thisMonth() : month} />}
              {section === 'transactions' && <Transactions month={month === ALL ? null : month} />}
              {section === 'cashflow' && <CashFlow />}
              {section === 'categories' && <Categories month={month === ALL ? thisMonth() : month} />}
              {section === 'goals' && <Goals />}
              {section === 'recap' && <Recap week={accountId ?? null} />}
              {section === 'report' && <Report month={accountId ?? null} />}
              {section === 'accounts' && <Accounts selected={accountId ?? null} />}
              {section === 'investments' && <Investments />}
              {section === 'recurrings' && <Recurrings />}
              {section === 'review' && <Review />}
              {section === 'settings' && <SettingsPage />}
            </>
          )}
        </main>
      </SidebarInset>
      <TransactionSheet />
    </SidebarProvider>
  )
}

export default function App() {
  return (
    <TooltipProvider>
      <LockGate>
        <DataProvider>
          <Shell />
        </DataProvider>
      </LockGate>
    </TooltipProvider>
  )
}

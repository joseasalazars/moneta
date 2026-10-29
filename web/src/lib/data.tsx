import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { type Account, type Alert, type Ledger, type NetWorthPoint, type Recurring, type Settings, type Txn, api } from '@/lib/api'
import { type Group, setCustomCategories } from '@/lib/categories'

type Data = {
  ledger: Ledger | null
  accounts: Account[]
  recurrings: Recurring[]
  networth: NetWorthPoint[]
  alerts: Alert[]
  settings: Settings
  saveSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>
  categories: string[]
  tags: string[]
  reload: () => Promise<void>
  status: string
  setStatus: (s: string) => void
  editing: Txn | 'new' | null
  setEditing: (t: Txn | 'new' | null) => void
}

const DataContext = createContext<Data | null>(null)

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [recurrings, setRecurrings] = useState<Recurring[]>([])
  const [networth, setNetworth] = useState<NetWorthPoint[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [settings, setSettings] = useState<Settings>({ idle_cash: { name: 'a high-yield savings account', apy: 0.04 }, categories: {}, tag_renames: {} })
  const [status, setStatus] = useState('')
  const [editing, setEditing] = useState<Txn | 'new' | null>(null)

  const reload = useCallback(async () => {
    const [l, a, r, n, al, st] = await Promise.all([
      api<Ledger>('/api/ledger'), api<Account[]>('/api/accounts'), api<Recurring[]>('/api/recurrings'), api<NetWorthPoint[]>('/api/networth'),
      api<Alert[]>('/api/alerts'), api<Settings>('/api/settings'),
    ])
    setCustomCategories(st.categories as Record<string, [string, Group]>) // before the render that uses it
    setSettings(st)
    setLedger(l)
    setAccounts(a)
    setRecurrings(r)
    setNetworth(n)
    setAlerts(al)
  }, [])

  useEffect(() => {
    reload().catch((e: Error) => setStatus(`Error: ${e.message}`))
  }, [reload])

  const saveSetting = useCallback(async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    await api('/api/settings', { key, value })
    await reload()
  }, [reload])

  // Suggestions for category/tag inputs, most used first.
  const { categories, tags } = useMemo(() => {
    const count = (values: string[]) => {
      const m = new Map<string, number>()
      for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1) // Radix Select rejects '' values
      return [...m].sort((a, b) => b[1] - a[1]).map(([v]) => v)
    }
    const rows = ledger?.rows ?? []
    // Categories added in Settings show up as suggestions before any transaction uses them.
    const used = count(rows.map((t) => t.category))
    return { categories: [...used, ...Object.keys(settings.categories).filter((c) => !used.includes(c))], tags: count(rows.flatMap((t) => t.tags)) }
  }, [ledger, settings])

  return (
    <DataContext.Provider value={{ ledger, accounts, recurrings, networth, alerts, settings, saveSetting, categories, tags, reload, status, setStatus, editing, setEditing }}>
      {children}
    </DataContext.Provider>
  )
}

export function useData() {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData outside DataProvider')
  return ctx
}

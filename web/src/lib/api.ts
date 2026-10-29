export type Txn = {
  id: string
  date: string
  name: string
  amount: number // positive = money out, negative = money in (Plaid/Copilot convention)
  account: string
  mask: string | null
  category: string
  type: 'regular' | 'income' | 'internal transfer'
  excluded: boolean
  pending: boolean
  note: string | null
  tags: string[]
  recurring: string | null
  reviewed: boolean
  source: 'plaid' | 'copilot' | 'split' | 'manual'
  via?: 'PayPal' // a card or bank charge that paid a PayPal purchase
  pairedWith?: string // the PayPal copy of that charge: hidden from lists, shown on the PayPal account
  foreign?: string // original amount when the bank reported another currency, e.g. "2000 MXN"
  splitOf?: string // set on parts of a split made in the app: the original transaction's id
}

export type Account = {
  account_id: string // Plaid id, or manual:<id>
  institution: string | null
  name: string
  mask: string | null
  type: string
  subtype: string | null
  balance: number | null
  updated_at: string | null // last sync (Plaid) or last balance entered (manual)
  bank_update?: string | null // when Plaid last reached the bank
  item_error?: string | null // e.g. ITEM_LOGIN_REQUIRED
  manual: 0 | 1
  excluded?: boolean // left out of net worth and investment totals (unvested RSUs)
  asset?: 'BTC' | 'XAU' | null // market-priced holding: quantity × spot price
  quantity?: number | null
  price?: number // per BTC, or per gram of gold
  // Credit cards with Plaid Liabilities (Amex, Robinhood card)
  due_date?: string | null
  minimum?: number | null
  statement_balance?: number | null
  statement_date?: string | null
  last_payment?: number | null
  last_payment_date?: string | null
  overdue?: 0 | 1 | null
  apr?: number | null
}

// Same rule as statementPaid in ledger.js: a payment at least the statement balance, on or after the statement date.
export const statementPaid = (a: Account) => !((a.statement_balance ?? 0) > 0)
  || ((a.last_payment_date ?? '') >= (a.statement_date ?? '') && (a.last_payment ?? 0) >= (a.statement_balance ?? 0) - 0.01)

export const ASSET_LABEL = { BTC: 'BTC', XAU: 'g gold' } as const

export type Recurring = {
  name: string
  category: string
  account: string
  frequency: string
  lastDate: string
  lastAmount: number
  avgAmount: number
  nextDate: string
  active: boolean
  monthPaid: number
  yearTotal: number
  count: number
  schedule: { id: number; bill: boolean; account: string; amount: number; count: number | null; remaining: number | null; endDate: string | null } | null
  transactions: { id: string; date: string; name: string; amount: number; account: string }[]
}

// An investment position. live/prev come from the latest quote; liveValue = quantity × live (cash: its value).
export type Holding = {
  account_id: string
  symbol: string
  name: string | null
  type: string // Plaid security type: equity, etf, mutual fund, cryptocurrency, cash...
  quantity: number
  cost_basis: number | null
  price: number // Plaid's (or entry-time) price
  value: number
  manual: 0 | 1
  live: number
  prev: number | null
  liveValue: number
  quoted_at: string | null
}

export type Alert = {
  id: string
  kind: 'budget' | 'large' | 'price' | 'missed' | 'card' | 'report' | 'recap' | 'bill'
  severity: 'critical' | 'warning' | 'info'
  date: string
  title: string
  detail: string
  link: string // page hash
}

// Investment activity from Plaid. amount: positive = cash out of the account (buy, withdrawal), negative = cash in.
export type InvTxn = {
  id: string; account_id: string; date: string; name: string; type: string; subtype: string
  symbol: string | null; quantity: number; price: number; amount: number; fees: number | null
}

export type NetWorthPoint = { date: string; assets: number; debt: number }

export type Rule = { id: number; field: string; match: string; category: string | null; tags: string; recurring: string | null }

type Loose = { date: string; name: string; amount: number; account: string }
export type Report = { matched: number; unmatchedPlaid: Loose[]; unmatchedCopilot: Loose[]; unknownAccounts: string[] }
export type Ledger = { rows: Txn[]; report: Report }
export type Settings = {
  idle_cash: { name: string; apy: number } // where idle checking money should go (health check)
  categories: Record<string, [string, string]> // category -> [emoji, group]
  tag_renames: Record<string, string> // old tag -> new tag ('' deletes it)
}

export type SyncResult = { institution: string | null; added?: number; modified?: number; removed?: number; status?: string; error?: string }

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  // Locked (passkey session expired or the server restarted): the lock screen takes over.
  if (res.status === 401) dispatchEvent(new Event('ledger:locked'))
  const data = await res.json()
  if (!res.ok) throw new Error(data.error)
  return data
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
// Privacy: the eye icon swaps every amount for dots. Remembered per browser; the shell remounts on the event.
const HIDE_KEY = 'ledger:hide-money'
export let moneyHidden = (() => { try { return localStorage.getItem(HIDE_KEY) === '1' } catch { return false } })()
export function setMoneyHidden(hide: boolean) {
  moneyHidden = hide
  try { localStorage.setItem(HIDE_KEY, hide ? '1' : '0') } catch { /* private window: this session only */ }
  dispatchEvent(new Event('ledger:privacy'))
}
const HIDDEN = '$••••'
export const money = (n: number) => (moneyHidden ? HIDDEN : usd.format(n || 0)) // || 0 turns -0 into 0, no "-$0"
export const money0 = (n: number) => (moneyHidden ? HIDDEN : usd0.format(n || 0))

// "5 min ago", "3 h ago", "2 days ago".
export function ago(iso: string) {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  if (min < 2) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`
  return `${Math.round(min / 1440)} days ago`
}

export const todayISO = () => new Date().toLocaleDateString('en-CA')
export const addDaysISO = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10)

export const isSpend = (t: Txn) => t.type === 'regular' && !t.excluded
// Copilot flags income rows as excluded (= not spending), so income ignores the flag.
export const isIncome = (t: Txn) => t.type === 'income'
export const LIABILITY = new Set(['credit', 'loan'])

export const thisMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
export const prevMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7)
}
export const daysIn = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  return new Date(Date.UTC(y, mo, 0)).getUTCDate()
}
export const monthLabel = (m: string) =>
  new Date(`${m}-01T12:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' })
export const shortDate = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleString('en-US', { month: 'short', day: 'numeric' })

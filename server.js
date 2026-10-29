import http from 'node:http';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ALGS, b64url, checkCeremony, verifyAssertion } from './auth.js';
import { buildAlerts, buildHealth, buildRecurrings, dueOccurrences, loadLedger } from './ledger.js';

const { PLAID_CLIENT_ID, PLAID_SECRET, PORT = '3000' } = process.env;
// `node server.js --demo` (npm run demo) works on every OS, unlike setting PLAID_ENV inline.
const PLAID_ENV = process.argv.includes('--demo') ? 'demo' : process.env.PLAID_ENV || 'sandbox';
// PLAID_ENV=demo (npm run demo): no Plaid keys, no banks, a database filled with made-up data (demo.js).
const demo = PLAID_ENV === 'demo';
// Without Plaid keys Moneta still runs: manual accounts, transactions, budgets and everything else; only connecting
// and syncing banks needs the keys.
const plaidKeys = !!(PLAID_CLIENT_ID && PLAID_SECRET);
if (!demo && !plaidKeys) console.log('No Plaid keys in .env: running with manual accounts only. Add keys to connect banks (see README).');

const smoke = process.argv[2] === 'smoke';
// ponytail: access_token stored in plaintext in a gitignored local file; encrypt (keychain) if this ever leaves the laptop
// One DB per environment so sandbox test Items never mix with real ones.
const dbFile = new URL(`ledger-${PLAID_ENV}.db`, import.meta.url).pathname;
const db = new DatabaseSync(smoke ? ':memory:' : dbFile);
if (!smoke) chmodSync(dbFile, 0o600); // bank tokens and every transaction: readable by this user only
db.exec(`
  CREATE TABLE IF NOT EXISTS items (item_id TEXT PRIMARY KEY, access_token TEXT NOT NULL, institution TEXT, cursor TEXT);
  CREATE TABLE IF NOT EXISTS accounts (account_id TEXT PRIMARY KEY, item_id TEXT, name TEXT, mask TEXT, type TEXT, subtype TEXT, balance REAL, currency TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS transactions (transaction_id TEXT PRIMARY KEY, account_id TEXT, date TEXT, name TEXT, merchant TEXT, amount REAL, currency TEXT, category TEXT, pending INTEGER);
  CREATE TABLE IF NOT EXISTS copilot_transactions (
    date TEXT, name TEXT, amount REAL, status TEXT, category TEXT, parent_category TEXT,
    excluded TEXT, tags TEXT, type TEXT, account TEXT, account_mask TEXT, note TEXT, recurring TEXT
  );
  -- Per-transaction overrides keyed by ledger id (Plaid transaction_id, copilot:<rowid>, manual:<id>); NULL = untouched.
  CREATE TABLE IF NOT EXISTS edits (
    id TEXT PRIMARY KEY, name TEXT, category TEXT, type TEXT, excluded INTEGER, note TEXT, tags TEXT, recurring TEXT, reviewed INTEGER
  );
  CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY, match TEXT NOT NULL, category TEXT, tags TEXT);
  CREATE TABLE IF NOT EXISTS manual_transactions (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL, name TEXT NOT NULL, amount REAL NOT NULL, account TEXT NOT NULL,
    category TEXT, type TEXT NOT NULL DEFAULT 'regular', note TEXT, tags TEXT, recurring TEXT
  );
  CREATE TABLE IF NOT EXISTS manual_accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, subtype TEXT, balance REAL NOT NULL DEFAULT 0, updated_at TEXT);
  -- One balance per account per day, written on every sync / manual update; Plaid only reports current balances.
  CREATE TABLE IF NOT EXISTS balances (account_id TEXT, date TEXT, balance REAL, PRIMARY KEY (account_id, date));
  -- Payments the app adds by itself as manual transactions, e.g. a purchase spread over 12 months. count NULL = no end.
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, amount REAL NOT NULL, account TEXT NOT NULL, category TEXT, tags TEXT,
    type TEXT NOT NULL DEFAULT 'regular', note TEXT, frequency TEXT NOT NULL DEFAULT 'monthly', start_date TEXT NOT NULL,
    count INTEGER, generated INTEGER NOT NULL DEFAULT 0
  );
`);
// Rules match the name by default; field lets them match the note, recurring or (exactly) the category instead.
const addColumn = (table, column, type) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
};
addColumn('rules', 'field', "TEXT NOT NULL DEFAULT 'name'");
addColumn('rules', 'recurring', 'TEXT'); // a rule can also put matches into a recurring charge
addColumn('edits', 'amount', 'REAL');
addColumn('manual_accounts', 'alias', 'TEXT'); // the account's name in the Copilot export, to keep its history
addColumn('manual_transactions', 'schedule_id', 'INTEGER');
// 0 = budgeting-only payments (a laptop spread over 12 months) that must not move the account's balance.
addColumn('schedules', 'affects_balance', 'INTEGER NOT NULL DEFAULT 1');
// Set = a bill you pay yourself (PayPal Credit installments): no rows are added, it claims bank debits whose name
// contains this text and alerts until each month's payment shows up.
addColumn('schedules', 'match', 'TEXT');
// From /item/get on each sync: when Plaid last reached the bank, and the login error if any (ITEM_LOGIN_REQUIRED).
addColumn('items', 'last_update', 'TEXT');
// Health checks the user acted on: 'working' (still counts, shown as in progress) or 'ignored' (out of the score).
// User settings as JSON values: 'idle_cash' = { name, apy } (where idle checking money should go, for the health
// check), 'categories' = { [category]: [emoji, group] } (custom categories and overrides of the built-in look).
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
// 'tag_renames' = { old: new } ('' deletes the tag), applied when the ledger is built.
const SETTINGS = { idle_cash: { name: 'a high-yield savings account', apy: 0.04 }, categories: {}, tag_renames: {} };
const settings = () => ({ ...SETTINGS, ...Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, JSON.parse(r.value)])) });
db.exec('CREATE TABLE IF NOT EXISTS health_state (id TEXT PRIMARY KEY, state TEXT NOT NULL, at TEXT NOT NULL)');
addColumn('items', 'error', 'TEXT');
// Market-priced manual holdings: asset 'BTC' (quantity in BTC) or 'XAU' (quantity in grams of gold).
addColumn('manual_accounts', 'asset', 'TEXT');
addColumn('manual_accounts', 'quantity', 'REAL');
db.exec('CREATE TABLE IF NOT EXISTS prices (asset TEXT, date TEXT, price REAL, PRIMARY KEY (asset, date))');
// Investment positions: Plaid's (replaced on every sync) and the ones the user enters on manual accounts (manual = 1).
db.exec(`CREATE TABLE IF NOT EXISTS holdings (account_id TEXT, symbol TEXT, name TEXT, type TEXT, quantity REAL, cost_basis REAL,
  price REAL, value REAL, as_of TEXT, manual INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, symbol))`);
// Accounts left out of net worth and investment totals (e.g. unvested RSUs: shown, not owned yet).
db.exec('CREATE TABLE IF NOT EXISTS excluded_accounts (account_id TEXT PRIMARY KEY)');
// Copilot-export accounts the user closed: off the "Not linked yet" list; their history stays in net worth.
db.exec("CREATE TABLE IF NOT EXISTS closed_exports (name TEXT NOT NULL, mask TEXT NOT NULL DEFAULT '', PRIMARY KEY (name, mask))");
// Parts of a transaction split in the app (see buildLedger). Each part's category/tags/note live in edits.
db.exec('CREATE TABLE IF NOT EXISTS splits (parent_id TEXT, idx INTEGER, name TEXT, amount REAL NOT NULL, PRIMARY KEY (parent_id, idx))');
// Alerts the user dismissed or was already notified about, by alert id.
db.exec('CREATE TABLE IF NOT EXISTS alert_state (id TEXT PRIMARY KEY, notified_at TEXT, dismissed_at TEXT)');
// Passkeys (WebAuthn). Once one exists, every /api call needs an unlocked session.
db.exec('CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, public_key TEXT NOT NULL, alg INTEGER NOT NULL, counter INTEGER NOT NULL DEFAULT 0, created_at TEXT)');
// Credit card statement details from Plaid Liabilities (Amex, Robinhood card; Ally doesn't offer it).
db.exec(`CREATE TABLE IF NOT EXISTS card_details (account_id TEXT PRIMARY KEY, due_date TEXT, minimum REAL, statement_balance REAL,
  statement_date TEXT, last_payment REAL, last_payment_date TEXT, overdue INTEGER, apr REAL)`);
// Savings goals: a monthly target filled by new money arriving in the listed accounts (JSON array of account ids).
db.exec('CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY, name TEXT NOT NULL, monthly REAL NOT NULL, accounts TEXT NOT NULL)');
// Optional cash cushion to rebuild first (e.g. an emergency fund back to its target before buying stocks again), from the accounts' cash.
addColumn('goals', 'cash_target', 'REAL');
// Monthly budget per category (one amount for every month, like Copilot's base budget).
db.exec('CREATE TABLE IF NOT EXISTS budgets (category TEXT PRIMARY KEY, amount REAL NOT NULL)');
// Investment activity from Plaid: deposits, buys, sells, dividends, interest, fees, RSU vests. amount follows Plaid:
// positive = cash out of the account (a buy, a withdrawal), negative = cash in (a deposit, a dividend, a sale).
db.exec(`CREATE TABLE IF NOT EXISTS inv_transactions (id TEXT PRIMARY KEY, account_id TEXT, date TEXT, name TEXT, type TEXT,
  subtype TEXT, symbol TEXT, quantity REAL, price REAL, amount REAL, fees REAL)`);
// Latest quote per symbol; prev is the previous close (the price 24h ago for crypto), for "today" changes.
db.exec('CREATE TABLE IF NOT EXISTS quotes (symbol TEXT PRIMARY KEY, name TEXT, type TEXT, price REAL, prev REAL, updated_at TEXT)');

const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
const snapshot = db.prepare('INSERT OR REPLACE INTO balances VALUES (?, ?, ?)');

// Spot prices from Coinbase's public API (no key). PAXG is backed 1:1 by a troy ounce of gold, so it stands in for
// gold spot; dividing by grams per troy ounce gives a per-gram price.
const ASSETS = { BTC: { pair: 'BTC-USD', unitsPerQuote: 1 }, XAU: { pair: 'PAXG-USD', unitsPerQuote: 31.1034768 } };
async function refreshPrices() {
  for (const [asset, { pair, unitsPerQuote }] of Object.entries(ASSETS)) {
    try {
      const res = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`);
      const price = Number((await res.json())?.data?.amount) / unitsPerQuote;
      if (!res.ok || !(price > 0)) throw new Error(`HTTP ${res.status}`);
      db.prepare('INSERT OR REPLACE INTO prices VALUES (?, ?, ?)').run(asset, today(), price);
    } catch (e) {
      console.error(`price ${asset}: ${e.message}`); // offline or API hiccup: keep using the last stored price
    }
  }
}
// Live quotes, no API keys: Coinbase Exchange for crypto, Yahoo Finance's chart endpoint for stocks, ETFs and funds
// (mutual funds only move once a day, after the close). Crypto gets its own key so "CC" (Canton) isn't a stock ticker.
const quoteKey = (h) => (h.type === 'cryptocurrency' ? `crypto:${h.symbol}` : h.symbol);
const YAHOO_TYPES = { EQUITY: 'equity', ETF: 'etf', MUTUALFUND: 'mutual fund', CRYPTOCURRENCY: 'cryptocurrency' };
async function fetchQuote(key) {
  if (key.startsWith('crypto:')) {
    const res = await fetch(`https://api.exchange.coinbase.com/products/${encodeURIComponent(key.slice(7))}-USD/stats`);
    const s = await res.json();
    if (!res.ok) throw new Error(s.message ?? `HTTP ${res.status}`);
    return { price: Number(s.last), prev: Number(s.open), name: key.slice(7), type: 'cryptocurrency' };
  }
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(key)}?range=5d&interval=1d`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const r = (await res.json())?.chart?.result?.[0];
  if (!res.ok || !r) throw new Error(`unknown symbol (HTTP ${res.status})`);
  const closes = (r.indicators?.quote?.[0]?.close ?? []).filter((c) => c != null);
  return { price: r.meta.regularMarketPrice, prev: closes.at(-2) ?? r.meta.chartPreviousClose, name: r.meta.longName ?? r.meta.shortName ?? key,
    type: YAHOO_TYPES[r.meta.instrumentType] ?? 'other' };
}
// Price history for one position's chart, from Yahoo's chart endpoint (crypto as SYM-USD). Cached 5 minutes.
const HISTORY = { '1D': ['1d', '5m'], '1W': ['5d', '30m'], '1M': ['1mo', '1h'], '3M': ['3mo', '1d'], YTD: ['ytd', '1d'], '1Y': ['1y', '1d'], ALL: ['max', '1wk'] };
const historyCache = new Map();
async function priceHistory(_, { symbol = '', type = '', range = '1M' }) {
  if (!/^[A-Za-z0-9.^=-]{1,15}$/.test(symbol) || !HISTORY[range]) throw Object.assign(new Error('bad symbol or range'), { status: 400 });
  // Gold grams chart COMEX gold futures (USD per troy ounce), scaled to grams.
  const key = type === 'gold' ? 'GC=F' : type === 'cryptocurrency' ? `${symbol}-USD` : symbol;
  const per = type === 'gold' ? 1 / ASSETS.XAU.unitsPerQuote : 1;
  const hit = historyCache.get(`${key} ${range}`);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
  const [r, interval] = HISTORY[range];
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(key)}?range=${r}&interval=${interval}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const out = (await res.json())?.chart?.result?.[0];
  if (!res.ok || !out) throw Object.assign(new Error('no price history for this symbol'), { status: 404 });
  const close = out.indicators?.quote?.[0]?.close ?? [];
  const data = {
    points: (out.timestamp ?? []).map((t, i) => ({ t: t * 1000, price: close[i] * per })).filter((p) => p.price != null && p.price > 0),
    prevClose: out.meta.chartPreviousClose ? out.meta.chartPreviousClose * per : null, // the close before the range, so 1D compares to yesterday
    name: out.meta.longName ?? out.meta.shortName ?? symbol,
  };
  historyCache.set(`${key} ${range}`, { at: Date.now(), data });
  return data;
}
// Daily USD rates for every non-USD currency in the transactions (prices: asset = code, price = USD per unit), from
// Yahoo's <CODE>=X pair, which is units per USD. Five years covers all history.
async function syncFx() {
  const put = db.prepare('INSERT OR REPLACE INTO prices (asset, date, price) VALUES (?, ?, ?)');
  for (const { currency } of db.prepare("SELECT DISTINCT currency FROM transactions WHERE coalesce(currency, 'USD') != 'USD'").all()) {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(currency)}=X?range=5y&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const r = (await res.json())?.chart?.result?.[0];
      const close = r?.indicators?.quote?.[0]?.close ?? [];
      db.exec('BEGIN');
      (r?.timestamp ?? []).forEach((t, i) => close[i] > 0 && put.run(currency, new Date(t * 1000).toISOString().slice(0, 10), 1 / close[i]));
      db.exec('COMMIT');
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      console.error(`fx ${currency}: ${e.message}`);
    }
  }
}
const putQuote = db.prepare('INSERT OR REPLACE INTO quotes VALUES (?, ?, ?, ?, ?, ?)');
async function refreshQuotes() {
  const keys = new Set(db.prepare("SELECT symbol, type FROM holdings WHERE type != 'cash'").all().map(quoteKey));
  for (const key of keys) {
    try {
      const q = await fetchQuote(key);
      if (!(q.price > 0)) throw new Error('no price');
      putQuote.run(key, q.name, q.type, q.price, q.prev || null, new Date().toISOString());
    } catch (e) {
      console.error(`quote ${key}: ${e.message}`); // keep the last quote, or Plaid's own price
    }
  }
}
const round2 = (n) => Math.round(n * 100) / 100;
// Every position at its latest quote. Cash, and symbols no source knows (Plaid's own price then), stay as they are.
function liveHoldings() {
  const quotes = new Map(db.prepare('SELECT * FROM quotes').all().map((q) => [q.symbol, q]));
  return db.prepare('SELECT * FROM holdings').all().map((h) => {
    const q = h.type === 'cash' ? null : quotes.get(quoteKey(h));
    const price = q?.price ?? h.price;
    return { ...h, live: price, prev: q?.prev ?? null, quoted_at: q?.updated_at ?? null,
      liveValue: round2(h.type === 'cash' ? (h.value ?? h.quantity) : h.quantity * price) };
  });
}

const lastPrice = (asset) => db.prepare('SELECT price FROM prices WHERE asset = ? ORDER BY date DESC LIMIT 1').get(asset)?.price;

// Plaid is plain JSON over HTTPS; every request carries the secret, so never log bodies.
async function plaid(path, body = {}) {
  if (demo) throw Object.assign(new Error('This is the demo: connecting banks needs your own Plaid keys in .env'), { status: 400 });
  if (!plaidKeys) throw Object.assign(new Error('Connecting banks needs Plaid keys: copy .env.example to .env, add PLAID_CLIENT_ID and PLAID_SECRET (free sandbox keys at dashboard.plaid.com), then restart. Manual accounts work without them.'), { status: 400 });
  const res = await fetch(`https://${PLAID_ENV}.plaid.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, ...body }),
  });
  const data = await res.json();
  if (data.error_code === 'INVALID_API_KEYS') {
    throw Object.assign(new Error(`Plaid didn't accept your keys. Check PLAID_CLIENT_ID and PLAID_SECRET in .env, and that PLAID_ENV (${PLAID_ENV}) is the environment those keys are for, then restart.`), { code: data.error_code, status: 400 });
  }
  if (!res.ok) throw Object.assign(new Error(`${path}: ${data.error_code} ${data.error_message}`), { code: data.error_code });
  return data;
}

// days_requested is fixed when an Item is created, so ask for the max (730) up front.
// Only transactions is required; investments/liabilities are optional so Link doesn't hide banks lacking them.
const linkToken = () => plaid('/link/token/create', {
  user: { client_user_id: 'me' },
  client_name: 'Moneta',
  products: ['transactions'],
  optional_products: ['investments', 'liabilities'],
  transactions: { days_requested: 730 },
  country_codes: ['US'],
  language: 'en',
});

async function addItem(publicToken, institution) {
  const { access_token, item_id } = await plaid('/item/public_token/exchange', { public_token: publicToken });
  db.prepare('INSERT INTO items (item_id, access_token, institution) VALUES (?, ?, ?)').run(item_id, access_token, institution ?? null);
  return item_id;
}

async function syncItem({ item_id, access_token, cursor }) {
  // /accounts/get returns cached balances for free; /accounts/balance/get is billed per call.
  const { accounts } = await plaid('/accounts/get', { access_token });
  const now = new Date().toISOString();
  const upAccount = db.prepare('INSERT OR REPLACE INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const a of accounts) {
    upAccount.run(a.account_id, item_id, a.name, a.mask ?? null, a.type, a.subtype ?? null,
      a.balances.current ?? null, a.balances.iso_currency_code ?? null, now);
    if (a.balances.current != null) snapshot.run(a.account_id, today(), a.balances.current);
  }
  const info = await plaid('/item/get', { access_token }).catch((e) => console.error(`item ${item_id}: ${e.message}`));
  if (info) {
    const times = [info.status?.transactions?.last_successful_update, info.status?.investments?.last_successful_update].filter(Boolean).sort();
    db.prepare('UPDATE items SET last_update = ?, error = ? WHERE item_id = ?').run(times.at(-1) ?? null, info.item?.error?.error_code ?? null, item_id);
  }
  if (accounts.some((a) => a.type === 'credit')) {
    await syncCards(access_token).catch((e) => e.code !== 'PRODUCTS_NOT_SUPPORTED' && console.error(`liabilities ${item_id}: ${e.message}`));
  }
  if (accounts.some((a) => a.type === 'investment')) {
    await syncHoldings(item_id, access_token).catch((e) => console.error(`holdings ${item_id}: ${e.message}`));
    await syncInvestmentTransactions(item_id, access_token).catch((e) => console.error(`investment activity ${item_id}: ${e.message}`));
  }

  // Page until has_more is false; if Plaid mutates data mid-pagination, drop the batch and restart from the saved cursor.
  let added = [], modified = [], removed = [], next = cursor, page;
  for (;;) {
    try {
      page = await plaid('/transactions/sync', { access_token, cursor: next || undefined, count: 500 });
    } catch (e) {
      if (e.code !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') throw e;
      added = []; modified = []; removed = []; next = cursor;
      continue;
    }
    added.push(...page.added); modified.push(...page.modified); removed.push(...page.removed);
    next = page.next_cursor;
    if (!page.has_more) break;
  }

  // Plaid sign convention kept as-is (positive = money out), same as Copilot.
  const upTx = db.prepare('INSERT OR REPLACE INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const delTx = db.prepare('DELETE FROM transactions WHERE transaction_id = ?');
  db.exec('BEGIN');
  try {
    for (const t of [...added, ...modified]) {
      upTx.run(t.transaction_id, t.account_id, t.date, t.name, t.merchant_name ?? null, t.amount,
        t.iso_currency_code ?? null, t.personal_finance_category?.primary ?? null, t.pending ? 1 : 0);
    }
    for (const t of removed) delTx.run(t.transaction_id);
    db.prepare('UPDATE items SET cursor = ? WHERE item_id = ?').run(next, item_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { added: added.length, modified: modified.length, removed: removed.length, status: page.transactions_update_status };
}

async function syncHoldings(item_id, access_token) {
  const { holdings, securities } = await plaid('/investments/holdings/get', { access_token });
  const sec = new Map(securities.map((s) => [s.security_id, s]));
  const put = db.prepare('INSERT OR REPLACE INTO holdings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM holdings WHERE manual = 0 AND account_id IN (SELECT account_id FROM accounts WHERE item_id = ?)').run(item_id);
    for (const h of holdings) {
      const s = sec.get(h.security_id) ?? {};
      put.run(h.account_id, s.ticker_symbol ?? s.name ?? h.security_id, s.name ?? null, s.type ?? 'other', h.quantity, h.cost_basis ?? null,
        h.institution_price, h.institution_value, h.institution_price_as_of ?? null);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

async function syncCards(access_token) {
  const { liabilities } = await plaid('/liabilities/get', { access_token });
  const put = db.prepare('INSERT OR REPLACE INTO card_details VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const c of liabilities.credit ?? []) {
    put.run(c.account_id, c.next_payment_due_date ?? null, c.minimum_payment_amount ?? null, c.last_statement_balance ?? null,
      c.last_statement_issue_date ?? null, c.last_payment_amount ?? null, c.last_payment_date ?? null, c.is_overdue ? 1 : 0,
      c.aprs?.find((a) => a.apr_type === 'purchase_apr')?.apr_percentage ?? null);
  }
}

// Plaid keeps 24 months of investment activity. The first sync takes all of it, later ones the last 60 days (enough
// to pick up late corrections); rows are upserted by id.
async function syncInvestmentTransactions(item_id, access_token) {
  const { has } = db.prepare('SELECT count(*) AS has FROM inv_transactions WHERE account_id IN (SELECT account_id FROM accounts WHERE item_id = ?)').get(item_id);
  const end = today();
  const start = new Date(Date.parse(end) - (has ? 60 : 730) * 86400000).toISOString().slice(0, 10);
  const put = db.prepare('INSERT OR REPLACE INTO inv_transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (let offset = 0, total = Infinity; offset < total;) {
    const page = await plaid('/investments/transactions/get', { access_token, start_date: start, end_date: end, options: { count: 500, offset } });
    const sec = new Map(page.securities.map((x) => [x.security_id, x]));
    for (const t of page.investment_transactions) {
      const x = sec.get(t.security_id);
      put.run(t.investment_transaction_id, t.account_id, t.date, t.name, t.type, t.subtype, x ? x.ticker_symbol ?? x.name : null,
        t.quantity, t.price, t.amount, t.fees ?? null);
    }
    total = page.total_investment_transactions;
    offset += page.investment_transactions.length;
    if (!page.investment_transactions.length) break;
  }
}

// Positions on manual accounts (e.g. an HSA's funds). Quantity 0 removes one. The quote also validates the symbol.
async function saveHolding({ account_id, symbol, quantity, cost_basis }) {
  if (!String(account_id).startsWith('manual:')) throw new Error('positions can only be edited on manual accounts');
  requireFields({ symbol }, ['symbol']);
  const sym = symbol.trim().toUpperCase();
  if (!(Number(quantity) > 0)) {
    db.prepare('DELETE FROM holdings WHERE account_id = ? AND symbol = ?').run(account_id, sym);
    return { ok: true };
  }
  const q = await fetchQuote(sym);
  putQuote.run(sym, q.name, q.type, q.price, q.prev || null, new Date().toISOString());
  db.prepare('INSERT OR REPLACE INTO holdings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(account_id, sym, q.name, q.type, Number(quantity),
    cost_basis === '' || cost_basis == null ? null : Number(cost_basis), q.price, round2(Number(quantity) * q.price), today());
  return { ok: true };
}

async function syncAll() {
  const results = [];
  for (const item of db.prepare('SELECT * FROM items').all()) {
    // One bank failing (a login that needs fixing) shouldn't stop the others; the error shows on its accounts.
    try {
      results.push({ institution: item.institution, ...(await syncItem(item)) });
    } catch (e) {
      db.prepare('UPDATE items SET error = ? WHERE item_id = ?').run(e.code ?? 'SYNC_FAILED', item.item_id);
      results.push({ institution: item.institution, error: e.message });
    }
  }
  await syncFx();
  await refreshQuotes();
  notifyNewAlerts();
  return results;
}

// Plaid accounts plus manual ones (cash, gold, Apple Card) in one list. Accounts with positions are valued live.
const listAccounts = () => withHoldings([
  ...db.prepare(`SELECT a.account_id, i.institution, a.name, a.mask, a.type, a.subtype, a.balance, a.updated_at, 0 AS manual,
      i.last_update AS bank_update, i.error AS item_error,
      c.due_date, c.minimum, c.statement_balance, c.statement_date, c.last_payment, c.last_payment_date, c.overdue, c.apr
    FROM accounts a JOIN items i USING (item_id) LEFT JOIN card_details c USING (account_id)`).all(),
  ...db.prepare(`SELECT 'manual:' || id AS account_id, 'Manual' AS institution, name, alias, NULL AS mask, type, subtype, balance, updated_at, asset, quantity, 1 AS manual
    FROM manual_accounts`).all().map(manualBalance),
]).sort((a, b) => `${a.institution} ${a.name}`.localeCompare(`${b.institution} ${b.name}`));

// Plaid's balance already holds the positions at Plaid's price, so move it by the live difference; a manual account
// with positions is worth exactly its positions.
function withHoldings(accounts) {
  const byAccount = Map.groupBy(liveHoldings(), (h) => h.account_id);
  const excluded = new Set(db.prepare('SELECT account_id FROM excluded_accounts').all().map((r) => r.account_id));
  return accounts.map((a) => ({ ...a, excluded: excluded.has(a.account_id) })).map((a) => {
    const list = byAccount.get(a.account_id);
    if (!list) return a;
    const live = list.reduce((s, h) => s + h.liveValue, 0);
    const balance = round2(a.manual ? live : a.balance - list.reduce((s, h) => s + (h.value ?? 0), 0) + live);
    snapshot.run(a.account_id, today(), balance);
    return { ...a, balance };
  });
}

// A manual account's balance is what the user last entered plus every later manual transaction on it
// (scheduled ones included), so Apple Savings grows with its interest and Apple Card follows its charges.
const LIABILITIES = new Set(['credit', 'loan']);
function manualBalance(a) {
  const price = a.asset && a.quantity != null ? lastPrice(a.asset) : null;
  if (price) {
    const balance = Math.round(a.quantity * price * 100) / 100;
    snapshot.run(a.account_id, today(), balance);
    return { ...a, balance, price };
  }
  // updated_at is a UTC timestamp; compare in local days like transaction dates.
  const since = a.updated_at ? new Date(a.updated_at).toLocaleDateString('en-CA') : '';
  const { total } = db.prepare(`SELECT coalesce(sum(m.amount), 0) AS total FROM manual_transactions m
    LEFT JOIN schedules s ON s.id = m.schedule_id
    WHERE m.account = ? AND m.date > ? AND coalesce(s.affects_balance, 1) = 1`).get(a.name, since);
  const balance = Math.round((a.balance + (LIABILITIES.has(a.type) ? total : -total)) * 100) / 100;
  snapshot.run(a.account_id, today(), balance);
  return { ...a, balance };
}

// Balance history: Copilot's export (matched by mask or name, like the ledger) overlaid with our own snapshots.
const copilotRecurringsFile = fileURLToPath(new URL('copilot-export/recurrings.json', import.meta.url));
const copilotBalancesFile = fileURLToPath(new URL('copilot-export/balances.json', import.meta.url));
const readExportedBalances = () => (existsSync(copilotBalancesFile) ? JSON.parse(readFileSync(copilotBalancesFile, 'utf8')) : []);
const exportName = (c) => c.name.replace(/\u00a0/g, ' ');
// Match by mask (or name when there's no mask), or the manual account's alias. Banks sometimes renumber an account
// (one 401k had different last digits in Copilot and in Plaid), so fall back to a name that's unique in the export.
const exportedFor = (a, exported) => exported.find((c) => [a.mask || a.name, a.alias].includes(c.mask || exportName(c)))
  ?? (() => {
    const same = exported.filter((c) => exportName(c).toLowerCase() === a.name.toLowerCase());
    return same.length === 1 ? same[0] : undefined;
  })();
function accountPoints(a, exported) {
  const byDate = new Map((exportedFor(a, exported)?.points ?? []).map((p) => [p.date, p.balance]));
  for (const p of db.prepare('SELECT date, balance FROM balances WHERE account_id = ?').all(a.account_id)) byDate.set(p.date, p.balance);
  return byDate;
}

function balanceHistory({ account }) {
  const a = listAccounts().find((x) => x.account_id === account);
  if (!a) throw new Error('unknown account');
  return [...accountPoints(a, readExportedBalances())].sort((x, y) => x[0].localeCompare(y[0])).map(([date, balance]) => ({ date, balance }));
}

// Daily assets and debt across every account: linked and manual ones from their own history, accounts not linked
// yet from the Copilot export (held at their last exported balance until they're linked). Each account carries its
// last known balance forward over days without a reading.
function netWorthHistory() {
  const exported = readExportedBalances();
  const all = listAccounts();
  const used = new Set(all.map((a) => exportedFor(a, exported)));
  const accounts = all.filter((a) => !a.excluded);
  const series = [
    ...accounts.map((a) => ({ liability: LIABILITIES.has(a.type), points: accountPoints(a, exported) })),
    ...exported.filter((c) => !used.has(c)).map((c) => ({
      liability: LIABILITIES.has(c.type), points: new Map(c.points.map((p) => [p.date, p.balance])),
    })),
  ];
  const end = today();
  const start = series.flatMap((s) => [...s.points.keys()]).reduce((min, d) => (d < min ? d : min), end);
  const last = series.map(() => 0);
  const out = [];
  for (let d = start; d <= end; d = new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10)) {
    let assets = 0, debt = 0;
    series.forEach((s, i) => {
      if (s.points.has(d)) last[i] = s.points.get(d);
      if (s.liability) debt += last[i]; else assets += last[i];
    });
    out.push({ date: d, assets: Math.round(assets * 100) / 100, debt: Math.round(debt * 100) / 100 });
  }
  // Skip the first days when only a stray credit-card balance existed (assets 0), which makes % changes meaningless.
  const firstReal = out.findIndex((p) => p.assets > 0);
  return firstReal > 0 ? out.slice(firstReal) : out;
}

// Accounts in the Copilot export that aren't linked or manual yet, with their last known balance.
function unlinkedAccounts() {
  const exported = readExportedBalances();
  const used = new Set(listAccounts().map((a) => exportedFor(a, exported)));
  const closed = new Set(db.prepare('SELECT name, mask FROM closed_exports').all().map((c) => `${c.name}|${c.mask}`));
  return exported
    .filter((c) => !used.has(c) && c.points.length && !closed.has(`${exportName(c)}|${c.mask ?? ''}`))
    .map(({ mask, type, institution, points, ...c }) => ({ name: exportName(c), mask, type, institution, ...points.at(-1) }));
}

const EDIT_FIELDS = ['name', 'amount', 'category', 'type', 'excluded', 'note', 'tags', 'recurring', 'reviewed'];
function saveEdit(body) {
  if (!body.id) throw new Error('id required');
  const row = db.prepare('SELECT * FROM edits WHERE id = ?').get(body.id) ?? {};
  for (const f of EDIT_FIELDS) {
    if (!(f in body)) continue;
    // Blank name/category means "back to the default", not an empty value.
    const v = body[f] === '' && (f === 'name' || f === 'category') ? null : f === 'amount' && body[f] != null ? Number(body[f]) : body[f];
    if (f === 'amount' && v != null && !Number.isFinite(v)) throw new Error('amount must be a number');
    row[f] = f === 'tags' ? JSON.stringify(v) : typeof v === 'boolean' ? Number(v) : v;
  }
  db.prepare(`INSERT OR REPLACE INTO edits (id, ${EDIT_FIELDS}) VALUES (?, ${EDIT_FIELDS.map(() => '?')})`)
    .run(body.id, ...EDIT_FIELDS.map((f) => row[f] ?? null));
  if (body.rule?.match) saveRule(body.rule);
  return { ok: true };
}

const RULE_FIELDS = new Set(['name', 'note', 'recurring', 'category']);
// "Always do this": a rule applies its category/tags to every past and future transaction that matches.
function saveRule({ field = 'name', match, category = null, tags = [], recurring = null }) {
  if (!RULE_FIELDS.has(field)) throw new Error(`field must be one of ${[...RULE_FIELDS]}`);
  requireFields({ match }, ['match']);
  db.prepare('DELETE FROM rules WHERE field = ? AND match = ?').run(field, match.toLowerCase());
  db.prepare('INSERT INTO rules (field, match, category, tags, recurring) VALUES (?, ?, ?, ?, ?)')
    .run(field, match.toLowerCase(), field === 'category' ? null : category || null, JSON.stringify(tags), field === 'category' ? null : recurring || null);
  return { ok: true };
}

function saveSchedule(b) {
  requireFields(b, ['name', 'amount', 'account', 'start_date']);
  if (b.count != null && b.count !== '' && !(Number(b.count) >= 1)) throw new Error('count must be at least 1');
  const vals = [b.name, Number(b.amount), b.account, b.category || null, JSON.stringify(b.tags ?? []), b.type || 'regular',
    b.note || null, b.frequency || 'monthly', b.start_date, b.count == null || b.count === '' ? null : Number(b.count),
    b.affects_balance === false || b.affects_balance === 0 ? 0 : 1, b.match || null];
  if (b.id) db.prepare('UPDATE schedules SET name=?, amount=?, account=?, category=?, tags=?, type=?, note=?, frequency=?, start_date=?, count=?, affects_balance=?, match=? WHERE id=?').run(...vals, b.id);
  else db.prepare('INSERT INTO schedules (name, amount, account, category, tags, type, note, frequency, start_date, count, affects_balance, match) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals);
  materializeSchedules();
  return { ok: true };
}

// Adds every due-but-missing scheduled payment as a manual transaction. Called before any read of the ledger.
function materializeSchedules() {
  const insert = db.prepare(`INSERT INTO manual_transactions (date, name, amount, account, category, type, note, tags, recurring, schedule_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const s of db.prepare('SELECT * FROM schedules WHERE match IS NULL').all()) {
    const due = dueOccurrences(s, today());
    if (!due.length) continue;
    db.exec('BEGIN');
    try {
      for (const o of due) insert.run(o.date, s.name, s.amount, s.account, s.category, s.type, s.note, s.tags, s.name, s.id);
      db.prepare('UPDATE schedules SET generated = ? WHERE id = ?').run(due.at(-1).index + 1, s.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

const ledgerNow = () => (materializeSchedules(), loadLedger(db));
const recurringsNow = (rows) => buildRecurrings(rows, today(),
  existsSync(copilotRecurringsFile) ? JSON.parse(readFileSync(copilotRecurringsFile, 'utf8')) : [],
  db.prepare('SELECT * FROM schedules').all());

// Replace a transaction's split. Parts must add up to the original amount, to the cent.
function saveSplit({ id, parts = [] }) {
  requireFields({ id }, ['id']);
  if (parts.length < 2) throw new Error('a split needs at least two parts');
  const rows = ledgerNow().rows.filter((r) => r.id === id || r.splitOf === id);
  if (!rows.length) throw new Error('unknown transaction');
  const cents = (n) => Math.round(Number(n) * 100);
  const total = rows.reduce((s, r) => s + cents(r.amount), 0);
  if (parts.some((p) => !Number.isFinite(Number(p.amount)) || cents(p.amount) === 0)) throw new Error('every part needs an amount');
  const sum = parts.reduce((s, p) => s + cents(p.amount), 0);
  if (sum !== total) throw new Error(`parts add up to ${(sum / 100).toFixed(2)}, the transaction is ${(total / 100).toFixed(2)}`);
  db.exec('BEGIN');
  try {
    clearSplit(id);
    parts.forEach((p, i) => {
      db.prepare('INSERT INTO splits VALUES (?, ?, ?, ?)').run(id, i, p.name?.trim() || null, cents(p.amount) / 100);
      // No tags given: leave the part to the rules (Groceries -> Essential) instead of pinning an empty list.
      saveEdit({ id: `${id}#${i}`, category: p.category ?? '', reviewed: true, ...(p.tags?.length && { tags: p.tags }) });
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true };
}
function clearSplit(id) {
  db.prepare('DELETE FROM splits WHERE parent_id = ?').run(id);
  db.prepare("DELETE FROM edits WHERE substr(id, 1, length(?) + 1) = ? || '#'").run(id, id);
}

function currentHealth() {
  const accounts = listAccounts().filter((a) => !a.excluded);
  const counted = new Set(accounts.map((a) => a.account_id));
  const bank = accounts.filter((a) => a.type === 'depository' && !/hsa/i.test(a.name));
  const brokerageCash = liveHoldings().filter((h) => h.type === 'cash' && counted.has(h.account_id)).reduce((s, h) => s + h.liveValue, 0);
  const state = new Map(db.prepare('SELECT id, state FROM health_state').all().map((r) => [r.id, r.state]));
  return buildHealth({
    rows: ledgerNow().rows, today: today(),
    budget: db.prepare('SELECT coalesce(sum(amount), 0) AS t FROM budgets').get().t,
    saveTarget: db.prepare('SELECT coalesce(sum(monthly), 0) AS t FROM goals').get().t,
    cash: bank.reduce((s, a) => s + (a.balance ?? 0), 0) + brokerageCash,
    checking: bank.filter((a) => a.subtype === 'checking').reduce((s, a) => s + (a.balance ?? 0), 0),
    cards: db.prepare('SELECT c.*, a.name FROM card_details c JOIN accounts a USING (account_id)').all(),
    cashApy: settings().idle_cash.apy,
  }).map((c) => ({ ...c, state: state.get(c.id) ?? null }));
}

function currentAlerts() {
  const rows = ledgerNow().rows;
  const dismissed = new Set(db.prepare('SELECT id FROM alert_state WHERE dismissed_at IS NOT NULL').all().map((r) => r.id));
  const cards = db.prepare(`SELECT c.*, a.name, (SELECT balance FROM balances b WHERE b.account_id = c.account_id ORDER BY date DESC LIMIT 1) AS balance
    FROM card_details c JOIN accounts a USING (account_id)`).all();
  return buildAlerts({ rows, recurrings: recurringsNow(rows), budgets: db.prepare('SELECT * FROM budgets').all(), cards, today: today() })
    .filter((a) => !dismissed.has(a.id));
}

// macOS notification for each alert not seen before (after a sync). Text goes in as osascript arguments, never
// spliced into the script, so bank strings can't inject AppleScript.
function notifyNewAlerts() {
  if (demo) return;
  if (process.platform !== 'darwin') return;
  const seen = new Set(db.prepare('SELECT id FROM alert_state').all().map((r) => r.id));
  const fresh = currentAlerts().filter((a) => !seen.has(a.id));
  const mark = db.prepare('INSERT OR IGNORE INTO alert_state (id, notified_at) VALUES (?, ?)');
  for (const a of fresh) mark.run(a.id, new Date().toISOString());
  if (!fresh.length) return;
  // No amounts or merchants: notifications can show on the lock screen, where anyone could read them.
  const shown = [{ title: fresh.length === 1 ? '1 new alert' : `${fresh.length} new alerts`, detail: 'Open Moneta to see them' }];
  for (const a of shown) {
    execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title "Moneta" subtitle (item 1 of argv)', '-e', 'end run', a.title, a.detail],
      (e) => e && console.error(`notify: ${e.message}`));
  }
}

const manualId = (id) => Number(String(id).replace(/^manual:/, ''));
function requireFields(b, fields) {
  for (const f of fields) if (b[f] == null || b[f] === '') throw new Error(`${f} is required`);
  if ('amount' in b && !Number.isFinite(Number(b.amount))) throw new Error('amount must be a number');
}

function saveManualTransaction(b) {
  requireFields(b, ['date', 'name', 'amount', 'account']);
  const vals = [b.date, b.name, Number(b.amount), b.account, b.category || null, b.type || 'regular', b.note || null,
    JSON.stringify(b.tags ?? []), b.recurring || null];
  if (b.id) db.prepare('UPDATE manual_transactions SET date=?, name=?, amount=?, account=?, category=?, type=?, note=?, tags=?, recurring=? WHERE id=?').run(...vals, manualId(b.id));
  else db.prepare('INSERT INTO manual_transactions (date, name, amount, account, category, type, note, tags, recurring) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals);
  return { ok: true };
}

function saveManualAccount(b) {
  const asset = b.asset || null;
  if (asset && !ASSETS[asset]) throw new Error(`asset must be one of ${Object.keys(ASSETS)}`);
  if (asset && !(Number(b.quantity) > 0)) throw new Error('quantity must be a positive number');
  requireFields(b, asset ? ['name', 'type'] : ['name', 'type', 'balance']);
  const old = b.id ? db.prepare('SELECT * FROM manual_accounts WHERE id = ?').get(manualId(b.id)) : null;
  const vals = [b.name, b.type, b.subtype || null, Number(b.balance ?? 0), new Date().toISOString(), b.alias ?? old?.alias ?? null,
    asset, asset ? Number(b.quantity) : null];
  const id = b.id
    ? (db.prepare('UPDATE manual_accounts SET name=?, type=?, subtype=?, balance=?, updated_at=?, alias=?, asset=?, quantity=? WHERE id=?').run(...vals, manualId(b.id)), manualId(b.id))
    : db.prepare('INSERT INTO manual_accounts (name, type, subtype, balance, updated_at, alias, asset, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...vals).lastInsertRowid;
  // Renaming must carry the account's manual transactions and scheduled payments along.
  if (old && old.name !== b.name) {
    db.prepare('UPDATE manual_transactions SET account = ? WHERE account = ?').run(b.name, old.name);
    db.prepare('UPDATE schedules SET account = ? WHERE account = ?').run(b.name, old.name);
  }
  if (asset) refreshPrices().catch(() => {}); // first price for a new holding; listAccounts snapshots it
  else snapshot.run(`manual:${id}`, today(), Number(b.balance));
  return { ok: true };
}
const listTransactions = () => db.prepare(
  'SELECT t.*, a.name AS account FROM transactions t LEFT JOIN accounts a USING (account_id) ORDER BY t.date DESC LIMIT 200').all();

if (demo && !db.prepare('SELECT 1 FROM manual_accounts LIMIT 1').get()) {
  const { seedDemo } = await import('./demo.js');
  const made = seedDemo(db);
  console.log(`demo data: ${made.accounts} accounts, ${made.transactions} transactions`);
}

if (smoke) {
  // End-to-end sandbox check without the Link UI: link token, fake Amex Item, sync until transactions land.
  await linkToken();
  const { public_token } = await plaid('/sandbox/public_token/create', {
    institution_id: 'ins_10',
    initial_products: ['transactions'],
    options: { transactions: { days_requested: 730 } },
  });
  await addItem(public_token, 'American Express (sandbox)');
  for (let i = 0; i < 20 && listTransactions().length === 0; i++) {
    console.log(await syncAll());
    if (listTransactions().length === 0) await new Promise((r) => setTimeout(r, 3000));
  }
  const accounts = listAccounts(), transactions = listTransactions();
  assert.ok(accounts.length > 0, 'no accounts synced');
  assert.ok(transactions.length > 0, 'no transactions synced');
  console.log(`smoke ok: ${accounts.length} accounts, ${transactions.length} transactions (latest ${transactions[0].date})`);
} else {
  // Financial data must not land in the browser's disk cache.
  const json = (res, code, data, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(data));
  };

  // Passkey lock. Passkeys are bound to the site "localhost", so the app must be opened at http://localhost:PORT.
  // Sessions live in memory: a server restart locks the app. 15 idle minutes lock it too (the page also locks itself
  // after a minute in the background).
  const RP_ID = 'localhost';
  const ORIGINS = [`http://localhost:${PORT}`, 'http://localhost:5173']; // the app, and the Vite dev server
  const SESSION_IDLE = 15 * 60 * 1000;
  const sessions = new Map(); // token -> last request time
  let pending = null; // the one outstanding challenge: { challenge, type, expires }
  const newChallenge = (type) => (pending = { challenge: b64url(randomBytes(32)), type, expires: Date.now() + 120_000 }).challenge;
  const takeChallenge = (type) => {
    const p = pending;
    pending = null;
    if (!p || p.type !== type || p.expires < Date.now()) throw new Error('the passkey request expired, try again');
    return p.challenge;
  };
  const hasPasskey = () => !!db.prepare('SELECT 1 FROM passkeys LIMIT 1').get();
  const tokenOf = (req) => /(?:^|;\s*)ledger_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
  // Scripts on this Mac (and Claude Code) use `Authorization: Bearer $(cat .api-token)`. The file is new on every
  // start and readable only by this user, the same as the database itself. Browsers can't send the header to another
  // site without a CORS preflight, which this server never answers, so web pages can't use it.
  const apiToken = Buffer.from(b64url(randomBytes(32)));
  const tokenFile = fileURLToPath(new URL(demo ? '.api-token-demo' : '.api-token', import.meta.url)); // a demo next to the real app keeps its own
  writeFileSync(tokenFile, apiToken, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  const bearer = (req) => {
    const t = Buffer.from(/^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '');
    return t.length === apiToken.length && timingSafeEqual(t, apiToken);
  };
  const unlocked = (req) => {
    if (bearer(req)) return true;
    const t = tokenOf(req), seen = t && sessions.get(t);
    if (!seen || Date.now() - seen > SESSION_IDLE) return (t && sessions.delete(t), false);
    sessions.set(t, Date.now());
    return true;
  };
  const startSession = () => {
    const token = b64url(randomBytes(32));
    sessions.set(token, Date.now());
    return { 'Set-Cookie': `ledger_session=${token}; HttpOnly; SameSite=Strict; Path=/` };
  };
  const passkeyIds = () => db.prepare('SELECT id FROM passkeys').all().map((p) => ({ type: 'public-key', id: p.id }));

  const auth = {
    'GET /api/auth/status': (req) => ({ registered: hasPasskey(), unlocked: !hasPasskey() || unlocked(req), demo }),
    // Registering needs an unlocked session, except for the very first passkey.
    'POST /api/auth/register/options': (req) => {
      if (hasPasskey() && !unlocked(req)) throw Object.assign(new Error('locked'), { status: 401 });
      return {
        challenge: newChallenge('webauthn.create'), rp: { name: 'Moneta', id: RP_ID },
        user: { id: b64url(Buffer.from('ledger-owner')), name: 'Moneta', displayName: 'Moneta' },
        pubKeyCredParams: ALGS.map((alg) => ({ type: 'public-key', alg })), excludeCredentials: passkeyIds(),
        // Any passkey (this computer, a phone, a password manager, a security key), always with fingerprint/face/PIN.
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        attestation: 'none', timeout: 120_000,
      };
    },
    'POST /api/auth/register': (req, b) => {
      if (hasPasskey() && !unlocked(req)) throw Object.assign(new Error('locked'), { status: 401 });
      const challenge = takeChallenge('webauthn.create');
      const counter = checkCeremony({ ...b, type: 'webauthn.create', challenge, origins: ORIGINS, rpId: RP_ID });
      if (!ALGS.includes(b.alg) || !b.publicKey || !b.id) throw new Error('unsupported passkey');
      db.prepare('INSERT INTO passkeys VALUES (?, ?, ?, ?, ?)').run(b.id, b.publicKey, b.alg, counter, new Date().toISOString());
      return [{ ok: true }, startSession()];
    },
    'POST /api/auth/login/options': () => ({ challenge: newChallenge('webauthn.get'), rpId: RP_ID, allowCredentials: passkeyIds(), userVerification: 'required', timeout: 120_000 }),
    'POST /api/auth/login': (req, b) => {
      const challenge = takeChallenge('webauthn.get');
      const key = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(b.id);
      if (!key) throw new Error('unknown passkey');
      const counter = checkCeremony({ ...b, type: 'webauthn.get', challenge, origins: ORIGINS, rpId: RP_ID });
      if (!verifyAssertion({ ...b, publicKey: key.public_key })) throw new Error('signature check failed');
      // Apple's passkeys always report 0; a counter that goes backwards would mean a cloned key.
      if ((counter || key.counter) && counter <= key.counter) throw new Error('passkey counter went backwards');
      db.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').run(counter, key.id);
      return [{ ok: true }, startSession()];
    },
    'POST /api/auth/lock': (req) => {
      sessions.delete(tokenOf(req));
      return [{ ok: true }, { 'Set-Cookie': 'ledger_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }];
    },
  };
  const readBody = async (req) => {
    let s = '';
    for await (const chunk of req) s += chunk;
    return s ? JSON.parse(s) : {};
  };
  const routes = {
    'POST /api/link_token': async () => ({ link_token: (await linkToken()).link_token }),
    'POST /api/exchange': async (body) => ({ item_id: await addItem(body.public_token, body.institution) }),
    'POST /api/sync': syncAll,
    'GET /api/accounts': listAccounts,
    'GET /api/transactions': listTransactions,
    'GET /api/ledger': ledgerNow,
    'GET /api/recurrings': () => recurringsNow(ledgerNow().rows),
    'GET /api/alerts': currentAlerts,
    'POST /api/split': saveSplit,
    'POST /api/split/delete': ({ id }) => (requireFields({ id }, ['id']), clearSplit(id), { ok: true }),
    'POST /api/alerts/dismiss': ({ id }) => {
      requireFields({ id }, ['id']);
      db.prepare('INSERT INTO alert_state (id, dismissed_at) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET dismissed_at = excluded.dismissed_at')
        .run(id, new Date().toISOString());
      return { ok: true };
    },
    'GET /api/schedules': () => db.prepare('SELECT * FROM schedules ORDER BY name').all(),
    'POST /api/schedules': saveSchedule,
    'POST /api/schedules/delete': ({ id }) => (db.prepare('DELETE FROM schedules WHERE id = ?').run(id), { ok: true }),
    'POST /api/rules': saveRule,
    'GET /api/balances': (_, query) => balanceHistory(query),
    'GET /api/accounts/unlinked': unlinkedAccounts,
    'POST /api/accounts/unlinked/close': ({ name, mask }) => {
      requireFields({ name }, ['name']);
      db.prepare('INSERT OR IGNORE INTO closed_exports (name, mask) VALUES (?, ?)').run(name, mask ?? '');
      return { ok: true };
    },
    'GET /api/networth': netWorthHistory,
    'GET /api/rules': () => db.prepare('SELECT * FROM rules ORDER BY field, match').all(),
    'POST /api/edit': saveEdit,
    'POST /api/review': ({ ids = [] }) => {
      for (const id of ids) saveEdit({ id, reviewed: true });
      return { ok: true };
    },
    'POST /api/rules/delete': ({ id }) => (db.prepare('DELETE FROM rules WHERE id = ?').run(id), { ok: true }),
    'POST /api/manual/transaction': saveManualTransaction,
    'POST /api/manual/transaction/delete': ({ id }) => (db.prepare('DELETE FROM manual_transactions WHERE id = ?').run(manualId(id)), { ok: true }),
    'POST /api/manual/account': saveManualAccount,
    'POST /api/manual/account/delete': ({ id }) => {
      db.prepare('DELETE FROM manual_accounts WHERE id = ?').run(manualId(id));
      db.prepare('DELETE FROM holdings WHERE account_id = ?').run(`manual:${manualId(id)}`);
      return { ok: true };
    },
    'GET /api/holdings': liveHoldings,
    'GET /api/health': currentHealth,
    'GET /api/settings': settings,
    'POST /api/settings': ({ key, value }) => {
      if (key === 'idle_cash') {
        if (!value?.name?.trim() || !(Number(value.apy) >= 0 && Number(value.apy) < 1)) throw Object.assign(new Error('idle cash needs a name and a yearly rate between 0 and 1'), { status: 400 });
        value = { name: value.name.trim(), apy: Number(value.apy) };
      } else if (key === 'categories') {
        if (typeof value !== 'object' || Object.values(value).some((v) => !Array.isArray(v) || v.length !== 2)) throw Object.assign(new Error('categories: { name: [emoji, group] }'), { status: 400 });
      } else if (key === 'tag_renames') {
        if (typeof value !== 'object' || Object.entries(value).some(([k, v]) => !k.trim() || typeof v !== 'string' || v === k)) throw Object.assign(new Error('tag_renames: { old: new }'), { status: 400 });
      } else throw Object.assign(new Error(`unknown setting ${key}`), { status: 400 });
      db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, JSON.stringify(value));
      return { ok: true };
    },
    'POST /api/health/state': ({ id, state }) => {
      requireFields({ id }, ['id']);
      if (state == null) db.prepare('DELETE FROM health_state WHERE id = ?').run(id);
      else if (['working', 'ignored'].includes(state)) db.prepare('INSERT OR REPLACE INTO health_state VALUES (?, ?, ?)').run(id, state, new Date().toISOString());
      else throw Object.assign(new Error('state must be working, ignored or null'), { status: 400 });
      return { ok: true };
    },
    'GET /api/history': priceHistory,
    // Fidelity's core cash sweep (FCASH buys/sells) mirrors every cash movement; it's noise next to the real activity.
    'GET /api/investments/activity': () => db.prepare("SELECT * FROM inv_transactions WHERE coalesce(symbol, '') != 'FCASH' ORDER BY date DESC, id").all(),
    'POST /api/accounts/exclude': ({ id, excluded }) => {
      requireFields({ id }, ['id']);
      if (excluded) db.prepare('INSERT OR IGNORE INTO excluded_accounts VALUES (?)').run(id);
      else db.prepare('DELETE FROM excluded_accounts WHERE account_id = ?').run(id);
      return { ok: true };
    },
    'GET /api/goals': () => db.prepare('SELECT * FROM goals ORDER BY id').all().map((g) => ({ ...g, accounts: JSON.parse(g.accounts) })),
    'POST /api/goals': ({ id, name, monthly, accounts = [], cash_target = null }) => {
      requireFields({ name }, ['name']);
      if (!(Number(monthly) > 0)) throw new Error('monthly target must be a positive number');
      if (cash_target != null && cash_target !== '' && !(Number(cash_target) > 0)) throw new Error('cash target must be a positive number');
      const vals = [name.trim(), Number(monthly), JSON.stringify(accounts), cash_target == null || cash_target === '' ? null : Number(cash_target)];
      if (id) db.prepare('UPDATE goals SET name = ?, monthly = ?, accounts = ?, cash_target = ? WHERE id = ?').run(...vals, id);
      else db.prepare('INSERT INTO goals (name, monthly, accounts, cash_target) VALUES (?, ?, ?, ?)').run(...vals);
      return { ok: true };
    },
    'POST /api/goals/delete': ({ id }) => (db.prepare('DELETE FROM goals WHERE id = ?').run(id), { ok: true }),
    'GET /api/budgets': () => db.prepare('SELECT * FROM budgets ORDER BY category').all(),
    // A blank or zero amount removes the budget.
    'POST /api/budgets': ({ category, amount }) => {
      requireFields({ category }, ['category']);
      if (amount === '' || amount == null || Number(amount) === 0) db.prepare('DELETE FROM budgets WHERE category = ?').run(category);
      else if (!(Number(amount) > 0)) throw new Error('amount must be a positive number');
      else db.prepare('INSERT OR REPLACE INTO budgets VALUES (?, ?)').run(category, Number(amount));
      return { ok: true };
    },
    'POST /api/holdings': saveHolding,
  };
  const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
  const dist = fileURLToPath(new URL('web/dist', import.meta.url));
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  };
  const sendFile = (res, file) => {
    // HTML must revalidate so a rebuild shows up on reload; hashed assets under /assets can be cached.
    // Never framed by another site (clickjacking), and no referrer leaks to Plaid or anyone else.
    res.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream', ...(extname(file) === '.html' && { 'Cache-Control': 'no-cache' }),
      'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    });
    res.end(readFileSync(file));
  };

  http.createServer(async (req, res) => {
    // Block DNS rebinding: only answer requests addressed to localhost.
    if (!allowedHosts.has(req.headers.host)) return json(res, 403, { error: 'forbidden host' });
    // Block CSRF: other sites can only POST text/plain without a preflight, and preflights are never answered.
    if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) {
      return json(res, 415, { error: 'content-type must be application/json' });
    }
    const path = req.url.split('?')[0];
    try {
      const authRoute = auth[`${req.method} ${path}`];
      if (authRoute) {
        const out = await authRoute(req, await readBody(req));
        return Array.isArray(out) ? json(res, 200, out[0], out[1]) : json(res, 200, out);
      }
      if (path.startsWith('/api/') && hasPasskey() && !unlocked(req)) return json(res, 401, { error: 'locked' });
      const route = routes[`${req.method} ${path}`];
      if (route) return json(res, 200, await route(await readBody(req), Object.fromEntries(new URL(req.url, 'http://x').searchParams)));
      if (path.startsWith('/api/') || req.method !== 'GET') return json(res, 404, { error: 'not found' });
      // Plain Link page kept as a fallback for connecting banks.
      if (path === '/connect') return sendFile(res, fileURLToPath(new URL('connect.html', import.meta.url)));
      // React build; anything outside web/dist is refused, unknown paths fall back to the SPA.
      const file = resolve(dist, '.' + decodeURIComponent(path));
      if (file !== dist && !file.startsWith(dist + sep)) return json(res, 403, { error: 'forbidden path' });
      const target = existsSync(file) && statSync(file).isFile() ? file : join(dist, 'index.html');
      if (!existsSync(target)) return json(res, 404, { error: 'UI not built: run npm run build' });
      sendFile(res, target);
    } catch (e) {
      console.error(e.message);
      json(res, e.status ?? 500, { error: e.message });
    }
  }).listen(Number(PORT), '127.0.0.1', () => console.log(`Moneta on http://localhost:${PORT} (${PLAID_ENV})`));

  // Gold/BTC manual accounts and every investment position reprice every 15 minutes while the server runs.
  const reprice = () => Promise.all([refreshPrices(), refreshQuotes()]);
  reprice();
  syncFx();
  setInterval(reprice, 15 * 60 * 1000);
}

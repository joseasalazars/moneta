# Moneta

The app is called Moneta; code and files keep the older internal name "ledger" (`ledger.js`, `ledger-<env>.db`,
`ledger:*` browser keys, the `ledger_session` cookie), so existing data and passkeys keep working.

A personal finance app that runs on your own laptop. It pulls bank data through Plaid, can import your history from
a Copilot Money export, and adds what most apps don't: overlapping tags (e.g. a person's name), rules, payment
plans, splits, investments with live prices, and manual accounts for anything Plaid can't reach.

If `NOTES.md` exists, read it: it's the owner's private log (state, decisions, what's next) and isn't published.

## Run

```bash
npm start              # server on http://localhost:3000 (serves web/dist + /api), env from .env; prestart runs
                       # scripts/setup.js (installs/builds the UI when missing or stale). No Plaid keys = manual accounts only
npm run build          # build the React UI into web/dist (needed after any web/ change)
npm run dev            # server (restarts on code changes) + Vite on :5173, both at once (dev:demo: sample data)
node ledger.js         # self-check for the merge / rules / recurrings / schedules logic
npm run check          # offline check of the Plaid <-> Copilot merge on the real DB (no Plaid calls)
npm run import:copilot # re-import copilot-export/copilot-transactions.csv (see warning below)
npm run demo           # no Plaid keys: ledger-demo.db filled by demo.js with 14 months of made-up data
```

`README.md` is the public introduction (screenshots in `docs/screenshots/`, taken from the demo). The passkey lock is optional
("Not now" on the setup screen; the lock button offers it again) and the demo never asks.

`.env` holds `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (`sandbox` or `production`). Never read, print or commit it.

## Layout

- `server.js`: zero-dependency Node HTTP server. Plaid calls (plain `fetch`), SQLite (`node:sqlite`), schema and
  migrations (`addColumn`), every `/api/*` route, static serving of `web/dist`, schedule materialization.
- `ledger.js`: pure logic, with a self-check at the bottom. `buildLedger` merges Plaid + Copilot history + manual
  rows, then applies rules and edits. `buildRecurrings` derives recurring charges. `dueOccurrences` and
  `scheduleDate` drive scheduled payments.
- `web/`: Vite + React + TypeScript + Tailwind v4 + shadcn (radix-nova preset). Pages live in
  `web/src/components/` (dashboard, transactions, cash-flow, categories, accounts, investments, recurrings, review). Shared data comes from
  `web/src/lib/data.tsx` (`useData`). API types are in `web/src/lib/api.ts`. Category emoji and group colors are in
  `web/src/lib/categories.ts`.
- `connect.html`: a bare Plaid Link page at `/connect`, kept as a fallback for linking banks.
- `auth.js`: WebAuthn (passkey) checks for the lock, no dependencies.
- `check-merge.js`: an offline merge report and double-count assertion.
- `ledger-<env>.db`: SQLite, one file per Plaid environment. `copilot-export/`: Copilot CSV and JSON exports.
  Both are gitignored, along with `.env`.

## Rules that matter

- **Plaid's Trial plan has 10 production Items and slots are never freed** (NOTES.md, if present, says how many are
  used). Link one bank at a time and click Connect once. Never run `npm run smoke` with production keys, because it creates a
  sandbox Item through the sandbox API. Never call `/sandbox/*` or create Items to test anything.
- **Amount sign:** positive means money out, negative means money in. Plaid and Copilot use the same convention,
  so keep it everywhere.
- **Spending** is `type === 'regular' && !excluded`. **Income** is `type === 'income'`, and it ignores `excluded`
  because Copilot flags all income as excluded.
- **Merge:** each Plaid account takes over from its first Plaid date. Copilot rows inside that window are matched
  one-to-one, by mask or name plus amount, exact date first and then within 30 days. Unmatched Copilot rows in
  the window are dropped, because Plaid is the source of truth there. Never sum both sources for the same period.
  A shared bank reference number (9+ digits) matches first, at any date. Splits: when 2-3 unused Copilot rows add
  up to one Plaid row, the Copilot rows (`source: 'split'`) replace it.
- **Foreign currency:** PayPal reports some payments in MXN. `loadLedger` converts non-USD Plaid rows to dollars at that
  day's rate (`prices`, asset = currency code, USD per unit, from Yahoo `<CODE>=X`, fetched by `syncFx` at startup
  and on sync) and keeps `foreign: "2000 MXN"`; they match Copilot rows within 3% (Copilot can record peso amounts as dollars).
- **PayPal wallet** (`type = 'depository' AND subtype = 'paypal'`, balance always $0): its regular rows are excluded,
  because each purchase or refund also posts on the card or bank that funded it (the card shows the merchant or
  "Paypal Pay in 4", a bank shows "PAYPAL INST XFER"). PayPal Credit is a real card and isn't affected. An edit can still count a row.
  `pairWallet` pairs each wallet purchase with the charge that paid it (within 4 days, same amount, 5% if converted,
  name says PayPal or shares the merchant's word; Copilot-only rows by merchant and day): the charge gets `via:
  'PayPal'` (and the merchant name if the bank wrote PAYPAL ...), the wallet copy gets `pairedWith` and is hidden from
  Transactions, Review, the dashboard and recurrings (still listed on the PayPal account page).
- **Edits follow matches:** a matched Plaid row carries `copilotId`, so an edit made on the Copilot history row still
  applies after Plaid backfills that date.
- **Transfers vs spending:** Plaid marks Zelle, Coinbase and rent as transfers. A new Plaid row takes the user's
  category and type learned from matched history (same name, else same first word and direction). A rule that sets
  a real category makes a transfer regular spending.
- **Rule order:** text rules (name, note or recurring substring) can set the category, tags and recurring. Then
  per-transaction edits apply, and an edit always wins. Then category rules (exact match) add tags only. If an
  edit sets tags, that list replaces whatever the rules added.
- **Edits are keyed by ledger id:** the Plaid `transaction_id`, `copilot:<rowid>` or `manual:<id>`. Re-importing
  the Copilot CSV changes rowids and orphans edits on history rows. Don't re-import without migrating edits.
- **Manual account balance** is the balance the user last entered (as of `updated_at`, in local days) plus every
  later manual transaction on that account. Scheduled payments with `affects_balance = 0` (budgeting-only, e.g. a laptop
  paid in full but spread over 12 months) don't move it. A schedule with `match` set is a bill the user pays by hand
  (e.g. store-card installments): no rows are added; `buildLedger` claims bank debits whose name contains `match` (in date order, up to
  `count`), `billPaid` counts those or the card's own payment credits, and `buildAlerts` raises `bill:` alerts until paid. Liabilities add the amount, assets subtract it.
- **Priced holdings:** a manual account with `asset` (`BTC`, or `XAU` in grams) and `quantity` is worth
  quantity × the last stored spot price (`prices` table, from Coinbase's public API). Manual transactions don't
  apply to it.
- **Investments:** `holdings` holds Plaid positions (replaced on every sync via `/investments/holdings/get`) and
  positions the user enters on manual accounts (`manual = 1`, validated by fetching a quote). `quotes` holds live
  prices: Coinbase Exchange for crypto (key `crypto:<SYM>`), Yahoo Finance's chart endpoint for everything else, no
  keys. Prices refresh every 15 minutes while the server runs. An account with positions is valued live: Plaid's
  balance moved by (live − Plaid's price) per position; a manual account is worth exactly its positions.
  Clicking a position opens a side panel (`PositionSheet` in investments.tsx): price chart from `GET /api/history`
  (Yahoo chart endpoint, crypto as `SYM-USD`, 5-minute cache, ranges 1D-ALL) and the position in every account.
- **Copilot export matching** (`exportedFor`): mask (or name when no mask), or a manual account's `alias`; if none,
  a name that's unique in the export (banks renumber accounts: Fidelity's 401k). Net worth, balance history and
  the "Not linked yet" list all go through it.
- **Excluded accounts** (`excluded_accounts`, e.g. unvested RSUs) show everywhere but count in no total and not in
  net worth.
- **Budgets:** one monthly amount per category (`budgets`); the Categories page edits them inline.
- **Splits made in the app** (`splits` table): a row becomes parts with ids `<id>#<n>` (`splitOf` = original id);
  each part's category/tags are ordinary edits on its id; parts must sum to the original to the cent. (Different
  from `source: 'split'`, which is a Copilot split matched at merge time.)
- **Alerts** (`buildAlerts` in `ledger.js`, stateless): over budget by $10+, near budget (90%, only where there's
  non-recurring spending), one-off charges above 1.25x the category's 95th percentile, a recurring price change
  (two equal charges then a different one), a monthly charge 5-15 days late. `alert_state` remembers dismissed and
  notified ids. After each sync, new alerts become macOS notifications via `osascript` with the text passed as
  arguments (never spliced into the script).
- **Investment activity** (`inv_transactions`, Plaid `/investments/transactions/get`): first sync pulls 24 months, later
  ones the last 60 days, upserted by id. Plaid sign: positive = cash out of the account. Fidelity's FCASH core-cash
  sweep rows are hidden. An RSU vest is a $0 buy; its tax withholding is a "JOURNALED RSU" withdrawal.
- **Freshness:** each sync calls `/item/get` (free) and stores `items.last_update` (when Plaid last reached the bank)
  and `items.error` (e.g. ITEM_LOGIN_REQUIRED). One bank failing no longer stops the sync of the others.
- **Card statements** (`card_details`, Plaid `/liabilities/get` on items with credit accounts; Ally answers
  PRODUCTS_NOT_SUPPORTED, which is ignored). Paid = a payment ≥ the statement balance on/after the statement date
  (`statementPaid`, same rule in ledger.js and api.ts). Alerts: due within 5 days and unpaid, or overdue.
- **Goals** (`goals`): a monthly target filled by new money into the goal's accounts (`newMoney`: investment activity
  money moves, leaving out any move mirrored by an opposite one in another linked investment account within 5 days,
  so a Fidelity → Robinhood transfer or an IRA → Roth conversion isn't savings). The Goals page headline is income minus
  spending against the sum of the targets.
- **Dashboard extras:** "Left to spend" (`left-to-spend.tsx`: budget total minus spending, bills still due, pacing on
  non-recurring spending only), "Financial health" (`buildHealth` in ledger.js via `GET /api/health`; the page words
  and formats the numbers so the eye button hides them). Investments has "Top movers today"; Recurrings has a bills
  calendar (`bills-calendar.tsx`: paid = this month's rows with a recurring, upcoming = projected from nextDate).
- **Weekly recap** (`#recap/<monday>`, `recap.tsx`, computed in the browser): last finished Monday-Sunday week, spend vs
  the 8 weeks before, a day-by-day strip, top categories, bills for the next 7 days, biggest purchases, net worth change.
  Monday to Wednesday an info alert links to it. Health checks can be marked `working` or `ignored` (`health_state`).
- **Monthly report** (`#report/<YYYY-MM>`, computed in the browser): highlights, savings vs goals, budget scorecard,
  net worth change, tags, biggest purchases. Days 1-7 of a month, an info alert links to last month's report.
- **Rule tags starting with `-`** remove that tag (e.g. a rideshare rule `["Partner", "-Essential"]` beats the
  Transportation category rule).
- **Manual accounts can carry an `alias`** (their name in the Copilot export) so their history shows up under the
  new name.
- **Security:** bind 127.0.0.1, check the Host header (DNS rebinding), and require `application/json` on every
  POST (CSRF). Render bank strings as text only. Access tokens sit in plain text in the gitignored DB, so keep disk
  encryption (FileVault) on. API responses are `no-store`; pages send `X-Frame-Options: DENY`, `frame-ancestors 'none'`, no referrer.
- **Passkey lock** (`auth.js`, self-check `node auth.js`): a WebAuthn passkey bound to `localhost` (any authenticator:
  Touch ID, Windows Hello, a phone, a password manager or a security key; user verification is always required). Once one is in
  `passkeys`, every `/api/*` except `/api/auth/*` needs the `ledger_session` cookie (HttpOnly, SameSite=Strict).
  Sessions are in memory: restart = locked; 15 idle minutes on the server = locked. The page locks itself by wall
  clock (timers pause in the background and in sleep): 5 minutes without input, a >30 s gap between its 5 s checks
  (the Mac slept), or back after >60 s hidden. A full-screen backdrop-blur overlay (above Radix portals) covers the
  app whenever the window loses focus. DB and .env are chmod 600. Open the app at http://localhost:3000, never 127.0.0.1 (it redirects).
  **Scripts / Claude Code** call the API with `-H "Authorization: Bearer $(cat .api-token)"`: the server writes a fresh
  random token to `.api-token` (0600, gitignored) on every start. Use it instead of hand-written SQL.
  To look at the UI headless: `$B header "Authorization:Bearer $(cat .api-token)"` then `$B goto http://localhost:3000/#goals`
  (the gstack browse binary); the page counts as unlocked. The header goes to every site that browser visits, so
  run `$B stop` before browsing anything outside localhost.
  **Locked out** (new computer, passkey deleted): `sqlite3 ledger-production.db 'DELETE FROM passkeys'`, restart, set up
  again. Mac notifications carry no amounts or merchants (they can show on the lock screen).
- **Settings** (`settings` table, JSON per key; `GET/POST /api/settings`, page `#settings`): `idle_cash` = { name, apy }
  for the idle-cash health check; `categories` = { name: [emoji, group] } for custom categories and overrides of the
  built-in look in `web/src/lib/categories.ts` (applied via `setCustomCategories` when data loads). Nothing personal is
  hardcoded: the monthly saving is the sum of Goals, the budget is the sum of Budgets, the report lists the top tags.
  `tag_renames` = { old: new } ('' deletes), applied last in `buildLedger` so rules/edits keep old names and it's undoable.
- **Everything personal is set up in the UI:** tags and rules (Review → New rule: by name/note/recurring/category, add or
  remove tags), recurring names and splits (transaction sheet), payment plans (Recurrings → New scheduled payment:
  "added for me" or "I pay it myself" with the bank's payment name), categories and tags (Settings).
- **Colors:** categories are colored by **group** (7 validated dataviz hues, `--group-*` in `web/src/index.css`),
  never one hue per category. Text stays in normal ink and the color goes on a dot or bar.

## Working style for this repo

- One person per install: the owner is the only user. Keep the server dependency-free. UI packages go in `web/` only.
- After changing `server.js` or `ledger.js`, restart the server. After changing `web/`, run `npm run build`.
- Check UI changes with the gstack `browse` skill (headless screenshots + console errors), not by guessing.
- Run `node ledger.js` after touching `ledger.js`. Add an assertion there for new pure logic.
- Data changes for the user (rules, schedules, edits) go through the API, so they're validated and reversible.
  Don't write SQL against those tables by hand.

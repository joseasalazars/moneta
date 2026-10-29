// Unified transaction ledger: Plaid rows for linked accounts, Copilot history for everything else,
// manual rows on top, then the user's rules and per-transaction edits.
// Copilot's categories are user-curated, so Plaid rows inherit them whenever they can be matched.

const TRANSFER = new Set(['TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS']);
// Copilot sometimes dates a charge weeks off from Plaid's posted date (seen: 4-24 days), so allow 30.
const MATCH_DAYS = 30;

// Copilot exports a missing mask as '' (not null), so fall back with ||.
const accountKey = (mask, name) => mask || name;
const cents = (n) => Math.round(n * 100);
const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
// Plaid's primary categories mapped onto the user's Copilot categories, so new rows land in familiar buckets.
const PFC = {
  FOOD_AND_DRINK: 'Restaurants', GENERAL_MERCHANDISE: 'Shops', RENT_AND_UTILITIES: 'Utilities', TRAVEL: 'Travel & Vacation',
  TRANSPORTATION: 'Transportation', ENTERTAINMENT: 'Entertainment', PERSONAL_CARE: 'Personal Care', MEDICAL: 'Healthcare',
  HOME_IMPROVEMENT: 'Home', GOVERNMENT_AND_NON_PROFIT: 'Taxes', INCOME: 'Income',
  TRANSFER_IN: 'Transfer', TRANSFER_OUT: 'Transfer', LOAN_PAYMENTS: 'Transfer',
};
const pretty = (pfc) => PFC[pfc] ?? (pfc ? pfc.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'Other');
const plaidName = (t) => (t.merchant || t.name).toLowerCase();
// Bank reference numbers (e.g. an employer reimbursement's RMR*IV*US100000000001) survive Copilot's renaming; dates sometimes don't.
const refs = (s) => s.match(/\d{9,}/g) ?? [];
// First word plus direction ("zelle out"): what the user usually did with transfers of that kind.
const transferKind = (t) => `${plaidName(t).split(/\W/)[0]} ${t.amount > 0 ? 'out' : 'in'}`;
// Copilot names some accounts with non-breaking spaces ("Apple Card").
const clean = (s) => (s ?? '').replace(/ /g, ' ');
const splitTags = (s) => (s ? s.split(',').map((t) => t.trim()).filter(Boolean) : []);
const parseTags = (s) => (s ? JSON.parse(s) : []);

const fromCopilot = (c, aliases = new Map()) => ({
  id: `copilot:${c.rowid}`,
  date: c.date,
  name: c.name,
  amount: c.amount,
  // Accounts we no longer sync (Venmo, Apple Card...) live on as manual accounts that may use a friendlier name.
  account: aliases.get(clean(c.account)) ?? clean(c.account),
  mask: c.account_mask || null,
  category: c.category || { 'internal transfer': 'Transfer', income: 'Income' }[c.type] || 'Uncategorized',
  type: c.type,
  excluded: c.excluded === 'true',
  pending: c.status === 'pending',
  note: c.note || null,
  tags: splitTags(c.tags),
  recurring: c.recurring || null,
  reviewed: true,
  source: 'copilot',
});

const fromManual = (m) => ({
  id: `manual:${m.id}`,
  date: m.date,
  name: m.name,
  amount: m.amount,
  account: m.account,
  mask: null,
  category: m.category || 'Uncategorized',
  type: m.type,
  excluded: m.type === 'internal transfer',
  pending: false,
  note: m.note || null,
  tags: parseTags(m.tags),
  recurring: m.recurring || null,
  reviewed: true,
  source: 'manual',
});

export function buildLedger({ plaid, copilot, manual = [], rules = [], edits = [], userSplits = [], aliases = new Map(), schedules = [], wallets = new Set(), tagRenames = {} }) {
  // Each linked Plaid account takes over from its first Plaid date; older Copilot rows stay as history.
  const firstDate = new Map();
  for (const t of plaid) {
    const k = accountKey(t.mask, t.account);
    if (!firstDate.has(k) || t.date < firstDate.get(k)) firstDate.set(k, t.date);
  }

  // Match candidates start MATCH_DAYS before the Plaid window so edge rows dated differently don't double count.
  const history = [], overlap = new Map(); // overlap: key -> Copilot match candidates
  const copilotKeys = new Set();
  for (const c of copilot) {
    const k = accountKey(c.account_mask, c.account);
    copilotKeys.add(k);
    const first = firstDate.get(k);
    if (first && (c.date >= first || days(c.date, first) <= MATCH_DAYS)) (overlap.get(k) ?? overlap.set(k, []).get(k)).push(c);
    else history.push(fromCopilot(c, aliases));
  }

  // One-to-one matching, same amount: shared reference number (any date), then exact date, then within MATCH_DAYS
  // (nearest wins).
  const matched = new Map(); // plaid transaction_id -> copilot row
  const used = new Set();
  for (const pass of ['ref', 'exact', 'loose']) {
    for (const t of plaid) {
      if (matched.has(t.transaction_id)) continue;
      let best = null;
      for (const c of overlap.get(accountKey(t.mask, t.account)) ?? []) {
        // Converted foreign amounts (MXN on PayPal) differ from Copilot's conversion by a rate, so they match within 3%.
        const same = t.foreign ? Math.abs(c.amount - t.amount) <= 0.03 * Math.abs(t.amount) : cents(c.amount) === cents(t.amount);
        if (used.has(c) || !same) continue;
        const d = days(c.date, t.date);
        if (pass === 'ref' ? refs(t.name).some((r) => c.name.includes(r)) : pass === 'exact' ? d === 0 : d <= MATCH_DAYS && (!best || d < days(best.date, t.date))) {
          best = c;
          if (pass !== 'loose') break;
        }
      }
      if (best) { matched.set(t.transaction_id, best); used.add(best); }
    }
  }

  // Splits: the user split one bank charge into several Copilot rows (rent across two months, a $100 transfer into
  // two $50 purchases). Find 2-3 unused Copilot rows that add up to the Plaid amount: at least one from the same
  // account within MATCH_DAYS, the rest from there or the same date on any account (Copilot sometimes files a split
  // child under another account). The Copilot rows then stand in for the Plaid row.
  const splits = new Map(); // plaid transaction_id -> copilot rows
  for (const t of plaid) {
    if (matched.has(t.transaction_id)) continue;
    const ok = (c) => !used.has(c) && Math.sign(c.amount) === Math.sign(t.amount) && Math.abs(c.amount) < Math.abs(t.amount);
    const near = (overlap.get(accountKey(t.mask, t.account)) ?? []).filter((c) => ok(c) && days(c.date, t.date) <= MATCH_DAYS);
    if (!near.length) continue;
    const pool = [...new Set([...near, ...copilot.filter((c) => ok(c) && c.date === t.date)])];
    const target = cents(t.amount);
    let found = null;
    for (let i = 0; i < pool.length && !found; i++) {
      for (let j = i + 1; j < pool.length && !found; j++) {
        const two = cents(pool[i].amount) + cents(pool[j].amount);
        if (two === target) found = [pool[i], pool[j]];
        for (let k = j + 1; k < pool.length && !found; k++) if (two + cents(pool[k].amount) === target) found = [pool[i], pool[j], pool[k]];
      }
    }
    if (found && found.some((c) => near.includes(c))) {
      splits.set(t.transaction_id, found);
      for (const c of found) used.add(c);
    }
  }

  // Learn merchant -> user category + type / recurring from matched pairs, for new Plaid rows Copilot never saw.
  // The type matters: Plaid calls a Zelle rent payment TRANSFER_OUT, the user called it regular Rent.
  // kindVotes covers a brand-new Zelle or Coinbase payee: the user treated most of those as spending, not transfers.
  const votes = new Map(), kindVotes = new Map(), recurringByName = new Map();
  const vote = (map, key, value) => {
    const v = map.get(key) ?? map.set(key, new Map()).get(key);
    v.set(value, (v.get(value) ?? 0) + 1);
  };
  const top = (v) => v && [...v].sort((a, b) => b[1] - a[1])[0][0];
  for (const t of plaid) {
    const c = matched.get(t.transaction_id);
    if (!c) continue;
    if (TRANSFER.has(t.category)) vote(kindVotes, transferKind(t), c.type);
    if (c.recurring) recurringByName.set(plaidName(t), c.recurring);
    if (c.category) vote(votes, plaidName(t), JSON.stringify([c.category, c.type]));
  }
  const learned = (t) => {
    const v = top(votes.get(plaidName(t)));
    if (v) return JSON.parse(v);
    return TRANSFER.has(t.category) && top(kindVotes.get(transferKind(t))) === 'regular' ? ['Uncategorized', 'regular'] : [];
  };

  const plaidRows = plaid.filter((t) => !splits.has(t.transaction_id)).map((t) => {
    const c = matched.get(t.transaction_id);
    const base = {
      id: t.transaction_id,
      date: t.date,
      name: t.merchant || t.name,
      amount: t.amount,
      account: t.account,
      mask: t.mask,
      pending: !!t.pending,
      source: 'plaid',
      ...(t.foreign && { foreign: t.foreign }),
    };
    if (c) {
      return {
        ...base, category: c.category || pretty(t.category), type: c.type, excluded: c.excluded === 'true',
        note: c.note || null, tags: splitTags(c.tags), recurring: c.recurring || null, reviewed: true,
        copilotId: `copilot:${c.rowid}`, // edits made on the history row follow it when Plaid's copy takes over
      };
    }
    const [category, learnedType] = learned(t);
    const type = learnedType || (TRANSFER.has(t.category) ? 'internal transfer' : t.category === 'INCOME' ? 'income' : 'regular');
    return {
      ...base, category: category || (type === 'internal transfer' ? 'Transfer' : pretty(t.category)), type,
      excluded: type === 'internal transfer', note: null, tags: [], recurring: recurringByName.get(plaidName(t)) ?? null,
      reviewed: false,
    };
  });

  // Split children keep the user's dates, names and categories, on the account the money actually left.
  const splitRows = [...splits].flatMap(([id, list]) => {
    const t = plaid.find((p) => p.transaction_id === id);
    return list.map((c) => ({ ...fromCopilot(c, aliases), account: t.account, mask: t.mask, pending: !!t.pending, source: 'split', parent: id }));
  });
  const splitIds = new Set(splitRows.map((r) => r.id));

  // Unmatched candidates before the window are genuine history; inside it Plaid is the source of truth. Plaid's first
  // day is often partial (Robinhood's card started mid-day), so unmatched rows on that day count as history too.
  const unmatchedCopilot = [];
  for (const [k, list] of overlap) {
    for (const c of list) {
      if (used.has(c)) continue;
      if (c.date <= firstDate.get(k)) history.push(fromCopilot(c, aliases));
      else unmatchedCopilot.push(c);
    }
  }

  // Rules apply everywhere. name/note/recurring rules match a substring and may set the category; category rules
  // match exactly and only add tags (e.g. Healthcare -> "HSA eligible"), so they run after edits settle the category.
  // A per-transaction edit always wins: its tags replace whatever rules added.
  const ruleList = rules.map((r) => ({ field: r.field || 'name', match: r.match.toLowerCase(), category: r.category, tags: parseTags(r.tags), recurring: r.recurring }));
  const textRules = ruleList.filter((r) => r.field !== 'category');
  const categoryRules = ruleList.filter((r) => r.field === 'category');
  const editById = new Map(edits.map((e) => [e.id, e]));
  // Splits made in the app: a row becomes its parts (ids `<id>#<n>`), whose category, tags and note are ordinary
  // edits on the part's id. Only the first part keeps the recurring link, so a recurring isn't counted twice.
  const partsOf = Map.groupBy(userSplits, (p) => p.parent_id);
  const expand = (row) => (partsOf.get(row.id) ?? []).sort((a, b) => a.idx - b.idx)
    .map((p, i) => ({ ...row, id: `${row.id}#${p.idx}`, name: p.name || row.name, amount: p.amount, recurring: i === 0 ? row.recurring : null, splitOf: row.id }));
  const base = [...plaidRows, ...splitRows, ...history.filter((h) => !splitIds.has(h.id)), ...manual.map(fromManual)]
    .flatMap((row) => (partsOf.has(row.id) ? expand(row) : [row]));
  // Bills you pay yourself (a purchase on PayPal Credit paid off monthly): each payment leaving your bank is the
  // spending, under the schedule's category and recurring name, in date order up to `count`. The purchase stays excluded.
  const billOf = new Map();
  for (const s of schedules.filter((s) => s.match)) {
    const from = addDays(s.start_date, -10), match = s.match.toLowerCase();
    // ponytail: "at least half the installment" keeps small debits with the same name (PayPal subscriptions) out
    base.filter((r) => r.date >= from && r.account !== s.account && r.amount >= s.amount / 2 && r.amount <= s.amount + 0.01
      && r.name.toLowerCase().includes(match)).sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, s.count ?? Infinity).forEach((r) => billOf.set(r.id, s));
  }
  const rows = base.map((row) => {
    let out = row;
    const drop = new Set(); // "-Essential" in a text rule's tags removes that tag, even one a category rule adds later
    for (const r of textRules) {
      if (!(row[r.field] ?? '').toLowerCase().includes(r.match)) continue;
      for (const t of r.tags) if (t.startsWith('-')) drop.add(t.slice(1));
      const add = r.tags.filter((t) => !t.startsWith('-'));
      out = { ...out, category: r.category ?? out.category, tags: [...new Set([...out.tags, ...add])], recurring: r.recurring ?? out.recurring };
      // A rule that files a transfer under a real category (Zelle to the landlord -> Rent) makes it spending.
      if (r.category && r.category !== 'Transfer' && out.type === 'internal transfer') out = { ...out, type: 'regular', excluded: false };
    }
    // A PayPal wallet holds $0: every purchase on it is charged to a card or bank (and refunds go back there), where it
    // already counts. (PayPal Credit is a real card and isn't a wallet.) An edit can still count one.
    if (wallets.has(row.account) && out.type === 'regular') out = { ...out, excluded: true, note: out.note ?? 'Paid through PayPal; the card or bank charge is the spending' };
    const bill = billOf.get(row.id);
    if (bill) out = { ...out, category: bill.category || out.category, type: 'regular', excluded: false, recurring: bill.name };
    const e = editById.get(row.id) ?? (row.copilotId && editById.get(row.copilotId));
    if (e) {
      out = {
        ...out,
        name: e.name ?? out.name,
        amount: e.amount ?? out.amount, // only offered for Copilot history; Plaid amounts are the bank's
        category: e.category ?? out.category,
        type: e.type ?? out.type,
        excluded: e.excluded == null ? out.excluded : !!e.excluded,
        note: e.note ?? out.note,
        tags: e.tags == null ? out.tags : parseTags(e.tags),
        recurring: e.recurring == null ? out.recurring : e.recurring || null, // '' clears
        reviewed: e.reviewed == null ? out.reviewed : !!e.reviewed,
      };
    }
    if (e?.tags != null) return out;
    for (const r of categoryRules) {
      if (out.category.toLowerCase() !== r.match) continue;
      const remove = r.tags.filter((t) => t.startsWith('-')).map((t) => t.slice(1));
      out = { ...out, tags: [...new Set([...out.tags, ...r.tags.filter((t) => !t.startsWith('-'))])].filter((t) => !remove.includes(t)) };
    }
    return drop.size ? { ...out, tags: out.tags.filter((t) => !drop.has(t)) } : out;
  });

  const report = {
    matched: matched.size,
    splits: [...splits].map(([id, list]) => ({ plaid: id, into: list.map((c) => `${c.date} ${c.name} ${c.amount}`) })),
    unmatchedPlaid: plaid.filter((t) => !matched.has(t.transaction_id) && !splits.has(t.transaction_id)).map((t) => ({ date: t.date, name: t.merchant || t.name, amount: t.amount, account: t.account })),
    unmatchedCopilot: unmatchedCopilot.map((c) => ({ date: c.date, name: c.name, amount: c.amount, account: clean(c.account) })),
    // Linked accounts Copilot knows under a different key would have their overlap counted twice.
    unknownAccounts: [...firstDate.keys()].filter((k) => !copilotKeys.has(k)),
  };
  // Renamed or merged tags (Settings → Tags): old -> new, '' deletes. Applied last, so rules and edits keep the old name
  // and the rename can be undone.
  const renamed = Object.keys(tagRenames).length
    ? rows.map((r) => (r.tags.some((t) => t in tagRenames) ? { ...r, tags: [...new Set(r.tags.map((t) => (t in tagRenames ? tagRenames[t] : t)).filter(Boolean))] } : r))
    : rows;
  return { rows: pairWallet(renamed, wallets).sort((a, b) => b.date.localeCompare(a.date)), report };
}

// Each PayPal wallet purchase paired with the card or bank charge that paid it (within 4 days, same amount; 5% for a
// converted currency), when the charge says PayPal or shares the merchant's first word. The charge gets via: 'PayPal'
// (and the merchant's name when the bank only wrote PAYPAL ...); the wallet copy gets pairedWith, so lists can hide it.
function pairWallet(rows, wallets) {
  if (!wallets.size) return rows;
  const key = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').find((w) => w.length > 2 && !['paypal', 'payment'].includes(w));
  const patch = new Map(), taken = new Set();
  const charges = rows.filter((r) => !wallets.has(r.account) && r.amount > 0);
  for (const w of rows.filter((r) => wallets.has(r.account) && r.type === 'regular' && r.amount > 0).sort((a, b) => a.date.localeCompare(b.date))) {
    const k = key(w.name), tol = w.foreign ? 0.05 * w.amount : 0.01;
    const named = (r) => /paypal/i.test(r.name) || (k && r.name.toLowerCase().includes(k));
    // Copilot's PayPal history kept peso amounts as dollars (149 for Streamly), so its rows pair on merchant and day.
    const f = charges.find((r) => !taken.has(r.id) && days(r.date, w.date) <= 4 && Math.abs(r.amount - w.amount) <= tol && named(r))
      ?? (w.source === 'copilot' ? charges.find((r) => days(r.date, w.date) <= 1 && k && r.name.toLowerCase().includes(k)) : undefined);
    if (!f) continue;
    taken.add(f.id);
    patch.set(w.id, { pairedWith: f.id });
    patch.set(f.id, { via: 'PayPal', ...(/paypal/i.test(f.name) && !/paypal/i.test(w.name) && { name: w.name }) });
  }
  return rows.map((r) => (patch.has(r.id) ? { ...r, ...patch.get(r.id) } : r));
}

// Recurring charges, derived from transactions tagged with a recurring name.
const FREQUENCIES = [[7, 'Weekly'], [14, 'Biweekly'], [30, 'Monthly'], [61, 'Bimonthly'], [91, 'Quarterly'], [182, 'Semiannually'], [365, 'Annually']];
const addDays = (date, n) => new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);
const addMonths = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); // Jan 31 + 1 month = Feb 28, not Mar 3
  return d.toISOString().slice(0, 10);
};

// `known` = Copilot's recurrings export ({name, frequency, state}); the user curated those, so they win over guesses.
// `schedules` = payments the app adds itself (e.g. a laptop spread over 12 months); they know their own next date and end.
export function buildRecurrings(rows, today, known = [], schedules = []) {
  const meta = new Map(known.map((k) => [k.name, k]));
  const done = new Map(schedules.map((s) => [s, s.match ? billPaid(s, rows) : s.generated]));
  // Several schedules can feed one recurring (Daily Cash on the 20th and the 25th); the soonest one speaks for it.
  const scheduleByName = new Map();
  for (const s of schedules) {
    const cur = scheduleByName.get(s.name);
    if (!cur || scheduleDate(s, done.get(s)) < scheduleDate(cur, done.get(cur))) scheduleByName.set(s.name, s);
  }
  const groups = new Map();
  // A PayPal copy (pairedWith) is the same charge as its card row; count the charge once.
  for (const t of rows) if (t.recurring && !t.pairedWith) (groups.get(t.recurring) ?? groups.set(t.recurring, []).get(t.recurring)).push(t);
  for (const s of schedules) {
    if (groups.has(s.name)) continue;
    groups.set(s.name, [{ id: `schedule:${s.id}`, date: scheduleDate(s, 0), name: s.name, amount: s.amount, account: s.account, category: s.category || 'Uncategorized', upcoming: true }]);
  }

  return [...groups].map(([name, list]) => {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const dates = [...new Set(list.map((t) => t.date))];
    const gaps = dates.slice(1).map((d, i) => days(d, dates[i])).sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 30;
    const set = FREQUENCIES.find(([, f]) => f.toUpperCase() === meta.get(name)?.frequency);
    const [interval, frequency] = set ?? FREQUENCIES.reduce((best, f) => (Math.abs(f[0] - median) < Math.abs(best[0] - median) ? f : best));
    const last = list.at(-1);
    const months = { 30: 1, 61: 2, 91: 3, 182: 6, 365: 12 }[interval];
    const next = months ? addMonths(last.date, months) : addDays(last.date, interval);
    const recent = list.slice(-3);
    const yearAgo = addDays(today, -365);
    const sched = scheduleByName.get(name);
    const remaining = sched && (sched.count == null ? Infinity : sched.count - done.get(sched));
    return {
      name,
      category: last.category,
      account: last.account,
      frequency,
      lastDate: last.date,
      lastAmount: last.amount,
      avgAmount: recent.reduce((s, t) => s + t.amount, 0) / recent.length,
      nextDate: sched ? (remaining > 0 ? scheduleDate(sched, done.get(sched)) : last.date) : next,
      // Inactive once a payment is overdue by more than half its cycle.
      active: sched ? remaining > 0 : meta.get(name)?.state !== 'ARCHIVED' && (days(next, today) <= interval / 2 || next >= today),
      monthPaid: list.filter((t) => t.date.startsWith(today.slice(0, 7))).reduce((s, t) => s + t.amount, 0),
      yearTotal: list.filter((t) => t.date >= yearAgo).reduce((s, t) => s + t.amount, 0),
      count: list.length,
      schedule: sched ? { id: sched.id, bill: !!sched.match, account: sched.account, amount: sched.amount, count: sched.count, remaining: remaining === Infinity ? null : remaining, endDate: sched.count == null ? null : scheduleDate(sched, sched.count - 1) } : null,
      transactions: list.slice(-12).reverse().map(({ id, date, name: n, amount, account }) => ({ id, date, name: n, amount, account })),
    };
  }).sort((a, b) => a.nextDate.localeCompare(b.nextDate));
}

// Things worth a look. Ids are stable (category + month, transaction id, recurring + date) so a dismissed or
// already-notified alert stays that way.
const usd = (n) => `$${n.toFixed(2)}`;
const LARGE_MIN = 150; // a "large charge" is at least this, and well above the category's own big charges
const OVER_MIN = 10; // cents-level overruns aren't worth an alert
// A statement is paid once a payment at least as big as it arrived on or after the statement date.
export const statementPaid = (c) => !(c.statement_balance > 0)
  || (c.last_payment_date >= c.statement_date && c.last_payment >= c.statement_balance - 0.01);

export function buildAlerts({ rows, recurrings, budgets, cards = [], today }) {
  const out = [];
  const month = today.slice(0, 7);
  const spend = rows.filter((t) => t.type === 'regular' && !t.excluded);

  const spentBy = new Map(), flexible = new Set();
  for (const t of spend) {
    if (!t.date.startsWith(month)) continue;
    spentBy.set(t.category, (spentBy.get(t.category) ?? 0) + t.amount);
    if (!t.recurring) flexible.add(t.category);
  }
  for (const { category, amount } of budgets) {
    const spent = spentBy.get(category) ?? 0;
    const base = { kind: 'budget', date: today, link: 'categories', detail: `${usd(spent)} of ${usd(amount)} this month` };
    // "Near" only matters where there's discretionary spending; rent sitting at 100% is the plan, not news.
    if (spent - amount >= OVER_MIN) out.push({ ...base, id: `budget-over:${category}:${month}`, severity: 'critical', title: `${category} is over budget by ${usd(spent - amount)}` });
    else if (spent <= amount && spent >= 0.9 * amount && flexible.has(category)) out.push({ ...base, id: `budget-near:${category}:${month}`, severity: 'warning', title: `${category} is at ${Math.round((spent / amount) * 100)}% of its budget` });
  }

  // One-off charges above 1.25x the category's 95th percentile over the last year (recurring charges have their own
  // alerts). Against the median, every big grocery run would count.
  const yearAgo = addDays(today, -365), since = addDays(today, -14);
  const usual = new Map();
  for (const t of spend) if (!t.recurring && t.amount > 0 && t.date >= yearAgo) (usual.get(t.category) ?? usual.set(t.category, []).get(t.category)).push(t);
  for (const t of spend) {
    if (t.recurring || t.date < since || t.amount < LARGE_MIN) continue;
    const others = (usual.get(t.category) ?? []).filter((o) => o.id !== t.id).map((o) => o.amount).sort((a, b) => a - b);
    const p95 = others.length ? others[Math.min(others.length - 1, Math.floor(others.length * 0.95))] : 0; // few rows: the max
    if (p95 && t.amount < 1.25 * p95) continue;
    out.push({ id: `large:${t.id}`, kind: 'large', severity: 'warning', date: t.date, link: 'transactions', title: `Large charge: ${t.name}`,
      detail: `${usd(t.amount)} · ${t.category}${p95 ? ` · your big ones are usually up to ${usd(p95)}` : ''} · ${t.account}` });
  }

  for (const r of recurrings) {
    // A bill you pay yourself: from the day before it's due until a payment shows up, on either side (PayPal shows the
    // payment days before the bank debit posts). Critical once it's 5+ days late.
    const b = r.schedule?.bill && r.active && today >= addDays(r.nextDate, -1) ? r.schedule : null;
    const owed = b && Math.min(b.amount, cards.find((c) => c.name === b.account)?.balance ?? Infinity);
    if (owed > 0) {
      out.push({ id: `bill:${b.id}:${r.nextDate}`, kind: 'bill', severity: today > addDays(r.nextDate, 4) ? 'critical' : 'warning',
        date: r.nextDate, link: 'recurrings', title: `Pay ${b.account} ${usd(owed)}`,
        detail: `${r.name} · payment ${b.count - b.remaining + 1} of ${b.count} · it doesn't charge you automatically` });
    }
    if (!r.active || r.schedule) continue;
    // Price change: the last charge differs from two identical ones before it (a bill that varies never qualifies).
    const [last, prev, prev2] = r.transactions;
    if (prev2 && cents(prev.amount) === cents(prev2.amount) && cents(last.amount) !== cents(prev.amount) && last.date >= addDays(today, -45)) {
      out.push({ id: `price:${r.name}:${last.date}`, kind: 'price', severity: 'warning', date: last.date, link: 'recurrings',
        title: `${r.name} ${Math.abs(last.amount) > Math.abs(prev.amount) ? 'went up' : 'went down'}`, detail: `${usd(prev.amount)} → ${usd(last.amount)}` });
    }
    // Missing: a monthly charge 5+ days late (after half a cycle it counts as stopped and goes inactive).
    if (r.frequency === 'Monthly' && r.nextDate < addDays(today, -5)) {
      out.push({ id: `missed:${r.name}:${r.nextDate}`, kind: 'missed', severity: 'warning', date: r.nextDate, link: 'recurrings',
        title: `${r.name} hasn't shown up`, detail: `Expected ${r.nextDate}, usually ${usd(r.avgAmount)}` });
    }
  }
  // Card payments: overdue (the bank's flag) or due within 5 days and the statement isn't paid yet.
  for (const c of cards) {
    if (!c.due_date || statementPaid(c)) continue;
    const base = { kind: 'card', date: c.due_date, link: `accounts/${c.account_id}`, detail: `Statement ${usd(c.statement_balance)}, minimum ${usd(c.minimum ?? 0)}` };
    if (c.overdue || c.due_date < today) out.push({ ...base, id: `card-overdue:${c.account_id}:${c.due_date}`, severity: 'critical', title: `${c.name} payment is overdue` });
    else if (c.due_date <= addDays(today, 5)) out.push({ ...base, id: `card-due:${c.account_id}:${c.due_date}`, severity: 'warning', title: `${c.name} payment due ${c.due_date}` });
  }
  // Monthly review: the first week of a month points at last month's report.
  if (Number(today.slice(8, 10)) <= 7) {
    const last = addMonths(`${month}-01`, -1).slice(0, 7);
    const name = new Date(`${last}-15T12:00:00`).toLocaleString('en-US', { month: 'long' });
    out.push({ id: `report:${last}`, kind: 'report', severity: 'info', date: `${month}-01`, link: `report/${last}`,
      title: `Your ${name} review is ready`, detail: 'Savings vs goal, budget scorecard, biggest changes' });
  }
  // Weekly recap: Monday to Wednesday point at the week that just ended (Monday to Sunday).
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  if (dow >= 1 && dow <= 3) {
    const start = addDays(today, -(dow - 1) - 7);
    out.push({ id: `recap:${start}`, kind: 'recap', severity: 'info', date: today, link: `recap/${start}`,
      title: 'Your weekly recap is ready', detail: 'What you spent, day by day, and what is coming up' });
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.date.localeCompare(a.date));
}

// Payments made on a bill you pay yourself: the bank debits it claimed, or the card's own payment credits when those
// post first.
export function billPaid(s, rows) {
  const from = addDays(s.start_date, -10);
  const debits = rows.filter((r) => r.recurring === s.name && r.account !== s.account).length;
  const credits = rows.filter((r) => r.account === s.account && r.amount < 0 && r.date >= from).length;
  return Math.min(Math.max(debits, credits), s.count ?? Infinity);
}

// Financial health checks, numbers only (the page words and formats them, so hidden amounts stay hidden). Ratios use
// the last three full months, so a half-finished month doesn't skew them. `cash` = cash you could reach (bank +
// brokerage cash), `checking` = checking balances (earning ~0%).
// cashApy: the yearly rate where idle checking money would go (a setting), for the "you'd earn $X a year" figure.
export function buildHealth({ rows, budget, saveTarget, cash, checking, cards = [], today, cashApy = 0.04 }) {
  const month = today.slice(0, 7);
  const months = [1, 2, 3].map((n) => addMonths(`${month}-01`, -n).slice(0, 7));
  const spend = rows.filter((t) => t.type === 'regular' && !t.excluded);
  const total = (list, m) => list.filter((t) => (m ? t.date.startsWith(m) : months.includes(t.date.slice(0, 7)))).reduce((a, t) => a + t.amount, 0);
  const income = -total(rows.filter((t) => t.type === 'income')) / 3;
  if (income <= 0) return []; // no income in the last three months yet: too little data to judge anything
  const spent = total(spend) / 3;
  const of = (cats) => total(spend.filter((t) => cats.includes(t.category))) / 3;
  const [last] = months;
  const lastIncome = -total(rows.filter((t) => t.type === 'income'), last), lastSpent = total(spend, last);
  // Rent is this month's (or last month's) payment, not an average: a move overlaps two leases for a while.
  const rentRows = spend.filter((t) => t.category === 'Rent');
  const rent = total(rentRows, month) || total(rentRows, last), car = of(['Car', 'Gas', 'Tolls']);
  const thisSpent = total(spend, month);
  const unpaid = cards.filter((c) => c.due_date && c.due_date < today && !statementPaid(c));
  const idle = Math.max(0, checking - spent); // keep one month of spending in checking
  return [
    { id: 'save', ok: income - spent >= saveTarget, actual: income - spent, target: saveTarget },
    { id: 'earn', ok: lastSpent <= lastIncome, actual: lastSpent, target: lastIncome, month: last },
    { id: 'budget', ok: thisSpent <= budget, actual: thisSpent, target: budget, month },
    { id: 'housing', ok: income > 0 && rent / income <= 0.3, actual: rent, target: 0.3 * income, share: income > 0 ? rent / income : null },
    { id: 'car', ok: income > 0 && car / income <= 0.2, actual: car, target: 0.2 * income, share: income > 0 ? car / income : null },
    { id: 'cushion', ok: cash >= 3 * spent, actual: cash, target: 3 * spent },
    { id: 'idle', ok: checking <= 1.5 * spent, actual: checking, target: spent, move: idle, yearly: idle * cashApy },
    { id: 'cards', ok: unpaid.length === 0, actual: unpaid.length, cards: unpaid.map((c) => c.name) },
  ];
}

// Occurrence i of a schedule (0-based).
export const scheduleDate = (s, i) => {
  const step = { monthly: [1, 0], annually: [12, 0], weekly: [0, 7], biweekly: [0, 14] }[s.frequency] ?? [1, 0];
  return step[0] ? addMonths(s.start_date, step[0] * i) : addDays(s.start_date, step[1] * i);
};

// Due occurrences that haven't been added yet, as manual transactions. Deleting one later doesn't bring it back,
// because `generated` only moves forward.
export function dueOccurrences(schedule, today) {
  const out = [];
  for (let i = schedule.generated; schedule.count == null || i < schedule.count; i++) {
    const date = scheduleDate(schedule, i);
    if (date > today) break;
    out.push({ index: i, date });
  }
  return out;
}

export function loadLedger(db) {
  return buildLedger({
    // Non-USD rows (PayPal pays some merchants in MXN) in dollars at that day's rate, kept as `foreign` for display.
    plaid: db.prepare(`SELECT t.*, a.mask, a.name AS account, CASE WHEN coalesce(t.currency, 'USD') = 'USD' THEN NULL
        ELSE (SELECT price FROM prices p WHERE p.asset = t.currency AND p.date <= t.date ORDER BY p.date DESC LIMIT 1) END AS fx
      FROM transactions t JOIN accounts a USING (account_id)`).all()
      .map((t) => (t.fx ? { ...t, foreign: `${t.amount} ${t.currency}`, amount: Math.round(t.amount * t.fx * 100) / 100 } : t)),
    // ponytail: Copilot rows are keyed by rowid, so re-importing the CSV orphans edits made on history rows
    copilot: db.prepare('SELECT rowid, * FROM copilot_transactions').all(),
    manual: db.prepare('SELECT * FROM manual_transactions').all(),
    rules: db.prepare('SELECT * FROM rules ORDER BY id').all(),
    edits: db.prepare('SELECT * FROM edits').all(),
    schedules: db.prepare('SELECT * FROM schedules').all(),
    wallets: new Set(db.prepare("SELECT name FROM accounts WHERE type = 'depository' AND subtype = 'paypal'").all().map((a) => a.name)),
    tagRenames: JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'tag_renames'").get()?.value ?? '{}'),
    userSplits: db.prepare("SELECT * FROM splits").all(),
    aliases: new Map(db.prepare('SELECT alias, name FROM manual_accounts WHERE alias IS NOT NULL').all().map((a) => [a.alias, a.name])),
  });
}

// Self-check for the pure parts: node ledger.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert/strict')).default;
  const acct = { mask: '2000', account: 'Gold' };
  const plaid = [
    { transaction_id: 'p1', date: '2026-01-10', name: 'NETFLIX', merchant: 'Netflix', amount: 9.99, category: 'ENTERTAINMENT', pending: 0, ...acct },
    { transaction_id: 'p2', date: '2026-02-10', name: 'NETFLIX', merchant: 'Netflix', amount: 9.99, category: 'ENTERTAINMENT', pending: 0, ...acct },
    { transaction_id: 'p3', date: '2026-02-12', name: 'TACOS', merchant: null, amount: 20, category: 'FOOD_AND_DRINK', pending: 0, ...acct },
  ];
  const cp = (rowid, date, name, amount, extra = {}) => ({ rowid, date, name, amount, status: 'posted', category: 'Subscriptions', excluded: 'false', tags: '', type: 'regular', account: 'Gold', account_mask: '2000', note: '', recurring: 'Netflix', ...extra });
  const copilot = [cp(1, '2025-12-10', 'Netflix', 9.99), cp(2, '2026-01-14', 'Netflix', 9.99)]; // row 2 is p1, dated 4 days off
  const { rows } = buildLedger({
    plaid, copilot,
    manual: [{ id: 1, date: '2026-02-01', name: 'Cash tip', amount: 5, account: 'Cash', category: 'Restaurants', type: 'regular', tags: '["Partner"]', note: null }],
    rules: [{ id: 1, match: 'taco', category: 'Restaurants', tags: '["Partner"]' }],
    edits: [{ id: 'p2', name: null, category: null, type: null, excluded: null, note: 'split', tags: null, recurring: null, reviewed: 1 }],
  });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(rows.length, 5, 'p1 absorbs copilot row 2; history row 1, p2, p3, manual remain');
  assert.equal(byId.p1.category, 'Subscriptions');
  assert.equal(byId.p2.category, 'Subscriptions', 'learned from matched pair');
  assert.equal(byId.p2.recurring, 'Netflix');
  assert.equal(byId.p2.note, 'split');
  assert.equal(byId.p3.category, 'Restaurants', 'rule');
  assert.deepEqual(byId.p3.tags, ['Partner']);
  assert.equal(byId.p3.reviewed, false);
  const [netflix] = buildRecurrings(rows, '2026-02-20');
  assert.equal(netflix.frequency, 'Monthly');
  assert.equal(netflix.nextDate, '2026-03-10');
  assert.equal(netflix.monthPaid, 9.99);
  const [annual] = buildRecurrings(rows, '2026-02-20', [{ name: 'Netflix', frequency: 'ANNUALLY', state: 'ACTIVE' }]);
  assert.equal(annual.nextDate, '2027-02-10');
  assert.equal(buildRecurrings(rows, '2026-02-20', [{ name: 'Netflix', state: 'ARCHIVED' }])[0].active, false);
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  const mac = { id: 1, name: 'Laptop', amount: 108, account: 'Apple Card', frequency: 'monthly', start_date: '2026-11-01', count: 8, generated: 0 };
  assert.deepEqual(dueOccurrences(mac, '2026-10-28'), []);
  assert.deepEqual(dueOccurrences(mac, '2026-12-05').map((o) => o.date), ['2026-11-01', '2026-12-01']);
  assert.equal(dueOccurrences({ ...mac, generated: 8 }, '2030-01-01').length, 0, 'stops after count');
  assert.equal(scheduleDate(mac, 7), '2027-06-01');
  const withMac = buildRecurrings([...rows, { id: 'm', date: '2026-10-01', name: 'Laptop', amount: 108, account: 'Apple Card', category: 'Shops', recurring: 'Laptop' }], '2026-10-28', [], [mac]);
  const macRec = withMac.find((r) => r.name === 'Laptop');
  assert.equal(macRec.nextDate, '2026-11-01');
  assert.deepEqual(macRec.schedule, { id: 1, bill: false, account: 'Apple Card', amount: 108, count: 8, remaining: 8, endDate: '2027-06-01' });
  const catRule = buildLedger({ plaid: [], copilot: [], manual: [{ id: 2, date: '2026-01-01', name: 'Clinic', amount: 50, account: 'Cash', category: 'Healthcare', type: 'regular', tags: '[]' }],
    rules: [{ id: 2, field: 'category', match: 'healthcare', category: null, tags: '["HSA eligible"]' }] });
  assert.deepEqual(catRule.rows[0].tags, ['HSA eligible']);
  const minus = buildLedger({ plaid: [], copilot: [], manual: [{ id: 3, date: '2026-01-01', name: 'Rideshare', amount: 5, account: 'Cash', category: 'Transportation', type: 'regular', tags: '[]' }],
    rules: [{ id: 5, match: 'rideshare', tags: '["Partner","-Essential"]' }, { id: 6, field: 'category', match: 'transportation', tags: '["Essential"]' }] });
  assert.deepEqual(minus.rows[0].tags, ['Partner'], '"-Essential" beats the category rule');
  const firstDay = buildLedger({ plaid: [plaid[2]], copilot: [cp(9, '2026-02-12', 'Flight Club', 170.73)] }).rows;
  assert.equal(firstDay.length, 2, "an unmatched Copilot row on Plaid's first day is kept");
  const zelle = (id, date, amount) => ({ transaction_id: id, date, name: 'Zelle to Landlord', merchant: null, amount, category: 'TRANSFER_OUT', pending: 0, ...acct });
  const rent = buildLedger({ plaid: [zelle('z1', '2026-01-01', 2500), zelle('z2', '2026-02-01', 2600)],
    copilot: [cp(3, '2026-01-01', 'Zelle', 2500, { category: 'Rent', recurring: '' })] }).rows.find((r) => r.id === 'z2');
  assert.deepEqual([rent.category, rent.type, rent.excluded], ['Rent', 'regular', false], 'learned type beats TRANSFER_OUT');
  const split = buildLedger({
    plaid: [zelle('z3', '2026-08-25', 4167), { ...zelle('o1', '2026-04-02', -50), name: 'EDI RMR*IV*US100000000001' }, { ...zelle('o2', '2026-04-06', -50), name: 'EDI RMR*IV*US100000000002' }],
    copilot: [cp(4, '2026-08-25', 'Rent part', 2500, { category: 'Rent' }), cp(5, '2026-09-01', 'Rent part', 1667, { category: 'Rent' }),
      cp(6, '2026-03-25', 'Edi Rmr*iv*us100000000001', -50, { note: 'march' }), cp(8, '2026-04-03', 'Edi Rmr*iv*us100000000002', -50, { note: 'january' })],
  });
  assert.deepEqual(split.rows.filter((r) => r.source === 'split').map((r) => r.amount).sort(), [1667, 2500], 'split replaces the Plaid row');
  assert.equal(split.rows.find((r) => r.id === 'o1').note, 'march', 'reference number beats the nearer date');
  const p2p = buildLedger({
    plaid: [{ ...zelle('z4', '2026-01-01', 20), name: 'Zelle to Ana' }, { ...zelle('z5', '2026-02-01', 30), name: 'Zelle to Bob' }],
    copilot: [cp(7, '2026-01-01', 'Zelle', 20, { category: 'Restaurants' })],
    rules: [{ id: 3, match: 'landlord', category: 'Rent', tags: '[]' }],
  }).rows.find((r) => r.id === 'z5');
  assert.deepEqual([p2p.category, p2p.type], ['Uncategorized', 'regular'], 'new Zelle payee follows past Zelle habits');
  const ruled = buildLedger({ plaid: [{ ...zelle('z6', '2026-03-01', 2500), name: 'Zelle to New Landlord' }], copilot: [],
    rules: [{ id: 4, match: 'new landlord', category: 'Rent', tags: '[]' }] }).rows[0];
  assert.deepEqual([ruled.category, ruled.type, ruled.excluded], ['Rent', 'regular', false], 'rule category makes a transfer spending');
  const userSplit = buildLedger({ plaid: [{ ...plaid[2], amount: 100 }], copilot: [],
    userSplits: [{ parent_id: 'p3', idx: 0, name: 'Clinic', amount: 50 }, { parent_id: 'p3', idx: 1, name: null, amount: 50 }],
    edits: [{ id: 'p3#0', category: 'Healthcare' }] }).rows;
  assert.deepEqual(userSplit.map((r) => [r.id, r.name, r.amount, r.category]), [['p3#0', 'Clinic', 50, 'Healthcare'], ['p3#1', 'TACOS', 50, 'Restaurants']]);
  const tx = (id, date, name, amount, category, extra = {}) => ({ id, date, name, amount, category, type: 'regular', excluded: false, recurring: null, account: 'Gold', ...extra });
  const alertRows = [
    tx('g1', '2026-10-02', 'Grocer', 300, 'Groceries'), tx('g2', '2026-10-20', 'Grocer', 160, 'Groceries'),
    tx('h1', '2026-06-01', 'Target', 40, 'Home'), tx('h2', '2026-07-01', 'Target', 50, 'Home'), tx('h3', '2026-10-25', 'Sofa', 900, 'Home'),
    ...['2026-07-24', '2026-08-24', '2026-09-24'].map((d, i) => tx(`n${i}`, d, 'Netflix', 9.73, 'Subscriptions', { recurring: 'Netflix' })),
    tx('n3', '2026-10-24', 'Netflix', 11.99, 'Subscriptions', { recurring: 'Netflix' }),
    ...['2026-07-17', '2026-08-17', '2026-09-17'].map((d, i) => tx(`q${i}`, d, 'Clinic', 50, 'Healthcare', { recurring: 'Clinic' })),
  ];
  const alerts = buildAlerts({ rows: alertRows, recurrings: buildRecurrings(alertRows, '2026-10-29'),
    budgets: [{ category: 'Groceries', amount: 450 }, { category: 'Home', amount: 1000 }], today: '2026-10-29' });
  assert.deepEqual(alerts.map((a) => a.id).sort(), ['budget-near:Home:2026-10', 'budget-over:Groceries:2026-10', 'large:h3', 'missed:Clinic:2026-10-17', 'price:Netflix:2026-10-24'].sort());
  assert.equal(alerts[0].severity, 'critical', 'over budget first');
  const card = { account_id: 'c1', name: 'Gold', due_date: '2026-11-02', statement_balance: 500, minimum: 40, statement_date: '2026-10-05', last_payment: 300, last_payment_date: '2026-10-20' };
  assert.deepEqual(buildAlerts({ rows: [], recurrings: [], budgets: [], cards: [card], today: '2026-10-29' }).map((a) => a.id), ['card-due:c1:2026-11-02'], 'partial payment: still due');
  assert.equal(buildAlerts({ rows: [], recurrings: [], budgets: [], cards: [{ ...card, last_payment: 500 }], today: '2026-10-29' }).length, 0, 'paid in full');
  assert.deepEqual(buildAlerts({ rows: [], recurrings: [], budgets: [], today: '2026-11-01' }).map((a) => a.link), ['report/2026-10'], 'review on the 1st');
  // A bill you pay yourself: the bank debit is the spending, the card's own credit counts as paid, alerts until paid.
  const desk = { id: 9, name: 'Desk', amount: 100, account: 'PayPal Credit', category: 'Home', frequency: 'monthly', start_date: '2026-10-01', count: 6, generated: 0, match: 'paypal inst xfer' };
  const mt = (id, date, name, amount, account, type = 'internal transfer') => ({ id, date, name, amount, account, category: 'Travel & Vacation', type });
  const billManual = [mt(1, '2026-10-02', 'Payment to PayPal Credit', -100, 'PayPal Credit'), mt(2, '2026-10-05', 'PAYPAL INST XFER', 100, 'Spending Account'),
    mt(3, '2026-10-06', 'PAYPAL INST XFER~ Future Amount: 9.37', 9.37, 'Spending Account', 'regular'), mt(4, '2026-03-03', 'PAYPAL INST XFER', 100, 'Spending Account', 'regular')];
  const billRows = buildLedger({ plaid: [], copilot: [], schedules: [desk], manual: billManual }).rows;
  const byManual = Object.fromEntries(billRows.map((r) => [r.id, [r.category, r.type, r.excluded, r.recurring]]));
  assert.deepEqual(byManual['manual:2'], ['Home', 'regular', false, 'Desk'], 'the debit is Home spending');
  assert.deepEqual(byManual['manual:3'].slice(3), [null], 'small same-name debit is not claimed');
  assert.deepEqual(byManual['manual:4'], ['Travel & Vacation', 'regular', false, null], 'history before the plan untouched');
  const billAlerts = (rows, today, cards = []) => buildAlerts({ rows, recurrings: buildRecurrings(rows, today, [], [desk]), budgets: [], cards, today }).filter((a) => a.kind === 'bill');
  const deskRec = buildRecurrings(billRows, '2026-10-29', [], [desk]).find((r) => r.name === 'Desk');
  assert.deepEqual([deskRec.nextDate, deskRec.schedule.remaining], ['2026-11-01', 5]);
  assert.equal(billAlerts(billRows, '2026-10-29').length, 0, 'not yet');
  assert.deepEqual(billAlerts(billRows, '2026-10-31').map((a) => [a.id, a.severity, a.title]), [['bill:9:2026-11-01', 'warning', 'Pay PayPal Credit $100.00']]);
  assert.equal(billAlerts(billRows, '2026-11-06')[0].severity, 'critical');
  assert.equal(billAlerts(billRows, '2026-10-31', [{ name: 'PayPal Credit', balance: 71.56 }])[0].title, 'Pay PayPal Credit $71.56', 'last one is what is left');
  const paidNov = buildLedger({ plaid: [], copilot: [], schedules: [desk], manual: [...billManual, mt(5, '2026-11-01', 'Payment to PayPal Credit', -100, 'PayPal Credit')] }).rows;
  assert.equal(billAlerts(paidNov, '2026-11-02').length, 0, 'the card credit clears it before the bank debit posts');
  // Health: three full months of $8k income and $6k spending (rent $2.5k), $5k in checking.
  const hRows = ['2026-07', '2026-08', '2026-09'].flatMap((m, i) => [
    tx(`i${i}`, `${m}-15`, 'Employer', -8000, 'Income', { type: 'income' }), tx(`r${i}`, `${m}-02`, 'Rent', 2500, 'Rent'), tx(`s${i}`, `${m}-10`, 'Shop', 3500, 'Shops')]);
  const health = Object.fromEntries(buildHealth({ rows: hRows, budget: 5000, saveTarget: 1000, cash: 20000, checking: 10000, cards: [{ ...card, name: 'Gold', due_date: '2026-10-20' }], today: '2026-10-29' }).map((c) => [c.id, c]));
  assert.deepEqual([health.save.ok, health.save.actual], [true, 2000]);
  assert.equal(health.earn.ok, true);
  assert.deepEqual([health.housing.ok, Math.round(health.housing.share * 1000)], [false, 313], 'rent 31% of income');
  assert.deepEqual([health.cushion.ok, health.idle.ok, health.idle.move], [true, false, 4000], '10k checking vs 6k/month: move the 4k above a month');
  assert.deepEqual(health.cards.cards, ['Gold'], 'past due and short of the statement');
  const carried = buildLedger({ plaid: [plaid[0]], copilot: [copilot[1]], edits: [{ id: 'copilot:2', excluded: 1 }] }).rows[0];
  assert.deepEqual([carried.id, carried.excluded], ['p1', true], 'an edit on the Copilot row follows its Plaid match');
  const fx = buildLedger({ plaid: [{ ...plaid[2], amount: 112.21, foreign: '2000 MXN' }], copilot: [cp(9, '2026-02-12', 'Tacos', 111.09, { category: 'Gifts' })] }).rows;
  assert.deepEqual(fx.map((r) => [r.amount, r.category]), [[112.21, 'Gifts']], 'a converted amount matches Copilot within 3%');
  assert.deepEqual(buildAlerts({ rows: [], recurrings: [], budgets: [], today: '2026-11-03' }).map((a) => a.link), ['recap/2026-10-26', 'report/2026-10'], 'Tuesday: last week');
  const wallet = buildLedger({ plaid: [], copilot: [], wallets: new Set(['PayPal']), manual: [
    { id: 7, date: '2025-03-15', name: 'eBay', amount: 343.19, account: 'PayPal', category: 'Shops', type: 'regular', tags: '[]' },
    { id: 8, date: '2025-03-15', name: 'Refund', amount: -20, account: 'PayPal', category: 'Shops', type: 'regular', tags: '[]' }] }).rows;
  assert.deepEqual(wallet.map((r) => r.excluded), [true, true], 'wallet purchases and refunds count on the funding card');
  const paired = buildLedger({ plaid: [], copilot: [], wallets: new Set(['PayPal']), manual: [
    { id: 20, date: '2026-01-26', name: 'Streamly', amount: 8.58, account: 'PayPal', category: 'Subscriptions', type: 'regular', tags: '[]' },
    { id: 21, date: '2026-01-27', name: 'PAYPAL INST XFER~ Future Amount: 8.96', amount: 8.96, account: 'Spending', category: 'Subscriptions', type: 'regular', tags: '[]' },
    { id: 22, date: '2026-01-27', name: 'Grocer', amount: 8.58, account: 'Amex', category: 'Groceries', type: 'regular', tags: '[]' }] }).rows;
  // 8.96 vs 8.58 is outside a cent: only a converted (foreign) amount gets 5%, so this pairs nothing ...
  assert.ok(paired.every((r) => !r.via && !r.pairedWith), 'different amounts, no foreign currency: no pair');
  const paired2 = buildLedger({ plaid: [], copilot: [], wallets: new Set(['PayPal']), manual: [
    { id: 20, date: '2026-01-26', name: 'Streamly', amount: 8.58, account: 'PayPal', category: 'Subscriptions', type: 'regular', tags: '[]' },
    { id: 21, date: '2026-01-27', name: 'PAYPAL INST XFER', amount: 8.58, account: 'Spending', category: 'Subscriptions', type: 'regular', tags: '[]' },
    { id: 22, date: '2026-01-26', name: 'Grocer', amount: 8.58, account: 'Amex', category: 'Groceries', type: 'regular', tags: '[]' }] }).rows;
  const byM = Object.fromEntries(paired2.map((r) => [r.id, r]));
  assert.deepEqual([byM['manual:20'].pairedWith, byM['manual:21'].via, byM['manual:21'].name, byM['manual:22'].via], ['manual:21', 'PayPal', 'Streamly', undefined],
    'pairs with the PayPal debit, not a same-amount grocery run');
  const catMinus = buildLedger({ plaid: [], copilot: [], manual: [{ id: 30, date: '2026-01-01', name: 'Gift card', amount: 20, account: 'Cash', category: 'Gifts', type: 'regular', tags: '["Lifestyle","Partner"]' }],
    rules: [{ id: 9, field: 'category', match: 'gifts', tags: '["Social","-Lifestyle"]' }] }).rows[0];
  assert.deepEqual(catMinus.tags, ['Partner', 'Social'], 'a category rule can remove a tag too');
  const renamedTags = buildLedger({ plaid: [], copilot: [], tagRenames: { Freelance: 'Business', Old: '' }, manual: [
    { id: 31, date: '2026-01-01', name: 'Hosting', amount: 9, account: 'Cash', category: 'Work Expenses', type: 'regular', tags: '["Freelance","Business","Old"]' }] }).rows[0];
  assert.deepEqual(renamedTags.tags, ['Business'], 'merge Freelance into Business, delete Old');
  assert.deepEqual(buildHealth({ rows: [], budget: 0, saveTarget: 0, cash: 0, checking: 0, today: '2026-10-29' }), [], 'a new install has no checks yet');
  console.log('ledger self-check ok');
}

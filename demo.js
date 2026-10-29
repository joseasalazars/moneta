// Sample data for `npm run demo`: a made-up person's last 14 months, so the app can be tried (and screenshotted)
// without Plaid keys or anyone's real finances. Everything goes in as manual accounts, transactions and positions,
// generated from a fixed seed relative to today, so every run looks the same apart from the dates.
const MONTHS = 14;

// Small deterministic random generator (mulberry32), so the demo doesn't change between runs.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (date, n) => iso(new Date(Date.parse(date) + n * 86400000));
const round = (n) => Math.round(n * 100) / 100;

export function seedDemo(db) {
  const rand = rng(42);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const between = (lo, hi) => round(lo + rand() * (hi - lo));
  const today = iso(new Date());
  const start = iso(new Date(new Date().getFullYear(), new Date().getMonth() - MONTHS, 1));
  const now = new Date().toISOString();

  const accounts = [
    ['Everyday Checking', 'depository', 'checking', 4210.55],
    ['High-Yield Savings', 'depository', 'savings', 18450],
    ['Rewards Card', 'credit', 'credit card', 1243.18],
    ['Brokerage', 'investment', 'brokerage', 0],
    ['Roth IRA', 'investment', 'roth', 0],
    ['Car Loan', 'loan', 'auto', 11850],
  ];
  const addAccount = db.prepare('INSERT INTO manual_accounts (name, type, subtype, balance, updated_at) VALUES (?, ?, ?, ?, ?)');
  const ids = {};
  for (const [name, type, subtype, balance] of accounts) ids[name] = `manual:${addAccount.run(name, type, subtype, balance, now).lastInsertRowid}`;
  db.prepare('INSERT INTO manual_accounts (name, type, subtype, balance, updated_at, asset, quantity) VALUES (?, ?, ?, 0, ?, ?, ?)')
    .run('Bitcoin', 'investment', 'crypto', now, 'BTC', 0.042);

  // Positions on the investment accounts, priced live like any manual position.
  const position = db.prepare('INSERT INTO holdings (account_id, symbol, name, type, quantity, cost_basis, price, value, as_of, manual) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)');
  for (const [acct, sym, name, type, qty, cost, price] of [
    ['Brokerage', 'VTI', 'Vanguard Total Stock Market ETF', 'etf', 62.5, 14200, 300],
    ['Brokerage', 'QQQ', 'Invesco QQQ Trust', 'etf', 18.2, 8400, 520],
    ['Brokerage', 'AAPL', 'Apple Inc.', 'equity', 25, 4300, 230],
    ['Roth IRA', 'VTI', 'Vanguard Total Stock Market ETF', 'etf', 41.3, 10100, 300],
  ]) position.run(ids[acct], sym, name, type, qty, cost, price, round(qty * price), today);

  // Transactions. Positive = money out, negative = money in (the app's convention everywhere).
  const txns = [];
  const add = (date, name, amount, account, category, extra = {}) => {
    if (date <= today) txns.push({ date, name, amount: round(amount), account, category, type: 'regular', tags: [], recurring: null, note: null, ...extra });
  };
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const day = Number(d.slice(8, 10)), dow = new Date(`${d}T12:00:00`).getDay();
    // Paycheck every other Friday, rent and bills on fixed days, savings and investing after the first paycheck.
    if (dow === 5 && Math.floor(Date.parse(d) / 86400000 / 7) % 2 === 0) add(d, 'Acme Corp Payroll', -3150, 'Everyday Checking', 'Income', { type: 'income' });
    if (day === 1) add(d, 'Maple Street Apartments', 2250, 'Everyday Checking', 'Rent', { recurring: 'Rent' });
    if (day === 4) add(d, 'City Power & Light', between(70, 145), 'Everyday Checking', 'Utilities', { recurring: 'Electricity' });
    if (day === 6) add(d, 'Fiberline Internet', 65, 'Everyday Checking', 'Utilities', { recurring: 'Internet' });
    if (day === 9) add(d, 'Cell Mobile', 45, 'Rewards Card', 'Utilities', { recurring: 'Phone' });
    if (day === 12) add(d, 'Streamflix', 15.49, 'Rewards Card', 'Subscriptions', { recurring: 'Streamflix' });
    if (day === 14) add(d, 'Tunely Music', 11.99, 'Rewards Card', 'Subscriptions', { recurring: 'Tunely' });
    if (day === 3) add(d, 'Peak Fitness', 40, 'Rewards Card', 'Sports', { recurring: 'Gym' });
    if (day === 15) add(d, 'Car Loan Payment', 385, 'Everyday Checking', 'Car', { recurring: 'Car loan' });
    if (day === 20) add(d, 'Safeway Insurance Co', 128.4, 'Everyday Checking', 'Insurance', { recurring: 'Car insurance' });
    if (day === 22) add(d, 'Rewards Card Payment', between(1100, 1700), 'Everyday Checking', 'Transfer', { type: 'internal transfer' });
    if (day === 16) add(d, 'Transfer to High-Yield Savings', 500, 'Everyday Checking', 'Transfer', { type: 'internal transfer' });
    if (day === 17) add(d, 'Roth IRA Contribution', 500, 'Everyday Checking', 'Transfer', { type: 'internal transfer' });
    // Everyday spending on the card.
    if (dow === 6 || (dow === 3 && rand() < 0.5)) add(d, pick(['Green Basket Market', 'FreshCo', 'Corner Grocer']), between(45, 165), 'Rewards Card', 'Groceries');
    if (rand() < 0.22) add(d, pick(['Luna Taqueria', 'Bistro 21', 'Noodle House', 'Pizza Palace', 'Sakura Sushi']), between(18, 85), 'Rewards Card', 'Restaurants', rand() < 0.4 ? { tags: ['Partner'] } : {});
    if (rand() < 0.18) add(d, pick(['Daily Grind Coffee', 'Bean There']), between(4.5, 9), 'Rewards Card', 'Restaurants');
    if (rand() < 0.08) add(d, pick(['Shell', 'Chevron']), between(38, 62), 'Rewards Card', 'Gas');
    if (rand() < 0.06) add(d, pick(['QuickRide', 'CityCab']), between(12, 34), 'Rewards Card', 'Transportation');
    if (rand() < 0.07) add(d, pick(['Online Marketplace', 'Home Goods Store', 'Bookshop']), between(15, 140), 'Rewards Card', 'Shops');
    if (rand() < 0.025) add(d, pick(['Threads Apparel', 'Shoe Depot']), between(35, 120), 'Rewards Card', 'Clothing');
    if (rand() < 0.02) add(d, pick(['City Pharmacy', 'Family Clinic']), between(15, 90), 'Rewards Card', 'Healthcare');
    if (rand() < 0.015) add(d, pick(['Cinema 8', 'Concert Hall']), between(25, 95), 'Rewards Card', 'Entertainment', { tags: ['Partner'] });
    if (rand() < 0.012) add(d, 'Cloud Hosting Co', between(10, 30), 'Rewards Card', 'Work Expenses', { tags: ['Side project'] });
  }
  // A couple of one-off moments: a trip, a gift, a refund.
  const mid = addDays(today, -95);
  add(mid, 'SkyHigh Airlines', 412.3, 'Rewards Card', 'Travel & Vacation', { tags: ['Partner'], note: 'Weekend trip' });
  add(addDays(mid, 6), 'Seaside Hotel', 389, 'Rewards Card', 'Travel & Vacation', { tags: ['Partner'] });
  add(addDays(today, -40), 'Birthday gift', 85, 'Rewards Card', 'Gifts');
  add(addDays(today, -5), 'ElectroMart', 780, 'Rewards Card', 'Shops', { note: 'New TV' }); // puts this month over budget
  add(addDays(today, -33), 'Online Marketplace refund', -42.99, 'Rewards Card', 'Shops');

  const tx = db.prepare('INSERT INTO manual_transactions (date, name, amount, account, category, type, note, tags, recurring) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const t of txns) tx.run(t.date, t.name, t.amount, t.account, t.category, t.type, t.note, JSON.stringify(t.tags), t.recurring);

  // Monthly contributions into the investment accounts, so the goals have progress.
  const inv = db.prepare('INSERT INTO inv_transactions (id, account_id, date, name, type, subtype, symbol, quantity, price, amount, fees) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0)');
  for (const t of txns.filter((x) => x.name === 'Roth IRA Contribution')) inv.run(`demo-roth-${t.date}`, ids['Roth IRA'], t.date, 'Contribution', 'cash', 'contribution', -500);
  for (const t of txns.filter((x) => x.name === 'Transfer to High-Yield Savings').filter((_, i) => i % 2 === 0)) inv.run(`demo-brk-${t.date}`, ids.Brokerage, addDays(t.date, 1), 'Deposit', 'cash', 'deposit', -300);

  // Balance history, so net worth and account charts have a past: steady savings, a market that wobbles upward.
  const snap = db.prepare('INSERT OR REPLACE INTO balances (account_id, date, balance) VALUES (?, ?, ?)');
  const weeks = Math.ceil((Date.parse(today) - Date.parse(start)) / (7 * 86400000));
  for (let w = 0; w <= weeks; w++) {
    const d = addDays(start, w * 7), f = w / weeks, wobble = 1 + Math.sin(w / 3) * 0.03;
    snap.run(ids['Everyday Checking'], d, round(3000 + rand() * 2200));
    snap.run(ids['High-Yield Savings'], d, round(11000 + 7450 * f));
    snap.run(ids['Rewards Card'], d, round(700 + rand() * 900));
    snap.run(ids.Brokerage, d, round((22000 + 14000 * f) * wobble));
    snap.run(ids['Roth IRA'], d, round((5200 + 7200 * f) * wobble));
    snap.run(ids['Car Loan'], d, round(17000 - 5150 * f));
  }

  // The setup a real user would make in the UI: budgets, goals, rules, a payment plan.
  const budget = db.prepare('INSERT INTO budgets (category, amount) VALUES (?, ?)');
  for (const [c, a] of [['Rent', 2250], ['Groceries', 650], ['Restaurants', 400], ['Utilities', 300], ['Car', 385], ['Insurance', 130],
    ['Gas', 120], ['Subscriptions', 40], ['Sports', 40], ['Shops', 200], ['Transportation', 60], ['Clothing', 60], ['Healthcare', 50],
    ['Entertainment', 60], ['Travel & Vacation', 150], ['Gifts', 50], ['Work Expenses', 30]]) budget.run(c, a);
  const goal = db.prepare('INSERT INTO goals (name, monthly, accounts, cash_target) VALUES (?, ?, ?, ?)');
  goal.run('Roth IRA', 500, JSON.stringify([ids['Roth IRA']]), null);
  goal.run('Brokerage', 300, JSON.stringify([ids.Brokerage]), null);
  const rule = db.prepare("INSERT INTO rules (field, match, category, tags) VALUES (?, ?, NULL, ?)");
  for (const c of ['rent', 'groceries', 'utilities', 'car', 'insurance', 'gas', 'healthcare', 'transportation']) rule.run('category', c, '["Essential"]');
  for (const c of ['restaurants', 'shops', 'clothing', 'entertainment', 'travel & vacation', 'subscriptions', 'sports', 'gifts']) rule.run('category', c, '["Lifestyle"]');
  const first = iso(new Date(new Date().getFullYear(), new Date().getMonth() - 2, 1));
  db.prepare(`INSERT INTO schedules (name, amount, account, category, tags, type, note, frequency, start_date, count, generated, affects_balance)
    VALUES ('New laptop', 125, 'Rewards Card', 'Shops', '[]', 'regular', 'Paid in full, spread over 12 months', 'monthly', ?, 12, 0, 0)`).run(first);
  return { accounts: accounts.length + 1, transactions: txns.length };
}

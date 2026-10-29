// Offline merge check against the real DB (no Plaid calls): node check-merge.js [db]
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadLedger } from './ledger.js';

const db = new DatabaseSync(process.argv[2] ?? 'ledger-production.db', { readOnly: true });
const { rows, report } = loadLedger(db);
const spend = (list) => Math.round(list.filter((r) => r.type === 'regular' && !r.excluded).reduce((s, r) => s + r.amount, 0) * 100) / 100;

for (const { mask, name, first } of db.prepare(
  'SELECT a.mask, a.name, min(t.date) AS first FROM transactions t JOIN accounts a USING (account_id) GROUP BY a.account_id').all()) {
  const key = mask || name;
  const inWindow = rows.filter((r) => (r.mask || r.account) === key && r.date > first);
  // Double-count signature: Copilot history leaking into a window Plaid already covers (after its partial first day).
  assert.equal(inWindow.filter((r) => r.source === 'copilot').length, 0, `${name}: Copilot rows inside Plaid window`);
  const copilotOnly = db.prepare("SELECT rowid, * FROM copilot_transactions WHERE ((? != '' AND account_mask = ?) OR (account_mask = '' AND account = ?)) AND date > ?").all(mask ?? '', mask ?? '', name, first);
  console.log(`${name} (${key}) since ${first}: ${inWindow.length} merged rows, spend merged $${spend(inWindow)} vs Copilot $${spend(copilotOnly.map((c) => ({ ...c, excluded: c.excluded === 'true' })))}`);
}

console.log(`matched ${report.matched}, unmatched Plaid ${report.unmatchedPlaid.length}, unmatched Copilot ${report.unmatchedCopilot.length}`);
console.log('splits:', report.splits);
console.log('unmatched Plaid:', report.unmatchedPlaid);
console.log('unmatched Copilot:', report.unmatchedCopilot);
if (report.unknownAccounts.length) console.log('WARNING linked accounts not found in Copilot export:', report.unknownAccounts);
console.log(`total ledger rows ${rows.length}`);

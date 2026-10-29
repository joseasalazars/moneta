-- Copilot Money CSV export, kept verbatim (custom categories, notes, tags, transfer flags).
-- Usage: npm run import:copilot   (re-runnable: replaces the previous import)
CREATE TABLE IF NOT EXISTS copilot_transactions (
  date TEXT, name TEXT, amount REAL, status TEXT, category TEXT, parent_category TEXT,
  excluded TEXT, tags TEXT, type TEXT, account TEXT, account_mask TEXT, note TEXT, recurring TEXT
);
DELETE FROM copilot_transactions;
.import --csv --skip 1 copilot-export/copilot-transactions.csv copilot_transactions
SELECT count(*) || ' rows, ' || min(date) || ' -> ' || max(date) FROM copilot_transactions;

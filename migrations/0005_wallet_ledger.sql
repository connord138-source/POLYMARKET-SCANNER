-- Point-in-time wallet ledger (v5)
--
-- signal_wallets: which wallets were in each signal, written at detection.
-- A wallet's record "as of" any signal is then computable from rows that
-- SETTLED BEFORE that signal was detected, so backtests never see the future.
--
-- signals_log gains the as-of score of the signal's best wallet plus the
-- canonical learning factors, so the Strategy Forge can test them directly.
--
--   wrangler d1 execute polymarket-scanner --remote --file=migrations/0005_wallet_ledger.sql

CREATE TABLE IF NOT EXISTS signal_wallets (
  signal_id    TEXT NOT NULL,
  wallet       TEXT NOT NULL,
  usd          INTEGER,            -- that wallet's fill size in the signal (NULL when backfilled)
  detected_at  TEXT,
  PRIMARY KEY (signal_id, wallet)
);
CREATE INDEX IF NOT EXISTS idx_sw_wallet ON signal_wallets(wallet);

ALTER TABLE signals_log ADD COLUMN factors TEXT;            -- JSON array of canonical factor names
ALTER TABLE signals_log ADD COLUMN wallets_logged INTEGER;  -- 1 logged, -1 unavailable (KV expired), NULL pending
ALTER TABLE signals_log ADD COLUMN wallet_best TEXT;        -- best wallet by as-of excess
ALTER TABLE signals_log ADD COLUMN wallet_best_n INTEGER;   -- its settled bets before this signal
ALTER TABLE signals_log ADD COLUMN wallet_best_excess REAL; -- its win rate minus avg entry price (pts), as of detection
ALTER TABLE signals_log ADD COLUMN wallet_scored_at TEXT;

CREATE INDEX IF NOT EXISTS idx_sig_wscore ON signals_log(wallets_logged, wallet_scored_at);

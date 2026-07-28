-- Signal settlement tracking (v2)
--
-- signals_log rows are written when a signal is detected; these columns are
-- filled when the learning system settles the market (recordSignalOutcome),
-- so the dashboard can show how every signal actually played out.
--
--   wrangler d1 execute polymarket-scanner --remote --file=migrations/0002_signal_outcomes.sql

ALTER TABLE signals_log ADD COLUMN outcome TEXT;          -- WIN | LOSS | UNKNOWN (NULL = pending)
ALTER TABLE signals_log ADD COLUMN winning_outcome TEXT;  -- resolved market outcome name
ALTER TABLE signals_log ADD COLUMN profit_pct INTEGER;    -- return per $100 at whale entry; -100 on loss
ALTER TABLE signals_log ADD COLUMN settled_by TEXT;       -- gamma | odds-api | trades | kv_expired
ALTER TABLE signals_log ADD COLUMN settled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_sig_outcome ON signals_log(outcome);

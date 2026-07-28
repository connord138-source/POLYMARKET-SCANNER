-- Price movement after signal detection (v3)
--
-- The line-movement tracker snapshots the market price 30 minutes and 1 hour
-- after each signal fires (KV, 24h TTL). Mirroring the snapshots onto
-- signals_log makes "did the market move toward the whales?" a permanent,
-- queryable part of every signal's record.
--
--   wrangler d1 execute polymarket-scanner --remote --file=migrations/0003_signal_prices.sql

ALTER TABLE signals_log ADD COLUMN price_30m INTEGER;     -- market price 30 min after detection (percent)
ALTER TABLE signals_log ADD COLUMN price_1h INTEGER;      -- market price 1 hour after detection (percent)
ALTER TABLE signals_log ADD COLUMN price_move_pct REAL;   -- latest movement, positive = toward the whales' side

-- Speed telemetry (v6)
--
-- How much does the price move between the whale's fill, the moment the
-- scanner sees the signal, and the minutes after? Answers whether a realtime
-- listener (seconds) would beat the 5-minute cron, using OUR side's live
-- Gamma price, not the last global trade.
--
--   wrangler d1 execute polymarket-scanner --remote --file=migrations/0006_speed_telemetry.sql

ALTER TABLE signals_log ADD COLUMN lag_sec INTEGER;      -- detected_at - last whale trade time
ALTER TABLE signals_log ADD COLUMN price_detect REAL;    -- our side's live price at detection (cents)
ALTER TABLE signals_log ADD COLUMN price_5m REAL;
ALTER TABLE signals_log ADD COLUMN price_15m REAL;
ALTER TABLE signals_log ADD COLUMN price_60m REAL;

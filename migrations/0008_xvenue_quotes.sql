-- Cross-venue quote sampler (src/xvenue.js): Kalshi vs Polymarket top-of-book,
-- one row per live game side per minute. Mirrors XV_SCHEMA (applied at runtime
-- by ensureSchema).
CREATE TABLE IF NOT EXISTS xvenue_quotes (
    ts INTEGER NOT NULL, sport TEXT NOT NULL, game TEXT NOT NULL, team TEXT NOT NULL, phase TEXT,
    k_ticker TEXT, k_bid REAL, k_ask REAL, k_last REAL,
    p_token TEXT, p_bid REAL, p_ask REAL, p_last REAL, p_fee_rate REAL);
CREATE INDEX IF NOT EXISTS idx_xv_ts ON xvenue_quotes(ts);
CREATE INDEX IF NOT EXISTS idx_xv_game ON xvenue_quotes(game, team, ts);
-- Polymarket US top of book for the same game side (added after the first deploy;
-- XV_SCHEMA carries the same ALTERs, which no-op once applied).
ALTER TABLE xvenue_quotes ADD COLUMN us_bid REAL;
ALTER TABLE xvenue_quotes ADD COLUMN us_ask REAL;
ALTER TABLE xvenue_quotes ADD COLUMN us_last REAL;

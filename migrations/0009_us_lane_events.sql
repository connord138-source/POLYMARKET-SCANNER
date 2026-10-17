-- Polymarket US stale-quote paper lane (src/us-lane.js). Applied at runtime by
-- ensureSchema (index.js SCHEMA_MIGRATIONS); kept here for the record and for
-- `wrangler d1 migrations apply`.
CREATE TABLE IF NOT EXISTS us_lane_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, sport TEXT NOT NULL, game TEXT NOT NULL, team TEXT NOT NULL,
  p_token TEXT, us_slug TEXT, side TEXT NOT NULL, px REAL NOT NULL, qty REAL, fee REAL NOT NULL,
  p_bid REAL, p_ask REAL, p_mid REAL, dp_c REAL, edge_c REAL,
  m1 REAL, m5 REAL, m15 REAL, m60 REAL, final REAL, marked_at INTEGER, settle REAL, settled_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_usl_ts ON us_lane_events(ts);
CREATE INDEX IF NOT EXISTS idx_usl_open ON us_lane_events(final, settle, ts);
-- shares shown at the Polymarket US best bid / ask (sampler now reads /book)
ALTER TABLE xvenue_quotes ADD COLUMN us_bid_qty REAL;
ALTER TABLE xvenue_quotes ADD COLUMN us_ask_qty REAL;

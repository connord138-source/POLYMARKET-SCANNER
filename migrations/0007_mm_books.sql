-- Order-book depth snapshots for the market-making study (src/mm-collector.js).
-- Also created at runtime by ensureSchema (CREATE TABLE IF NOT EXISTS), so
-- applying this file is optional.
--
--   wrangler d1 execute polymarket-scanner --remote --file=migrations/0007_mm_books.sql

CREATE TABLE IF NOT EXISTS mm_books (
  ts INTEGER NOT NULL,            -- unix seconds
  condition_id TEXT NOT NULL,
  token_id TEXT NOT NULL,         -- outcome-0 token (the book scored)
  slug TEXT, question TEXT, kind TEXT,
  game_start INTEGER,             -- unix seconds, sports only
  pool_usd REAL, min_size REAL, max_spread REAL,
  best_bid REAL, best_ask REAL, mid REAL, spread_c REAL,
  q_bid REAL, q_ask REAL,         -- score-weighted shares within max_spread, per side
  depth_bid_usd REAL, depth_ask_usd REAL,
  touch_bid_sh REAL, touch_ask_sh REAL,
  last_trade REAL
);
CREATE INDEX IF NOT EXISTS idx_mm_books_cond_ts ON mm_books(condition_id, ts);
CREATE INDEX IF NOT EXISTS idx_mm_books_ts ON mm_books(ts);

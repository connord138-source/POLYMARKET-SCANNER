-- Kalshi against Polymarket US, tested as live (src/cross-lane.js, Nov 16
-- 2026): one row per sampled cross the lane read both real order books for,
-- with what a live two-leg bot would have got (verdict filled / legged_us /
-- legged_kalshi / killed / gone_t0 / thin_t0 / read_failed / closed) and
-- whether the two legs tracked each other over the game (hedge_ok). Dry
-- only. Applied at runtime by ensureSchema (CROSS_SCHEMA).
CREATE TABLE IF NOT EXISTS cross_events (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, version INTEGER, sport TEXT, game TEXT, team TEXT, dir TEXT,
  us_slug TEXT, us_side TEXT, k_ticker TEXT, k_side TEXT,
  s_us_px REAL, s_k_px REAL, s_edge_c REAL, s_us_qty REAL, suspect INTEGER, lag_s REAL,
  verdict TEXT, why TEXT, shares REAL, us_limit REAL, k_limit REAL, real_edge_c REAL, lock0_c REAL,
  us_px REAL, k_px REAL, fee_us_usd REAL, fee_k_usd REAL, staked_usd REAL, pnl_usd REAL, pnl_c REAL,
  gap_ms INTEGER, t2_both INTEGER, reads TEXT, hedge_ok INTEGER, hedge_gap REAL, hedge_n INTEGER);
CREATE INDEX IF NOT EXISTS idx_cross_ts ON cross_events(ts);

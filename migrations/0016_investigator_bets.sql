-- The investigator's test lane (src/investigator-lane.js, Nov 15 2026): one
-- row per finished investigation with the real order book of the side the
-- agent backs and the bet a live bot would have placed (rule = 1) or why not.
-- The outcome is read off investigations.y at report time. Applied at runtime
-- by ensureSchema (INV_LANE_SCHEMA).
CREATE TABLE IF NOT EXISTS investigator_bets (
  inv_key TEXT PRIMARY KEY, ts INTEGER NOT NULL, version INTEGER, market_slug TEXT, title TEXT, kind TEXT, cluster TEXT,
  side TEXT, outcome TEXT, token_id TEXT, agent_p REAL, shown_p REAL, best_ask REAL, best_bid REAL, ask_px REAL, limit_px REAL,
  fill_px REAL, fill_usd REAL, shares REAL, fee_poly_usd REAL, fee_k_usd REAL, edge_fill_pts REAL, horizon_h REAL,
  confidence TEXT, source TEXT, rule INTEGER, why TEXT, lag_s INTEGER, event_date TEXT);
CREATE INDEX IF NOT EXISTS idx_invbets_ts ON investigator_bets(ts);

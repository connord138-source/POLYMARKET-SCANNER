-- Polymarket Scanner - D1 analytics schema (v1)
--
-- D1 is an ADDITIVE, queryable mirror of the agent-analytics data that already
-- lives in KV. The Worker writes to it only when a `DB` binding is present, so
-- provisioning is optional and non-breaking:
--
--   wrangler d1 create polymarket-scanner
--   # copy the returned database_id into wrangler.toml under [[d1_databases]]
--   wrangler d1 execute polymarket-scanner --remote --file=migrations/0001_init.sql
--
-- KV remains the source of truth for the operational hot-path (wallet stats,
-- factor weights, signals cache, pending list). D1 exists so the data is
-- QUERYABLE (for the dashboard and ad-hoc SQL) rather than opaque blobs.

CREATE TABLE IF NOT EXISTS investigations (
  inv_key         TEXT PRIMARY KEY,   -- marketSlug::directionRaw (stable)
  market_slug     TEXT,
  direction_raw   TEXT,
  market_title    TEXT,
  source          TEXT,               -- 'whale' | 'sweep'
  status          TEXT,               -- 'done' | 'error_permanent' | 'error_transient'
  agent_prob      REAL,               -- independent P(direction resolves YES)
  confidence      TEXT,               -- LOW | MEDIUM | HIGH
  reasoning       TEXT,
  key_findings    TEXT,               -- JSON array
  model           TEXT,
  web_searches    INTEGER,
  market_prob     REAL,               -- live Gamma baseline at investigation time
  entry_price_pct INTEGER,            -- whale fill (ROI reference only)
  edge_pts        REAL,               -- agent_prob - market_prob, percentage points
  event_date      TEXT,
  investigated_at TEXT,
  -- filled at ground-truth (Gamma) settlement:
  outcome         TEXT,               -- WIN | LOSS
  y               INTEGER,            -- 1 for WIN, 0 for LOSS
  agent_brier     REAL,
  market_brier    REAL,
  settled_by      TEXT,               -- 'gamma'
  settled_at      TEXT,
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_inv_status ON investigations(status);
CREATE INDEX IF NOT EXISTS idx_inv_source ON investigations(source);
CREATE INDEX IF NOT EXISTS idx_inv_settled ON investigations(settled_by);
CREATE INDEX IF NOT EXISTS idx_inv_edge ON investigations(edge_pts);

CREATE TABLE IF NOT EXISTS opportunities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  market_slug   TEXT,
  market_title  TEXT,
  agent_prob    REAL,
  market_prob   REAL,
  edge_pts      REAL,
  confidence    TEXT,
  reasoning     TEXT,
  event_date    TEXT,
  found_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_opp_found ON opportunities(found_at);
CREATE INDEX IF NOT EXISTS idx_opp_edge ON opportunities(edge_pts);

CREATE TABLE IF NOT EXISTS signals_log (
  id              TEXT PRIMARY KEY,   -- signal.id
  market_slug     TEXT,
  direction_raw   TEXT,
  market_title    TEXT,
  market_type     TEXT,
  score           INTEGER,
  largest_bet     INTEGER,
  volume          INTEGER,
  num_wallets     INTEGER,
  fresh_wallets   INTEGER,
  avg_entry_price INTEGER,
  event_date      TEXT,
  detected_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sig_detected ON signals_log(detected_at);
CREATE INDEX IF NOT EXISTS idx_sig_score ON signals_log(score);
CREATE INDEX IF NOT EXISTS idx_sig_slug ON signals_log(market_slug);

-- Polymarket US stale-quote scalp lane (src/scalp.js): every closed scalp.
CREATE TABLE IF NOT EXISTS scalp_trades (
  id TEXT PRIMARY KEY, mode TEXT, ts_entry INTEGER, ts_exit INTEGER, sport TEXT, game TEXT, team TEXT, us_slug TEXT, side TEXT,
  entry_px REAL, exit_px REAL, shares REAL, usd REAL, fee_entry_usd REAL, fee_exit_usd REAL, pnl_c REAL, pnl_usd REAL,
  edge_c REAL, dp_c REAL, shown_qty REAL, hold_s INTEGER, exit_kind TEXT, live INTEGER, order_id TEXT, exit_order_id TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_scalp_trades_ts ON scalp_trades(ts_entry);

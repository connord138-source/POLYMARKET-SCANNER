-- Member scalpers (src/scalp-accounts.js, Nov 9 2026): a Desk member's own
-- scalp lane on his own Polymarket US account. NULL = the owner's lane.
-- Applied at runtime by ensureSchema (index.js) as well.
ALTER TABLE scalp_trades ADD COLUMN account TEXT;
CREATE INDEX IF NOT EXISTS idx_scalp_trades_account ON scalp_trades(account, ts_entry);

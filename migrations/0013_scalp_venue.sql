-- Scalp lane venues (src/scalp.js, Nov 1 2026): 'us' (Polymarket US, null on
-- older rows) or 'kalshi' (the Kalshi NHL scalp lane), and the Kalshi market.
ALTER TABLE scalp_trades ADD COLUMN venue TEXT;
ALTER TABLE scalp_trades ADD COLUMN k_ticker TEXT;

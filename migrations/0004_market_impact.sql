-- Agent market-impact analysis (v4)
--
-- The investigator now also outputs which tradeable assets (crypto, stocks,
-- sectors, commodities) the market's outcome would plausibly move, with
-- direction, conviction, and a causal rationale. Stored as a JSON array:
--   [{ asset, assetType, direction, conviction, rationale }, ...]
-- Powers the Market Intel page's Impact Analysis tab.
--
--   wrangler d1 execute polymarket-scanner --remote --file=migrations/0004_market_impact.sql

ALTER TABLE investigations ADD COLUMN market_impact TEXT;

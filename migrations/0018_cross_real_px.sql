-- The two-venue cross test (src/cross-lane.js): the cheapest real offer on
-- each venue at the first read, next to the sampled s_us_px / s_k_px, so the
-- record says which venue's sampled price had already gone (Nov 17 2026).
-- Applied at runtime by ensureSchema (CROSS_SCHEMA).
ALTER TABLE cross_events ADD COLUMN real_us_px REAL;
ALTER TABLE cross_events ADD COLUMN real_k_px REAL;

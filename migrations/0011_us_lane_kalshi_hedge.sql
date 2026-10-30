-- Kalshi hedge marks for the Polymarket US paper lane (src/us-lane.js): the
-- Kalshi quote the US fill would be hedged at as a taker on the same leg (its
-- bid for a buy, its ask for a sell), in the event minute (kh0) and at the next
-- sample (kh1). Applied at runtime by ensureSchema; kept here for the record.
ALTER TABLE us_lane_events ADD COLUMN kh0 REAL;
ALTER TABLE us_lane_events ADD COLUMN kh1 REAL;

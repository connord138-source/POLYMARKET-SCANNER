-- Round-trip marks for the Polymarket US paper lane (src/us-lane.js): the US
-- exit price 5 / 15 minutes after the event (bid for a buy, ask for a sell).
-- Applied at runtime by ensureSchema; kept here for the record.
ALTER TABLE us_lane_events ADD COLUMN x5 REAL;
ALTER TABLE us_lane_events ADD COLUMN x15 REAL;

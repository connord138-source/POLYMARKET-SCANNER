-- Fill probe (src/fill-probe.js, Nov 2 2026): the venue's book re-read a few
-- seconds after the sampler's look and again 10s later, on every dry scalp.
ALTER TABLE scalp_trades ADD COLUMN probe TEXT;

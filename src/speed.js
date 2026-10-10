// ============================================================
// SPEED.JS — does reacting faster than the 5-minute cron pay?
// ============================================================
//
// For each newly detected market+side we record:
//   lag_sec      seconds from the whale's last fill to our detection
//   price_detect our side's live Gamma price when we saw it
//   price_5m / price_15m / price_60m  the same price later
//
// Read together with avg_entry_price (the whale's fill) and the outcome:
//   price_detect - avg_entry_price = what the cron lag already cost us
//   price_15m   - price_detect     = drift after detection (momentum vs fade)
// If most of the move happens before detection, a realtime listener (the
// DO VPS on Polymarket's websocket) is worth building. If the price keeps
// running after detection, the 5-min cron is fast enough and the entry rule
// is the problem. GET /speed/report summarizes both.
//
// Replaces the old line tracker for this purpose: it checked only the OLDEST
// 20 pending signals (expired), priced from the last global trade (often the
// other side / another market), and reset its clock on every re-detection.
// ============================================================

export const SPEED_KEYS = { WATCH: 'speed_watch', SEEN: 'speedseen:' };
const CHECKPOINTS = [
  { col: 'price_5m', min: 5 },
  { col: 'price_15m', min: 15 },
  { col: 'price_60m', min: 60 },
];
const WATCH_MAX = 400;
const MAX_AGE_MIN = 120;

// Start watching a newly detected signal. `pricer(slug, directionRaw)` returns
// our side's live price in cents (or null). Once per market+side per 6h.
export async function trackSpeed(env, signal, pricer) {
  if (!env.SIGNALS_CACHE || !signal || !signal.id || !signal.marketSlug) return null;
  const side = signal.directionRaw || signal.direction || '';
  const seenKey = SPEED_KEYS.SEEN + signal.marketSlug + '::' + side;
  try {
    if (await env.SIGNALS_CACHE.get(seenKey)) return null;
    await env.SIGNALS_CACHE.put(seenKey, '1', { expirationTtl: 6 * 3600 });

    const detectedMs = signal.detectedAt ? new Date(signal.detectedAt).getTime() : Date.now();
    const lastTradeMs = signal.lastTradeTime ? new Date(signal.lastTradeTime).getTime() : null;
    const lagSec = lastTradeMs ? Math.max(0, Math.round((detectedMs - lastTradeMs) / 1000)) : null;
    let p0 = null;
    try { p0 = await pricer(signal.marketSlug, side); } catch (e) {}

    if (env.DB) {
      await env.DB.prepare('UPDATE signals_log SET lag_sec=?2, price_detect=?3 WHERE id=?1')
        .bind(signal.id, lagSec, p0).run();
    }
    const watch = (await env.SIGNALS_CACHE.get(SPEED_KEYS.WATCH, { type: 'json' })) || [];
    watch.push({ id: signal.id, slug: signal.marketSlug, side, t0: Date.now(), done: [] });
    await env.SIGNALS_CACHE.put(SPEED_KEYS.WATCH, JSON.stringify(watch.slice(-WATCH_MAX)));
    return { lagSec, priceDetect: p0 };
  } catch (e) {
    return null;
  }
}

// Pure: which checkpoints are due for an entry at time `now`.
export function dueCheckpoints(entry, now) {
  const ageMin = (now - entry.t0) / 60000;
  return CHECKPOINTS.filter(c => ageMin >= c.min && !(entry.done || []).includes(c.col));
}

// Cron: fill due checkpoints. Bounded Gamma calls per run.
export async function updateSpeed(env, pricer, maxCalls = 40) {
  if (!env.SIGNALS_CACHE) return { skipped: 'no KV' };
  const out = { watching: 0, priced: 0, dropped: 0 };
  try {
    const now = Date.now();
    let watch = (await env.SIGNALS_CACHE.get(SPEED_KEYS.WATCH, { type: 'json' })) || [];
    let calls = 0;
    const priceCache = new Map();   // one Gamma read per market+side per run
    for (const e of watch) {
      const due = dueCheckpoints(e, now);
      if (!due.length || calls >= maxCalls) continue;
      const k = e.slug + '::' + e.side;
      let p = priceCache.get(k);
      if (p === undefined) {
        calls++;
        try { p = await pricer(e.slug, e.side); } catch (err) { p = null; }
        priceCache.set(k, p);
      }
      // A run late by more than a checkpoint's own length still records the
      // value, but only for the latest due checkpoint (no fake 5m from a 40m read).
      const target = due[due.length - 1];
      e.done = [...(e.done || []), ...due.map(d => d.col)];
      if (p != null && env.DB) {
        await env.DB.prepare(`UPDATE signals_log SET ${target.col}=?2 WHERE id=?1`).bind(e.id, p).run();
        out.priced++;
      }
    }
    const before = watch.length;
    watch = watch.filter(e => (e.done || []).length < CHECKPOINTS.length && (now - e.t0) / 60000 < MAX_AGE_MIN);
    out.dropped = before - watch.length;
    out.watching = watch.length;
    await env.SIGNALS_CACHE.put(SPEED_KEYS.WATCH, JSON.stringify(watch));
    return out;
  } catch (e) {
    return { ...out, error: e.message };
  }
}

// Summary: lag cost vs post-detection drift, by price side and lag bucket.
export async function speedReport(env) {
  if (!env.DB) return { success: false, error: 'no DB' };
  const q = (sql) => env.DB.prepare(sql).all().then(r => r.results || []);
  const base =
    "FROM signals_log WHERE price_detect IS NOT NULL AND avg_entry_price IS NOT NULL";
  const overall = await q(
    `SELECT COUNT(*) n, ROUND(AVG(lag_sec)) avg_lag_sec, ` +
    `ROUND(AVG(price_detect - avg_entry_price),2) lag_cost_c, ` +
    `ROUND(AVG(price_5m - price_detect),2) drift_5m_c, ` +
    `ROUND(AVG(price_15m - price_detect),2) drift_15m_c, ` +
    `ROUND(AVG(price_60m - price_detect),2) drift_60m_c ${base}`);
  const byLag = await q(
    `SELECT CASE WHEN lag_sec < 120 THEN '<2m' WHEN lag_sec < 300 THEN '2-5m' WHEN lag_sec < 900 THEN '5-15m' ELSE '15m+' END lag, ` +
    `COUNT(*) n, ROUND(AVG(price_detect - avg_entry_price),2) lag_cost_c, ROUND(AVG(price_15m - price_detect),2) drift_15m_c ` +
    `${base} GROUP BY lag ORDER BY MIN(lag_sec)`);
  const settled = await q(
    `SELECT COUNT(*) n, ` +
    `ROUND(AVG(CASE WHEN outcome='WIN' THEN (100.0/avg_entry_price-1)*100 ELSE -100 END),1) roi_at_whale, ` +
    `ROUND(AVG(CASE WHEN outcome='WIN' THEN (100.0/price_detect-1)*100 ELSE -100 END),1) roi_at_detect ` +
    `${base} AND outcome IN ('WIN','LOSS') AND price_detect BETWEEN 2 AND 98`);
  return {
    success: true,
    overall: overall[0] || null,
    byLag,
    settled: settled[0] || null,
    read: 'lag_cost_c = cents the price moved against us before we saw it; drift = movement after. ' +
      'roi_at_whale vs roi_at_detect = the value of being as fast as the whale.',
  };
}

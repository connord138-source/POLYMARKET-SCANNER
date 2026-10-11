// ============================================================
// MM-COLLECTOR.JS — order-book depth snapshots for the market-making study
// ============================================================
//
// Polymarket pays liquidity rewards per market per day, split among makers
// by a score that favours size close to the midpoint (S = ((v - s)/v)^2 per
// order, v = max spread, s = distance from mid; Q_min of the two sides, with
// one-sided liquidity counted at 1/3 when the mid is in 10-90c). Whether a
// $X two-sided quote earns enough to beat adverse selection depends on how
// much competing, score-weighted depth sits in the band — and that changes
// through the day. This records it: every cron, for the reward markets with
// the biggest daily pools, one row per market with the book's best levels
// and its score-weighted depth on each side. Rows live in D1 `mm_books`
// (pruned after MM_RETENTION_DAYS); the simulation reads them later.
// ============================================================

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
export const MM_MIN_POOL_USD = 300;     // skip the long tail ($1/day pools)
export const MM_MAX_MARKETS = 60;       // ~60 book fetches per cron
export const MM_RETENTION_DAYS = 45;

const r4 = (x) => Math.round(x * 10000) / 10000;
const parseArr = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch (e) { return null; } };

export function kindOf(slug) {
  const m = String(slug || '').match(/^(nfl|nba|nhl|mlb|cfb|ncaab|wnba|epl|ucl|mls)-/);
  return m ? m[1] : 'other';
}

// Pure: choose which markets to snapshot from a Gamma market list.
export function pickMarkets(list, { minPool = MM_MIN_POOL_USD, max = MM_MAX_MARKETS } = {}) {
  const out = [];
  for (const m of list || []) {
    if (!m || m.closed || m.acceptingOrders === false || m.enableOrderBook === false) continue;
    const pool = (m.clobRewards || []).reduce((s, r) => s + (Number(r.rewardsDailyRate) || 0), 0);
    if (pool < minPool) continue;
    const tokens = parseArr(m.clobTokenIds) || [];
    if (!tokens[0] || !m.conditionId) continue;
    const gs = m.gameStartTime ? Date.parse(String(m.gameStartTime).replace(' ', 'T').replace(/\+00$/, 'Z')) : NaN;
    out.push({
      conditionId: m.conditionId, tokenId: String(tokens[0]), slug: m.slug, question: String(m.question || '').slice(0, 120),
      kind: kindOf(m.slug), gameStart: isNaN(gs) ? null : Math.floor(gs / 1000), pool,
      minSize: Number(m.rewardsMinSize) || 0, maxSpread: Number(m.rewardsMaxSpread) || 0,
    });
  }
  return out.sort((a, b) => b.pool - a.pool).slice(0, max);
}

// Pure: score a CLOB book ({bids:[{price,size}], asks:[...]}) under the
// rewards rule with max spread v (cents). Sizes are shares.
export function scoreBook(book, maxSpread) {
  const lv = (arr) => (arr || []).map(x => [Number(x.price), Number(x.size)]).filter(([p, s]) => p > 0 && s > 0);
  const bids = lv(book && book.bids).sort((a, b) => b[0] - a[0]);
  const asks = lv(book && book.asks).sort((a, b) => a[0] - b[0]);
  if (!bids.length || !asks.length) return null;
  const bestBid = bids[0][0], bestAsk = asks[0][0], mid = (bestBid + bestAsk) / 2;
  const v = Number(maxSpread) || 0;
  const side = (levels) => {
    let q = 0, usd = 0;
    for (const [p, s] of levels) {
      const d = Math.abs(p - mid) * 100;
      if (v > 0 && d <= v) { q += Math.pow((v - d) / v, 2) * s; usd += s * p; }
    }
    return { q: r4(q), usd: r4(usd) };
  };
  const b = side(bids), a = side(asks);
  return {
    bestBid, bestAsk, mid: r4(mid), spreadC: r4((bestAsk - bestBid) * 100),
    qBid: b.q, qAsk: a.q, depthBidUsd: b.usd, depthAskUsd: a.usd,
    touchBidSh: r4(bids[0][1]), touchAskSh: r4(asks[0][1]),
    lastTrade: book && book.last_trade_price != null ? Number(book.last_trade_price) : null,
  };
}

export const MM_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mm_books (
    ts INTEGER NOT NULL, condition_id TEXT NOT NULL, token_id TEXT NOT NULL, slug TEXT, question TEXT, kind TEXT,
    game_start INTEGER, pool_usd REAL, min_size REAL, max_spread REAL,
    best_bid REAL, best_ask REAL, mid REAL, spread_c REAL,
    q_bid REAL, q_ask REAL, depth_bid_usd REAL, depth_ask_usd REAL, touch_bid_sh REAL, touch_ask_sh REAL, last_trade REAL)`,
  'CREATE INDEX IF NOT EXISTS idx_mm_books_cond_ts ON mm_books(condition_id, ts)',
  'CREATE INDEX IF NOT EXISTS idx_mm_books_ts ON mm_books(ts)',
];

export async function collectBooks(env, nowMs = Date.now()) {
  if (!env.DB) return { skipped: 'no D1' };
  const res = await fetch(`${GAMMA_API}/markets?closed=false&limit=100&order=volume24hr&ascending=false`);
  if (!res.ok) return { error: `gamma ${res.status}` };
  const picked = pickMarkets(await res.json());
  const ts = Math.floor(nowMs / 1000);
  const stmts = [];
  let failed = 0;
  for (const m of picked) {
    try {
      const r = await fetch(`${CLOB_API}/book?token_id=${m.tokenId}`);
      if (!r.ok) { failed++; continue; }
      const s = scoreBook(await r.json(), m.maxSpread);
      if (!s) { failed++; continue; }
      stmts.push(env.DB.prepare(
        `INSERT INTO mm_books (ts, condition_id, token_id, slug, question, kind, game_start, pool_usd, min_size, max_spread,
          best_bid, best_ask, mid, spread_c, q_bid, q_ask, depth_bid_usd, depth_ask_usd, touch_bid_sh, touch_ask_sh, last_trade)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)`
      ).bind(ts, m.conditionId, m.tokenId, m.slug, m.question, m.kind, m.gameStart, m.pool, m.minSize, m.maxSpread,
        s.bestBid, s.bestAsk, s.mid, s.spreadC, s.qBid, s.qAsk, s.depthBidUsd, s.depthAskUsd, s.touchBidSh, s.touchAskSh, s.lastTrade));
    } catch (e) { failed++; }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  // Prune old rows once an hour (cheap; the ts index covers it).
  if (new Date(nowMs).getUTCMinutes() < 5) {
    try { await env.DB.prepare('DELETE FROM mm_books WHERE ts < ?1').bind(ts - MM_RETENTION_DAYS * 86400).run(); } catch (e) {}
  }
  return { markets: picked.length, rows: stmts.length, failed };
}

// ============================================================
// CROSS-LANE.JS — Kalshi against Polymarket US, tested as live (dry only)
// ============================================================
//
// Owner, Nov 16 2026 ("go, build the two-venue dry test"). The sampler's
// record showed minutes where buying a team on one US-legal venue and the
// other side of the same game on the other cost less than the $1 the pair
// pays, after both taker fees (xvenue.js `kUsCross`; 34 of 508 such minutes
// in 48h were still there a minute later at 2.2c a share). The sampler reads
// Kalshi a few seconds before Polymarket US inside its minute, and the scalp
// lane taught us what a sampled quote is worth: nothing until the real book
// is read. So this lane does what a live two-leg bot would do, and sends
// nothing:
//
//   1. a sampled cross of CROSS.minEdgeC or more is a candidate;
//   2. t0: both real order books are read at the same moment (Polymarket US
//      past the edge cache, Kalshi's book with its sizes) and the pair is
//      planned on them: every share that still locks CROSS.minLockC after
//      both fees, up to the stake. No such share = no trade (`gone_t0`);
//   3. t1: both books are read again right away, standing in for the two
//      fill-or-kill orders arriving: each leg fills only if its whole size is
//      still offered at its limit. Both = the pair is locked (`filled`, pays
//      $1 a share whoever wins); one = a naked leg (`legged_us` /
//      `legged_kalshi`), sold straight back into that book, both fees paid;
//      neither = nothing happened (`killed`);
//   4. t2: CROSS.delayMs later, is the pair still there (how long a real
//      cross lasts);
//   5. later, the two legs are checked against each other over the game's
//      samples (`checkCrossHedges`): a mis-mapped Kalshi leg (the Tulsa /
//      Tulane kind) reads as a huge cross and "fills" on both books, and it
//      is not a hedge at all.
//
// The rule is fixed here (CROSS, version 1); changing it means bumping the
// version. There is no live path in this file. D1 `cross_events` (migration
// 0017); GET /xvenue/cross; snapshot key `cross`.
import { fetchUsBook, fetchUsMarket, buildUsOrder, matchFok, matchClose, usLevels, usFeePerContract, PMUS_FEE } from './polymarket-us.js';
import { kalshiBookLevels } from './kalshi.js';
import { KALSHI_TAKER_RATE, US_TAKER_RATE } from './xvenue.js';

export const CROSS = {
  version: 1,
  stakeUsd: 25,          // what one pair may cost (both legs)
  minEdgeC: 1,           // sampled cross, cents a share after both fees, to look at all
  minLockC: 1,           // what the real books must still lock, cents a share after both fees
  minShares: 5,          // a smaller pair is not a trade
  perMinute: 3,          // pairs looked at per minute, biggest sampled edge first
  legCooldownMin: 5,     // the same leg and direction is not looked at again for this long
  perGameDay: 12,        // looks at one game per UTC day
  suspectEdgeC: 15,      // a sampled cross this big is flagged (a mis-mapped leg looks like this)
  delayMs: 5000,         // the third look
  hedgeGapMax: 0.12,     // mean |Kalshi mid - US mid| over the game above this = not the same proposition
};
export const ROOM_CAP_SHARES = 5000;   // the uncapped walk's own bound (observation, not the rule)
export const CROSS_KEYS = { STATE: 'cross_state', LAST: 'cross_last' };
export const CROSS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cross_events (
    id TEXT PRIMARY KEY, ts INTEGER NOT NULL, version INTEGER, sport TEXT, game TEXT, team TEXT, dir TEXT,
    us_slug TEXT, us_side TEXT, k_ticker TEXT, k_side TEXT,
    s_us_px REAL, s_k_px REAL, s_edge_c REAL, s_us_qty REAL, suspect INTEGER, lag_s REAL,
    verdict TEXT, why TEXT, shares REAL, us_limit REAL, k_limit REAL, real_edge_c REAL, lock0_c REAL,
    us_px REAL, k_px REAL, fee_us_usd REAL, fee_k_usd REAL, staked_usd REAL, pnl_usd REAL, pnl_c REAL,
    gap_ms INTEGER, t2_both INTEGER, reads TEXT, hedge_ok INTEGER, hedge_gap REAL, hedge_n INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_cross_ts ON cross_events(ts)`,
  `ALTER TABLE cross_events ADD COLUMN real_us_px REAL`,   // the cheapest real offer on each venue at t0 (Nov 17 2026): which venue's sampled price was off
  `ALTER TABLE cross_events ADD COLUMN real_k_px REAL`,
  `ALTER TABLE cross_events ADD COLUMN room_shares REAL`,   // shares that still locked minLockC+ at t0 with no stake cap (Nov 23 2026): how much size a real lane could have taken; observation only
];

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const defaultSleep = (ms) => new Promise(res => setTimeout(res, ms));
const SENT = new Set(['filled', 'legged_us', 'legged_kalshi', 'killed']);
export const crossMode = (env) => (env && String(env.CROSS_LANE || '').toLowerCase() === 'off' ? 'off' : 'dry');

// ---------- the candidates (pure) ----------
// One sampled leg = one team: its Kalshi YES market (k_bid / k_ask) and the
// Polymarket US instrument in that team's terms (us_bid / us_ask, sizes).
//   us_k: buy the team on Polymarket US at its ask, buy Kalshi NO at 1 - k_bid
//   k_us: buy Kalshi YES at its ask, buy the other US side at 1 - us_bid
// Either pair pays $1 a share whoever wins; the edge is $1 less both costs
// and both taker fees (the sampler's c1 / c2).
export function crossCandidates(legs, { minEdgeC = CROSS.minEdgeC, suspectEdgeC = CROSS.suspectEdgeC, usRate = US_TAKER_RATE, kRate = KALSHI_TAKER_RATE } = {}) {
  const fee = (p, rate) => rate * p * (1 - p);
  const out = [];
  for (const l of legs || []) {
    if (!l || !l.us_slug || !l.k_ticker) continue;
    const ok = (x) => typeof x === 'number' && x > 0 && x < 1;
    if (ok(l.us_ask) && ok(l.k_bid)) {
      const usPx = l.us_ask, kPx = r4(1 - l.k_bid);
      const c = (1 - usPx - kPx - fee(usPx, usRate) - fee(kPx, kRate)) * 100;
      if (c >= minEdgeC) out.push({ ts: l.ts, sport: l.sport, game: l.game, team: l.team, dir: 'us_k', usSlug: l.us_slug, usSide: l.us_long ? 'long' : 'short', kTicker: l.k_ticker, kSide: 'no', sUsPx: r4(usPx), sKPx: kPx, sEdgeC: r2(c), sUsQty: l.us_ask_qty ?? null, suspect: c > suspectEdgeC });
    }
    if (ok(l.us_bid) && ok(l.k_ask)) {
      const usPx = r4(1 - l.us_bid), kPx = l.k_ask;
      const c = (1 - usPx - kPx - fee(usPx, usRate) - fee(kPx, kRate)) * 100;
      if (c >= minEdgeC) out.push({ ts: l.ts, sport: l.sport, game: l.game, team: l.team, dir: 'k_us', usSlug: l.us_slug, usSide: l.us_long ? 'short' : 'long', kTicker: l.k_ticker, kSide: 'yes', sUsPx: usPx, sKPx: r4(kPx), sEdgeC: r2(c), sUsQty: l.us_bid_qty ?? null, suspect: c > suspectEdgeC });
    }
  }
  return out.sort((a, b) => b.sEdgeC - a.sEdgeC);
}
export const gameKey = (c) => `${c.sport}|${c.game}`;
export const legDirKey = (c) => `${c.sport}|${c.game}|${c.team}|${c.dir}`;

// Which candidates this minute looks at: biggest edge first, one per game,
// not a leg looked at inside the cooldown, not a game past its day's count.
export function pickCandidates(cands, state = {}, { nowMs = Date.now(), cfg = CROSS } = {}) {
  const picked = [], skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  const last = state.last || {}, games = state.games || {};
  const seenGames = new Set();
  for (const c of cands || []) {
    const g = gameKey(c);
    if (seenGames.has(g)) { skip('one per game a minute'); continue; }
    if (last[legDirKey(c)] && nowMs - last[legDirKey(c)] < cfg.legCooldownMin * 60e3) { skip('looked at in the last few minutes'); continue; }
    if ((games[g] || 0) >= cfg.perGameDay) { skip("the game's daily count"); continue; }
    if (picked.length >= cfg.perMinute) { skip('over the per-minute count'); continue; }
    seenGames.add(g); picked.push(c);
  }
  return { picked, skipped };
}

// ---------- the books (pure) ----------
// Kalshi lists bids only: a NO bid at p is a YES offer at 1 - p and the other
// way round. book = { yes: [{px, qty}], no: [{px, qty}] } (kalshiBookLevels).
export function kalshiBuyLevels(book, side) {
  const src = side === 'yes' ? (book && book.no) || [] : (book && book.yes) || [];
  return src.filter(l => l.qty > 0 && l.px > 0 && l.px < 1).map(l => ({ price: r4(1 - l.px), size: l.qty })).sort((a, b) => a.price - b.price);
}
export function kalshiSellLevels(book, side) {
  const src = side === 'yes' ? (book && book.yes) || [] : (book && book.no) || [];
  return src.filter(l => l.qty > 0 && l.px > 0 && l.px < 1).map(l => ({ price: l.px, size: l.qty })).sort((a, b) => b.price - a.price);
}
// Kalshi's taker fee on one fill, rounded up to the cent as the venue charges it.
export const kalshiOrderFee = (count, px, rate = KALSHI_TAKER_RATE) => Math.ceil(rate * count * px * (1 - px) * 100 - 1e-9) / 100;
// A fill-or-kill BUY on ascending levels: the whole size at or under the limit, cheapest first.
export function walkBuy(levels, shares, limit = 1) {
  const xs = (levels || []).filter(l => l.size > 0 && l.price <= limit + 1e-9).sort((a, b) => a.price - b.price);
  let left = shares, cost = 0, worst = null; const parts = [];
  for (const l of xs) { if (left <= 1e-9) break; const q = Math.min(left, l.size); parts.push({ price: l.price, q }); cost += q * l.price; worst = l.price; left -= q; }
  const avail = r4(xs.reduce((a, l) => a + l.size, 0));
  if (!(shares > 0) || left > 1e-9) return { filled: false, avail, best: xs.length ? xs[0].price : null };
  return { filled: true, avail, best: xs[0].price, avgPx: r4(cost / shares), worstPx: worst, cost, parts };
}
// Selling a position back into descending bids, no limit; null on an empty side, partial when the book is short.
export function walkSell(levels, shares) {
  const xs = (levels || []).filter(l => l.size > 0).sort((a, b) => b.price - a.price);
  let left = shares, got = 0, took = 0; const parts = [];
  for (const l of xs) { if (left <= 1e-9) break; const q = Math.min(left, l.size); parts.push({ price: l.price, q }); got += q * l.price; took += q; left -= q; }
  if (!(took > 0)) return null;
  return { shares: r4(took), avgPx: r4(got / took), got, parts, partial: left > 1e-9 };
}

// The pair on the real books: walk both ask sides together, cheapest first,
// taking every share whose own edge (after both per-share fees) is still
// minLockC or more, up to maxShares. Whole shares, the venue's step. Returns
// the size and each leg's limit (the worst level it takes), or null.
export function planCross(usLv, kLv, { maxShares, minLockC = CROSS.minLockC, minShares = CROSS.minShares, usFeeCoef = PMUS_FEE, kRate = KALSHI_TAKER_RATE, step = 1 } = {}) {
  const us = (usLv || []).filter(l => l.size > 0).sort((a, b) => a.price - b.price).map(l => ({ ...l }));
  const k = (kLv || []).filter(l => l.size > 0).sort((a, b) => a.price - b.price).map(l => ({ ...l }));
  const edgeOf = (pu, pk) => 1 - pu - pk - usFeePerContract(pu, usFeeCoef) - kRate * pk * (1 - pk);
  const top = us.length && k.length ? r2(edgeOf(us[0].price, k[0].price) * 100) : null;
  let i = 0, j = 0, taken = 0;
  const marks = [];   // cumulative size after each chunk, with the levels it reached
  while (i < us.length && j < k.length && taken < maxShares - 1e-9) {
    if (edgeOf(us[i].price, k[j].price) * 100 < minLockC - 1e-9) break;
    const q = Math.min(us[i].size, k[j].size, maxShares - taken);
    taken += q; marks.push({ upTo: taken, usLimit: us[i].price, kLimit: k[j].price });
    us[i].size -= q; k[j].size -= q;
    if (us[i].size <= 1e-9) i++;
    if (j < k.length && k[j].size <= 1e-9) j++;
  }
  const s = Math.max(1, Math.round(Number(step) || 1));   // whole contracts (Kalshi's unit), in the US venue's step when that is bigger
  const whole = Math.floor(Math.floor(taken + 1e-9) / s + 1e-9) * s;
  if (!(whole >= minShares)) return { ok: false, topEdgeC: top, offered: r4(taken) };
  const m = marks.find(x => x.upTo >= whole - 1e-9) || marks[marks.length - 1];
  return { ok: true, shares: whole, usLimit: m.usLimit, kLimit: m.kLimit, topEdgeC: top, offered: r4(taken) };
}

// Both fill-or-kill orders against one pair of book reads. The US leg is the
// very order a live bot would send (tick-rounded, the venue's step), matched
// the way the scalp lane's dry mode matches it.
export function matchPair(usBook, kBook, c, plan, market) {
  const feeCoef = (market && market.feeCoef) || PMUS_FEE;
  const order = buildUsOrder({ slug: c.usSlug, action: 'BUY', side: c.usSide, effectivePrice: plan.usLimit, tick: market && market.tick, quantity: plan.shares, minQty: market && market.minQty });
  const u = usBook ? matchFok(usBook, order, c.usSide, feeCoef) : null;
  const kw = kBook ? walkBuy(kalshiBuyLevels(kBook, c.kSide), plan.shares, plan.kLimit) : null;
  const kFee = kw && kw.filled ? r2(kw.parts.reduce((a, p) => a + kalshiOrderFee(p.q, p.price), 0)) : null;
  return {
    us: !u ? null : u.filled ? { filled: true, px: u.effectivePx, feeUsd: u.feeUsd, best: u.best } : { filled: false, avail: u.available, best: u.best },
    k: !kw ? null : kw.filled ? { filled: true, px: kw.avgPx, feeUsd: kFee, best: kw.best } : { filled: false, avail: kw.avail, best: kw.best },
    feeCoef,
  };
}
// A leg that filled alone is sold straight back into the same book read, the exit fee paid.
export function unwindLeg(venue, book, c, shares, fill, feeCoef = PMUS_FEE) {
  if (venue === 'us') {
    const m = book ? matchClose(book, c.usSide, shares, feeCoef) : null;
    if (!m || m.partial) return null;
    return r2(shares * m.effectivePx - shares * fill.px - fill.feeUsd - m.feeUsd);
  }
  const w = book ? walkSell(kalshiSellLevels(book, c.kSide), shares) : null;
  if (!w || w.partial) return null;
  const exitFee = r2(w.parts.reduce((a, p) => a + kalshiOrderFee(p.q, p.price), 0));
  return r2(w.got - shares * fill.px - fill.feeUsd - exitFee);
}

// The verdict for one candidate from its plan and the second read (pure).
export function verdictFor(c, plan, m1, books1) {
  if (!m1 || !m1.us || !m1.k) return { verdict: 'read_failed', why: 'the second read failed' };
  const n = plan.shares;
  if (m1.us.filled && m1.k.filled) {
    const cost = n * m1.us.px + n * m1.k.px, fees = m1.us.feeUsd + m1.k.feeUsd;
    const pnl = r2(n - cost - fees);
    return { verdict: 'filled', why: 'both orders would fill', usPx: m1.us.px, kPx: m1.k.px, feeUs: m1.us.feeUsd, feeK: m1.k.feeUsd, staked: r2(cost + fees), pnl, pnlC: r2(100 * pnl / n) };
  }
  if (m1.us.filled) {
    const pnl = unwindLeg('us', books1.us, c, n, m1.us, m1.feeCoef);
    return { verdict: 'legged_us', why: pnl == null ? 'Kalshi gone, the US leg could not be priced back out' : 'Kalshi gone; the US leg sold back', usPx: m1.us.px, feeUs: m1.us.feeUsd, staked: r2(n * m1.us.px + m1.us.feeUsd), pnl, pnlC: pnl == null ? null : r2(100 * pnl / n) };
  }
  if (m1.k.filled) {
    const pnl = unwindLeg('kalshi', books1.k, c, n, m1.k);
    return { verdict: 'legged_kalshi', why: pnl == null ? 'Polymarket US gone, the Kalshi leg could not be priced back out' : 'Polymarket US gone; the Kalshi leg sold back', kPx: m1.k.px, feeK: m1.k.feeUsd, staked: r2(n * m1.k.px + m1.k.feeUsd), pnl, pnlC: pnl == null ? null : r2(100 * pnl / n) };
  }
  return { verdict: 'killed', why: 'both gone before the orders arrived', pnl: 0, pnlC: 0, staked: 0 };
}

// ---------- the run ----------
async function kvJson(env, key, fallback) { try { const v = await env.SIGNALS_CACHE.get(key, { type: 'json' }); return v == null ? fallback : v; } catch (e) { return fallback; } }
async function kvPut(env, key, value, ttlSec) { try { await env.SIGNALS_CACHE.put(key, JSON.stringify(value), ttlSec ? { expirationTtl: ttlSec } : undefined); } catch (e) {} }
async function readPair(env, c, { fetchImpl }) {
  const [us, k] = await Promise.all([
    fetchUsBook(c.usSlug, { fetchImpl }).catch(() => null),
    kalshiBookLevels(env, c.kTicker, { fetchImpl }).catch(() => null),
  ]);
  return { us, k };
}
const view = (m) => (!m ? null : { us: m.us ? [m.us.best ?? null, m.us.filled ? 1 : 0, m.us.avail ?? null] : null, k: m.k ? [m.k.best ?? null, m.k.filled ? 1 : 0, m.k.avail ?? null] : null });

// One candidate: t0 (plan on the real books), t1 (the fills). Never throws.
async function lookAt(env, c, { fetchImpl, nowMs, clock, cfg }) {
  const row = { ...c, lagS: null, verdict: null, why: null, shares: null, usLimit: null, kLimit: null, realEdgeC: null, realUsPx: null, realKPx: null, roomShares: null, lock0C: null, gapMs: null, t2Both: null, reads: {} };
  try {
    let market = null;
    const [books0, mk] = await Promise.all([readPair(env, c, { fetchImpl }), fetchUsMarket(env, c.usSlug, { fetchImpl, nowMs }).catch(() => null)]);
    market = mk; const at0 = clock();
    row.lagS = r2((at0 - c.ts * 1000) / 1000);
    if (!books0.us || !books0.k) return { ...row, verdict: 'read_failed', why: !books0.us && !books0.k ? 'neither book answered' : !books0.us ? 'the Polymarket US book did not answer' : 'the Kalshi book did not answer' };
    if (market && market.status && market.status !== 'MARKET_STATUS_OPEN') return { ...row, verdict: 'closed', why: `US market ${market.status}` };
    const feeCoef = (market && market.feeCoef) || PMUS_FEE;
    const maxShares = Math.max(0, Math.floor(cfg.stakeUsd / Math.max(0.05, c.sUsPx + c.sKPx)));
    const usLv = usLevels(books0.us, 'BUY', c.usSide), kLv = kalshiBuyLevels(books0.k, c.kSide);
    const cheapest = (lv) => lv.reduce((m, l) => (l.size > 0 && (m == null || l.price < m) ? l.price : m), null);
    row.realUsPx = cheapest(usLv); row.realKPx = cheapest(kLv);   // what each venue really offered, against the sampled s_us_px / s_k_px
    const plan = planCross(usLv, kLv, { maxShares, minLockC: cfg.minLockC, minShares: cfg.minShares, usFeeCoef: feeCoef, step: (market && market.minQty) || 1 });
    row.realEdgeC = plan.topEdgeC;
    // How much size was really there: the same walk with no stake cap. Not part
    // of the rule (the pair sent is still the $25 one); read at the decision.
    // minShares 1: with nothing crossing the walk answers { ok: false, offered: 0 } (0 was a thrown-and-caught null until Nov 24 2026)
    try { row.roomShares = planCross(usLv, kLv, { maxShares: ROOM_CAP_SHARES, minLockC: cfg.minLockC, minShares: 1, usFeeCoef: feeCoef, step: 1 }).offered; } catch (e) { row.roomShares = null; }
    if (!plan.ok) {
      const thin = plan.offered > 0;
      return { ...row, verdict: thin ? 'thin_t0' : 'gone_t0', why: thin ? `only ${plan.offered} shares still crossed on the real books` : 'no cross on the real books', reads: { t0: { offered: plan.offered } } };
    }
    row.shares = plan.shares; row.usLimit = plan.usLimit; row.kLimit = plan.kLimit;
    const m0 = matchPair(books0.us, books0.k, c, plan, market);
    if (m0.us && m0.us.filled && m0.k && m0.k.filled) row.lock0C = r2(100 * (plan.shares - plan.shares * m0.us.px - plan.shares * m0.k.px - m0.us.feeUsd - m0.k.feeUsd) / plan.shares);
    row.reads.t0 = view(m0);
    const books1 = await readPair(env, c, { fetchImpl });
    row.gapMs = Math.round(clock() - at0);
    const m1 = books1.us && books1.k ? matchPair(books1.us, books1.k, c, plan, market) : null;
    row.reads.t1 = view(m1);
    const v = verdictFor(c, plan, m1, books1);
    return { ...row, ...v, planned: true, market, plan };
  } catch (e) {
    return { ...row, verdict: 'read_failed', why: `error: ${String(e && e.message).slice(0, 60)}` };
  }
}

const INSERT = `INSERT OR REPLACE INTO cross_events (id, ts, version, sport, game, team, dir, us_slug, us_side, k_ticker, k_side, s_us_px, s_k_px, s_edge_c, s_us_qty, suspect, lag_s, verdict, why, shares, us_limit, k_limit, real_edge_c, lock0_c, us_px, k_px, fee_us_usd, fee_k_usd, staked_usd, pnl_usd, pnl_c, gap_ms, t2_both, reads, real_us_px, real_k_px, room_shares) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
const bindsOf = (r, version) => [`cx_${r.ts}_${Math.random().toString(36).slice(2, 8)}`, r.ts, version, r.sport, r.game, r.team, r.dir, r.usSlug, r.usSide, r.kTicker, r.kSide, r.sUsPx, r.sKPx, r.sEdgeC, r.sUsQty ?? null, r.suspect ? 1 : 0, r.lagS ?? null, r.verdict, r.why ?? null, r.shares ?? null, r.usLimit ?? null, r.kLimit ?? null, r.realEdgeC ?? null, r.lock0C ?? null, r.usPx ?? null, r.kPx ?? null, r.feeUs ?? null, r.feeK ?? null, r.staked ?? null, r.pnl ?? null, r.pnlC ?? null, r.gapMs ?? null, r.t2Both ?? null, JSON.stringify(r.reads || {}), r.realUsPx ?? null, r.realKPx ?? null, r.roomShares ?? null];

// Called from the minute cron's afterSample hook with this minute's sampled
// legs. Reads only; returns a small status. Never throws.
export async function runCrossLane(env, { legs = [], nowMs = Date.now(), fetchImpl = fetch, sleep = defaultSleep, clock = Date.now, cfg = CROSS, retryMs = 500 } = {}) {
  const out = { mode: crossMode(env), seen: 0, looked: 0, planned: 0, filled: 0, legged: 0, killed: 0, gone: 0, skipped: {} };
  if (out.mode === 'off' || !env || !env.DB || !env.SIGNALS_CACHE) return out;
  try {
    const cands = crossCandidates(legs, cfg);
    out.seen = cands.length;
    if (!cands.length) return out;
    const day = new Date(nowMs).toISOString().slice(0, 10);
    let state = await kvJson(env, CROSS_KEYS.STATE, null);
    if (!state || state.day !== day) state = { day, games: {}, last: (state && state.last) || {} };
    const { picked, skipped } = pickCandidates(cands, state, { nowMs, cfg });
    out.skipped = skipped;
    if (!picked.length) return out;
    const rows = await Promise.all(picked.map(c => lookAt(env, c, { fetchImpl, nowMs, clock, cfg })));
    out.looked = rows.length;
    // the third look, one shared wait, only for the pairs that were sent
    const sent = rows.filter(r => r.planned && r.plan);
    if (sent.length) {
      await sleep(cfg.delayMs);
      await Promise.all(sent.map(async (r) => {
        try {
          const b2 = await readPair(env, r, { fetchImpl });
          const m2 = b2.us && b2.k ? matchPair(b2.us, b2.k, r, r.plan, r.market) : null;
          r.reads.t2 = view(m2);
          r.t2Both = m2 && m2.us && m2.k ? (m2.us.filled && m2.k.filled ? 1 : 0) : null;
        } catch (e) { r.t2Both = null; }
      }));
    }
    for (const r of rows) {
      state.last[legDirKey(r)] = nowMs; state.games[gameKey(r)] = (state.games[gameKey(r)] || 0) + 1;
      if (r.planned) out.planned++;
      if (r.verdict === 'filled') out.filled++;
      else if (r.verdict === 'legged_us' || r.verdict === 'legged_kalshi') out.legged++;
      else if (r.verdict === 'killed') out.killed++;
      else if (r.verdict === 'gone_t0' || r.verdict === 'thin_t0') out.gone++;
    }
    for (const k of Object.keys(state.last)) if (nowMs - state.last[k] > 6 * 3600e3) delete state.last[k];
    await kvPut(env, CROSS_KEYS.STATE, state, 2 * 86400);
    const stmts = rows.map(r => env.DB.prepare(INSERT).bind(...bindsOf(r, cfg.version)));
    let healed = false;
    for (let t = 0; ; t++) {
      try { await env.DB.batch(stmts); break; }
      catch (e) {
        // A column this version writes is not on the table yet (the worker's
        // schema pass swallows a transient failure and does not come back to
        // it): apply the table's own schema once and write again.
        if (!healed && /no column named|has no column/i.test(String(e && e.message))) {
          healed = true; out.schemaHealed = true;
          for (const q of CROSS_SCHEMA) { try { await env.DB.prepare(q).run(); } catch (_) { /* already there */ } }
          continue;
        }
        if (t >= 2) { out.writeError = String(e && e.message).slice(0, 80); break; }
        await sleep(retryMs * (t + 1));
      }
    }
    out.pnlUsd = r2(rows.reduce((a, r) => a + (typeof r.pnl === 'number' ? r.pnl : 0), 0));
    await kvPut(env, CROSS_KEYS.LAST, { at: new Date(nowMs).toISOString(), ...out, rows: rows.map(r => ({ game: r.game, team: r.team, dir: r.dir, sEdgeC: r.sEdgeC, verdict: r.verdict, why: r.why, shares: r.shares, pnl: r.pnl ?? null })) }, 7 * 86400);
  } catch (e) { out.error = String(e && e.message).slice(0, 80); }
  return out;
}

// ---------- are the two legs the same game side? ----------
// Over the game's samples, a correctly matched leg has Kalshi's mid and the
// US mid within a few cents of each other and moving together. A mis-mapped
// leg (team A on one venue, team B on the other) sits far apart and moves
// the other way. hedge_ok 1 = the same proposition, 0 = not, -1 = too few
// samples to say.
export function hedgeVerdict(agg, { gapMax = CROSS.hedgeGapMax, minRows = 10 } = {}) {
  const n = Number(agg && agg.n) || 0;
  if (n < minRows) return { ok: null, n, gap: null };
  const gap = Number(agg.gap), cov = Number(agg.kum) - Number(agg.km) * Number(agg.um);
  return { ok: gap <= gapMax && cov > -0.0005 ? 1 : 0, n, gap: r4(gap), cov: r4(cov) };
}
export async function checkCrossHedges(env, nowMs = Date.now(), { limit = 6, ageMin = 60, giveUpH = 8 } = {}) {
  const out = { checked: 0, ok: 0, bad: 0, unknown: 0 };
  if (!env || !env.DB) return out;
  try {
    const now = Math.floor(nowMs / 1000);
    const due = await env.DB.prepare(`SELECT sport, game, team, MIN(ts) AS ts FROM cross_events WHERE hedge_ok IS NULL AND ts < ?1 GROUP BY sport, game, team ORDER BY ts LIMIT ?2`).bind(now - ageMin * 60, limit).all();
    for (const d of (due && due.results) || []) {
      const agg = await env.DB.prepare(`SELECT COUNT(*) AS n, AVG(ABS((k_bid + k_ask) / 2 - (us_bid + us_ask) / 2)) AS gap, AVG((k_bid + k_ask) / 2) AS km, AVG((us_bid + us_ask) / 2) AS um, AVG(((k_bid + k_ask) / 2) * ((us_bid + us_ask) / 2)) AS kum FROM xvenue_quotes WHERE game = ?1 AND team = ?2 AND sport = ?3 AND ts BETWEEN ?4 AND ?5 AND k_bid IS NOT NULL AND k_ask IS NOT NULL AND us_bid IS NOT NULL AND us_ask IS NOT NULL`)
        .bind(d.game, d.team, d.sport, d.ts - 8 * 3600, d.ts + 8 * 3600).first();
      const v = hedgeVerdict(agg);
      let ok = v.ok;
      if (ok == null) { if (now - d.ts < giveUpH * 3600) continue; ok = -1; }
      await env.DB.prepare(`UPDATE cross_events SET hedge_ok = ?1, hedge_gap = ?2, hedge_n = ?3 WHERE sport = ?4 AND game = ?5 AND team = ?6 AND hedge_ok IS NULL AND ts BETWEEN ?7 AND ?8`)
        .bind(ok, v.gap, v.n, d.sport, d.game, d.team, d.ts - 8 * 3600, d.ts + 8 * 3600).run();
      out.checked++; if (ok === 1) out.ok++; else if (ok === 0) out.bad++; else out.unknown++;
    }
  } catch (e) { out.error = String(e && e.message).slice(0, 80); }
  return out;
}

// ---------- the record (pure) ----------
// rows = cross_events rows. `sent` = the pairs a live bot would have sent
// (the real books still crossed at t0). A filled pair whose legs turned out
// not to be the same proposition (hedge_ok 0) is left out of the money and
// counted as `mismatched`.
export function summarizeCrosses(rows, { cfg = CROSS } = {}) {
  const list = (rows || []).filter(r => r && r.verdict);
  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : 0);
  const avg = (xs) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const pct = (a, b) => (b ? r2(100 * a / b) : null);
  const blank = () => ({ looked: 0, sent: 0, filled: 0, legged: 0, killed: 0, pnlUsd: 0, stakedUsd: 0 });
  const add = (o, r) => {
    o.looked++;
    if (!SENT.has(r.verdict)) return;
    o.sent++;
    if (r.verdict === 'killed') { o.killed++; return; }
    if (r.verdict === 'filled') { if (r.hedge_ok === 0) return; o.filled++; o.pnlUsd += num(r.pnl_usd); o.stakedUsd += num(r.staked_usd); return; }
    o.legged++; o.pnlUsd += num(r.pnl_usd);
  };
  const fin = (o) => ({ ...o, pnlUsd: r2(o.pnlUsd), stakedUsd: r2(o.stakedUsd), fillPct: pct(o.filled, o.sent), roiPct: o.stakedUsd ? r2(100 * o.pnlUsd / o.stakedUsd) : null });
  const all = blank(), bySport = {}, byDir = {}, byVerdict = {}, byGame = new Map(), byDay = {};
  for (const r of list) {
    byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
    add(all, r);
    add(bySport[r.sport] || (bySport[r.sport] = blank()), r);
    add(byDir[r.dir] || (byDir[r.dir] = blank()), r);
    const g = `${r.sport}|${r.game}`;
    add(byGame.get(g) || byGame.set(g, { game: g, ...blank(), hedgeBad: 0 }).get(g), r);
    if (r.hedge_ok === 0) byGame.get(g).hedgeBad++;
    const d = new Date(r.ts * 1000).toISOString().slice(0, 10);
    add(byDay[d] || (byDay[d] = blank()), r);
  }
  const filledRows = list.filter(r => r.verdict === 'filled');
  const good = filledRows.filter(r => r.hedge_ok !== 0);
  const leggedRows = list.filter(r => r.verdict === 'legged_us' || r.verdict === 'legged_kalshi');
  const sentRows = list.filter(r => SENT.has(r.verdict));
  // the evidence, counted per game: one game's pairs are one observation
  const perGame = [...byGame.values()].filter(g => g.sent > 0).map(g => g.pnlUsd);
  let tGames = null;
  if (perGame.length >= 3) { const m = perGame.reduce((a, b) => a + b, 0) / perGame.length; const sd = Math.sqrt(perGame.reduce((a, b) => a + (b - m) * (b - m), 0) / (perGame.length - 1)); tGames = sd > 0 ? r2(m / (sd / Math.sqrt(perGame.length))) : null; }
  const t2 = sentRows.filter(r => r.t2_both === 0 || r.t2_both === 1);
  const first = list.length ? Math.min(...list.map(r => r.ts)) : null;
  const games = [...byGame.values()].sort((a, b) => b.looked - a.looked).slice(0, 10).map(g => ({ ...fin(g) }));
  return {
    rule: `sampled cross of ${cfg.minEdgeC}c+ a share after both fees -> both real books read at once -> every share that still locks ${cfg.minLockC}c+, up to $${cfg.stakeUsd} a pair (at least ${cfg.minShares} shares) -> both read again right away: each leg fills only if its whole size is still offered at its limit`,
    version: cfg.version,
    since: first ? new Date(first * 1000).toISOString() : null,
    looked: all.looked, byVerdict,
    sent: all.sent, sentPct: pct(all.sent, all.looked),
    filled: { n: good.length, games: new Set(good.map(r => `${r.sport}|${r.game}`)).size, pnlUsd: r2(good.reduce((a, r) => a + num(r.pnl_usd), 0)), stakedUsd: r2(good.reduce((a, r) => a + num(r.staked_usd), 0)), avgLockC: avg(good.map(r => r.pnl_c).filter(x => typeof x === 'number')), avgShares: avg(good.map(r => r.shares).filter(x => typeof x === 'number')),
      hedge: { ok: filledRows.filter(r => r.hedge_ok === 1).length, mismatched: filledRows.filter(r => r.hedge_ok === 0).length, unknown: filledRows.filter(r => r.hedge_ok === -1).length, unchecked: filledRows.filter(r => r.hedge_ok == null).length } },
    legged: { n: leggedRows.length, us: leggedRows.filter(r => r.verdict === 'legged_us').length, kalshi: leggedRows.filter(r => r.verdict === 'legged_kalshi').length, pnlUsd: r2(leggedRows.reduce((a, r) => a + num(r.pnl_usd), 0)), unpriced: leggedRows.filter(r => r.pnl_usd == null).length },
    killed: all.killed,
    net: { pnlUsd: r2(all.pnlUsd), stakedUsd: r2(all.stakedUsd), roiPct: all.stakedUsd ? r2(100 * all.pnlUsd / all.stakedUsd) : null, perSentUsd: all.sent ? r2(all.pnlUsd / all.sent) : null, fillPct: pct(all.filled, all.sent), leggedPct: pct(all.legged, all.sent), games: perGame.length, tGames },
    edge: { sampledC: avg(list.map(r => r.s_edge_c).filter(x => typeof x === 'number')), realTopC: avg(list.map(r => r.real_edge_c).filter(x => typeof x === 'number')), plannedC: avg(sentRows.map(r => r.lock0_c).filter(x => typeof x === 'number')), bookedC: avg(good.map(r => r.pnl_c).filter(x => typeof x === 'number')) },
    // cents each venue's real cheapest offer was above the sampled one (positive = the sample was too kind on that venue)
    // the size that was there on the pairs sent: shares still locking with no stake cap, and that in dollars
    room: (() => { const xs = sentRows.filter(r => typeof r.room_shares === 'number'); const sh = xs.map(r => r.room_shares).sort((x, y) => x - y); const usd = xs.map(r => r.room_shares * (num(r.s_us_px) + num(r.s_k_px))).sort((x, y) => x - y); const mid = (v) => (v.length ? r2(v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null); return { n: xs.length, medShares: mid(sh), maxShares: sh.length ? r2(sh[sh.length - 1]) : null, medUsd: mid(usd), maxUsd: usd.length ? r2(usd[usd.length - 1]) : null, capShares: ROOM_CAP_SHARES }; })(),
    drift: (() => { const xs = list.filter(r => typeof r.real_us_px === 'number' && typeof r.real_k_px === 'number' && typeof r.s_us_px === 'number' && typeof r.s_k_px === 'number'); return { n: xs.length, usC: avg(xs.map(r => (r.real_us_px - r.s_us_px) * 100)), kalshiC: avg(xs.map(r => (r.real_k_px - r.s_k_px) * 100)) }; })(),
    timing: { avgLagS: avg(list.map(r => r.lag_s).filter(x => typeof x === 'number')), avgGapMs: avg(sentRows.map(r => r.gap_ms).filter(x => typeof x === 'number')), stillThereAfterDelayPct: pct(t2.filter(r => r.t2_both === 1).length, t2.length), delayS: cfg.delayMs / 1000 },
    suspect: list.filter(r => r.suspect).length,
    bySport: Object.fromEntries(Object.entries(bySport).map(([k, v]) => [k, fin(v)])),
    byDir: Object.fromEntries(Object.entries(byDir).map(([k, v]) => [k, fin(v)])),
    byDay: Object.fromEntries(Object.entries(byDay).sort().map(([k, v]) => [k, fin(v)])),
    games,
    recent: list.slice().sort((a, b) => b.ts - a.ts).slice(0, 25).map(r => ({ at: new Date(r.ts * 1000).toISOString(), sport: r.sport, game: r.game, team: r.team, dir: r.dir, sampledC: r.s_edge_c, realTopC: r.real_edge_c, sUs: r.s_us_px, realUs: r.real_us_px ?? null, sK: r.s_k_px, realK: r.real_k_px ?? null, verdict: r.verdict, why: r.why, shares: r.shares, usPx: r.us_px, kPx: r.k_px, pnlUsd: r.pnl_usd, lockC: r.pnl_c, lagS: r.lag_s, gapMs: r.gap_ms, stillThere: r.t2_both, hedgeOk: r.hedge_ok, roomShares: r.room_shares ?? null })),
    read: 'looked = sampled crosses the lane read the real books for. sent = the real books still crossed, so a live bot would have sent both fill-or-kill orders. filled = both would have filled: the pair is locked and pays $1 a share whoever wins (pnl after both taker fees; held to the end of the game, so the stake is tied up until then). legged = one leg filled alone and was sold straight back (the spread and two fees lost). killed = both gone, nothing happened. net = filled + legged, the number to read; tGames counts each game once. drift = how many cents the real cheapest offer on each venue was above the price the sampler saw (the venue with the big number is the one whose sampled price had already gone). mismatched = filled pairs whose two legs did not track each other over the game (not a hedge), left out of the money. Nothing is ever sent.',
  };
}

export async function crossReport(env, { hours = 168, nowMs = Date.now(), cfg = CROSS } = {}) {
  const since = Math.floor(nowMs / 1000) - hours * 3600;
  let rows = [], readError = null;
  for (let t = 0; t < 3; t++) {
    try { const q = await env.DB.prepare(`SELECT * FROM cross_events WHERE ts >= ?1 AND version = ?2 ORDER BY ts DESC LIMIT 5000`).bind(since, cfg.version).all(); rows = (q && q.results) || []; readError = null; break; }
    catch (e) { readError = String(e && e.message).slice(0, 100); await defaultSleep(400 * (t + 1)); }
  }
  const last = await kvJson(env, CROSS_KEYS.LAST, null);
  const state = await kvJson(env, CROSS_KEYS.STATE, null);
  return { success: true, mode: crossMode(env), hours, readError, last, today: state ? { day: state.day, games: Object.keys(state.games || {}).length, looks: Object.values(state.games || {}).reduce((a, b) => a + b, 0) } : null, ...summarizeCrosses(rows, { cfg }) };
}

// Which Polymarket crypto contracts a US client can actually trade, and
// where. Polymarket US lists sports only (gateway.polymarket.us, Oct 30
// 2026: 300 of 300 events in category "sports"), so for crypto the US-legal
// venue is Kalshi:
//   KX{BTC,ETH,SOL}D      "BTC price on Oct 30 at 5pm EDT?" one event per hour,
//                          strikes $500 apart (BTC), the 12am/5pm ones open a
//                          day ahead, the other hours open the same day.
//   KX{..}MAXMON/MINMON   "Will BTC be above/below $X by 11:59 PM ET on Oct 31",
//                          the monthly one-touch, strikes $2,500 apart (BTC).
// Polymarket's "above $X on <date>" settles at noon ET, its "dip to / reach
// $X in <month>" at month end: the hourly series matches the first on the
// date (the noon event itself once it opens, else the nearest open hour,
// with the gap in hours stated), the monthly one-touch the second.
//
// Public endpoints, no key needed; signed when KALSHI_* secrets exist
// (kalshi.js). Kalshi 429s Cloudflare's shared egress at times, so the board
// is cached in KV and a stale board is kept up to BOARD_STALE_MAX_MS.
// Prices come back in dollars (yes_bid_dollars ...), volume as *_fp.

import { kalshiFetch } from './kalshi.js';

export const US_BOARD_KEY = 'crypto_us_board';
export const BOARD_TTL_MS = 10 * 60e3;          // refetch after this
export const BOARD_STALE_MAX_MS = 6 * 3600e3;   // serve an old board up to this
export const KALSHI_SERIES = {
  BTC: { daily: 'KXBTCD', max: 'KXBTCMAXMON', min: 'KXBTCMINMON' },
  ETH: { daily: 'KXETHD', max: 'KXETHMAXMON', min: 'KXETHMINMON' },
  SOL: { daily: 'KXSOLD', max: 'KXSOLMAXMON', min: 'KXSOLMINMON' },
};
// Strike tolerance as a share of the Polymarket strike: Kalshi's floor is
// $X,999.99 for "above $X+1", so a same contract differs by a cent.
export const SAME_TOL = 0.002, NEAR_TOL = 0.012;
export const DAILY_MAX_HOURS = 6;       // an hourly event on the same ET date, at most this far from noon (the 12am one is another bet)
export const TOUCH_MAX_HOURS = 36;      // a one-touch whose month end is within this of the window end

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function slimMarket(m, kind) {
  const strike = kind === 'min' ? num(m.cap_strike) : num(m.floor_strike);
  if (strike == null) return null;
  return {
    ticker: m.ticker, event: m.event_ticker, kind,                       // 'daily' | 'max' | 'min'
    strike: kind === 'daily' ? Math.round((strike + 0.01) * 100) / 100 : strike,   // 77,999.99 -> 78,000
    close: m.close_time, title: m.title || m.subtitle || '',
    yesBid: num(m.yes_bid_dollars), yesAsk: num(m.yes_ask_dollars), last: num(m.last_price_dollars),
    vol24h: Math.round(num(m.volume_24h_fp) || 0), status: m.status || null,
  };
}

async function kalshiMarkets(env, series, fetchImpl) {
  const path = `/markets?series_ticker=${encodeURIComponent(series)}&status=open&limit=200`;
  const res = fetchImpl ? await fetchImpl(path) : await kalshiFetch(env, path);
  if (!res || !res.ok) throw new Error(`kalshi ${series} ${res ? res.status : 'no response'}`);
  const d = await res.json();
  return Array.isArray(d.markets) ? d.markets : [];
}

// Fetch every series once. fetchImpl(path) -> Response is for tests.
export async function fetchUsBoard(env, nowMs = Date.now(), fetchImpl = null) {
  const board = { at: new Date(nowMs).toISOString(), venue: 'Kalshi', assets: {}, errors: {} };
  for (const [sym, s] of Object.entries(KALSHI_SERIES)) {
    const rows = [];
    for (const [kind, series] of [['daily', s.daily], ['max', s.max], ['min', s.min]]) {
      try {
        for (const m of await kalshiMarkets(env, series, fetchImpl)) {
          if (m.status && m.status !== 'active' && m.status !== 'open') continue;
          const r = slimMarket(m, kind); if (r) rows.push({ ...r, series });
        }
      } catch (e) { board.errors[series] = String(e.message || e).slice(0, 80); }
      if (!fetchImpl) await sleep(250);
    }
    board.assets[sym] = rows;
  }
  if (!Object.keys(board.errors).length) delete board.errors;
  return board;
}

// The cached board, refetched after BOARD_TTL_MS; a failed refetch keeps the
// old board (flagged stale) up to BOARD_STALE_MAX_MS.
export async function getUsBoard(env, nowMs = Date.now(), fetchImpl = null) {
  let cached = null;
  try { cached = await env.SIGNALS_CACHE.get(US_BOARD_KEY, { type: 'json' }); } catch (e) {}
  const age = cached && cached.at ? nowMs - Date.parse(cached.at) : Infinity;
  if (cached && age <= BOARD_TTL_MS) return cached;
  const fresh = await fetchUsBoard(env, nowMs, fetchImpl);
  const got = Object.values(fresh.assets).some(rows => rows.length);
  if (got) {
    try { await env.SIGNALS_CACHE.put(US_BOARD_KEY, JSON.stringify(fresh), { expirationTtl: Math.round(BOARD_STALE_MAX_MS / 1000) }); } catch (e) {}
    return fresh;
  }
  if (cached && age <= BOARD_STALE_MAX_MS) return { ...cached, stale: true, errors: fresh.errors || cached.errors };
  return fresh;   // empty, with its errors
}

const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export const etDate = (ms) => ET_DATE.format(new Date(ms));
const ET_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: true });
export const etHour = (ms) => ET_HOUR.format(new Date(ms)).replace(' ', '').toLowerCase();   // "5pm"

function nearestStrike(cands, K) {
  let best = null;
  for (const c of cands) {
    const d = Math.abs(c.strike - K) / K;
    if (!best || d < best.d) best = { c, d };
  }
  if (!best || best.d > NEAR_TOL) return null;
  return { ...best.c, match: best.d <= SAME_TOL ? 'same' : 'near' };
}

// Pure. One Polymarket row (asset, kind, K, resolvesAt) -> the Kalshi
// contract a US client would trade for the same view, or null.
export function matchUsVenue(row, board) {
  if (!row || !board || !board.assets) return null;
  const rows = board.assets[row.asset] || [];
  if (!rows.length) return null;
  const want = Date.parse(row.resolvesAt);
  if (!Number.isFinite(want)) return null;
  let pick = null, side = 'YES', settleHours = 0;
  if (row.kind === 'above' || row.kind === 'below') {
    const date = etDate(want);
    const sameDay = rows.filter(r => r.kind === 'daily' && r.close && etDate(Date.parse(r.close)) === date && Math.abs(Date.parse(r.close) - want) <= DAILY_MAX_HOURS * 3600e3);
    if (!sameDay.length) return null;
    // the event nearest the Polymarket settlement (noon), then the strike
    const byEvent = new Map();
    for (const r of sameDay) { const k = r.event; const d = Math.abs(Date.parse(r.close) - want); if (!byEvent.has(k) || d < byEvent.get(k).d) byEvent.set(k, { d, close: r.close }); }
    const ev = [...byEvent.entries()].sort((a, b) => a[1].d - b[1].d)[0][0];
    pick = nearestStrike(sameDay.filter(r => r.event === ev), row.K);
    if (!pick) return null;
    side = row.kind === 'above' ? 'YES' : 'NO';     // Kalshi's contract is "above": below is its NO
    settleHours = Math.round((Date.parse(pick.close) - want) / 3600e3 * 10) / 10;
  } else if (row.kind === 'reach' || row.kind === 'dip') {
    const kind = row.kind === 'reach' ? 'max' : 'min';
    const cands = rows.filter(r => r.kind === kind && r.close && Math.abs(Date.parse(r.close) - want) <= TOUCH_MAX_HOURS * 3600e3);
    pick = nearestStrike(cands, row.K);
    if (!pick) return null;
    settleHours = Math.round((Date.parse(pick.close) - want) / 3600e3 * 10) / 10;
  } else return null;
  const yes = pick.yesAsk != null || pick.yesBid != null ? { bid: pick.yesBid, ask: pick.yesAsk, last: pick.last } : null;
  return {
    venue: 'Kalshi', ticker: pick.ticker, series: pick.series, event: pick.event, title: pick.title,
    strike: pick.strike, side, match: pick.match, settles: pick.close, settleHours,
    when: pick.kind === 'daily' ? `${etHour(Date.parse(pick.close))} ET` : 'month end',
    yes, vol24h: pick.vol24h, url: `https://kalshi.com/markets/${String(pick.series || '').toLowerCase()}`,
  };
}

// Pure: rows with `us` on each (null when no US-venue contract matches).
export function attachUsVenue(rows, board) {
  return (rows || []).map(r => ({ ...r, us: matchUsVenue(r, board) }));
}

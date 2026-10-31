// ============================================================
// PROPS.JS — player props: line shopping across the US books, and
// Polymarket's own player props priced against those books
// ============================================================
//
// Two feeds, one fair price. The Odds API serves each event's player props
// from the US books, one event at a time, one credit per market per region
// (the event list itself is free). Every book's two-sided quote on the same
// line is devigged and the fair chance is the consensus of the books quoting
// that exact line. That fair price is used twice:
//   1. Line shopping: the best price any book offers on the line, scored per
//      $100 (the DraftKings board's method). Nothing settles; no paper bet.
//   2. Polymarket's props (Oct 31 2026: NFL and NBA list them; CFB, NHL, MLB,
//      WNBA and college hoops do not): the live ask on Polymarket's
//      "Player: Stat O/U line" market against the same fair price. Those
//      gaps go to the crew's council like moneylines and can be paper-bet.
// Props are the luxury feed: they refresh hourly per game and pause when the
// credits run low. Oct 31 2026, owner's "I want to track every possible prop
// for the best edge" and "ensure it's tracking player props for sports where
// Polymarket does have the props".
import { americanToProb, ODDS_API_BASE, SPORT_KEY_MAP } from './odds.js';
import { VALUE_EV_MIN } from './dk-picks.js';

export const PROP_MARKETS = {
  football: ['player_pass_yds', 'player_rush_yds', 'player_reception_yds', 'player_receptions', 'player_pass_tds', 'player_anytime_td'],
  basketball: ['player_points', 'player_rebounds', 'player_assists', 'player_threes', 'player_points_rebounds_assists'],
  hockey: ['player_points', 'player_shots_on_goal', 'player_assists'],
  baseball: ['batter_hits', 'batter_total_bases', 'batter_home_runs', 'pitcher_strikeouts'],
};
export const SPORT_FAMILY = { cfb: 'football', nfl: 'football', nba: 'basketball', wnba: 'basketball', ncaab: 'basketball', nhl: 'hockey', mlb: 'baseball' };
export const PROP_LABEL = {
  player_pass_yds: 'pass yds', player_rush_yds: 'rush yds', player_reception_yds: 'rec yds', player_receptions: 'receptions', player_pass_tds: 'pass TDs', player_rush_attempts: 'rush att', player_anytime_td: 'anytime TD',
  player_points: 'points', player_rebounds: 'rebounds', player_assists: 'assists', player_threes: 'threes', player_points_rebounds_assists: 'pts+reb+ast',
  player_shots_on_goal: 'shots on goal', batter_hits: 'hits', batter_total_bases: 'total bases', batter_home_runs: 'home runs', pitcher_strikeouts: 'strikeouts',
};
// Polymarket's player-prop market types (Gamma `sportsMarketType`) -> The
// Odds API market with the same stat. Question "Chris Godwin Jr.: Receiving
// Yards O/U 39.5", `line` 39.5, outcomes [Over, Under] (NFL) or [Yes, No]
// (NBA; Yes = over). Anytime TD is [Yes, No] with no line.
export const POLY_PROP_TYPES = {
  nfl: { passing_yards: 'player_pass_yds', passing_touchdowns: 'player_pass_tds', rushing_yards: 'player_rush_yds', receiving_yards: 'player_reception_yds', receptions: 'player_receptions', anytime_touchdowns: 'player_anytime_td' },
  nba: { points: 'player_points', rebounds: 'player_rebounds', assists: 'player_assists', threes: 'player_threes' },
};
export const POLY_PROP_TAG = { nfl: 450, nba: 745 };   // Gamma sport tags (crew.js SPORT_TAG)
export const PROPS_CREDIT_FLOOR = 2500;   // never spend the last credits on props
export const PROPS_MAX_GAMES = 10;        // soonest games first
export const PROPS_HOURS_AHEAD = 36;
export const PROPS_TTL_S = 3600;          // a game's props are re-pulled hourly at most (markets x games credits each time)
export const PROPS_MIN_BOOKS = 2;         // books quoting the same line before a fair price is trusted
export const PROP_MAX_SPREAD = 0.10;      // Polymarket prop books are thin; wider than 10c is display only
export const PREGAME_MIN_MS = 10 * 60e3;
const GAMMA_API = 'https://gamma-api.polymarket.com';
const POLY_PAGES = 3;
const PROPS_CONCURRENCY = 4;

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
export const americanToDecimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
const isProp = (key) => /^(player|batter|pitcher)_/.test(String(key || ''));
const parseArr = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch (e) { return null; } };
const UP = { Over: 'Over', Yes: 'Over' }, DOWN = { Under: 'Under', No: 'Under' };
// "A.J. Brown" / "AJ Brown", "Ja'Marr Chase", "Alperen Sengün", "Chris Godwin Jr." all meet.
export const normPlayer = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[.'’-]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
const propLabel = (market) => PROP_LABEL[market] || String(market).replace(/^(player|batter|pitcher)_/, '').replace(/_/g, ' ');

// Pure: the fair price of every (market, player, line) in one event's odds
// payload (bookmakers[].markets[].outcomes[]: name Over/Under or Yes/No,
// description = player, price, point). Two-sided quotes are devigged and
// averaged across the books quoting that exact line; a market the books
// only quote one way (anytime TD "Yes") gets the LOWEST implied price any
// book shows as its fair, flagged `oneSided`: that is the books' best price
// with the cut still in it, an upper bound on the true chance, so it is
// compared but never paper-bet. At least `minBooks` books either way.
export function propFairs(ev, { minBooks = PROPS_MIN_BOOKS } = {}) {
  if (!ev) return [];
  const game = `${ev.away_team} @ ${ev.home_team}`;
  const groups = new Map();
  for (const b of ev.bookmakers || []) {
    for (const m of b.markets || []) {
      if (!isProp(m.key)) continue;
      for (const o of m.outcomes || []) {
        const player = o.description; if (!player || typeof o.price !== 'number') continue;
        const side = UP[o.name] || DOWN[o.name]; if (!side) continue;
        const point = o.point ?? null;
        const k = `${m.key}|${player}|${point}`;
        const g = groups.get(k) || groups.set(k, { market: m.key, player, point, yesNo: o.name === 'Yes' || o.name === 'No', quotes: new Map(), updatedAt: null }).get(k);
        const q = g.quotes.get(b.key) || g.quotes.set(b.key, {}).get(b.key);
        q[side] = o.price;
        const at = m.last_update || b.last_update || null;
        if (at && (!g.updatedAt || at > g.updatedAt)) g.updatedAt = at;
      }
    }
  }
  const out = [];
  for (const g of groups.values()) {
    const fair = { Over: [], Under: [] }, best = {}, oneSidedImplied = [];
    for (const [book, q] of g.quotes) {
      for (const side of ['Over', 'Under']) {
        if (typeof q[side] !== 'number') continue;
        const dec = americanToDecimal(q[side]);
        if (!best[side] || dec > best[side].decimal) best[side] = { book, odds: q[side], decimal: dec, implied: r1(americanToProb(q[side]) * 100) };
      }
      if (typeof q.Over !== 'number') continue;
      if (typeof q.Under !== 'number') { oneSidedImplied.push(americanToProb(q.Over)); continue; }
      const po = americanToProb(q.Over), pu = americanToProb(q.Under), s = po + pu;
      if (!(s > 0)) continue;
      fair.Over.push(po / s); fair.Under.push(pu / s);
    }
    const base = { eventId: ev.id, game, home: ev.home_team, away: ev.away_team, startTime: ev.commence_time, market: g.market, label: propLabel(g.market), player: g.player, point: g.point, yesNo: g.yesNo, updatedAt: g.updatedAt, best };
    if (fair.Over.length >= minBooks) {
      const n = fair.Over.length;
      out.push({ ...base, fair: fair.Over.reduce((a, b) => a + b, 0) / n, books: n, oneSided: false });
    } else if (g.yesNo && fair.Over.length + oneSidedImplied.length >= minBooks && oneSidedImplied.length) {
      out.push({ ...base, fair: Math.min(...oneSidedImplied, ...fair.Over), books: fair.Over.length + oneSidedImplied.length, oneSided: true });
    }
  }
  return out;
}

// Pure: line-shopping rows from one event's odds payload: both sides of every
// two-sided prop, best price per side vs the fair, sorted by EV per $100.
export function propRowsFromEvent(ev, opts = {}) {
  const rows = [];
  for (const f of propFairs(ev, opts)) {
    if (f.oneSided) continue;
    for (const side of ['Over', 'Under']) {
      const b = f.best[side]; if (!b) continue;
      const p = side === 'Over' ? f.fair : 1 - f.fair;
      rows.push({
        id: `${f.eventId}:${f.market}:${f.player}:${f.point}:${side}`, eventId: f.eventId, game: f.game, home: f.home, away: f.away, startTime: f.startTime,
        market: f.market, label: f.label, player: f.player, point: f.point, side: f.yesNo ? (side === 'Over' ? 'Yes' : 'No') : side,
        odds: b.odds, book: b.book, implied: b.implied, fair: r1(p * 100), ev: r2(100 * (p * b.decimal - 1)), books: f.books, updatedAt: f.updatedAt,
      });
    }
  }
  return rows.sort((a, b) => b.ev - a.ev);
}

// KV-cached GET against The Odds API that never marks the shared feed status
// as down on a failure (a bad prop market for one sport must not read as an
// outage to the moneyline scan); on success it refreshes the credit counters.
async function propsFetch(env, key, url, ttlS, fetchImpl = fetch) {
  const kv = env.SIGNALS_CACHE;
  if (kv) { try { const hit = await kv.get(key, { type: 'json' }); if (hit) return { data: hit, fromCache: true }; } catch (e) {} }
  const res = await fetchImpl(url);
  if (!res.ok) { let body = ''; try { body = (await res.text()).slice(0, 160); } catch (e) {} return { error: res.status, body }; }
  const data = await res.json();
  if (kv) {
    try { await kv.put(key, JSON.stringify(data), { expirationTtl: ttlS }); } catch (e) {}
    try {
      const get = (h) => (res.headers && res.headers.get ? res.headers.get(h) : null);
      const prev = (await kv.get('odds_api_status', { type: 'json' })) || {};
      if (get('x-requests-remaining') != null) await kv.put('odds_api_status', JSON.stringify({ ...prev, at: new Date().toISOString(), ok: true, status: 200, key, remaining: get('x-requests-remaining'), used: get('x-requests-used') }));
    } catch (e) {}
  }
  return { data, fromCache: false };
}

// The sport's upcoming events (free endpoint; cached 15 min to spare the rate limit), pregame and within the horizon, soonest first.
export async function listEvents(env, sportKey, { nowMs = Date.now(), hoursAhead = PROPS_HOURS_AHEAD, fetchImpl } = {}) {
  if (!env.ODDS_API_KEY) return [];
  const r = await propsFetch(env, `odds_events:${sportKey}`, `${ODDS_API_BASE}/sports/${sportKey}/events?apiKey=${env.ODDS_API_KEY}`, 900, fetchImpl);
  const events = r && Array.isArray(r.data) ? r.data : [];
  const lo = nowMs + PREGAME_MIN_MS, hi = nowMs + hoursAhead * 3600e3;
  return events.filter(e => { const t = Date.parse(e.commence_time); return t >= lo && t <= hi; }).sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time));
}

// One event's player props from the US books (markets returned x 1 region credits when not cached).
export async function fetchEventProps(env, sportKey, eventId, markets, { fetchImpl } = {}) {
  const url = `${ODDS_API_BASE}/sports/${sportKey}/events/${eventId}/odds?apiKey=${env.ODDS_API_KEY}&regions=us&markets=${markets.join(',')}&oddsFormat=american`;
  return propsFetch(env, `odds_props:${eventId}:${markets.length}`, url, PROPS_TTL_S, fetchImpl);
}

// The books' board for one sport: the soonest games' props, best price per
// line vs the consensus. `fairs` (every priced line, one-sided included) is
// for the Polymarket match and is not meant to be stored.
export async function propsBoard(env, sport, { nowMs = Date.now(), maxGames = PROPS_MAX_GAMES, creditsLeft = null, fetchImpl } = {}) {
  const sportKey = SPORT_KEY_MAP[sport], family = SPORT_FAMILY[sport], markets = family ? PROP_MARKETS[family] : null;
  const base = { sport, at: new Date(nowMs).toISOString(), rows: [], fairs: [], value: 0 };
  if (!sportKey || !markets) return { ...base, skipped: 'no prop markets for this sport' };
  if (!env.ODDS_API_KEY) return { ...base, skipped: 'The Odds API is not configured' };
  if (creditsLeft !== null && !isNaN(creditsLeft) && creditsLeft < PROPS_CREDIT_FLOOR) return { ...base, skipped: `odds credits low (${creditsLeft} left; props pause under ${PROPS_CREDIT_FLOOR})` };
  const events = await listEvents(env, sportKey, { nowMs, fetchImpl });
  const picked = events.slice(0, maxGames);
  const rows = [], fairs = []; let fetched = 0, cached = 0, failed = 0, noProps = 0; let lastError = null;
  for (let i = 0; i < picked.length; i += PROPS_CONCURRENCY) {
    const batch = await Promise.all(picked.slice(i, i + PROPS_CONCURRENCY).map(ev => fetchEventProps(env, sportKey, ev.id, markets, { fetchImpl }).catch(e => ({ error: 0, body: e.message }))));
    for (const r of batch) {
      if (!r || r.error !== undefined) { failed++; if (r && r.error !== undefined) lastError = `HTTP ${r.error}${r.body ? ` ${r.body.slice(0, 80)}` : ''}`; continue; }
      if (r.fromCache) cached++; else fetched++;
      const got = propRowsFromEvent(r.data);
      if (!got.length) noProps++;
      rows.push(...got);
      fairs.push(...propFairs(r.data));
    }
  }
  rows.sort((a, b) => b.ev - a.ev);
  return { ...base, games: picked.length, eventsAhead: events.length, markets, fetched, cached, failed, noProps, lastError, creditsSpentMax: fetched * markets.length, rows: rows.slice(0, 80), fairs, value: rows.filter(r => r.ev >= VALUE_EV_MIN).length, priced: rows.length / 2 };
}

// Polymarket's open player-prop markets for a sport (Gamma, by type, most
// traded first, up to 300 per type), within the props horizon.
export async function fetchPolyProps(sport, { nowMs = Date.now(), hoursAhead = PROPS_HOURS_AHEAD, fetchImpl = fetch, pages = POLY_PAGES } = {}) {
  const types = POLY_PROP_TYPES[sport], tag = POLY_PROP_TAG[sport];
  if (!types || !tag) return { markets: [], error: null };
  const min = new Date(nowMs).toISOString(), max = new Date(nowMs + hoursAhead * 3600e3).toISOString();
  let error = null;
  const perType = await Promise.all(Object.keys(types).map(async (type) => {
    const got = [];
    for (let i = 0; i < pages; i++) {
      try {
        const res = await fetchImpl(`${GAMMA_API}/markets?closed=false&limit=100&offset=${i * 100}&sports_market_types=${type}&tag_id=${tag}&order=volumeNum&ascending=false&end_date_min=${encodeURIComponent(min)}&end_date_max=${encodeURIComponent(max)}`);
        if (!res.ok) { error = `Gamma HTTP ${res.status}`; break; }
        const page = await res.json();
        if (!Array.isArray(page) || !page.length) break;
        got.push(...page.filter(m => String(m.slug || '').startsWith(`${sport}-`)));
        if (page.length < 100) break;
      } catch (e) { error = e.message; break; }
    }
    return got;
  }));
  return { markets: perType.flat(), error };
}

// Honest price for one side of a Polymarket market from its Gamma row
// (crew.js quoteOutcome): the ask to buy outcome 0, 1 - bid to buy outcome 1,
// the mid only when there is no book.
export function polyQuote(market, idx) {
  const prices = (parseArr(market.outcomePrices) || []).map(Number);
  const bid = Number(market.bestBid), ask = Number(market.bestAsk);
  const hasBook = bid > 0 && ask > 0 && ask >= bid;
  const mid = typeof prices[idx] === 'number' && !isNaN(prices[idx]) ? prices[idx] : null;
  let buy = null;
  if (hasBook) buy = idx === 0 ? ask : 1 - bid;
  else if (mid !== null) buy = mid;
  return { buy: buy === null ? null : r1(buy * 100), mid: mid === null ? null : r1(mid * 100), spread: hasBook ? Math.round((ask - bid) * 1000) / 1000 : null };
}

// Pure: Polymarket prop markets matched to the books' fairs by stat, player
// and the exact line (a different line is a different bet), priced at the
// live ask. Edge = fair - ask in points; one row per side; `thin` marks a
// book wider than PROP_MAX_SPREAD (shown, not queued).
export function polyPropRows(sport, markets, fairs, { nowMs = Date.now(), maxSpread = PROP_MAX_SPREAD } = {}) {
  const map = POLY_PROP_TYPES[sport];
  const out = { listed: !!map, markets: (markets || []).length, matched: 0, noFair: 0, lineMismatch: 0, notOpen: 0, rows: [] };   // `skipped` is the pass's reason string, set by propsSweep
  if (!map) return out;
  const byKey = new Map(), byPlayer = new Map();
  for (const f of fairs || []) {
    const p = normPlayer(f.player);
    byKey.set(`${f.market}|${p}|${f.point ?? ''}`, f);
    byPlayer.set(`${f.market}|${p}`, true);
  }
  for (const m of markets || []) {
    const oddsMarket = map[m.sportsMarketType];
    if (!oddsMarket) continue;
    const startMs = Date.parse(String(m.gameStartTime || m.endDate || '').replace(' ', 'T').replace(/\+00$/, 'Z'));
    const outcomes = parseArr(m.outcomes) || [];
    if (!startMs || startMs - nowMs < PREGAME_MIN_MS || m.closed || m.acceptingOrders === false || outcomes.length !== 2) { out.notOpen++; continue; }
    const player = String(m.question || '').split(':')[0].trim();
    const point = typeof m.line === 'number' ? m.line : null;
    const p = normPlayer(player);
    const f = byKey.get(`${oddsMarket}|${p}|${point ?? ''}`);
    if (!f) { if (byPlayer.has(`${oddsMarket}|${p}`)) out.lineMismatch++; else out.noFair++; continue; }
    if (Math.abs(startMs - Date.parse(f.startTime)) > 6 * 3600e3) { out.notOpen++; continue; }
    out.matched++;
    const eventSlug = Array.isArray(m.events) && m.events[0] && m.events[0].slug ? m.events[0].slug : null;
    for (let idx = 0; idx < 2; idx++) {
      if (f.oneSided && idx === 1) continue;
      const q = polyQuote(m, idx);
      if (q.buy === null) continue;
      const fairSide = idx === 0 ? f.fair : 1 - f.fair;
      const best = f.best[idx === 0 ? 'Over' : 'Under'] || null;
      out.rows.push({
        id: `${m.slug}:${idx}`, sport, slug: m.slug, url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : `https://polymarket.com/market/${m.slug}`,
        game: f.game, startTime: new Date(startMs).toISOString(), player, market: oddsMarket, label: f.label, point, side: String(outcomes[idx]), outcomeIndex: idx,
        buyPrice: q.buy, midPrice: q.mid, spread: q.spread, fair: r1(fairSide * 100), edge: r1(fairSide * 100 - q.buy), ev: r2(100 * (fairSide / (q.buy / 100) - 1)),
        books: f.books, oneSided: !!f.oneSided, bestBook: best ? { book: best.book, odds: best.odds, implied: best.implied } : null,
        volume: Math.round(Number(m.volumeNum || m.volume || 0)), thin: q.spread === null || q.spread > maxSpread,
      });
    }
  }
  out.rows.sort((a, b) => b.edge - a.edge);
  return out;
}

// One sport's full props pass: the books' board, then Polymarket's props
// against it where Polymarket lists them.
export async function propsSweep(env, sport, { nowMs = Date.now(), creditsLeft = null, fetchImpl } = {}) {
  const board = await propsBoard(env, sport, { nowMs, creditsLeft, fetchImpl });
  const { fairs = [], ...rest } = board;
  const poly = { listed: !!POLY_PROP_TYPES[sport], rows: [], matched: 0 };
  if (POLY_PROP_TYPES[sport]) {
    if (board.skipped) poly.skipped = board.skipped;
    else if (!fairs.length) poly.skipped = 'no books fair price to compare';
    else {
      try {
        const g = await fetchPolyProps(sport, { nowMs, fetchImpl: fetchImpl || fetch });
        Object.assign(poly, polyPropRows(sport, g.markets, fairs, { nowMs }));
        if (g.error) poly.error = g.error;
      } catch (e) { poly.error = e.message; }
    }
  }
  return { ...rest, poly };
}

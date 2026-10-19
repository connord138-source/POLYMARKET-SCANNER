// Cross-venue quote sampler: Kalshi vs Polymarket, same game, same side, once a
// minute while games are live. The question it answers is the one real-money
// question left for a US operator (Kalshi is legal to trade from the US via its
// own API): does Kalshi's quote lag Polymarket's by enough to pay Kalshi's
// 7% x p(1-p) taker fee, or is there room to quote on Kalshi around Polymarket's
// mid? Pregame scans (Oct 12 2026, 103 NCAAF/MLB/WNBA games) found a median
// |mid difference| of 0.5c and zero fee-clearing crossings - so the answer, if
// there is one, lives in-game, at minute resolution. Rows go to D1
// `xvenue_quotes`; `xvenueReport` reads them back.

import { KALSHI_API, kalshiHeaders, kalshiAuthConfigured } from './kalshi.js';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const US_API = 'https://gateway.polymarket.us';   // Polymarket US public market data (no key)

export const XV_KEYS = { PAIRS: 'xv_pairs', LAST: 'xv_last', BOOT: 'xv_boot', KALSHI_COOLDOWN: 'xv_kalshi_cooldown' };
export const XV_KALSHI_COOLDOWN_S = 300;           // after a 429 on the per-minute quote call, skip Kalshi for 5 minutes
export const XV_PAIRS_TTL_MS = 30 * 60e3;        // pairs change slowly; fewer Kalshi series calls
export const XV_LIVE_BEFORE_MS = 30 * 60e3;        // start sampling 30 min before kickoff
export const XV_LIVE_AFTER_MS = 4.5 * 3600e3;      // ... and stop 4.5h after it
export const XV_PRUNE_DAYS = 14;
export const KALSHI_TAKER_RATE = 0.07;             // per-contract taker fee = rate x p(1-p) (Kalshi fee schedule)
export const US_TAKER_RATE = 0.0695;               // Polymarket US taker fee = 0.0695 x p(1-p); makers get a 0.0125 x p(1-p) rebate
export const US_MAX_BBO_CALLS = 40;                // per minute, one per live game

export const XV_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS xvenue_quotes (
    ts INTEGER NOT NULL, sport TEXT NOT NULL, game TEXT NOT NULL, team TEXT NOT NULL, phase TEXT,
    k_ticker TEXT, k_bid REAL, k_ask REAL, k_last REAL,
    p_token TEXT, p_bid REAL, p_ask REAL, p_last REAL, p_fee_rate REAL)`,
  `CREATE INDEX IF NOT EXISTS idx_xv_ts ON xvenue_quotes(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_xv_game ON xvenue_quotes(game, team, ts)`,
  `ALTER TABLE xvenue_quotes ADD COLUMN us_bid REAL`,
  `ALTER TABLE xvenue_quotes ADD COLUMN us_ask REAL`,
  `ALTER TABLE xvenue_quotes ADD COLUMN us_last REAL`,
  `ALTER TABLE xvenue_quotes ADD COLUMN us_bid_qty REAL`,    // shares shown at the US best bid / ask (from /book; null when only /bbo answered)
  `ALTER TABLE xvenue_quotes ADD COLUMN us_ask_qty REAL`,
];

export const XV_SPORTS = {
  nfl: { series: 'KXNFLGAME', tags: ['nfl'], us: 'nfl' },
  cfb: { series: 'KXNCAAFGAME', tags: ['cfb'], us: 'cfb' },
  nba: { series: 'KXNBAGAME', tags: ['nba'], us: 'nba' },
  nhl: { series: 'KXNHLGAME', tags: ['nhl'], us: 'nhl' },
  mlb: { series: 'KXMLBGAME', tags: ['mlb'], us: 'mlb' },
  wnba: { series: 'KXWNBAGAME', tags: ['wnba'], us: null },
};

// Kalshi names pro teams by city ("Calgary wins"); Polymarket by nickname
// ("Bills") or full name ("Cleveland Guardians"). City -> nicknames; cities
// with two teams list both and the opponent disambiguates.
const CITY = {
  nfl: { arizona: ['cardinals'], atlanta: ['falcons'], baltimore: ['ravens'], buffalo: ['bills'], carolina: ['panthers'], chicago: ['bears'], cincinnati: ['bengals'], cleveland: ['browns'], dallas: ['cowboys'], denver: ['broncos'], detroit: ['lions'], 'green bay': ['packers'], houston: ['texans'], indianapolis: ['colts'], jacksonville: ['jaguars'], 'kansas city': ['chiefs'], 'las vegas': ['raiders'], 'los angeles': ['rams', 'chargers'], la: ['rams', 'chargers'], miami: ['dolphins'], minnesota: ['vikings'], 'new england': ['patriots'], 'new orleans': ['saints'], 'new york': ['giants', 'jets'], ny: ['giants', 'jets'], philadelphia: ['eagles'], pittsburgh: ['steelers'], 'san francisco': ['49ers'], seattle: ['seahawks'], 'tampa bay': ['buccaneers'], tennessee: ['titans'], washington: ['commanders'] },
  nba: { atlanta: ['hawks'], boston: ['celtics'], brooklyn: ['nets'], charlotte: ['hornets'], chicago: ['bulls'], cleveland: ['cavaliers'], dallas: ['mavericks'], denver: ['nuggets'], detroit: ['pistons'], 'golden state': ['warriors'], houston: ['rockets'], indiana: ['pacers'], 'los angeles': ['lakers', 'clippers'], la: ['lakers', 'clippers'], memphis: ['grizzlies'], miami: ['heat'], milwaukee: ['bucks'], minnesota: ['timberwolves'], 'new orleans': ['pelicans'], 'new york': ['knicks'], ny: ['knicks'], 'oklahoma city': ['thunder'], orlando: ['magic'], philadelphia: ['76ers'], phoenix: ['suns'], portland: ['trail blazers', 'blazers'], sacramento: ['kings'], 'san antonio': ['spurs'], toronto: ['raptors'], utah: ['jazz'], washington: ['wizards'] },
  nhl: { anaheim: ['ducks'], boston: ['bruins'], buffalo: ['sabres'], calgary: ['flames'], carolina: ['hurricanes'], chicago: ['blackhawks'], colorado: ['avalanche'], columbus: ['blue jackets'], dallas: ['stars'], detroit: ['red wings'], edmonton: ['oilers'], florida: ['panthers'], 'los angeles': ['kings'], la: ['kings'], minnesota: ['wild'], montreal: ['canadiens'], nashville: ['predators'], 'new jersey': ['devils'], 'new york': ['rangers', 'islanders'], ny: ['rangers', 'islanders'], ottawa: ['senators'], philadelphia: ['flyers'], pittsburgh: ['penguins'], 'san jose': ['sharks'], seattle: ['kraken'], 'st louis': ['blues'], 'tampa bay': ['lightning'], toronto: ['maple leafs'], utah: ['mammoth', 'hockey club'], vancouver: ['canucks'], vegas: ['golden knights'], washington: ['capitals'], winnipeg: ['jets'] },
  mlb: { arizona: ['diamondbacks'], atlanta: ['braves'], baltimore: ['orioles'], boston: ['red sox'], chicago: ['cubs', 'white sox'], cincinnati: ['reds'], cleveland: ['guardians'], colorado: ['rockies'], detroit: ['tigers'], houston: ['astros'], 'kansas city': ['royals'], 'los angeles': ['dodgers', 'angels'], la: ['dodgers', 'angels'], miami: ['marlins'], milwaukee: ['brewers'], minnesota: ['twins'], 'new york': ['yankees', 'mets'], ny: ['yankees', 'mets'], oakland: ['athletics'], philadelphia: ['phillies'], pittsburgh: ['pirates'], 'san diego': ['padres'], 'san francisco': ['giants'], seattle: ['mariners'], 'st louis': ['cardinals'], 'tampa bay': ['rays'], texas: ['rangers'], toronto: ['blue jays'], washington: ['nationals'], athletics: ['athletics'] },
  wnba: { atlanta: ['dream'], chicago: ['sky'], connecticut: ['sun'], dallas: ['wings'], 'golden state': ['valkyries'], indiana: ['fever'], 'las vegas': ['aces'], 'los angeles': ['sparks'], la: ['sparks'], minnesota: ['lynx'], 'new york': ['liberty'], ny: ['liberty'], phoenix: ['mercury'], seattle: ['storm'], washington: ['mystics'] },
  cfb: {},
};

export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Does a Kalshi team label name the same team as a Polymarket outcome label?
// Pro sports: exact, or city -> nickname via CITY, or one label is the other
// plus words on a word boundary ("Calgary" / "Calgary Flames", "49ers" /
// "San Francisco 49ers"). College: exact, same word count with per-word
// prefixes ("Kansas St" / "Kansas State"), or the same name plus a short
// qualifier ("Miami (FL)" / "Miami") - never a bare prefix, so "Kansas" is
// not "Kansas State".
export function teamMatch(sport, kalshiTeam, polyOutcome) {
  const k = norm(kalshiTeam).replace(/ wins?$/, ''), p = norm(polyOutcome);
  if (!k || !p) return false;
  if (k === p) return true;
  const kw = k.split(' '), pw = p.split(' ');
  if (sport === 'cfb') {
    if (kw.length === pw.length && kw.every((w, i) => w.length >= 2 && pw[i].length >= 2 && (w.startsWith(pw[i].slice(0, 3)) || pw[i].startsWith(w.slice(0, 3))))) return true;
    const [longer, shorter] = kw.length > pw.length ? [kw, pw] : [pw, kw];
    return shorter.length > 0 && shorter.every((w, i) => longer[i] === w) && longer.slice(shorter.length).every(w => w.length <= 2);
  }
  if (p.startsWith(k + ' ') || p.endsWith(' ' + k) || k.startsWith(p + ' ') || k.endsWith(' ' + p)) return true;
  const nicks = (CITY[sport] || {})[k] || [];
  for (const n of nicks) if (p === n || p.endsWith(' ' + n)) return true;
  return false;
}

const parseArr = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v || '[]'); } catch { return []; } };

// Pure: Kalshi open game markets (two per event) + Polymarket moneyline
// markets -> matched legs. Both teams must match and the start times must be
// within 14h (Kalshi's expected_expiration is game end + settlement buffer).
export function matchPairs(sport, kalshiMarkets, polyMarkets, nowMs = Date.now()) {
  const byEvent = new Map();
  for (const m of kalshiMarkets || []) {
    if (!m || !m.event_ticker) continue;
    (byEvent.get(m.event_ticker) || byEvent.set(m.event_ticker, []).get(m.event_ticker)).push(m);
  }
  const poly = [];
  for (const m of polyMarkets || []) {
    if (!m || m.closed || m.active === false) continue;
    if (m.sportsMarketType && m.sportsMarketType !== 'moneyline') continue;
    const outcomes = parseArr(m.outcomes), tokens = parseArr(m.clobTokenIds);
    if (outcomes.length !== 2 || tokens.length !== 2) continue;
    const start = Date.parse(m.gameStartTime || m.startDate || m.endDate || '');
    if (!Number.isFinite(start)) continue;
    const fee = m.feeSchedule && typeof m.feeSchedule.rate === 'number' ? m.feeSchedule.rate : null;
    poly.push({ m, outcomes, tokens, start, fee, title: m.question || m.slug || '' });
  }
  const pairs = [];
  for (const [evt, ms] of byEvent) {
    if (ms.length !== 2) continue;
    const teams = ms.map(x => String(x.yes_sub_title || x.title || '').replace(/ wins?$/i, ''));
    const kEnd = Date.parse(ms[0].expected_expiration_time || ms[0].close_time || '');
    let best = null;
    for (const p of poly) {
      if (Number.isFinite(kEnd) && Math.abs(p.start - kEnd) > 14 * 3600e3) continue;
      let map = null;
      if (teamMatch(sport, teams[0], p.outcomes[0]) && teamMatch(sport, teams[1], p.outcomes[1])) map = [0, 1];
      else if (teamMatch(sport, teams[0], p.outcomes[1]) && teamMatch(sport, teams[1], p.outcomes[0])) map = [1, 0];
      if (!map) continue;
      const dt = Number.isFinite(kEnd) ? Math.abs(p.start - kEnd) : 0;
      if (!best || dt < best.dt) best = { p, map, dt };
    }
    if (!best) continue;
    const { p, map } = best;
    pairs.push({
      sport, event: evt, game: p.title.slice(0, 60), startMs: p.start, feeRate: p.fee,
      legs: ms.map((k, i) => ({ team: p.outcomes[map[i]], kTicker: k.ticker, pToken: p.tokens[map[i]] })),
    });
  }
  return pairs;
}

export function isLive(pair, nowMs) {
  return pair.startMs - XV_LIVE_BEFORE_MS <= nowMs && nowMs <= pair.startMs + XV_LIVE_AFTER_MS;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Kalshi 429s most unauthenticated calls that arrive from Cloudflare's shared
// egress (the same calls from elsewhere return 200), so calls are signed with
// the operator's API key when KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY are set
// (src/kalshi.js, pushed by push-kalshi-key.yml). Either way: identify
// ourselves, honour Retry-After, back off 2s/4s/8s.
export { KALSHI_UA } from './kalshi.js';
export const KALSHI_RETRIES = 3;
async function kalshiJson(env, path, retry = KALSHI_RETRIES) {
  const { headers } = await kalshiHeaders(env, 'GET', path);
  const res = await fetch(`${KALSHI_API}${path}`, { headers });
  if (res.status === 429 && retry > 0) {
    const ra = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : 0);
    await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 2000 * Math.pow(2, KALSHI_RETRIES - retry));
    return kalshiJson(env, path, retry - 1);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`kalshi ${res.status} (check KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY) ${path.slice(0, 40)}`);
  if (!res.ok) throw new Error(`kalshi ${res.status} ${path.slice(0, 60)}`);
  return res.json();
}

async function gammaMarketsByTag(tag, nowMs = Date.now()) {
  const out = [];
  const endMin = new Date(nowMs - 6 * 3600e3).toISOString();
  for (let off = 0; off < 400; off += 100) {
    const res = await fetch(`${GAMMA_API}/events?tag_slug=${encodeURIComponent(tag)}&active=true&closed=false&limit=100&offset=${off}&order=endDate&ascending=true&end_date_min=${encodeURIComponent(endMin)}`);
    if (!res.ok) break;
    const events = await res.json();
    for (const e of events) for (const m of e.markets || []) {
      // keep only what matching needs: a page of sports events is megabytes of descriptions
      out.push({ question: m.question, slug: m.slug, outcomes: m.outcomes, clobTokenIds: m.clobTokenIds, gameStartTime: m.gameStartTime, startDate: m.startDate || e.startDate, endDate: m.endDate, sportsMarketType: m.sportsMarketType, feeSchedule: m.feeSchedule, active: m.active, closed: m.closed, _event: e.title });
    }
    if (events.length < 100) break;
  }
  return out;
}

// Polymarket US (gateway.polymarket.us/v2/leagues/{slug}/events): the league's
// upcoming games with their moneyline market. Pure matcher below; this fetch
// returns slim rows {slug, startMs, teams:[long, short]} where `long` is the
// side the US instrument quotes (bestBid/bestAsk belong to it).
async function usLeagueGames(league) {
  const res = await fetch(`${US_API}/v2/leagues/${encodeURIComponent(league)}/events?limit=100`);
  if (!res.ok) throw new Error(`polymarket.us ${res.status}`);
  const data = await res.json();
  const out = [];
  for (const e of data.events || []) {
    if (!e || e.closed || e.ended) continue;
    const ml = (e.markets || []).find(m => m && (m.sportsMarketTypeV2 === 'SPORTS_MARKET_TYPE_MONEYLINE' || /winner|moneyline/i.test(m.sportsMarketType || '')) && Array.isArray(m.marketSides) && m.marketSides.length === 2);
    if (!ml) continue;
    const sides = [...ml.marketSides].sort((a, b) => (b.long ? 1 : 0) - (a.long ? 1 : 0));   // long first
    out.push({ slug: ml.slug, startMs: Date.parse(e.startDate || e.startTime || ''), teams: sides.map(s => (s.team && s.team.name) || s.description || '') });
  }
  return out;
}

// Pure: attach each pair's Polymarket US market (slug + which leg is the US
// instrument's long side). Both teams must match and kickoffs be within 6h.
export function attachUs(sport, pairs, usGames) {
  let n = 0;
  for (const p of pairs || []) {
    if (!p || !Array.isArray(p.legs) || p.legs.length !== 2) continue;
    for (const g of usGames || []) {
      if (!Number.isFinite(g.startMs) || Math.abs(g.startMs - p.startMs) > 6 * 3600e3) continue;
      let longIdx = -1;
      if (teamMatch(sport, g.teams[0], p.legs[0].team) && teamMatch(sport, g.teams[1], p.legs[1].team)) longIdx = 0;
      else if (teamMatch(sport, g.teams[0], p.legs[1].team) && teamMatch(sport, g.teams[1], p.legs[0].team)) longIdx = 1;
      if (longIdx < 0) continue;
      p.usSlug = g.slug; p.usLongIdx = longIdx; n++; break;
    }
  }
  return n;
}

// Rebuild the matched-pairs list (Kalshi game series x Polymarket tags, plus
// the Polymarket US moneyline where one exists), one Kalshi call and one
// Polymarket US call per sport. Cached in KV for XV_PAIRS_TTL_MS; games are
// kept while they are within 36h ahead or 6h behind.
export async function buildPairs(env, nowMs = Date.now()) {
  const pairs = []; const diag = {};
  for (const [sport, cfg] of Object.entries(XV_SPORTS)) {
    try {
      const k = await kalshiJson(env, `/markets?series_ticker=${cfg.series}&status=open&limit=1000`);
      const kal = (k.markets || []).filter(m => { const t = Date.parse(m.expected_expiration_time || m.close_time || ''); return !Number.isFinite(t) || (t > nowMs - 6 * 3600e3 && t < nowMs + 48 * 3600e3); });
      if (!kal.length) { diag[sport] = { kalshi: 0 }; continue; }
      let poly = [];
      for (const tag of cfg.tags) poly = poly.concat(await gammaMarketsByTag(tag, nowMs));
      const got = matchPairs(sport, kal, poly, nowMs).filter(p => p.startMs > nowMs - 6 * 3600e3 && p.startMs < nowMs + 36 * 3600e3);
      diag[sport] = { kalshi: kal.length, poly: poly.length, matched: got.length };
      if (cfg.us && got.length) {
        try { diag[sport].us = attachUs(sport, got, await usLeagueGames(cfg.us)); }
        catch (e) { diag[sport].usError = e.message.slice(0, 60); }
      }
      pairs.push(...got);
    } catch (e) { diag[sport] = { error: e.message.slice(0, 80) }; }
    await sleep(2500);   // pace the Kalshi series calls (6 sports x 2.5s fits the cron easily)
  }
  const blob = { builtAt: nowMs, pairs, diag, kalshiAuth: kalshiAuthConfigured(env) };
  try { await env.SIGNALS_CACHE.put(XV_KEYS.PAIRS, JSON.stringify(blob), { expirationTtl: 3600 }); } catch (e) {}
  return blob;
}

// Polymarket US top of book for one market: best bid/ask with the shares shown
// there (/book), else best bid/ask alone (/bbo). null when neither answers.
export async function usTopOfBook(slug) {
  const v = (x) => (x && x.value != null ? Number(x.value) : null);
  try {
    const res = await fetch(`${US_API}/v1/markets/${encodeURIComponent(slug)}/book`);
    if (res.ok) {
      const md = (await res.json()).marketData || {};
      const top = (lv, pick) => { const xs = (lv || []).map(l => ({ px: v(l.px), qty: l.qty != null ? Number(l.qty) : null })).filter(l => l.px > 0); if (!xs.length) return null; return xs.reduce((a, b) => (pick(b.px, a.px) ? b : a)); };
      // the gateway names the ask side `offers` (older docs: `asks`); either is accepted
      const b = top(md.bids, (x, y) => x > y), a = top(md.offers || md.asks, (x, y) => x < y);
      if (b || a) return { bid: b ? b.px : null, ask: a ? a.px : null, last: null, bidQty: b ? b.qty : null, askQty: a ? a.qty : null };
    }
  } catch (e) { /* fall through to /bbo */ }
  const res = await fetch(`${US_API}/v1/markets/${encodeURIComponent(slug)}/bbo`);
  if (!res.ok) return null;
  const md = (await res.json()).marketData || {};
  return { bid: v(md.bestBid), ask: v(md.bestAsk), last: v(md.lastTradePx), bidQty: null, askQty: null };
}

const bestOf = (book) => {
  const asks = (book?.asks || []).map(a => Number(a.price)).filter(x => x > 0), bids = (book?.bids || []).map(a => Number(a.price)).filter(x => x > 0);
  return { bid: bids.length ? Math.max(...bids) : null, ask: asks.length ? Math.min(...asks) : null, last: book?.last_trade_price != null ? Number(book.last_trade_price) : null };
};

// One sample: Kalshi top-of-book (one call, ticker list) + Polymarket books
// (one POST) for every live leg -> D1 rows. Returns a small status object.
// `hooks.afterSample(sampledLiveLegs, nowMs)` runs once the rows are stored
// (the Polymarket US paper lane, src/us-lane.js, hangs off it); its result
// lands in status.usLane and its failure never fails the sample.
export async function sampleXvenue(env, nowMs = Date.now(), hooks = {}) {
  const mark = async (stage, extra) => { try { await env.SIGNALS_CACHE.put(XV_KEYS.BOOT, JSON.stringify({ at: new Date(nowMs).toISOString(), stage, ...(extra || {}) }), { expirationTtl: 86400 }); } catch (e) {} };
  await mark('start');
  let blob = null;
  try { blob = await env.SIGNALS_CACHE.get(XV_KEYS.PAIRS, { type: 'json' }); } catch (e) {}
  if (!blob || !Array.isArray(blob.pairs) || nowMs - (blob.builtAt || 0) > XV_PAIRS_TTL_MS) { await mark('build'); blob = await buildPairs(env, nowMs); }
  const live = blob.pairs.filter(p => isLive(p, nowMs));
  await mark('quotes', { pairs: blob.pairs.length, live: live.length });
  const status = { at: new Date(nowMs).toISOString(), pairs: blob.pairs.length, live: live.length, rows: 0, kalshiAuth: kalshiAuthConfigured(env), diag: blob.diag };
  if (!live.length) {
    // Nothing to sample, but the lane still has marks to fill and backfills to run between games.
    if (typeof hooks.afterSample === 'function') { try { status.usLane = await hooks.afterSample([], nowMs); } catch (e) { status.usLaneError = e.message.slice(0, 80); } }
    try { await env.SIGNALS_CACHE.put(XV_KEYS.LAST, JSON.stringify(status), { expirationTtl: 86400 }); } catch (e) {}
    await mark('done', { rows: 0, live: 0 }); return status;
  }
  const legs = live.flatMap(p => p.legs.map((l, i) => ({ ...l, sport: p.sport, game: p.game, startMs: p.startMs, feeRate: p.feeRate, usSlug: p.usSlug || null, usLong: p.usLongIdx === i })));
  const kq = new Map();
  let kalshiCooldown = null; try { kalshiCooldown = await env.SIGNALS_CACHE.get(XV_KEYS.KALSHI_COOLDOWN); } catch (e) {}
  if (kalshiCooldown) status.kalshiSkipped = 'cooldown after 429';
  else for (let i = 0; i < legs.length; i += 40) {
    try { const r = await kalshiJson(env, `/markets?tickers=${legs.slice(i, i + 40).map(l => l.kTicker).join(',')}&limit=100`); for (const m of r.markets || []) kq.set(m.ticker, m); }
    catch (e) {
      status.kalshiError = e.message.slice(0, 80);
      if (/429/.test(e.message)) { try { await env.SIGNALS_CACHE.put(XV_KEYS.KALSHI_COOLDOWN, '1', { expirationTtl: XV_KALSHI_COOLDOWN_S }); } catch (e2) {} }
      break;
    }
  }
  status.kQuoted = kq.size;
  const pq = new Map();
  for (let i = 0; i < legs.length; i += 40) {
    try {
      const res = await fetch(`${CLOB_API}/books`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(legs.slice(i, i + 40).map(l => ({ token_id: l.pToken }))) });
      if (res.ok) for (const b of await res.json()) pq.set(b.asset_id, b);
    } catch (e) { status.polyError = e.message.slice(0, 80); }
  }
  // Polymarket US: one call per live game (the instrument quotes the long side).
  // /book gives the top of book with the shares shown there; /bbo (no sizes) is the fallback.
  const uq = new Map();
  const usSlugs = [...new Set(live.map(p => p.usSlug).filter(Boolean))].slice(0, US_MAX_BBO_CALLS);
  for (const slug of usSlugs) {
    try {
      const q = await usTopOfBook(slug);
      if (q) uq.set(slug, q);
    } catch (e) { status.usError = e.message.slice(0, 80); }
  }
  const ts = Math.floor(nowMs / 1000);
  const stmts = []; const sampled = [];
  for (const l of legs) {
    const k = kq.get(l.kTicker), b = pq.get(l.pToken), u = l.usSlug ? uq.get(l.usSlug) : null;
    if (!k && !b && !u) continue;
    const p = bestOf(b);
    const num = (v) => (v == null || v === '' ? null : Number(v));
    const c = (x) => (x == null ? null : Math.round((1 - x) * 10000) / 10000);
    // the US instrument quotes one side; the other leg's bid/ask are the complements (and its sizes swap)
    const us = !u ? { bid: null, ask: null, last: null, bidQty: null, askQty: null } : l.usLong ? u : { bid: c(u.ask), ask: c(u.bid), last: c(u.last), bidQty: u.askQty ?? null, askQty: u.bidQty ?? null };
    const phase = l.startMs > nowMs ? 'pre' : 'live';
    stmts.push(env.DB.prepare(`INSERT INTO xvenue_quotes (ts, sport, game, team, phase, k_ticker, k_bid, k_ask, k_last, p_token, p_bid, p_ask, p_last, p_fee_rate, us_bid, us_ask, us_last, us_bid_qty, us_ask_qty) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(ts, l.sport, l.game, l.team, phase, l.kTicker, k ? num(k.yes_bid_dollars) : null, k ? num(k.yes_ask_dollars) : null, k ? num(k.last_price_dollars) : null, l.pToken, p.bid, p.ask, p.last, l.feeRate, us.bid, us.ask, us.last, us.bidQty, us.askQty));
    if (phase === 'live') sampled.push({ ts, sport: l.sport, game: l.game, team: l.team, p_token: l.pToken, us_slug: l.usSlug, us_long: !!l.usLong, p_bid: p.bid, p_ask: p.ask, us_bid: us.bid, us_ask: us.ask, us_bid_qty: us.bidQty, us_ask_qty: us.askQty });
  }
  status.usQuoted = uq.size;
  if (stmts.length) {
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    status.rows = stmts.length;
  }
  if (typeof hooks.afterSample === 'function') {
    try { status.usLane = await hooks.afterSample(sampled, nowMs); } catch (e) { status.usLaneError = e.message.slice(0, 80); }
  }
  if (new Date(nowMs).getUTCMinutes() === 7) {
    try { await env.DB.prepare(`DELETE FROM xvenue_quotes WHERE ts < ?`).bind(ts - XV_PRUNE_DAYS * 86400).run(); } catch (e) {}
  }
  try { await env.SIGNALS_CACHE.put(XV_KEYS.LAST, JSON.stringify(status), { expirationTtl: 86400 }); } catch (e) {}
  await mark('done', { rows: status.rows });
  return status;
}

export const usFee = (p, rate = US_TAKER_RATE) => rate * p * (1 - p);
export const kalshiFee = (p, rate = KALSHI_TAKER_RATE) => rate * p * (1 - p);

// Pure: turn ordered rows for one (game, team) into lead/lag evidence.
// For each minute where Polymarket's mid moved by >= moveC cents, was Kalshi's
// quote at that same minute still crossable after Kalshi's taker fee?
//   up-move  : Polymarket bid now above Kalshi's ask  -> buy Kalshi, hedge/sell on Polymarket
//   down-move: Kalshi's bid still above Polymarket ask -> sell Kalshi (buy its NO)
// Also: who moved first (sign agreement of this minute's Polymarket move with
// Kalshi's move this minute vs next minute), and the average mid gap/spreads.
export function analyzeSeries(rows, { moveC = 3, feeRate = KALSHI_TAKER_RATE, usRate = US_TAKER_RATE } = {}) {
  const out = { samples: 0, bothQuoted: 0, polyMoves: 0, staleKalshi: 0, staleEdgeC: 0, kalshiSameMin: 0, kalshiNextMin: 0, kalshiLeads: 0, gapAbsSumC: 0, kSpreadSumC: 0, pSpreadSumC: 0,
    usQuoted: 0, usGapAbsSumC: 0, usSpreadSumC: 0, staleUs: 0, staleUsEdgeC: 0, kUsCross: 0, kUsCrossEdgeC: 0 };
  const mid = (b, a) => (b != null && a != null ? (b + a) / 2 : null);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; out.samples++;
    const pm = mid(r.p_bid, r.p_ask);
    if (pm == null) continue;                       // Polymarket is the reference; nothing to compare without it
    const km = mid(r.k_bid, r.k_ask), um = mid(r.us_bid, r.us_ask);
    if (km != null) { out.bothQuoted++; out.gapAbsSumC += Math.abs(pm - km) * 100; out.kSpreadSumC += (r.k_ask - r.k_bid) * 100; out.pSpreadSumC += (r.p_ask - r.p_bid) * 100; }
    if (um != null) {
      out.usQuoted++; out.usGapAbsSumC += Math.abs(pm - um) * 100; out.usSpreadSumC += (r.us_ask - r.us_bid) * 100;
      if (km != null) {
        // the one fully US-legal pair: buy on one venue, sell on the other, both taker fees paid
        const c1 = r.k_bid - r.us_ask - kalshiFee(r.k_bid, feeRate) - usFee(r.us_ask, usRate);   // buy US, sell Kalshi
        const c2 = r.us_bid - r.k_ask - usFee(r.us_bid, usRate) - kalshiFee(r.k_ask, feeRate);   // buy Kalshi, sell US
        const c = Math.max(c1, c2);
        if (c > 0) { out.kUsCross++; out.kUsCrossEdgeC += c * 100; }
      }
    }
    const prev = i > 0 ? rows[i - 1] : null;
    const ppm = prev ? mid(prev.p_bid, prev.p_ask) : null;
    if (ppm == null || r.ts - prev.ts > 180) continue;
    const pkm = mid(prev.k_bid, prev.k_ask);
    const dP = (pm - ppm) * 100;
    const next = rows[i + 1]; const nextOk = next && next.ts - r.ts <= 180;
    if (Math.abs(dP) >= moveC) {
      out.polyMoves++;
      if (km != null) {
        const edge = dP > 0 ? r.p_bid - r.k_ask - kalshiFee(r.k_ask, feeRate) : r.k_bid - r.p_ask - kalshiFee(r.k_bid, feeRate);
        if (edge > 0) { out.staleKalshi++; out.staleEdgeC += edge * 100; }
        if (pkm != null) { const dK = (km - pkm) * 100; if (Math.sign(dK) === Math.sign(dP) && Math.abs(dK) >= moveC / 2) out.kalshiSameMin++; }
        const nkm = nextOk ? mid(next.k_bid, next.k_ask) : null;
        if (nkm != null && Math.sign((nkm - km) * 100) === Math.sign(dP) && Math.abs(nkm - km) * 100 >= moveC / 2) out.kalshiNextMin++;
      }
      if (um != null) {
        const ue = dP > 0 ? r.p_bid - r.us_ask - usFee(r.us_ask, usRate) : r.us_bid - r.p_ask - usFee(r.us_bid, usRate);
        if (ue > 0) { out.staleUs++; out.staleUsEdgeC += ue * 100; }
      }
    }
    if (km != null && pkm != null) {
      const dK = (km - pkm) * 100;
      const npm = nextOk ? mid(next.p_bid, next.p_ask) : null;
      if (Math.abs(dK) >= moveC && Math.abs(dP) < moveC / 2 && npm != null && Math.sign((npm - pm) * 100) === Math.sign(dK) && Math.abs(npm - pm) * 100 >= moveC / 2) out.kalshiLeads++;
    }
  }
  return out;
}

// Read back the last `hours` of live-phase rows and aggregate per sport.
export async function xvenueReport(env, { hours = 48, moveC = 3 } = {}) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const q = await env.DB.prepare(`SELECT ts, sport, game, team, k_bid, k_ask, p_bid, p_ask, us_bid, us_ask FROM xvenue_quotes WHERE ts >= ? AND phase = 'live' ORDER BY sport, game, team, ts LIMIT 60000`).bind(since).all();
  const rows = (q && q.results) || [];
  // Which venues actually delivered quotes (a 429 from Kalshi leaves k_* null while p_*/us_* fill).
  let quoted = {};
  try {
    const h = await env.DB.prepare(`SELECT sport, COUNT(*) AS n, SUM(k_bid IS NOT NULL) AS k, SUM(p_bid IS NOT NULL) AS p, SUM(us_bid IS NOT NULL) AS us FROM xvenue_quotes WHERE ts >= ? AND phase = 'live' GROUP BY sport`).bind(since).all();
    for (const r of (h && h.results) || []) quoted[r.sport] = { rows: r.n, kalshi: r.k, polymarket: r.p, polymarketUs: r.us };
  } catch (e) { quoted = { error: e.message.slice(0, 60) }; }
  const groups = new Map();
  for (const r of rows) { const k = `${r.sport}|${r.game}|${r.team}`; (groups.get(k) || groups.set(k, []).get(k)).push(r); }
  const bySport = {};
  for (const [k, series] of groups) {
    const sport = k.split('|')[0];
    const a = analyzeSeries(series, { moveC });
    const s = bySport[sport] || (bySport[sport] = { legs: 0, samples: 0, bothQuoted: 0, polyMoves: 0, staleKalshi: 0, staleEdgeC: 0, kalshiSameMin: 0, kalshiNextMin: 0, kalshiLeads: 0, gapAbsSumC: 0, kSpreadSumC: 0, pSpreadSumC: 0, usQuoted: 0, usGapAbsSumC: 0, usSpreadSumC: 0, staleUs: 0, staleUsEdgeC: 0, kUsCross: 0, kUsCrossEdgeC: 0 });
    s.legs++; for (const f of Object.keys(a)) s[f] += a[f];
  }
  for (const s of Object.values(bySport)) {
    s.avgGapC = s.bothQuoted ? +(s.gapAbsSumC / s.bothQuoted).toFixed(2) : null;
    s.avgKalshiSpreadC = s.bothQuoted ? +(s.kSpreadSumC / s.bothQuoted).toFixed(2) : null;
    s.avgPolySpreadC = s.bothQuoted ? +(s.pSpreadSumC / s.bothQuoted).toFixed(2) : null;
    s.staleRate = s.polyMoves ? +(s.staleKalshi / s.polyMoves).toFixed(3) : null;
    s.avgStaleEdgeC = s.staleKalshi ? +(s.staleEdgeC / s.staleKalshi).toFixed(2) : null;
    s.avgUsGapC = s.usQuoted ? +(s.usGapAbsSumC / s.usQuoted).toFixed(2) : null;
    s.avgUsSpreadC = s.usQuoted ? +(s.usSpreadSumC / s.usQuoted).toFixed(2) : null;
    s.staleUsRate = s.polyMoves && s.usQuoted ? +(s.staleUs / s.polyMoves).toFixed(3) : null;
    s.avgStaleUsEdgeC = s.staleUs ? +(s.staleUsEdgeC / s.staleUs).toFixed(2) : null;
    s.kUsCrossRate = s.usQuoted ? +(s.kUsCross / s.usQuoted).toFixed(4) : null;
    s.avgKUsCrossEdgeC = s.kUsCross ? +(s.kUsCrossEdgeC / s.kUsCross).toFixed(2) : null;
    delete s.gapAbsSumC; delete s.kSpreadSumC; delete s.pSpreadSumC; delete s.staleEdgeC; delete s.usGapAbsSumC; delete s.usSpreadSumC; delete s.staleUsEdgeC; delete s.kUsCrossEdgeC;
  }
  let last = null, boot = null; try { last = await env.SIGNALS_CACHE.get(XV_KEYS.LAST, { type: 'json' }); boot = await env.SIGNALS_CACHE.get(XV_KEYS.BOOT, { type: 'json' }); } catch (e) {}
  return {
    success: true, hours, moveC, rows: rows.length, legs: groups.size, quoted, bySport, last, boot,
    read: `polyMoves = minutes where Polymarket's mid moved >= ${moveC}c; staleKalshi = of those, Kalshi's same-minute quote was still crossable after its ${KALSHI_TAKER_RATE * 100}% x p(1-p) taker fee (avgStaleEdgeC = cents of edge per share); kalshiSameMin/NextMin = Kalshi moved the same way that minute / the next; kalshiLeads = Kalshi moved first and Polymarket followed. A Kalshi lane is worth building only if staleRate x avgStaleEdgeC is meaningfully positive over many games. us* = the same for Polymarket US (taker ${US_TAKER_RATE * 100}% x p(1-p)); kUsCross = minutes where buying on one US-legal venue and selling on the other cleared both taker fees (the only fully legal arbitrage pair for a US operator).`,
  };
}

// Polymarket US adapter: the CFTC-regulated US venue (polymarket.us). Market
// data is public on gateway.polymarket.us; trading is on api.polymarket.us
// with an Ed25519 signature over `${timestampMs}${METHOD}${pathname}` (the
// query string and body are not signed), base64-encoded, in X-PM-Signature;
// X-PM-Access-Key carries the key id, X-PM-Timestamp the ms timestamp (±30s).
// Only the long (YES) side of a market is tradable; the short side is
// synthetic exposure and order prices are always the YES price. Fees: taker
// 0.0695 x p x (1-p) per contract (Table Tennis 0.10), same on buys and
// sells, makers below $10M/month earn nothing. Retail limit 25 req/s per IP.
// Secrets PMUS_KEY_ID / PMUS_SECRET_KEY are pushed by
// .github/workflows/push-polymarket-us-key.yml (keys at polymarket.us/developer).
import { teamMatch } from './xvenue.js';

export const PMUS_API = 'https://api.polymarket.us';
export const PMUS_GATEWAY = 'https://gateway.polymarket.us';
export const PMUS_FEE = 0.0695;
export const PMUS_KEYS = { EVENTS: 'pmus_events', MARKET: 'pmus_market' };
export const EVENTS_TTL_S = 600, MARKET_TTL_S = 1800;
// global Polymarket slug prefix -> Polymarket US league slug(s), tried in order (Oct 25 2026: tennis,
// soccer, UFC/boxing and esports added on the owner's word). The US big four + CFB keep the
// city/nickname matcher in xvenue.js; every other sport matches on normalized names (nameScore).
export const LEAGUES = {
  nfl: ['nfl'], cfb: ['cfb'], ncaaf: ['cfb'], nba: ['nba'], nhl: ['nhl'], mlb: ['mlb'],
  wnba: ['wnba'], cbb: ['cbb'], khl: ['khl'], euroleague: ['eurolg'], bknbl: ['nbl'], bkkbl: ['kbl'],
  // tennis: challengers and qualifying share the tour league on the US side; ITF splits by gender (see leaguesOf)
  atp: ['atp', 'atpcq'], wta: ['wta'], itf: ['itfm', 'itfw'],
  // combat sports
  ufc: ['ufc', 'dwcs'], mma: ['ufc', 'pfl', 'one'], boxing: ['boxing'],
  // esports: match winner only (game/map winners and handicaps are sub-markets, see marketKind)
  lol: ['lol'], cs2: ['cs2'], csgo: ['cs2'], dota2: ['dota2'], val: ['valorant'], valorant: ['valorant'], cod: ['cod'], rl: ['rl'], ow: ['ow'], r6: ['r6'],
  // soccer: "Will X win" is the long side of X's own full-time market (the draw is a separate market)
  epl: ['epl'], lal: ['lal'], ucl: ['ucl'], uel: ['uel'], uecl: ['uecl'], sea: ['sea'], bun: ['bun'], bun2: ['bun2'], bl2: ['bun2'], fl1: ['lg1'], fl2: ['lig2'],
  mls: ['mls'], ere: ['ere'], por: ['ligpor'], lib: ['lib'], sud: ['sud'], bra: ['bra'], bra2: ['brb'], mex: ['lmx'], elc: ['eflch'], efl1: ['efl1'], efl2: ['efl2'],
  arg: ['lpa', 'arg2'], tur: ['tsl'], spl: ['spl'], kor: ['kl1'], jap: ['j1', 'j2'], ja2: ['j2', 'j1'], swe: ['alsv'], swe2: ['swe2'], scop: ['scp'], acle: ['acle'],
  es2: ['lal2'], itsb: ['srb'], col1: ['lco'], chi1: ['pdc'], per1: ['pl1'], fin1: ['vkl'], bel1: ['bel1'], gre1: ['grsl'], nor: ['els'], pol: ['ekst'], sui: ['swsl'], chi: ['csl'], idn1: ['idnsl'],
};
const ALIAS_LEAGUES = new Set(['nfl', 'cfb', 'nba', 'nhl', 'mlb']);
const TITLE_LEAGUES = [
  [/\bnfl\b/, ['nfl']], [/\bnba\b/, ['nba']], [/\bnhl\b/, ['nhl']], [/\bmlb\b/, ['mlb']], [/college football|\bcfb\b|\bncaaf\b/, ['cfb']], [/\bwnba\b/, ['wnba']],
  [/^lol:|league of legends/, ['lol']], [/^(counter-strike|cs2|csgo):/, ['cs2']], [/^dota 2:/, ['dota2']], [/^valorant:/, ['valorant']], [/^(call of duty|cod):/, ['cod']],
  [/^ufc\b/, ['ufc', 'dwcs']], [/^boxing\b/, ['boxing']], [/\bkhl\b/, ['khl']],
];

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const b64ToBytes = (b64) => Uint8Array.from(atob(String(b64).trim()), c => c.charCodeAt(0));
const bytesToB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

export class PmusError extends Error { constructor(message, status, body) { super(message); this.status = status; this.body = body; } }

export const pmusConfigured = (env) => !!(env && env.PMUS_KEY_ID && env.PMUS_SECRET_KEY);

// ---- signing ----
export function signingMessage(tsMs, method, pathname) { return `${tsMs}${String(method).toUpperCase()}${pathname}`; }
// The secret is a base64 Ed25519 key: 32-byte seed, or 64 bytes (seed || public) of which the first 32 are the seed.
export function decodeSecret(secretB64) {
  const bytes = b64ToBytes(secretB64);
  if (bytes.length === 64) return bytes.slice(0, 32);
  if (bytes.length !== 32) throw new PmusError(`PMUS_SECRET_KEY decodes to ${bytes.length} bytes; expected 32 or 64`, 0);
  return bytes;
}
// PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410): the 16-byte prefix then the seed as an OCTET STRING.
export function seedToPkcs8(seed) {
  const prefix = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
  const out = new Uint8Array(prefix.length + 32); out.set(prefix, 0); out.set(seed, prefix.length); return out;
}
export async function importPmusKey(secretB64) {
  return crypto.subtle.importKey('pkcs8', seedToPkcs8(decodeSecret(secretB64)), { name: 'Ed25519' }, false, ['sign']);
}
export async function pmusHeaders(env, method, pathname, nowMs = Date.now()) {
  if (!pmusConfigured(env)) throw new PmusError('Polymarket US credentials not configured (PMUS_KEY_ID / PMUS_SECRET_KEY)', 0);
  const key = await importPmusKey(env.PMUS_SECRET_KEY);
  const ts = String(Math.floor(nowMs));
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(signingMessage(ts, method, pathname)));
  return { 'X-PM-Access-Key': String(env.PMUS_KEY_ID).trim(), 'X-PM-Timestamp': ts, 'X-PM-Signature': bytesToB64(sig), 'Content-Type': 'application/json' };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Authenticated request. One retry after a 429 (the docs: wait >= 1s); any other non-2xx throws with the body.
export async function pmusRequest(env, method, path, { query = null, body = null, fetchImpl = fetch, nowMs = Date.now(), retry = 1 } = {}) {
  const url = new URL(path, PMUS_API);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
  const headers = await pmusHeaders(env, method, url.pathname, nowMs);
  const res = await fetchImpl(url.toString(), { method: String(method).toUpperCase(), headers, body: body != null ? JSON.stringify(body) : undefined });
  if (res.status === 429 && retry > 0) { await sleep(1000); return pmusRequest(env, method, path, { query, body, fetchImpl, nowMs: Date.now(), retry: retry - 1 }); }
  let data = null; try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) throw new PmusError(`polymarket.us ${res.status} ${String(method).toUpperCase()} ${url.pathname}${data && data.message ? `: ${String(data.message).slice(0, 120)}` : ''}`, res.status, data);
  return data;
}

// ---- market mapping: a global-Polymarket intent -> a Polymarket US moneyline + side ----
export const slugPrefix = (intent) => { const m = String((intent && intent.marketSlug) || '').toLowerCase().match(/^([a-z0-9]+)-/); return m ? m[1] : null; };
// Ordered list of Polymarket US leagues to search for this intent ([] = not routable).
export function leaguesOf(intent) {
  const p = slugPrefix(intent);
  if (p && LEAGUES[p]) { if (p === 'itf' && /^W\d/i.test(String(intent.marketTitle || '').trim())) return ['itfw', 'itfm']; return LEAGUES[p]; }
  const text = `${intent.marketCategory || ''} ${intent.marketTitle || ''}`.toLowerCase().trim();
  for (const [re, ls] of TITLE_LEAGUES) if (re.test(text)) return ls;
  return [];
}
export function leagueOf(intent) { return leaguesOf(intent)[0] || null; }
// What the global market is. Only a match/game winner ("moneyline") can be mirrored on the US book.
export function marketKind(intent) {
  const slug = String(intent.marketSlug || '').toLowerCase(), title = String(intent.marketTitle || '');
  if (/\bwill\b.*\band\b.*\bwill\b/i.test(title)) return 'combo';
  if (/-(total|spread|handicap|game-handicap|map-handicap)(-|$)/.test(slug) || /(\bo\/u\b|over\/under|\bspread\b|\bhandicap\b|\btotals?\b)/i.test(title)) return 'spread/total';
  if (/-(game|map|set)\d+(-|$)/.test(slug) || /\b(game|map|set) \d+\b/i.test(title) || /\b(first blood|first kill|1st half|first half|rounds?)\b/i.test(title)) return 'sub-market';
  return 'moneyline';
}
// "A vs B" (with a tournament/league prefix and a series/qualifier suffix tolerated) or "Will X win".
export function teamsOfTitle(title) {
  const t0 = String(title || '').trim();
  const m = t0.match(/^(.*?)\s+vs\.?\s+(.*)$/i);
  if (m) {
    let a = m[1], b = m[2];
    const ci = a.lastIndexOf(': '); if (ci >= 0) a = a.slice(ci + 2);
    b = b.split(/\s+-\s+|:\s|\s*\(|\?/)[0];
    a = a.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim(); b = b.trim();
    if (a && b) return [a, b];
  }
  const w = t0.replace(/\s*\(.*?\)\s*$/, '').match(/^Will (.+?) win\b/i);
  if (w) return [w[1].trim()];
  return [];
}
// Which team the intent is long. directionRaw is the outcome label the bot
// holds; YES on a single-team market means that team; NO is its opponent (unknown here).
export function teamOfIntent(intent) {
  const raw = String(intent.directionRaw || '').trim();
  if (raw && !/^(yes|no)$/i.test(raw)) return raw;
  const dir0 = String(intent.direction || '').trim();
  if (dir0 && !/^(yes|no)$/i.test(dir0)) return dir0;   // some lanes put the outcome label in `direction`
  const teams = teamsOfTitle(intent.marketTitle);
  const dir = String(intent.direction || 'YES').toUpperCase();
  if (teams.length === 1) return dir === 'YES' ? teams[0] : null;
  return null;
}
// The leg to mirror: { team, no }. NO on "Will X win" is X's other side (short on X's own soccer
// market; the opponent's long side on a two-sided moneyline). null when the team cannot be told.
export function legOfIntent(intent) {
  const raw = String(intent.directionRaw || '').trim(), dir0 = String(intent.direction || '').trim();
  if (raw && !/^(yes|no)$/i.test(raw)) return { team: raw, no: false };
  if (dir0 && !/^(yes|no)$/i.test(dir0)) return { team: dir0, no: false };
  const teams = teamsOfTitle(intent.marketTitle);
  if (teams.length !== 1) return null;
  return { team: teams[0], no: /^no$/i.test(raw) || (!raw && /^no$/i.test(dir0)) };
}
// ---- name matching for sports without a city/nickname table ----
const NAME_STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'cd', 'ca', 'rc', 'rcd', 'ud', 'sd', 'sv', 'bsc', 'vfb', 'vfl', 'fk', 'sk', 'bk', 'if', 'cp', 'ss', 'ssc', 'fsv', 'spvgg', 'tsg', 'club', 'de', 'del', 'da', 'do', 'di', 'la', 'le', 'el', 'los', 'las', 'the', 'esports', 'esport', 'gaming', 'team']);
export function normName(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim(); }
export function nameTokens(s) { return normName(s).split(' ').filter(w => w && !NAME_STOP.has(w)); }
// 2 = the same name (after normalization / stop words), 1 = every significant token of the shorter
// name is in the longer one (initials may prefix-match), 0 = different. Exact beats subset when choosing.
export function nameScore(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 2;
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  if (ta.join(' ') === tb.join(' ')) return 2;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const sig = (w) => w.length >= 3 || /\d/.test(w);
  if (!short.some(sig)) return 0;
  return short.every(w => (sig(w) ? long.includes(w) : long.some(x => x.startsWith(w)))) ? 1 : 0;
}
export const nameMatch = (a, b) => nameScore(a, b) > 0;
const sideScore = (league, side, name) => (ALIAS_LEAGUES.has(league) ? (teamMatch(league, side.team, name) || (side.alt && teamMatch(league, side.alt, name)) ? 2 : 0) : Math.max(nameScore(side.team, name), nameScore(side.alt, name)));
const sameName = (league, a, b) => (ALIAS_LEAGUES.has(league) ? teamMatch(league, a, b) : nameScore(a, b) > 0);
const sideOf = (s) => ({ team: (s.team && s.team.name) || s.description || '', alt: s.description || '', long: !!s.long });
// Events -> matchable rows. A two-sided moneyline keeps its long/short sides; a soccer match (one
// Yes/No market per team plus the draw) becomes one row whose sides each carry their own market slug.
export function slimEvents(data) {
  const out = [];
  for (const e of (data && data.events) || []) {
    if (!e || e.closed || e.ended) continue;
    const startMs = Date.parse(e.startDate || e.startTime || '');
    const markets = e.markets || [];
    const ml = markets.find(m => m && m.slug && Array.isArray(m.marketSides) && m.marketSides.length === 2 && (m.sportsMarketTypeV2 === 'SPORTS_MARKET_TYPE_MONEYLINE' || (!m.sportsMarketTypeV2 && /moneyline|winner/i.test(m.sportsMarketType || ''))));
    if (ml) { out.push({ slug: ml.slug, startMs, title: e.title || '', sides: ml.marketSides.map(sideOf) }); continue; }
    const teamMarkets = markets.filter(m => m && m.slug && m.sportsMarketTypeV2 === 'SPORTS_MARKET_TYPE_DRAWABLE_OUTCOME' && Array.isArray(m.marketSides) && m.marketSides.some(x => x && x.team && x.team.name));
    if (teamMarkets.length >= 2) {
      const sides = teamMarkets.slice(0, 2).map(m => ({ ...sideOf(m.marketSides.find(x => x && x.team && x.team.name)), long: true, slug: m.slug }));
      out.push({ slug: teamMarkets[0].slug.replace(/-[^-]+$/, ''), drawable: true, startMs, title: e.title || '', sides });
    }
  }
  return out;
}
// want = 'long' (the team wins) or 'no' (the team does not win). Exact name matches beat subset
// matches, then the nearest start inside now-6h .. now+36h.
export function matchUsEvent(league, events, team, opponent = null, nowMs = Date.now(), want = 'long') {
  let best = null;
  for (const ev of events || []) {
    if (!Number.isFinite(ev.startMs) || ev.startMs < nowMs - 6 * 3600e3 || ev.startMs > nowMs + 36 * 3600e3) continue;
    let idx = -1, score = 0;
    ev.sides.forEach((s, i) => { const sc = sideScore(league, s, team); if (sc > score) { score = sc; idx = i; } });
    if (idx < 0) continue;
    const other = ev.sides[1 - idx] || null;
    if (opponent && !(other && sideScore(league, other, opponent))) continue;
    const d = Math.abs(ev.startMs - nowMs);
    if (best && (score < best.score || (score === best.score && d >= best.d))) continue;
    const base = ev.drawable ? 'long' : (ev.sides[idx].long ? 'long' : 'short');
    const side = want === 'no' ? (base === 'long' ? 'short' : 'long') : base;
    best = { score, d, slug: ev.drawable ? ev.sides[idx].slug : ev.slug, side, startMs: ev.startMs, team: ev.sides[idx].team, opponent: other ? other.team : null, drawable: !!ev.drawable };
  }
  if (!best) return null;
  const { d, score, ...rest } = best; return rest;
}
async function kvJson(env, key) { try { return await env.SIGNALS_CACHE.get(key, { type: 'json' }); } catch (e) { return null; } }
async function kvPut(env, key, v, ttl) { try { await env.SIGNALS_CACHE.put(key, JSON.stringify(v), { expirationTtl: ttl }); } catch (e) {} }
export async function fetchLeagueEvents(env, league, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const key = `${PMUS_KEYS.EVENTS}_${league}`;
  const cached = await kvJson(env, key);
  if (cached && nowMs - (cached.at || 0) < EVENTS_TTL_S * 1000) return cached.events;
  const res = await fetchImpl(`${PMUS_GATEWAY}/v2/leagues/${encodeURIComponent(league)}/events?limit=250`);
  if (!res.ok) throw new PmusError(`polymarket.us gateway ${res.status} (league ${league})`, res.status);
  const events = slimEvents(await res.json());
  await kvPut(env, key, { at: nowMs, events }, EVENTS_TTL_S);
  return events;
}
export async function fetchUsMarket(env, slug, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const key = `${PMUS_KEYS.MARKET}_${slug}`;
  const cached = await kvJson(env, key);
  if (cached && nowMs - (cached.at || 0) < MARKET_TTL_S * 1000) return cached.market;
  const res = await fetchImpl(`${PMUS_GATEWAY}/v1/market/slug/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new PmusError(`polymarket.us gateway ${res.status} (market ${slug})`, res.status);
  const m = ((await res.json()) || {}).market || {};
  const market = { slug, tick: Number(m.orderPriceMinTickSize) > 0 ? Number(m.orderPriceMinTickSize) : 0.01, minQty: Number(m.minimumTradeQty) > 0 ? Number(m.minimumTradeQty) : 1, feeCoef: Number(m.feeCoefficient) > 0 ? Number(m.feeCoefficient) : PMUS_FEE, status: m.status || null, active: m.active !== false && m.closed !== true };
  await kvPut(env, key, { at: nowMs, market }, MARKET_TTL_S);
  return market;
}
// The whole route: kind -> leagues -> events -> name match -> market details. Never throws; returns {ok:false, reason}.
export async function resolveUsMarket(env, intent, deps = {}) {
  try {
    if (intent.usSlug && intent.usSide) { const market = await fetchUsMarket(env, intent.usSlug, deps); return { ok: true, slug: intent.usSlug, side: intent.usSide, ...market }; }
    const kind = marketKind(intent);
    if (kind !== 'moneyline') return { ok: false, reason: `not a moneyline market (${kind})` };
    const leagues = leaguesOf(intent);
    if (!leagues.length) return { ok: false, reason: `league not routable (${slugPrefix(intent) || 'no slug prefix'}: no Polymarket US league mapped)` };
    const leg = legOfIntent(intent);
    if (!leg) return { ok: false, reason: 'cannot tell which team the intent is long' };
    const teams = teamsOfTitle(intent.marketTitle);
    const opponent = teams.length === 2 ? (sameName(leagues[0], teams[0], leg.team) ? teams[1] : teams[0]) : null;
    const nowMs = deps.nowMs || Date.now();
    let hit = null; const errs = [];
    for (const league of leagues) {
      let events;
      try { events = await fetchLeagueEvents(env, league, deps); } catch (e) { errs.push(String(e.message).slice(0, 80)); continue; }
      hit = matchUsEvent(league, events, leg.team, opponent, nowMs, leg.no ? 'no' : 'long');
      if (hit) { hit.league = league; break; }
    }
    if (!hit && errs.length === leagues.length) return { ok: false, reason: `routing error: ${errs[0]}` };
    if (!hit) return { ok: false, reason: `no Polymarket US ${leagues.map(l => l.toUpperCase()).join('/')} moneyline for ${leg.team}${opponent ? ` vs ${opponent}` : ''} within the window` };
    const market = await fetchUsMarket(env, hit.slug, deps);
    if (market.status && market.status !== 'MARKET_STATUS_OPEN') return { ok: false, reason: `US market ${hit.slug} is ${market.status}` };
    return { ok: true, slug: hit.slug, side: hit.side, team: hit.team, opponent: hit.opponent, startMs: hit.startMs, league: hit.league, drawable: hit.drawable, ...market };
  } catch (e) { return { ok: false, reason: `routing error: ${String(e.message).slice(0, 100)}` }; }
}

// ---- book and order math (YES-price convention) ----
export async function fetchUsBook(slug, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${PMUS_GATEWAY}/v1/markets/${encodeURIComponent(slug)}/book`);
  if (!res.ok) return null;
  const md = ((await res.json()) || {}).marketData || {};
  const lv = (xs) => (xs || []).map(l => ({ price: Number(l.px && l.px.value), size: Number(l.qty) })).filter(l => l.price > 0 && l.size > 0);
  return { bids: lv(md.bids), offers: lv(md.offers || md.asks) };
}
// Effective-price levels for our side. price = what one contract costs us
// (buy) or returns to us (sell); yesPrice = the YES price the order carries.
//   BUY long  = lift offers (cost = ask)        SELL long  = hit bids (get bid)
//   BUY short = hit bids (cost = 1 - bid)       SELL short = lift offers (get 1 - ask)
export function usLevels(book, action, side) {
  const isBuy = action === 'BUY';
  const useOffers = (isBuy && side === 'long') || (!isBuy && side === 'short');
  const src = useOffers ? (book && book.offers) || [] : (book && book.bids) || [];
  return src.map(l => ({ price: side === 'long' ? l.price : r4(1 - l.price), size: l.size, yesPrice: l.price }));
}
export const orderIntent = (action, side) => `ORDER_INTENT_${action === 'BUY' ? 'BUY' : 'SELL'}_${side === 'long' ? 'LONG' : 'SHORT'}`;
export const yesPriceFor = (side, effectivePrice) => (side === 'long' ? effectivePrice : r4(1 - effectivePrice));
// Marketable limit: BUY long and SELL short lift offers (round the YES price up); BUY short and SELL long hit bids (round down).
export function roundYesPrice(yes, tick, action, side) {
  const t = Number(tick) || 0.01; const n = yes / t;
  const up = (action === 'BUY' && side === 'long') || (action === 'SELL' && side === 'short');
  const k = up ? Math.ceil(n - 1e-9) : Math.floor(n + 1e-9);
  return r4(Math.min(1 - t, Math.max(t, k * t)));
}
export function roundQty(q, minQty) { const step = Number(minQty) > 0 ? Number(minQty) : 1; return Math.floor(q / step + 1e-9) * step; }
const decimalsOf = (tick) => Math.max(0, Math.min(6, Math.round(-Math.log10(Number(tick) || 0.01))));
// A limit order in YES terms. Default = marketable FOK with synchronous execution (the taker
// path). tif 'TIME_IN_FORCE_GOOD_TILL_DATE' + goodTillTime + postOnly = a resting maker order that
// the venue itself expires (participateDontInitiate: rejected instead of crossing).
export function buildUsOrder({ slug, action, side, effectivePrice, tick, quantity, minQty, tif = 'TIME_IN_FORCE_FILL_OR_KILL', goodTillTime = null, postOnly = false, synchronous = true, maxBlockTime = '5' }) {
  const yes = roundYesPrice(yesPriceFor(side, effectivePrice), tick, action, side);
  const o = { marketSlug: slug, intent: orderIntent(action, side), type: 'ORDER_TYPE_LIMIT', price: { value: yes.toFixed(decimalsOf(tick)), currency: 'USD' }, quantity: r4(roundQty(quantity, minQty)), tif, manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC', synchronousExecution: !!synchronous };
  if (synchronous) o.maxBlockTime = String(maxBlockTime);
  if (goodTillTime) o.goodTillTime = goodTillTime;
  if (postOnly) o.participateDontInitiate = true;
  return o;
}
// The level a resting BUY joins: long rests at the best YES bid (cost = bid); short rests at the
// best YES offer (cost = 1 - offer). null when that side of the book is empty.
export function restingLevel(book, side) {
  if (side === 'long') { const bids = (book && book.bids) || []; if (!bids.length) return null; const yes = Math.max(...bids.map(l => l.price)); return { yes: r4(yes), cost: r4(yes), shown: bids.filter(l => l.price === yes).reduce((a, l) => a + l.size, 0) }; }
  const offers = (book && book.offers) || []; if (!offers.length) return null; const yes = Math.min(...offers.map(l => l.price)); return { yes: r4(yes), cost: r4(1 - yes), shown: offers.filter(l => l.price === yes).reduce((a, l) => a + l.size, 0) };
}
// Maker rebate per contract: Polymarket US pays it only from maker tier 2 ($10M+ monthly maker
// volume; fee schedule of Oct 19 2026), so the default coefficient is 0.
export const usMakerRebatePerContract = (effectivePrice, coef = 0) => (Number(coef) > 0 ? Number(coef) * effectivePrice * (1 - effectivePrice) : 0);
export const usFeePerContract = (effectivePrice, coef = PMUS_FEE) => coef * effectivePrice * (1 - effectivePrice);
// Top of book + tape summary from the public bbo: last trade price and the cumulative shares
// traded, which together tell a dry resting order whether a print happened at its level.
export async function fetchUsBbo(slug, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${PMUS_GATEWAY}/v1/markets/${encodeURIComponent(slug)}/bbo`);
  if (!res.ok) throw new PmusError(`polymarket.us gateway ${res.status} (bbo ${slug})`, res.status);
  const md = ((await res.json()) || {}).marketData || {};
  const num = (v) => { const x = Number(v && v.value != null ? v.value : v); return Number.isFinite(x) && x > 0 ? x : null; };
  return { bid: num(md.bestBid), ask: num(md.bestAsk), last: num(md.lastTradePx), sharesTraded: md.sharesTraded != null && Number.isFinite(Number(md.sharesTraded)) ? Number(md.sharesTraded) : null, state: md.state || null };
}

// ---- trading calls ----
export const placeUsOrder = (env, order, deps) => pmusRequest(env, 'POST', '/v1/orders', { ...deps, body: order });
export const getUsOrder = (env, id, deps) => pmusRequest(env, 'GET', `/v1/order/${encodeURIComponent(id)}`, deps);
export const cancelUsOrder = (env, id, slug, deps) => pmusRequest(env, 'POST', `/v1/order/${encodeURIComponent(id)}/cancel`, { ...deps, body: { marketSlug: slug } });
export async function getUsOpenOrders(env, slug, deps) {
  const data = await pmusRequest(env, 'GET', '/v1/orders/open', { ...deps, query: slug ? { market: slug } : null });
  const list = (data && (data.orders || data.openOrders)) || (Array.isArray(data) ? data : []);
  return slug ? list.filter(o => !o.marketSlug || o.marketSlug === slug) : list;
}
export const closeUsPosition = (env, slug, deps) => pmusRequest(env, 'POST', '/v1/order/close-position', { ...deps, body: { marketSlug: slug, manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC', synchronousExecution: true, maxBlockTime: '5' } });
export async function usPositionQty(env, slug, deps) {
  const data = await pmusRequest(env, 'GET', '/v1/portfolio/positions', { ...deps, query: { market: slug, limit: 5 } });
  const p = data && data.positions && (data.positions[slug] || Object.values(data.positions)[0]);
  return p ? Number(p.netPositionDecimal ?? p.netPosition ?? 0) : 0;
}
export async function usBalances(env, deps) {
  const data = await pmusRequest(env, 'GET', '/v1/account/balances', deps);
  const b = (data && data.balances && data.balances.find(x => (x.currency || 'USD') === 'USD')) || (data && data.balances && data.balances[0]) || null;
  return b ? { currency: b.currency || 'USD', currentBalance: Number(b.currentBalance), buyingPower: Number(b.buyingPower), assetNotional: Number(b.assetNotional), openOrders: Number(b.openOrders), lastUpdated: b.lastUpdated || null } : null;
}
// Pure: a fill from the synchronous executions (lastPx is the YES price).
export function fillFromExecutions(executions, side) {
  let shares = 0, notional = 0, fee = 0;
  for (const x of executions || []) {
    const q = Number(x.lastShares), px = Number(x.lastPx && x.lastPx.value != null ? x.lastPx.value : x.lastPx);
    if (!(q > 0) || !(px > 0)) continue;
    shares += q; notional += q * px; fee += Number((x.commissionNotionalCollected && x.commissionNotionalCollected.value) ?? x.commissionNotionalCollected ?? 0) || 0;
  }
  if (!(shares > 0)) return null;
  const avgYes = notional / shares;
  return { shares: r4(shares), avgYesPx: r4(avgYes), effectivePx: r4(side === 'long' ? avgYes : 1 - avgYes), feeUsd: r2(fee) };
}
export function fillFromOrder(order, side) {
  if (!order) return null;
  const q = Number(order.cumQuantity), yes = Number(order.avgPx && order.avgPx.value != null ? order.avgPx.value : order.avgPx);
  const state = order.state || null;
  if (!(q > 0) || !(yes > 0)) return { shares: 0, state };
  return { shares: r4(q), avgYesPx: r4(yes), effectivePx: r4(side === 'long' ? yes : 1 - yes), feeUsd: r2(Number((order.commissionNotionalTotalCollected && order.commissionNotionalTotalCollected.value) || 0)), state };
}

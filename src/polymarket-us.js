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
// global Polymarket slug prefix / category word -> Polymarket US league slug
export const LEAGUES = { nfl: 'nfl', cfb: 'cfb', ncaaf: 'cfb', nba: 'nba', nhl: 'nhl', mlb: 'mlb' };

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
export function leagueOf(intent) {
  const slug = String(intent.marketSlug || '').toLowerCase();
  const m = slug.match(/^(nfl|nba|nhl|mlb|cfb|ncaaf)-/);
  if (m) return LEAGUES[m[1]];
  const text = `${intent.marketCategory || ''} ${intent.marketTitle || ''}`.toLowerCase();
  if (/\bnfl\b/.test(text)) return 'nfl';
  if (/\bnba\b/.test(text)) return 'nba';
  if (/\bnhl\b/.test(text)) return 'nhl';
  if (/\bmlb\b/.test(text)) return 'mlb';
  if (/college football|\bcfb\b|\bncaaf\b/.test(text)) return 'cfb';
  return null;
}
export function teamsOfTitle(title) {
  const t = String(title || '').replace(/\s*\(.*?\)\s*$/, '').trim();
  let m = t.match(/^(.+?)\s+vs\.?\s+(.+?)(?::.*)?$/i);
  if (m) return [m[1].trim(), m[2].trim()];
  m = t.match(/^Will (.+?) win\b/i);
  if (m) return [m[1].trim()];
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
  if (teams.length === 2) { if (dir === 'YES') return null; return null; }
  return null;
}
export function slimEvents(data) {
  const out = [];
  for (const e of (data && data.events) || []) {
    if (!e || e.closed || e.ended) continue;
    const ml = (e.markets || []).find(m => m && (m.sportsMarketTypeV2 === 'SPORTS_MARKET_TYPE_MONEYLINE' || /moneyline|winner/i.test(m.sportsMarketType || '')) && Array.isArray(m.marketSides) && m.marketSides.length === 2);
    if (!ml || !ml.slug) continue;
    out.push({ slug: ml.slug, startMs: Date.parse(e.startDate || e.startTime || ''), title: e.title || '', sides: ml.marketSides.map(s => ({ team: (s.team && s.team.name) || s.description || '', long: !!s.long })) });
  }
  return out;
}
export function matchUsEvent(league, events, team, opponent = null, nowMs = Date.now()) {
  let best = null;
  for (const ev of events || []) {
    if (!Number.isFinite(ev.startMs) || ev.startMs < nowMs - 6 * 3600e3 || ev.startMs > nowMs + 36 * 3600e3) continue;
    const idx = ev.sides.findIndex(s => teamMatch(league, s.team, team));
    if (idx < 0) continue;
    const other = ev.sides[1 - idx];
    if (opponent && !teamMatch(league, other.team, opponent)) continue;
    const d = Math.abs(ev.startMs - nowMs);
    if (!best || d < best.d) best = { d, slug: ev.slug, side: ev.sides[idx].long ? 'long' : 'short', startMs: ev.startMs, team: ev.sides[idx].team, opponent: other.team };
  }
  if (!best) return null;
  const { d, ...rest } = best; return rest;
}
async function kvJson(env, key) { try { return await env.SIGNALS_CACHE.get(key, { type: 'json' }); } catch (e) { return null; } }
async function kvPut(env, key, v, ttl) { try { await env.SIGNALS_CACHE.put(key, JSON.stringify(v), { expirationTtl: ttl }); } catch (e) {} }
export async function fetchLeagueEvents(env, league, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const key = `${PMUS_KEYS.EVENTS}_${league}`;
  const cached = await kvJson(env, key);
  if (cached && nowMs - (cached.at || 0) < EVENTS_TTL_S * 1000) return cached.events;
  const res = await fetchImpl(`${PMUS_GATEWAY}/v2/leagues/${encodeURIComponent(league)}/events?limit=100`);
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
// The whole route: league -> events -> team match -> market details. Never throws; returns {ok:false, reason}.
export async function resolveUsMarket(env, intent, deps = {}) {
  try {
    if (intent.usSlug && intent.usSide) { const market = await fetchUsMarket(env, intent.usSlug, deps); return { ok: true, slug: intent.usSlug, side: intent.usSide, ...market }; }
    const league = leagueOf(intent);
    if (!league) return { ok: false, reason: 'league not routable (not NFL/CFB/NBA/NHL/MLB)' };
    const team = teamOfIntent(intent);
    if (!team) return { ok: false, reason: 'cannot tell which team the intent is long' };
    const teams = teamsOfTitle(intent.marketTitle);
    const opponent = teams.length === 2 ? (teamMatch(league, teams[0], team) ? teams[1] : teams[0]) : null;
    const events = await fetchLeagueEvents(env, league, deps);
    const hit = matchUsEvent(league, events, team, opponent, deps.nowMs || Date.now());
    if (!hit) return { ok: false, reason: `no Polymarket US ${league.toUpperCase()} moneyline for ${team}${opponent ? ` vs ${opponent}` : ''} within the window` };
    const market = await fetchUsMarket(env, hit.slug, deps);
    if (market.status && market.status !== 'MARKET_STATUS_OPEN') return { ok: false, reason: `US market ${hit.slug} is ${market.status}` };
    return { ok: true, slug: hit.slug, side: hit.side, team: hit.team, opponent: hit.opponent, startMs: hit.startMs, ...market };
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
export function buildUsOrder({ slug, action, side, effectivePrice, tick, quantity, minQty }) {
  const yes = roundYesPrice(yesPriceFor(side, effectivePrice), tick, action, side);
  return { marketSlug: slug, intent: orderIntent(action, side), type: 'ORDER_TYPE_LIMIT', price: { value: yes.toFixed(decimalsOf(tick)), currency: 'USD' }, quantity: r4(roundQty(quantity, minQty)), tif: 'TIME_IN_FORCE_FILL_OR_KILL', manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC', synchronousExecution: true, maxBlockTime: '5' };
}
export const usFeePerContract = (effectivePrice, coef = PMUS_FEE) => coef * effectivePrice * (1 - effectivePrice);

// ---- trading calls ----
export const placeUsOrder = (env, order, deps) => pmusRequest(env, 'POST', '/v1/orders', { ...deps, body: order });
export const getUsOrder = (env, id, deps) => pmusRequest(env, 'GET', `/v1/order/${encodeURIComponent(id)}`, deps);
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

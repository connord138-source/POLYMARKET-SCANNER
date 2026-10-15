// Crypto fair value: price Polymarket's crypto threshold contracts ("Will
// Bitcoin be above $84,000 on October 16?", "dip to $77,500 in October?",
// "reach $90,000 in October?") from realized volatility, and compare to the
// market. Driftless lognormal: a European digital for "above/below on a
// date", the reflection-principle one-touch for "dip to"/"reach" (Polymarket
// resolves those on any 1-minute print, i.e. continuous monitoring).
//
// Candles come from Coinbase's public exchange API (US-accessible, no key):
// hourly for the 7-day and 30-day realized vols, daily for 90-day. Spot is the
// live ticker. Everything is cached in KV `crypto_fv` for FV_TTL_S and
// refreshed by the 5-minute cron; the frontend re-prices client-side when the
// user moves the volatility slider (same math in src/lib/cryptoFv.js there).
//
// Oct 15 2026 calibration (82 liquid BTC contracts): median |model - market|
// 1.4c; the only systematic gap is far-dated "dip to" tails trading 7-12c
// ABOVE the lognormal model - the crowd (correctly) prices fatter tails than
// a lognormal, so a big gap on a tail contract is a model warning, not an edge.

const COINBASE = 'https://api.exchange.coinbase.com';
const GAMMA = 'https://gamma-api.polymarket.com';

export const FV_KEYS = { CACHE: 'crypto_fv' };
export const FV_TTL_S = 600;               // KV TTL; cron refreshes every 5 min
export const FV_MAX_ROWS = 200;
export const ASSETS = {
  BTC: { product: 'BTC-USD', names: ['bitcoin', 'btc'] },
  ETH: { product: 'ETH-USD', names: ['ethereum', 'ether', 'eth'] },
  SOL: { product: 'SOL-USD', names: ['solana', 'sol'] },
};
const YEAR_MS = 365 * 86400e3;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// ---- math ----
// erf, Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7): plenty for cents.
export function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export const Phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

// Probability of the YES side for one contract. sigma annualized, T in years.
export function priceContract({ kind, K, spot, sigma, T }) {
  if (!(K > 0) || !(spot > 0) || !(sigma > 0)) return null;
  if (!(T > 0)) {
    if (kind === 'above') return spot > K ? 1 : 0;
    if (kind === 'below') return spot < K ? 1 : 0;
    return (kind === 'dip' ? spot <= K : spot >= K) ? 1 : 0;
  }
  const sq = sigma * Math.sqrt(T);
  const lnKS = Math.log(K / spot);
  if (kind === 'above') return Phi((-lnKS - 0.5 * sigma * sigma * T) / sq);
  if (kind === 'below') return 1 - Phi((-lnKS - 0.5 * sigma * sigma * T) / sq);
  if (kind === 'dip') return K >= spot ? 1 : Math.min(1, 2 * Phi(lnKS / sq));
  if (kind === 'reach') return K <= spot ? 1 : Math.min(1, 2 * (1 - Phi(lnKS / sq)));
  return null;
}

export function realizedVol(closes, barsPerYear) {
  const r = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0 && closes[i] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  if (r.length < 5) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) * (b - m), 0) / r.length;
  return Math.sqrt(v) * Math.sqrt(barsPerYear);
}

// ---- parsing ----
const num = (s) => Number(String(s).replace(/,/g, ''));

// "Will Bitcoin dip to $77,500 in October?" -> { asset, kind, K, resolvesAt }.
// Returns null for anything that is not a single-strike price contract.
export function parseCryptoQuestion(question, { endDate, nowMs = Date.now() } = {}) {
  const q = String(question || '');
  const ql = q.toLowerCase();
  if (/between|\band \$|market cap|dominance|etf|%|percent|flippen|all[- ]time high|ath\b|close(?:s|d)? (?:above|below) its/i.test(q)) return null;
  let asset = null;
  for (const [sym, a] of Object.entries(ASSETS)) if (a.names.some(n => new RegExp(`\\b${n}\\b`, 'i').test(q))) { asset = sym; break; }
  if (!asset) return null;
  const km = q.match(/\$\s*([\d,]+(?:\.\d+)?)\s*([kKmM])?\b/);
  if (!km) return null;
  let K = num(km[1]); if (/k/i.test(km[2] || '')) K *= 1e3; if (/m/i.test(km[2] || '')) K *= 1e6;
  if (!(K > 0)) return null;
  let kind = null;
  if (/\b(dip|fall|drop|decline|crash) (?:to|below)\b/.test(ql)) kind = 'dip';
  else if (/\b(reach|hit|touch|rise to|climb to|rally to|surpass|exceed)\b/.test(ql)) kind = 'reach';
  else if (/\babove\b/.test(ql)) kind = 'above';
  else if (/\bbelow\b|\bunder\b/.test(ql)) kind = 'below';
  if (!kind) return null;
  // Resolution time: "on October 16" contracts settle at 12:00 ET that day; windows use Gamma's endDate.
  let resolvesAt = endDate ? Date.parse(endDate) : NaN;
  const on = ql.match(/\bon (january|february|march|april|may|june|july|august|september|october|november|december) (\d{1,2})\b/);
  if (on && (kind === 'above' || kind === 'below')) {
    const yr = Number.isFinite(resolvesAt) ? new Date(resolvesAt).getUTCFullYear() : new Date(nowMs).getUTCFullYear();
    const t = Date.UTC(yr, MONTHS.indexOf(on[1]), Number(on[2]), 16, 0, 0);   // noon ET (EDT); EST would be 17:00
    if (t > nowMs - 86400e3) resolvesAt = t;
  }
  if (!Number.isFinite(resolvesAt)) return null;
  return { asset, kind, K, resolvesAt: new Date(resolvesAt).toISOString() };
}

// ---- data ----
async function coinbaseJson(path) {
  const res = await fetch(`${COINBASE}${path}`, { headers: { accept: 'application/json', 'user-agent': 'edgerunner-crypto-fv/1.0' } });
  if (!res.ok) throw new Error(`coinbase ${res.status} ${path.slice(0, 50)}`);
  return res.json();
}

// Coinbase returns at most 300 candles per call: [time, low, high, open, close, volume], newest first.
export async function fetchCandles(product, granularity, bars, nowMs = Date.now()) {
  const out = new Map();
  const span = 300 * granularity * 1000;
  let end = nowMs;
  while (out.size < bars && end > nowMs - (bars + 300) * granularity * 1000) {
    const start = end - span;
    const rows = await coinbaseJson(`/products/${product}/candles?granularity=${granularity}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) out.set(r[0], Number(r[4]));
    end = start;
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).slice(-bars).map(([, c]) => c);
}

export async function fetchAssetStats(sym, nowMs = Date.now()) {
  const a = ASSETS[sym];
  const [ticker, hourly, daily] = await Promise.all([
    coinbaseJson(`/products/${a.product}/ticker`),
    fetchCandles(a.product, 3600, 24 * 30, nowMs),
    fetchCandles(a.product, 86400, 90, nowMs),
  ]);
  const spot = Number(ticker.price) || hourly[hourly.length - 1];
  const vols = {
    h7: realizedVol(hourly.slice(-24 * 7), 24 * 365),
    h30: realizedVol(hourly, 24 * 365),
    d90: realizedVol(daily, 365),
  };
  const sigma = vols.h30 || vols.d90 || vols.h7;
  return { spot, sigma, vols, bars: { hourly: hourly.length, daily: daily.length }, change24h: hourly.length > 24 ? (spot / hourly[hourly.length - 25] - 1) : null };
}

async function gammaCryptoMarkets(pages = 3) {
  const out = [];
  for (let off = 0; off < pages * 100; off += 100) {
    const res = await fetch(`${GAMMA}/events?tag_slug=crypto&active=true&closed=false&limit=100&offset=${off}&order=volume24hr&ascending=false`);
    if (!res.ok) break;
    const events = await res.json();
    for (const e of events) for (const m of e.markets || []) {
      if (!m || !m.active || m.closed) continue;
      let prices = []; try { prices = JSON.parse(m.outcomePrices || '[]').map(Number); } catch (e2) {}
      let toks = []; try { toks = JSON.parse(m.clobTokenIds || '[]'); } catch (e2) {}
      out.push({ question: m.question, slug: m.slug, endDate: m.endDate, description: m.description, yes: prices[0], bestBid: m.bestBid != null ? Number(m.bestBid) : null, bestAsk: m.bestAsk != null ? Number(m.bestAsk) : null, volume24hr: Number(m.volume24hr || 0), liquidity: Number(m.liquidityNum || m.liquidity || 0), tokenId: toks[0] || null, conditionId: m.conditionId || null, event: e.slug });
    }
    if (events.length < 100) break;
  }
  return out;
}

// Pure: price a list of Gamma crypto markets against asset stats.
export function priceMarkets(markets, assets, nowMs = Date.now()) {
  const rows = [];
  for (const m of markets || []) {
    const p = parseCryptoQuestion(m.question, { endDate: m.endDate, nowMs });
    if (!p || !assets[p.asset] || !(m.yes >= 0)) continue;
    const a = assets[p.asset];
    const T = (Date.parse(p.resolvesAt) - nowMs) / YEAR_MS;
    if (!(T > 0)) continue;
    const model = priceContract({ kind: p.kind, K: p.K, spot: a.spot, sigma: a.sigma, T });
    if (model == null) continue;
    rows.push({
      slug: m.slug, question: m.question, asset: p.asset, kind: p.kind, K: p.K, resolvesAt: p.resolvesAt, days: Math.round(T * 365 * 10) / 10, T: Math.round(T * 1e6) / 1e6,
      market: Math.round(m.yes * 1000) / 1000, bestBid: m.bestBid, bestAsk: m.bestAsk, model: Math.round(model * 1000) / 1000, gap: Math.round((model - m.yes) * 1000) / 1000,
      volume24h: Math.round(m.volume24hr || 0), liquidity: Math.round(m.liquidity || 0), tokenId: m.tokenId, conditionId: m.conditionId, event: m.event,
    });
  }
  rows.sort((a, b) => b.volume24h - a.volume24h);
  return rows.slice(0, FV_MAX_ROWS);
}

export function summarize(rows) {
  const liquid = rows.filter(r => r.volume24h >= 5000);
  const med = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const byKind = {};
  for (const r of liquid) { const b = byKind[r.kind] || (byKind[r.kind] = { n: 0, sumGap: 0 }); b.n++; b.sumGap += r.gap; }
  for (const k of Object.keys(byKind)) { byKind[k].meanGap = Math.round(byKind[k].sumGap / byKind[k].n * 1000) / 1000; delete byKind[k].sumGap; }
  return { contracts: rows.length, liquid: liquid.length, medianAbsGapLiquid: med(liquid.map(r => Math.abs(r.gap))), over10c: liquid.filter(r => Math.abs(r.gap) > 0.10).length, byKind };
}

export async function refreshCryptoFairValue(env, nowMs = Date.now()) {
  const assets = {}; const errors = {};
  for (const sym of Object.keys(ASSETS)) {
    try { assets[sym] = await fetchAssetStats(sym, nowMs); } catch (e) { errors[sym] = e.message.slice(0, 80); }
  }
  let markets = [];
  try { markets = await gammaCryptoMarkets(3); } catch (e) { errors.gamma = e.message.slice(0, 80); }
  const rows = priceMarkets(markets, assets, nowMs);
  const blob = { at: new Date(nowMs).toISOString(), assets, rows, summary: summarize(rows), errors: Object.keys(errors).length ? errors : undefined, read: 'model = driftless lognormal at the asset\'s 30-day realized vol (sigma); gap = model - market for the YES side. Far-dated dip/reach tails trade above the model by design (fat tails): treat a big tail gap as a model warning, not an edge.' };
  try { await env.SIGNALS_CACHE.put(FV_KEYS.CACHE, JSON.stringify(blob), { expirationTtl: FV_TTL_S * 3 }); } catch (e) {}
  return blob;
}

export async function getCryptoFairValue(env, { maxAgeMs = FV_TTL_S * 1000, nowMs = Date.now() } = {}) {
  let blob = null;
  try { blob = await env.SIGNALS_CACHE.get(FV_KEYS.CACHE, { type: 'json' }); } catch (e) {}
  if (blob && blob.at && nowMs - Date.parse(blob.at) <= maxAgeMs) return blob;
  return refreshCryptoFairValue(env, nowMs);
}

// Pure: attach the model to crypto signals (by market slug). The whale's side
// decides the sign: modelSide is the model probability of the side bought,
// gapSide = modelSide - the price the whale paid (in probability), so a
// positive gapSide means the whale bought below the model.
export function annotateCryptoFairValue(signals, fv) {
  if (!fv || !Array.isArray(fv.rows) || !Array.isArray(signals)) return 0;
  const bySlug = new Map(fv.rows.map(r => [r.slug, r]));
  let n = 0;
  for (const s of signals) {
    const r = s && s.marketSlug ? bySlug.get(s.marketSlug) : null;
    if (!r) continue;
    const isNo = /^no$/i.test(String(s.directionRaw || s.direction || 'Yes'));
    const paid = typeof s.displayPrice === 'number' ? s.displayPrice / 100 : (typeof s.avgEntryPrice === 'number' ? s.avgEntryPrice / 100 : (isNo ? 1 - r.market : r.market));
    const modelSide = isNo ? 1 - r.model : r.model;
    s.cryptoFv = { asset: r.asset, kind: r.kind, K: r.K, days: r.days, sigma: fv.assets[r.asset] ? Math.round(fv.assets[r.asset].sigma * 1000) / 1000 : null, model: r.model, market: r.market, side: isNo ? 'No' : 'Yes', modelSide: Math.round(modelSide * 1000) / 1000, paid: Math.round(paid * 1000) / 1000, gapSide: Math.round((modelSide - paid) * 1000) / 1000, tail: (r.kind === 'dip' || r.kind === 'reach') && r.days > 20 };
    n++;
  }
  return n;
}

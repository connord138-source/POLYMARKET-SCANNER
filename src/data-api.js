// ============================================================
// DATA-API.JS — Polymarket Data API v2 behind the v1 shapes the worker reads
// ============================================================
//
// Nov 2 2026: Polymarket retired Data API v1 (every /trades, /activity,
// /positions and /closed-positions call answers 410 "Data API v1 has been
// retired"), which stopped the 5-minute cron at the whale scan and broke the
// followed-wallet poll, the whale-exit check, the execution shadow and the
// wallet pages. v2 (https://docs.polymarket.com/migrate/data-api-v1-to-v2)
// changes the envelope ({ data, pagination }), the paging (an opaque
// cursor, no offset), the key casing (snake_case) and the market filter
// (`condition` instead of `market`), and folds /closed-positions into
// /v2/positions?status=CLOSED.
//
// `dataApi(url)` is a drop-in for `fetch(url)` at every v1 call site: it
// takes the v1 URL the code already builds, sends the v2 request(s), follows
// cursors until the v1 `limit` is met, and hands back a Response-like
// { ok, status, json() } whose rows carry the v1 camelCase keys plus the
// v2 names, so nothing downstream had to change its reading. A URL already
// on /v2/ passes straight through. A body that is a bare array (a test's
// v1-shaped mock) is returned as it is.
export const DATA_API = 'https://data-api.polymarket.com';
export const V2_PAGE_MAX = 1000;
export const V2_DEFAULT_LIMIT = 100;
const MAX_PAGES = 12;
// v2 rate-limits harder than v1 did (Nov 3 2026, 15:15 UTC: the scan's
// 5000-trade read answered 429 and the whole 5-minute cron died with it). Two
// guards: a 429 / 5xx page is retried after a short wait (Retry-After when
// given, capped), and the GLOBAL trades feed (no user / condition / event
// filter) is kept for FEED_TTL_MS and served to every smaller or equal read
// in that window, so the scan, the sport price pass, the active-sports probe
// and the per-market lookups share one paged read instead of each paying
// five requests.
export const FEED_TTL_MS = 20000;
export const RETRY_MAX = 3;
const RETRY_BASE_MS = 1200;
const RETRY_CAP_MS = 4000;
const defaultSleep = (ms) => new Promise(res => setTimeout(res, ms));
let feedCache = null;   // { at, want, rows } for the global trades feed
export const _resetFeedCache = () => { feedCache = null; };
const isGlobalFeed = (req) => req.path === '/v2/trades' && !req.params.has('user') && !req.params.has('condition') && !req.params.has('event_id') && !req.params.has('side') && !req.params.has('start') && !req.params.has('end') && (req.params.get('taker_only') ?? 'true') === 'true';

// snake_case -> camelCase, one level (the rows are flat).
export const camel = (k) => String(k).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
// v2 names whose v1 counterparts the worker reads; the alias is added only when absent.
const ALIASES = {
  tokenId: ['asset'],
  currentSize: ['size'],
  currentPrice: ['curPrice'],
  currentValue: ['value'],
  entryCostUsdc: ['initialValue'],
  totalPnl: ['cashPnl'],
  totalSize: ['totalBought'],
  oppositeTokenId: ['oppositeAsset'],
};
export function v1Row(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[camel(k)] = v;
  for (const [k, names] of Object.entries(ALIASES)) if (k in out) for (const n of names) if (!(n in out)) out[n] = out[k];
  return out;
}

// Pure: the v1 request -> the v2 request(s) that answer it.
//   { passthrough: url }                       already v2, or a route this layer does not know
//   { path, params (URLSearchParams), want, statuses } otherwise
export function v2Request(urlOrPath) {
  const u = new URL(String(urlOrPath), DATA_API);
  const path = u.pathname.replace(/\/+$/, '');
  if (path.startsWith('/v2/')) return { passthrough: u.toString() };
  const q = u.searchParams;
  const params = new URLSearchParams();
  const limit = Number(q.get('limit'));
  const want = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : V2_DEFAULT_LIMIT;
  params.set('limit', String(Math.min(want, V2_PAGE_MAX)));
  for (const [k, v] of q.entries()) {
    if (['limit', 'offset', 'sizeThreshold', 'size_threshold', 'market', 'marketId', 'market_id', 'takerOnly', 'taker_only'].includes(k)) continue;
    params.set(k, v);
  }
  const cond = q.get('market') || q.get('marketId') || q.get('market_id');
  if (cond) params.set('condition', cond);
  const taker = q.get('takerOnly') ?? q.get('taker_only');
  if (taker != null) params.set('taker_only', String(taker) === 'true' ? 'true' : 'false');
  const sizeThreshold = q.get('sizeThreshold') ?? q.get('size_threshold');
  if (sizeThreshold != null && Number(sizeThreshold) > 0) { params.set('filter_type', 'TOKENS'); params.set('filter_amount', String(Number(sizeThreshold))); }
  if (path === '/trades') return { path: '/v2/trades', params, want, statuses: [null] };
  if (path === '/activity') return { path: '/v2/activity', params, want, statuses: [null] };
  // v1 /positions listed everything still held: open and resolved-but-unredeemed (won or lost)
  if (path === '/positions') { params.delete('status'); return { path: '/v2/positions', params, want, statuses: q.get('status') ? [q.get('status')] : ['OPEN', 'REDEEMABLE'] }; }
  if (path === '/closed-positions') { params.delete('status'); return { path: '/v2/positions', params, want, statuses: ['CLOSED'] }; }
  return { passthrough: u.toString() };
}

const respLike = (ok, status, rows, text) => ({ ok, status, json: async () => rows, text: async () => (text != null ? text : JSON.stringify(rows)) });

// Drop-in for fetch(v1Url). Follows cursors until `want` rows (or the pages
// run out), one status at a time for the position routes. The first non-OK
// page ends the read with that status (rows already read are kept only when
// the failure is on a later page).
// One page, retried on 429 / 5xx with a short wait (Retry-After honoured, capped).
async function fetchPage(f, url, { sleep, nowMs, retries = RETRY_MAX }) {
  let res = null, lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { res = await f(url); lastErr = null; } catch (e) { res = null; lastErr = e; }
    const retryable = res ? (res.status === 429 || res.status >= 500) : true;
    if (res && !retryable) return res;
    if (attempt === retries) break;
    let waitMs = RETRY_BASE_MS * Math.pow(2, attempt);
    const ra = res && res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('retry-after')) : NaN;
    if (Number.isFinite(ra) && ra > 0) waitMs = Math.max(waitMs, ra * 1000);
    await sleep(Math.min(waitMs, RETRY_CAP_MS));
  }
  if (res) return res;
  throw lastErr || new Error('data-api: unreachable');
}

export async function dataApi(urlOrPath, { fetchImpl, maxPages = MAX_PAGES, sleep = defaultSleep, nowMs = Date.now() } = {}) {
  const f = fetchImpl || fetch;
  const req = v2Request(urlOrPath);
  if (req.passthrough) return f(req.passthrough);
  const global = isGlobalFeed(req);
  if (global && feedCache && nowMs - feedCache.at < FEED_TTL_MS && req.want <= feedCache.want) return respLike(true, 200, feedCache.rows.slice(0, req.want));   // a read no bigger than the one cached
  const rows = [];
  let status = 200;
  for (const st of req.statuses) {
    let cursor = null;
    for (let page = 0; page < maxPages && rows.length < req.want; page++) {
      const p = new URLSearchParams(req.params);
      if (st) p.set('status', st);
      if (cursor) p.set('cursor', cursor);
      let res;
      try { res = await fetchPage(f, `${DATA_API}${req.path}?${p.toString()}`, { sleep, nowMs }); } catch (e) { if (rows.length) break; throw e; }
      if (!res.ok) { if (rows.length) break; let t = ''; try { t = await res.text(); } catch (e) {} return respLike(false, res.status, null, t); }
      let body = null; try { body = await res.json(); } catch (e) { body = null; }
      if (Array.isArray(body)) { rows.push(...body); cursor = null; }          // a v1-shaped body (legacy mock): as it is
      else {
        const data = body && Array.isArray(body.data) ? body.data : [];
        for (const r of data) rows.push(v1Row(r));
        cursor = body && body.pagination && body.pagination.has_more !== false ? body.pagination.next_cursor || null : null;
      }
      status = res.status;
      if (!cursor) break;
    }
  }
  if (global) feedCache = { at: nowMs, want: req.want, rows: rows.slice() };
  return respLike(true, status, rows.slice(0, req.want));
}

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
export async function dataApi(urlOrPath, { fetchImpl, maxPages = MAX_PAGES } = {}) {
  const f = fetchImpl || fetch;
  const req = v2Request(urlOrPath);
  if (req.passthrough) return f(req.passthrough);
  const rows = [];
  let status = 200;
  for (const st of req.statuses) {
    let cursor = null;
    for (let page = 0; page < maxPages && rows.length < req.want; page++) {
      const p = new URLSearchParams(req.params);
      if (st) p.set('status', st);
      if (cursor) p.set('cursor', cursor);
      let res;
      try { res = await f(`${DATA_API}${req.path}?${p.toString()}`); } catch (e) { if (rows.length) return respLike(true, 200, rows); throw e; }
      if (!res.ok) { if (rows.length) return respLike(true, 200, rows); let t = ''; try { t = await res.text(); } catch (e) {} return respLike(false, res.status, null, t); }
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
  return respLike(true, status, rows.slice(0, req.want));
}

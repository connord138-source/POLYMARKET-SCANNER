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
// Rate limits (docs.polymarket.com/quickstart/introduction/rate-limits, Nov 3
// 2026): /v2/trades 300 requests per 10s, /v2/activity and /v2/positions 200,
// enforced per IP by Cloudflare. Our cycle makes a few dozen trades requests
// at most, but a cron-triggered Worker reaches a Cloudflare-proxied host from
// a shared egress address, so the window is shared with every other Worker
// reading the same feed: the 15:15 UTC cycle on Nov 3 read 429 on the scan's
// first page and the 15:25 one again after three retries, while the same
// pages answered 200 from elsewhere. Guards:
//   - a 429 / 5xx page is retried after a wait (Retry-After honoured, capped);
//   - the GLOBAL trades feed (no user / condition / event filter) is kept for
//     FEED_TTL_MS and served to every read no bigger than the one cached (the
//     venue's own edge serves that feed from a 300s cache, so a few minutes
//     costs no freshness); a reader can insist on a younger copy (`maxAgeMs`);
//   - a path that just answered 429 after its retries is BLOCKED for
//     FEED_BLOCK_MS: every read of it in that window fails at once instead of
//     waiting through its own retries (the 15:30 cycle ran past eight minutes
//     when the settlement, line-movement and edge readers each retried the
//     feed the scan had just been refused);
//   - `dataApiStats()` carries the counters, the block and the last failure
//     (status, Retry-After, body excerpt) for the cron status.
export const FEED_TTL_MS = 240000;
export const FEED_BLOCK_MS = 60000;
export const RETRY_MAX = 3;
const RETRY_BASE_MS = 1200;
const RETRY_CAP_MS = 10000;
const defaultSleep = (ms) => new Promise(res => setTimeout(res, ms));
let feedCache = null;   // { at, want, rows } for the global trades feed
let blocks = {};        // path -> { at, until, status, retryAfter }
let stats = null;
const freshStats = () => ({ reads: 0, ok: 0, failed: 0, served: 0, blocked: 0, requests: 0, retries: 0, throttled: 0, lastError: null });
const st = () => stats || (stats = freshStats());
export const _resetFeedCache = () => { feedCache = null; blocks = {}; stats = null; };
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

const respLike = (ok, status, rows, text, extra) => ({ ok, status, json: async () => rows, text: async () => (text != null ? text : JSON.stringify(rows)), ...(extra || {}) });
const retryAfterOf = (res) => {
  const ra = res && res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('retry-after')) : NaN;
  return Number.isFinite(ra) && ra > 0 ? ra : null;
};

// One page, retried on 429 / 5xx with a short wait (Retry-After honoured, capped).
// Returns { res, attempts, retryAfter } (res null when every try threw).
async function fetchPage(f, url, { sleep, retries = RETRY_MAX }) {
  let res = null, lastErr = null, retryAfter = null, attempts = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts++; st().requests++;
    try { res = await f(url); lastErr = null; } catch (e) { res = null; lastErr = e; }
    const retryable = res ? (res.status === 429 || res.status >= 500) : true;
    if (res && res.status === 429) { st().throttled++; retryAfter = retryAfterOf(res) ?? retryAfter; }
    if (res && !retryable) return { res, attempts, retryAfter };
    if (attempt === retries) break;
    st().retries++;
    let waitMs = RETRY_BASE_MS * Math.pow(2, attempt);
    const ra = retryAfterOf(res);
    if (ra != null) waitMs = Math.max(waitMs, ra * 1000);
    await sleep(Math.min(waitMs, RETRY_CAP_MS));
  }
  if (res) return { res, attempts, retryAfter };
  throw lastErr || new Error('data-api: unreachable');
}

const excerpt = (t) => String(t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
function noteFailure(req, nowMs, status, retryAfter, text, attempts) {
  const s = st(); s.failed++;
  s.lastError = { at: new Date(nowMs).toISOString(), path: req.path, status, retryAfter, attempts, body: excerpt(text) };
  if (status === 429) blocks[req.path] = { at: nowMs, until: nowMs + Math.max(FEED_BLOCK_MS, (retryAfter || 0) * 1000), status, retryAfter };
}

// The counters, the active blocks and the last failure, for the cron status.
export function dataApiStats(nowMs = Date.now()) {
  const s = st();
  const active = Object.fromEntries(Object.entries(blocks).filter(([, b]) => b.until > nowMs).map(([p, b]) => [p, { since: new Date(b.at).toISOString(), forS: Math.round((b.until - nowMs) / 1000), retryAfter: b.retryAfter }]));
  return { ...s, blocked_paths: active, feed: feedCache ? { at: new Date(feedCache.at).toISOString(), ageS: Math.round((nowMs - feedCache.at) / 1000), rows: feedCache.rows.length, want: feedCache.want } : null };
}

// A readable tail for an error message: tries, Retry-After, the block, the body.
export async function describeFailure(res) {
  if (!res || res.ok) return '';
  const bits = [];
  if (res.blocked) bits.push(`not retried: ${res.path || 'path'} throttled ${res.blockedAgoS}s ago`);
  else if (res.attempts > 1) bits.push(`${res.attempts} tries`);
  if (res.retryAfter != null) bits.push(`retry-after ${res.retryAfter}s`);
  let t = ''; try { t = excerpt(await res.text()); } catch (e) {}
  if (t) bits.push(JSON.stringify(t));
  return bits.length ? ` (${bits.join('; ')})` : '';
}

// Drop-in for fetch(v1Url). Follows cursors until `want` rows (or the pages
// run out), one status at a time for the position routes. The first non-OK
// page ends the read with that status (rows already read are kept only when
// the failure is on a later page). `maxAgeMs` is how old a cached global feed
// may be for this reader (default FEED_TTL_MS).
export async function dataApi(urlOrPath, { fetchImpl, maxPages = MAX_PAGES, sleep = defaultSleep, nowMs = Date.now(), maxAgeMs = FEED_TTL_MS } = {}) {
  const f = fetchImpl || fetch;
  const req = v2Request(urlOrPath);
  if (req.passthrough) return f(req.passthrough);
  st().reads++;
  const global = isGlobalFeed(req);
  if (global && feedCache && nowMs - feedCache.at < Math.min(maxAgeMs, FEED_TTL_MS) && req.want <= feedCache.want) { st().served++; st().ok++; return respLike(true, 200, feedCache.rows.slice(0, req.want), null, { cached: true, cacheAgeS: Math.round((nowMs - feedCache.at) / 1000) }); }   // a read no bigger than the one cached
  const block = blocks[req.path];
  if (block && block.until > nowMs) {
    st().blocked++; st().failed++;
    const agoS = Math.round((nowMs - block.at) / 1000);
    return respLike(false, block.status, null, `throttled: ${req.path} answered ${block.status} ${agoS}s ago; not retried`, { blocked: true, blockedAgoS: agoS, retryAfter: block.retryAfter, path: req.path, attempts: 0 });
  }
  const rows = [];
  let status = 200;
  for (const stName of req.statuses) {
    let cursor = null;
    for (let page = 0; page < maxPages && rows.length < req.want; page++) {
      const p = new URLSearchParams(req.params);
      if (stName) p.set('status', stName);
      if (cursor) p.set('cursor', cursor);
      let got;
      try { got = await fetchPage(f, `${DATA_API}${req.path}?${p.toString()}`, { sleep }); }
      catch (e) { if (rows.length) break; noteFailure(req, nowMs, 0, null, e && e.message, RETRY_MAX + 1); throw e; }
      const { res, attempts, retryAfter } = got;
      if (!res.ok) {
        if (rows.length) break;
        let t = ''; try { t = await res.text(); } catch (e) {}
        noteFailure(req, nowMs, res.status, retryAfter, t, attempts);
        return respLike(false, res.status, null, t, { retryAfter, attempts, path: req.path });
      }
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
  st().ok++;
  if (global) feedCache = { at: nowMs, want: req.want, rows: rows.slice() };
  return respLike(true, status, rows.slice(0, req.want));
}

// ---------- the scan's rolling record (KV `scan_history`) ----------
// One entry per 5-minute cycle: { at, ok, signals, ms, error?, cached? }.
export const SCAN_HISTORY_MAX = 288;   // a day of 5-minute cycles
export function pushScanHistory(list, entry, max = SCAN_HISTORY_MAX) {
  const out = Array.isArray(list) ? list.filter(e => e && e.at) : [];
  out.push(entry);
  return out.length > max ? out.slice(out.length - max) : out;
}
// Pure: how the scan has been doing. `failedStreak` = failures at the tail.
export function scanHistorySummary(list, nowMs = Date.now()) {
  const l = Array.isArray(list) ? list.filter(e => e && e.at) : [];
  const ok = l.filter(e => e.ok);
  let failedStreak = 0; for (let i = l.length - 1; i >= 0 && !l[i].ok; i--) failedStreak++;
  const lastOk = ok.length ? ok[ok.length - 1] : null;
  const lastFail = [...l].reverse().find(e => !e.ok) || null;
  const ms = l.filter(e => Number.isFinite(e.ms)).map(e => e.ms);
  return {
    cycles: l.length, ok: ok.length, failed: l.length - ok.length,
    okRate: l.length ? Math.round(100 * ok.length / l.length) / 100 : null,
    failedStreak,
    lastOkAt: lastOk ? lastOk.at : null,
    lastOkAgoMin: lastOk ? Math.round((nowMs - Date.parse(lastOk.at)) / 60000) : null,
    lastError: lastFail ? { at: lastFail.at, error: lastFail.error || null } : null,
    avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
    last: l.slice(-12).map(e => ({ at: e.at, ok: !!e.ok, signals: e.signals, ms: e.ms, ...(e.error ? { error: e.error } : {}) })),
  };
}

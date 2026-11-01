// Kalshi API client with request signing. Unauthenticated calls from
// Cloudflare's shared egress are throttled (429) most of the time; an API key
// from the operator's own Kalshi account gets per-account limits and is
// permitted for the member's own use under Kalshi's developer terms.
//
// Signing (docs.kalshi.com, API keys): headers KALSHI-ACCESS-KEY (key id),
// KALSHI-ACCESS-TIMESTAMP (ms), KALSHI-ACCESS-SIGNATURE (base64) over the
// string  timestamp + METHOD + path-without-query  where the path includes the
// /trade-api/v2 prefix. Ed25519 keys (Kalshi's default, PKCS#8 "BEGIN PRIVATE
// KEY") sign the bytes directly; RSA keys (PKCS#1 "BEGIN RSA PRIVATE KEY" as
// Kalshi issues them, or PKCS#8) use RSA-PSS / SHA-256 / salt = digest length.
//
// Secrets: KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY (the PEM, newlines intact),
// pushed by .github/workflows/push-kalshi-key.yml.

export const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
export const KALSHI_PATH_PREFIX = '/trade-api/v2';
export const KALSHI_UA = 'edgerunner-xvenue/1.0 (+https://edgerunner.vip; research sampler)';

const RSA_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const ED25519_OID = [0x2b, 0x65, 0x70];

const b64ToBytes = (b64) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const bytesToB64 = (bytes) => { let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]); return btoa(bin); };

// PEM -> { label, der }. Accepts escaped "\n" (a secret pasted on one line).
export function pemToDer(pem) {
  const text = String(pem || '').replace(/\\n/g, '\n').trim();
  const m = text.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) throw new Error('KALSHI_PRIVATE_KEY is not a PEM block');
  return { label: m[1].trim(), der: b64ToBytes(m[2].replace(/\s+/g, '')) };
}

const derLen = (n) => { if (n < 0x80) return [n]; const b = []; let x = n; while (x > 0) { b.unshift(x & 0xff); x >>= 8; } return [0x80 | b.length, ...b]; };

// PKCS#1 RSAPrivateKey -> PKCS#8 PrivateKeyInfo (what WebCrypto imports).
export function wrapPkcs1ToPkcs8(pkcs1) {
  const algId = [0x30, 0x0d, 0x06, 0x09, ...RSA_OID, 0x05, 0x00];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLen(pkcs1.length), ...pkcs1];
  const body = [...version, ...algId, ...octet];
  return new Uint8Array([0x30, ...derLen(body.length), ...body]);
}

const hasSeq = (der, oid) => { const lim = Math.min(der.length, 64) - oid.length; outer: for (let i = 0; i <= lim; i++) { for (let j = 0; j < oid.length; j++) if (der[i + j] !== oid[j]) continue outer; return true; } return false; };

// Normalise any supported PEM to { type: 'rsa'|'ed25519', pkcs8: Uint8Array }.
export function normalizeKey(pem) {
  const { label, der } = pemToDer(pem);
  if (label === 'RSA PRIVATE KEY') return { type: 'rsa', pkcs8: wrapPkcs1ToPkcs8(der) };
  if (label === 'PRIVATE KEY') {
    if (hasSeq(der, ED25519_OID)) return { type: 'ed25519', pkcs8: der };
    if (hasSeq(der, RSA_OID)) return { type: 'rsa', pkcs8: der };
    throw new Error('KALSHI_PRIVATE_KEY: unsupported key algorithm (need Ed25519 or RSA)');
  }
  throw new Error(`KALSHI_PRIVATE_KEY: unsupported PEM label "${label}"`);
}

// timestamp + METHOD + path without query, path prefixed with /trade-api/v2.
export function signingMessage(timestampMs, method, path) {
  const p = String(path || '').split('?')[0];
  const full = p.startsWith(KALSHI_PATH_PREFIX) ? p : KALSHI_PATH_PREFIX + (p.startsWith('/') ? p : '/' + p);
  return String(timestampMs) + String(method || 'GET').toUpperCase() + full;
}

const keyCache = new Map();   // pem -> Promise<{type, key}>
export async function importKalshiKey(pem) {
  if (!keyCache.has(pem)) {
    keyCache.set(pem, (async () => {
      const { type, pkcs8 } = normalizeKey(pem);
      const key = type === 'ed25519'
        ? await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'])
        : await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
      return { type, key };
    })().catch(e => { keyCache.delete(pem); throw e; }));
  }
  return keyCache.get(pem);
}

export async function signKalshi({ type, key }, message) {
  const data = new TextEncoder().encode(message);
  const sig = type === 'ed25519'
    ? await crypto.subtle.sign({ name: 'Ed25519' }, key, data)
    : await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, key, data);
  return bytesToB64(new Uint8Array(sig));
}

export const kalshiAuthConfigured = (env) => !!(env && env.KALSHI_API_KEY_ID && env.KALSHI_PRIVATE_KEY);

// Headers for one request: identification always, signature when a key is configured.
export async function kalshiHeaders(env, method, path, nowMs = Date.now()) {
  const headers = { accept: 'application/json', 'user-agent': KALSHI_UA };
  if (!kalshiAuthConfigured(env)) return { headers, authed: false };
  const ts = String(Math.floor(nowMs));
  const k = await importKalshiKey(env.KALSHI_PRIVATE_KEY);
  headers['KALSHI-ACCESS-KEY'] = String(env.KALSHI_API_KEY_ID).trim();
  headers['KALSHI-ACCESS-TIMESTAMP'] = ts;
  headers['KALSHI-ACCESS-SIGNATURE'] = await signKalshi(k, signingMessage(ts, method, path));
  return { headers, authed: true, keyType: k.type };
}

// GET/POST/DELETE against /trade-api/v2 with signing. Returns the Response.
export async function kalshiFetch(env, path, { method = 'GET', body, fetchImpl } = {}) {
  const { headers } = await kalshiHeaders(env, method, path);
  if (body !== undefined) headers['content-type'] = 'application/json';
  return (fetchImpl || fetch)(`${KALSHI_API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

// ---------- trading (Nov 1 2026, the Kalshi NHL scalp lane) ----------
// Kalshi's V2 event-market orders (POST /portfolio/events/orders): one YES
// book per market, `bid` = buy YES, `ask` = sell YES (= buy NO at 1 - price;
// positions net, so an `ask` from flat leaves a NO position). Prices and
// counts are fixed-point strings. Only reached when KALSHI_API_KEY_ID /
// KALSHI_PRIVATE_KEY are on the worker (push-kalshi-key.yml).
export class KalshiError extends Error {
  constructor(status, message, body) { super(message); this.name = 'KalshiError'; this.status = status; this.body = body; }
}
const fp = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
export const kalshiPriceStr = (p) => (Math.round(Math.min(0.99, Math.max(0.01, Number(p))) * 100) / 100).toFixed(2);   // whole cents, inside 1-99c
async function kalshiJsonCall(env, path, { method = 'GET', body, fetchImpl } = {}) {
  const res = await kalshiFetch(env, path, { method, body, fetchImpl });
  let data = null; try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) throw new KalshiError(res.status, `kalshi ${res.status}${data && (data.message || data.error) ? `: ${String(data.message || data.error).slice(0, 120)}` : ''}`, data);
  return data || {};
}
// Place one order; IOC by default (a scalp wants the quote or nothing). Returns
// { orderId, fillCount, remainingCount, avgPx (YES terms), avgFee (per contract) }.
export async function kalshiPlaceOrder(env, { ticker, side, count, price, timeInForce = 'immediate_or_cancel', reduceOnly = false, clientOrderId, postOnly = false }, { fetchImpl } = {}) {
  if (!ticker || !['bid', 'ask'].includes(side) || !(count > 0)) throw new KalshiError(400, 'kalshi order: ticker, side bid|ask and a positive count are required');
  const body = { ticker, side, count: String(Math.round(count * 100) / 100), price: kalshiPriceStr(price), time_in_force: timeInForce, self_trade_prevention_type: 'taker_at_cross', client_order_id: clientOrderId || `er-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  if (reduceOnly) body.reduce_only = true;
  if (postOnly) body.post_only = true;
  const r = await kalshiJsonCall(env, '/portfolio/events/orders', { method: 'POST', body, fetchImpl });
  return { orderId: r.order_id || null, clientOrderId: r.client_order_id || body.client_order_id, fillCount: fp(r.fill_count) ?? 0, remainingCount: fp(r.remaining_count) ?? 0, avgPx: fp(r.average_fill_price), avgFee: fp(r.average_fee_paid), tsMs: r.ts_ms || null, sent: body };
}
// Cancel a resting order (auto-routed by its market ticker). Returns the contracts canceled.
export async function kalshiCancelOrder(env, orderId, ticker, { fetchImpl } = {}) {
  const r = await kalshiJsonCall(env, `/portfolio/events/orders/${encodeURIComponent(orderId)}?market_ticker=${encodeURIComponent(ticker || '')}`, { method: 'DELETE', fetchImpl });
  return { orderId: r.order_id || orderId, reducedBy: fp(r.reduced_by) ?? 0 };
}
// Net contracts held in one market: positive = YES, negative = NO, 0 = flat.
export async function kalshiPositionQty(env, ticker, { fetchImpl } = {}) {
  const r = await kalshiJsonCall(env, `/portfolio/positions?ticker=${encodeURIComponent(ticker)}&count_filter=position&limit=20`, { fetchImpl });
  const row = (r.market_positions || []).find(m => m.ticker === ticker);
  return row ? (fp(row.position_fp) ?? 0) : 0;
}
export async function getKalshiOrder(env, orderId, { fetchImpl } = {}) {
  const r = await kalshiJsonCall(env, `/portfolio/orders/${encodeURIComponent(orderId)}`, { fetchImpl });
  return r.order || r;
}

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

// GET/POST against /trade-api/v2 with signing. Returns the Response.
export async function kalshiFetch(env, path, { method = 'GET', body } = {}) {
  const { headers } = await kalshiHeaders(env, method, path);
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${KALSHI_API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

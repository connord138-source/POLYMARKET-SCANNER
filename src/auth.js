// Supabase Auth on the worker: verify the access token the frontend sends as
// `Authorization: Bearer <jwt>` and hand back the user. Supports the two ways
// Supabase signs tokens: HS256 with the project's JWT secret
// (SUPABASE_JWT_SECRET) and ES256/RS256 with the project's JWKS
// (${SUPABASE_URL}/auth/v1/.well-known/jwks.json, cached in KV for an hour).
// No Supabase SDK: WebCrypto only.

export const AUTH_KEYS = { JWKS: 'supabase_jwks' };
const JWKS_TTL_S = 3600;

const b64uToBytes = (s) => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')); const out = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i); return out; };
const b64uToJson = (s) => JSON.parse(new TextDecoder().decode(b64uToBytes(s)));

export function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try { return { header: b64uToJson(parts[0]), payload: b64uToJson(parts[1]), signingInput: `${parts[0]}.${parts[1]}`, signature: b64uToBytes(parts[2]) }; }
  catch (e) { return null; }
}

export const authConfigured = (env) => !!(env && (env.SUPABASE_JWT_SECRET || env.SUPABASE_URL));

async function fetchJwks(env) {
  let cached = null;
  try { cached = await env.SIGNALS_CACHE.get(AUTH_KEYS.JWKS, { type: 'json' }); } catch (e) {}
  if (cached && Array.isArray(cached.keys)) return cached.keys;
  const res = await fetch(`${String(env.SUPABASE_URL).replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const jwks = await res.json();
  try { await env.SIGNALS_CACHE.put(AUTH_KEYS.JWKS, JSON.stringify(jwks), { expirationTtl: JWKS_TTL_S }); } catch (e) {}
  return jwks.keys || [];
}

async function verifySignature(decoded, env) {
  const { header, signingInput, signature } = decoded;
  const data = new TextEncoder().encode(signingInput);
  if (header.alg === 'HS256') {
    if (!env.SUPABASE_JWT_SECRET) throw new Error('HS256 token but SUPABASE_JWT_SECRET is not set');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SUPABASE_JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('HMAC', key, signature, data);
  }
  if (header.alg === 'ES256' || header.alg === 'RS256') {
    if (!env.SUPABASE_URL) throw new Error(`${header.alg} token but SUPABASE_URL is not set`);
    const keys = await fetchJwks(env);
    const jwk = keys.find(k => k.kid === header.kid) || keys.find(k => k.alg === header.alg);
    if (!jwk) throw new Error('no matching JWKS key');
    if (header.alg === 'ES256') {
      const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, data);
    }
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  }
  throw new Error(`unsupported alg ${header.alg}`);
}

// -> { ok, user: { id, email, role }, error }
export async function verifySupabaseJwt(token, env, nowMs = Date.now()) {
  const decoded = decodeJwt(token);
  if (!decoded) return { ok: false, error: 'malformed token' };
  const p = decoded.payload || {};
  if (typeof p.exp !== 'number' || p.exp * 1000 < nowMs - 30e3) return { ok: false, error: 'token expired' };
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!aud.includes('authenticated')) return { ok: false, error: 'wrong audience' };
  if (env.SUPABASE_URL && p.iss && !String(p.iss).startsWith(String(env.SUPABASE_URL).replace(/\/$/, ''))) return { ok: false, error: 'wrong issuer' };
  if (!p.sub) return { ok: false, error: 'no subject' };
  try {
    const good = await verifySignature(decoded, env);
    if (!good) return { ok: false, error: 'bad signature' };
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, user: { id: p.sub, email: p.email || null, role: p.role || 'authenticated' } };
}

// The signed-in user for a request, or null. The admin token is handled
// separately (isAdminRequest in index.js) and never reaches here as a user.
export async function getUser(request, env, nowMs = Date.now()) {
  if (!authConfigured(env)) return null;
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return null;
  const token = h.slice(7).trim();
  if (!token || (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN)) return null;
  const r = await verifySupabaseJwt(token, env, nowMs);
  return r.ok ? r.user : null;
}

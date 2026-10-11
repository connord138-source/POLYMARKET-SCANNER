// ============================================================
// WAITLIST.JS — EDGERUNNER Pro "will people pay?" test
// ============================================================
//
// The Pro page collects emails + what the visitor would use most. Storage is
// a single KV JSON array (`pro_waitlist`) — a few thousand entries at most,
// read by the admin summary, so one blob is simpler than D1 for this test.
//
//   POST /waitlist  (public)  → addToWaitlist + per-IP throttle (index.js)
//   GET  /waitlist  (admin)   → waitlistSummary(list)
//
// Defences, cheapest first: a honeypot field (`website`) that humans never
// see — bots that fill it get a success response and nothing is stored;
// a sane email regex + length cap; and a 60s per-IP throttle keyed on the
// SHA-256 of the client IP (no raw IPs in KV).
// ============================================================

export const WAITLIST_KEY = 'pro_waitlist';
export const WAITLIST_CAP = 5000;
export const WANT_KEYS = ['alerts', 'dkboard', 'intel', 'api'];
export const IP_THROTTLE_SECONDS = 60;

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const EMAIL_MAX = 120;

// Returns the normalized (trimmed, lowercased) email, or null when it is not
// something we would ever want to send mail to.
export function validateEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

export function normalizeWants(wants) {
  if (!Array.isArray(wants)) return [];
  const out = [];
  for (const w of wants) {
    if (typeof w !== 'string') continue;
    const k = w.trim().toLowerCase();
    if (WANT_KEYS.includes(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

function normalizeSource(source) {
  if (typeof source !== 'string') return 'unknown';
  const s = source.trim().slice(0, 64);
  return s || 'unknown';
}

export async function loadWaitlist(env) {
  const list = await env.SIGNALS_CACHE.get(WAITLIST_KEY, { type: 'json' });
  return Array.isArray(list) ? list : [];
}

// entry: { email, wants, source, website, country }
// Resolves to { success, position, count } or { success:false, error, status }.
export async function addToWaitlist(env, entry) {
  const e = entry || {};

  // Honeypot: a filled `website` field means a bot. Look successful, store nothing.
  if (typeof e.website === 'string' ? e.website.trim() !== '' : e.website != null) {
    return { success: true, position: null, count: null };
  }

  const email = validateEmail(e.email);
  if (!email) return { success: false, error: 'Enter a valid email address', status: 400 };

  const wants = normalizeWants(e.wants);
  const source = normalizeSource(e.source);
  const at = new Date().toISOString();
  const country = typeof e.country === 'string' && e.country ? e.country.slice(0, 8) : null;

  const list = await loadWaitlist(env);
  let idx = list.findIndex(x => x && x.email === email);
  if (idx >= 0) {
    // Repeat sign-up: keep their place, refresh what they want + when.
    list[idx] = { ...list[idx], wants, at, source: list[idx].source || source, country: list[idx].country || country };
  } else {
    if (list.length >= WAITLIST_CAP) {
      return { success: false, error: 'The waitlist is full', status: 409 };
    }
    list.push({ email, wants, source, at, country });
    idx = list.length - 1;
  }

  await env.SIGNALS_CACHE.put(WAITLIST_KEY, JSON.stringify(list));
  return { success: true, position: idx + 1, count: list.length };
}

// Admin view: counts per interest, last-7-day sign-ups, entries newest first.
export function waitlistSummary(list) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  const byWant = Object.fromEntries(WANT_KEYS.map(k => [k, 0]));
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let last7d = 0;
  arr.forEach((x) => {
    for (const w of (Array.isArray(x.wants) ? x.wants : [])) {
      if (w in byWant) byWant[w]++;
    }
    const t = Date.parse(x.at);
    if (Number.isFinite(t) && t >= weekAgo) last7d++;
  });
  const entries = arr.map((x, i) => ({ position: i + 1, ...x })).reverse();
  return { count: arr.length, byWant, last7d, entries };
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

export async function ipThrottleKey(ip) {
  return 'wl_ip:' + await sha256Hex(ip || 'unknown');
}

// True when this IP submitted within the last IP_THROTTLE_SECONDS.
export async function isIpThrottled(env, ip) {
  const key = await ipThrottleKey(ip);
  return (await env.SIGNALS_CACHE.get(key)) != null;
}

// Mark this IP as having just submitted; the key expires on its own.
export async function markIpSubmitted(env, ip) {
  const key = await ipThrottleKey(ip);
  await env.SIGNALS_CACHE.put(key, '1', { expirationTtl: IP_THROTTLE_SECONDS });
}

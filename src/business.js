// The operator's business view: subscribers and MRR from KV entitlements,
// sign-ups from Supabase (service role, optional), affiliate clicks, waitlist.
import { planOf, PLANS, FOUNDING_SEATS } from './tiers.js';
import { foundingSeatsUsed } from './billing.js';
import { waitlistSummary, loadWaitlist } from './waitlist.js';

export const CLICK_KEY = (day) => `clicks:${day}`;
export const VENUES = {
  polymarket: ['polymarket.com', 'www.polymarket.com'],
  'polymarket-us': ['polymarket.us', 'www.polymarket.us'],
  kalshi: ['kalshi.com', 'www.kalshi.com'],
  draftkings: ['sportsbook.draftkings.com', 'draftkings.com', 'www.draftkings.com'],
};

// Validate an outbound link for /go/:venue. -> URL string or null.
export function allowedOutbound(venue, u) {
  const hosts = VENUES[venue]; if (!hosts || !u) return null;
  try { const url = new URL(u); if (url.protocol !== 'https:' || !hosts.includes(url.hostname)) return null; return url.toString(); } catch (e) { return null; }
}

export async function recordClick(env, venue, userId, nowMs = Date.now()) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const key = CLICK_KEY(day);
  let cur = {}; try { cur = (await env.SIGNALS_CACHE.get(key, { type: 'json' })) || {}; } catch (e) {}
  cur[venue] = (cur[venue] || 0) + 1;
  if (userId) { cur._users = cur._users || {}; cur._users[userId] = (cur._users[userId] || 0) + 1; }
  try { await env.SIGNALS_CACHE.put(key, JSON.stringify(cur), { expirationTtl: 90 * 86400 }); } catch (e) {}
  return cur[venue];
}

export async function listEntitlements(env) {
  const out = []; let cursor;
  for (let i = 0; i < 20; i++) {
    const page = await env.SIGNALS_CACHE.list({ prefix: 'ent:', cursor, limit: 1000 });
    for (const k of page.keys || []) { try { const v = await env.SIGNALS_CACHE.get(k.name, { type: 'json' }); if (v) out.push(v); } catch (e) {} }
    if (page.list_complete || !page.cursor) break; cursor = page.cursor;
  }
  return out;
}

export async function supabaseUserStats(env, nowMs = Date.now()) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { configured: false };
  try {
    const res = await fetch(`${String(env.SUPABASE_URL).replace(/\/$/, '')}/auth/v1/admin/users?page=1&per_page=1000`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
    if (!res.ok) return { configured: true, error: `supabase ${res.status}` };
    const data = await res.json();
    const users = data.users || [];
    const d7 = nowMs - 7 * 86400e3, d1 = nowMs - 86400e3;
    return { configured: true, total: typeof data.total === 'number' ? data.total : users.length, last7d: users.filter(u => Date.parse(u.created_at) > d7).length, last24h: users.filter(u => Date.parse(u.created_at) > d1).length, confirmed: users.filter(u => u.email_confirmed_at).length };
  } catch (e) { return { configured: true, error: e.message.slice(0, 80) }; }
}

export async function businessReport(env, nowMs = Date.now()) {
  const ents = await listEntitlements(env);
  const byPlan = { free: 0, pro: 0, desk: 0 }; let mrr = 0, founding = 0, pastDue = 0, cancelAtEnd = 0, comped = 0;
  for (const e of ents) {
    const p = planOf(e, nowMs); byPlan[p] = (byPlan[p] || 0) + 1;
    if (p !== 'free') { mrr += typeof e.amountMonthly === 'number' ? e.amountMonthly : (PLANS[p].priceMonthly || 0); if (e.founding) founding++; if (e.status === 'past_due') pastDue++; if (e.cancelAtPeriodEnd) cancelAtEnd++; if (e.status === 'comped') comped++; }
  }
  const clicks = {}; const days = [];
  for (let i = 0; i < 7; i++) { const day = new Date(nowMs - i * 86400e3).toISOString().slice(0, 10); days.push(day); try { const c = await env.SIGNALS_CACHE.get(CLICK_KEY(day), { type: 'json' }); for (const [k, v] of Object.entries(c || {})) if (k !== '_users') clicks[k] = (clicks[k] || 0) + v; } catch (e) {} }
  let waitlist = null; try { waitlist = waitlistSummary(await loadWaitlist(env)); waitlist = { count: waitlist.count, last7d: waitlist.last7d, byWant: waitlist.byWant }; } catch (e) {}
  const seats = await foundingSeatsUsed(env);
  return {
    success: true, at: new Date(nowMs).toISOString(),
    subscribers: { ...byPlan, paying: byPlan.pro + byPlan.desk - comped, comped, pastDue, cancelAtPeriodEnd: cancelAtEnd, founding, foundingSeatsLeft: Math.max(0, FOUNDING_SEATS - seats) },
    mrr: Math.round(mrr * 100) / 100, arr: Math.round(mrr * 12),
    users: await supabaseUserStats(env, nowMs),
    affiliateClicks7d: clicks, waitlist,
    recentSubscribers: ents.filter(e => planOf(e, nowMs) !== 'free').sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 20).map(e => ({ userId: e.userId, plan: e.plan, status: e.status, interval: e.interval, amountMonthly: e.amountMonthly, founding: !!e.founding, since: e.updatedAt })),
  };
}

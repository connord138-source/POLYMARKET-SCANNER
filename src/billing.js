// Stripe billing without the SDK: Checkout for sign-up, the customer portal
// for changes, a signed webhook for the truth. Entitlements live in KV
// `ent:<userId>` and decide what the worker serves (src/tiers.js).
//
// Secrets (push-billing-keys.yml): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
// STRIPE_PRICE_PRO_MONTHLY, STRIPE_PRICE_PRO_ANNUAL, STRIPE_PRICE_DESK_MONTHLY,
// STRIPE_PRICE_DESK_ANNUAL (price ids), optional STRIPE_PRICE_PRO_FOUNDING.

import { PLANS, planOf } from './tiers.js';

const STRIPE_API = 'https://api.stripe.com/v1';
export const BILLING_KEYS = { ent: (uid) => `ent:${uid}`, cust: (cid) => `stripe_cust:${cid}`, evt: (id) => `stripe_evt:${id}` };

export const billingConfigured = (env) => !!(env && env.STRIPE_SECRET_KEY);

// Which price id serves (plan, interval); founding Pro monthly when the seat
// counter is below FOUNDING_SEATS and a founding price exists.
export function priceIdFor(env, plan, interval, founding = false) {
  const P = String(plan).toUpperCase(), I = interval === 'annual' ? 'ANNUAL' : 'MONTHLY';
  if (plan === 'pro' && interval !== 'annual' && founding && env.STRIPE_PRICE_PRO_FOUNDING) return env.STRIPE_PRICE_PRO_FOUNDING;
  return env[`STRIPE_PRICE_${P}_${I}`] || null;
}
export function planForPriceId(env, priceId) {
  if (!priceId) return null;
  for (const plan of ['pro', 'desk']) for (const key of [`STRIPE_PRICE_${plan.toUpperCase()}_MONTHLY`, `STRIPE_PRICE_${plan.toUpperCase()}_ANNUAL`, ...(plan === 'pro' ? ['STRIPE_PRICE_PRO_FOUNDING'] : [])]) if (env[key] && env[key] === priceId) return plan;
  return null;
}

// Stripe wants application/x-www-form-urlencoded with bracket nesting.
export function encodeForm(obj, prefix = '') {
  const parts = [];
  const walk = (v, k) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${k}[${i}]`));
    else if (typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, k ? `${k}[${kk}]` : kk);
    else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  };
  walk(obj, prefix);
  return parts.join('&');
}

export async function stripeRequest(env, path, params = null, method = 'POST') {
  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': '2024-06-20' };
  let url = `${STRIPE_API}${path}`, body;
  if (params && method === 'GET') url += `?${encodeForm(params)}`;
  else if (params) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = encodeForm(params); }
  const res = await fetch(url, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`stripe ${res.status}: ${(data.error && data.error.message) || 'request failed'}`);
  return data;
}

export async function getEntitlement(env, userId) {
  try { return await env.SIGNALS_CACHE.get(BILLING_KEYS.ent(userId), { type: 'json' }); } catch (e) { return null; }
}
export async function setEntitlement(env, userId, ent) {
  const rec = { ...ent, userId, updatedAt: new Date().toISOString() };
  await env.SIGNALS_CACHE.put(BILLING_KEYS.ent(userId), JSON.stringify(rec));
  if (rec.stripeCustomerId) await env.SIGNALS_CACHE.put(BILLING_KEYS.cust(rec.stripeCustomerId), userId);
  return rec;
}

// Count of Pro subscriptions ever started (founding seats), kept in KV.
export async function foundingSeatsUsed(env) {
  try { return Number(await env.SIGNALS_CACHE.get('founding_seats')) || 0; } catch (e) { return 0; }
}

export async function createCheckoutSession(env, { user, plan, interval, successUrl, cancelUrl, founding = false }) {
  if (!PLANS[plan] || plan === 'free') throw new Error('unknown plan');
  const priceId = priceIdFor(env, plan, interval, founding);
  if (!priceId) throw new Error(`no Stripe price configured for ${plan} ${interval}`);
  const ent = await getEntitlement(env, user.id);
  const params = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: user.id,
    metadata: { userId: user.id, plan, interval },
    subscription_data: { metadata: { userId: user.id, plan, interval } },
    allow_promotion_codes: true,
    success_url: successUrl, cancel_url: cancelUrl,
  };
  if (ent && ent.stripeCustomerId) params.customer = ent.stripeCustomerId; else if (user.email) params.customer_email = user.email;
  const session = await stripeRequest(env, '/checkout/sessions', params);
  return { url: session.url, id: session.id };
}

export async function createPortalSession(env, { user, returnUrl }) {
  const ent = await getEntitlement(env, user.id);
  if (!ent || !ent.stripeCustomerId) throw new Error('no billing account yet');
  const s = await stripeRequest(env, '/billing_portal/sessions', { customer: ent.stripeCustomerId, return_url: returnUrl });
  return { url: s.url };
}

// ---- webhook ----
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const timingEqual = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export async function verifyStripeSignature(payload, header, secret, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(',').map(kv => kv.split('=').map(s => s.trim())).filter(x => x.length === 2).map(([k, v]) => [k, v]));
  const t = Number(parts.t); const sigs = String(header).split(',').map(s => s.trim()).filter(s => s.startsWith('v1=')).map(s => s.slice(3));
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowSec - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
  return sigs.some(s => timingEqual(s, expected));
}

// Pure: entitlement record from a Stripe subscription object.
export function entitlementFromSubscription(env, sub, prev = null) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const price = item && item.price;
  const priceId = price && price.id;
  const plan = planForPriceId(env, priceId) || (sub.metadata && PLANS[sub.metadata.plan] ? sub.metadata.plan : null) || (prev && prev.plan) || 'pro';
  const interval = price && price.recurring ? price.recurring.interval : (sub.metadata && sub.metadata.interval) || null;
  const amount = price && typeof price.unit_amount === 'number' ? price.unit_amount / 100 : null;
  const amountMonthly = amount == null ? null : interval === 'year' ? Math.round(amount / 12 * 100) / 100 : amount;
  const status = sub.status === 'canceled' || sub.status === 'unpaid' || sub.status === 'incomplete_expired' ? 'canceled' : sub.status;
  return {
    plan: status === 'canceled' ? 'free' : plan, status,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : (item && item.current_period_end ? new Date(item.current_period_end * 1000).toISOString() : null),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || (prev && prev.stripeCustomerId) || null,
    stripeSubscriptionId: sub.id, priceId: priceId || null, interval, amountMonthly,
    founding: priceId && env.STRIPE_PRICE_PRO_FOUNDING === priceId ? true : (prev && prev.founding) || false,
  };
}

async function userIdForCustomer(env, customerId) {
  try { return await env.SIGNALS_CACHE.get(BILLING_KEYS.cust(customerId)); } catch (e) { return null; }
}

// Apply one Stripe event. Idempotent on event id. -> { handled, type, userId, plan }
export async function handleStripeEvent(env, event) {
  const out = { handled: false, type: event.type, userId: null, plan: null };
  try { if (await env.SIGNALS_CACHE.get(BILLING_KEYS.evt(event.id))) return { ...out, duplicate: true }; } catch (e) {}
  const obj = event.data && event.data.object;
  if (!obj) return out;
  if (event.type === 'checkout.session.completed') {
    const userId = obj.client_reference_id || (obj.metadata && obj.metadata.userId);
    const customer = typeof obj.customer === 'string' ? obj.customer : obj.customer && obj.customer.id;
    if (!userId) return out;
    if (customer) await env.SIGNALS_CACHE.put(BILLING_KEYS.cust(customer), userId);
    let ent = { plan: (obj.metadata && obj.metadata.plan) || 'pro', status: 'active', stripeCustomerId: customer || null, stripeSubscriptionId: typeof obj.subscription === 'string' ? obj.subscription : null };
    if (ent.stripeSubscriptionId && billingConfigured(env)) {
      try { const sub = await stripeRequest(env, `/subscriptions/${ent.stripeSubscriptionId}`, null, 'GET'); ent = entitlementFromSubscription(env, sub, ent); } catch (e) {}
    }
    const prev = await getEntitlement(env, userId);
    if (ent.plan === 'pro' && !(prev && prev.plan === 'pro')) { try { await env.SIGNALS_CACHE.put('founding_seats', String((await foundingSeatsUsed(env)) + 1)); } catch (e) {} }
    await setEntitlement(env, userId, { ...(prev || {}), ...ent });
    Object.assign(out, { handled: true, userId, plan: ent.plan });
  } else if (event.type.startsWith('customer.subscription.')) {
    const customer = typeof obj.customer === 'string' ? obj.customer : obj.customer && obj.customer.id;
    const userId = (obj.metadata && obj.metadata.userId) || (customer && await userIdForCustomer(env, customer));
    if (!userId) return out;
    const prev = await getEntitlement(env, userId);
    const ent = event.type === 'customer.subscription.deleted' ? { ...entitlementFromSubscription(env, obj, prev), plan: 'free', status: 'canceled' } : entitlementFromSubscription(env, obj, prev);
    await setEntitlement(env, userId, { ...(prev || {}), ...ent });
    Object.assign(out, { handled: true, userId, plan: ent.plan });
  } else if (event.type === 'invoice.payment_failed') {
    const customer = typeof obj.customer === 'string' ? obj.customer : obj.customer && obj.customer.id;
    const userId = customer && await userIdForCustomer(env, customer);
    if (!userId) return out;
    const prev = await getEntitlement(env, userId);
    if (prev) { await setEntitlement(env, userId, { ...prev, status: 'past_due' }); Object.assign(out, { handled: true, userId, plan: prev.plan }); }
  }
  try { await env.SIGNALS_CACHE.put(BILLING_KEYS.evt(event.id), '1', { expirationTtl: 7 * 86400 }); } catch (e) {}
  return out;
}

// Operator comp: grant a plan for N days without Stripe.
export async function grantPlan(env, userId, plan, days = 30) {
  if (!PLANS[plan]) throw new Error('unknown plan');
  const prev = await getEntitlement(env, userId);
  return setEntitlement(env, userId, { ...(prev || {}), plan, status: plan === 'free' ? 'canceled' : 'comped', currentPeriodEnd: new Date(Date.now() + days * 86400e3).toISOString(), stripeSubscriptionId: null, priceId: null, amountMonthly: 0 });
}

// /me payload
export async function meFor(env, user, nowMs = Date.now()) {
  const ent = await getEntitlement(env, user.id);
  const plan = planOf(ent, nowMs);
  return { user: { id: user.id, email: user.email }, plan, entitlement: ent ? { status: ent.status, currentPeriodEnd: ent.currentPeriodEnd, cancelAtPeriodEnd: !!ent.cancelAtPeriodEnd, interval: ent.interval, founding: !!ent.founding, hasBilling: !!ent.stripeCustomerId } : null, features: PLANS[plan].features, billingEnabled: billingConfigured(env) };
}

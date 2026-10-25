// Auth (Supabase JWT), tiers and Stripe billing. Run with: node test/access.test.mjs
import { createHmac, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { decodeJwt, verifySupabaseJwt, getUser, authConfigured } from "../src/auth.js";
import { PLANS, planOf, hasPlan, limitsFor, policyFor, degradeFor } from "../src/tiers.js";
import { encodeForm, priceIdFor, planForPriceId, verifyStripeSignature, entitlementFromSubscription, handleStripeEvent, createCheckoutSession, createPortalSession, grantPlan, meFor, getEntitlement } from "../src/billing.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (header, payload, signer) => { const si = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`; return `${si}.${b64u(signer(si))}`; };
const now = Date.parse("2026-10-16T12:00:00Z");
const kv = new Map();
const KV = { get: async (k, o) => { const v = kv.get(k); if (v === undefined) return null; return o && o.type === "json" ? JSON.parse(v) : v; }, put: async (k, v) => { kv.set(k, v); }, list: async ({ prefix }) => ({ keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }) };

// ---- tiers ----
check("planOf: free by default, active pro, canceled -> free, past period + grace -> free, comped ok", planOf(null) === "free" && planOf({ plan: "pro", status: "active", currentPeriodEnd: "2026-11-01T00:00:00Z" }, now) === "pro" && planOf({ plan: "pro", status: "canceled" }, now) === "free" && planOf({ plan: "desk", status: "past_due", currentPeriodEnd: "2026-10-01T00:00:00Z" }, now) === "free" && planOf({ plan: "desk", status: "past_due", currentPeriodEnd: "2026-10-15T00:00:00Z" }, now) === "desk" && planOf({ plan: "pro", status: "comped", currentPeriodEnd: "2027-01-01T00:00:00Z" }, now) === "pro");
check("hasPlan ranks, limits", hasPlan("desk", "pro") && hasPlan("pro", "pro") && !hasPlan("free", "pro") && limitsFor("free").signalsMax === 5 && limitsFor("pro").signalsDelayMin === 0 && limitsFor("desk").api === true && PLANS.pro.foundingMonthly === 19);
check("policy: scan degrades for free, crew orders need pro, api needs desk, health is open", policyFor("/scan").degrade === "scan" && policyFor("/agents/crew/orders", "POST").tier === "pro" && policyFor("/agents/crew", "GET").degrade === "crew" && policyFor("/api/signals").tier === "desk" && policyFor("/health") === null && policyFor("/odds/compare-all").tier === "pro");

// ---- auth: HS256 ----
{
  const secret = "super-secret-jwt";
  const env = { SUPABASE_JWT_SECRET: secret, SUPABASE_URL: "https://abc.supabase.co", SIGNALS_CACHE: KV };
  const hs = (si) => createHmac("sha256", secret).update(si).digest();
  const good = jwt({ alg: "HS256", typ: "JWT" }, { sub: "u1", email: "a@b.c", aud: "authenticated", role: "authenticated", iss: "https://abc.supabase.co/auth/v1", exp: Math.floor(now / 1000) + 3600 }, hs);
  const r = await verifySupabaseJwt(good, env, now);
  check("hs256: valid token -> user", r.ok && r.user.id === "u1" && r.user.email === "a@b.c", JSON.stringify(r));
  const tampered = good.slice(0, -4) + "AAAA";
  check("hs256: bad signature rejected", (await verifySupabaseJwt(tampered, env, now)).ok === false);
  const expired = jwt({ alg: "HS256" }, { sub: "u1", aud: "authenticated", iss: "https://abc.supabase.co/auth/v1", exp: Math.floor(now / 1000) - 120 }, hs);
  check("hs256: expired / wrong aud / wrong iss rejected", (await verifySupabaseJwt(expired, env, now)).error === "token expired" && (await verifySupabaseJwt(jwt({ alg: "HS256" }, { sub: "u1", aud: "anon", exp: Math.floor(now / 1000) + 60 }, hs), env, now)).error === "wrong audience" && (await verifySupabaseJwt(jwt({ alg: "HS256" }, { sub: "u1", aud: "authenticated", iss: "https://evil.example/auth/v1", exp: Math.floor(now / 1000) + 60 }, hs), env, now)).error === "wrong issuer");
  check("decode: malformed -> null", decodeJwt("abc") === null && decodeJwt("a.b.c") === null);
  const req = (h) => ({ headers: { get: (k) => (k === "Authorization" ? h : null) } });
  check("getUser: bearer -> user; admin token is not a user; no auth config -> null", (await getUser(req(`Bearer ${good}`), env, now)).id === "u1" && (await getUser(req("Bearer adm"), { ...env, ADMIN_TOKEN: "adm" }, now)) === null && (await getUser(req(`Bearer ${good}`), {}, now)) === null && authConfigured(env) && !authConfigured({}));
}
// ---- auth: ES256 via JWKS ----
{
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "ES256", use: "sig" };
  let jwksCalls = 0;
  globalThis.fetch = async (url) => { jwksCalls++; return { ok: true, json: async () => ({ keys: [jwk] }) }; };
  const env = { SUPABASE_URL: "https://xyz.supabase.co", SIGNALS_CACHE: KV };
  const es = (si) => nodeSign("sha256", Buffer.from(si), { key: privateKey, dsaEncoding: "ieee-p1363" });
  const tok = jwt({ alg: "ES256", typ: "JWT", kid: "k1" }, { sub: "u2", email: "e@s.c", aud: ["authenticated"], iss: "https://xyz.supabase.co/auth/v1", exp: Math.floor(now / 1000) + 600 }, es);
  const r1 = await verifySupabaseJwt(tok, env, now);
  const r2 = await verifySupabaseJwt(tok, env, now);
  check("es256: JWKS fetched once (KV cache), raw r||s signature verifies", r1.ok && r1.user.id === "u2" && r2.ok && jwksCalls === 1, JSON.stringify({ r1, jwksCalls }));
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const bad = jwt({ alg: "ES256", kid: "k1" }, { sub: "u2", aud: "authenticated", iss: "https://xyz.supabase.co/auth/v1", exp: Math.floor(now / 1000) + 600 }, (si) => nodeSign("sha256", Buffer.from(si), { key: other.privateKey, dsaEncoding: "ieee-p1363" }));
  check("es256: token from another key rejected", (await verifySupabaseJwt(bad, env, now)).error === "bad signature");
}
// ---- billing ----
{
  const env = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_PRO_FOUNDING: "p_found", STRIPE_PRICE_PRO_MONTHLY: "p_pro_m", STRIPE_PRICE_PRO_ANNUAL: "p_pro_y", STRIPE_PRICE_DESK_MONTHLY: "p_desk_m", STRIPE_PRICE_DESK_ANNUAL: "p_desk_y", SIGNALS_CACHE: KV };
  check("encodeForm: nested brackets and arrays", encodeForm({ mode: "subscription", line_items: [{ price: "p", quantity: 1 }], metadata: { userId: "u 1" } }) === "mode=subscription&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&metadata%5BuserId%5D=u%201");
  check("priceIdFor / planForPriceId", priceIdFor(env, "pro", "monthly", true) === "p_found" && priceIdFor(env, "pro", "monthly", false) === "p_pro_m" && priceIdFor(env, "desk", "annual") === "p_desk_y" && priceIdFor(env, "pro", "annual", true) === "p_pro_y" && planForPriceId(env, "p_desk_m") === "desk" && planForPriceId(env, "nope") === null);
  const payload = JSON.stringify({ id: "evt_1", type: "x" });
  const t = Math.floor(now / 1000);
  const v1 = createHmac("sha256", "whsec_x").update(`${t}.${payload}`).digest("hex");
  check("webhook signature: valid, wrong secret, stale timestamp", (await verifyStripeSignature(payload, `t=${t},v1=${v1}`, "whsec_x", t + 10)) === true && (await verifyStripeSignature(payload, `t=${t},v1=${v1}`, "other", t)) === false && (await verifyStripeSignature(payload, `t=${t},v1=${v1}`, "whsec_x", t + 1000)) === false);
  const sub = { id: "sub_1", status: "active", customer: "cus_1", current_period_end: Math.floor(now / 1000) + 30 * 86400, cancel_at_period_end: false, metadata: { userId: "u1", plan: "pro" }, items: { data: [{ price: { id: "p_found", unit_amount: 1900, recurring: { interval: "month" } } }] } };
  const ent = entitlementFromSubscription(env, sub);
  check("entitlement from subscription: plan by price, founding flag, monthly amount, period end", ent.plan === "pro" && ent.founding === true && ent.amountMonthly === 19 && ent.status === "active" && ent.currentPeriodEnd.startsWith("2026-11-15") && ent.stripeCustomerId === "cus_1");
  const annual = entitlementFromSubscription(env, { ...sub, items: { data: [{ price: { id: "p_desk_y", unit_amount: 39900, recurring: { interval: "year" } } }] } });
  check("entitlement: annual desk -> 33.25/month", annual.plan === "desk" && annual.amountMonthly === 33.25 && annual.founding === false);
  // checkout.session.completed fetches the subscription
  let lastBody = "";
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/subscriptions/sub_1")) return { ok: true, json: async () => sub };
    if (u.endsWith("/checkout/sessions")) { lastBody = decodeURIComponent(String(opts.body)); return { ok: true, json: async () => ({ id: "cs_1", url: "https://checkout.stripe.com/cs_1" }) }; }
    if (u.endsWith("/billing_portal/sessions")) { lastBody = decodeURIComponent(String(opts.body)); return { ok: true, json: async () => ({ url: "https://billing.stripe.com/p_1" }) }; }
    return { ok: false, status: 404, json: async () => ({ error: { message: "nope" } }) };
  };
  const r1 = await handleStripeEvent(env, { id: "evt_a", type: "checkout.session.completed", data: { object: { client_reference_id: "u1", customer: "cus_1", subscription: "sub_1", metadata: { app: "edgerunner", plan: "pro" } } } });
  const e1 = await getEntitlement(env, "u1");
  check("checkout completed -> pro entitlement from the subscription, customer mapped, founding seat counted", r1.handled && r1.plan === "pro" && e1.plan === "pro" && e1.founding === true && kv.get("stripe_cust:cus_1") === "u1" && kv.get("founding_seats") === "1", JSON.stringify({ r1, e1 }));
  const dup = await handleStripeEvent(env, { id: "evt_a", type: "checkout.session.completed", data: { object: { client_reference_id: "u1" } } });
  check("duplicate event ignored", dup.duplicate === true && kv.get("founding_seats") === "1");
  // Shared Stripe account: the other product's checkouts carry a client_reference_id but no app tag,
  // its subscriptions carry no metadata at all, and its customers are not in our map.
  const f1 = await handleStripeEvent(env, { id: "evt_f1", type: "checkout.session.completed", data: { object: { mode: "subscription", client_reference_id: "spec_user_1", customer: "cus_spec", subscription: "sub_spec", metadata: {} } } });
  const f2 = await handleStripeEvent(env, { id: "evt_f2", type: "checkout.session.completed", data: { object: { mode: "payment", client_reference_id: "spec_user_2", customer: "cus_spec2", payment_intent: "pi_1", metadata: { type: "pervin", vin: "1HGCM82633A004352" } } } });
  const f3 = await handleStripeEvent(env, { id: "evt_f3", type: "customer.subscription.updated", data: { object: { ...sub, id: "sub_spec", customer: "cus_spec", metadata: { userId: "spec_user_1" }, items: { data: [{ price: { id: "price_other_product", unit_amount: 1999, recurring: { interval: "month" } } }] } } } });
  const f4 = await handleStripeEvent(env, { id: "evt_f4", type: "invoice.payment_failed", data: { object: { customer: "cus_spec" } } });
  check("foreign checkout / one-time payment / subscription / invoice ignored: no entitlement, no customer map, founding seats untouched", f1.ignored === "foreign" && !f1.handled && f2.ignored === "foreign" && f3.ignored === "foreign" && f4.ignored === "foreign" && (await getEntitlement(env, "spec_user_1")) === null && (await getEntitlement(env, "spec_user_2")) === null && kv.get("stripe_cust:cus_spec") === undefined && kv.get("founding_seats") === "1", JSON.stringify({ f1, f2, f3, f4 }));
  const own = await handleStripeEvent(env, { id: "evt_own", type: "customer.subscription.updated", data: { object: { ...sub, id: "sub_own", customer: "cus_own", metadata: { app: "edgerunner", userId: "u3", plan: "desk" }, items: { data: [{ price: { id: "p_desk_m", unit_amount: 4900, recurring: { interval: "month" } } }] } } } });
  check("own tagged subscription handled for a not-yet-mapped customer", own.handled && own.userId === "u3" && (await getEntitlement(env, "u3")).plan === "desk" && kv.get("stripe_cust:cus_own") === "u3", JSON.stringify(own));
  const r2 = await handleStripeEvent(env, { id: "evt_b", type: "customer.subscription.updated", data: { object: { ...sub, metadata: {}, items: { data: [{ price: { id: "p_desk_m", unit_amount: 4900, recurring: { interval: "month" } } }] } } } });
  check("subscription updated (user via customer map) -> desk", r2.handled && r2.userId === "u1" && (await getEntitlement(env, "u1")).plan === "desk");
  await handleStripeEvent(env, { id: "evt_c", type: "invoice.payment_failed", data: { object: { customer: "cus_1" } } });
  check("payment failed -> past_due keeps plan inside grace", (await getEntitlement(env, "u1")).status === "past_due" && planOf(await getEntitlement(env, "u1"), now) === "desk");
  await handleStripeEvent(env, { id: "evt_d", type: "customer.subscription.deleted", data: { object: { ...sub, status: "canceled" } } });
  check("subscription deleted -> free", (await getEntitlement(env, "u1")).plan === "free" && planOf(await getEntitlement(env, "u1"), now) === "free");
  const co = await createCheckoutSession(env, { user: { id: "u9", email: "x@y.z" }, plan: "pro", interval: "monthly", founding: true, successUrl: "https://edgerunner.vip/Account?ok=1", cancelUrl: "https://edgerunner.vip/Pro" });
  check("checkout session: founding price, client_reference_id, email, app tag on session + subscription", co.url === "https://checkout.stripe.com/cs_1" && lastBody.includes("line_items[0][price]=p_found") && lastBody.includes("client_reference_id=u9") && lastBody.includes("customer_email=x@y.z") && lastBody.includes("metadata[app]=edgerunner") && lastBody.includes("subscription_data[metadata][app]=edgerunner"), lastBody);
  let threw = false; try { await createCheckoutSession(env, { user: { id: "u9" }, plan: "free", interval: "monthly", successUrl: "a", cancelUrl: "b" }); } catch (e) { threw = /unknown plan/.test(e.message); }
  check("checkout session: free plan rejected", threw);
  const portal = await createPortalSession(env, { user: { id: "u1" }, returnUrl: "https://edgerunner.vip/Account" });
  check("portal session for a customer (no configuration var -> account default)", portal.url.startsWith("https://billing.stripe.com/") && !lastBody.includes("configuration="), lastBody);
  await createPortalSession({ ...env, STRIPE_PORTAL_CONFIG: "bpc_er" }, { user: { id: "u1" }, returnUrl: "https://edgerunner.vip/Account" });
  check("portal session uses EdgeRunner's own configuration when set", lastBody.includes("configuration=bpc_er") && lastBody.includes("customer=cus_1"), lastBody);
  threw = false; try { await createPortalSession(env, { user: { id: "nobody" }, returnUrl: "x" }); } catch (e) { threw = /no billing account/.test(e.message); }
  check("portal without a customer -> error", threw);
  const g = await grantPlan(env, "u7", "pro", 14);
  const me = await meFor(env, { id: "u7", email: "c@d.e" }, now);
  check("grant + /me", g.status === "comped" && me.plan === "pro" && me.features.alerts === true && me.entitlement.hasBilling === false && me.billingEnabled === true);
}
{
  const t0 = Date.parse("2026-10-16T12:00:00Z");
  const sig = (m, s) => ({ marketSlug: m, score: s, detectedAt: new Date(t0 - m * 60e3).toISOString(), topTrades: [{ wallet: "0xabcdef1234", amount: 1 }] });
  const scan = { success: true, signals: [sig(5, 99), sig(45, 50), sig(60, 90), sig(90, 10), sig(120, 20), sig(200, 30), sig(300, 40), sig(400, 60)] };
  const d = degradeFor("scan", scan, "free", t0);
  check("degrade scan (free): 30-min delay, top 5 by score, wallets masked, counts hidden", d.access.degraded && d.signals.length === 5 && d.signals.every(s => Date.parse(s.detectedAt) <= t0 - 30 * 60e3) && d.signals[0].score === 90 && d.signals[0].topTrades[0].wallet === "0xabcd…" && d.access.hidden === 3, JSON.stringify(d.access));
  check("degrade scan (pro): untouched", degradeFor("scan", scan, "pro", t0) === scan);
  const fv = degradeFor("cryptoFv", { rows: Array.from({ length: 40 }, (_, i) => ({ i })) }, "free");
  check("degrade crypto lab (free): 12 rows", fv.rows.length === 12 && fv.access.hidden === 28);
  const crew = degradeFor("crew", { hunt: { a: 1 }, chat: [1, 2], queue: [1], open: [1], recent: [1], ledger: { x: 1 } }, "free");
  check("degrade crew (free): sweep stays, chat/queue/picks locked", crew.hunt.a === 1 && crew.ledger.x === 1 && crew.chat.length === 0 && crew.queue.length === 0 && crew.access.locked.includes("orders"));
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

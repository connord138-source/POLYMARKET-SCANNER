// Plans and what each unlocks. The worker is the source of truth: the
// frontend reads /me and mirrors these for the paywall, but every gated
// endpoint checks here. Prices are display values; Stripe prices are the
// billing truth (STRIPE_PRICE_* vars).

export const PLANS = {
  free: {
    name: 'Free', priceMonthly: 0, priceAnnual: 0,
    features: { signalsDelayMin: 30, signalsMax: 5, alerts: false, dkBoardLive: false, crewRead: true, crewOrdersPerDay: 0, intel: 'preview', api: false, cryptoLabRows: 12, tradeRouting: false },
  },
  pro: {
    name: 'Pro', priceMonthly: 29, foundingMonthly: 19, priceAnnual: 149,
    features: { signalsDelayMin: 0, signalsMax: null, alerts: true, dkBoardLive: true, crewRead: true, crewOrdersPerDay: 0, intel: 'full', api: false, cryptoLabRows: null, tradeRouting: true },
  },
  desk: {
    name: 'Desk', priceMonthly: 49, priceAnnual: 399,
    features: { signalsDelayMin: 0, signalsMax: null, alerts: true, dkBoardLive: true, crewRead: true, crewOrdersPerDay: 0, intel: 'full', api: true, cryptoLabRows: null, tradeRouting: true },
  },
};
export const PLAN_RANK = { free: 0, pro: 1, desk: 2 };
export const FOUNDING_SEATS = 100;          // first N Pro subscribers keep the founding price
export const GRACE_DAYS = 3;                // past_due keeps access this long after the period ends

const ACTIVE = new Set(['active', 'trialing', 'past_due', 'comped']);

// Effective plan for an entitlement record (see billing.js) at `nowMs`.
export function planOf(ent, nowMs = Date.now()) {
  if (!ent || !PLANS[ent.plan] || ent.plan === 'free') return 'free';
  if (!ACTIVE.has(ent.status)) return 'free';
  const end = ent.currentPeriodEnd ? Date.parse(ent.currentPeriodEnd) : null;
  if (end && nowMs > end + GRACE_DAYS * 86400e3) return 'free';
  return ent.plan;
}

export const hasPlan = (plan, required) => (PLAN_RANK[plan] ?? 0) >= (PLAN_RANK[required] ?? 0);
export const limitsFor = (plan) => (PLANS[plan] || PLANS.free).features;

// Route access policy. First match wins; anything unlisted stays as it was
// (public). `degrade` means the route still answers for lower plans but
// trims the payload (see index.js). Admin-token requests bypass all of this.
export const ROUTE_POLICY = [
  { test: (p) => p === '/scan' || p === '/api/scan', tier: 'free', degrade: 'scan' },
  { test: (p) => p === '/crypto/fairvalue', tier: 'free', degrade: 'cryptoFv' },
  { test: (p) => p === '/agents/crew', tier: 'free', degrade: 'crew' },
  // Crew orders and chat are the owner's alone: requiresAdmin() in index.js
  // answers 401 to any POST under /agents/crew without the admin token, before
  // this table is consulted. Members read the crew (`crewRead`), nothing more.
  { test: (p, m) => p.startsWith('/agents/crew/') && m === 'POST', tier: 'pro' },
  { test: (p) => p.startsWith('/agents/'), tier: 'pro' },
  { test: (p) => p.startsWith('/alerts') || p.startsWith('/fade') || p.startsWith('/whale'), tier: 'pro' },
  { test: (p) => p.startsWith('/odds') || p.startsWith('/edge') || p.startsWith('/sweep') || p.startsWith('/lines'), tier: 'pro' },
  { test: (p) => p.startsWith('/learning') || p.startsWith('/db/') || p.startsWith('/intel') || p.startsWith('/investigat'), tier: 'pro' },
  { test: (p) => p.startsWith('/wallet') || p.startsWith('/wallets') || p.startsWith('/signals') || p.startsWith('/history') || p.startsWith('/analytics'), tier: 'pro' },
  { test: (p) => p.startsWith('/autotrader') || p.startsWith('/paper') || p.startsWith('/forge') || p.startsWith('/speed') || p.startsWith('/xvenue'), tier: 'pro' },
  { test: (p) => p.startsWith('/api/'), tier: 'desk' },
];

export function policyFor(path, method = 'GET') {
  for (const r of ROUTE_POLICY) if (r.test(path, method)) return r;
  return null;
}

// Trim a payload for a plan below the route's full tier. Pure.
export function degradeFor(kind, data, plan, nowMs = Date.now()) {
  if (!data || hasPlan(plan, 'pro')) return data;
  const lim = limitsFor(plan);
  if (kind === "scan" && Array.isArray(data.signals)) {
    const cutoff = nowMs - (lim.signalsDelayMin || 0) * 60e3;
    const delayed = data.signals.filter(s => Date.parse(s.detectedAt || s.lastTradeTime || 0) <= cutoff).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, lim.signalsMax || 5)
      .map(s => ({ ...s, topTrades: (s.topTrades || []).map(t => ({ ...t, wallet: t.wallet ? t.wallet.slice(0, 6) + "…" : "" })) }));
    return { ...data, signals: delayed, access: { plan, degraded: true, delayMin: lim.signalsDelayMin, max: lim.signalsMax, hidden: Math.max(0, data.signals.length - delayed.length) } };
  }
  if (kind === "cryptoFv" && Array.isArray(data.rows)) {
    return { ...data, rows: data.rows.slice(0, lim.cryptoLabRows || 12), access: { plan, degraded: true, max: lim.cryptoLabRows, hidden: Math.max(0, data.rows.length - (lim.cryptoLabRows || 12)) } };
  }
  if (kind === "crew") {
    const { chat, queue, open, recent, ...rest } = data;
    return { ...rest, chat: [], queue: [], open: [], recent: [], access: { plan, degraded: true, locked: ["chat", "orders", "queue", "picks"] } };
  }
  return data;
}


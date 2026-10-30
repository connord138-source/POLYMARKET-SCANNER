// ============================================================
// COPY.JS — copy a whale wallet: the 'whale_copy' paper lane
// ============================================================
//
// The operator feeds the agent a wallet (POST /agents/copy/wallets). Each
// 5-minute cron reads the wallet's newest trades from the data-api and
// queues every fresh BUY of $copyMinWhaleUsd or more as a pick: the market,
// the outcome it bought, what it paid and how much. enterCopyPicks in
// autotrader.js fills the pick at the live Gamma price in the lane's own
// ledger (strategySource 'whale_copy', own open cap and daily cap, fixed
// paper size), holds it to resolution, and leaves with the wallet when the
// wallet sells, redeems or merges (mirrorWhaleExit, exit engine). Paper
// only, like Forge and Crew: the live flip is the operator's decision.
//
// A wallet's own record (the ledger's skill row, Polymarket's profit book)
// rides along in the report so the page can say whether it is still worth
// copying.

export const COPY_KEYS = {
  WALLETS: 'copy_wallets',   // [{ address, nickname, addedAt, enabled, lastSeenTs, lastTradeAt, seen, queued }]
  PICKS: 'copy_picks',       // queued picks awaiting entry
  ENTERED: 'copy_entered',   // pick ids entered or skipped for good
  LOG: 'copy_log',           // recent events for the page
};
export const COPY_MAX_WALLETS = 12;
const POLY_DATA_API = 'https://data-api.polymarket.com';

const norm = (a) => String(a || '').trim().toLowerCase();
export const isWalletAddress = (a) => /^0x[0-9a-f]{40}$/.test(norm(a));

async function kvJson(env, key, fallback) {
  try { const v = await env.SIGNALS_CACHE.get(key, { type: 'json' }); return v == null ? fallback : v; } catch { return fallback; }
}
async function kvPut(env, key, value, ttlSec) {
  await env.SIGNALS_CACHE.put(key, JSON.stringify(value), ttlSec ? { expirationTtl: ttlSec } : undefined);
}

export async function listCopyWallets(env) { return kvJson(env, COPY_KEYS.WALLETS, []); }

export async function appendCopyLog(env, entry, nowMs = Date.now()) {
  const log = await kvJson(env, COPY_KEYS.LOG, []);
  log.push({ at: new Date(nowMs).toISOString(), ...entry });
  await kvPut(env, COPY_KEYS.LOG, log.slice(-120));
}

// The wallet starts being copied from NOW: its history is not replayed.
export async function addCopyWallet(env, { address, nickname = '' } = {}, nowMs = Date.now()) {
  const a = norm(address);
  if (!isWalletAddress(a)) return { ok: false, error: 'Not a wallet address (0x followed by 40 hex characters)' };
  const list = await listCopyWallets(env);
  if (list.some(w => w.address === a)) return { ok: false, error: 'Already copying this wallet' };
  if (list.length >= COPY_MAX_WALLETS) return { ok: false, error: `At most ${COPY_MAX_WALLETS} wallets at a time` };
  const w = { address: a, nickname: String(nickname || '').trim().slice(0, 40), addedAt: new Date(nowMs).toISOString(), enabled: true, lastSeenTs: nowMs, lastTradeAt: null, seen: 0, queued: 0 };
  list.push(w);
  await kvPut(env, COPY_KEYS.WALLETS, list);
  await appendCopyLog(env, { type: 'added', wallet: a, nickname: w.nickname }, nowMs);
  return { ok: true, wallet: w };
}

export async function removeCopyWallet(env, address, nowMs = Date.now()) {
  const a = norm(address);
  const list = await listCopyWallets(env);
  const w = list.find(x => x.address === a);
  if (!w) return { ok: false, error: 'Not copying this wallet' };
  await kvPut(env, COPY_KEYS.WALLETS, list.filter(x => x.address !== a));
  const picks = await kvJson(env, COPY_KEYS.PICKS, []);
  await kvPut(env, COPY_KEYS.PICKS, picks.filter(p => p.wallet !== a));
  await appendCopyLog(env, { type: 'removed', wallet: a, nickname: w.nickname }, nowMs);
  return { ok: true };
}

export async function setCopyWalletEnabled(env, address, enabled, nowMs = Date.now()) {
  const a = norm(address);
  const list = await listCopyWallets(env);
  const w = list.find(x => x.address === a);
  if (!w) return { ok: false, error: 'Not copying this wallet' };
  w.enabled = !!enabled;
  if (w.enabled) w.lastSeenTs = nowMs;   // resuming: do not replay what it did while paused
  await kvPut(env, COPY_KEYS.WALLETS, list);
  await appendCopyLog(env, { type: w.enabled ? 'resumed' : 'paused', wallet: a, nickname: w.nickname }, nowMs);
  return { ok: true, wallet: w };
}

// Pure: the picks in a wallet's activity feed newer than `sinceTs`. BUYs are
// grouped by market + outcome (a whale fills in several clips), kept at
// $minUsd or more and no older than maxAgeMin, with the wallet's
// share-weighted average price and the newest clip's time.
export function picksFromActivity(wallet, acts, sinceTs = 0, { minUsd = 500, nowMs = Date.now(), maxAgeMin = 60 } = {}) {
  const w = norm(wallet);
  const groups = new Map();
  for (const a of acts || []) {
    if (!a || a.type !== 'TRADE' || String(a.side || '').toUpperCase() !== 'BUY') continue;
    let ts = Number(a.timestamp) || 0;
    if (ts && ts < 1e12) ts *= 1000;
    if (!ts || ts <= sinceTs || nowMs - ts > maxAgeMin * 60e3) continue;
    const slug = a.slug || '';
    const outcome = String(a.outcome || '').trim();
    if (!slug || !outcome) continue;
    const usd = parseFloat(a.usdcSize) || 0;
    const px = parseFloat(a.price) || 0;
    if (usd <= 0 || px <= 0) continue;
    const k = `${slug}|${outcome.toLowerCase()}`;
    const g = groups.get(k) || { wallet: w, marketSlug: slug, eventSlug: a.eventSlug || null, title: a.title || slug, outcome, outcomeIndex: typeof a.outcomeIndex === 'number' ? a.outcomeIndex : null, usd: 0, shares: 0, firstTs: ts, lastTs: ts, trades: 0 };
    g.usd += usd; g.shares += usd / px; g.trades++;
    g.firstTs = Math.min(g.firstTs, ts); g.lastTs = Math.max(g.lastTs, ts);
    groups.set(k, g);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.usd < minUsd) continue;
    const { shares, ...rest } = g;
    out.push({ id: `${w}:${g.marketSlug}:${g.outcome.toLowerCase()}:${Math.round(g.firstTs / 1000)}`, ...rest, usd: Math.round(g.usd), price: shares > 0 ? Math.round(100 * g.usd / shares) : null, seenAt: new Date(nowMs).toISOString() });
  }
  return out.sort((a, b) => b.usd - a.usd);
}

// Pure: merge fresh picks into the queue (no duplicates, nothing already
// entered), returning the new queue and how many were added.
export function mergePicks(queue, fresh, enteredIds) {
  const known = new Set((queue || []).map(p => p.id));
  const entered = new Set(enteredIds || []);
  const out = [...(queue || [])];
  let added = 0;
  for (const p of fresh || []) {
    if (known.has(p.id) || entered.has(p.id)) continue;
    out.push(p); known.add(p.id); added++;
  }
  return { queue: out, added };
}

// Cron: read each copied wallet's newest trades and queue the fresh buys.
export async function pollCopyWallets(env, config = {}, nowMs = Date.now(), fetchImpl = fetch) {
  const list = await listCopyWallets(env);
  const stat = { wallets: list.length, polled: 0, queued: 0, failed: 0 };
  if (!list.length) return stat;
  let picks = await kvJson(env, COPY_KEYS.PICKS, []);
  const entered = await kvJson(env, COPY_KEYS.ENTERED, []);
  for (const w of list) {
    if (!w.enabled) continue;
    try {
      const res = await fetchImpl(`${POLY_DATA_API}/activity?user=${w.address}&limit=100`);
      if (!res.ok) { stat.failed++; continue; }
      const acts = await res.json();
      if (!Array.isArray(acts)) { stat.failed++; continue; }
      stat.polled++;
      const fresh = picksFromActivity(w.address, acts, w.lastSeenTs || 0, { minUsd: config.copyMinWhaleUsd ?? 500, nowMs, maxAgeMin: config.copyMaxAgeMin ?? 60 });
      let maxTs = w.lastSeenTs || 0;
      for (const a of acts) { let ts = Number(a.timestamp) || 0; if (ts && ts < 1e12) ts *= 1000; if (ts > maxTs) maxTs = ts; }
      const merged = mergePicks(picks, fresh.map(p => ({ ...p, nickname: w.nickname || null })), entered);
      picks = merged.queue;
      stat.queued += merged.added;
      w.queued = (w.queued || 0) + merged.added;
      w.seen = (w.seen || 0) + fresh.length;
      w.lastSeenTs = maxTs;
      if (fresh.length) w.lastTradeAt = new Date(Math.max(...fresh.map(p => p.lastTs))).toISOString();
      for (const p of fresh.slice(0, merged.added)) {
        await appendCopyLog(env, { type: 'seen', wallet: w.address, nickname: w.nickname, market: p.title, outcome: p.outcome, usd: p.usd, price: p.price }, nowMs);
      }
    } catch (e) { stat.failed++; }
  }
  await kvPut(env, COPY_KEYS.WALLETS, list);
  // A pick nobody entered within a few hours is stale: the price is gone.
  const keep = picks.filter(p => nowMs - (p.lastTs || 0) < 6 * 3600e3);
  await kvPut(env, COPY_KEYS.PICKS, keep.slice(-100));
  return stat;
}

// Pure: per-wallet and total copy record from the bot's ledger.
export function copyLedger(history, openPositions, wallets) {
  const per = {};
  const row = (a) => (per[a] = per[a] || { open: 0, wins: 0, losses: 0, pushes: 0, pnl: 0, staked: 0 });
  for (const p of openPositions || []) if (p.strategySource === 'whale_copy' && p.copyOf) row(p.copyOf).open++;
  for (const t of history || []) {
    if (t.strategySource !== 'whale_copy' || !t.copyOf) continue;
    const r = row(t.copyOf);
    if (t.outcome === 'win') r.wins++; else if (t.outcome === 'loss') r.losses++; else r.pushes++;
    r.pnl += t.pnl || 0; r.staked += t.size || 0;
  }
  const total = { open: 0, wins: 0, losses: 0, pushes: 0, pnl: 0, staked: 0 };
  for (const r of Object.values(per)) { for (const k of Object.keys(total)) total[k] += r[k]; r.pnl = Math.round(r.pnl * 100) / 100; r.staked = Math.round(r.staked * 100) / 100; }
  total.pnl = Math.round(total.pnl * 100) / 100; total.staked = Math.round(total.staked * 100) / 100;
  return { perWallet: per, total };
}

// GET /agents/copy
export async function getCopyState(env, deps, nowMs = Date.now()) {
  const [wallets, picks, log, history, open, config] = await Promise.all([
    listCopyWallets(env),
    kvJson(env, COPY_KEYS.PICKS, []),
    kvJson(env, COPY_KEYS.LOG, []),
    deps.getTradeHistory(env, 1000).catch(() => []),
    deps.getOpenPositions(env).catch(() => []),
    deps.getAutotraderConfig ? deps.getAutotraderConfig(env).catch(() => ({})) : Promise.resolve({}),
  ]);
  const ledger = copyLedger(history, open, wallets);
  const rows = [];
  for (const w of wallets) {
    const [book, skill] = await Promise.all([
      kvJson(env, `wallet_onchain:${w.address}`, null),
      deps.walletSkill ? deps.walletSkill(env, w.address).catch(() => null) : Promise.resolve(null),
    ]);
    rows.push({
      ...w,
      record: ledger.perWallet[w.address] || { open: 0, wins: 0, losses: 0, pushes: 0, pnl: 0, staked: 0 },
      skill,
      onChain: book && book.skill ? { ...book.skill, wins: book.winCount, losses: book.lossCount, windowDays: book.windowDays ?? null, official: book.official || null, at: book.at } : null,
    });
  }
  const copyOpen = (open || []).filter(p => p.strategySource === 'whale_copy').map(p => ({
    id: p.id, wallet: p.copyOf, nickname: p.copyNick || null, title: p.marketTitle, slug: p.marketSlug, side: p.directionRaw || p.direction,
    entry: p.entryPrice, whalePrice: p.whalePrice ?? null, whaleUsd: p.whaleUsd ?? null, size: p.size, openedAt: p.openedAt,
  }));
  const copyClosed = (history || []).filter(t => t.strategySource === 'whale_copy').slice(-20).reverse().map(t => ({
    wallet: t.copyOf, nickname: t.copyNick || null, title: t.marketTitle, slug: t.marketSlug, side: t.directionRaw || t.direction,
    entry: t.entryPrice, exit: t.exitPrice, whalePrice: t.whalePrice ?? null, size: t.size, pnl: t.pnl, outcome: t.outcome, exitType: t.exitType, closedAt: t.closedAt,
  }));
  return {
    success: true,
    paper: config.paperTradeMode !== false,
    wallets: rows,
    queue: picks,
    open: copyOpen,
    recent: copyClosed,
    total: ledger.total,
    log: (log || []).slice(-30).reverse(),
    settings: {
      betSize: config.copyBetSize ?? 5, maxOpen: config.copyMaxOpen ?? 10, maxPerDay: config.copyMaxPerDay ?? 10,
      minWhaleUsd: config.copyMinWhaleUsd ?? 500, maxSlipPts: config.copyMaxSlipPts ?? 4, maxAgeMin: config.copyMaxAgeMin ?? 60,
      entries: config.copyEntries !== false, maxWallets: COPY_MAX_WALLETS,
    },
    fetchedAt: new Date(nowMs).toISOString(),
  };
}

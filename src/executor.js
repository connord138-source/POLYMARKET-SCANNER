// Trade executor - DRY RUN. The GO-LIVE checklist (docs/GO-LIVE.md section 3)
// asks for a service that consumes the auto-trader's execution queue, places
// orders, confirms fills back, and fails closed on any ambiguity; and for a
// week of dry running it against the queue in paper mode first. This module is
// that executor with order placement left unimplemented on purpose: while
// `paperTradeMode` is on, every paper entry and every paper exit of the main
// lane is queued here as an intent (`executor_intents`), each 5-minute cron
// consumes the intents against the LIVE CLOB book, builds the exact order it
// would send (side, token, tick-rounded price, size, FOK), walks the book for
// the fill it would have got, charges the taker fee, applies the live risk
// gates, and records the result (`executor_fills`). GET /autotrader/executor
// diffs those dry fills against the paper ledger, round trip by round trip.
// Nothing is sent to any venue. If paperTradeMode is ever off, runExecutor
// refuses to run: there is no live adapter in this build.
import { bestOfBook, feeSched, takerFee } from './execution.js';

const CLOB_API = 'https://clob.polymarket.com';
export const EXECUTOR_KEYS = { INTENTS: 'executor_intents', FILLS: 'executor_fills', HALT: 'executor_halt', LAST: 'executor_last', DAY: 'executor_day' };
export const INTENT_TTL_MIN = 30;     // an intent not filled within 30 min is stale and fails - the live rule too
export const MAX_ATTEMPTS = 3;        // book fetch failures before an intent fails
export const DEFAULT_MIN_SIZE = 5;    // CLOB minimum order size (shares) when Gamma does not say
export const SLIPPAGE_CAP_C = 5;      // live rule: refuse a fill worse than this vs the paper price
export const FILLS_KEEP = 500;
export const MAX_PER_RUN = 10;

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// Pure: the intent the live path would have queued, from a paper position
// (BUY at entry) or a closed paper trade (SELL at exit).
export function buildIntent({ action, position, gamma = null, tokenId, priceC, exitType = null, nowIso = new Date().toISOString() }) {
  const sizeUsd = Number(position.size) || 0;
  const px = Number(priceC) / 100;
  const shares = action === 'BUY' ? (px > 0 ? sizeUsd / px : 0) : (Number(position.shares) || 0);
  return {
    id: `${action.toLowerCase()}_${position.id}`, action, positionId: position.id,
    marketSlug: position.marketSlug || null, marketTitle: position.marketTitle || null,
    conditionId: (gamma && gamma.conditionId) || position.conditionId || position.execCond || null,
    tokenId: tokenId || null,
    negRisk: !!(gamma && gamma.negRisk), tickSize: String((gamma && gamma.tickSize) || '0.01'),
    minSize: Number((gamma && gamma.minSize) || DEFAULT_MIN_SIZE),
    direction: position.directionRaw || position.direction || null,
    sizeUsd: r2(sizeUsd), shares: r4(shares), paperPriceC: r2(Number(priceC)),
    feeSchedule: (gamma && gamma.feeSchedule) || (position.exec ? { rate: position.exec.feeRate, exponent: position.exec.exponent, rebateRate: position.exec.rebateRate } : null),
    exitType, graduatedEntry: !!position.graduatedEntry, isExploration: !!position.isExploration,
    queuedAt: nowIso, status: 'PENDING', attempts: 0,
  };
}

// Pure: round a price to the market's tick; buys round up (never a better
// price than the book shows), sells round down.
export function roundToTick(price, tick, side) {
  const t = Number(tick) || 0.01;
  const n = price / t;
  const k = side === 'buy' ? Math.ceil(n - 1e-9) : Math.floor(n + 1e-9);
  return r4(Math.min(0.999, Math.max(0.001, k * t)));
}

// Pure: walk one side of the book. `levels` = [{price,size}] as the CLOB
// returns them; a buy eats asks from the cheapest, a sell eats bids from the
// best. Fill a dollar amount (buy) or a share count (sell).
export function walkBook(levels, side, { usd = null, shares = null } = {}) {
  const lv = (levels || []).map(l => [Number(l.price), Number(l.size)]).filter(l => l[0] > 0 && l[1] > 0).sort((a, b) => (side === 'buy' ? a[0] - b[0] : b[0] - a[0]));
  let fShares = 0, fUsd = 0, used = 0;
  for (const [p, s] of lv) {
    const wantShares = usd != null ? Math.max(0, (usd - fUsd) / p) : Math.max(0, shares - fShares);
    if (wantShares <= 1e-9) break;
    const take = Math.min(s, wantShares);
    fShares += take; fUsd += take * p; used++;
    if (usd != null ? fUsd >= usd - 1e-9 : fShares >= shares - 1e-9) break;
  }
  const target = usd != null ? usd : shares;
  const got = usd != null ? fUsd : fShares;
  return { filledShares: r4(fShares), filledUsd: r2(fUsd), vwap: fShares > 0 ? r4(fUsd / fShares) : null, levelsUsed: used, partial: got < target - 1e-6, bestPrice: lv.length ? lv[0][0] : null, depthShares: r2(lv.reduce((a, l) => a + l[1], 0)) };
}

// Pure: the fill the executor would have got for an intent against a book,
// and the order it would have sent to get it. A resolved market has no book:
// the position is redeemed at 0 or 1 with no fee.
export function dryFill(intent, book, nowIso = new Date().toISOString()) {
  const base = { id: intent.id, action: intent.action, positionId: intent.positionId, marketSlug: intent.marketSlug, marketTitle: intent.marketTitle, tokenId: intent.tokenId, queuedAt: intent.queuedAt, filledAt: nowIso, latencyS: Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(intent.queuedAt)) / 1000)), sizeUsd: intent.sizeUsd, paperPriceC: intent.paperPriceC, exitType: intent.exitType || null, graduatedEntry: intent.graduatedEntry, isExploration: intent.isExploration };
  if (intent.action === 'SELL' && intent.exitType === 'market_resolved') {
    const px = intent.paperPriceC >= 50 ? 1 : 0;
    return { ...base, status: 'filled', kind: 'redeem', execPriceC: px * 100, bestPriceC: px * 100, shares: intent.shares, filledShares: intent.shares, feeUsd: 0, slippageC: 0, partial: false, order: null };
  }
  const side = intent.action === 'BUY' ? 'buy' : 'sell';
  const levels = side === 'buy' ? (book && book.asks) || [] : (book && book.bids) || [];
  const w = walkBook(levels, side, side === 'buy' ? { usd: intent.sizeUsd } : { shares: intent.shares });
  if (w.vwap == null) return { ...base, status: 'failed', kind: side, reason: 'empty book', order: null };
  const sched = feeSched(intent.feeSchedule);
  const feePerShare = takerFee(w.vwap, sched);
  const limit = roundToTick(w.vwap, intent.tickSize, side);
  const order = { side: intent.action, tokenId: intent.tokenId, price: limit, size: r2(w.filledShares), type: 'FOK', tickSize: intent.tickSize, negRisk: intent.negRisk };
  const slippageC = r2((side === 'buy' ? w.vwap * 100 - intent.paperPriceC : intent.paperPriceC - w.vwap * 100));   // positive = worse than paper
  const reasons = [];
  if (w.filledShares < intent.minSize) reasons.push(`below min size (${r2(w.filledShares)} < ${intent.minSize} shares)`);
  if (slippageC > SLIPPAGE_CAP_C) reasons.push(`slippage ${slippageC}c > cap ${SLIPPAGE_CAP_C}c`);
  if (w.partial) reasons.push(`book too thin: ${r2(w.filledShares)} of ${side === 'buy' ? r2(intent.sizeUsd / (intent.paperPriceC / 100)) : intent.shares} shares`);
  return { ...base, status: 'filled', kind: side, execPriceC: r2(w.vwap * 100), bestPriceC: r2(w.bestPrice * 100), shares: side === 'buy' ? r4(intent.sizeUsd / (intent.paperPriceC / 100)) : intent.shares, filledShares: w.filledShares, filledUsd: w.filledUsd, feePerShareC: r2(feePerShare * 100), feeUsd: r2(feePerShare * w.filledShares), slippageC, partial: w.partial, levelsUsed: w.levelsUsed, depthShares: w.depthShares, spreadC: (() => { const b = bestOfBook(book); return b ? r2((b.ask - b.bid) * 100) : null; })(), wouldReject: reasons.length ? reasons : null, order };
}

// Pure: the live risk gates, evaluated on every intent. In the dry run they
// never block (the fill is still simulated so the diff stays complete); the
// result is recorded as `wouldBlock` so the gates themselves get a week of
// exercise.
export function evaluateGates(intent, { config = {}, dailyStats = {}, day = {} } = {}) {
  const reasons = [];
  if (intent.action === 'BUY') {
    if (config.maxDailyTrades != null && (day.buys || 0) >= config.maxDailyTrades) reasons.push(`maxDailyTrades ${config.maxDailyTrades} reached`);
    if (config.maxDailySpend != null && (day.spendUsd || 0) + intent.sizeUsd > config.maxDailySpend) reasons.push(`maxDailySpend ${config.maxDailySpend} would be exceeded`);
    if (config.dailyLossLimit != null && typeof dailyStats.realizedPnL === 'number' && dailyStats.realizedPnL <= config.dailyLossLimit) reasons.push(`dailyLossLimit ${config.dailyLossLimit} hit (${dailyStats.realizedPnL})`);
    if (config.maxPositionSize != null && intent.sizeUsd > config.maxPositionSize) reasons.push(`size ${intent.sizeUsd} > maxPositionSize ${config.maxPositionSize}`);
  }
  if (!intent.tokenId) reasons.push('no token id');
  return { blocked: reasons.length > 0, reasons };
}

// Pure: pair BUY and SELL dry fills by position and diff against the paper
// ledger. dryPnl = what the executor's fills would have made after both
// fees; paperPnl = the bot's own number for the same trade.
export function summarizeExecutor(fills, history = []) {
  const byPos = new Map();
  for (const f of fills || []) { const e = byPos.get(f.positionId) || byPos.set(f.positionId, {}).get(f.positionId); e[f.action === 'BUY' ? 'buy' : 'sell'] = f; }
  const hist = new Map((history || []).map(t => [t.id, t]));
  const buys = (fills || []).filter(f => f.action === 'BUY' && f.status === 'filled' && f.kind !== 'redeem');
  const avg = (xs) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const stats = {
    intentsFilled: (fills || []).filter(f => f.status === 'filled').length, failed: (fills || []).filter(f => f.status === 'failed').length,
    buys: buys.length, avgLatencyS: avg(buys.map(f => f.latencyS)), avgSlippageC: avg(buys.map(f => f.slippageC)), avgSpreadC: avg(buys.map(f => f.spreadC).filter(x => x != null)),
    partialRate: buys.length ? r2(buys.filter(f => f.partial).length / buys.length) : null, wouldRejectRate: buys.length ? r2(buys.filter(f => f.wouldReject).length / buys.length) : null, wouldBlockRate: buys.length ? r2(buys.filter(f => f.wouldBlock).length / buys.length) : null,
    feesUsd: r2((fills || []).reduce((a, f) => a + (f.feeUsd || 0), 0)),
  };
  const roundTrips = [];
  for (const [pid, e] of byPos) {
    if (!e.buy || !e.sell || e.buy.status !== 'filled' || e.sell.status !== 'filled') continue;
    const sh = Math.min(e.buy.filledShares, e.sell.filledShares);
    const dryPnl = r2((e.sell.execPriceC - e.buy.execPriceC) / 100 * sh - (e.buy.feeUsd || 0) - (e.sell.feeUsd || 0));
    const t = hist.get(pid);
    roundTrips.push({ positionId: pid, market: e.buy.marketTitle, exitType: e.sell.exitType, buyC: e.buy.execPriceC, sellC: e.sell.execPriceC, shares: r2(sh), dryPnl, paperPnl: t && typeof t.pnl === 'number' ? r2(t.pnl) : null, closedAt: e.sell.filledAt });
  }
  const withPaper = roundTrips.filter(r => r.paperPnl != null);
  const rt = { n: roundTrips.length, dryPnl: r2(roundTrips.reduce((a, r) => a + r.dryPnl, 0)), paperPnl: withPaper.length ? r2(withPaper.reduce((a, r) => a + r.paperPnl, 0)) : null, dryMinusPaper: withPaper.length ? r2(withPaper.reduce((a, r) => a + (r.dryPnl - r.paperPnl), 0)) : null, wins: roundTrips.filter(r => r.dryPnl > 0).length };
  return { stats, roundTrips: rt, recentRoundTrips: roundTrips.slice(-20).reverse() };
}

async function kvJson(env, key, dflt) { try { return (await env.SIGNALS_CACHE.get(key, { type: 'json' })) ?? dflt; } catch (e) { return dflt; } }
async function kvPut(env, key, value, ttl) { try { await env.SIGNALS_CACHE.put(key, JSON.stringify(value), ttl ? { expirationTtl: ttl } : undefined); } catch (e) {} }

export const getIntents = (env) => kvJson(env, EXECUTOR_KEYS.INTENTS, []);
export async function enqueueIntent(env, intent) {
  if (!intent || !intent.id) return false;
  const q = await getIntents(env);
  if (q.some(i => i.id === intent.id)) return false;
  q.push(intent);
  await kvPut(env, EXECUTOR_KEYS.INTENTS, q, 7 * 86400);
  return true;
}
export async function setHalt(env, on) { await kvPut(env, EXECUTOR_KEYS.HALT, { halted: !!on, at: new Date().toISOString() }); return { halted: !!on }; }
export const getHalt = (env) => kvJson(env, EXECUTOR_KEYS.HALT, { halted: false });

// One executor cycle. Refuses to do anything unless paper mode is on (no live
// adapter exists), and does nothing while the kill switch is set.
export async function runExecutor(env, { config = {}, dailyStats = {}, nowMs = Date.now(), fetchImpl = fetch, maxPerRun = MAX_PER_RUN } = {}) {
  const nowIso = new Date(nowMs).toISOString();
  if (config.paperTradeMode === false) {
    const st = { at: nowIso, mode: 'live', refused: 'live order placement is not implemented in this build; the executor fails closed and placed nothing' };
    await kvPut(env, EXECUTOR_KEYS.LAST, st); return st;
  }
  const halt = await getHalt(env);
  if (halt && halt.halted) { const st = { at: nowIso, mode: 'dry', halted: true, haltedAt: halt.at, consumed: 0 }; await kvPut(env, EXECUTOR_KEYS.LAST, st); return st; }
  const intents = await getIntents(env);
  const dayKey = `${EXECUTOR_KEYS.DAY}_${dayOf(nowMs)}`;
  const day = await kvJson(env, dayKey, { buys: 0, sells: 0, spendUsd: 0 });
  const fills = await kvJson(env, EXECUTOR_KEYS.FILLS, []);
  const remaining = []; let consumed = 0, filled = 0, failed = 0, retried = 0;
  for (const it of intents) {
    if (it.status !== 'PENDING' || consumed >= maxPerRun) { remaining.push(it); continue; }
    consumed++;
    if (nowMs - Date.parse(it.queuedAt) > INTENT_TTL_MIN * 60e3) { fills.push({ id: it.id, action: it.action, positionId: it.positionId, marketTitle: it.marketTitle, status: 'failed', reason: `stale: queued ${Math.round((nowMs - Date.parse(it.queuedAt)) / 60e3)} min ago`, queuedAt: it.queuedAt, filledAt: nowIso }); failed++; continue; }
    const gates = evaluateGates(it, { config, dailyStats, day });
    let book = null;
    if (!(it.action === 'SELL' && it.exitType === 'market_resolved')) {
      if (!it.tokenId) { fills.push({ id: it.id, action: it.action, positionId: it.positionId, marketTitle: it.marketTitle, status: 'failed', reason: 'no token id', queuedAt: it.queuedAt, filledAt: nowIso }); failed++; continue; }
      try { const res = await fetchImpl(`${CLOB_API}/book?token_id=${it.tokenId}`); if (res.ok) book = await res.json(); } catch (e) {}
      if (!book) {
        it.attempts = (it.attempts || 0) + 1;
        if (it.attempts >= MAX_ATTEMPTS) { fills.push({ id: it.id, action: it.action, positionId: it.positionId, marketTitle: it.marketTitle, status: 'failed', reason: `no book after ${it.attempts} attempts`, queuedAt: it.queuedAt, filledAt: nowIso }); failed++; }
        else { remaining.push(it); retried++; }
        continue;
      }
    }
    const f = dryFill(it, book, nowIso);
    f.wouldBlock = gates.blocked ? gates.reasons : null;
    fills.push(f);
    if (f.status === 'filled') { filled++; if (it.action === 'BUY') { day.buys++; day.spendUsd = r2(day.spendUsd + (f.filledUsd || 0)); } else day.sells++; } else failed++;
  }
  await kvPut(env, EXECUTOR_KEYS.INTENTS, remaining, 7 * 86400);
  await kvPut(env, EXECUTOR_KEYS.FILLS, fills.slice(-FILLS_KEEP), 90 * 86400);
  await kvPut(env, dayKey, day, 3 * 86400);
  const st = { at: nowIso, mode: 'dry', halted: false, pending: remaining.filter(i => i.status === 'PENDING').length, consumed, filled, failed, retried, day };
  await kvPut(env, EXECUTOR_KEYS.LAST, st);
  return st;
}

export async function getExecutorReport(env, history = [], config = {}) {
  const fills = await kvJson(env, EXECUTOR_KEYS.FILLS, []);
  const intents = await getIntents(env);
  const last = await kvJson(env, EXECUTOR_KEYS.LAST, null);
  const halt = await getHalt(env);
  const sum = summarizeExecutor(fills, history);
  const first = fills.length ? fills[0].filledAt : null;
  return {
    success: true, mode: config.paperTradeMode === false ? 'live' : 'dry', enabled: config.executorDryRun !== false, halted: !!(halt && halt.halted), last,
    dryRunSince: first, dryRunDays: first ? r2((Date.now() - Date.parse(first)) / 86400e3) : 0,
    pending: intents.filter(i => i.status === 'PENDING').map(i => ({ id: i.id, action: i.action, market: i.marketTitle, queuedAt: i.queuedAt, attempts: i.attempts })),
    ...sum, recentFills: fills.slice(-20).reverse(),
    read: `Dry run: every paper entry/exit of the main lane is queued as an intent and consumed on the next 5-minute cron against the live CLOB book. Nothing is placed anywhere. order = the FOK order the executor would have sent (tick-rounded price, size in shares). execPriceC = volume-weighted price walking the book for the paper size; slippageC = cents worse than the paper price; wouldReject = the live rules that would have refused the order (min size, slippage cap ${SLIPPAGE_CAP_C}c, thin book); wouldBlock = the daily risk gates that would have stopped it. roundTrips diff the executor's buy+sell (both taker fees) against the paper ledger's pnl for the same position; dryMinusPaper is how much the paper ledger overstates. A resolved market is redeemed at 0/1 with no fee. Live placement is not implemented: with paperTradeMode off the executor refuses to run.`,
  };
}

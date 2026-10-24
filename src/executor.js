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
// Venue: the owner routed real orders to Polymarket US (Oct 24 2026), so the
// dry run prices every intent on the Polymarket US book (src/polymarket-us.js:
// league -> moneyline -> long/short side, YES-price orders, 0.0695 x p(1-p)
// fee) and keeps the global CLOB fill alongside as a reference. The live
// path exists but is inert: it runs only when paperTradeMode is off AND the
// Polymarket US key is configured; it consumes the live exec queue, places a
// FOK limit (or close-position for exits) with synchronous execution,
// confirms the fill back to the auto-trader, and on any ambiguity after a
// send it reconciles against the account's positions and halts itself.
import { bestOfBook, feeSched, takerFee } from './execution.js';
import { pmusConfigured, resolveUsMarket, fetchUsBook, usLevels, buildUsOrder, usFeePerContract, placeUsOrder, getUsOrder, closeUsPosition, usPositionQty, usBalances, fillFromExecutions, fillFromOrder, PmusError } from './polymarket-us.js';

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
    direction: position.direction || null, directionRaw: position.directionRaw || null, marketCategory: position.marketCategory || null,
    usSlug: position.usSlug || null, usSide: position.usSide || null,
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
  if (side === 'buy' && slippageC > SLIPPAGE_CAP_C) reasons.push(`slippage ${slippageC}c > cap ${SLIPPAGE_CAP_C}c`);
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

// ---- Polymarket US dry fill: same walk, effective-price levels, venue fee ----
export function dryFillUs(intent, route, book, nowIso = new Date().toISOString()) {
  const base = { id: intent.id, action: intent.action, positionId: intent.positionId, marketSlug: intent.marketSlug, marketTitle: intent.marketTitle, tokenId: intent.tokenId, queuedAt: intent.queuedAt, filledAt: nowIso, latencyS: Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(intent.queuedAt)) / 1000)), sizeUsd: intent.sizeUsd, paperPriceC: intent.paperPriceC, exitType: intent.exitType || null, graduatedEntry: intent.graduatedEntry, isExploration: intent.isExploration, venue: 'polymarket-us', usSlug: route.slug, usSide: route.side };
  if (intent.action === 'SELL' && intent.exitType === 'market_resolved') {
    const px = intent.paperPriceC >= 50 ? 1 : 0;
    return { ...base, status: 'filled', kind: 'redeem', execPriceC: px * 100, bestPriceC: px * 100, shares: intent.shares, filledShares: intent.shares, feeUsd: 0, slippageC: 0, partial: false, order: null };
  }
  const side = intent.action === 'BUY' ? 'buy' : 'sell';
  const levels = usLevels(book, intent.action, route.side);
  const w = walkBook(levels, side, side === 'buy' ? { usd: intent.sizeUsd } : { shares: intent.shares });
  if (w.vwap == null) return { ...base, status: 'failed', kind: side, reason: 'empty Polymarket US book', order: null };
  const feePerShare = usFeePerContract(w.vwap, route.feeCoef);
  const wantShares = side === 'buy' ? intent.sizeUsd / (intent.paperPriceC / 100) : intent.shares;
  const order = buildUsOrder({ slug: route.slug, action: intent.action, side: route.side, effectivePrice: w.vwap, tick: route.tick, quantity: w.filledShares, minQty: route.minQty });
  const slippageC = r2(side === 'buy' ? w.vwap * 100 - intent.paperPriceC : intent.paperPriceC - w.vwap * 100);
  const reasons = [];
  if (order.quantity < (route.minQty || 1) || order.quantity <= 0) reasons.push(`below min size (${r2(w.filledShares)} < ${route.minQty} contracts)`);
  if (side === 'buy' && slippageC > SLIPPAGE_CAP_C) reasons.push(`slippage ${slippageC}c > cap ${SLIPPAGE_CAP_C}c`);   // exits the engine decided on go through; slippage is recorded
  if (w.partial) reasons.push(`book too thin: ${r2(w.filledShares)} of ${r2(wantShares)} contracts`);
  const spread = book && book.bids.length && book.offers.length ? r2((Math.min(...book.offers.map(l => l.price)) - Math.max(...book.bids.map(l => l.price))) * 100) : null;
  return { ...base, status: 'filled', kind: side, execPriceC: r2(w.vwap * 100), bestPriceC: r2(w.bestPrice * 100), shares: r4(wantShares), filledShares: w.filledShares, filledUsd: w.filledUsd, feePerShareC: r2(feePerShare * 100), feeUsd: r2(feePerShare * w.filledShares), slippageC, partial: w.partial, levelsUsed: w.levelsUsed, depthShares: w.depthShares, spreadC: spread, wouldReject: reasons.length ? reasons : null, order };
}

// Pure: the live exec queue item (what processSignals / the exit engine queue
// when paperTradeMode is off) in the executor's intent shape.
export function intentFromQueueItem(q) {
  const isBuy = q.action === 'BUY';
  const px = isBuy ? Number(q.entryPrice) : Number(q.exitPrice);
  const sizeUsd = Number(q.size) || 0;
  return {
    id: q.id, action: q.action, positionId: q.positionId || null, queueItem: true,
    marketSlug: q.marketSlug || null, marketTitle: q.marketTitle || null, conditionId: q.conditionId || null, tokenId: q.tokenId || null,
    negRisk: !!q.negRisk, tickSize: String(q.tickSize || '0.01'), minSize: DEFAULT_MIN_SIZE,
    direction: q.direction || null, directionRaw: q.directionRaw || null, marketCategory: q.marketCategory || null,
    usSlug: q.usSlug || null, usSide: q.usSide || null,
    sizeUsd: r2(sizeUsd), shares: r4(isBuy ? (px > 0 ? sizeUsd / px : 0) : Number(q.shares) || 0), paperPriceC: r2(px * 100),
    feeSchedule: null, exitType: q.exitType || null, exitReason: q.exitReason || null, graduatedEntry: false, isExploration: false,
    queuedAt: q.queuedAt || new Date().toISOString(), status: q.status || 'PENDING', attempts: q.attempts || 0,
  };
}

const failRec = (it, reason, nowIso, extra = {}) => ({ id: it.id, action: it.action, positionId: it.positionId, marketTitle: it.marketTitle, status: 'failed', reason, queuedAt: it.queuedAt, filledAt: nowIso, ...extra });
async function clobBook(tokenId, fetchImpl) { try { const res = await fetchImpl(`${CLOB_API}/book?token_id=${tokenId}`); return res.ok ? await res.json() : null; } catch (e) { return null; } }

// Live placement on Polymarket US for one queue item. Returns the fill record
// and calls `live.confirm` exactly once (FILLED or FAILED). Any error after
// the order left us is reconciled against the account's position in that
// market; if that cannot settle the question the executor halts itself.
async function placeLive(env, it, route, dry, { live, fetchImpl, nowIso }) {
  const confirmFailed = async (reason) => { await live.confirm({ id: it.id, status: 'FAILED', error: reason }); return { ...dry, status: 'failed', reason, live: true }; };
  if (dry.status !== 'filled') return confirmFailed(dry.reason || 'no fill');
  if (dry.wouldBlock) return confirmFailed(`blocked by risk gates: ${dry.wouldBlock.join('; ')}`);
  if (dry.wouldReject) return confirmFailed(`rejected by live rules: ${dry.wouldReject.join('; ')}`);
  await live.updateItem(it.id, { status: 'EXECUTING', executingAt: nowIso, usSlug: route.slug, usSide: route.side });
  let before = null; try { before = await usPositionQty(env, route.slug, { fetchImpl }); } catch (e) { before = null; }
  let res = null, sent = false;
  try {
    sent = true;
    res = it.action === 'BUY' || !it.positionId ? await placeUsOrder(env, dry.order, { fetchImpl }) : await closeUsPosition(env, route.slug, { fetchImpl });
  } catch (e) {
    if (e instanceof PmusError && e.status >= 400 && e.status < 500) return confirmFailed(`venue rejected: ${e.message}`);
    // ambiguous: the order may have reached the venue. Reconcile on the position, else halt.
    let after = null; try { after = await usPositionQty(env, route.slug, { fetchImpl }); } catch (e2) { after = null; }
    if (before != null && after != null && after !== before) {
      const px = dry.execPriceC / 100;
      await live.confirm({ id: it.id, status: 'FILLED', filledPrice: px, filledShares: Math.abs(after - before), orderId: 'reconciled', venue: 'polymarket-us', usSlug: route.slug, usSide: route.side, exitType: it.exitType, exitReason: it.exitReason });
      return { ...dry, live: true, reconciled: true, orderId: 'reconciled', note: `placement error (${String(e.message).slice(0, 80)}) but the position moved ${before} -> ${after}; confirmed at the dry price` };
    }
    await setHalt(env, true);
    await live.confirm({ id: it.id, status: 'FAILED', error: `ambiguous placement: ${String(e.message).slice(0, 100)} - executor halted` });
    return { ...dry, status: 'failed', live: true, halted: true, reason: `ambiguous placement, executor halted: ${String(e.message).slice(0, 100)}` };
  }
  let fill = fillFromExecutions(res && res.executions, route.side);
  if (!fill && res && res.id) {
    try { const o = await getUsOrder(env, res.id, { fetchImpl }); const f = fillFromOrder(o, route.side); if (f && f.shares > 0) fill = f; else return confirmFailed(`order ${res.id} ${f && f.state ? f.state : 'unfilled'} (FOK)`); }
    catch (e) { await setHalt(env, true); await live.confirm({ id: it.id, status: 'FAILED', error: `order ${res.id} sent but state unknown - executor halted` }); return { ...dry, status: 'failed', live: true, halted: true, orderId: res.id, reason: 'order sent, state unknown, executor halted' }; }
  }
  if (!fill) return confirmFailed(`no executions returned for order ${res && res.id}`);
  await live.confirm({ id: it.id, status: 'FILLED', filledPrice: fill.effectivePx, filledShares: fill.shares, orderId: res.id, venue: 'polymarket-us', usSlug: route.slug, usSide: route.side, exitType: it.exitType, exitReason: it.exitReason });
  return { ...dry, live: true, orderId: res.id, execPriceC: r2(fill.effectivePx * 100), filledShares: fill.shares, feeUsd: fill.feeUsd, slippageC: r2(it.action === 'BUY' ? fill.effectivePx * 100 - it.paperPriceC : it.paperPriceC - fill.effectivePx * 100) };
}

// One executor cycle. Dry while paperTradeMode is on (prices the paper lane's
// intents on the chosen venue, places nothing). Live only when paperTradeMode
// is off, the venue is Polymarket US, its key is configured and the live
// queue hooks are supplied; anything else refuses. Halted = consumes nothing.
export async function runExecutor(env, { config = {}, dailyStats = {}, nowMs = Date.now(), fetchImpl = fetch, maxPerRun = MAX_PER_RUN, live = null } = {}) {
  const nowIso = new Date(nowMs).toISOString();
  const venue = config.executorVenue || 'polymarket-us';
  const mode = config.paperTradeMode === false ? 'live' : 'dry';
  const refuse = async (why) => { const st = { at: nowIso, mode, venue, refused: why }; await kvPut(env, EXECUTOR_KEYS.LAST, st); return st; };
  if (mode === 'live') {
    if (venue !== 'polymarket-us') return refuse(`live placement exists only for polymarket-us (executorVenue is ${venue}); placed nothing`);
    if (!pmusConfigured(env)) return refuse('paperTradeMode is off but PMUS_KEY_ID / PMUS_SECRET_KEY are not configured; placed nothing');
    if (!live || typeof live.getQueue !== 'function' || typeof live.confirm !== 'function' || typeof live.updateItem !== 'function') return refuse('live queue hooks not supplied; placed nothing');
  }
  const halt = await getHalt(env);
  if (halt && halt.halted) { const st = { at: nowIso, mode, venue, halted: true, haltedAt: halt.at, consumed: 0 }; await kvPut(env, EXECUTOR_KEYS.LAST, st); return st; }
  const source = mode === 'live' ? (await live.getQueue()).filter(q => q.status === 'PENDING').map(intentFromQueueItem) : await getIntents(env);
  const dayKey = `${EXECUTOR_KEYS.DAY}_${dayOf(nowMs)}`;
  const day = await kvJson(env, dayKey, { buys: 0, sells: 0, spendUsd: 0 });
  const fills = await kvJson(env, EXECUTOR_KEYS.FILLS, []);
  const remaining = []; let consumed = 0, filled = 0, failed = 0, retried = 0, unroutable = 0, placed = 0;
  for (const it of source) {
    if (it.status !== 'PENDING' || consumed >= maxPerRun) { if (mode === 'dry') remaining.push(it); continue; }
    consumed++;
    const record = async (rec) => { fills.push(rec); if (rec.status === 'filled') { filled++; if (it.action === 'BUY') { day.buys++; day.spendUsd = r2(day.spendUsd + (rec.filledUsd || 0)); } else day.sells++; } else failed++; };
    if (nowMs - Date.parse(it.queuedAt) > INTENT_TTL_MIN * 60e3) {
      const reason = `stale: queued ${Math.round((nowMs - Date.parse(it.queuedAt)) / 60e3)} min ago`;
      if (mode === 'live') await live.confirm({ id: it.id, status: 'FAILED', error: reason });
      await record(failRec(it, reason, nowIso)); continue;
    }
    const gates = evaluateGates(it, { config, dailyStats, day });
    let rec = null;
    if (venue === 'polymarket-us') {
      const route = it.action === 'SELL' && it.exitType === 'market_resolved' ? { ok: true, slug: it.usSlug || null, side: it.usSide || 'long', tick: 0.01, minQty: 1, feeCoef: 0 } : await resolveUsMarket(env, it, { fetchImpl, nowMs });
      if (!route.ok) {
        unroutable++;
        const reason = `no Polymarket US market: ${route.reason}`;
        if (mode === 'live') await live.confirm({ id: it.id, status: 'FAILED', error: reason });
        await record(failRec(it, reason, nowIso, { venue: 'polymarket-us', unroutable: true })); continue;
      }
      let book = null;
      if (!(it.action === 'SELL' && it.exitType === 'market_resolved')) {
        try { book = await fetchUsBook(route.slug, { fetchImpl }); } catch (e) { book = null; }
        if (!book) {
          it.attempts = (it.attempts || 0) + 1;
          if (it.attempts >= MAX_ATTEMPTS) { const reason = `no Polymarket US book after ${it.attempts} attempts`; if (mode === 'live') await live.confirm({ id: it.id, status: 'FAILED', error: reason }); await record(failRec(it, reason, nowIso, { venue: 'polymarket-us' })); }
          else { if (mode === 'dry') remaining.push(it); else await live.updateItem(it.id, { attempts: it.attempts }); retried++; }
          continue;
        }
      }
      rec = dryFillUs(it, route, book, nowIso);
      rec.wouldBlock = gates.blocked ? gates.reasons : null;
      // reference: what the same intent would have filled at on the global CLOB (dry only, best effort)
      if (mode === 'dry' && it.tokenId && rec.status === 'filled' && rec.kind !== 'redeem') {
        const cb = await clobBook(it.tokenId, fetchImpl);
        if (cb) { const c = dryFill(it, cb, nowIso); if (c.status === 'filled') rec.clobRef = { execPriceC: c.execPriceC, slippageC: c.slippageC, feeUsd: c.feeUsd, spreadC: c.spreadC }; }
      }
      if (mode === 'live') { rec = await placeLive(env, it, route, rec, { live, fetchImpl, nowIso }); if (rec.live && rec.status === 'filled') placed++; }
    } else {
      // venue 'clob': the original dry run on the global book (reference only; never live)
      let book = null;
      if (!(it.action === 'SELL' && it.exitType === 'market_resolved')) {
        if (!it.tokenId) { await record(failRec(it, 'no token id', nowIso)); continue; }
        book = await clobBook(it.tokenId, fetchImpl);
        if (!book) { it.attempts = (it.attempts || 0) + 1; if (it.attempts >= MAX_ATTEMPTS) await record(failRec(it, `no book after ${it.attempts} attempts`, nowIso)); else { remaining.push(it); retried++; } continue; }
      }
      rec = dryFill(it, book, nowIso); rec.venue = 'clob'; rec.wouldBlock = gates.blocked ? gates.reasons : null;
    }
    await record(rec);
    if (rec.halted) break;   // a live ambiguity halted the executor: stop consuming this run
  }
  if (mode === 'dry') await kvPut(env, EXECUTOR_KEYS.INTENTS, remaining, 7 * 86400);
  await kvPut(env, EXECUTOR_KEYS.FILLS, fills.slice(-FILLS_KEEP), 90 * 86400);
  await kvPut(env, dayKey, day, 3 * 86400);
  const st = { at: nowIso, mode, venue, halted: !!(await getHalt(env)).halted, pending: mode === 'dry' ? remaining.filter(i => i.status === 'PENDING').length : (await live.getQueue()).filter(q => q.status === 'PENDING').length, consumed, filled, failed, retried, unroutable, placed, day };
  await kvPut(env, EXECUTOR_KEYS.LAST, st);
  return st;
}

export async function getExecutorReport(env, history = [], config = {}, { fetchImpl = fetch } = {}) {
  const fills = await kvJson(env, EXECUTOR_KEYS.FILLS, []);
  const intents = await getIntents(env);
  const last = await kvJson(env, EXECUTOR_KEYS.LAST, null);
  const halt = await getHalt(env);
  const sum = summarizeExecutor(fills, history);
  const first = fills.length ? fills[0].filledAt : null;
  const venue = config.executorVenue || 'polymarket-us';
  const unroutable = fills.filter(f => f.unroutable);
  const reasons = {}; for (const f of unroutable) { const k = String(f.reason || '').replace(/^no Polymarket US market: /, '').replace(/ for .*$/, '').slice(0, 60); reasons[k] = (reasons[k] || 0) + 1; }
  const usFills = fills.filter(f => f.venue === 'polymarket-us' && f.status === 'filled' && f.kind === 'buy');
  const withRef = usFills.filter(f => f.clobRef);
  const avg = (xs) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  let account = { configured: pmusConfigured(env) };
  if (account.configured) { try { account = { ...account, ...(await usBalances(env, { fetchImpl })) }; } catch (e) { account.error = String(e.message).slice(0, 100); } }
  return {
    success: true, mode: config.paperTradeMode === false ? 'live' : 'dry', venue, enabled: config.executorDryRun !== false, halted: !!(halt && halt.halted), last, account,
    dryRunSince: first, dryRunDays: first ? r2((Date.now() - Date.parse(first)) / 86400e3) : 0,
    pending: intents.filter(i => i.status === 'PENDING').map(i => ({ id: i.id, action: i.action, market: i.marketTitle, queuedAt: i.queuedAt, attempts: i.attempts })),
    routing: { routable: fills.filter(f => f.venue === 'polymarket-us' && !f.unroutable).length, unroutable: unroutable.length, reasons, usVsClobSlippageC: withRef.length ? { n: withRef.length, us: avg(withRef.map(f => f.slippageC)), clob: avg(withRef.map(f => f.clobRef.slippageC)) } : null },
    live: { placed: fills.filter(f => f.live && f.status === 'filled').length, failed: fills.filter(f => f.live && f.status === 'failed').length },
    ...sum, recentFills: fills.slice(-20).reverse(),
    read: `Venue: ${venue}. Dry run while paperTradeMode is on: every paper entry/exit of the main lane is queued as an intent and consumed on the next 5-minute cron; each is routed to the Polymarket US moneyline (league -> game -> long/short side) and priced on that book with its 0.0695 x p(1-p) fee; clobRef is the same intent on the global CLOB for comparison. Nothing is placed while dry. order = the FOK limit the executor would send (YES-price convention, tick-rounded, contracts). execPriceC = volume-weighted effective price for the paper size; slippageC = cents worse than the paper price; wouldReject = live rules that would refuse it (min size, slippage cap ${SLIPPAGE_CAP_C}c, thin book); wouldBlock = the daily risk gates. routing.unroutable = intents with no Polymarket US market (the live path skips those trades). roundTrips diff buy+sell (both fees) against the paper ledger; dryMinusPaper is how much paper overstates. Live: only with paperTradeMode off and PMUS_KEY_ID/PMUS_SECRET_KEY set; consumes the live exec queue, FOK limit or close-position with synchronous execution, confirms fills to the auto-trader, reconciles ambiguous sends against the account position and halts itself if that fails. POST /autotrader/executor/halt is the kill switch.`,
  };
}

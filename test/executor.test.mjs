// Executor dry run. Run with: node test/executor.test.mjs
import { buildIntent, roundToTick, walkBook, dryFill, evaluateGates, summarizeExecutor, enqueueIntent, getIntents, runExecutor, setHalt, getExecutorReport, INTENT_TTL_MIN, MAX_ATTEMPTS, SLIPPAGE_CAP_C } from "../src/executor.js";
import { takerFee } from "../src/execution.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const sched = { rate: 0.03, exponent: 1, takerOnly: true, rebateRate: 0.15 };
const gamma = { conditionId: "0xc1", negRisk: false, tickSize: "0.01", minSize: 5, feeSchedule: sched };
const pos = { id: "at_1", marketSlug: "bills-rams", marketTitle: "Bills vs. Rams", direction: "YES", directionRaw: "Bills", size: 10, shares: 25, graduatedEntry: true };
const T0 = "2026-10-24T18:00:00.000Z";

{
  const b = buildIntent({ action: "BUY", position: pos, gamma, tokenId: "tokB", priceC: 40, nowIso: T0 });
  check("intent: BUY carries the live payload (token, flags, size, shares = usd/price, fee schedule)", b.id === "buy_at_1" && b.tokenId === "tokB" && b.conditionId === "0xc1" && b.tickSize === "0.01" && b.minSize === 5 && b.sizeUsd === 10 && b.shares === 25 && b.paperPriceC === 40 && b.feeSchedule.rate === 0.03 && b.status === "PENDING" && b.graduatedEntry === true, JSON.stringify(b));
  const s = buildIntent({ action: "SELL", position: { ...pos, exec: { feeRate: 0.03, exponent: 1, rebateRate: 0.15 }, execCond: "0xc1" }, tokenId: "tokB", priceC: 55, exitType: "take_profit", nowIso: T0 });
  check("intent: SELL uses the position's shares, exit type and the shadow's fee schedule", s.id === "sell_at_1" && s.shares === 25 && s.paperPriceC === 55 && s.exitType === "take_profit" && s.conditionId === "0xc1" && s.feeSchedule.rate === 0.03, JSON.stringify(s));
  check("tick: buys round up, sells round down, clamped to (0,1)", roundToTick(0.4133, "0.01", "buy") === 0.42 && roundToTick(0.4133, "0.01", "sell") === 0.41 && roundToTick(0.4133, "0.001", "buy") === 0.414 && roundToTick(0.0001, "0.01", "sell") === 0.001 && roundToTick(0.9999, "0.01", "buy") === 0.999);
}
{
  const asks = [{ price: "0.42", size: "10" }, { price: "0.40", size: "15" }, { price: "0.45", size: "100" }];
  const w = walkBook(asks, "buy", { usd: 10 });
  // 15 @ .40 = $6, then $4 / .42 = 9.5238 shares -> 24.5238 shares, vwap 0.4078
  check("walk: a buy eats the cheapest asks first and fills the dollar amount", Math.abs(w.filledShares - 24.5238) < 1e-3 && w.filledUsd === 10 && Math.abs(w.vwap - 0.4078) < 1e-3 && w.levelsUsed === 2 && !w.partial && w.bestPrice === 0.4 && w.depthShares === 125, JSON.stringify(w));
  const thin = walkBook([{ price: "0.40", size: "5" }], "buy", { usd: 10 });
  check("walk: a thin book fills partially", thin.filledShares === 5 && thin.filledUsd === 2 && thin.partial === true);
  const bids = [{ price: "0.50", size: "10" }, { price: "0.55", size: "10" }, { price: "0.48", size: "50" }];
  const ws = walkBook(bids, "sell", { shares: 25 });
  // 10 @ .55, 10 @ .50, 5 @ .48 -> vwap (5.5+5+2.4)/25 = 0.516
  check("walk: a sell eats the best bids first for the share count", ws.filledShares === 25 && Math.abs(ws.vwap - 0.516) < 1e-6 && ws.levelsUsed === 3 && !ws.partial && ws.bestPrice === 0.55, JSON.stringify(ws));
  check("walk: empty book -> no vwap", walkBook([], "buy", { usd: 10 }).vwap === null);
}
{
  const buy = buildIntent({ action: "BUY", position: pos, gamma, tokenId: "tokB", priceC: 40, nowIso: T0 });
  const book = { bids: [{ price: "0.39", size: "200" }], asks: [{ price: "0.41", size: "200" }] };
  const f = dryFill(buy, book, "2026-10-24T18:00:30.000Z");
  check("fill: buy at the ask, 1c slippage, fee on the filled shares, FOK order at the tick-rounded price, latency recorded", f.status === "filled" && f.kind === "buy" && f.execPriceC === 41 && f.slippageC === 1 && Math.abs(f.filledShares - 10 / 0.41) < 1e-3 && Math.abs(f.feeUsd - takerFee(0.41, sched) * (10 / 0.41)) < 0.01 && f.spreadC === 2 && f.order.side === "BUY" && f.order.price === 0.41 && f.order.type === "FOK" && f.order.size === 24.39 && f.wouldReject === null && f.latencyS === 30 && !f.partial, JSON.stringify(f));
  const bad = dryFill(buy, { bids: [], asks: [{ price: "0.47", size: "3" }] }, T0);
  check("fill: thin and expensive book -> would be rejected (min size, slippage cap, thin)", bad.status === "filled" && bad.partial && bad.wouldReject.length === 3 && /min size/.test(bad.wouldReject[0]) && /slippage/.test(bad.wouldReject[1]) && /thin/.test(bad.wouldReject[2]), JSON.stringify(bad.wouldReject));
  check("fill: empty book -> failed", dryFill(buy, { bids: [], asks: [] }, T0).status === "failed");
  const sell = buildIntent({ action: "SELL", position: { ...pos, shares: 24 }, gamma, tokenId: "tokB", priceC: 55, exitType: "take_profit", nowIso: T0 });
  const fs = dryFill(sell, { bids: [{ price: "0.54", size: "100" }], asks: [{ price: "0.56", size: "100" }] }, T0);
  check("fill: sell at the bid, slippage measured against the paper exit", fs.kind === "sell" && fs.execPriceC === 54 && fs.slippageC === 1 && fs.filledShares === 24 && fs.order.side === "SELL" && fs.order.price === 0.54, JSON.stringify(fs));
  const red = dryFill(buildIntent({ action: "SELL", position: { ...pos, shares: 24 }, gamma, tokenId: "tokB", priceC: 100, exitType: "market_resolved", nowIso: T0 }), null, T0);
  check("fill: a resolved market is redeemed at 1 or 0 with no fee and no order", red.kind === "redeem" && red.execPriceC === 100 && red.feeUsd === 0 && red.order === null && dryFill(buildIntent({ action: "SELL", position: pos, gamma, tokenId: "tokB", priceC: 0, exitType: "market_resolved", nowIso: T0 }), null, T0).execPriceC === 0);
}
{
  const buy = buildIntent({ action: "BUY", position: pos, gamma, tokenId: "tokB", priceC: 40, nowIso: T0 });
  const cfg = { maxDailyTrades: 5, maxDailySpend: 50, dailyLossLimit: -15, maxPositionSize: 100 };
  check("gates: clear day passes", evaluateGates(buy, { config: cfg, dailyStats: { realizedPnL: 0 }, day: { buys: 0, spendUsd: 0 } }).blocked === false);
  const g = evaluateGates(buy, { config: cfg, dailyStats: { realizedPnL: -15 }, day: { buys: 5, spendUsd: 45 } });
  check("gates: trade cap, spend cap and loss limit all reported", g.blocked && g.reasons.length === 3 && /maxDailyTrades/.test(g.reasons[0]) && /maxDailySpend/.test(g.reasons[1]) && /dailyLossLimit/.test(g.reasons[2]), JSON.stringify(g));
  check("gates: a sell is not capped; a missing token blocks", evaluateGates({ ...buy, action: "SELL" }, { config: cfg, day: { buys: 9 } }).blocked === false && evaluateGates({ ...buy, tokenId: null }, { config: cfg }).reasons[0] === "no token id");
}
{
  const fills = [
    { id: "buy_p1", action: "BUY", positionId: "p1", marketTitle: "A", status: "filled", kind: "buy", execPriceC: 41, filledShares: 24, feeUsd: 0.18, slippageC: 1, latencyS: 20, spreadC: 2, partial: false, wouldReject: null, wouldBlock: null },
    { id: "sell_p1", action: "SELL", positionId: "p1", marketTitle: "A", status: "filled", kind: "sell", execPriceC: 54, filledShares: 24, feeUsd: 0.18, exitType: "take_profit", filledAt: "2026-10-24T20:00:00Z" },
    { id: "buy_p2", action: "BUY", positionId: "p2", marketTitle: "B", status: "filled", kind: "buy", execPriceC: 30, filledShares: 30, feeUsd: 0.19, slippageC: 3, latencyS: 40, spreadC: 4, partial: true, wouldReject: ["thin"], wouldBlock: ["maxDailySpend"] },
    { id: "buy_p3", action: "BUY", positionId: "p3", status: "failed", reason: "stale" },
  ];
  const hist = [{ id: "p1", pnl: 3.5 }, { id: "p2", pnl: -1 }];
  const s = summarizeExecutor(fills, hist);
  check("summary: fills, rates and averages", s.stats.intentsFilled === 3 && s.stats.failed === 1 && s.stats.buys === 2 && s.stats.avgSlippageC === 2 && s.stats.avgLatencyS === 30 && s.stats.partialRate === 0.5 && s.stats.wouldRejectRate === 0.5 && s.stats.wouldBlockRate === 0.5 && Math.abs(s.stats.feesUsd - 0.55) < 1e-9, JSON.stringify(s.stats));
  // round trip p1: (0.54-0.41)*24 - 0.36 = 2.76 vs paper 3.5
  check("summary: round trip pairs buy and sell, diffs against the paper ledger", s.roundTrips.n === 1 && Math.abs(s.roundTrips.dryPnl - 2.76) < 1e-6 && s.roundTrips.paperPnl === 3.5 && Math.abs(s.roundTrips.dryMinusPaper + 0.74) < 1e-6 && s.roundTrips.wins === 1 && s.recentRoundTrips[0].positionId === "p1", JSON.stringify(s.roundTrips));
}
{
  // end to end: KV + fetch mocked; a BUY intent is consumed on the next run; stale intents fail; halt stops everything; live mode refuses
  const kv = new Map();
  const env = { SIGNALS_CACHE: { get: async (k) => { const v = kv.get(k); return v === undefined ? null : JSON.parse(v); }, put: async (k, v) => { kv.set(k, v); } } };
  let bookCalls = 0; let bookDown = false;
  const fetchMock = async (u) => { bookCalls++; if (bookDown) return { ok: false, status: 500, json: async () => ({}) }; return { ok: true, json: async () => ({ bids: [{ price: "0.39", size: "500" }], asks: [{ price: "0.41", size: "500" }] }) }; };
  const cfg = { paperTradeMode: true, maxDailyTrades: 5, maxDailySpend: 50, dailyLossLimit: -15, maxPositionSize: 100 };
  const t0 = Date.parse(T0);
  check("enqueue: idempotent by id", (await enqueueIntent(env, buildIntent({ action: "BUY", position: pos, gamma, tokenId: "tokB", priceC: 40, nowIso: T0 }))) === true && (await enqueueIntent(env, buildIntent({ action: "BUY", position: pos, gamma, tokenId: "tokB", priceC: 40, nowIso: T0 }))) === false && (await getIntents(env)).length === 1);
  const r1 = await runExecutor(env, { config: cfg, dailyStats: { realizedPnL: 0 }, nowMs: t0 + 20e3, fetchImpl: fetchMock });
  check("run: the intent is consumed against the book, the day counters advance, the queue empties", r1.mode === "dry" && r1.consumed === 1 && r1.filled === 1 && r1.pending === 0 && r1.day.buys === 1 && r1.day.spendUsd === 10 && bookCalls === 1 && (await getIntents(env)).length === 0, JSON.stringify(r1));
  let rep = await getExecutorReport(env, [], cfg);
  check("report: one dry fill with its order, dry run started", rep.mode === "dry" && rep.enabled && !rep.halted && rep.stats.buys === 1 && rep.recentFills[0].order.price === 0.41 && rep.dryRunSince === "2026-10-24T18:00:20.000Z" && /Nothing is placed/.test(rep.read), JSON.stringify(rep.stats));
  // sell closes the round trip: paper pnl 3.5 vs dry
  await enqueueIntent(env, buildIntent({ action: "SELL", position: { ...pos, shares: 24.39 }, gamma, tokenId: "tokB", priceC: 55, exitType: "take_profit", nowIso: new Date(t0 + 3600e3).toISOString() }));
  const r2 = await runExecutor(env, { config: cfg, dailyStats: { realizedPnL: 0 }, nowMs: t0 + 3600e3 + 10e3, fetchImpl: fetchMock });
  rep = await getExecutorReport(env, [{ id: "at_1", pnl: 3.5 }], cfg);
  check("run+report: the sell fills at the bid and the round trip is diffed against the paper pnl", r2.filled === 1 && rep.roundTrips.n === 1 && rep.roundTrips.paperPnl === 3.5 && rep.roundTrips.dryPnl < 0 && rep.roundTrips.dryMinusPaper < -3, JSON.stringify(rep.roundTrips));
  // stale intent fails without a book call
  await enqueueIntent(env, buildIntent({ action: "BUY", position: { ...pos, id: "at_2" }, gamma, tokenId: "tokB", priceC: 40, nowIso: T0 }));
  const before = bookCalls;
  const r3 = await runExecutor(env, { config: cfg, nowMs: t0 + (INTENT_TTL_MIN + 1) * 60e3, fetchImpl: fetchMock });
  check("run: a stale intent fails closed, no book fetched", r3.failed === 1 && r3.filled === 0 && bookCalls === before && (await getIntents(env)).length === 0, JSON.stringify(r3));
  // book down: retried, then failed after MAX_ATTEMPTS
  bookDown = true;
  await enqueueIntent(env, buildIntent({ action: "BUY", position: { ...pos, id: "at_3" }, gamma, tokenId: "tokB", priceC: 40, nowIso: new Date(t0 + 7200e3).toISOString() }));
  let last = null; for (let i = 0; i < MAX_ATTEMPTS; i++) last = await runExecutor(env, { config: cfg, nowMs: t0 + 7200e3 + (i + 1) * 60e3, fetchImpl: fetchMock });
  check("run: no book -> retried, then failed after the attempt cap", last.failed === 1 && (await getIntents(env)).length === 0, JSON.stringify(last));
  bookDown = false;
  // gates recorded, never blocking in the dry run
  await enqueueIntent(env, buildIntent({ action: "BUY", position: { ...pos, id: "at_4", size: 200 }, gamma, tokenId: "tokB", priceC: 40, nowIso: new Date(t0 + 7300e3).toISOString() }));
  const r4 = await runExecutor(env, { config: cfg, dailyStats: { realizedPnL: -20 }, nowMs: t0 + 7300e3 + 10e3, fetchImpl: fetchMock });
  rep = await getExecutorReport(env, [], cfg);
  const f4 = rep.recentFills.find(f => f.positionId === "at_4");
  check("run: the live gates are evaluated and recorded as wouldBlock, the fill is still simulated", r4.filled === 1 && Array.isArray(f4.wouldBlock) && f4.wouldBlock.some(r => /dailyLossLimit/.test(r)) && f4.wouldBlock.some(r => /maxDailySpend/.test(r)) && f4.wouldBlock.some(r => /maxPositionSize/.test(r)), JSON.stringify(f4 && f4.wouldBlock));
  // kill switch
  await setHalt(env, true);
  await enqueueIntent(env, buildIntent({ action: "BUY", position: { ...pos, id: "at_5" }, gamma, tokenId: "tokB", priceC: 40, nowIso: new Date(t0 + 7400e3).toISOString() }));
  const r5 = await runExecutor(env, { config: cfg, nowMs: t0 + 7400e3 + 10e3, fetchImpl: fetchMock });
  check("run: halted -> consumes nothing, intent stays queued", r5.halted === true && r5.consumed === 0 && (await getIntents(env)).length === 1 && (await getExecutorReport(env, [], cfg)).halted === true, JSON.stringify(r5));
  await setHalt(env, false);
  // live mode: refuses, touches nothing
  const r6 = await runExecutor(env, { config: { ...cfg, paperTradeMode: false }, nowMs: t0 + 7500e3, fetchImpl: fetchMock });
  check("run: paperTradeMode off -> refuses (no live adapter), the intent is untouched", r6.mode === "live" && /not implemented/.test(r6.refused) && (await getIntents(env)).length === 1 && (await getExecutorReport(env, [], { ...cfg, paperTradeMode: false })).mode === "live", JSON.stringify(r6));
  const r7 = await runExecutor(env, { config: cfg, nowMs: t0 + 7500e3, fetchImpl: fetchMock });
  check("run: back in paper mode the queued intent is consumed", r7.filled === 1 && (await getIntents(env)).length === 0);
}
console.log(`executor: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

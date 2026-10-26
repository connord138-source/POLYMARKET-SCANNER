// Executor dry run. Run with: node test/executor.test.mjs
import { buildIntent, roundToTick, walkBook, dryFill, dryFillUs, intentFromQueueItem, evaluateGates, summarizeExecutor, enqueueIntent, getIntents, runExecutor, setHalt, getHalt, getExecutorReport, INTENT_TTL_MIN, MAX_ATTEMPTS, SLIPPAGE_CAP_C } from "../src/executor.js";
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
  check("gates: the loss limit is a magnitude (+100 or -150 both mean stop at -limit); a small losing day passes, -limit blocks", evaluateGates(buy, { config: { dailyLossLimit: 100 }, dailyStats: { realizedPnL: -5 }, day: {} }).blocked === false && evaluateGates(buy, { config: { dailyLossLimit: 100 }, dailyStats: { realizedPnL: -100 }, day: {} }).reasons[0] === "dailyLossLimit -100 hit (-100)" && evaluateGates(buy, { config: { dailyLossLimit: -15 }, dailyStats: { realizedPnL: -20 }, day: {} }).blocked === true && evaluateGates(buy, { config: { dailyLossLimit: -15 }, dailyStats: { realizedPnL: 45 }, day: {} }).blocked === false);
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
  const cfg = { paperTradeMode: true, executorVenue: "clob", maxDailyTrades: 5, maxDailySpend: 50, dailyLossLimit: -15, maxPositionSize: 100 };
  const t0 = Date.parse(T0);
  check("enqueue: idempotent by id", (await enqueueIntent(env, buildIntent({ action: "BUY", position: pos, gamma, tokenId: "tokB", priceC: 40, nowIso: T0 }))) === true && (await enqueueIntent(env, buildIntent({ action: "BUY", position: pos, gamma, tokenId: "tokB", priceC: 40, nowIso: T0 }))) === false && (await getIntents(env)).length === 1);
  const r1 = await runExecutor(env, { config: cfg, dailyStats: { realizedPnL: 0 }, nowMs: t0 + 20e3, fetchImpl: fetchMock });
  check("run: the intent is consumed against the book, the day counters advance, the queue empties", r1.mode === "dry" && r1.consumed === 1 && r1.filled === 1 && r1.pending === 0 && r1.day.buys === 1 && r1.day.spendUsd === 10 && bookCalls === 1 && (await getIntents(env)).length === 0, JSON.stringify(r1));
  let rep = await getExecutorReport(env, [], cfg);
  check("report: one dry fill with its order, dry run started", rep.mode === "dry" && rep.enabled && !rep.halted && rep.stats.buys === 1 && rep.recentFills[0].order.price === 0.41 && rep.dryRunSince === "2026-10-24T18:00:20.000Z" && /Nothing is placed while dry/.test(rep.read), JSON.stringify(rep.stats));
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
  check("run: paperTradeMode off on the clob venue -> refuses (no live adapter there), the intent is untouched", r6.mode === "live" && /live placement exists only for polymarket-us/.test(r6.refused) && (await getIntents(env)).length === 1 && (await getExecutorReport(env, [], { ...cfg, paperTradeMode: false })).mode === "live", JSON.stringify(r6));
  const r7 = await runExecutor(env, { config: cfg, nowMs: t0 + 7500e3, fetchImpl: fetchMock });
  check("run: back in paper mode the queued intent is consumed", r7.filled === 1 && (await getIntents(env)).length === 0);
}
{
  // ---- Polymarket US venue: dry run routes every intent to the US moneyline and prices it there ----
  const kv = new Map();
  const env = { SIGNALS_CACHE: { get: async (k) => { const v = kv.get(k); return v === undefined ? null : JSON.parse(v); }, put: async (k, v) => { kv.set(k, v); } } };
  const seen = []; let usBids = [{ px: { value: "0.40" }, qty: "100" }], usOffers = [{ px: { value: "0.42" }, qty: "80" }];
  const gw = async (u, opts) => {
    const url = String(u); seen.push({ url, opts });
    if (url.includes("/v2/leagues/nfl/events")) return { ok: true, json: async () => ({ events: [{ title: "BUF Bills vs. LA Rams", startDate: "2026-10-25T00:15:00Z", markets: [{ slug: "aec-nfl-buf-lar-2026-10-24", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE", marketSides: [{ description: "Rams", long: false, team: { name: "Los Angeles Rams" } }, { description: "Bills", long: true, team: { name: "Buffalo Bills" } }] }] }] }) };
    if (url.includes("/v1/market/slug/aec-nfl-buf-lar-2026-10-24")) return { ok: true, json: async () => ({ market: { orderPriceMinTickSize: 0.01, minimumTradeQty: 1, feeCoefficient: 0.0695, status: "MARKET_STATUS_OPEN" } }) };
    if (url.includes("/v1/markets/aec-nfl-buf-lar-2026-10-24/book")) return { ok: true, json: async () => ({ marketData: { bids: usBids, offers: usOffers } }) };
    if (url.includes("clob.polymarket.com/book")) return { ok: true, json: async () => ({ bids: [{ price: "0.39", size: "500" }], asks: [{ price: "0.405", size: "500" }] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const cfg = { paperTradeMode: true, maxDailyTrades: 5, maxDailySpend: 50, dailyLossLimit: -15, maxPositionSize: 100 };
  const T = "2026-10-24T22:00:00.000Z", t0 = Date.parse(T);
  const nflPos = { id: "at_us1", marketSlug: "nfl-buf-lar-2026-10-24", marketTitle: "Bills vs. Rams", direction: "YES", directionRaw: "Bills", size: 10, shares: 25 };
  await enqueueIntent(env, buildIntent({ action: "BUY", position: nflPos, gamma, tokenId: "tokB", priceC: 40, nowIso: T }));
  await enqueueIntent(env, buildIntent({ action: "BUY", position: { ...nflPos, id: "at_us2", directionRaw: "Rams" }, gamma, tokenId: "tokR", priceC: 60, nowIso: T }));
  await enqueueIntent(env, buildIntent({ action: "BUY", position: { id: "at_btc", marketSlug: "btc-updown-5m-1", marketTitle: "Bitcoin Up or Down", direction: "YES", size: 10 }, gamma, tokenId: "tokX", priceC: 50, nowIso: T }));
  const r = await runExecutor(env, { config: cfg, dailyStats: {}, nowMs: t0 + 20e3, fetchImpl: gw });
  const rep = await getExecutorReport(env, [], cfg);
  const fB = rep.recentFills.find(f => f.positionId === "at_us1"), fR = rep.recentFills.find(f => f.positionId === "at_us2"), fX = rep.recentFills.find(f => f.positionId === "at_btc");
  check("us dry: default venue is polymarket-us; two NFL intents routed, the crypto one unroutable", r.venue === "polymarket-us" && r.consumed === 3 && r.filled === 2 && r.failed === 1 && r.unroutable === 1 && rep.routing.routable === 2 && rep.routing.unroutable === 1 && fX.unroutable === true && /league not routable/.test(fX.reason), JSON.stringify({ r, routing: rep.routing }));
  check("us dry: the Bills intent is the long side, lifts the 0.42 offer, pays the US fee, carries the FOK order and a clob reference", fB.venue === "polymarket-us" && fB.usSlug === "aec-nfl-buf-lar-2026-10-24" && fB.usSide === "long" && fB.execPriceC === 42 && fB.slippageC === 2 && fB.order.intent === "ORDER_INTENT_BUY_LONG" && fB.order.price.value === "0.42" && fB.order.quantity === 23 && Math.abs(fB.feePerShareC - 0.0695 * 0.42 * 0.58 * 100) < 0.01 && fB.clobRef && fB.clobRef.execPriceC === 40.5 && fB.spreadC === 2, JSON.stringify(fB));
  check("us dry: the Rams intent is the short side: hits the 0.40 bid at an effective 0.60, YES price 0.40, BUY_SHORT", fR.usSide === "short" && fR.execPriceC === 60 && fR.slippageC === 0 && fR.order.intent === "ORDER_INTENT_BUY_SHORT" && fR.order.price.value === "0.40", JSON.stringify(fR));
  check("us dry: nothing was sent to api.polymarket.us", seen.every(c => !String(c.url).includes("api.polymarket.us")));
  // thin US book -> wouldReject
  usOffers = [{ px: { value: "0.42" }, qty: "3" }];
  await enqueueIntent(env, buildIntent({ action: "BUY", position: { ...nflPos, id: "at_us3" }, gamma, tokenId: "tokB", priceC: 40, nowIso: new Date(t0 + 60e3).toISOString() }));
  await runExecutor(env, { config: cfg, dailyStats: {}, nowMs: t0 + 80e3, fetchImpl: gw });
  const f3 = (await getExecutorReport(env, [], cfg)).recentFills.find(f => f.positionId === "at_us3");
  check("us dry: a thin US book is recorded as would-reject (thin), still filled for the diff", f3.status === "filled" && f3.partial && f3.wouldReject && f3.wouldReject.length === 1 && /thin/.test(f3.wouldReject[0]), JSON.stringify(f3.wouldReject));
  usOffers = [{ px: { value: "0.42" }, qty: "80" }];
  // resolved-market exit on a pre-routed intent needs no book
  await enqueueIntent(env, buildIntent({ action: "SELL", position: { ...nflPos, usSlug: "aec-nfl-buf-lar-2026-10-24", usSide: "long", shares: 23 }, tokenId: "tokB", priceC: 100, exitType: "market_resolved", nowIso: new Date(t0 + 120e3).toISOString() }));
  const rr = await runExecutor(env, { config: cfg, dailyStats: {}, nowMs: t0 + 130e3, fetchImpl: gw });
  check("us dry: a resolved market is redeemed, no routing or book needed", rr.filled === 1 && (await getExecutorReport(env, [], cfg)).recentFills[0].kind === "redeem");
}
{
  // ---- live path on Polymarket US with a mocked venue: FOK fill, FOK miss, ambiguity -> halt, exit via close-position ----
  const kv = new Map();
  const env = { SIGNALS_CACHE: { get: async (k) => { const v = kv.get(k); return v === undefined ? null : JSON.parse(v); }, put: async (k, v) => { kv.set(k, v); } }, PMUS_KEY_ID: "key-1", PMUS_SECRET_KEY: Buffer.alloc(32, 9).toString("base64") };
  const T = "2026-10-24T22:00:00.000Z", t0 = Date.parse(T);
  let queue = []; const confirms = [], updates = [], api = [];
  const live = { getQueue: async () => queue, updateItem: async (id, u) => { updates.push({ id, u }); const q = queue.find(x => x.id === id); if (q) Object.assign(q, u); }, confirm: async (b) => { confirms.push(b); queue = queue.filter(x => x.id !== b.id); } };
  let orderResponse = { id: "ord-1", executions: [{ lastShares: 23, lastPx: { value: "0.42" }, commissionNotionalCollected: { value: "0.39" } }] };
  let orderThrows = null, positionQty = 0, getOrderState = null;
  const mock = async (u, opts) => {
    const url = String(u);
    if (url.includes("/v2/leagues/nfl/events")) return { ok: true, json: async () => ({ events: [{ title: "BUF Bills vs. LA Rams", startDate: "2026-10-25T00:15:00Z", markets: [{ slug: "aec-nfl-buf-lar-2026-10-24", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE", marketSides: [{ description: "Rams", long: false, team: { name: "Los Angeles Rams" } }, { description: "Bills", long: true, team: { name: "Buffalo Bills" } }] }] }] }) };
    if (url.includes("/v1/market/slug/")) return { ok: true, json: async () => ({ market: { orderPriceMinTickSize: 0.01, minimumTradeQty: 1, feeCoefficient: 0.0695, status: "MARKET_STATUS_OPEN" } }) };
    if (url.includes("/book")) return { ok: true, json: async () => ({ marketData: { bids: [{ px: { value: "0.40" }, qty: "100" }], offers: [{ px: { value: "0.42" }, qty: "80" }] } }) };
    if (url.startsWith("https://api.polymarket.us")) {
      api.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
      if (url.includes("/v1/portfolio/positions")) return { ok: true, status: 200, json: async () => ({ positions: positionQty ? { "aec-nfl-buf-lar-2026-10-24": { netPositionDecimal: String(positionQty) } } : {} }) };
      if (url.endsWith("/v1/orders") || url.endsWith("/v1/order/close-position")) { if (orderThrows) throw orderThrows; return { ok: true, status: 200, json: async () => orderResponse }; }
      if (url.includes("/v1/order/")) return { ok: true, status: 200, json: async () => ({ state: getOrderState, cumQuantity: 0 }) };
      if (url.includes("/v1/account/balances")) return { ok: true, status: 200, json: async () => ({ balances: [{ currency: "USD", currentBalance: 150, buyingPower: 140 }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const cfgLive = { paperTradeMode: false, maxDailyTrades: 5, maxDailySpend: 50, dailyLossLimit: -15, maxPositionSize: 100 };
  const qBuy = () => ({ id: "trade_1", action: "BUY", status: "PENDING", marketSlug: "nfl-buf-lar-2026-10-24", marketTitle: "Bills vs. Rams", tokenId: "tokB", direction: "YES", directionRaw: "Bills", entryPrice: 0.40, size: 10, queuedAt: T, marketCategory: "sports" });
  const it = intentFromQueueItem(qBuy());
  check("live: queue item -> intent (cents, shares from size/price, labels)", it.id === "trade_1" && it.paperPriceC === 40 && it.shares === 25 && it.directionRaw === "Bills" && it.sizeUsd === 10 && it.status === "PENDING", JSON.stringify(it));
  // refusals: no credentials / no hooks
  const noKey = await runExecutor({ ...env, PMUS_SECRET_KEY: undefined }, { config: cfgLive, nowMs: t0, fetchImpl: mock, live });
  const noHooks = await runExecutor(env, { config: cfgLive, nowMs: t0, fetchImpl: mock });
  check("live: refuses without credentials or without the queue hooks", /not configured/.test(noKey.refused) && /hooks not supplied/.test(noHooks.refused));
  // happy path
  queue = [qBuy()];
  const r1 = await runExecutor(env, { config: cfgLive, dailyStats: { realizedPnL: 0 }, nowMs: t0 + 10e3, fetchImpl: mock, live });
  const post = api.find(c => c.url.endsWith("/v1/orders"));
  check("live: FOK limit sent with signed headers; fill confirmed to the auto-trader with price, shares, order id and venue", r1.mode === "live" && r1.placed === 1 && r1.filled === 1 && post && post.method === "POST" && post.headers["X-PM-Access-Key"] === "key-1" && post.headers["X-PM-Signature"] && post.body.intent === "ORDER_INTENT_BUY_LONG" && post.body.price.value === "0.42" && post.body.quantity === 23 && post.body.tif === "TIME_IN_FORCE_FILL_OR_KILL" && updates.some(u => u.id === "trade_1" && u.u.status === "EXECUTING") && confirms.length === 1 && confirms[0].status === "FILLED" && confirms[0].filledPrice === 0.42 && confirms[0].filledShares === 23 && confirms[0].orderId === "ord-1" && confirms[0].venue === "polymarket-us" && confirms[0].usSlug === "aec-nfl-buf-lar-2026-10-24" && confirms[0].usSide === "long" && queue.length === 0, JSON.stringify({ r1, post: post && post.body, confirms }));
  const rep1 = await getExecutorReport(env, [], cfgLive, { fetchImpl: mock });
  check("live: report shows the live fill and the account", rep1.mode === "live" && rep1.live.placed === 1 && rep1.account.configured && rep1.account.buyingPower === 140 && rep1.recentFills[0].live === true && rep1.recentFills[0].orderId === "ord-1", JSON.stringify({ live: rep1.live, account: rep1.account }));
  // FOK miss: no executions, order state canceled -> FAILED
  orderResponse = { id: "ord-2", executions: [] }; getOrderState = "ORDER_STATE_CANCELED";
  queue = [{ ...qBuy(), id: "trade_2", queuedAt: new Date(t0 + 60e3).toISOString() }];
  const r2 = await runExecutor(env, { config: cfgLive, dailyStats: { realizedPnL: 0 }, nowMs: t0 + 70e3, fetchImpl: mock, live });
  check("live: an unfilled FOK is confirmed FAILED, nothing halts", r2.failed === 1 && confirms[1].status === "FAILED" && /ORDER_STATE_CANCELED/.test(confirms[1].error) && !(await getHalt(env)).halted, JSON.stringify(confirms[1]));
  // venue 4xx -> FAILED, no halt
  const { PmusError } = await import("../src/polymarket-us.js"); orderThrows = new PmusError("polymarket.us 400 POST /v1/orders: Bad request", 400, {});
  queue = [{ ...qBuy(), id: "trade_3", queuedAt: new Date(t0 + 120e3).toISOString() }];
  const r3 = await runExecutor(env, { config: cfgLive, dailyStats: { realizedPnL: 0 }, nowMs: t0 + 130e3, fetchImpl: mock, live });
  check("live: a clean venue rejection is confirmed FAILED without halting", r3.failed === 1 && /venue rejected/.test(confirms[2].error) && !(await getHalt(env)).halted, JSON.stringify(confirms[2]));
  // ambiguous send: network error, position unchanged -> FAILED + halted
  orderThrows = new Error("fetch failed: socket hang up");
  queue = [{ ...qBuy(), id: "trade_4", queuedAt: new Date(t0 + 180e3).toISOString() }];
  const r4 = await runExecutor(env, { config: cfgLive, dailyStats: { realizedPnL: 0 }, nowMs: t0 + 190e3, fetchImpl: mock, live });
  check("live: an ambiguous send with no position change halts the executor and fails the item", r4.halted === true && confirms[3].status === "FAILED" && /ambiguous placement/.test(confirms[3].error) && (await getHalt(env)).halted, JSON.stringify({ r4, c: confirms[3] }));
  const r5 = await runExecutor(env, { config: cfgLive, nowMs: t0 + 200e3, fetchImpl: mock, live });
  check("live: while halted nothing is consumed", r5.halted === true && r5.consumed === 0);
  await setHalt(env, false);
  // ambiguous send but the position moved -> reconciled as FILLED at the dry price
  positionQty = 0;
  const mockMoving = async (u, opts) => { const url = String(u); if (url.includes("/v1/portfolio/positions")) { const q = positionQty; positionQty = 23; return { ok: true, status: 200, json: async () => ({ positions: q ? { "aec-nfl-buf-lar-2026-10-24": { netPositionDecimal: String(q) } } : {} }) }; } return mock(u, opts); };
  queue = [{ ...qBuy(), id: "trade_5", queuedAt: new Date(t0 + 240e3).toISOString() }];
  const r6 = await runExecutor(env, { config: cfgLive, dailyStats: { realizedPnL: 0 }, nowMs: t0 + 250e3, fetchImpl: mockMoving, live });
  const c5 = confirms.find(c => c.id === "trade_5");
  check("live: an ambiguous send whose position moved is reconciled and confirmed FILLED", r6.filled === 1 && c5.status === "FILLED" && c5.orderId === "reconciled" && c5.filledShares === 23 && !(await getHalt(env)).halted, JSON.stringify(c5));
  // gates block for real in live mode
  orderThrows = null; orderResponse = { id: "ord-6", executions: [{ lastShares: 23, lastPx: { value: "0.42" } }] };
  queue = [{ ...qBuy(), id: "trade_6", size: 500, queuedAt: new Date(t0 + 300e3).toISOString() }];
  const r7 = await runExecutor(env, { config: cfgLive, dailyStats: { realizedPnL: 0 }, nowMs: t0 + 310e3, fetchImpl: mock, live });
  check("live: a risk gate blocks the order and fails the item", r7.failed === 1 && /blocked by risk gates/.test(confirms.find(c => c.id === "trade_6").error) && !api.some(c => c.url.endsWith("/v1/orders") && c.body && c.body.quantity > 100));
  // exit: SELL queue item on a short position -> close-position, effective price = 1 - avgPx
  orderResponse = { id: "ord-7", executions: [{ lastShares: 20, lastPx: { value: "0.35" }, commissionNotionalCollected: { value: "0.3" } }] };
  queue = [{ id: "exit_1", action: "SELL", status: "PENDING", marketSlug: "nfl-buf-lar-2026-10-24", marketTitle: "Bills vs. Rams", tokenId: "tokR", positionId: "at_live_1", shares: 20, size: 12, exitPrice: 0.66, exitType: "take_profit", exitReason: "tp", usSlug: "aec-nfl-buf-lar-2026-10-24", usSide: "short", directionRaw: "Rams", queuedAt: new Date(t0 + 360e3).toISOString() }];
  const r8 = await runExecutor(env, { config: cfgLive, dailyStats: { realizedPnL: 0 }, nowMs: t0 + 370e3, fetchImpl: mock, live });
  const close = api.filter(c => c.url.endsWith("/v1/order/close-position")).pop();
  const c8 = confirms.find(c => c.id === "exit_1");
  check("live: an exit closes the position on the venue; a short's proceeds are 1 - YES price; exit type passed through", r8.placed === 1 && close && close.body.marketSlug === "aec-nfl-buf-lar-2026-10-24" && close.body.synchronousExecution === true && c8.status === "FILLED" && Math.abs(c8.filledPrice - 0.65) < 1e-9 && c8.filledShares === 20 && c8.exitType === "take_profit", JSON.stringify({ close: close && close.body, c8 }));
}
console.log(`executor: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

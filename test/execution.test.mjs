// Execution shadow ledger. Run with: node test/execution.test.mjs
import { feeSched, takerFee, makerRebate, bestOfBook, sideTokenId, shadowOnEntry, shadowCheckFills, shadowOnExit, ledgerAdd, ledgerSummary, refreshShadows, settleShadow, attachShadow, getExecReport } from "../src/execution.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

const sports = { feeSchedule: { exponent: 1, rate: 0.03, takerOnly: true, rebateRate: 0.15 } };
check("fee: sports schedule 3% x p(1-p), 15% rebate", near(takerFee(0.5, sports), 0.0075) && near(makerRebate(0.5, sports), 0.001125) && feeSched(null).rate === 0 && takerFee(0.4, null) === 0);
check("book: best levels", JSON.stringify(bestOfBook({ bids: [{ price: "0.38", size: "100" }, { price: "0.30", size: "5" }], asks: [{ price: "0.40", size: "7" }, { price: "0.39", size: "20" }] })) === JSON.stringify({ bid: 0.38, ask: 0.39, bidSz: 100, askSz: 20 }) && bestOfBook({ bids: [], asks: [{ price: "0.5", size: "1" }] }) === null);
const gamma = { yesTokenId: "Y", noTokenId: "N", outcomes: ["Bills", "Rams"], conditionId: "0xc", feeSchedule: sports.feeSchedule };
check("side token: label match, then Yes/No", sideTokenId(gamma, "Rams") === "N" && sideTokenId(gamma, "Bills") === "Y" && sideTokenId({ yesTokenId: "Y", noTokenId: "N" }, "No") === "N" && sideTokenId(gamma, "Under 45.5") === null);

{
  const pos = { size: 10, entryPrice: 38.5, pnl: 0 };
  const ex = shadowOnEntry(pos, { bids: [{ price: "0.38", size: "100" }], asks: [{ price: "0.39", size: "50" }] }, gamma, "2026-10-13T00:00:00Z", 60);
  check("entry: book recorded, limit at bid, fees in cents", ex.bidC === 38 && ex.askC === 39 && ex.midC === 38.5 && ex.spreadC === 1 && ex.limitC === 38 && ex.status === "pending" && near(ex.takerFeeC, 0.714, 1e-3) && near(ex.rebateC, 0.106, 1e-3), JSON.stringify(ex));
  check("entry: crossed or empty book -> no shadow", shadowOnEntry({}, { bids: [{ price: "0.40", size: 1 }], asks: [{ price: "0.39", size: 1 }] }, gamma) === null && shadowOnEntry({}, null, gamma) === null);
  const T = (ts, price, side = "SELL", asset = "Y") => ({ asset, price, side, timestamp: ts });
  const placed = Date.parse("2026-10-13T00:00:00Z") / 1000;
  check("fills: earlier print, wrong token, taker-buy print and price above limit all ignored",
    shadowCheckFills(ex, [T(placed - 10, 0.37), T(placed + 10, 0.37, "SELL", "N"), T(placed + 20, 0.38, "BUY"), T(placed + 30, 0.385)], "Y", placed * 1000 + 600e3) === "pending");
  check("fills: a sell at the bid after posting fills", shadowCheckFills(ex, [T(placed + 300, 0.38)], "Y", placed * 1000 + 600e3) === "filled" && ex.fillMin === 5 && ex.filledAt === "2026-10-13T00:05:00.000Z");
  const ex2 = shadowOnEntry({ size: 10 }, { bids: [{ price: "0.38", size: 1 }], asks: [{ price: "0.39", size: 1 }] }, gamma, "2026-10-13T00:00:00Z", 60);
  check("fills: TTL passes -> expired; millisecond timestamps accepted", shadowCheckFills(ex2, [{ asset: "Y", price: 0.39, side: "SELL", timestamp: (placed + 5) * 1000 }], "Y", placed * 1000 + 61 * 60e3) === "expired");

  // exit by resolution at 100: paper +$15.97 (10/0.385 shares); taker bought 25.641 sh at 39 -> +15.64 - fee 25.641*0.03*0.39*0.61 = 0.183
  pos.pnl = 15.97;
  const r = shadowOnExit(pos, 100, "market_resolved");
  const sharesT = 10 / 0.39, sharesM = 10 / 0.38;
  check("exit: resolved win, taker pays entry fee only, maker earns rebate", r.status === "filled" && near(r.taker, Math.round((sharesT - 10 - sharesT * 0.03 * 0.39 * 0.61) * 100) / 100, 1e-9) && near(r.maker, Math.round((sharesM - 10 + sharesM * 0.15 * 0.03 * 0.38 * 0.62) * 100) / 100, 1e-9) && r.paper === 15.97, JSON.stringify(r));
  // stopped out at 30 (not resolved): both pay half the entry spread + taker fee at 0.30 on the way out
  const pos2 = { size: 10, entryPrice: 38.5, pnl: -2.21, exec: { ...ex, status: "filled" } };
  const r2 = shadowOnExit(pos2, 30, "stop_loss");
  const exitCost = 0.01 / 2 + 0.03 * 0.3 * 0.7;
  check("exit: non-resolution exit charges spread + fee", near(r2.taker, Math.round((sharesT * (0.30 - exitCost) - 10 - sharesT * 0.03 * 0.39 * 0.61) * 100) / 100, 1e-9) && r2.maker < r2.taker + 0.5 && r2.maker > r2.taker, JSON.stringify(r2));
  const pos3 = { size: 10, pnl: 1, exec: { ...ex, status: "expired" } };
  check("exit: expired maker -> maker null, taker still priced", shadowOnExit(pos3, 50, "take_profit").maker === null && typeof shadowOnExit(pos3, 50, "take_profit").taker === "number");
  check("exit: no exec -> null", shadowOnExit({ size: 10 }, 50, "x") === null);
}
{
  let L = ledgerAdd(null, { paper: 2, taker: 1.5, maker: 1.8, status: "filled", spreadC: 1 }, { fillMin: 4 });
  L = ledgerAdd(L, { paper: -1, taker: -1.3, maker: null, status: "expired", spreadC: 2 }, {});
  const s = ledgerSummary(L);
  check("ledger: sums and the filled-subset comparison", s.n === 2 && s.filled === 1 && s.expired === 1 && s.paper === 1 && s.taker === 0.2 && s.makerOnFilled === 1.8 && s.paperOnFilled === 2 && s.takerOnFilled === 1.5 && s.fillRate === 0.5 && s.avgSpreadC === 1.5 && s.avgFillMin === 4 && s.takerMinusPaper === -0.8 && s.makerMinusTakerOnFilled === 0.3, JSON.stringify(s));
}
{
  // IO: attach (CLOB book), refresh (data-api tape), settle (KV ledger), report
  const kv = new Map();
  const env = { SIGNALS_CACHE: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => { kv.set(k, v); } } };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/book?token_id=Y")) return { ok: true, json: async () => ({ bids: [{ price: "0.38", size: "100" }], asks: [{ price: "0.39", size: "50" }] }) };
    if (u.includes("/trades?market=0xc")) return { ok: true, json: async () => [{ asset: "Y", side: "SELL", price: 0.38, size: 20, timestamp: Math.floor(Date.now() / 1000) + 1 }] };
    return { ok: false, status: 404 };
  };
  const pos = { id: "p1", marketTitle: "Bills vs. Rams", direction: "Bills", size: 10, entryPrice: 38.5 };
  const ex = await attachShadow(env, pos, gamma, sideTokenId(gamma, "Bills"), 60);
  check("attach: book fetched, token/condition stored", ex && ex.status === "pending" && pos.execToken === "Y" && pos.execCond === "0xc" && pos.exec.feeRate === 0.03, JSON.stringify(pos));
  const rf = await refreshShadows(env, [pos, { exec: null }], Date.now() + 120e3);
  check("refresh: pending shadow filled from the tape", rf.checked === 1 && rf.filled === 1 && pos.exec.status === "filled", JSON.stringify(rf));
  const closed = { ...pos, exitPrice: 100, exitType: "market_resolved", pnl: 15.97 };
  const res = await settleShadow(env, closed);
  const L = JSON.parse(kv.get("exec_ledger"));
  check("settle: ledger written", res.status === "filled" && L.n === 1 && L.filled === 1 && L.paper === 15.97 && L.makerOnFilled > L.takerOnFilled, JSON.stringify(L));
  const rep = await getExecReport(env, [closed], [pos]);
  check("report: ledger summary + recent rows", rep.ledger.n === 1 && rep.recent.length === 1 && rep.recent[0].status === "filled" && rep.recent[0].maker === res.maker && rep.open.length === 1, JSON.stringify(rep).slice(0, 300));
  const closedPending = { size: 10, pnl: 0, exitPrice: 50, exitType: "timeout", exec: { bidC: 38, askC: 39, midC: 38.5, spreadC: 1, limitC: 38, status: "pending", placedAt: new Date().toISOString(), ttlMin: 60, feeRate: 0.03, exponent: 1, rebateRate: 0.15 } };
  const r2 = await settleShadow(env, closedPending);
  check("settle: closing with the shadow still pending counts as unfilled", r2.status === "expired" && r2.maker === null && JSON.parse(kv.get("exec_ledger")).expired === 1);
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

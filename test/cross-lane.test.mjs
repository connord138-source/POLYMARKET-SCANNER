// Kalshi against Polymarket US, tested as live (src/cross-lane.js): what a two-leg bot would have got.
import { CROSS, crossMode, crossCandidates, pickCandidates, gameKey, legDirKey, kalshiBuyLevels, kalshiSellLevels, kalshiOrderFee, walkBuy, walkSell, planCross, matchPair, unwindLeg, verdictFor, runCrossLane, hedgeVerdict, checkCrossHedges, summarizeCrosses, crossReport } from "../src/cross-lane.js";
import { kalshiLevelsOf } from "../src/kalshi.js";
import { usLevels } from "../src/polymarket-us.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x === undefined ? "" : JSON.stringify(x)); } };
const near = (a, b, e = 0.006) => typeof a === "number" && Math.abs(a - b) < e;
const NOW = Date.parse("2026-11-16T20:00:00Z"), TS = Math.floor(NOW / 1000);

// one sampled leg: the team's Kalshi YES market and the US instrument in the team's terms
const leg = (o = {}) => ({ ts: TS, sport: "nba", game: "Knicks vs. Raptors", team: "Knicks", us_slug: "aec-nba-nyk-tor-2026-11-16", us_long: true, k_ticker: "KXNBAGAME-26NOV16NYKTOR-NYK", us_bid: 0.50, us_ask: 0.51, us_bid_qty: 600, us_ask_qty: 700, k_bid: 0.50, k_ask: 0.52, ...o });
// US gateway book and Kalshi orderbook bodies
const usBody = (bids, offers) => ({ marketData: { bids: bids.map(([p, q]) => ({ px: { value: String(p) }, qty: String(q) })), offers: offers.map(([p, q]) => ({ px: { value: String(p) }, qty: String(q) })) } });
const usBook = (bids, offers) => ({ bids: bids.map(([price, size]) => ({ price, size })), offers: offers.map(([price, size]) => ({ price, size })) });
const kBody = (yes, no) => ({ orderbook_fp: { yes_dollars: yes.map(([p, q]) => [String(p), String(q)]), no_dollars: no.map(([p, q]) => [String(p), String(q)]) } });
const kBook = (yes, no) => kalshiLevelsOf(kBody(yes, no));

// ---------- the candidates ----------
{
  check("candidates: no cross at ordinary quotes", crossCandidates([leg()]).length === 0);
  // Kalshi bids 58 for the Knicks while the US asks 51: buy US at 51, buy Kalshi NO at 42 -> 1 - .93 = 7c less fees (~2.37 + 1.71)
  const a = crossCandidates([leg({ k_bid: 0.58, k_ask: 0.60 })]);
  check("candidates: buy US, sell Kalshi = the US side at its ask and Kalshi NO at 1 - bid", a.length === 1 && a[0].dir === "us_k" && a[0].usSide === "long" && a[0].kSide === "no" && a[0].sUsPx === 0.51 && a[0].sKPx === 0.42 && near(a[0].sEdgeC, 7 - 9.5 * 0.51 * 0.49 - 7 * 0.42 * 0.58, 0.02) && a[0].sUsQty === 700 && !a[0].suspect, a);
  // Kalshi asks 44 while the US bids 50: buy Kalshi YES at 44, buy the other US side at 1 - .50
  const b = crossCandidates([leg({ k_bid: 0.42, k_ask: 0.44 })]);
  check("candidates: buy Kalshi, sell US = Kalshi YES at its ask and the other US side at 1 - bid", b.length === 1 && b[0].dir === "k_us" && b[0].usSide === "short" && b[0].kSide === "yes" && b[0].sUsPx === 0.5 && b[0].sKPx === 0.44 && b[0].sUsQty === 600 && near(b[0].sEdgeC, 6 - 9.5 * 0.25 - 7 * 0.44 * 0.56, 0.02), b);
  const c = crossCandidates([leg({ us_long: false, k_bid: 0.58, k_ask: 0.60 })]);
  check("candidates: a leg on the short side of the US instrument buys short", c[0].usSide === "short" && crossCandidates([leg({ us_long: false, k_bid: 0.42, k_ask: 0.44 })])[0].usSide === "long");
  check("candidates: under the floor, missing quotes or no market on a venue = nothing", crossCandidates([leg({ k_bid: 0.55 })]).length === 0 && crossCandidates([leg({ k_bid: 0.58, us_slug: null })]).length === 0 && crossCandidates([leg({ k_bid: 0.58, k_ticker: null })]).length === 0 && crossCandidates([leg({ k_bid: null, k_ask: null })]).length === 0 && crossCandidates([null]).length === 0);
  const big = crossCandidates([leg({ k_bid: 0.9, k_ask: 0.92 }), leg({ team: "Raptors", game: "B", k_bid: 0.58, k_ask: 0.6 })]);
  check("candidates: biggest first, a huge one is flagged suspect", big.length === 2 && big[0].sEdgeC > big[1].sEdgeC && big[0].suspect === true && big[1].suspect === false);
}

// ---------- which ones a minute looks at ----------
{
  const mk = (game, team, edge, dir = "us_k") => ({ sport: "nba", game, team, dir, sEdgeC: edge });
  const cands = [mk("A", "a1", 5), mk("A", "a2", 4), mk("B", "b1", 3), mk("C", "c1", 2.5), mk("D", "d1", 2), mk("E", "e1", 1.5)];
  const p = pickCandidates(cands, {}, { nowMs: NOW });
  check("pick: one per game, three a minute, biggest first", p.picked.map(x => x.team).join() === "a1,b1,c1" && p.skipped["one per game a minute"] === 1 && p.skipped["over the per-minute count"] === 2, p);
  const st = { last: { [legDirKey(cands[0])]: NOW - 2 * 60e3, [legDirKey(cands[2])]: NOW - 6 * 60e3 }, games: { [gameKey(cands[3])]: CROSS.perGameDay } };
  const q = pickCandidates(cands, st, { nowMs: NOW });
  check("pick: a leg inside the cooldown and a game past its daily count are passed over; the other leg of the game takes its place", q.picked.map(x => x.team).join() === "a2,b1,d1" && q.skipped["looked at in the last few minutes"] === 1 && q.skipped["the game's daily count"] === 1, q);
}

// ---------- Kalshi's book ----------
{
  const b = kBook([[0.55, 100], [0.57, 40], [0.5, 0]], [[0.40, 30], [0.41, 20]]);
  check("kalshi levels: highest first, empty levels dropped", b.yes.map(l => l.px).join() === "0.57,0.55" && b.no.map(l => l.px).join() === "0.41,0.4");
  check("kalshi: buying YES lifts the NO bids (a NO bid at 41 is a YES offer at 59), cheapest first", JSON.stringify(kalshiBuyLevels(b, "yes")) === JSON.stringify([{ price: 0.59, size: 20 }, { price: 0.6, size: 30 }]));
  check("kalshi: buying NO lifts the YES bids (a YES bid at 57 is a NO offer at 43)", JSON.stringify(kalshiBuyLevels(b, "no")) === JSON.stringify([{ price: 0.43, size: 40 }, { price: 0.45, size: 100 }]));
  check("kalshi: selling goes into that side's own bids, best first", kalshiSellLevels(b, "yes")[0].price === 0.57 && kalshiSellLevels(b, "no")[0].price === 0.41 && kalshiBuyLevels(null, "yes").length === 0);
  check("kalshi fee: 0.07 x count x p(1-p), rounded up to the cent", kalshiOrderFee(25, 0.5) === 0.44 && kalshiOrderFee(1, 0.5) === 0.02 && kalshiOrderFee(100, 0.5) === 1.75 && kalshiOrderFee(10, 0.99) === 0.01);
  check("kalshi levels: the legacy cents shape reads the same", kalshiLevelsOf({ orderbook: { yes: [[55, 10]], no: [[40, 5]] } }).yes[0].px === 0.55 && kalshiLevelsOf({}).yes.length === 0);
}

// ---------- walking a side ----------
{
  const lv = [{ price: 0.45, size: 100 }, { price: 0.43, size: 40 }, { price: 0.5, size: 0 }];
  const w = walkBuy(lv, 50, 0.45);
  check("walk buy: cheapest first, the whole size or nothing", w.filled && near(w.avgPx, (40 * 0.43 + 10 * 0.45) / 50, 0.0002) && w.worstPx === 0.45 && w.best === 0.43 && w.avail === 140, w);
  check("walk buy: the limit holds, short size is no fill", walkBuy(lv, 50, 0.43).filled === false && walkBuy(lv, 50, 0.43).avail === 40 && walkBuy(lv, 200, 0.99).filled === false && walkBuy([], 5).filled === false && walkBuy(lv, 0).filled === false);
  const s = walkSell([{ price: 0.4, size: 10 }, { price: 0.42, size: 5 }], 12);
  check("walk sell: best bid first, no limit; partial on a short book, null on an empty one", s && near(s.avgPx, (5 * 0.42 + 7 * 0.4) / 12, 0.0002) && !s.partial && walkSell([{ price: 0.4, size: 10 }], 12).partial === true && walkSell([], 5) === null);
}

// ---------- the plan on the real books ----------
{
  // US offers 30 at 51 then 500 at 53; Kalshi NO offered (YES bid) 20 at 42 then 200 at 43
  const us = usLevels(usBook([[0.5, 600]], [[0.51, 30], [0.53, 500]]), "BUY", "long");
  const k = kalshiBuyLevels(kBook([[0.58, 20], [0.57, 200]], [[0.38, 300]]), "no");
  // edges at 0.095 and 0.07: 51+42 -> 7 - 4.08 = 2.92c; 51+43 -> 6 - 4.09 = 1.91c; 53+43 -> 4 - 4.08 < 0
  const p = planCross(us, k, { maxShares: 25 });
  check("plan: takes every share that still locks 1c, to the stake; the limits are the worst levels it takes", p.ok && p.shares === 25 && p.usLimit === 0.51 && p.kLimit === 0.43 && near(p.topEdgeC, 2.92, 0.02), p);
  const p2 = planCross(us, k, { maxShares: 100 });
  check("plan: stops where the next share no longer locks 1c (30 at 51 on the US side)", p2.ok && p2.shares === 30 && p2.usLimit === 0.51 && p2.kLimit === 0.43, p2);
  const p3 = planCross(us, k, { maxShares: 100, minLockC: 2.5 });
  check("plan: a higher floor keeps only the best levels", p3.ok && p3.shares === 20 && p3.kLimit === 0.42, p3);
  const gone = planCross(usLevels(usBook([[0.5, 600]], [[0.56, 500]]), "BUY", "long"), k, { maxShares: 25 });
  check("plan: no cross on the real books -> nothing, with how far off the top of book was", gone.ok === false && gone.offered === 0 && gone.topEdgeC < 1, gone);
  const thin = planCross(usLevels(usBook([[0.5, 600]], [[0.51, 3], [0.6, 500]]), "BUY", "long"), k, { maxShares: 25 });
  check("plan: under five shares crossing is not a trade", thin.ok === false && thin.offered === 3, thin);
  check("plan: whole shares at the venue's step; an empty side is nothing", planCross(usLevels(usBook([], [[0.51, 12.7]]), "BUY", "long"), k, { maxShares: 25 }).shares === 12 && planCross(usLevels(usBook([], [[0.51, 13]]), "BUY", "long"), k, { maxShares: 25, step: 5 }).shares === 10 && planCross([], k, { maxShares: 25 }).ok === false && planCross([], k, { maxShares: 25 }).topEdgeC === null);
}

// ---------- both orders against a pair of book reads ----------
const C = crossCandidates([leg({ k_bid: 0.58, k_ask: 0.60 })])[0];          // us_k: US long + Kalshi NO
const MARKET = { tick: 0.01, minQty: 1, feeCoef: 0.095, status: "MARKET_STATUS_OPEN" };
const US_OK = usBook([[0.5, 600]], [[0.51, 700]]), K_OK = kBook([[0.58, 300]], [[0.4, 300]]);
const PLAN = { ok: true, shares: 25, usLimit: 0.51, kLimit: 0.42 };
{
  const m = matchPair(US_OK, K_OK, C, PLAN, MARKET);
  check("match: both legs fill at their limits with each venue's fee", m.us.filled && m.us.px === 0.51 && near(m.us.feeUsd, 25 * 0.095 * 0.51 * 0.49, 0.006) && m.k.filled && m.k.px === 0.42 && m.k.feeUsd === kalshiOrderFee(25, 0.42), m);
  const v = verdictFor(C, PLAN, m, { us: US_OK, k: K_OK });
  check("verdict: both fill = the pair is locked; pays $1 a share less both costs and both fees", v.verdict === "filled" && near(v.pnl, 25 - 25 * 0.51 - 25 * 0.42 - m.us.feeUsd - m.k.feeUsd, 0.011) && near(v.pnlC, 100 * v.pnl / 25, 0.011) && near(v.staked, 25 * 0.93 + m.us.feeUsd + m.k.feeUsd, 0.011), v);
  // Kalshi's bid pulled: only 10 left at 58
  const K_GONE = kBook([[0.58, 10], [0.5, 300]], [[0.4, 300]]);
  const m2 = matchPair(US_OK, K_GONE, C, PLAN, MARKET);
  const v2 = verdictFor(C, PLAN, m2, { us: US_OK, k: K_GONE });
  check("verdict: Kalshi gone = the US leg alone, sold straight back at the bid with both US fees", v2.verdict === "legged_us" && m2.k.filled === false && m2.k.avail === 10 && near(v2.pnl, 25 * 0.5 - 25 * 0.51 - m2.us.feeUsd - 25 * 0.095 * 0.25, 0.011) && v2.pnl < 0, [m2, v2]);
  // the US offer pulled: only 4 at 51
  const US_GONE = usBook([[0.5, 600]], [[0.51, 4], [0.55, 700]]);
  const m3 = matchPair(US_GONE, K_OK, C, PLAN, MARKET);
  const v3 = verdictFor(C, PLAN, m3, { us: US_GONE, k: K_OK });
  // bought NO at 42 (the YES bid at 58); sells NO back into the NO bids at 40
  check("verdict: Polymarket US gone = the Kalshi leg alone, sold back into its own bids", v3.verdict === "legged_kalshi" && near(v3.pnl, 25 * 0.4 - 25 * 0.42 - kalshiOrderFee(25, 0.42) - kalshiOrderFee(25, 0.4), 0.011) && v3.pnl < 0, [m3, v3]);
  const v4 = verdictFor(C, PLAN, matchPair(US_GONE, K_GONE, C, PLAN, MARKET), { us: US_GONE, k: K_GONE });
  check("verdict: both gone = nothing happened", v4.verdict === "killed" && v4.pnl === 0 && v4.staked === 0);
  check("verdict: a failed second read is not a result", verdictFor(C, PLAN, null, {}).verdict === "read_failed" && verdictFor(C, PLAN, { us: null, k: m.k }, {}).verdict === "read_failed");
  check("unwind: a leg that cannot be sold back whole is unpriced", unwindLeg("us", usBook([], [[0.51, 700]]), C, 25, m.us) === null && unwindLeg("kalshi", kBook([[0.58, 300]], [[0.4, 5]]), C, 25, m.k) === null && verdictFor(C, PLAN, m2, { us: usBook([], [[0.51, 700]]), k: K_GONE }).pnl === null);
  // the other direction: Kalshi YES + the US short side
  const C2 = crossCandidates([leg({ k_bid: 0.42, k_ask: 0.44 })])[0];
  const m5 = matchPair(usBook([[0.5, 600]], [[0.51, 700]]), kBook([[0.42, 300]], [[0.56, 300]]), C2, { ok: true, shares: 25, usLimit: 0.5, kLimit: 0.44 }, MARKET);
  check("match: buy Kalshi YES at 44 and the US short side at 1 - bid", m5.us.filled && m5.us.px === 0.5 && m5.k.filled && m5.k.px === 0.44, m5);
}

// ---------- the run ----------
// $25 at 51c + 42c a pair buys 26 pairs
const mkEnv = (o = {}) => {
  const kv = new Map(), writes = [];
  const env = {
    SIGNALS_CACHE: { get: async (k, opt) => { const v = kv.get(k); return v == null ? null : opt && opt.type === "json" ? JSON.parse(v) : v; }, put: async (k, v) => { kv.set(k, v); } },
    DB: { prepare: (sql) => ({ bind: (...a) => ({ sql, a, run: async () => ({ success: true }) }) }), batch: async (stmts) => { if (o.dbFail && o.dbFail-- > 0) throw new Error("D1 DB is overloaded"); writes.push(...stmts); return []; } },
    ...o.env,
  };
  return { env, kv, writes };
};
// a fetch that serves a sequence of (US book, Kalshi book) pairs: read n of each venue gets books[n]
const mkFetch = (pairs, calls = []) => {
  const n = { us: 0, k: 0 };
  return async (u) => {
    const url = String(u); calls.push(url);
    if (/\/v1\/market\/slug\//.test(url)) return { ok: true, json: async () => ({ market: { orderPriceMinTickSize: "0.01", minimumTradeQty: "0.01", feeCoefficient: "0.095", status: "MARKET_STATUS_OPEN" } }) };
    if (/polymarket\.us\/v1\/markets\/.*\/book/.test(url)) { const p = pairs[Math.min(n.us++, pairs.length - 1)]; return p.us ? { ok: true, json: async () => p.us } : { ok: false, status: 502, json: async () => ({}) }; }
    if (/\/orderbook/.test(url)) { const p = pairs[Math.min(n.k++, pairs.length - 1)]; return p.k ? { ok: true, status: 200, json: async () => p.k } : { ok: false, status: 503, json: async () => ({}) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
};
const US_B = usBody([[0.5, 600]], [[0.51, 700]]), K_B = kBody([[0.58, 300]], [[0.4, 300]]);
const noSleep = async () => {};
{
  const { env, kv, writes } = mkEnv();
  const calls = [];
  const out = await runCrossLane(env, { legs: [leg({ k_bid: 0.58, k_ask: 0.60 })], nowMs: NOW, fetchImpl: mkFetch([{ us: US_B, k: K_B }], calls), sleep: noSleep, clock: () => NOW + 4000 });
  check("run: a cross that is still on both books at both reads is a filled pair", out.mode === "dry" && out.seen === 1 && out.looked === 1 && out.planned === 1 && out.filled === 1 && out.pnlUsd > 0 && writes.length === 1, out);
  const a = writes[0].a;
  check("run: the row carries the pair, the fills, the timing and the size that was there (37 values)", a.length === 37 && (writes[0].sql.match(/\?/g) || []).length === 37 && a[34] === 0.51 && a[35] === 0.42 && a[36] === 300 && a[6] === "us_k" && a[8] === "long" && a[10] === "no" && a[17] === "filled" && a[19] === 26 && a[20] === 0.51 && a[21] === 0.42 && a[24] === 0.51 && a[25] === 0.42 && a[29] > 0 && a[16] === 4 && a[32] === 1, a);
  check("run: both books are read three times (plan, fill, the later look) past the US edge cache, and nothing is posted", calls.filter(u => /\/book\?_=/.test(u)).length === 3 && calls.filter(u => /orderbook/.test(u)).length === 3 && calls.every(u => !/\/v1\/orders|portfolio/.test(u)), calls);
  const st = JSON.parse(kv.get("cross_state"));
  check("run: the leg is cooling off and the game counted", Object.keys(st.last).length === 1 && Object.values(st.games)[0] === 1 && JSON.parse(kv.get("cross_last")).rows[0].verdict === "filled");
  const again = await runCrossLane(env, { legs: [leg({ k_bid: 0.58, k_ask: 0.60 })], nowMs: NOW + 60e3, fetchImpl: mkFetch([{ us: US_B, k: K_B }]), sleep: noSleep });
  check("run: the same leg a minute later is not looked at again", again.seen === 1 && again.looked === 0 && again.skipped["looked at in the last few minutes"] === 1 && writes.length === 1, again);
}
{
  // the sampled cross is not on the real books: Kalshi's bid is really 52
  const { env, writes } = mkEnv();
  const calls = [];
  const out = await runCrossLane(env, { legs: [leg({ k_bid: 0.58, k_ask: 0.60 })], nowMs: NOW, fetchImpl: mkFetch([{ us: US_B, k: kBody([[0.52, 300]], [[0.46, 300]]) }], calls), sleep: noSleep });
  check("run: no cross on the real books = no trade, one read of each book, the real edge and each venue's real offer recorded", out.gone === 1 && out.planned === 0 && writes[0].a[17] === "gone_t0" && writes[0].a[22] < 0 && writes[0].a[29] === null && writes[0].a[34] === 0.51 && writes[0].a[35] === 0.48 && calls.filter(u => /orderbook/.test(u)).length === 1, [out, writes[0] && writes[0].a]);
}
{
  // there at the first read, Kalshi pulled by the second
  const { env, writes } = mkEnv();
  const out = await runCrossLane(env, { legs: [leg({ k_bid: 0.58, k_ask: 0.60 })], nowMs: NOW, fetchImpl: mkFetch([{ us: US_B, k: K_B }, { us: US_B, k: kBody([[0.5, 300]], [[0.48, 300]]) }]), sleep: noSleep });
  check("run: Kalshi gone between the reads = a naked US leg sold back at a loss", out.legged === 1 && writes[0].a[17] === "legged_us" && writes[0].a[29] < 0 && writes[0].a[32] === 0, [out, writes[0] && writes[0].a]);
}
{
  const { env, writes } = mkEnv();
  const out = await runCrossLane(env, { legs: [leg({ k_bid: 0.58, k_ask: 0.60 })], nowMs: NOW, fetchImpl: mkFetch([{ us: null, k: K_B }]), sleep: noSleep });
  check("run: a book that does not answer is a failed read, not a result", out.planned === 0 && writes[0].a[17] === "read_failed" && /Polymarket US/.test(writes[0].a[18]), writes[0] && writes[0].a);
  const off = await runCrossLane(mkEnv({ env: { CROSS_LANE: "off" } }).env, { legs: [leg({ k_bid: 0.58 })], nowMs: NOW, fetchImpl: async () => { throw new Error("no reads when off"); } });
  check("run: off reads nothing; no legs or no cross reads nothing", off.mode === "off" && off.seen === 0 && crossMode({}) === "dry" && crossMode({ CROSS_LANE: "OFF" }) === "off" && (await runCrossLane(mkEnv().env, { legs: [leg()], nowMs: NOW, fetchImpl: async () => { throw new Error("x"); } })).looked === 0);
  const busy = mkEnv({ dbFail: 2 });
  const o2 = await runCrossLane(busy.env, { legs: [leg({ k_bid: 0.58, k_ask: 0.60 })], nowMs: NOW, fetchImpl: mkFetch([{ us: US_B, k: K_B }]), sleep: noSleep, retryMs: 0 });
  check("run: a busy database is retried; one that stays down never throws", busy.writes.length === 1 && !o2.writeError && (await runCrossLane(mkEnv({ dbFail: 9 }).env, { legs: [leg({ k_bid: 0.58, k_ask: 0.60 })], nowMs: NOW, fetchImpl: mkFetch([{ us: US_B, k: K_B }]), sleep: noSleep, retryMs: 0 })).writeError.includes("overloaded"));
}

// ---------- are the legs the same side? ----------
{
  check("hedge: mids close and moving together = the same proposition", hedgeVerdict({ n: 120, gap: 0.015, km: 0.6, um: 0.6, kum: 0.38 }).ok === 1);
  check("hedge: far apart, or moving opposite ways = not a hedge; too few samples = unknown", hedgeVerdict({ n: 120, gap: 0.4, km: 0.7, um: 0.3, kum: 0.19 }).ok === 0 && hedgeVerdict({ n: 120, gap: 0.06, km: 0.5, um: 0.5, kum: 0.24 }).ok === 0 && hedgeVerdict({ n: 4, gap: 0.01 }).ok === null && hedgeVerdict(null).ok === null);
  const updates = [];
  const db = (aggs) => ({ prepare: (sql) => ({ bind: (...a) => ({
    all: async () => ({ results: [{ sport: "nba", game: "A", team: "a1", ts: TS - 2 * 3600 }, { sport: "cfb", game: "Tulsa vs. Tulane", team: "Tulsa", ts: TS - 3 * 3600 }, { sport: "nhl", game: "N", team: "n1", ts: TS - 2 * 3600 }, { sport: "nhl", game: "Old", team: "o1", ts: TS - 9 * 3600 }] }),
    first: async () => aggs[a[0]],
    run: async () => { updates.push(a); return { success: true }; },
  }) }) });
  const r = await checkCrossHedges({ DB: db({ A: { n: 90, gap: 0.02, km: 0.6, um: 0.61, kum: 0.37 }, "Tulsa vs. Tulane": { n: 150, gap: 0.5, km: 0.75, um: 0.25, kum: 0.18 }, N: { n: 3 }, Old: { n: 2 } }) }, NOW);
  check("hedge check: good, mismatched, still waiting, and given up after eight hours", r.checked === 3 && r.ok === 1 && r.bad === 1 && r.unknown === 1 && updates.length === 3 && updates[0][0] === 1 && updates[1][0] === 0 && updates[2][0] === -1, [r, updates]);
  check("hedge check: no database, or one that throws, never throws", (await checkCrossHedges({}, NOW)).checked === 0 && /down/.test((await checkCrossHedges({ DB: { prepare: () => { throw new Error("down"); } } }, NOW)).error));
}

// ---------- the record ----------
{
  const row = (o = {}) => ({ ts: TS, sport: "nba", game: "A", team: "a1", dir: "us_k", verdict: "filled", s_us_px: 0.51, s_k_px: 0.42, real_us_px: 0.51, real_k_px: 0.42, s_edge_c: 3, real_edge_c: 2.5, lock0_c: 2.4, shares: 25, staked_usd: 24, pnl_usd: 0.6, pnl_c: 2.4, lag_s: 4, gap_ms: 300, t2_both: 1, hedge_ok: 1, suspect: 0, ...o });
  const rows = [
    row(), row({ game: "B", pnl_usd: 0.5, pnl_c: 2, t2_both: 0 }), row({ game: "C", sport: "nhl", pnl_usd: 0.7, pnl_c: 2.8, hedge_ok: null }),
    row({ game: "Tulsa vs. Tulane", sport: "cfb", pnl_usd: 9, pnl_c: 36, staked_usd: 16, hedge_ok: 0, suspect: 1 }),
    row({ game: "D", verdict: "legged_us", pnl_usd: -1.1, pnl_c: -4.4, staked_usd: 13, t2_both: 0 }), row({ game: "E", verdict: "legged_kalshi", pnl_usd: null, pnl_c: null }),
    row({ game: "F", verdict: "killed", pnl_usd: 0, pnl_c: 0, staked_usd: 0, t2_both: 0 }),
    row({ game: "G", verdict: "gone_t0", real_k_px: 0.51, pnl_usd: null, pnl_c: null, shares: null, staked_usd: null, lock0_c: null, real_edge_c: -1.5, gap_ms: null, t2_both: null, hedge_ok: null }),
    row({ game: "H", verdict: "read_failed", real_us_px: null, real_k_px: null, pnl_usd: null, shares: null, staked_usd: null, lock0_c: null, real_edge_c: null, gap_ms: null, t2_both: null }),
  ];
  const s = summarizeCrosses(rows);
  check("record: looked, sent and the verdicts", s.looked === 9 && s.sent === 7 && near(s.sentPct, 77.78, 0.02) && s.byVerdict.filled === 4 && s.byVerdict.gone_t0 === 1 && s.killed === 1 && s.suspect === 1, s);
  check("record: a filled pair whose legs were not the same side is left out of the money", s.filled.n === 3 && s.filled.games === 3 && near(s.filled.pnlUsd, 1.8) && near(s.filled.stakedUsd, 72) && s.filled.hedge.ok === 2 && s.filled.hedge.mismatched === 1 && s.filled.hedge.unchecked === 1 && near(s.filled.avgLockC, 2.4), s.filled);
  check("record: legged pairs cost money; one that could not be priced is counted", s.legged.n === 2 && s.legged.us === 1 && s.legged.kalshi === 1 && near(s.legged.pnlUsd, -1.1) && s.legged.unpriced === 1);
  check("record: net = filled + legged, per pair sent, each game counted once", near(s.net.pnlUsd, 0.7) && near(s.net.perSentUsd, 0.1) && near(s.net.fillPct, 42.86, 0.02) && near(s.net.leggedPct, 28.57, 0.02) && s.net.games === 7 && typeof s.net.tGames === "number", s.net);
  check("record: sampled edge against the real books; timing; how long a cross lasts", near(s.edge.sampledC, 3) && s.edge.realTopC < 3 && near(s.edge.bookedC, 2.4) && s.timing.avgLagS === 4 && s.timing.avgGapMs === 300 && near(s.timing.stillThereAfterDelayPct, 100 * 4 / 7, 0.02) && s.timing.delayS === 5, [s.edge, s.timing]);
  check("record: by sport, direction, day, game and the recent list", s.bySport.nba.sent === 5 && s.bySport.cfb.filled === 0 && s.byDir.us_k.looked === 9 && Object.keys(s.byDay).length === 1 && s.games.length === 9 && s.games.find(g => g.game === "cfb|Tulsa vs. Tulane").hedgeBad === 1 && s.recent.length === 9 && s.recent[0].verdict && /Nothing is ever sent/.test(s.read) && s.version === 1 && s.since === new Date(TS * 1000).toISOString());
  check("record: which venue's sampled price was off (only rows with both real offers count)", s.drift.n === 8 && s.drift.usC === 0 && near(s.drift.kalshiC, 9 / 8, 0.02) && s.recent.find(r => r.game === "G").realK === 0.51 && /drift/.test(s.read), s.drift);
  const empty = summarizeCrosses([]);
  check("record: empty is empty", empty.looked === 0 && empty.sent === 0 && empty.since === null && empty.filled.n === 0 && empty.net.pnlUsd === 0 && empty.net.tGames === null && empty.edge.sampledC === null);
  const kv = new Map([["cross_last", JSON.stringify({ at: "x" })], ["cross_state", JSON.stringify({ day: "2026-11-16", games: { a: 2, b: 1 }, last: {} })]]);
  const env = { CROSS_LANE: "dry", SIGNALS_CACHE: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null) }, DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } };
  const rep = await crossReport(env, { hours: 168, nowMs: NOW });
  check("report: the record with the lane's mode, last run and today's counts", rep.success && rep.mode === "dry" && rep.looked === 9 && rep.last.at === "x" && rep.today.games === 2 && rep.today.looks === 3 && rep.readError === null);
}

// ---------- how much size was there (an observation beside the rule) ----------
{
  const { ROOM_CAP_SHARES, CROSS_SCHEMA } = await import("../src/cross-lane.js");
  // 100 shares cross at 40c + 50c; the next US level (47c) no longer locks a cent
  const usLv = [{ price: 0.40, size: 100 }, { price: 0.47, size: 300 }];
  const kLv = [{ price: 0.50, size: 150 }, { price: 0.60, size: 999 }];
  const capped = planCross(usLv, kLv, { maxShares: 27, minLockC: 1, minShares: 5 });
  const room = planCross(usLv, kLv, { maxShares: ROOM_CAP_SHARES, minLockC: 1, minShares: 0 });
  check("room: the pair sent is still the stake's size; the uncapped walk says what was there", capped.ok === true && capped.shares === 27 && room.offered === 100, { capped, room });
  check("room: the walks never change the books they were given", usLv[0].size === 100 && kLv[0].size === 150);
  const none = planCross([{ price: 0.60, size: 100 }], [{ price: 0.50, size: 100 }], { maxShares: ROOM_CAP_SHARES, minLockC: 1, minShares: 1 });
  check("room: nothing crossing is zero room, not an error", none.ok === false && none.offered === 0, none);
  {
    // a look that finds no cross on the real books stores room 0 (the 37th value)
    const { env, writes } = mkEnv();
    await runCrossLane(env, { legs: [leg({ k_bid: 0.58, k_ask: 0.60 })], nowMs: NOW, fetchImpl: mkFetch([{ us: usBody([[0.5, 600]], [[0.56, 700]]), k: K_B }]), sleep: noSleep, clock: () => NOW + 4000 });
    check("room: a gone cross is stored with room 0", writes.length === 1 && writes[0].a[17] === "gone_t0" && writes[0].a[36] === 0, writes[0] && [writes[0].a[17], writes[0].a[36]]);
  }
  const TS2 = 1795300000;
  const r = (o = {}) => ({ ts: TS2, sport: "cfb", game: "A", team: "a1", dir: "us_k", verdict: "filled", s_us_px: 0.5, s_k_px: 0.4, shares: 25, staked_usd: 24, pnl_usd: 0.5, pnl_c: 2, hedge_ok: 1, ...o });
  const sum = summarizeCrosses([
    r({ room_shares: 40 }), r({ game: "B", verdict: "legged_kalshi", pnl_usd: -1, room_shares: 26 }), r({ game: "C", verdict: "killed", pnl_usd: 0, room_shares: 300 }),
    r({ game: "D", room_shares: null }),                                          // a row from before the column
    r({ game: "E", verdict: "thin_t0", shares: null, pnl_usd: null, room_shares: 0.5 }),   // not sent: not counted
  ]);
  check("room: over the pairs sent, in shares and dollars", sum.room.n === 3 && sum.room.medShares === 40 && sum.room.maxShares === 300 && sum.room.medUsd === 36 && sum.room.maxUsd === 270 && sum.room.capShares === ROOM_CAP_SHARES, sum.room);
  check("room: each recent row carries it; an old row carries null", sum.recent.find(x => x.game === "C").roomShares === 300 && sum.recent.find(x => x.game === "D").roomShares === null);
  check("room: no rows, no numbers", summarizeCrosses([]).room.n === 0 && summarizeCrosses([]).room.medShares === null);
  // a deploy whose schema pass missed the new column: the write applies the table's schema and goes through
  {
    const kv = new Map(), ran = [], wrote = [];
    let fails = 1;
    const env = {
      SIGNALS_CACHE: { get: async (k, opt) => { const v = kv.get(k); return v == null ? null : opt && opt.type === "json" ? JSON.parse(v) : v; }, put: async (k, v) => { kv.set(k, v); } },
      DB: {
        prepare: (sql) => ({ run: async () => { ran.push(sql); return { success: true }; }, bind: (...a) => ({ sql, a }) }),
        batch: async (stmts) => { if (fails-- > 0) throw new Error("D1_ERROR: table cross_events has no column named room_shares"); wrote.push(...stmts); return []; },
      },
    };
    const out = await runCrossLane(env, { legs: [leg({ k_bid: 0.58, k_ask: 0.60 })], nowMs: NOW, fetchImpl: mkFetch([{ us: US_B, k: K_B }]), sleep: noSleep, clock: () => NOW + 4000 });
    check("room: a missing column is added by the write itself and the row is kept", out.schemaHealed === true && !out.writeError && wrote.length === 1 && ran.some(q => /ADD COLUMN room_shares/.test(q)) && ran.some(q => /CREATE TABLE IF NOT EXISTS cross_events/.test(q)), { out, ran: ran.length, wrote: wrote.length });
  }
  check("room: the column is in the schema and the rule's version is untouched", CROSS_SCHEMA.some(q => /ADD COLUMN room_shares REAL/.test(q)) && CROSS.version === 1 && CROSS.stakeUsd === 25);
}

console.log(`cross-lane: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

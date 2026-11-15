// The investigator's test lane (src/investigator-lane.js): the bet a live bot would place.
import { LANE, asksOf, bestBidOf, walkAsks, laneSide, laneDecision, recordLaneBet, sweepPool, interleaveByKind, pickFresh, laneReport } from "../src/investigator-lane.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const near = (a, b, e = 0.006) => Math.abs(a - b) < e;
const NOW = Date.parse("2026-11-15T12:00:00Z");
const book = (asks, bids = [[0.3, 100]]) => ({ asks: asks.map(([price, size]) => ({ price: String(price), size: String(size) })), bids: bids.map(([price, size]) => ({ price: String(price), size: String(size) })) });
const inv = (o = {}) => ({ agentProb: 0.65, marketProb: 0.40, edgePts: 25, confidence: "MEDIUM", title: "Will the Fed cut rates on Tuesday?", slug: "will-the-fed-cut-rates", eventDate: "2026-11-16T18:00:00Z", source: "sweep", ...o });
const mk = (o = {}) => ({ outcomes: ["Yes", "No"], tokens: ["tok-yes", "tok-no"], winIndex: 0, ...o });

// ---------- the book ----------
{
  const b = book([[0.44, 50], [0.42, 20], [0.41, 10], [1.2, 5], [0.5, 0]], [[0.39, 10], [0.4, 5]]);
  check("asks: cheapest first, junk dropped; best bid", JSON.stringify(asksOf(b)) === "[[0.41,10],[0.42,20],[0.44,50]]" && bestBidOf(b) === 0.4 && asksOf(null).length === 0 && bestBidOf({}) === null);
  const w = walkAsks(asksOf(b), 25);                       // 10 @ 41 = 4.10, 20 @ 42 = 8.40, then 12.50 at 44 = 28.41 shares
  check("walk: $25 takes the 41c and 42c levels and part of 44c", near(w.usd, 25) && near(w.shares, 10 + 20 + 12.5 / 0.44, 0.01) && w.worstPx === 0.44 && w.avgPx > 0.42 && w.avgPx < 0.44, w);
  const lim = walkAsks(asksOf(b), 25, 0.42);                // only what is offered at 42c or better: $12.50
  check("walk with a limit: only the levels at or under it (a partial fill)", near(lim.usd, 12.5) && near(lim.shares, 30) && lim.worstPx === 0.42 && near(lim.avgPx, 12.5 / 30, 0.0002), lim);
  check("walk: nothing under the limit, or an empty book, is no fill", walkAsks(asksOf(b), 25, 0.40).usd === 0 && walkAsks([], 25).usd === 0);
}

// ---------- which side ----------
{
  check("side: a positive edge backs the direction's own contract", JSON.stringify(laneSide(inv(), mk())) === JSON.stringify({ side: "with", outcome: "Yes", tokenId: "tok-yes" }));
  check("side: a negative edge backs the other contract of a two-outcome market", JSON.stringify(laneSide(inv({ edgePts: -25 }), mk())) === JSON.stringify({ side: "against", outcome: "No", tokenId: "tok-no" }));
  check("side: the direction can be the second outcome", laneSide(inv(), mk({ winIndex: 1 })).tokenId === "tok-no" && laneSide(inv({ edgePts: -30 }), mk({ winIndex: 1 })).tokenId === "tok-yes");
  check("side: no edge, no outcome index -> nothing; against on a 3-way has no single contract", laneSide(inv({ edgePts: 0 }), mk()) === null && laneSide(inv(), mk({ winIndex: -1 })) === null && laneSide(inv({ edgePts: -25 }), mk({ outcomes: ["A", "B", "C"], tokens: ["a", "b", "c"] })).tokenId === null);
}

// ---------- the decision ----------
{
  // agent 65% vs shown 40%: the limit is 45c. The book offers 30 contracts at 41c and plenty at 47c.
  const d = laneDecision(inv(), mk(), book([[0.41, 30], [0.47, 500]]), { nowMs: NOW, startedMs: NOW - 90e3, feeSchedule: { rate: 0.05, exponent: 1 } });
  check("decision: the bet is what is offered under the limit (30 at 41c = $12.30, partial), not the whole stake at any price", d.rule === 1 && d.why === "bet" && d.side === "with" && d.limitPx === 0.45 && near(d.fillUsd, 12.3) && near(d.shares, 30) && d.fillPx === 0.41 && d.edgeFillPts === 24 && d.lagS === 90 && d.horizonH === 30, d);
  check("decision: fees at Polymarket's schedule and at Kalshi's rate", near(d.feePolyUsd, 30 * 0.05 * 0.41 * 0.59, 0.006) && near(d.feeKUsd, 30 * 0.07 * 0.41 * 0.59, 0.006), [d.feePolyUsd, d.feeKUsd]);
  check("decision: ask_px is the whole stake at the real offer, kept for other thresholds", d.askPx > 0.41 && d.askPx < 0.47 && d.bestAsk === 0.41 && d.bestBid === 0.3 && d.agentP === 0.65 && d.shownP === 0.4, d);
  // the price ran while it researched: the cheapest offer is now 50c, over the 45c limit
  const gone = laneDecision(inv(), mk(), book([[0.5, 500]]), { nowMs: NOW });
  check("decision: the price moved past the limit -> no bet, named", gone.rule === 0 && /under 20 points at the real offer/.test(gone.why) && gone.fillUsd === 0 && gone.fillPx === null && gone.askPx === 0.5, gone);
  const against = laneDecision(inv({ agentProb: 0.30, marketProb: 0.60, edgePts: -30 }), mk(), book([[0.42, 100]]), { nowMs: NOW });
  check("decision: backing the other side buys its contract (agent 70% for No, limit 50c, filled at 42c)", against.rule === 1 && against.side === "against" && against.outcome === "No" && against.tokenId === "tok-no" && against.agentP === 0.7 && against.shownP === 0.4 && against.limitPx === 0.5 && near(against.fillUsd, 25) && against.edgeFillPts === 28, against);
  const b = book([[0.41, 500]]);
  const why = (o, m = mk(), bk = b) => laneDecision(inv(o), m, bk, { nowMs: NOW }).why;
  check("decision: each rule names its failure", /weather is left out/.test(why({ title: "Will the highest temperature in Seoul be 16°C?" })) && why({ confidence: "LOW" }) === "low confidence" && why({ eventDate: null }) === "no settlement date" && why({ eventDate: "2026-11-15T11:00:00Z" }) === "already past its end" && /more than 72h out/.test(why({ eventDate: "2026-11-20T00:00:00Z" })) && /disagreement under 20 points/.test(why({ agentProb: 0.55, edgePts: 15 })) && why({}, mk(), null) === "no offers in the order book" && why({ edgePts: 0 }) === "no disagreement to bet");
  check("decision: a failed rule records the book but no fill", (() => { const x = laneDecision(inv({ confidence: "LOW" }), mk(), b, { nowMs: NOW }); return x.rule === 0 && x.fillUsd === 0 && x.fillPx === null && x.bestAsk === 0.41 && x.askPx === 0.41; })());
  check("decision: under $5 offered at the limit is no bet", laneDecision(inv(), mk(), book([[0.41, 10], [0.6, 500]]), { nowMs: NOW }).rule === 0);
}

// ---------- recording ----------
{
  const writes = [];
  const env = { DB: { prepare: (sql) => ({ bind: (...a) => ({ run: async () => { writes.push({ sql, a }); return { success: true }; } }) }) } };
  const rec = { status: "done", invKey: "investigation:will-the-fed-cut-rates::Yes", marketSlug: "will-the-fed-cut-rates", marketTitle: "Will the Fed cut rates on Tuesday?", agentProb: 0.65, marketProbAtInvestigation: 0.40, edgePts: 25, confidence: "MEDIUM", eventDate: "2026-11-16T18:00:00Z", source: "sweep" };
  const urls = [];
  const fetchImpl = async (u) => { urls.push(String(u)); return { ok: true, json: async () => book([[0.41, 200]]) }; };
  const row = await recordLaneBet(env, rec, { market: { outcomes: "[\"Yes\", \"No\"]", clobTokenIds: "[\"tok-yes\", \"tok-no\"]", feeSchedule: { rate: 0.07, exponent: 1 } }, baseline: { winIndex: 0 }, startedMs: NOW - 60e3, fetchImpl, nowMs: NOW });
  check("record: reads the backed side's book and stores the bet", row.rule === 1 && urls.length === 1 && /book\?token_id=tok-yes$/.test(urls[0]) && writes.length === 1 && writes[0].a[0] === rec.invKey && writes[0].a[25] === 1 && writes[0].a[16] === 0.41 && writes[0].a.length === 29, { row, n: writes[0] && writes[0].a.length });
  check("record: an unfinished investigation, or no database, records nothing", (await recordLaneBet(env, { ...rec, status: "error_transient" }, {})) === null && (await recordLaneBet({}, rec, {})) === null);
  const boom = await recordLaneBet({ DB: { prepare: () => { throw new Error("d1 down"); } } }, rec, { market: {}, baseline: { winIndex: 0 }, fetchImpl, nowMs: NOW, retryMs: 0 });
  check("record: a database failure never throws", boom && /d1 down/.test(boom.error));
  // D1 answers "overloaded" once, then takes the write
  let calls = 0; const w2 = [];
  const busy = { DB: { prepare: () => ({ bind: (...a) => ({ run: async () => { calls++; if (calls === 1) throw new Error("D1_ERROR: D1 DB is overloaded."); w2.push(a); return { success: true }; } }) }) } };
  const again = await recordLaneBet(busy, rec, { market: { outcomes: ["Yes", "No"], clobTokenIds: ["tok-yes", "tok-no"] }, baseline: { winIndex: 0 }, fetchImpl, nowMs: NOW, retryMs: 0 });
  check("record: a busy database gets another try and the bet is stored", again.rule === 1 && calls === 2 && w2.length === 1, { calls, again });
}

// ---------- what the sweep researches ----------
{
  const g = (o = {}) => ({ slug: "will-the-fed-cut-rates", question: "Will the Fed cut rates on Tuesday?", description: "Resolves Yes if...", outcomes: "[\"Yes\", \"No\"]", outcomePrices: "[\"0.40\", \"0.60\"]", endDate: "2026-11-16T18:00:00Z", bestBid: 0.39, bestAsk: 0.41, acceptingOrders: true, volume24hr: 1000, ...o });
  const pool = sweepPool([
    g(),
    g({ slug: "temp-seoul", question: "Will the highest temperature in Seoul be 16°C on November 16?" }),          // weather
    g({ slug: "far", endDate: "2026-11-25T00:00:00Z" }),                                                              // too far out
    g({ slug: "soon", endDate: "2026-11-15T12:30:00Z" }),                                                             // ends within the hour
    g({ slug: "sure", outcomePrices: "[\"0.97\", \"0.03\"]" }),                                                    // decided
    g({ slug: "wide", bestBid: 0.30, bestAsk: 0.45 }),                                                                // no real book
    g({ slug: "onesided", bestBid: null }),
    g({ slug: "team", outcomes: "[\"Lakers\", \"Celtics\"]" }),                                                    // not Yes/No
    g({ slug: "nodesc", description: "" }),
    g({ slug: "blocked", question: "Dota 2: A vs B" }),
    g({ slug: "btc-above-66k", question: "Will the price of Bitcoin be above $66,000 on November 16?", volume24hr: 9000 }),
  ], { nowMs: NOW, investigable: (s) => !/dota/i.test(s.marketTitle) });
  check("pool: only what the rule can bet", pool.length === 2 && pool.map(p => p.marketSlug).sort().join() === "btc-above-66k,will-the-fed-cut-rates" && pool[0].directionRaw === "Yes" && pool.find(p => p.marketSlug === "btc-above-66k").kind === "crypto", pool.map(p => p.marketSlug));
  const c = (kind, slug, vol24) => ({ kind, marketSlug: slug, directionRaw: "Yes", cluster: slug.replace(/-\d+$/, ""), vol24 });
  const order = interleaveByKind([c("crypto", "btc-1", 900), c("crypto", "btc-2", 800), c("crypto", "btc-3", 700), c("politics", "vote-1", 100), c("social", "tweets-1", 50), c("politics", "vote-2", 60)]).map(x => x.marketSlug);
  check("order: kinds in turn, the busiest of each first", order.join() === "btc-1,vote-1,tweets-1,btc-2,vote-2,btc-3", order);
  const p2 = [c("crypto", "btc-1", 9), c("crypto", "btc-2", 8), c("crypto", "btc-3", 7), c("politics", "vote-1", 6), c("social", "tweets-1", 5)];
  const fresh = pickFresh(p2, { doneKeys: new Set(["investigation:vote-1::Yes"]), eventCounts: { btc: 1 }, limit: 3, perEvent: 2 }).map(x => x.marketSlug);
  check("pick: skips what is done, at most two of one event a day (one was researched already)", fresh.join() === "btc-1,tweets-1", fresh);
  check("pick: the limit holds", pickFresh(p2, { limit: 1 }).length === 1 && pickFresh([], { limit: 3 }).length === 0);
}

// ---------- the report ----------
{
  const bet = (k, o = {}) => ({ inv_key: k, ts: Math.floor(NOW / 1000) - 3600, version: LANE.version, market_slug: k, title: `Q ${k}`, kind: "politics", cluster: k, side: "with", outcome: "Yes", agent_p: 0.65, shown_p: 0.40, best_ask: 0.41, ask_px: 0.41, limit_px: 0.45, fill_px: 0.40, fill_usd: 20, shares: 50, fee_poly_usd: 0.5, fee_k_usd: 0.84, edge_fill_pts: 25, horizon_h: 30, confidence: "MEDIUM", source: "sweep", rule: 1, why: "bet", lag_s: 80, event_date: "2026-11-16T18:00:00Z", ...o });
  const bets = [
    bet("alpha"), bet("bravo"), bet("charlie"),                                             // two win, one loses (outcomes below)
    bet("delta", { side: "against", outcome: "No" }),                                       // backs No: wins when y = 0
    bet("echo"),                                                                            // still open
    bet("foxtrot", { rule: 0, why: "under 20 points at the real offer", fill_px: null, fill_usd: 0, shares: 0, fee_k_usd: 0, fee_poly_usd: 0, ask_px: 0.5, agent_p: 0.62 }),
    bet("golf", { rule: 0, why: "low confidence", confidence: "LOW", fill_px: null, fill_usd: 0, shares: 0 }),
    bet("old", { version: 0 }),                                                             // an earlier rule version: left out
  ];
  const outcomes = new Map([["alpha", { y: 1 }], ["bravo", { y: 1 }], ["charlie", { y: 0 }], ["delta", { y: 0 }], ["foxtrot", { y: 1 }], ["golf", { y: 1 }], ["old", { y: 1 }]]);
  const rep = laneReport(bets, outcomes, { nowMs: NOW });
  check("report: counts (this version only)", rep.researched === 7 && rep.bets === 5 && rep.open === 1 && rep.settled.n === 4 && rep.whyNot["low confidence"] === 1 && rep.whyNot["under 20 points at the real offer"] === 1, rep);
  // 3 wins x (50 - 20) = +90, 1 loss = -20 -> +70 on $80 before fees; Kalshi fees 4 x 0.84 = 3.36
  check("report: P&L from the real fills, before fees and after each fee", rep.settled.wins === 3 && rep.settled.hitPct === 75 && rep.settled.breakEvenPct === 40 && rep.settled.stakedUsd === 80 && rep.settled.beforeFees.pnlUsd === 70 && near(rep.settled.kalshiFees.pnlUsd, 66.64) && near(rep.settled.polymarketFees.pnlUsd, 68) && near(rep.settled.kalshiFees.roiPct, 83.3, 0.06), rep.settled);
  check("report: the against bet won on y = 0; open and settled lists", rep.recentSettled.length === 4 && rep.recentSettled.find(r => r.backs === "No").won === true && rep.openBets.length === 1 && rep.openBets[0].title === "Q echo" && rep.openBets[0].pnlUsd === null);
  check("report: paid against shown, research time, by kind", rep.fill && rep.fill.avgPaidOverShownC === 0 && rep.fill.avgResearchS === 80 && rep.fill.partial === 5 && rep.byKind.politics.n === 4);
  // atEdge: every settled, non-LOW question at its ask_px: alpha/bravo/charlie/delta at 41c (24 pts), foxtrot at 50c (12 pts)
  check("report: the rule at other sizes on the real offer (foxtrot only counts at 10+ points)", rep.atEdge["10+"].n === 5 && rep.atEdge["20+"].n === 4 && rep.atEdge["30+"].n === 0 && rep.atEdge["20+"].hitPct === 75, rep.atEdge);
  check("report: the rule and the read text", /20\+ points above the price actually paid/.test(rep.rule) && /Paper only/.test(rep.rule) && rep.version === LANE.version && /Kalshi/.test(rep.read) && rep.perDay && rep.since);
  const empty = laneReport([], new Map(), { nowMs: NOW });
  check("report: empty", empty.researched === 0 && empty.bets === 0 && empty.settled.n === 0 && empty.since === null);
}
console.log(`investigator-lane: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

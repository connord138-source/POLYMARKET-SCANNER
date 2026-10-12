// Cross-venue sampler. Run with: node test/xvenue.test.mjs
import { teamMatch, matchPairs, attachUs, isLive, analyzeSeries, sampleXvenue, xvenueReport, kalshiFee, usFee, XV_LIVE_BEFORE_MS, XV_LIVE_AFTER_MS } from "../src/xvenue.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };

check("team: city -> nickname (nfl)", teamMatch("nfl", "Buffalo", "Bills") && teamMatch("nfl", "Los Angeles", "Rams") && teamMatch("nfl", "Los Angeles", "Chargers") && !teamMatch("nfl", "Buffalo", "Rams"));
check("team: city -> full name (mlb) and 'wins' suffix", teamMatch("mlb", "Cleveland wins", "Cleveland Guardians") && teamMatch("nhl", "Calgary", "Calgary Flames") && !teamMatch("mlb", "Cleveland", "Tampa Bay Rays"));
check("team: college exact / abbreviation", teamMatch("cfb", "Kansas State", "Kansas State") && teamMatch("cfb", "Kansas St", "Kansas State") && !teamMatch("cfb", "Kansas", "Kansas State"));
check("team: accents and punctuation", teamMatch("cfb", "Hawai'i", "Hawaii") && teamMatch("nfl", "San Francisco", "49ers"));

const K = (evt, team, exp, bid, ask) => ({ ticker: `${evt}-${team.slice(0, 3).toUpperCase()}`, event_ticker: evt, title: `${team} wins`, yes_sub_title: team, expected_expiration_time: exp, yes_bid_dollars: bid, yes_ask_dollars: ask });
const P = (q, outs, start, toks = ["t0", "t1"], extra = {}) => ({ question: q, outcomes: JSON.stringify(outs), clobTokenIds: JSON.stringify(toks), gameStartTime: start, sportsMarketType: "moneyline", feeSchedule: { rate: 0.03 }, ...extra });
{
  const kal = [K("KXNFLGAME-26OCT13BUFLA", "Buffalo", "2026-10-13T04:00:00Z", "0.38", "0.39"), K("KXNFLGAME-26OCT13BUFLA", "Los Angeles", "2026-10-13T04:00:00Z", "0.61", "0.62"),
    K("KXNFLGAME-26OCT19WASSF", "Washington", "2026-10-20T04:00:00Z", "0.3", "0.31"), K("KXNFLGAME-26OCT19WASSF", "San Francisco", "2026-10-20T04:00:00Z", "0.69", "0.7")];
  const poly = [P("Bills vs. Rams", ["Bills", "Rams"], "2026-10-13T00:15:00Z"), P("Chargers vs. Dolphins", ["Chargers", "Dolphins"], "2026-10-13T00:15:00Z", ["t2", "t3"]),
    P("Commanders vs. 49ers", ["Commanders", "49ers"], "2026-10-19T20:25:00Z", ["t4", "t5"]), P("Bills vs. Rams spread", ["Bills", "Rams"], "2026-10-13T00:15:00Z", ["t6", "t7"], { sportsMarketType: "spreads" })];
  const pairs = matchPairs("nfl", kal, poly, Date.parse("2026-10-12T06:00:00Z"));
  check("match: both games, legs mapped to the right tokens, opponent disambiguates LA", pairs.length === 2 && pairs[0].legs[0].team === "Bills" && pairs[0].legs[0].pToken === "t0" && pairs[0].legs[1].team === "Rams" && pairs[0].legs[1].pToken === "t1" && pairs[0].legs[1].kTicker === "KXNFLGAME-26OCT13BUFLA-LOS" && pairs[1].legs[1].pToken === "t5" && pairs[0].feeRate === 0.03, JSON.stringify(pairs));
  check("match: a swapped outcome order maps correctly", matchPairs("nfl", kal.slice(0, 2), [P("Rams vs. Bills", ["Rams", "Bills"], "2026-10-13T00:15:00Z", ["a", "b"])])[0].legs[0].pToken === "b");
  check("match: start time too far apart -> no pair", matchPairs("nfl", kal.slice(0, 2), [P("Bills vs. Rams", ["Bills", "Rams"], "2026-10-20T00:15:00Z")]).length === 0);
  const p0 = pairs[0];
  check("live window", !isLive(p0, p0.startMs - XV_LIVE_BEFORE_MS - 1) && isLive(p0, p0.startMs - 60e3) && isLive(p0, p0.startMs + 2 * 3600e3) && !isLive(p0, p0.startMs + XV_LIVE_AFTER_MS + 1));
  const n = attachUs("nfl", pairs, [{ slug: "aec-nfl-lar-buf-2026-10-12", startMs: Date.parse("2026-10-13T00:15:00Z"), teams: ["Los Angeles Rams", "Buffalo Bills"] }, { slug: "aec-nfl-x", startMs: Date.parse("2026-10-20T00:00:00Z"), teams: ["Miami Dolphins", "Buffalo Bills"] }]);
  check("attachUs: US market attached with the long side mapped to the right leg", n === 1 && pairs[0].usSlug === "aec-nfl-lar-buf-2026-10-12" && pairs[0].usLongIdx === 1 && pairs[1].usSlug === undefined, JSON.stringify(pairs.map(p => [p.usSlug, p.usLongIdx])));
}
{
  check("kalshi fee", Math.abs(kalshiFee(0.5) - 0.0175) < 1e-9);
  // Polymarket jumps +5c at t=120 while Kalshi sits still (stale), then Kalshi catches up at t=180.
  const rows = [
    { ts: 0, k_bid: 0.40, k_ask: 0.42, p_bid: 0.40, p_ask: 0.41 },
    { ts: 60, k_bid: 0.40, k_ask: 0.42, p_bid: 0.40, p_ask: 0.41 },
    { ts: 120, k_bid: 0.40, k_ask: 0.42, p_bid: 0.45, p_ask: 0.46 },
    { ts: 180, k_bid: 0.45, k_ask: 0.47, p_bid: 0.45, p_ask: 0.46 },
    { ts: 240, k_bid: 0.45, k_ask: 0.47, p_bid: 0.45, p_ask: 0.46 },
    { ts: 300, k_bid: 0.41, k_ask: 0.43, p_bid: 0.45, p_ask: 0.46 },   // Kalshi drops first ...
    { ts: 360, k_bid: 0.41, k_ask: 0.43, p_bid: 0.41, p_ask: 0.42 },   // ... Polymarket follows
  ];
  const a = analyzeSeries(rows, { moveC: 3 });
  // stale edge at t=120: p_bid 0.45 - k_ask 0.42 - fee(0.42)=0.017052 -> 0.012948
  check("analyze: one poly move, Kalshi stale with ~1.3c edge, caught up next minute", a.polyMoves === 2 && a.staleKalshi === 1 && Math.abs(a.staleEdgeC - 1.2948) < 0.01 && a.kalshiSameMin === 0 && a.kalshiNextMin === 1, JSON.stringify(a));
  check("analyze: Kalshi-led move counted", a.kalshiLeads === 1 && a.samples === 7 && a.bothQuoted === 7, JSON.stringify(a));
  const gap = analyzeSeries([{ ts: 0, k_bid: 0.40, k_ask: 0.42, p_bid: 0.40, p_ask: 0.41 }, { ts: 900, k_bid: 0.40, k_ask: 0.42, p_bid: 0.50, p_ask: 0.51 }]);
  check("analyze: a 15-minute gap between samples is not a 'move'", gap.polyMoves === 0);
  check("analyze: missing quotes are skipped", analyzeSeries([{ ts: 0, k_bid: null, k_ask: null, p_bid: 0.4, p_ask: 0.41 }]).bothQuoted === 0);
  check("us fee", Math.abs(usFee(0.5) - 0.017375) < 1e-9);
  // Polymarket US sits still through the same +5c move; and at t=0 Kalshi bid 0.48 vs US ask 0.40 clears both fees
  const us = analyzeSeries([
    { ts: 0, k_bid: 0.48, k_ask: 0.50, p_bid: 0.40, p_ask: 0.41, us_bid: 0.39, us_ask: 0.40 },
    { ts: 60, k_bid: 0.40, k_ask: 0.42, p_bid: 0.45, p_ask: 0.46, us_bid: 0.39, us_ask: 0.40 },
  ], { moveC: 3 });
  // t=60: p_bid 0.45 - us_ask 0.40 - usFee(0.40)=0.01668 -> 0.03332 ; t=0: k_bid 0.48 - us_ask 0.40 - kFee(0.48)=0.017472 - usFee(0.40)=0.01668 -> 0.045848
  check("analyze: US stale edge and a Kalshi<->US crossing counted", us.usQuoted === 2 && us.staleUs === 1 && Math.abs(us.staleUsEdgeC - 3.332) < 0.01 && us.kUsCross === 1 && Math.abs(us.kUsCrossEdgeC - 4.5848) < 0.01 && Math.abs(us.usSpreadSumC - 2) < 1e-9, JSON.stringify(us));
}
{
  // end-to-end sample with mocked Kalshi, Gamma, CLOB, KV and D1
  const kv = new Map(); const rows = []; let kalshiCalls = 0;
  const env = {
    SIGNALS_CACHE: { get: async (k) => { const v = kv.get(k); return v === undefined ? null : JSON.parse(v); }, put: async (k, v) => { kv.set(k, v); } },
    DB: { prepare: (sql) => ({ bind: (...a) => ({ sql, a, run: async () => {} }), run: async () => {} }), batch: async (st) => { rows.push(...st); } },
  };
  const now = Date.parse("2026-10-13T00:30:00Z");   // Bills-Rams kicked off 15 min ago
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("kalshi") && u.includes("series_ticker=KXNFLGAME")) { kalshiCalls++; return { ok: true, json: async () => ({ markets: [K("KXNFLGAME-26OCT13BUFLA", "Buffalo", "2026-10-13T04:00:00Z", "0.38", "0.39"), K("KXNFLGAME-26OCT13BUFLA", "Los Angeles", "2026-10-13T04:00:00Z", "0.61", "0.62")] }) }; }
    if (u.includes("kalshi") && u.includes("series_ticker=")) { kalshiCalls++; return { ok: true, json: async () => ({ markets: [] }) }; }
    if (u.includes("kalshi") && u.includes("tickers=")) return { ok: true, json: async () => ({ markets: [{ ticker: "KXNFLGAME-26OCT13BUFLA-BUF", yes_bid_dollars: "0.3700", yes_ask_dollars: "0.3900", last_price_dollars: "0.3800" }, { ticker: "KXNFLGAME-26OCT13BUFLA-LOS", yes_bid_dollars: "0.6100", yes_ask_dollars: "0.6300" }] }) };
    if (u.includes("gamma-api") && u.includes("tag_slug=nfl")) return { ok: true, json: async () => [{ title: "Bills vs. Rams", markets: [P("Bills vs. Rams", ["Bills", "Rams"], "2026-10-13T00:15:00Z")] }] };
    if (u.includes("gateway.polymarket.us/v2/leagues/nfl/events")) return { ok: true, json: async () => ({ events: [{ title: "BUF Bills vs. LA Rams", startDate: "2026-10-13T00:15:00Z", closed: false, markets: [{ slug: "aec-nfl-buf-lar-2026-10-12", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE", marketSides: [{ description: "Rams", long: false, team: { name: "Los Angeles Rams" } }, { description: "Bills", long: true, team: { name: "Buffalo Bills" } }] }] }] }) };
    if (u.includes("gateway.polymarket.us/v2/leagues/")) return { ok: true, json: async () => ({ events: [] }) };
    if (u.includes("gateway.polymarket.us/v1/markets/aec-nfl-buf-lar-2026-10-12/bbo")) return { ok: true, json: async () => ({ marketData: { bestBid: { value: "0.3800" }, bestAsk: { value: "0.3825" }, lastTradePx: { value: "0.3810" } } }) };
    if (u.includes("gamma-api")) return { ok: true, json: async () => [] };
    if (u.endsWith("/books") && opts && opts.method === "POST") return { ok: true, json: async () => [{ asset_id: "t0", bids: [{ price: "0.38", size: "100" }], asks: [{ price: "0.39", size: "50" }], last_trade_price: "0.39" }, { asset_id: "t1", bids: [{ price: "0.61", size: "10" }], asks: [{ price: "0.62", size: "10" }] }] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const s1 = await sampleXvenue(env, now);
  check("sample: pairs built, one live game, two rows, correct columns", s1.pairs === 1 && s1.live === 1 && s1.rows === 2 && rows[0].a[0] === Math.floor(now / 1000) && rows[0].a[3] === "Bills" && rows[0].a[4] === "live" && rows[0].a[6] === 0.37 && rows[0].a[7] === 0.39 && rows[0].a[10] === 0.38 && rows[0].a[11] === 0.39 && rows[0].a[13] === 0.03, JSON.stringify({ s1, row: rows[0] && rows[0].a }));
  check("sample: Polymarket US quotes on the long leg and complemented on the other", s1.usQuoted === 1 && rows[0].a[14] === 0.38 && rows[0].a[15] === 0.3825 && rows[0].a[16] === 0.381 && rows[1].a[3] === "Rams" && rows[1].a[14] === 0.6175 && rows[1].a[15] === 0.62 && rows[1].a[16] === 0.619, JSON.stringify([rows[0].a.slice(14), rows[1].a.slice(14)]));
  check("sample: stage marker reaches done", kv.has("xv_boot") && JSON.parse(kv.get("xv_boot")).stage === "done");
  const callsAfterBuild = kalshiCalls;
  const s2 = await sampleXvenue(env, now + 60e3);
  check("sample: second minute reuses the cached pairs (no Kalshi series calls)", kalshiCalls === callsAfterBuild && s2.rows === 2 && rows.length === 4);
  const s3 = await sampleXvenue(env, now + 6 * 3600e3);
  check("sample: nothing live -> no rows, status still written", s3.live === 0 && s3.rows === 0 && rows.length === 4 && kv.has("xv_last"));
  env.DB.prepare = () => ({ bind: () => ({ all: async () => ({ results: [{ ts: 0, sport: "nfl", game: "g", team: "Bills", k_bid: 0.4, k_ask: 0.42, p_bid: 0.4, p_ask: 0.41, us_bid: 0.39, us_ask: 0.40 }, { ts: 60, sport: "nfl", game: "g", team: "Bills", k_bid: 0.4, k_ask: 0.42, p_bid: 0.45, p_ask: 0.46, us_bid: 0.39, us_ask: 0.40 }] }) }) });
  const rep = await xvenueReport(env, { hours: 1 });
  check("report: per-sport aggregates incl. US", rep.rows === 2 && rep.legs === 1 && rep.bySport.nfl.polyMoves === 1 && rep.bySport.nfl.staleKalshi === 1 && rep.bySport.nfl.staleRate === 1 && rep.bySport.nfl.avgKalshiSpreadC === 2 && rep.bySport.nfl.staleUs === 1 && rep.bySport.nfl.avgUsSpreadC === 1 && rep.bySport.nfl.kUsCross === 0 && rep.last && rep.last.live === 0 && rep.boot && rep.boot.stage === "done", JSON.stringify(rep.bySport));
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

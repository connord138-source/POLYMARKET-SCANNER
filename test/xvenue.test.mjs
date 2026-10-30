// Cross-venue sampler. Run with: node test/xvenue.test.mjs
import { teamMatch, matchPairs, attachUs, isLive, analyzeSeries, sampleXvenue, xvenueReport, collectCrosses, kalshiFee, usFee, XV_LIVE_BEFORE_MS, XV_LIVE_AFTER_MS } from "../src/xvenue.js";
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
  const kv = new Map(); const rows = []; let kalshiCalls = 0; let gammaUrl = ""; let kalshiUa = ""; let bookDown = false; const hookCalls = [];
  const env = {
    SIGNALS_CACHE: { get: async (k) => { const v = kv.get(k); return v === undefined ? null : JSON.parse(v); }, put: async (k, v) => { kv.set(k, v); } },
    DB: { prepare: (sql) => ({ bind: (...a) => ({ sql, a, run: async () => {} }), run: async () => {} }), batch: async (st) => { rows.push(...st); } },
  };
  const now = Date.parse("2026-10-13T00:30:00Z");   // Bills-Rams kicked off 15 min ago
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("kalshi") && u.includes("series_ticker=KXNFLGAME")) { kalshiCalls++; kalshiUa = (opts && opts.headers && opts.headers['user-agent']) || ""; if (kalshiCalls === 1) return { ok: false, status: 429, headers: { get: (h) => (h === "retry-after" ? "1" : null) }, json: async () => ({}) }; return { ok: true, json: async () => ({ markets: [K("KXNFLGAME-26OCT13BUFLA", "Buffalo", "2026-10-13T04:00:00Z", "0.38", "0.39"), K("KXNFLGAME-26OCT13BUFLA", "Los Angeles", "2026-10-13T04:00:00Z", "0.61", "0.62")] }) }; }
    if (u.includes("kalshi") && u.includes("series_ticker=")) { kalshiCalls++; return { ok: true, json: async () => ({ markets: [] }) }; }
    if (u.includes("kalshi") && u.includes("tickers=")) return { ok: true, json: async () => ({ markets: [{ ticker: "KXNFLGAME-26OCT13BUFLA-BUF", yes_bid_dollars: "0.3700", yes_ask_dollars: "0.3900", last_price_dollars: "0.3800" }, { ticker: "KXNFLGAME-26OCT13BUFLA-LOS", yes_bid_dollars: "0.6100", yes_ask_dollars: "0.6300" }] }) };
    if (u.includes("gamma-api") && u.includes("tag_slug=nfl")) { gammaUrl = u; return { ok: true, json: async () => [{ title: "Bills vs. Rams", markets: [P("Bills vs. Rams", ["Bills", "Rams"], "2026-10-13T00:15:00Z")] }] }; }
    if (u.includes("gateway.polymarket.us/v2/leagues/nfl/events")) return { ok: true, json: async () => ({ events: [{ title: "BUF Bills vs. LA Rams", startDate: "2026-10-13T00:15:00Z", closed: false, markets: [{ slug: "aec-nfl-buf-lar-2026-10-12", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE", marketSides: [{ description: "Rams", long: false, team: { name: "Los Angeles Rams" } }, { description: "Bills", long: true, team: { name: "Buffalo Bills" } }] }] }] }) };
    if (u.includes("gateway.polymarket.us/v2/leagues/")) return { ok: true, json: async () => ({ events: [] }) };
    if (u.includes("gateway.polymarket.us/v1/markets/aec-nfl-buf-lar-2026-10-12/book")) { if (bookDown) return { ok: false, status: 404, json: async () => ({}) }; return { ok: true, json: async () => ({ marketData: { marketSlug: "aec-nfl-buf-lar-2026-10-12", bids: [{ px: { value: "0.3700" }, qty: "50.00" }, { px: { value: "0.3800" }, qty: "1200.50" }], offers: [{ px: { value: "0.3900" }, qty: "10.00" }, { px: { value: "0.3825" }, qty: "800.00" }], state: "MARKET_STATE_OPEN" } }) }; }
    if (u.includes("gateway.polymarket.us/v1/markets/aec-nfl-buf-lar-2026-10-12/bbo")) return { ok: true, json: async () => ({ marketData: { bestBid: { value: "0.3800" }, bestAsk: { value: "0.3825" }, lastTradePx: { value: "0.3810" } } }) };
    if (u.includes("gamma-api")) return { ok: true, json: async () => [] };
    if (u.endsWith("/books") && opts && opts.method === "POST") return { ok: true, json: async () => [{ asset_id: "t0", bids: [{ price: "0.38", size: "100" }], asks: [{ price: "0.39", size: "50" }], last_trade_price: "0.39" }, { asset_id: "t1", bids: [{ price: "0.61", size: "10" }], asks: [{ price: "0.62", size: "10" }] }] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const s1 = await sampleXvenue(env, now, { afterSample: async (legs, at) => { hookCalls.push({ legs, at }); return { events: 0 }; } });
  check("sample: pairs built, one live game, two rows, correct columns", s1.pairs === 1 && s1.live === 1 && s1.rows === 2 && rows[0].a[0] === Math.floor(now / 1000) && rows[0].a[3] === "Bills" && rows[0].a[4] === "live" && rows[0].a[6] === 0.37 && rows[0].a[7] === 0.39 && rows[0].a[10] === 0.38 && rows[0].a[11] === 0.39 && rows[0].a[13] === 0.03, JSON.stringify({ s1, row: rows[0] && rows[0].a }));
  check("sample: Polymarket US top of book from /book (bids + offers, as the gateway names them) on the long leg (best levels, shares shown) and complemented on the other (sizes swap)", s1.usQuoted === 1 && rows[0].a[14] === 0.38 && rows[0].a[15] === 0.3825 && rows[0].a[16] === null && rows[0].a[17] === 1200.5 && rows[0].a[18] === 800 && rows[1].a[3] === "Rams" && rows[1].a[14] === 0.6175 && rows[1].a[15] === 0.62 && rows[1].a[17] === 800 && rows[1].a[18] === 1200.5, JSON.stringify([rows[0].a.slice(14), rows[1].a.slice(14)]));
  check("sample: afterSample hook receives the live legs with global + US quotes and sizes; its result lands in status.usLane", hookCalls.length === 1 && hookCalls[0].at === now && hookCalls[0].legs.length === 2 && hookCalls[0].legs[0].team === "Bills" && hookCalls[0].legs[0].p_bid === 0.38 && hookCalls[0].legs[0].us_ask === 0.3825 && hookCalls[0].legs[0].us_ask_qty === 800 && hookCalls[0].legs[0].p_token === "t0" && s1.usLane && s1.usLane.events === 0, JSON.stringify({ hookCalls: hookCalls.map(h => h.legs), usLane: s1.usLane }));
  bookDown = true;
  const sb = await sampleXvenue(env, now + 30e3, { afterSample: async () => { throw new Error("lane boom"); } });
  check("sample: /book down -> /bbo fallback keeps bid/ask (no sizes, last filled); a throwing hook never fails the sample", sb.rows === 2 && rows[2].a[14] === 0.38 && rows[2].a[15] === 0.3825 && rows[2].a[16] === 0.381 && rows[2].a[17] === null && rows[2].a[18] === null && /lane boom/.test(sb.usLaneError || ""), JSON.stringify({ sb, row: rows[2] && rows[2].a.slice(14) }));
  bookDown = false; rows.splice(2, 2);
  check("sample: stage marker reaches done", kv.has("xv_boot") && JSON.parse(kv.get("xv_boot")).stage === "done");
  check("sample: a Kalshi 429 is retried (Retry-After honoured), calls carry a User-Agent; Gamma asks for ending-soonest events", kalshiCalls >= 2 && /edgerunner-xvenue/.test(kalshiUa) && s1.diag.nfl.matched === 1 && /order=endDate&ascending=true&end_date_min=/.test(gammaUrl), JSON.stringify({ kalshiCalls, kalshiUa, gammaUrl, diag: s1.diag }));
  const callsAfterBuild = kalshiCalls;
  const s2 = await sampleXvenue(env, now + 60e3);
  check("sample: second minute reuses the cached pairs (no Kalshi series calls)", kalshiCalls === callsAfterBuild && s2.rows === 2 && rows.length === 4);
  const idleHook = [];
  const s3 = await sampleXvenue(env, now + 6 * 3600e3, { afterSample: async (legs, at) => { idleHook.push({ legs, at }); return { events: 0, marked: 3 }; } });
  check("sample: nothing live -> no rows, status still written, and the hook still runs (marks fill between games)", s3.live === 0 && s3.rows === 0 && rows.length === 4 && kv.has("xv_last") && idleHook.length === 1 && idleHook[0].legs.length === 0 && s3.usLane && s3.usLane.marked === 3, JSON.stringify({ s3, idleHook }));
  env.DB.prepare = (sql) => ({ bind: () => ({ all: async () => (/GROUP BY sport/.test(sql)
    ? { results: [{ sport: "nfl", n: 2, k: 2, p: 2, us: 2 }] }
    : { results: [{ ts: 0, sport: "nfl", game: "g", team: "Bills", k_bid: 0.4, k_ask: 0.42, p_bid: 0.4, p_ask: 0.41, us_bid: 0.39, us_ask: 0.40 }, { ts: 60, sport: "nfl", game: "g", team: "Bills", k_bid: 0.4, k_ask: 0.42, p_bid: 0.45, p_ask: 0.46, us_bid: 0.39, us_ask: 0.40 }] }) }) });
  const rep = await xvenueReport(env, { hours: 1 });
  check("report: crosses block present and empty when the venues never cross", rep.crosses && rep.crosses.n === 0 && rep.crosses.persisted === 0 && rep.crosses.persistRate === null && rep.crosses.games.length === 0 && Array.isArray(rep.crosses.recent), JSON.stringify(rep.crosses));
  {
    // Kalshi's bid sits 6c above the US ask on two consecutive minutes of one game (persists), 4c for a single minute of another (gone next row), and never on a third.
    const g = new Map();
    const row = (ts, game, team, kb, ka, ub, ua, extra = {}) => ({ ts, sport: "nhl", game, team, k_bid: kb, k_ask: ka, p_bid: 0.5, p_ask: 0.51, us_bid: ub, us_ask: ua, ...extra });
    g.set("nhl|A|Bruins", [row(0, "A", "Bruins", 0.56, 0.58, 0.49, 0.50, { us_ask_qty: 320 }), row(60, "A", "Bruins", 0.56, 0.58, 0.49, 0.50, { us_ask_qty: 300 }), row(120, "A", "Bruins", 0.50, 0.52, 0.49, 0.50)]);
    g.set("nhl|B|Kings", [row(0, "B", "Kings", 0.45, 0.47, 0.49, 0.50), row(60, "B", "Kings", 0.54, 0.56, 0.49, 0.50, { us_ask_qty: 80 }), row(400, "B", "Kings", 0.54, 0.56, 0.49, 0.50)]);
    g.set("nhl|C|Jets", [row(0, "C", "Jets", 0.49, 0.51, 0.49, 0.50), row(60, "C", "Jets", null, null, 0.49, 0.50)]);
    const x = collectCrosses(g);
    check("crosses: counted after both fees, newest first, persistence judged on the next row within 3 min, US size on the side taken, games ranked",
      x.n === 4 && x.persisted === 1 && x.persistRate === 0.25 && x.recent[0].ts === 400 && x.recent[0].persisted === false && x.recent[0].nextC === null
      && x.recent.find(r => r.ts === 0 && r.game === "A").persisted === true && x.recent.find(r => r.ts === 0 && r.game === "A").dir === "buy US, sell Kalshi" && x.recent.find(r => r.ts === 0 && r.game === "A").usQty === 320
      && x.recent.find(r => r.ts === 60 && r.game === "A").persisted === false && x.recent.find(r => r.ts === 60 && r.game === "A").nextC < 0
      && x.games[0].game === "nhl|A" && x.games[0].n === 2 && x.games[0].persisted === 1 && x.games[1].game === "nhl|B" && x.games[1].n === 2 && x.medUsQty === 300 && x.withUsQty === 3
      && x.avgC > 1 && x.avgC < 3 && x.avgPersistedC > 2, JSON.stringify(x));
    check("crosses: a 4c raw gap near 50c is only a ~0.5c cross after both taker fees", Math.abs(x.recent.find(r => r.ts === 60 && r.game === "B").c - (0.54 - 0.50 - 0.07 * 0.54 * 0.46 - 0.0695 * 0.5 * 0.5) * 100) < 0.02, JSON.stringify(x.recent));
  }
  check("report: per-sport aggregates incl. US and quoted counts", rep.rows === 2 && rep.legs === 1 && rep.bySport.nfl.polyMoves === 1 && rep.bySport.nfl.staleKalshi === 1 && rep.bySport.nfl.staleRate === 1 && rep.bySport.nfl.avgKalshiSpreadC === 2 && rep.bySport.nfl.staleUs === 1 && rep.bySport.nfl.avgUsSpreadC === 1 && rep.bySport.nfl.kUsCross === 0 && rep.quoted.nfl.kalshi === 2 && rep.quoted.nfl.polymarketUs === 2 && rep.last && rep.last.live === 0 && rep.boot && rep.boot.stage === "done", JSON.stringify({ bySport: rep.bySport, quoted: rep.quoted }));
  // Kalshi missing entirely (the throttled nights): Polymarket US metrics must still compute
  const noK = analyzeSeries([{ ts: 0, k_bid: null, k_ask: null, p_bid: 0.40, p_ask: 0.41, us_bid: 0.39, us_ask: 0.40 }, { ts: 60, k_bid: null, k_ask: null, p_bid: 0.45, p_ask: 0.46, us_bid: 0.39, us_ask: 0.40 }]);
  check("analyze: US stale edge counted without any Kalshi quote", noK.bothQuoted === 0 && noK.usQuoted === 2 && noK.polyMoves === 1 && noK.staleUs === 1 && noK.kUsCross === 0, JSON.stringify(noK));
  // Kalshi 429 on the per-minute quote call -> cooldown key set, next minute skips Kalshi
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("kalshi") && u.includes("tickers=")) return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
    return baseFetch(url, opts);
  };
  env.DB.prepare = (sql) => ({ bind: (...a) => ({ sql, a, run: async () => {} }), run: async () => {} });
  kv.delete("xv_pairs");   // force a rebuild at the live minute (the earlier idle sample cached an empty pairs list)
  const s4 = await sampleXvenue(env, now + 2 * 60e3);
  const s5 = await sampleXvenue(env, now + 3 * 60e3);
  check("sample: a 429 on the quote call sets a cooldown; the next minute skips Kalshi but still records Polymarket rows", /429/.test(s4.kalshiError || "") && s4.kQuoted === 0 && s4.rows === 2 && s5.kalshiSkipped && s5.rows === 2 && kv.has("xv_kalshi_cooldown"), JSON.stringify({ s4, s5 }));
}
{
  // With the operator's key configured, every Kalshi call is signed (src/kalshi.js) and the status says so.
  const { generateKeyPairSync, verify } = await import("node:crypto");
  const ed = generateKeyPairSync("ed25519");
  const kv = new Map(); const rows = []; const kalshiReqs = [];
  const env = {
    KALSHI_API_KEY_ID: "kid-1", KALSHI_PRIVATE_KEY: ed.privateKey.export({ type: "pkcs8", format: "pem" }),
    SIGNALS_CACHE: { get: async (k) => { const v = kv.get(k); return v === undefined ? null : JSON.parse(v); }, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
    DB: { prepare: (sql) => ({ bind: (...a) => ({ sql, a, run: async () => {} }), run: async () => {} }), batch: async (st) => { rows.push(...st); } },
  };
  const now = Date.parse("2026-10-13T00:30:00Z");
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("kalshi")) { kalshiReqs.push({ u, h: (opts && opts.headers) || {} }); }
    if (u.includes("kalshi") && u.includes("series_ticker=KXNFLGAME")) return { ok: true, status: 200, json: async () => ({ markets: [K("KXNFLGAME-26OCT13BUFLA", "Buffalo", "2026-10-13T04:00:00Z", "0.38", "0.39"), K("KXNFLGAME-26OCT13BUFLA", "Los Angeles", "2026-10-13T04:00:00Z", "0.61", "0.62")] }) };
    if (u.includes("kalshi") && u.includes("series_ticker=")) return { ok: true, status: 200, json: async () => ({ markets: [] }) };
    if (u.includes("kalshi") && u.includes("tickers=")) return { ok: true, status: 200, json: async () => ({ markets: [{ ticker: "KXNFLGAME-26OCT13BUFLA-BUF", yes_bid_dollars: "0.3700", yes_ask_dollars: "0.3900" }, { ticker: "KXNFLGAME-26OCT13BUFLA-LOS", yes_bid_dollars: "0.6100", yes_ask_dollars: "0.6300" }] }) };
    if (u.includes("gamma-api") && u.includes("tag_slug=nfl")) return { ok: true, json: async () => [{ title: "Bills vs. Rams", markets: [P("Bills vs. Rams", ["Bills", "Rams"], "2026-10-13T00:15:00Z")] }] };
    if (u.includes("gamma-api")) return { ok: true, json: async () => [] };
    if (u.includes("gateway.polymarket.us/v2/leagues/")) return { ok: true, json: async () => ({ events: [] }) };
    if (u.endsWith("/books") && opts && opts.method === "POST") return { ok: true, json: async () => [{ asset_id: "t0", bids: [{ price: "0.38", size: "1" }], asks: [{ price: "0.39", size: "1" }] }, { asset_id: "t1", bids: [{ price: "0.61", size: "1" }], asks: [{ price: "0.62", size: "1" }] }] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const st = await sampleXvenue(env, now);
  const q = kalshiReqs.find(r => r.u.includes("tickers="));
  const signedOk = q && verify(null, Buffer.from(q.h["KALSHI-ACCESS-TIMESTAMP"] + "GET/trade-api/v2/markets"), ed.publicKey, Buffer.from(q.h["KALSHI-ACCESS-SIGNATURE"], "base64"));
  check("signed: series and quote calls carry a valid Kalshi signature; status reports kalshiAuth; Kalshi quotes land", st.kalshiAuth === true && st.kQuoted === 2 && kalshiReqs.length >= 7 && kalshiReqs.every(r => r.h["KALSHI-ACCESS-KEY"] === "kid-1") && signedOk === true && rows[0].a[6] === 0.37, JSON.stringify({ st, nReq: kalshiReqs.length, row: rows[0] && rows[0].a.slice(0, 8) }));
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

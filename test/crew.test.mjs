// Agent Crew orders: parse the chat order, hunt a slate vs the books, debate,
// queue, and open picks through the real processSignals.
// Run with: node test/crew.test.mjs
import {
  parseDirective, consensusMoneyline, quoteOutcome, buildCandidates,
  handleCrewOrder, runCrewHunt, getCrewState, crewLedger, CREW_KEYS,
} from "../src/crew.js";
import { processSignals } from "../src/autotrader.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const gammaTime = (ms) => iso(ms).replace("T", " ").replace(/\.\d+Z$/, "+00");

function makeEnv(store = {}, cfg = {}) {
  const s = {
    autotrader_config: JSON.stringify({
      enabled: true, paperTradeMode: true, fixedSize: 10, maxDailyTrades: 30, maxDailySpend: 300, maxOpenPositions: 15,
      useLearningData: false, favoritesExperiment: false, vegasEdgeEntries: false, councilEnabled: false,
      blockedCategories: [], entryCooldownSeconds: 0, _liveV2Tuned: true, _v3ProfitOverhaul: true, _clearPositions: true, ...cfg,
    }),
    autotrader_positions: "[]",
    ...store,
  };
  return {
    store: s,
    SIGNALS_CACHE: {
      get: async (k, o) => (k in s ? (o && o.type === "json" ? JSON.parse(s[k]) : s[k]) : null),
      put: async (k, v) => { s[k] = v; },
      delete: async (k) => { delete s[k]; },
      list: async () => ({ keys: [] }),
    },
  };
}
const J = (env, k) => JSON.parse(env.store[k] || "null");

// ---------- parsing ----------
{
  const p = parseDirective("Its CFB saturday and not a single bet for CFB. They need to actively be searching for the best bets on the market, debating, and submitting");
  check("parse: operator's message = CFB focus", p.kind === "focus" && p.sports.join() === "cfb", JSON.stringify(p));
  check("parse: stand down", parseDirective("stand down").kind === "stand_down");
  check("parse: 'stop ignoring CFB' focuses, not stands down", parseDirective("stop ignoring CFB").kind === "focus");
  const q = parseDirective("NFL and college football tomorrow, min edge 4, up to 3 bets");
  check("parse: two sports + knobs", q.sports.includes("nfl") && q.sports.includes("cfb") && q.minEdge === 4 && q.maxBets === 3, JSON.stringify(q));
  check("parse: politics unhuntable", parseDirective("focus on politics").kind === "unhuntable");
  check("parse: gibberish unknown", parseDirective("hello there").kind === "unknown");
}

// ---------- pricing ----------
{
  const game = { home_team: "Army Black Knights", away_team: "Tulane Green Wave", bookmakers: [
    { key: "draftkings", markets: [{ key: "h2h", outcomes: [{ name: "Army Black Knights", price: -250 }, { name: "Tulane Green Wave", price: 205 }] }] },
    { key: "fanduel", markets: [{ key: "h2h", outcomes: [{ name: "Army Black Knights", price: -240 }, { name: "Tulane Green Wave", price: 196 }] }] },
    { key: "betmgm", markets: [{ key: "h2h", outcomes: [{ name: "Army Black Knights", price: -275 }, { name: "Tulane Green Wave", price: 220 }] }] },
  ] };
  const c = consensusMoneyline(game);
  check("consensus: devigged median sums to ~100", c && Math.abs(c.home + c.away - 100) < 0.3 && c.books === 3 && c.home > 68 && c.home < 72, JSON.stringify(c));
  check("consensus: DK line kept for the operator", c.dk && c.dk.away === 205);

  const m = { outcomes: '["Tulane","Army"]', outcomePrices: '["0.265","0.735"]', bestBid: 0.26, bestAsk: 0.27 };
  check("quote: outcome 0 lifts the ask", quoteOutcome(m, 0).buy === 27);
  check("quote: outcome 1 pays 1 - bid", quoteOutcome(m, 1).buy === 74);
  check("quote: no book -> midpoint", quoteOutcome({ outcomes: '["A","B"]', outcomePrices: '["0.4","0.6"]' }, 1).buy === 60);
}

// ---------- pairing ----------
const START = NOW + 4 * 3600e3;
const gm = (slug, q, outs, prices, bid, ask, startMs = START) => ({
  slug, question: q, outcomes: JSON.stringify(outs), outcomePrices: JSON.stringify(prices.map(String)),
  bestBid: bid, bestAsk: ask, gameStartTime: gammaTime(startMs), endDate: iso(startMs), closed: false, volumeNum: 50000,
});
const og = (away, home, awayPx, homePx, startMs = START) => ({
  id: `${away}-${home}`, commence_time: iso(startMs), away_team: away, home_team: home,
  bookmakers: ["draftkings", "fanduel"].map(key => ({ key, markets: [{ key: "h2h", outcomes: [{ name: away, price: awayPx }, { name: home, price: homePx }] }] })),
});
const MARKETS = [
  gm("cfb-jmad-gas-2026-10-10", "James Madison vs. Georgia Southern", ["James Madison", "Georgia Southern"], [0.62, 0.38], 0.61, 0.63),
  gm("cfb-miaoh-ohio-2026-10-10", "Miami (OH) vs. Ohio", ["Miami (OH)", "Ohio"], [0.45, 0.55], 0.44, 0.46),
  gm("cfb-tulane-army-2026-10-10", "Tulane vs. Army", ["Tulane", "Army"], [0.3, 0.7], 0.29, 0.31, NOW + 2 * 60e3), // kicks off in 2 min
  gm("cfb-ghost-team-2026-10-10", "Ghost U vs. Nowhere St", ["Ghost U", "Nowhere St"], [0.5, 0.5], 0.49, 0.51),
];
const ODDS = [
  og("James Madison Dukes", "Georgia Southern Eagles", -300, 240),    // books ~74% JMU vs 63c ask => +11
  og("Miami Hurricanes", "Florida State Seminoles", -150, 130),       // decoy: different Miami
  og("Miami (OH) RedHawks", "Ohio Bobcats", 120, -140),               // books ~44/56
  og("Tulane Green Wave", "Army Black Knights", 205, -250, NOW + 2 * 60e3),
];
{
  const b = buildCandidates("cfb", MARKETS, ODDS, NOW);
  const jmu = b.candidates.find(c => c.team === "James Madison");
  check("pair: JMU matched to the Dukes, priced at the ask", jmu && jmu.teamFull === "James Madison Dukes" && jmu.buyPrice === 63 && jmu.edge > 8, JSON.stringify(jmu));
  const gs = b.candidates.find(c => c.team === "Georgia Southern");
  check("pair: other side = 1 - bid", gs && gs.buyPrice === 39, JSON.stringify(gs));
  const mia = b.candidates.find(c => c.team === "Miami (OH)");
  check("pair: Miami (OH) not confused with the Hurricanes", mia && mia.teamFull === "Miami (OH) RedHawks", JSON.stringify(mia));
  check("pair: game about to start is skipped", !b.candidates.some(c => c.team === "Tulane"));
  check("pair: unknown game counted, not guessed", b.unmatched === 1 && !b.candidates.some(c => c.team === "Ghost U"), JSON.stringify({ u: b.unmatched }));
}

// Polymarket short labels vs sportsbook spellings
for (const [label, book] of [["UMass", "Massachusetts Minutemen"], ["Hawai'i", "Hawaii Rainbow Warriors"],
  ["Tennessee-Martin", "UT Martin Skyhawks"], ["San José State", "San Jose State Spartans"]]) {
  const b = buildCandidates("cfb", [gm("cfb-x-2026-10-10", `${label} vs. Ohio`, [label, "Ohio"], [0.5, 0.5], 0.49, 0.51)],
    [og(book, "Ohio Bobcats", 100, -120)], NOW);
  check(`names: ${label} matches ${book}`, b.matched === 1, JSON.stringify(b.unmatched));
}

// ---------- order -> hunt -> queue -> entry ----------
function installFetch(markets, quoteOverride = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (u.includes("gamma-api.polymarket.com/markets?closed=false")) return json(u.includes("offset=0") ? markets : []);
    if (u.includes("gamma-api.polymarket.com/markets?slug=")) {
      const slug = decodeURIComponent(u.split("slug=")[1]);
      const m = markets.find(x => x.slug === slug);
      return json(m ? [{ ...m, ...(quoteOverride[slug] || {}) }] : []);
    }
    return json([]);
  };
}
const deps = (signals = []) => ({
  getAutotraderConfig: async (env) => J(env, "autotrader_config"),
  getGameOdds: async () => ODDS,
  getDailyStats: async () => ({ realizedPnL: 0, tradesOpened: 0, totalSpent: 0 }),
  getOpenPositions: async (env) => J(env, "autotrader_positions") || [],
  getBotPerformance: async () => ({}),
  getTradeHistory: async (env) => J(env, "autotrader_history") || [],
  signals,
});

{
  installFetch(MARKETS);
  const env = makeEnv();
  // no order -> no hunt
  const idle = await runCrewHunt(env, deps(), NOW);
  check("hunt: idle without orders", idle.skipped === "no orders");

  const r = await handleCrewOrder(env, "Its CFB saturday. Find the best bets, debate, submit.", J(env, "autotrader_config"), NOW);
  check("order: crew acknowledges with the plan", /Hunting CFB/.test(r.reply), r.reply);
  check("order: directive stored", J(env, CREW_KEYS.DIRECTIVE)?.sports?.join() === "cfb");

  const h = await runCrewHunt(env, deps(), NOW);
  const hunt = J(env, CREW_KEYS.HUNT);
  check("hunt: priced the slate", h.priced === 2 && hunt.board.length >= 1, JSON.stringify(h));
  const top = hunt.board[0];
  check("hunt: biggest gap leads the board", top.team === "James Madison" && top.votes.length === 6, JSON.stringify(top && top.team));
  check("hunt: QUANT speaks to the Vegas gap", top.votes.find(v => v.agent === "QUANT").vote === "YES");
  check("hunt: DOUBT flags no wallet / no record", top.votes.find(v => v.agent === "DOUBT").vote === "NO");
  const queue = J(env, CREW_KEYS.PICKS);
  check("hunt: JMU queued (non-veto, edge >= 3)", queue.some(p => p.team === "James Madison") && top.qualifies, JSON.stringify({ q: queue.map(p => p.team), v: top.verdict }));
  check("hunt: thin gaps not queued", !queue.some(p => p.team === "Ohio" || p.team === "Miami (OH)"), JSON.stringify(queue.map(p => [p.team, p.edge])));
  const chat = J(env, CREW_KEYS.CHAT);
  check("hunt: report posted to chat", /CFB sweep: 2 pregame games/.test(chat[chat.length - 1].text), chat[chat.length - 1].text);
  check("hunt: throttled on the next cron", (await runCrewHunt(env, deps(), NOW + 5 * 60e3)).skipped === "throttled");

  // entry through the real auto-trader
  const res = await processSignals(env, []);
  const pos = (J(env, "autotrader_positions") || []).filter(p => p.strategySource === "crew_hunt");
  check("entry: crew position opened", pos.length === 1 && res.crew && res.crew.entered === 1, JSON.stringify(res.crew));
  const p = pos[0];
  const expectSize = top.verdict === "TRIM" ? 2.5 : 5;
  check("entry: at the live ask, sized by verdict", p && p.entryPrice === 63 && p.size === expectSize && p.holdToResolution === true, JSON.stringify(p));
  check("entry: council attached for the persona ledger", p && p.council && p.council.v.length === 6);
  check("entry: not in graduation / go-live", p && !p.isExploration && !p.graduatedEntry);
  check("entry: queue drained + id remembered", J(env, CREW_KEYS.PICKS).length === 0 && J(env, CREW_KEYS.ENTERED).includes(top.id));
  check("entry: chat says what was placed", /Placed: James Madison moneyline @ 63¢/.test(J(env, CREW_KEYS.CHAT).slice(-1)[0].text));

  const st = await getCrewState(env, deps());
  check("state: open crew bet + ledger", st.open.length === 1 && st.ledger.open === 1 && st.directive && st.chat.length >= 3);

  // stand down clears the order and the queue
  await handleCrewOrder(env, "stand down", J(env, "autotrader_config"), NOW);
  check("stand down: order cleared", !env.store[CREW_KEYS.DIRECTIVE] && J(env, CREW_KEYS.PICKS).length === 0);
}

// edge evaporated at the live ask -> no entry, pick stays queued
{
  installFetch(MARKETS, { "cfb-jmad-gas-2026-10-10": { bestBid: 0.72, bestAsk: 0.73, outcomePrices: '["0.725","0.275"]' } });
  const env = makeEnv({
    [CREW_KEYS.PICKS]: JSON.stringify([{ id: "cfb-jmad-gas-2026-10-10:0", marketSlug: "cfb-jmad-gas-2026-10-10", outcomeIndex: 0,
      team: "James Madison", game: "James Madison vs. Georgia Southern", startTime: iso(START), vegasProb: 74, buyPrice: 63, edge: 11, verdict: "APPROVE", minEdge: 3 }]),
  });
  const res = await processSignals(env, []);
  check("recheck: edge gone => no position", (J(env, "autotrader_positions") || []).length === 0, JSON.stringify(res.crew));
  check("recheck: reason recorded, pick kept", res.crew.skips["edge gone at live price"] === 1 && J(env, CREW_KEYS.PICKS).length === 1);
}

// live mode => crew never places (paper only)
{
  installFetch(MARKETS);
  const env = makeEnv({
    [CREW_KEYS.PICKS]: JSON.stringify([{ id: "x:0", marketSlug: "cfb-jmad-gas-2026-10-10", outcomeIndex: 0, team: "James Madison",
      game: "g", startTime: iso(START), vegasProb: 74, verdict: "APPROVE", minEdge: 3 }]),
  }, { paperTradeMode: false });
  const res = await processSignals(env, []);
  check("live mode: paper only", (J(env, "autotrader_positions") || []).length === 0 && res.crew && res.crew.skips["paper only"] === 1, JSON.stringify(res.crew));
}

// ledger
{
  const L = crewLedger([
    { strategySource: "crew_hunt", outcome: "win", pnl: 2.9, size: 5, council: { verdict: "APPROVE" } },
    { strategySource: "crew_hunt", outcome: "loss", pnl: -2.5, size: 2.5, council: { verdict: "TRIM" } },
    { strategySource: "crew_hunt", outcome: "void", pnl: 0, size: 5 },
    { strategySource: "vegas_edge", outcome: "win", pnl: 9, size: 10 },
  ], [{ strategySource: "crew_hunt" }]);
  check("ledger", L.settled === 2 && L.wins === 1 && L.pnl === 0.4 && L.open === 1 && L.byVerdict.TRIM.losses === 1, JSON.stringify(L));
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

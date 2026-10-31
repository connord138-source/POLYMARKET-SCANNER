// Agent Crew orders: parse the chat order, hunt a slate vs the books, debate,
// queue, and open picks through the real processSignals.
// Run with: node test/crew.test.mjs
import {
  parseDirective, consensusMoneyline, quoteOutcome, buildCandidates, parseEspnGames, dkMoneyline,
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
      list: async ({ prefix } = {}) => ({ keys: Object.keys(s).filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })) }),
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
  const o = parseDirective("you can file up to 12 bets a day. Focus only on CFB and no other areas until I tell you");
  check("parse: operator's 2nd order = 12 bets, open-ended", o.kind === "focus" && o.maxBets === 12 && o.days === 30 && o.sports.join() === "cfb", JSON.stringify(o));
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

// ---------- DraftKings via ESPN ----------
const espnLink = (path) => ({ href: `https://www.espn.com/x?wpsrc=413&preurl=${encodeURIComponent(`https://sportsbook.draftkings.com/event/1?outcomes=${path}`)}` });
const espnEvent = (id, away, home, ml, sp, tot, startMs = START, state = "pre") => ({
  id, date: iso(startMs), name: `${away} at ${home}`,
  competitions: [{
    date: iso(startMs), status: { type: { state } },
    competitors: [{ homeAway: "home", team: { displayName: home, location: home.split(" ")[0] } }, { homeAway: "away", team: { displayName: away, location: away.split(" ")[0] } }],
    odds: [{
      provider: { name: "DraftKings" }, overUnder: tot,
      moneyline: { home: { close: { odds: ml[1], link: espnLink("hml") } }, away: { close: { odds: ml[0], link: espnLink("aml") } } },
      pointSpread: { home: { close: { line: sp[1], odds: "-110", link: espnLink("hsp") } }, away: { close: { line: sp[0], odds: "-110", link: espnLink("asp") } } },
      total: { over: { close: { line: `o${tot}`, odds: "-110", link: espnLink("o") } }, under: { close: { line: `u${tot}`, odds: "-110", link: espnLink("u") } } },
    }],
  }],
});
const ESPN = { events: [
  espnEvent("1", "James Madison Dukes", "Georgia Southern Eagles", ["-150", "+130"], ["-3.5", "+3.5"], 51.5),
  espnEvent("2", "Miami (OH) RedHawks", "Ohio Bobcats", ["+120", "-140"], ["+2.5", "-2.5"], 44.5),
  espnEvent("3", "Done U", "Over St", ["-110", "-110"], ["-1", "+1"], 40, NOW - 3600e3, "post"),
] };
{
  const g = parseEspnGames(ESPN);
  check("espn: pregame DK games only", g.length === 2 && g[0].home.name === "Georgia Southern Eagles", JSON.stringify(g.map(x => x.id)));
  check("espn: DK odds + direct DK link", g[0].dk.ml.away.odds === -150 && g[0].dk.ml.away.link === "https://sportsbook.draftkings.com/event/1?outcomes=aml");
  check("espn: spread + total", g[0].dk.spread.away.line === -3.5 && g[0].dk.total.line === 51.5 && g[0].dk.total.over.odds === -110);
  const ml = dkMoneyline(g[0].dk);
  check("dk: implied has vig, fair is no-vig", ml.away.implied === 60 && ml.away.fair < 60 && Math.abs(ml.away.fair + ml.home.fair - 100) < 0.2, JSON.stringify(ml));

  // No Odds API (feed down): DK is the reference; JMU 62c mid on Polymarket vs DK -150 (60% implied) = value
  const b = buildCandidates("cfb", MARKETS, [], NOW, g);
  const jmu = b.candidates.find(c => c.team === "James Madison");
  check("dk-only: game priced off DraftKings", b.matched === 2 && b.dkMatched === 2 && jmu.refSource === "dk" && jmu.vegasProb === jmu.dk.fair, JSON.stringify({ m: b.matched, ref: jmu && jmu.refSource }));
  check("dk-only: DK value = Polymarket fair vs DK implied", jmu.dk.ev === Math.round((62 / 60 - 1) * 1000) / 10 && jmu.dk.link.endsWith("aml"), JSON.stringify(jmu.dk));
  const gaso = b.candidates.find(c => c.team === "Georgia Southern");
  check("dk-only: other side negative", gaso.dk.ev < 0 && gaso.dk.spread.line === 3.5);
}

// ---------- order -> hunt -> queue -> entry ----------
function installFetch(markets, quoteOverride = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (u.includes("gamma-api.polymarket.com/markets?closed=false")) return json(u.includes("offset=0") ? markets : []);
    if (u.includes("site.api.espn.com")) return json(globalThis.__espn || { events: [] });
    if (u.includes("gamma-api.polymarket.com/markets?") && new URL(u).searchParams.has("slug")) {
      const slug = new URL(u).searchParams.get("slug");
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
  const chatN = J(env, CREW_KEYS.CHAT).length;
  await runCrewHunt(env, deps(), NOW + 15 * 60e3);
  check("hunt: quiet sweep within the hour posts nothing", J(env, CREW_KEYS.CHAT).length === chatN);
  await runCrewHunt(env, deps(), NOW + 61 * 60e3);
  check("hunt: hourly report keeps the chat fresh", J(env, CREW_KEYS.CHAT).length === chatN + 1, J(env, CREW_KEYS.CHAT).length - chatN);

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
  check("state: no browser board reported yet", st.dkBoardReport === null);

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

// copy lane, minute path: the copy opens now into the inbox; the next 5-minute cycle adopts it
{
  const { enterCopyPicksNow } = await import("../src/autotrader.js");
  installFetch(MARKETS.map(m => ({ ...m, clobTokenIds: '["11","22"]' })));   // the copy entry looks the market up by slug and fills at Gamma's price
  const W = "0x" + "c".repeat(40);
  const pick = { id: `${W}:cfb-jmad-gas-2026-10-10:james madison:1`, wallet: W, nickname: "heater", marketSlug: "cfb-jmad-gas-2026-10-10", eventSlug: null, title: "James Madison vs. Georgia Southern", outcome: "James Madison", outcomeIndex: 0, usd: 5000, price: 62, trades: 1, firstTs: NOW - 90e3, lastTs: NOW - 90e3, betSize: null };
  const env = makeEnv({ copy_picks: JSON.stringify([pick]) });
  const cfg = J(env, "autotrader_config");
  const e1 = await enterCopyPicksNow(env, cfg, NOW);
  const inboxKeys = Object.keys(env.store).filter(k => k.startsWith("copy_inbox:"));
  const parked = inboxKeys.length ? JSON.parse(env.store[inboxKeys[0]]) : null;
  check("minute entry: the copy is opened at the live price into its own inbox key, the pick marked entered, the positions list untouched", e1.entered === 1 && inboxKeys.length === 1 && parked && parked.strategySource === "whale_copy" && parked.entryPrice === 62 && parked.copyLagS === 90 && parked.copyNick === "heater" && (J(env, "autotrader_positions") || []).length === 0 && J(env, "copy_entered").includes(pick.id) && J(env, "copy_picks").length === 0, { e1, parked });
  const e2 = await enterCopyPicksNow(env, cfg, NOW + 60e3);
  check("minute entry: nothing to do on the next minute", e2.entered === 0 && Object.keys(env.store).filter(k => k.startsWith("copy_inbox:")).length === 1);
  // a second pick on the same market is refused against the inbox copy; the daily cap counts the inbox too
  const pick2 = { ...pick, id: pick.id + "b", lastTs: NOW - 30e3 };
  env.store.copy_picks = JSON.stringify([pick2]);
  const e3 = await enterCopyPicksNow(env, { ...cfg, copyMaxPerDay: 1 }, NOW + 60e3);
  check("minute entry: caps read the inbox (daily cap 1 already used, same market held)", e3.entered === 0 && (e3.skips["copy daily cap"] === 1 || e3.skips["already holding market"] === 1), e3);
  // the 5-minute cycle adopts it
  const res = await processSignals(env, []);
  const pos = (J(env, "autotrader_positions") || []).filter(p => p.strategySource === "whale_copy");
  const day = JSON.parse(env.store[Object.keys(env.store).find(k => k.startsWith("autotrader_daily_stats_"))] || "{}");
  check("adopt: the inbox copy joins the positions list, the day's stats count it, the key is gone, the log says who", pos.length === 1 && pos[0].id === parked.id && !("_copyLog" in pos[0]) && res.copyAdopted === 1 && Object.keys(env.store).filter(k => k.startsWith("copy_inbox:")).length === 0 && day.copyOpened === 1 && day.tradesOpened >= 1, { res: { adopted: res.copyAdopted, errors: res.errors }, pos: pos[0] && pos[0].id, day });
  const res2 = await processSignals(env, []);
  check("adopt: idempotent", !res2.copyAdopted && (J(env, "autotrader_positions") || []).filter(p => p.strategySource === "whale_copy").length === 1);
  check("minute entry: bot off / lane off / live mode -> nothing opened", (await enterCopyPicksNow(env, { ...cfg, enabled: false }, NOW)).skips["bot off"] === 1 && (await enterCopyPicksNow(env, { ...cfg, copyEntries: false }, NOW)).skips["copy lane off"] === 1 && (await enterCopyPicksNow(env, { ...cfg, paperTradeMode: false }, NOW)).skips["paper only"] === 1);
}

// lanes: the whale-signal lane paused on its own, the crew lane still places
{
  installFetch(MARKETS);
  const env = makeEnv({
    [CREW_KEYS.PICKS]: JSON.stringify([{ id: "cfb-jmad-gas-2026-10-10:0", marketSlug: "cfb-jmad-gas-2026-10-10", outcomeIndex: 0,
      team: "James Madison", game: "James Madison vs. Georgia Southern", startTime: iso(START), vegasProb: 74, buyPrice: 63, edge: 11, verdict: "APPROVE", minEdge: 3 }]),
  }, { signalEntries: false });
  const res = await processSignals(env, [{ id: "sig1", marketSlug: "x", marketTitle: "x", direction: "YES", score: 90 }]);
  const pos = (J(env, "autotrader_positions") || []);
  check("lanes: signalEntries false -> no whale signal evaluated, reason logged, crew pick still entered, lanes reported", res.evaluated === 0 && res.skipReasons["Whale-signal lane paused (lanes)"] === 1 && res.crew && res.crew.entered === 1 && pos.length === 1 && pos[0].strategySource === "crew_hunt" && res.lanes && res.lanes.signals === false && res.lanes.crew === true && res.lanes.copy === true, JSON.stringify({ evaluated: res.evaluated, skip: res.skipReasons, crew: res.crew, lanes: res.lanes }));
  const env2 = makeEnv({ [CREW_KEYS.PICKS]: JSON.stringify([{ id: "x:0", marketSlug: "cfb-jmad-gas-2026-10-10", outcomeIndex: 0, team: "James Madison", game: "g", startTime: iso(START), vegasProb: 74, verdict: "APPROVE", minEdge: 3 }]) }, { crewHuntEntries: false });
  const res2 = await processSignals(env2, []);
  check("lanes: crewHuntEntries false -> the crew lane sits out, reported", (J(env2, "autotrader_positions") || []).length === 0 && !res2.crew && res2.lanes.crew === false && res2.lanes.signals === true, JSON.stringify({ crew: res2.crew, lanes: res2.lanes }));
}

// hunt with the Odds API down: DraftKings board + crew still prices the slate
{
  globalThis.__espn = ESPN;
  installFetch(MARKETS);
  const env = makeEnv({ odds_api_status: JSON.stringify({ ok: false, status: 401, error: "Usage quota has been reached" }) });
  await handleCrewOrder(env, "you can file up to 12 bets a day. Focus only on CFB and no other areas until I tell you", J(env, "autotrader_config"), NOW);
  const d = J(env, CREW_KEYS.DIRECTIVE);
  check("order: 12 bets + open-ended stored", d.maxBets === 12 && Date.parse(d.expiresAt) - NOW > 20 * 86400e3, JSON.stringify(d));
  check("order: reply says until stand down", /until you say stand down/.test(J(env, CREW_KEYS.CHAT).slice(-1)[0].text));
  const h = await runCrewHunt({ ...env }, { ...deps(), getGameOdds: async () => null }, NOW);
  const hunt = J(env, CREW_KEYS.HUNT);
  check("dk hunt: priced off DraftKings", h.priced === 2 && hunt.dkBoard.length === 2, JSON.stringify(h));
  check("dk hunt: board sorted by EV, links kept", hunt.dkBoard[0].ev >= hunt.dkBoard[1].ev && /draftkings\.com/.test(hunt.dkBoard[0].link), JSON.stringify(hunt.dkBoard.map(x => [x.team, x.ev])));
  const msg = J(env, CREW_KEYS.CHAT).slice(-1)[0].text;
  check("dk hunt: chat names DK value + dead feed", /DraftKings value: James Madison ML -150 \(\+\$3\.30 per \$100\)/.test(msg) && /HTTP 401/.test(msg), msg);
  check("dk hunt: server built the full board with the page's row ids", hunt.dkBoard[0].id === "cfb-jmad-gas-2026-10-10:ml:0" && hunt.dkBoard[0].market === "moneyline" && hunt.dkBoard[0].espnId === "1", JSON.stringify(hunt.dkBoard[0]));
  const rec = J(env, "crew_dk_picks") || [];
  check("dk hunt: value pick recorded server-side (page not needed)", rec.length === 1 && rec[0].id === "cfb-jmad-gas-2026-10-10:ml:0" && rec[0].side === "away", JSON.stringify(rec.map(p => [p.id, p.ev])));
  check("dk hunt: board shared with the chief", J(env, CREW_KEYS.DK_BOARD).source === "server");
  check("dk hunt: picks carry the order's cap", J(env, CREW_KEYS.PICKS).every(p => p.maxBets === 12));
  const pg = hunt.polyGames.find(g => g.slug === "cfb-jmad-gas-2026-10-10");
  check("dk hunt: Polymarket prices published for the browser board", hunt.polyGames.length === 3 && pg && pg.mid[0] === 62 && pg.outcomes[0] === "James Madison" && pg.sport === "cfb",
    JSON.stringify(hunt.polyGames.map(g => g.slug)));
  globalThis.__espn = null;
}

// entry honors the order's cap (12), not the config default (6)
{
  installFetch(MARKETS);
  const today = new Date().toISOString().split("T")[0];
  const env = makeEnv({
    [`autotrader_daily_stats_${today}`]: JSON.stringify({ date: today, tradesOpened: 6, totalSpent: 30, crewOpened: 6, realizedPnL: 0 }),
    [CREW_KEYS.PICKS]: JSON.stringify([{ id: "cfb-jmad-gas-2026-10-10:0", marketSlug: "cfb-jmad-gas-2026-10-10", outcomeIndex: 0, team: "James Madison",
      game: "James Madison vs. Georgia Southern", startTime: iso(START), vegasProb: 74, verdict: "APPROVE", minEdge: 3, maxBets: 12 }]),
  });
  const res = await processSignals(env, []);
  check("cap: 7th crew bet allowed under a 12/day order", (J(env, "autotrader_positions") || []).length === 1, JSON.stringify(res.crew));
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


// ---------- player props: NFL order, Polymarket's prop priced against the books, council, queue, entry ----------
{
  const kickoff = iso(START);
  const godwin = { slug: "nfl-atl-tb-2026-10-10-recyd-chris-godwin-jr-39pt5", sportsMarketType: "receiving_yards", question: "Chris Godwin Jr.: Receiving Yards O/U 39.5", line: 39.5,
    outcomes: '["Over","Under"]', bestBid: 0.40, bestAsk: 0.46, outcomePrices: '["0.43","0.57"]', gameStartTime: kickoff.replace("T", " ").replace(".000Z", "+00"), endDate: kickoff, volumeNum: 1800, events: [{ slug: "nfl-atl-tb-2026-10-10" }] };
  const oddsEvent = { id: "g1", commence_time: kickoff, home_team: "Tampa Bay Buccaneers", away_team: "Atlanta Falcons", bookmakers: [
    { key: "draftkings", last_update: iso(NOW), markets: [{ key: "player_reception_yds", last_update: iso(NOW), outcomes: [{ name: "Over", description: "Chris Godwin Jr.", price: -120, point: 39.5 }, { name: "Under", description: "Chris Godwin Jr.", price: 100, point: 39.5 }] }] },
    { key: "fanduel", last_update: iso(NOW), markets: [{ key: "player_reception_yds", last_update: iso(NOW), outcomes: [{ name: "Over", description: "Chris Godwin Jr.", price: -115, point: 39.5 }, { name: "Under", description: "Chris Godwin Jr.", price: -105, point: 39.5 }] }] },
  ] };
  const urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url); urls.push(u);
    const json = (b) => ({ ok: true, status: 200, headers: { get: (h) => (h === "x-requests-remaining" ? "15000" : null) }, json: async () => b, text: async () => JSON.stringify(b) });
    if (u.includes("gamma-api.polymarket.com/markets?closed=false")) return json(u.includes("sports_market_types=receiving_yards") && u.includes("offset=0") ? [godwin] : []);
    if (u.includes("gamma-api.polymarket.com/markets?slug=")) return json(decodeURIComponent(u.split("slug=")[1]) === godwin.slug ? [godwin] : []);
    if (u.includes("/sports/americanfootball_nfl/events?")) return json([{ id: "g1", commence_time: kickoff, home_team: oddsEvent.home_team, away_team: oddsEvent.away_team }]);
    if (u.includes("/events/g1/odds")) return json(oddsEvent);
    return json([]);
  };
  const env = { ...makeEnv(), ODDS_API_KEY: "k" };
  await handleCrewOrder(env, "Focus NFL today", J(env, "autotrader_config"), NOW);
  const h = await runCrewHunt(env, { ...deps(), getGameOdds: async () => [] }, NOW);
  const hunt = J(env, CREW_KEYS.HUNT);
  const props = hunt.props;
  check("props: the books' lines priced (one game, one line, both sides on the line-shopping board) and the event odds pulled once with the six NFL markets", props && props.priced === 1 && props.games === 1 && props.rows.length === 2 && urls.filter(u => /\/events\/g1\/odds/.test(u)).length === 1 && /markets=player_pass_yds,player_rush_yds,player_reception_yds,player_receptions,player_pass_tds,player_anytime_td/.test(urls.find(u => /\/events\/g1\/odds/.test(u))), JSON.stringify(props && { ...props, rows: props.rows.length, poly: { ...props.poly, rows: props.poly.rows.length } }));
  const poly = props.poly;
  const over = poly.rows.find(r => r.outcomeIndex === 0);
  check("props: Polymarket's Godwin 39.5 matched to the books' 39.5, Over at the 46c ask vs the devigged fair, a gap over the 3-pt min edge", poly.listed.join() === "nfl" && poly.matched === 1 && over && over.buyPrice === 46 && over.fair > 51 && over.fair < 54 && over.edge >= 5 && poly.value === 1 && poly.debated === 1, JSON.stringify(over));
  const row = hunt.board.find(d => d.kind === "prop");
  check("props: the gap went before the council as a prop with a readable label, Over as its outcome", row && row.label === "Chris Godwin Jr. over 39.5 rec yds" && row.team === "Over" && row.marketSlug === godwin.slug && row.votes.length === 6 && row.edge === over.edge, JSON.stringify(row && { label: row.label, team: row.team, verdict: row.verdict, edge: row.edge }));
  const chat = J(env, CREW_KEYS.CHAT).slice(-1)[0].text;
  check("props: the chat report says what the props pass found", /Props: 1 lines priced across 1 games/.test(chat) && /Polymarket NFL props: 1 matched to a books line, 1 at \+3 or better \(Chris Godwin Jr. over 39.5 rec yds 46¢ vs 5\d(\.\d)?%\), sent to the council/.test(chat), chat);
  const queue = J(env, CREW_KEYS.PICKS);
  const queued = queue.find(p => p.kind === "prop");
  check("props: queued as a prop pick with its label when the council did not veto", row.verdict === "VETO" ? !queued : (queued && queued.label === row.label && queued.team === "Over" && queued.outcomeIndex === 0), JSON.stringify({ verdict: row.verdict, queued }));
  if (queued) {
    const res = await processSignals(env, []);
    const pos = (J(env, "autotrader_positions") || []).filter(p => p.strategySource === "crew_hunt");
    check("props: entered at the live ask as a player-prop position titled by the prop, not 'Over'", pos.length === 1 && pos[0].entryPrice === 46 && pos[0].signalSubType === "player_prop" && pos[0].marketTitle === "Atlanta Falcons @ Tampa Bay Buccaneers — Chris Godwin Jr. over 39.5 rec yds" && pos[0].directionRaw === "Over", JSON.stringify({ res: res.crew, pos: pos[0] && [pos[0].marketTitle, pos[0].entryPrice, pos[0].signalSubType] }));
    check("props: chat names the prop", /Placed: Chris Godwin Jr. over 39.5 rec yds \(player prop\) @ 46¢/.test(J(env, CREW_KEYS.CHAT).slice(-1)[0].text), J(env, CREW_KEYS.CHAT).slice(-1)[0].text);
  }
  const st = await getCrewState(env, deps());
  check("props: the crew state carries the props board for the page", st.hunt && st.hunt.props && st.hunt.props.poly.rows.length === 2 && st.hunt.props.bySport.nfl && st.hunt.props.bySport.nfl.poly.matched === 1 && st.hunt.props.bySport.nfl.poly.rows === undefined);
  // the chief's state block
  const { propsReportLine } = await import("../src/crew.js");
  check("props: a CFB order says Polymarket lists no CFB props", /Polymarket lists no CFB player props, so those are line shopping only/.test(propsReportLine({ priced: 4, games: 2, rows: [], bySport: { cfb: { games: 2 } }, poly: { listed: [], rows: [] } }, ["cfb"], 3)) && /Props: CFB: odds credits low/.test(propsReportLine({ priced: 0, bySport: { cfb: { skipped: "odds credits low" } } }, ["cfb"], 3)));
  await handleCrewOrder(env, "stand down", J(env, "autotrader_config"), NOW);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

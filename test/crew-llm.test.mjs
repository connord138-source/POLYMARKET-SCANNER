// Agent Crew with Claude: the chief (chat) and the sweep debate, against a
// mocked Anthropic API. Run with: node test/crew-llm.test.mjs
import { handleCrewOrder, runCrewHunt, saveBrowserDkBoard, polyGameRows, CREW_KEYS } from "../src/crew.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const gammaTime = (ms) => iso(ms).replace("T", " ").replace(/\.\d+Z$/, "+00");
const today = () => new Date().toISOString().slice(0, 10);

function makeEnv(store = {}, envExtra = {}) {
  const s = { autotrader_config: JSON.stringify({ paperTradeMode: true, crewBetSize: 5 }), autotrader_positions: "[]", ...store };
  return {
    store: s, ANTHROPIC_API_KEY: "test-key", ...envExtra,
    SIGNALS_CACHE: {
      get: async (k, o) => (k in s ? (o && o.type === "json" ? JSON.parse(s[k]) : s[k]) : null),
      put: async (k, v) => { s[k] = v; }, delete: async (k) => { delete s[k]; }, list: async () => ({ keys: [] }),
    },
  };
}
const J = (env, k) => JSON.parse(env.store[k] || "null");
const CFG = { crewMinEdge: 3, crewMaxPerDay: 6, crewBetSize: 5 };

// Anthropic mock: records requests, answers with the queued JSON payloads.
let claudeCalls = [];
let claudeReplies = [];
function claudeResponse(obj, { status = 200, stop = "end_turn", usage = { input_tokens: 3000, output_tokens: 800 } } = {}) {
  return { ok: status === 200, status, json: async () => (status === 200
    ? { content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(obj) }], stop_reason: stop, usage }
    : obj) };
}

const START = NOW + 4 * 3600e3;
const ML = [{
  slug: "nfl-kc-lv-2026-10-11", question: "Chiefs vs. Raiders", outcomes: '["Chiefs","Raiders"]', outcomePrices: '["0.62","0.38"]',
  bestBid: 0.61, bestAsk: 0.63, gameStartTime: gammaTime(START), endDate: iso(START), closed: false, volumeNum: 90000,
}];
const SPREADS = [
  { slug: "nfl-kc-lv-2026-10-11-spread-home-3pt5", question: "Spread: Chiefs (-3.5)", outcomes: '["Chiefs","Raiders"]', outcomePrices: '["0.48","0.52"]', bestBid: 0.47, bestAsk: 0.49, line: -3.5 },
];
const TOTALS = [
  { slug: "nfl-kc-lv-2026-10-11-total-47pt5", question: "Chiefs vs. Raiders: O/U 47.5", outcomes: '["Over","Under"]', outcomePrices: '["0.51","0.49"]', bestBid: 0.50, bestAsk: 0.52, line: 47.5 },
  { slug: "nfl-other-game-2026-10-11-total-40pt5", question: "Other", outcomes: '["Over","Under"]', outcomePrices: '["0.5","0.5"]', bestBid: 0.49, bestAsk: 0.51, line: 40.5 },
];
const ODDS = [{
  id: "g1", commence_time: iso(START), away_team: "Kansas City Chiefs", home_team: "Las Vegas Raiders",
  bookmakers: ["draftkings", "fanduel", "betmgm"].map(key => ({ key, markets: [{ key: "h2h", outcomes: [{ name: "Kansas City Chiefs", price: -230 }, { name: "Las Vegas Raiders", price: 190 }] }] })),
}];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  if (u.startsWith("https://api.anthropic.com/")) {
    claudeCalls.push({ url: u, headers: opts.headers, body: JSON.parse(opts.body) });
    const next = claudeReplies.shift();
    return typeof next === "function" ? next() : next;
  }
  if (u.includes("gamma-api.polymarket.com/markets?closed=false") && u.includes("sports_market_types=moneyline")) return json(u.includes("offset=0") ? ML : []);
  if (u.includes("sports_market_types=spreads")) return json(u.includes("offset=0") ? SPREADS : []);
  if (u.includes("sports_market_types=totals")) return json(u.includes("offset=0") ? TOTALS : []);
  return json({ events: [] });
};

const deps = {
  getAutotraderConfig: async () => ({ paperTradeMode: true, crewBetSize: 5, crewMinEdge: 3, bankroll: 1000, maxPortfolioRisk: 50 }),
  getGameOdds: async () => ODDS,
  getDailyStats: async () => ({ realizedPnL: 0, tradesOpened: 0, totalSpent: 0 }),
  getOpenPositions: async () => [],
  getBotPerformance: async () => ({}),
  signals: [],
};

// ---------- the chief ----------
const nflOrder = (extra = {}) => JSON.stringify({ id: "ord_nfl", text: "focus on nfl today", sports: ["nfl"], markets: ["moneyline", "spread", "total"],
  minEdge: 3, maxBets: 6, createdAt: iso(NOW - 60e3), expiresAt: iso(NOW + 12 * 3600e3), ...extra });

{
  // "only nfl nothing else today" restates the order: answer, change nothing
  const env = makeEnv({ [CREW_KEYS.DIRECTIVE]: nflOrder(), [CREW_KEYS.CHAT]: JSON.stringify([
    { at: iso(NOW - 60e3), from: "you", text: "focus on nfl today" },
    { at: iso(NOW - 59e3), from: "crew", text: "Copy. Hunting NFL only." },
  ]) });
  claudeCalls = []; claudeReplies = [claudeResponse({ reply: "Already on it: NFL only, nothing else, through tonight.", action: "none", focus: null })];
  const r = await handleCrewOrder(env, "only nfl nothing else today", CFG, NOW);
  check("chief: answered by Claude", r.via === "claude" && /NFL only/.test(r.reply), JSON.stringify(r));
  check("chief: restated order does not reset it", J(env, CREW_KEYS.DIRECTIVE).id === "ord_nfl");
  const chat = J(env, CREW_KEYS.CHAT);
  check("chief: reply in chat, tagged", chat.length === 4 && chat[3].from === "crew" && chat[3].by === "chief");
  const req = claudeCalls[0];
  check("chief: model + structured output + low effort", req.body.model === "claude-opus-5-5" && req.body.output_config.format.type === "json_schema" && req.body.output_config.effort === "low");
  check("chief: refusal fallback on", req.body.fallbacks === "default" && req.headers["anthropic-beta"] === "server-side-fallback-2026-07-01");
  const msgs = req.body.messages;
  check("chief: history + state, ends on the operator", msgs[0].role === "user" && msgs[msgs.length - 1].role === "user" &&
    /<state>/.test(msgs[msgs.length - 1].content) && /only nfl nothing else today/.test(msgs[msgs.length - 1].content) && msgs.some(m => m.role === "assistant"), JSON.stringify(msgs.map(m => m.role)));
  check("chief: state carries the live orders", /"sports":\["nfl"\]/.test(msgs[msgs.length - 1].content));
  check("chief: spend tracked", parseFloat(env.store[`crew_llm_usd:${today()}`]) > 0.02, env.store[`crew_llm_usd:${today()}`]);
}
{
  // "everything from game lines to player bets": widen markets, keep the order, honest about props
  const env = makeEnv({ [CREW_KEYS.DIRECTIVE]: nflOrder({ markets: ["moneyline"] }) });
  claudeReplies = [claudeResponse({
    reply: "Game lines: on it — moneylines, spreads and totals. Player props I can't price: Polymarket has none for these games and the free DraftKings feed doesn't carry them.",
    action: "update_focus", focus: { sports: ["nfl"], markets: ["moneyline", "spread", "total"], minEdge: null, maxBets: null, until: "end_of_day", hours: null },
  })];
  const r = await handleCrewOrder(env, "you should be looking at everything from game lines to player bets", CFG, NOW);
  const d = J(env, CREW_KEYS.DIRECTIVE);
  check("chief: markets widened, same order id", d.id === "ord_nfl" && d.markets.join() === "moneyline,spread,total" && d.minEdge === 3 && d.maxBets === 6, JSON.stringify(d));
  check("chief: says what it can't do", /props/i.test(r.reply));
}
{
  // new sport + 12 bets + until stand down; bogus values are clamped by code
  const env = makeEnv({ [CREW_KEYS.DIRECTIVE]: nflOrder(), [CREW_KEYS.PICKS]: JSON.stringify([{ id: "old" }]) });
  claudeReplies = [claudeResponse({ reply: "Switching to college football.", action: "set_focus",
    focus: { sports: ["cfb", "soccer"], markets: ["moneyline", "props"], minEdge: 99, maxBets: 12, until: "stand_down", hours: null } })];
  await handleCrewOrder(env, "switch to cfb, 12 bets, until I tell you", CFG, NOW);
  const d = J(env, CREW_KEYS.DIRECTIVE);
  check("chief: new sport = new order, queue cleared", d.id !== "ord_nfl" && d.sports.join() === "cfb" && J(env, CREW_KEYS.PICKS).length === 0, JSON.stringify(d));
  check("chief: values validated by code", d.markets.join() === "moneyline" && d.minEdge === 15 && d.maxBets === 12 && d.openEnded === true && Date.parse(d.expiresAt) - NOW > 20 * 86400e3, JSON.stringify(d));
}
{
  const env = makeEnv({ [CREW_KEYS.DIRECTIVE]: nflOrder() });
  claudeReplies = [claudeResponse({ reply: "Standing down.", action: "stand_down", focus: null })];
  await handleCrewOrder(env, "ok that's enough for today", CFG, NOW);
  check("chief: stand down clears the order", !env.store[CREW_KEYS.DIRECTIVE]);
}
{
  // API error -> keyword parser, with a note
  const env = makeEnv();
  claudeReplies = [claudeResponse({ error: { message: "overloaded" } }, { status: 529 })];
  const r = await handleCrewOrder(env, "focus on nfl today", CFG, NOW);
  check("chief down: parser fallback still sets the order", r.via === "parser" && J(env, CREW_KEYS.DIRECTIVE).sports.join() === "nfl" && /couldn't answer/.test(r.reply), r.reply);
}
{
  // over budget -> no Claude call at all
  const env = makeEnv({ [`crew_llm_usd:${today()}`]: "3.5" });
  claudeCalls = [];
  const r = await handleCrewOrder(env, "focus on nfl today", CFG, NOW);
  check("budget: no call when the daily cap is spent", claudeCalls.length === 0 && r.via === "parser" && /budget/.test(r.reply), r.reply);
}
{
  // out of credits -> flag set for everyone
  const env = makeEnv();
  claudeReplies = [claudeResponse({ error: { message: "Your credit balance is too low to access the Anthropic API." } }, { status: 400 })];
  await handleCrewOrder(env, "focus on nfl", CFG, NOW);
  check("credits: billing-down flag set", !!env.store.anthropic_billing_down);
}

// ---------- spreads / totals published for the browser ----------
{
  const lines = [
    { slug: "nfl-kc-lv-2026-10-11-spread-home-3pt5", t: "s", l: -3.5, o: ["Chiefs", "Raiders"], m: [48, 52], w: 0.02 },
    { slug: "nfl-other-game-2026-10-11-total-40pt5", t: "t", l: 40.5, o: ["Over", "Under"], m: [50, 50], w: 0.02 },
  ];
  const rows = polyGameRows(ML, [], NOW, lines);
  check("lines: grouped under their game by slug", rows.length === 1 && rows[0].lines.length === 1 && rows[0].lines[0].l === -3.5 && !rows[0].lines[0].slug, JSON.stringify(rows[0].lines));
}

// ---------- the debate ----------
{
  const env = makeEnv({ [CREW_KEYS.DIRECTIVE]: nflOrder() });
  await saveBrowserDkBoard(env, [{ id: "x:0", label: "Raiders +3.5", team: "Raiders", market: "spread", odds: -105, fair: 52.4, implied: 51.2, ev: 2.3, startTime: iso(START), junk: "<script>" }]);
  check("dk board: sanitized + stored", J(env, CREW_KEYS.DK_BOARD).rows.length === 1 && !("junk" in J(env, CREW_KEYS.DK_BOARD).rows[0]));

  claudeCalls = [];
  claudeReplies = [claudeResponse({
    debate: [
      { agent: "QUANT", line: "Raiders at 39c vs 33.9% fair is the wrong way round; Chiefs side is the gap." },
      { agent: "DOUBT", line: "Three books agree with DraftKings. QUANT, that's thin." },
      { agent: "CHAIR", line: "Pass on the paper side; the Raiders +3.5 DraftKings line is the one worth a look." },
    ],
    verdicts: [{ id: "nfl-kc-lv-2026-10-11:0", verdict: "VETO", reason: "Gap is inside the noise." }, { id: "nfl-kc-lv-2026-10-11:1", verdict: "VETO", reason: "Negative edge." }],
    summary: "No paper bet. On DraftKings, Raiders +3.5 at -105 pays about +$2.30 per $100.",
  }, { usage: { input_tokens: 5000, output_tokens: 2500 } })];
  const r = await runCrewHunt(env, deps, NOW);
  const hunt = J(env, CREW_KEYS.HUNT);
  check("debate: ran once", claudeCalls.length === 1 && /ran/.test(r.debate), JSON.stringify(r));
  const sent = JSON.parse(claudeCalls[0].body.messages[0].content.replace(/<\/?sweep>/g, ""));
  check("debate: real numbers + opening votes + DK board sent", sent.candidates.length >= 1 && sent.candidates[0].openingVotes.length === 6 &&
    typeof sent.candidates[0].edgePts === "number" && sent.dkBoard[0].pick === "Raiders +3.5", JSON.stringify(sent.candidates[0]).slice(0, 300));
  check("debate: effort medium", claudeCalls[0].body.output_config.effort === "medium");
  check("debate: transcript + summary stored", hunt.debate.lines.length === 3 && /Raiders \+3\.5/.test(hunt.debate.summary));
  const chiefs = hunt.board.find(d => d.team === "Chiefs");
  check("debate: chair's veto overrides the rule vote and blocks the pick", chiefs && chiefs.verdict === "VETO" && chiefs.ruleVerdict && !chiefs.qualifies &&
    !J(env, CREW_KEYS.PICKS).some(p => p.team === "Chiefs"), JSON.stringify({ v: chiefs && chiefs.verdict, rule: chiefs && chiefs.ruleVerdict, edge: chiefs && chiefs.edge }));
  check("debate: chair summary posted to chat", /No paper bet/.test(J(env, CREW_KEYS.CHAT).slice(-1)[0].text));
  check("debate: spreads/totals published with the game", hunt.polyGames[0].lines.length === 2, JSON.stringify(hunt.polyGames[0].lines));

  // next sweep, same plays, 20 min later: no new Claude call, ruling carries over
  claudeCalls = [];
  const r2 = await runCrewHunt(env, deps, NOW + 20 * 60e3);
  const hunt2 = J(env, CREW_KEYS.HUNT);
  check("debate: not re-run for the same board", claudeCalls.length === 0 && r2.debate === "carried over" && hunt2.board.find(d => d.team === "Chiefs").verdict === "VETO", JSON.stringify(r2));
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

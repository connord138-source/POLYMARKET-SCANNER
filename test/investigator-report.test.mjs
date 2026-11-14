// The AI investigator's record, broken down (src/investigator-report.js).
import { marketKind, clusterKey, betOf, betPnl, summarize, breakdown, concentration, openDrift, buildInvestigatorReport, entryBand, edgeBand, horizonBand, COSTS, CORE_MIN_EDGE } from "../src/investigator-report.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const near = (a, b, e = 0.011) => Math.abs(a - b) < e;
const row = (o = {}) => ({ inv_key: `k${Math.random()}`, market_slug: "will-x-happen", direction_raw: "Yes", market_title: "Will X happen?", source: "sweep", status: "done", agent_prob: 0.6, confidence: "MEDIUM", model: "m1", market_prob: 0.4, edge_pts: 20, event_date: "2026-11-10T00:00:00Z", investigated_at: "2026-11-08T00:00:00Z", y: 1, agent_brier: 0.16, market_brier: 0.36, settled_at: "2026-11-10T02:00:00Z", ...o });

// ---------- kinds and clusters ----------
{
  const k = (t, s) => marketKind(t, s);
  check("kind: the real titles land where a person would put them",
    k("Will the highest temperature in Seoul (Incheon) be 16°C on November 15?") === "weather" &&
    k("Will Don Toliver be nominated for Best New Artist at the 69th Annual GRAMMY Awards?") === "entertainment" &&
    k("Will CZ post 0-19 posts from November 13 to November 20, 2026?") === "social" &&
    k("Variational FDV above $800M one day after launch?") === "crypto" &&
    k("Will Kraken's valuation hit (LOW) $9.2B by November 30?") === "crypto" &&
    k("Will monthly inflation increase by 0.3% in October?") === "economy" &&
    k("Will Anthropic be the second-best AI lab at the end of November 2026?") === "tech" &&
    k("Jensen Huang announced resignation or removal by December 31, 2026?") === "tech" &&
    k("Will the right bloc win the Spanish election by 40-49 seats?") === "politics" &&
    k("Will Malta win 2026-27 Nations League Group D1?") === "sports" &&
    k("Counter-Strike: FURIA vs Team Falcons (BO3) - BLAST Rivals Playoffs") === "esports" &&
    k("Will Wassily Kandinsky's Betonte Ecken sell for between $75m and $90m?") === "entertainment" &&
    k("Something nobody can place") === "other");
  check("cluster: buckets and dates of one event share a key; another event does not",
    clusterKey("highest-temperature-in-seoul-on-november-15-16c") === clusterKey("highest-temperature-in-seoul-on-november-15-17c") &&
    clusterKey("jensen-huang-announced-resignation-or-removal-by-november-11-2026") === clusterKey("jensen-huang-announced-resignation-or-removal-by-december-31-2026") &&
    clusterKey("highest-temperature-in-seoul-on-november-15-16c") !== clusterKey("highest-temperature-in-ankara-on-november-15-16c"),
    [clusterKey("highest-temperature-in-seoul-on-november-15-16c"), clusterKey("jensen-huang-announced-resignation-or-removal-by-november-11-2026")]);
}

// ---------- one bet ----------
{
  const a = betOf(row());                                           // agent 60 vs market 40: backs the direction at 40c, it won
  check("bet: positive edge backs the direction at the market price", a.side === "with" && a.entry === 0.4 && a.won === true && a.absEdge === 20 && a.horizonH === 48);
  const b = betOf(row({ market_prob: 0.7, edge_pts: -25, y: 1 }));  // agent well under the market: backs the other side at 30c, it lost
  check("bet: negative edge backs the other side at 1 - price, and loses when the direction wins", b.side === "against" && near(b.entry, 0.3, 1e-9) && b.won === false);
  const c = betOf(row({ market_prob: 0.7, edge_pts: -25, y: 0 }));
  check("bet: the other side wins when the direction loses", c.won === true);
  check("bet: unsettled, unpriced, zero-edge and extreme-price rows are not bets", betOf(row({ y: null })) === null && betOf(row({ market_prob: null })) === null && betOf(row({ edge_pts: 0 })) === null && betOf(row({ market_prob: 0.02, edge_pts: 10 })) === null && betOf(row({ market_prob: 0.02, edge_pts: -10 })) === null);
  check("pnl: a 40c winner pays $150 on $100 at the recorded price; a loser costs the stake", near(betPnl(a, COSTS[0]), 150) && betPnl(b, COSTS[0]) === -100);
  const per2 = 0.4 + 0.02 + 0.07 * 0.4 * 0.6;
  check("pnl: 2c worse plus the fee buys fewer contracts (40c -> 43.68c a contract)", near(betPnl(a, COSTS[2]), 100 / per2 - 100) && betPnl(a, COSTS[2]) < betPnl(a, COSTS[1]) && betPnl(a, COSTS[1]) < betPnl(a, COSTS[0]));
  check("bands", entryBand(a) === "35-65c" && edgeBand(a) === "20-30" && horizonBand(a) === "1-3 days" && entryBand({ entry: 0.1 }) === "under 15c" && edgeBand({ absEdge: 35 }) === "30+" && horizonBand({ horizonH: null }) === "unknown");
}

// ---------- a group ----------
{
  // 4 bets at 50c, 3 win: +$50 a bet on $100 = +50% at the recorded price; break-even 50%
  const bets = [1, 1, 1, 0].map((y, i) => betOf(row({ market_slug: `event-${["alpha", "bravo", "charlie", "delta"][i]}`, market_prob: 0.5, edge_pts: 15, y })));
  const s = summarize(bets);
  check("summary: hit rate against break-even, ROI falling as costs rise", s.n === 4 && s.events === 4 && s.wins === 3 && s.hitPct === 75 && s.breakEvenPct === 50 && s.roi.recorded === 50 && s.roi.c1 < 50 && s.roi.c2 < s.roi.c1 && s.roi.c3 < s.roi.c2 && s.pnl.recorded === 200, s);
  check("summary: Brier from the scored rows", s.brier && s.brier.n === 4 && s.brier.agentCloserPct === 100, s.brier);
  // the same result as ten buckets of ONE event is one event: the t-stat cannot be computed from a single event
  const one = Array.from({ length: 10 }, (_, i) => betOf(row({ market_slug: `highest-temperature-in-seoul-on-november-15-${10 + i}c`, market_prob: 0.5, edge_pts: 15, y: i < 8 ? 1 : 0 })));
  const s1 = summarize(one);
  check("summary: ten buckets of one event count as one event, no significance claimed", s1.n === 10 && s1.events === 1 && s1.tEvents === null, s1);
  // many independent winners: a large t; a coin flip at 50c: a t near zero
  const many = Array.from({ length: 40 }, (_, i) => betOf(row({ market_slug: `ev-${i}-x${"abcdefghijklmnopqrstuvwxyzabcdefghijklmnop"[i]}${"zyxwvutsrqponmlkjihgfedcbazyxwvutsrqponml"[i]}${i % 7 === 0 ? "q" : "w"}`, market_prob: 0.5, edge_pts: 15, y: i % 4 === 0 ? 0 : 1 })));
  const sm = summarize(many);
  const flip = Array.from({ length: 40 }, (_, i) => betOf(row({ market_slug: `flip-${"abcdefghijklmnopqrstuvwxyzabcdefghijklmnop"[i]}${"zyxwvutsrqponmlkjihgfedcbazyxwvutsrqponml"[i]}${i % 3 === 0 ? "u" : "v"}`, market_prob: 0.5, edge_pts: 15, y: i % 2 })));
  const sf = summarize(flip);
  check("summary: 30 of 40 independent winners at 50c is evidence (t > 2); a coin flip is not (|t| < 1)", sm.events >= 30 && sm.tEvents > 2 && sf.roi.recorded === 0 && Math.abs(sf.tEvents) < 1, { sm: [sm.events, sm.tEvents], sf: [sf.events, sf.tEvents] });
  check("empty group", summarize([]).n === 0);
}

// ---------- breakdown, concentration, drift ----------
{
  const rows = [
    row({ market_slug: "temp-seoul-a", market_title: "Will the highest temperature in Seoul be 16°C?", market_prob: 0.1, edge_pts: 15, y: 1 }),    // a long shot that hit: +$900
    row({ market_slug: "temp-ankara-b", market_title: "Will the highest temperature in Ankara be 17°C?", market_prob: 0.2, edge_pts: 13, y: 0 }),
    row({ market_slug: "spanish-election-bloc", market_title: "Will the right bloc win the Spanish election?", market_prob: 0.6, edge_pts: -14, y: 0, source: "whale" }),
    row({ market_slug: "inflation-october", market_title: "Will monthly inflation increase by 0.3%?", market_prob: 0.44, edge_pts: -24, y: 1, confidence: "LOW" }),
    row({ market_slug: "small-edge", market_title: "Will Malta win Nations League Group D1?", market_prob: 0.9, edge_pts: -6, y: 1 }),
    row({ market_slug: "open-one", market_title: "Will the PSOE win the election?", market_prob: 0.5, edge_pts: 12, y: null, agent_brier: null, market_brier: null, settled_at: null, market_prob_now: 0.56 }),
    row({ market_slug: "open-two", market_title: "Will the Fed cut?", market_prob: 0.5, edge_pts: -8, y: null, agent_brier: null, market_brier: null, settled_at: null, market_prob_now: 0.53 }),
    row({ market_slug: "err", status: "error_transient", y: null, market_prob: null, edge_pts: null }),
  ];
  const rep = buildInvestigatorReport(rows, { nowMs: Date.parse("2026-11-14T00:00:00Z") });
  check("report: counts", rep.counts.investigations === 8 && rep.counts.settled === 5 && rep.counts.bets === 5 && rep.counts.open === 2 && rep.counts.openCore === 1 && rep.counts.status.error === 1, rep.counts);
  check("report core: 12+ points and not LOW = the two weather bets and the election bet", rep.core.all.n === 3 && rep.core.byKind.weather.n === 2 && rep.core.byKind.politics.n === 1 && rep.core.bySource.whale.n === 1 && rep.core.bySide.against.n === 1, rep.core.all);
  check("report wide: 5+ points, any confidence = all five", rep.wide.all.n === 5 && rep.wide.byConfidence.LOW.n === 1 && rep.wide.byKind.economy.n === 1 && rep.wide.byKind.sports.n === 1);
  check("report byMinEdge: thresholds nest, LOW left out", rep.byMinEdge["0+"].n === 4 && rep.byMinEdge["12+"].n === 3 && rep.byMinEdge["15+"].n === 1 && rep.byMinEdge["30+"].n === 0, rep.byMinEdge);
  const conc = rep.core.concentration;
  check("concentration: the long shot is the biggest win; without the top three nothing is left", conc.biggestWins[0].entryC === 10 && near(conc.biggestWins[0].pnl, 900) && conc.biggestLosses[0].pnl === -100 && conc.withoutTop3 === null, conc);
  check("calibration by kind on every scored row", rep.calibration.n === 5 && rep.calibration.byKind.weather.n === 2 && rep.calibration.byKind.weather.agentCloserPct === 100);
  check("open drift: +6c toward the agent on the 12-point one, -3c (away) on the 8-point one", rep.openDrift.all.n === 2 && near(rep.openDrift.all.avgMoveC, 1.5) && rep.openDrift.all.towardPct === 50 && rep.openDrift.core.n === 1 && near(rep.openDrift.core.avgMoveC, 6), rep.openDrift);
  check("report: samples per kind and the read text", Array.isArray(rep.samples.weather) && rep.samples.weather.length === 2 && /break-even|breakEvenPct/.test(rep.read) && rep.costs.length === 4);
  check("drift: settled, errored and un-annotated rows are left out", openDrift([row(), row({ y: null, market_prob_now: null }), row({ y: null, status: "error_transient", market_prob_now: 0.5 })]).all.n === 0);
  check("an empty table still answers", buildInvestigatorReport([]).core.all.n === 0 && buildInvestigatorReport(null).counts.investigations === 0);
}
console.log(`investigator-report: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

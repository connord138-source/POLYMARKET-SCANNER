// Player props value board. Run with: node test/props.test.mjs
import { propRowsFromEvent, propFairs, listEvents, fetchEventProps, propsBoard, propsSweep, fetchPolyProps, polyPropRows, polyQuote, normPlayer, americanToDecimal, PROPS_CREDIT_FLOOR, PROP_MARKETS, PROP_MAX_SPREAD } from "../src/props.js";
import { americanToProb } from "../src/odds.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const NOW = Date.parse("2026-10-31T15:00:00Z");
const mk = (key, outcomes, last_update = "2026-10-31T14:50:00Z") => ({ key, last_update, outcomes });
const ou = (player, point, over, under) => [{ name: "Over", description: player, price: over, point }, { name: "Under", description: player, price: under, point }];
const ev = {
  id: "e1", sport_key: "americanfootball_ncaaf", commence_time: "2026-10-31T19:30:00Z", home_team: "Ohio State Buckeyes", away_team: "Penn State Nittany Lions",
  bookmakers: [
    { key: "draftkings", last_update: "2026-10-31T14:50:00Z", markets: [mk("player_pass_yds", ou("Julian Sayin", 249.5, -115, -105)), mk("player_rush_yds", ou("Nicholas Singleton", 80.5, -110, -110)), mk("h2h", [{ name: "Ohio State Buckeyes", price: -300 }, { name: "Penn State Nittany Lions", price: 240 }])] },
    { key: "fanduel", last_update: "2026-10-31T14:52:00Z", markets: [mk("player_pass_yds", ou("Julian Sayin", 249.5, -105, -115)), mk("player_rush_yds", ou("Nicholas Singleton", 84.5, -114, -106))] },
    { key: "betmgm", last_update: "2026-10-31T14:40:00Z", markets: [mk("player_pass_yds", ou("Julian Sayin", 249.5, +105, -135)), mk("player_pass_yds", [{ name: "Over", description: "Lone Quote", price: -110, point: 10.5 }])] },
  ],
};
{
  const rows = propRowsFromEvent(ev);
  const over = rows.find(r => r.player === "Julian Sayin" && r.side === "Over"), under = rows.find(r => r.player === "Julian Sayin" && r.side === "Under");
  // fair over = mean of devigged overs: DK -115/-105 -> .5115/(.5115+.5122)=.4997; FD -105/-115 -> .5003; MGM +105/-135 -> .4878/(.4878+.5745)=.4592  => mean .4864
  const dk = americanToProb(-115) / (americanToProb(-115) + americanToProb(-105)), fd = americanToProb(-105) / (americanToProb(-105) + americanToProb(-115)), mgm = americanToProb(105) / (americanToProb(105) + americanToProb(-135));
  const fairOver = (dk + fd + mgm) / 3;
  check("rows: same line at three books -> fair is the mean of the devigged quotes, best price is BetMGM +105 on the over", over && over.books === 3 && Math.abs(over.fair - fairOver * 100) < 0.06 && over.book === "betmgm" && over.odds === 105 && Math.abs(over.ev - 100 * (fairOver * americanToDecimal(105) - 1)) < 0.06, JSON.stringify(over));
  check("rows: the under's best price is DraftKings -105, EV computed on its own fair (the under is the better-priced side here)", under && under.book === "draftkings" && under.odds === -105 && Math.abs(under.fair - (100 - fairOver * 100)) < 0.06 && under.ev > over.ev, JSON.stringify(under));
  check("rows: different lines are different props (80.5 vs 84.5 each have one book) -> below min books, dropped; one-sided quote dropped; h2h ignored", !rows.some(r => r.player === "Nicholas Singleton") && !rows.some(r => r.player === "Lone Quote") && rows.every(r => r.market === "player_pass_yds"), JSON.stringify(rows.map(r => r.player)));
  check("rows: labels, game, kickoff, sorted by EV desc, freshest update kept", over.label === "pass yds" && over.game === "Penn State Nittany Lions @ Ohio State Buckeyes" && over.startTime === ev.commence_time && rows[0].ev >= rows[rows.length - 1].ev && over.updatedAt === "2026-10-31T14:50:00Z", JSON.stringify(rows[0]));   // the market-level update time wins over the book-level one
  check("rows: minBooks 1 keeps the single-book lines", propRowsFromEvent(ev, { minBooks: 1 }).some(r => r.player === "Nicholas Singleton" && r.point === 80.5) && propRowsFromEvent(ev, { minBooks: 1 }).some(r => r.player === "Nicholas Singleton" && r.point === 84.5));
  check("rows: empty / malformed", propRowsFromEvent(null).length === 0 && propRowsFromEvent({ bookmakers: [] }).length === 0);
}
{
  // listEvents + fetchEventProps + propsBoard with a mock API and KV: the free list, pregame window, per-event credits, cache, status refresh, credit floor
  const kv = new Map(); const calls = [];
  const env = { ODDS_API_KEY: "k", SIGNALS_CACHE: { get: async (k) => { const v = kv.get(k); return v === undefined ? null : JSON.parse(v); }, put: async (k, v) => { kv.set(k, v); } } };
  const events = [
    { id: "e1", commence_time: "2026-10-31T19:30:00Z", home_team: "Ohio State Buckeyes", away_team: "Penn State Nittany Lions" },
    { id: "e0", commence_time: "2026-10-31T15:05:00Z", home_team: "A", away_team: "B" },      // 5 min out: skipped (pregame floor)
    { id: "e2", commence_time: "2026-10-31T16:00:00Z", home_team: "C", away_team: "D" },
    { id: "e9", commence_time: "2026-11-03T00:00:00Z", home_team: "E", away_team: "F" },      // beyond the horizon
  ];
  const fetchImpl = async (url) => {
    calls.push(url);
    const hdr = { get: (h) => (h === "x-requests-remaining" ? "18000" : h === "x-requests-used" ? "2000" : null) };
    if (/\/events\?/.test(url)) return { ok: true, headers: hdr, json: async () => events };
    const m = url.match(/\/events\/(\w+)\/odds/);
    if (m && m[1] === "e2") return { ok: false, status: 422, headers: hdr, text: async () => "INVALID_MARKET" };
    return { ok: true, headers: hdr, json: async () => ({ ...ev, id: m[1] }) };
  };
  const list = await listEvents(env, "americanfootball_ncaaf", { nowMs: NOW, fetchImpl });
  check("events: pregame floor and horizon applied, soonest first, list cached", list.map(e => e.id).join(",") === "e2,e1" && kv.has("odds_events:americanfootball_ncaaf"), JSON.stringify(list.map(e => e.id)));
  const b = await propsBoard(env, "cfb", { nowMs: NOW, fetchImpl });
  check("board: two games asked, one failed (422 kept out of the shared feed status), one priced; credits counted per fetched game x markets; value count", b.games === 2 && b.failed === 1 && b.fetched === 1 && b.cached === 0 && /422/.test(b.lastError) && b.creditsSpentMax === PROP_MARKETS.football.length && b.rows.length === 2 && typeof b.value === "number" && b.markets.includes("player_pass_yds"), JSON.stringify({ ...b, rows: b.rows.length }));
  const st = JSON.parse(kv.get("odds_api_status")); check("board: the credit counters refreshed from the headers on success, ok true", st.remaining === "18000" && st.ok === true, kv.get("odds_api_status"));
  const n0 = calls.length; const b2 = await propsBoard(env, "cfb", { nowMs: NOW, fetchImpl });
  check("board: a second pass inside the TTL serves the priced game from KV (no credits) and retries the failed one", b2.cached === 1 && b2.fetched === 0 && calls.length === n0 + 1, JSON.stringify({ calls: calls.length - n0, b2: { cached: b2.cached, fetched: b2.fetched } }));
  const low = await propsBoard(env, "cfb", { nowMs: NOW, creditsLeft: PROPS_CREDIT_FLOOR - 1, fetchImpl });
  check("board: credit floor -> skipped with the reason, no calls", /credits low/.test(low.skipped) && low.rows.length === 0 && calls.length === n0 + 1);
  check("board: a sport without prop markets / no key", /no prop markets/.test((await propsBoard(env, "tennis", { nowMs: NOW, fetchImpl })).skipped) && /not configured/.test((await propsBoard({ SIGNALS_CACHE: env.SIGNALS_CACHE }, "nba", { nowMs: NOW, fetchImpl })).skipped));
  const r = await fetchEventProps(env, "americanfootball_ncaaf", "e7", PROP_MARKETS.football, { fetchImpl });
  check("event props: url carries us region, the markets and american odds; cached under the event", /regions=us/.test(calls[calls.length - 1]) && /markets=player_pass_yds,player_rush_yds/.test(calls[calls.length - 1]) && /oddsFormat=american/.test(calls[calls.length - 1]) && r.fromCache === false && kv.has("odds_props:e7:6"));
}
{
  // Yes/No props (anytime TD): two-sided where a book quotes both, one-sided otherwise
  const td = { id: "e5", commence_time: "2026-11-01T18:00:00Z", home_team: "Tampa Bay Buccaneers", away_team: "Atlanta Falcons", bookmakers: [
    { key: "draftkings", markets: [mk("player_anytime_td", [{ name: "Yes", description: "A.J. Brown", price: -140 }, { name: "Yes", description: "Chris Godwin Jr.", price: +120 }]), mk("player_reception_yds", ou("Chris Godwin Jr.", 39.5, -115, -105))] },
    { key: "fanduel", markets: [mk("player_anytime_td", [{ name: "Yes", description: "A.J. Brown", price: -125 }, { name: "Yes", description: "Chris Godwin Jr.", price: +130 }, { name: "No", description: "Chris Godwin Jr.", price: -165 }]), mk("player_reception_yds", ou("Chris Godwin Jr.", 39.5, -108, -112))] },
    { key: "betmgm", markets: [mk("player_anytime_td", [{ name: "Yes", description: "Chris Godwin Jr.", price: +125 }, { name: "No", description: "Chris Godwin Jr.", price: -160 }])] },
  ] };
  const fairs = propFairs(td);
  const brown = fairs.find(f => f.player === "A.J. Brown"), godwinTd = fairs.find(f => f.player === "Chris Godwin Jr." && f.market === "player_anytime_td"), godwinYds = fairs.find(f => f.market === "player_reception_yds");
  check("fairs: one-sided Yes at two books -> fair is the lowest implied (FanDuel -125), flagged oneSided, best Yes price kept", brown && brown.oneSided && Math.abs(brown.fair - americanToProb(-125)) < 1e-9 && brown.books === 2 && brown.best.Over.book === "fanduel" && !brown.best.Under, JSON.stringify(brown));
  check("fairs: Yes/No quoted both ways at two books -> devigged like an over/under, yesNo flagged, the one-sided DraftKings quote only feeds best price", godwinTd && !godwinTd.oneSided && godwinTd.yesNo && godwinTd.books === 2 && godwinTd.best.Over.book === "fanduel" && godwinTd.best.Over.odds === 130 && godwinTd.fair > 0.4 && godwinTd.fair < 0.46, JSON.stringify(godwinTd));
  check("fairs: an over/under line next to them is unaffected", godwinYds && !godwinYds.yesNo && godwinYds.books === 2 && godwinYds.point === 39.5);
  const rows = propRowsFromEvent(td);
  check("rows: one-sided props are left off the line-shopping board; the two-sided TD shows Yes/No sides with no line", !rows.some(r => r.player === "A.J. Brown") && rows.some(r => r.market === "player_anytime_td" && r.side === "Yes" && r.point === null) && rows.some(r => r.market === "player_anytime_td" && r.side === "No"), JSON.stringify(rows.map(r => [r.player, r.side, r.point])));
  check("names: punctuation, suffixes, accents and hyphens are normalized away", normPlayer("A.J. Brown") === "aj brown" && normPlayer("AJ Brown") === "aj brown" && normPlayer("Chris Godwin Jr.") === "chris godwin" && normPlayer("Ja'Marr Chase") === "jamarr chase" && normPlayer("Alperen Sengün") === "alperen sengun" && normPlayer("Amon-Ra St. Brown") === "amonra st brown", [normPlayer("A.J. Brown"), normPlayer("Chris Godwin Jr."), normPlayer("Amon-Ra St. Brown")].join("|"));

  // Polymarket's markets against those fairs
  const pm = (slug, type, question, line, outcomes, bid, ask, prices, extra = {}) => ({ slug, sportsMarketType: type, question, line, outcomes: JSON.stringify(outcomes), bestBid: bid, bestAsk: ask, outcomePrices: JSON.stringify(prices), gameStartTime: "2026-11-01 18:00:00+00", volumeNum: 1500, events: [{ slug: "nfl-atl-tb-2026-11-01" }], ...extra });
  const markets = [
    pm("nfl-atl-tb-2026-11-01-recyd-chris-godwin-jr-39pt5", "receiving_yards", "Chris Godwin Jr.: Receiving Yards O/U 39.5", 39.5, ["Over", "Under"], 0.40, 0.46, ["0.43", "0.57"]),
    pm("nfl-atl-tb-2026-11-01-recyd-chris-godwin-jr-44pt5", "receiving_yards", "Chris Godwin Jr.: Receiving Yards O/U 44.5", 44.5, ["Over", "Under"], 0.30, 0.34, ["0.32", "0.68"]),
    pm("nfl-atl-tb-2026-11-01-anytime-td-aj-brown", "anytime_touchdowns", "AJ Brown: Anytime Touchdown", null, ["Yes", "No"], 0.47, 0.50, ["0.485", "0.515"]),
    pm("nfl-atl-tb-2026-11-01-anytime-td-chris-godwin-jr", "anytime_touchdowns", "Chris Godwin Jr.: Anytime Touchdown", null, ["Yes", "No"], 0.30, 0.52, ["0.41", "0.59"]),
    pm("nfl-atl-tb-2026-11-01-recyd-mike-evans-60pt5", "receiving_yards", "Mike Evans: Receiving Yards O/U 60.5", 60.5, ["Over", "Under"], 0.45, 0.48, ["0.46", "0.54"]),
    pm("nfl-atl-tb-2026-11-01-recyd-old-game-10pt5", "receiving_yards", "Someone: Receiving Yards O/U 10.5", 10.5, ["Over", "Under"], 0.45, 0.48, ["0.46", "0.54"], { gameStartTime: "2026-10-31 15:05:00+00" }),
    pm("nfl-atl-tb-2026-11-01-q4-moneyline", "q4_moneyline", "4th Quarter Winner", null, ["Falcons", "Buccaneers"], 0.45, 0.48, ["0.46", "0.54"]),
  ];
  const pr = polyPropRows("nfl", markets, fairs, { nowMs: NOW });
  const over = pr.rows.find(r => r.slug.endsWith("39pt5") && r.outcomeIndex === 0), under = pr.rows.find(r => r.slug.endsWith("39pt5") && r.outcomeIndex === 1);
  const fairOver = godwinYds.fair * 100;
  check("poly: the 39.5 line matches the books' 39.5 fair; Over buys at the ask (46c) and Under at 1 - bid (60c); edge = fair - ask", pr.listed && pr.matched === 3 && over && under && over.buyPrice === 46 && under.buyPrice === 60 && Math.abs(over.edge - (Math.round(fairOver * 10) / 10 - 46)) < 0.11 && Math.abs(under.fair - (100 - over.fair)) < 0.11 && over.side === "Over" && under.side === "Under" && over.books === 2 && over.bestBook && over.bestBook.book === "fanduel", JSON.stringify({ pr: { ...pr, rows: pr.rows.length }, over, under }));
  check("poly: the 44.5 line is a different bet (lineMismatch), Mike Evans has no books price (noFair), the started game is notOpen and the quarter market ignored", pr.lineMismatch === 1 && pr.noFair === 1 && pr.notOpen === 1 && pr.skipped === undefined && !pr.rows.some(r => /mike-evans|old-game|q4/.test(r.slug)), JSON.stringify({ ...pr, rows: pr.rows.length }));
  const brownRow = pr.rows.filter(r => /aj-brown/.test(r.slug)), godwinTdRows = pr.rows.filter(r => /anytime-td-chris-godwin/.test(r.slug));
  check("poly: one-sided anytime TD compares the Yes side only, flagged oneSided, against the books' best implied price; a two-sided TD gets both sides and the wide book is thin", brownRow.length === 1 && brownRow[0].oneSided && brownRow[0].side === "Yes" && brownRow[0].buyPrice === 50 && Math.abs(brownRow[0].fair - Math.round(americanToProb(-125) * 1000) / 10) < 0.11 && godwinTdRows.length === 2 && !godwinTdRows[0].oneSided && godwinTdRows.every(r => r.thin) && !over.thin, JSON.stringify({ brownRow, godwinTdRows: godwinTdRows.map(r => [r.side, r.thin, r.spread]) }));
  check("poly: sorted by edge, rows carry the event link, kickoff, label and volume", pr.rows.every((r, i) => i === 0 || pr.rows[i - 1].edge >= r.edge) && over.url === "https://polymarket.com/event/nfl-atl-tb-2026-11-01" && over.startTime === "2026-11-01T18:00:00.000Z" && over.label === "rec yds" && over.volume === 1500 && over.game === "Atlanta Falcons @ Tampa Bay Buccaneers");
  check("poly: a sport Polymarket lists no props for -> listed false, nothing matched", polyPropRows("cfb", markets, fairs, { nowMs: NOW }).listed === false && polyPropRows("cfb", markets, fairs, { nowMs: NOW }).rows.length === 0);
  check("quote: no book -> the mid; book -> ask / 1 - bid", polyQuote({ outcomePrices: '["0.3","0.7"]' }, 1).buy === 70 && polyQuote({ outcomePrices: '["0.3","0.7"]', bestBid: 0.28, bestAsk: 0.33 }, 0).buy === 33 && polyQuote({ outcomePrices: '["0.3","0.7"]', bestBid: 0.28, bestAsk: 0.33 }, 1).buy === 72);
}
{
  // fetchPolyProps + propsSweep end to end with mocks for both feeds
  const kv = new Map(); const calls = [];
  const env = { ODDS_API_KEY: "k", SIGNALS_CACHE: { get: async (k) => { const v = kv.get(k); return v === undefined ? null : JSON.parse(v); }, put: async (k, v) => { kv.set(k, v); } } };
  const td = { id: "g1", commence_time: "2026-11-01T18:00:00Z", home_team: "Tampa Bay Buccaneers", away_team: "Atlanta Falcons", bookmakers: [
    { key: "draftkings", markets: [mk("player_reception_yds", ou("Chris Godwin Jr.", 39.5, -115, -105))] }, { key: "fanduel", markets: [mk("player_reception_yds", ou("Chris Godwin Jr.", 39.5, -108, -112))] },
  ] };
  const gammaPage = (type, offset) => {
    if (type !== "receiving_yards" || offset > 0) return [];
    return [{ slug: "nfl-atl-tb-2026-11-01-recyd-chris-godwin-jr-39pt5", sportsMarketType: "receiving_yards", question: "Chris Godwin Jr.: Receiving Yards O/U 39.5", line: 39.5, outcomes: '["Over","Under"]', bestBid: 0.40, bestAsk: 0.46, outcomePrices: '["0.43","0.57"]', gameStartTime: "2026-11-01 18:00:00+00", events: [{ slug: "nfl-atl-tb-2026-11-01" }] },
      { slug: "nba-x-y-2026-11-01-recyd-wrong-sport-1pt5", sportsMarketType: "receiving_yards", question: "X: Receiving Yards O/U 1.5", line: 1.5, outcomes: '["Over","Under"]', gameStartTime: "2026-11-01 18:00:00+00" }];
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    const hdr = { get: (h) => (h === "x-requests-remaining" ? "17000" : null) };
    if (/gamma-api/.test(url)) { const u = new URL(url); return { ok: true, json: async () => gammaPage(u.searchParams.get("sports_market_types"), Number(u.searchParams.get("offset"))) }; }
    if (/\/events\?/.test(url)) return { ok: true, headers: hdr, json: async () => [{ id: "g1", commence_time: "2026-11-01T18:00:00Z", home_team: "Tampa Bay Buccaneers", away_team: "Atlanta Falcons" }] };
    return { ok: true, headers: hdr, json: async () => td };
  };
  const g = await fetchPolyProps("nfl", { nowMs: NOW, fetchImpl });
  const gammaCalls = calls.filter(u => /gamma-api/.test(u));
  check("gamma: one page per NFL prop type (six types), tag 450, window from now, the other sport's slug dropped", g.markets.length === 1 && g.error === null && gammaCalls.length === 6 && gammaCalls.every(u => /tag_id=450/.test(u) && /sports_market_types=/.test(u) && /end_date_min=/.test(u)), JSON.stringify({ n: g.markets.length, calls: gammaCalls.length }));
  const sw = await propsSweep(env, "nfl", { nowMs: NOW, fetchImpl });
  check("sweep: books board plus Polymarket props matched to it; the fairs are not carried on the result", sw.games === 1 && sw.rows.length === 2 && sw.fairs === undefined && sw.poly.listed && sw.poly.matched === 1 && sw.poly.rows.length === 2 && sw.poly.rows[0].buyPrice === 46, JSON.stringify({ ...sw, rows: sw.rows.length }));
  const cfb = await propsSweep(env, "cfb", { nowMs: NOW, fetchImpl });
  check("sweep: CFB has no Polymarket props -> listed false, no Gamma calls", cfb.poly.listed === false && calls.filter(u => /gamma-api/.test(u)).length === gammaCalls.length * 2);
  const low = await propsSweep(env, "nba", { nowMs: NOW, creditsLeft: 10, fetchImpl });
  check("sweep: credits low -> both feeds skipped with the reason", /credits low/.test(low.skipped) && /credits low/.test(low.poly.skipped) && low.poly.rows.length === 0);
  check("gamma: a failing page is reported, not thrown", (await fetchPolyProps("nba", { nowMs: NOW, fetchImpl: async () => ({ ok: false, status: 500 }) })).error === "Gamma HTTP 500");
}
console.log(`props: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

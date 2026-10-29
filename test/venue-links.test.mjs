// Polymarket US page links and quotes, Gamma game lookup. Run with: node test/venue-links.test.mjs
import { slimEvents, findUsGame, usEventUrl, usCategoryUrl, usLinkFor, usMatchForGame, usGameQuote } from "../src/polymarket-us.js";
import { gammaMoneylineFromSearch } from "../src/gamma.js";
import { teamNamesOverlap } from "../src/odds.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const kv = () => { const m = new Map(); return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), put: async (k, v) => { m.set(k, v); } }; };

// the gateway's event shape (Oct 29 2026): event slug + one moneyline market with two sides
const gw = { events: [
  { slug: "nba-cle-atl-2026-10-29", title: "CLE Cavaliers vs. ATL Hawks", startDate: "2026-10-30T00:00:00Z", markets: [{ slug: "aec-nba-cle-atl-2026-10-29", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE", marketSides: [{ team: { name: "Cleveland Cavaliers" }, long: true }, { team: { name: "Atlanta Hawks" } }] }] },
  { slug: "nba-sac-no-2026-10-29", title: "SAC Kings vs. NO Pelicans", startDate: "2026-10-30T00:00:00Z", markets: [{ slug: "aec-nba-sac-no-2026-10-29", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE", marketSides: [{ team: { name: "Sacramento Kings" } }, { team: { name: "New Orleans Pelicans" }, long: true }] }] },
  { slug: "nba-old-game-2026-10-20", title: "old", startDate: "2026-10-20T00:00:00Z", markets: [{ slug: "aec-nba-old", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE", marketSides: [{ team: { name: "Cleveland Cavaliers" }, long: true }, { team: { name: "Atlanta Hawks" } }] }] },
] };
const now = Date.parse("2026-10-29T15:00:00Z");
const events = slimEvents(gw);
check("slimEvents keeps the event slug", events[0].eventSlug === "nba-cle-atl-2026-10-29" && events[1].eventSlug === "nba-sac-no-2026-10-29");
const hit = findUsGame("nba", events, "Cleveland Cavaliers", "Atlanta Hawks", { nowMs: now });
check("findUsGame: both names, straight order, skips the stale game", hit && hit.slug === "aec-nba-cle-atl-2026-10-29" && hit.aIdx === 0 && hit.teamA === "Cleveland Cavaliers", hit);
const flipped = findUsGame("nba", events, "Atlanta Hawks", "Cleveland Cavaliers", { nowMs: now });
check("findUsGame: flipped order resolves with aIdx 1", flipped && flipped.aIdx === 1 && flipped.teamA === "Atlanta Hawks", flipped);
check("findUsGame: unknown teams -> null", findUsGame("nba", events, "Boston Celtics", "Miami Heat", { nowMs: now }) === null);
check("usEventUrl: league page, event page, marketSlug query", usEventUrl("nba") === "https://polymarket.us/sports/nba" && usEventUrl("nba", "nba-cle-atl-2026-10-29", "aec-nba-cle-atl-2026-10-29") === "https://polymarket.us/sports/nba/nba-cle-atl-2026-10-29?marketSlug=aec-nba-cle-atl-2026-10-29");
check("usCategoryUrl: crypto / politics / economics / home", usCategoryUrl({ marketTitle: "Will Bitcoin dip to $60,000 by December 31?" }).endsWith("/category/crypto") && usCategoryUrl({ marketTitle: "Will the Republicans win the Ohio Senate race?" }).endsWith("/category/politics") && usCategoryUrl({ marketTitle: "Fed rate cut in December?" }).endsWith("/category/economics") && usCategoryUrl({ marketTitle: "Will it rain in Paris?" }) === "https://polymarket.us");

// usLinkFor: league from the global slug, teams from the title, event page when listed
const env = { SIGNALS_CACHE: kv() };
const fetchImpl = async (u) => ({ ok: true, status: 200, json: async () => (String(u).includes("/leagues/nba/") ? gw : String(u).includes("/bbo") ? { marketData: { bestBid: { value: "0.47" }, bestAsk: { value: "0.49" }, lastTradePx: { value: "0.48" } } } : { events: [] }) });
const link = await usLinkFor(env, { marketSlug: "nba-cle-atl-2026-10-29", marketTitle: "Cavaliers vs. Hawks" }, { fetchImpl, nowMs: now });
check("usLinkFor: exact event page for a listed NBA game", link.exact === true && link.url === "https://polymarket.us/sports/nba/nba-cle-atl-2026-10-29?marketSlug=aec-nba-cle-atl-2026-10-29" && link.league === "nba", link);
const miss = await usLinkFor(env, { marketSlug: "nba-bos-mia-2026-10-29", marketTitle: "Celtics vs. Heat" }, { fetchImpl, nowMs: now });
check("usLinkFor: unlisted game -> the league page, not exact", miss.exact === false && miss.url === "https://polymarket.us/sports/nba", miss);
const cat = await usLinkFor(env, { marketSlug: "will-bitcoin-dip-to-60000", marketTitle: "Will Bitcoin dip to $60,000 by December 31, 2026?" }, { fetchImpl, nowMs: now });
check("usLinkFor: non-sports -> category page", cat.exact === false && cat.url.endsWith("/category/crypto"), cat);

// quotes: YES price belongs to the long side, the other side is its complement
const m = await usMatchForGame(env, "nba", "Sacramento Kings", "New Orleans Pelicans", { startMs: Date.parse("2026-10-30T00:10:00Z"), fetchImpl, nowMs: now });
check("usMatchForGame: by Odds API sport name, returns league + url", m && m.league === "nba" && m.url.startsWith("https://polymarket.us/sports/nba/nba-sac-no-2026-10-29"), m);
const q = await usGameQuote(env, "nba", m, { fetchImpl, nowMs: now });
check("usGameQuote: Pelicans (long) 48¢ from the mid, Kings 52¢ as the complement", q && q.teamA.price === 52 && q.teamB.price === 48 && q.teamA.team === "Sacramento Kings", q);
check("usGameQuote: taker cost is the ask on the long side (49) and 1 - bid on the short side (53)", q && q.teamB.cost === 49 && q.teamB.long === true && q.teamA.cost === 53 && q.teamA.long === false, q);
const none = await usMatchForGame(env, "ncaab", "Duke", "Kansas", { fetchImpl, nowMs: now });
check("usMatchForGame: ncaab maps to the cbb league and misses cleanly", none === null);

// Gamma search -> moneyline (shape from gamma-api public-search, Oct 29 2026)
const search = { events: [
  { slug: "polyv2-nba-cle-atl-2026-10-29", title: "Cavaliers vs. Hawks", markets: [{ slug: "polyv2-nba-cle-atl-2026-10-29", sportsMarketType: "moneyline", outcomes: '["Cavaliers", "Hawks"]', outcomePrices: '["0.40", "0.60"]' }] },
  { slug: "nba-cle-atl-2026-04-10", title: "Cavaliers vs. Hawks", markets: [{ slug: "nba-cle-atl-2026-04-10", sportsMarketType: "moneyline", outcomes: '["Cavaliers", "Hawks"]', outcomePrices: '["0.30", "0.70"]' }] },
  { slug: "nba-cle-atl-2026-10-29", title: "Cavaliers vs. Hawks", markets: [{ slug: "nba-cle-atl-2026-10-29-team-to-score-first", sportsMarketType: "basketball_team_to_score_first", outcomes: '["Cavaliers", "Hawks"]', outcomePrices: '["0.495", "0.505"]' }, { slug: "nba-cle-atl-2026-10-29", sportsMarketType: "moneyline", outcomes: '["Cavaliers", "Hawks"]', outcomePrices: '["0.485", "0.515"]' }] },
] };
const game = { id: "x", awayTeam: "Cleveland Cavaliers", homeTeam: "Atlanta Hawks", commenceTime: "2026-10-30T00:10:00Z" };
const gm = gammaMoneylineFromSearch(search, "nba", game, { teamNamesOverlap });
check("gamma: the dated nba-* event on the game's day, moneyline market, sides by nickname", gm && gm.slug === "nba-cle-atl-2026-10-29" && gm.moneyline.away.price === 49 && gm.moneyline.home.price === 52 && gm.url === "https://polymarket.com/event/nba-cle-atl-2026-10-29", gm);
check("gamma: nothing on the day -> null", gammaMoneylineFromSearch(search, "nba", { ...game, commenceTime: "2026-12-01T00:00:00Z" }, { teamNamesOverlap }) === null);

console.log(`venue-links: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

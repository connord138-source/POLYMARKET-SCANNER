// Polymarket US adapter. Run with: node test/polymarket-us.test.mjs
import { generateKeyPairSync, verify as nodeVerify, createPublicKey } from "node:crypto";
import { signingMessage, decodeSecret, seedToPkcs8, importPmusKey, pmusHeaders, pmusRequest, pmusConfigured, leagueOf, leaguesOf, marketKind, legOfIntent, nameScore, teamsOfTitle, teamOfIntent, slimEvents, matchUsEvent, resolveUsMarket, fetchUsBook, usLevels, orderIntent, yesPriceFor, roundYesPrice, roundQty, buildUsOrder, usFeePerContract, fillFromExecutions, fillFromOrder, usBalances, usPositionQty, PmusError } from "../src/polymarket-us.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };

// ---- signing: verified against Node's own Ed25519 ----
{
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  const seed = Buffer.from(pkcs8.subarray(pkcs8.length - 32));
  const seedB64 = seed.toString("base64");
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const sixtyFour = Buffer.concat([seed, Buffer.from(pub)]).toString("base64");
  check("secret: 32-byte and 64-byte base64 keys both yield the seed", Buffer.from(decodeSecret(seedB64)).equals(seed) && Buffer.from(decodeSecret(sixtyFour)).equals(seed));
  let threw = false; try { decodeSecret(Buffer.alloc(20).toString("base64")); } catch (e) { threw = e instanceof PmusError; } check("secret: wrong length rejected", threw);
  check("pkcs8: wrapper matches Node's DER", Buffer.from(seedToPkcs8(seed)).equals(pkcs8));
  const env = { PMUS_KEY_ID: " key-1 ", PMUS_SECRET_KEY: seedB64 };
  const h = await pmusHeaders(env, "post", "/v1/orders", 1761300000000);
  const msg = signingMessage("1761300000000", "POST", "/v1/orders");
  check("headers: key id trimmed, ms timestamp, base64 Ed25519 signature over ts+METHOD+pathname that Node verifies", h["X-PM-Access-Key"] === "key-1" && h["X-PM-Timestamp"] === "1761300000000" && msg === "1761300000000POST/v1/orders" && nodeVerify(null, Buffer.from(msg), publicKey, Buffer.from(h["X-PM-Signature"], "base64")) && h["Content-Type"] === "application/json");
  // request: query string is NOT in the signed path; 429 retried once; non-2xx throws with the body message
  const calls = [];
  const fetchMock = async (url, opts) => { calls.push({ url, opts }); if (calls.length === 1) return { ok: false, status: 429, json: async () => ({ status: 429, message: "Too Many Requests" }) }; return { ok: true, status: 200, json: async () => ({ positions: {} }) }; };
  const t0 = Date.now();
  const data = await pmusRequest(env, "GET", "/v1/portfolio/positions", { query: { market: "aec-nfl-x", limit: 5 }, fetchImpl: fetchMock });
  const sig = calls[1].opts.headers["X-PM-Signature"], ts = calls[1].opts.headers["X-PM-Timestamp"];
  check("request: url carries the query, the signature covers only the pathname, 429 retried after ~1s", data.positions && calls.length === 2 && calls[1].url === "https://api.polymarket.us/v1/portfolio/positions?market=aec-nfl-x&limit=5" && nodeVerify(null, Buffer.from(signingMessage(ts, "GET", "/v1/portfolio/positions")), publicKey, Buffer.from(sig, "base64")) && Date.now() - t0 >= 900, JSON.stringify(calls.map(c => c.url)));
  let err = null; try { await pmusRequest(env, "POST", "/v1/orders", { body: { marketSlug: "x" }, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ message: "Bad request - invalid order request" }) }) }); } catch (e) { err = e; }
  check("request: 4xx throws a PmusError with status and message", err instanceof PmusError && err.status === 400 && /invalid order request/.test(err.message));
  check("configured: needs both secrets", pmusConfigured(env) && !pmusConfigured({ PMUS_KEY_ID: "k" }) && !pmusConfigured(null));
}
// ---- routing helpers ----
{
  check("league: from the global slug prefix, else from category/title words", leagueOf({ marketSlug: "nfl-buf-lar-2026-10-26" }) === "nfl" && leagueOf({ marketSlug: "ncaaf-osu-ind-2026-10-25" }) === "cfb" && leagueOf({ marketSlug: "will-x", marketCategory: "sports", marketTitle: "NBA: Lakers vs. Celtics" }) === "nba" && leagueOf({ marketSlug: "btc-updown-5m-123" }) === null);
  check("title: 'A vs. B' and 'Will X win' parse; qualifiers dropped", JSON.stringify(teamsOfTitle("Bills vs. Rams")) === '["Bills","Rams"]' && JSON.stringify(teamsOfTitle("Ohio State vs. Indiana: O/U 45.5")) === '["Ohio State","Indiana"]' && JSON.stringify(teamsOfTitle("Will Lakers win on 2026-10-24?")) === '["Lakers"]' && teamsOfTitle("Bitcoin above $100k").length === 0);
  check("team: directionRaw wins; YES on a single-team title is that team; NO or a two-team YES is unknown", teamOfIntent({ directionRaw: "Rams", marketTitle: "Bills vs. Rams" }) === "Rams" && teamOfIntent({ direction: "YES", marketTitle: "Will Lakers win on 2026-10-24?" }) === "Lakers" && teamOfIntent({ direction: "NO", marketTitle: "Will Lakers win on 2026-10-24?" }) === null && teamOfIntent({ direction: "YES", marketTitle: "Bills vs. Rams" }) === null);
  const raw = { events: [
    { title: "BUF Bills vs. LA Rams", startDate: "2026-10-26T00:15:00Z", markets: [{ slug: "aec-nfl-buf-lar-2026-10-25", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE", marketSides: [{ description: "Rams", long: false, team: { name: "Los Angeles Rams" } }, { description: "Bills", long: true, team: { name: "Buffalo Bills" } }] }, { slug: "aec-nfl-buf-lar-spread", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_SPREAD", marketSides: [{}, {}] }] },
    { title: "closed", closed: true, markets: [] },
    { title: "MIA Dolphins vs. NYJ Jets", startDate: "2026-10-26T17:00:00Z", markets: [{ slug: "aec-nfl-mia-nyj-2026-10-27", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE", marketSides: [{ description: "Jets", long: true, team: { name: "New York Jets" } }, { description: "Dolphins", long: false, team: { name: "Miami Dolphins" } }] }] },
  ] };
  const ev = slimEvents(raw);
  check("events: moneyline only, closed dropped, sides keep team + long", ev.length === 2 && ev[0].slug === "aec-nfl-buf-lar-2026-10-25" && ev[0].sides[1].team === "Buffalo Bills" && ev[0].sides[1].long === true && ev[0].sides[0].long === false, JSON.stringify(ev));
  const now = Date.parse("2026-10-25T22:00:00Z");
  const hitL = matchUsEvent("nfl", ev, "Bills", "Rams", now), hitS = matchUsEvent("nfl", ev, "Rams", "Bills", now);
  check("match: the team's side decides long/short; opponent must match", hitL && hitL.slug === "aec-nfl-buf-lar-2026-10-25" && hitL.side === "long" && hitS && hitS.side === "short" && matchUsEvent("nfl", ev, "Bills", "Jets", now) === null && matchUsEvent("nfl", ev, "Jets", null, now).side === "long", JSON.stringify([hitL, hitS]));
  check("match: outside the time window -> none", matchUsEvent("nfl", ev, "Bills", null, now + 5 * 86400e3) === null);
}
// ---- wider league map (Oct 25 2026): tennis / soccer / UFC / esports ----
{
  check("leagues: tennis, soccer, UFC, esports prefixes map to US leagues (lists tried in order); unmapped prefixes do not", JSON.stringify(leaguesOf({ marketSlug: "atp-cerundo-grieksp-2026-10-24" })) === '["atp","atpcq"]' && leagueOf({ marketSlug: "lal-bar-rea-2026-10-25-rea" }) === "lal" && leagueOf({ marketSlug: "ufc-mer-pet-2026-10-24" }) === "ufc" && leagueOf({ marketSlug: "lol-hle1-gen-2026-10-24" }) === "lol" && leagueOf({ marketSlug: "val-vit-loud-2026-10-16" }) === "valorant" && leagueOf({ marketSlug: "fl1-tro-rcl-2026-10-17" }) === "lg1" && JSON.stringify(leaguesOf({ marketSlug: "itf-a-b-2026-10-22", marketTitle: "W35 Lisbon: A vs B" })) === '["itfw","itfm"]' && leagueOf({ marketSlug: "itf-a-b-2026-10-22", marketTitle: "M15 Sharm ElSheikh: A vs B" }) === "itfm" && leagueOf({ marketSlug: "will-x", marketTitle: "Counter-Strike: Liquid vs NaVi (BO3) - Major" }) === "cs2" && leagueOf({ marketSlug: "col-tra-hmi-2026-10-22" }) === null);
  check("kind: totals, spreads, handicaps, game/map winners and combos are not moneylines", marketKind({ marketSlug: "nfl-was-sf-2026-10-20-total-59pt5", marketTitle: "Commanders vs. 49ers: O/U 59.5" }) === "spread/total" && marketKind({ marketSlug: "lol-dk-mkoi-2026-10-25-game-handicap-away-1pt5", marketTitle: "Game Handicap: DK (-1.5) vs Movistar KOI (+1.5)" }) === "spread/total" && marketKind({ marketSlug: "lol-gen-ly-2026-10-25-game2", marketTitle: "LoL: Gen.G vs LYON - Game 2 Winner" }) === "sub-market" && marketKind({ marketSlug: "ufc-ram10-lon-2026-10-24", marketTitle: "O/U 2.5 Rounds" }) === "spread/total" && marketKind({ marketSlug: "cfb-wvir-tcu-2026-10-24-spread-home-10pt5", marketTitle: "Spread: TCU (-10.5)" }) === "spread/total" && marketKind({ marketSlug: "lol-gen-ly-2026-10-25", marketTitle: "LoL: Gen.G vs LYON (BO3) - Worlds Group Stage" }) === "moneyline" && marketKind({ marketSlug: "lal-bar-rea-2026-10-25-bar", marketTitle: "Will FC Barcelona win on 2026-10-25?" }) === "moneyline" && marketKind({ marketSlug: "nba-mia-cha-2026-10-24", marketTitle: "Heat vs. Hornets" }) === "moneyline" && marketKind({ marketTitle: "Will SS Lazio win on 2026-10-27? AND Will Como 1907 win on 2026-10-27?" }) === "combo");
  check("titles: tournament prefixes and series suffixes stripped", JSON.stringify(teamsOfTitle("UFC 333: Merab Dvalishvili vs. Petr Yan (Bantamweight, Main Card)")) === '["Merab Dvalishvili","Petr Yan"]' && JSON.stringify(teamsOfTitle("LoL: Hanwha Life Esports vs Gen.G (BO1) - Worlds Group Stage")) === '["Hanwha Life Esports","Gen.G"]' && JSON.stringify(teamsOfTitle("Almaty Open, Qualification: Gabriel Diallo vs Rei Sakamoto")) === '["Gabriel Diallo","Rei Sakamoto"]' && JSON.stringify(teamsOfTitle("Dota 2: 1win vs OG (BO3) - PARI Universe Group A")) === '["1win","OG"]' && JSON.stringify(teamsOfTitle("Will RC Celta de Vigo win on 2026-10-25?")) === '["RC Celta de Vigo"]' && JSON.stringify(teamsOfTitle("Guayaquil: Bernardo Munk Mesa vs Tristan McCormick")) === '["Bernardo Munk Mesa","Tristan McCormick"]');
  check("names: diacritics, club suffixes and initials tolerated; Manchester City is not Manchester United; exact beats subset", nameScore("Francisco Cerúndolo", "Francisco Cerundolo") === 2 && nameScore("F. Cerundolo", "Francisco Cerundolo") === 1 && nameScore("Gen.G", "Gen.G Esports") === 2 && nameScore("Athletic Club", "Athletic Bilbao") === 1 && nameScore("Manchester City FC", "Manchester United FC") === 0 && nameScore("FC Barcelona", "RCD Espanyol de Barcelona") === 1 && nameScore("FC Barcelona", "FC Barcelona") === 2 && nameScore("Real Madrid CF", "Real Sociedad de Fútbol") === 0 && nameScore("T1", "T1") === 2 && nameScore("Top Esports", "Top Esports") === 2 && nameScore("AZ", "AZ Alkmaar") === 0 && nameScore("Xinyu Wang", "Wang Xinyu") === 1, [nameScore("F. Cerundolo", "Francisco Cerundolo"), nameScore("Gen.G", "Gen.G Esports"), nameScore("FC Barcelona", "RCD Espanyol de Barcelona"), nameScore("Xinyu Wang", "Wang Xinyu")].join(","));
  check("leg: NO on a single-team title is that team's other side; outcome labels win; two-team YES unknown", JSON.stringify(legOfIntent({ directionRaw: "No", marketTitle: "Will FC Barcelona win on 2026-10-25?" })) === '{"team":"FC Barcelona","no":true}' && JSON.stringify(legOfIntent({ direction: "YES", marketTitle: "Will FC Barcelona win on 2026-10-25?" })) === '{"team":"FC Barcelona","no":false}' && JSON.stringify(legOfIntent({ directionRaw: "Gen.G", marketTitle: "LoL: Gen.G vs LYON (BO3) - Worlds Group Stage" })) === '{"team":"Gen.G","no":false}' && legOfIntent({ direction: "YES", marketTitle: "Bills vs. Rams" }) === null);
  // soccer: three Yes/No markets per match; tennis: a plain two-sided moneyline
  const raw = { events: [
    { title: "FC Barcelona vs. Real Madrid CF", startDate: "2026-10-25T15:15:00Z", markets: [
      { slug: "atc-lal-bar-rea-2026-10-25-bar", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_DRAWABLE_OUTCOME", sportsMarketType: "soccer_team_full_time_winner", marketSides: [{ team: { name: "FC Barcelona" }, description: "Yes", long: true }, { team: { name: "FC Barcelona" }, description: "No", long: false }] },
      { slug: "atc-lal-bar-rea-2026-10-25-draw", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_DRAWABLE_OUTCOME", sportsMarketType: "soccer_team_full_time_winner", marketSides: [{ description: "Yes", long: true }, { description: "No", long: false }] },
      { slug: "atc-lal-bar-rea-2026-10-25-rea", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_DRAWABLE_OUTCOME", sportsMarketType: "soccer_team_full_time_winner", marketSides: [{ team: { name: "Real Madrid CF" }, description: "Yes", long: true }, { team: { name: "Real Madrid CF" }, description: "No", long: false }] } ] },
    { title: "RCD Espanyol de Barcelona vs. Sevilla FC", startDate: "2026-10-25T13:00:00Z", markets: [
      { slug: "atc-lal-esp-sev-2026-10-25-esp", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_DRAWABLE_OUTCOME", sportsMarketType: "soccer_team_full_time_winner", marketSides: [{ team: { name: "RCD Espanyol de Barcelona" }, description: "Yes", long: true }, { team: { name: "RCD Espanyol de Barcelona" }, description: "No", long: false }] },
      { slug: "atc-lal-esp-sev-2026-10-25-sev", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_DRAWABLE_OUTCOME", sportsMarketType: "soccer_team_full_time_winner", marketSides: [{ team: { name: "Sevilla FC" }, description: "Yes", long: true }, { team: { name: "Sevilla FC" }, description: "No", long: false }] } ] },
    { title: "Francisco Cerundolo vs. Tallon Griekspoor", startDate: "2026-10-24T16:30:00Z", markets: [{ slug: "aec-atp-fracer-talgri-2026-10-24", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE", sportsMarketType: "tennis_match_winner", marketSides: [{ team: { name: "Francisco Cerundolo" }, description: "Francisco Cerundolo", long: true }, { team: { name: "Tallon Griekspoor" }, description: "Tallon Griekspoor", long: false }] }] },
  ] };
  const ev = slimEvents(raw);
  const now = Date.parse("2026-10-25T14:00:00Z");
  const bar = matchUsEvent("lal", ev, "FC Barcelona", null, now), barNo = matchUsEvent("lal", ev, "FC Barcelona", null, now, "no"), rea = matchUsEvent("lal", ev, "Real Madrid CF", null, now);
  check("soccer: 'Will X win' routes to X's own full-time market, long for Yes and short for No; the exact club beats the Barcelona-suffixed one", ev.length === 3 && ev[0].drawable === true && ev[2].drawable === undefined && bar && bar.slug === "atc-lal-bar-rea-2026-10-25-bar" && bar.side === "long" && bar.opponent === "Real Madrid CF" && barNo.side === "short" && rea.slug === "atc-lal-bar-rea-2026-10-25-rea" && matchUsEvent("lal", ev, "Espanyol", null, now).slug === "atc-lal-esp-sev-2026-10-25-esp", JSON.stringify({ ev, bar, barNo, rea }));
  const t0 = Date.parse("2026-10-24T16:00:00Z");
  const ten = matchUsEvent("atp", ev, "Tallon Griekspoor", "Francisco Cerundolo", t0), tenNo = matchUsEvent("atp", ev, "Tallon Griekspoor", "Francisco Cerundolo", t0, "no");
  check("tennis: player names match the two-sided moneyline; NO flips to the other side; wrong opponent rejects", ten && ten.slug === "aec-atp-fracer-talgri-2026-10-24" && ten.side === "short" && tenNo.side === "long" && matchUsEvent("atp", ev, "Tallon Griekspoor", "Carlos Alcaraz", t0) === null, JSON.stringify([ten, tenNo]));
  // resolve across a league list with a mocked gateway: ATP empty, the challenger-qualifier league has the match
  const kv = new Map();
  const env = { SIGNALS_CACHE: { get: async (k) => { const v = kv.get(k); return v === undefined ? null : JSON.parse(v); }, put: async (k, v) => { kv.set(k, v); } } };
  const fetchMock = async (u) => {
    const url = String(u);
    if (url.includes("/v2/leagues/atp/events")) return { ok: true, json: async () => ({ events: [] }) };
    if (url.includes("/v2/leagues/atpcq/events")) return { ok: true, json: async () => ({ events: [raw.events[2]] }) };
    if (url.includes("/v2/leagues/lal/events")) return { ok: true, json: async () => raw };
    if (url.includes("/v2/leagues/lol/events")) return { ok: false, status: 503, json: async () => ({}) };
    if (url.includes("/v1/market/slug/")) return { ok: true, json: async () => ({ market: { orderPriceMinTickSize: 0.01, minimumTradeQty: 1, feeCoefficient: 0.0695, status: "MARKET_STATUS_OPEN" } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const r1 = await resolveUsMarket(env, { marketSlug: "atp-cerundo-grieksp-2026-10-24", marketTitle: "European Open: Francisco Cerundolo vs Tallon Griekspoor", directionRaw: "Francisco Cerundolo" }, { fetchImpl: fetchMock, nowMs: t0 });
  const r2 = await resolveUsMarket(env, { marketSlug: "lal-bar-rea-2026-10-25-rea", marketTitle: "Will Real Madrid CF win on 2026-10-25?", directionRaw: "No", direction: "NO" }, { fetchImpl: fetchMock, nowMs: now });
  const r3 = await resolveUsMarket(env, { marketSlug: "lol-gen-ly-2026-10-25-game2", marketTitle: "LoL: Gen.G vs LYON - Game 2 Winner", directionRaw: "Gen.G" }, { fetchImpl: fetchMock, nowMs: now });
  const r4 = await resolveUsMarket(env, { marketSlug: "col-tra-hmi-2026-10-22", marketTitle: "Will Trabzonspor win on 2026-10-22?", directionRaw: "Yes" }, { fetchImpl: fetchMock, nowMs: now });
  const r5 = await resolveUsMarket(env, { marketSlug: "lol-gen-ly-2026-10-25", marketTitle: "LoL: Gen.G vs LYON (BO3) - Worlds Group Stage", directionRaw: "Gen.G" }, { fetchImpl: fetchMock, nowMs: now });
  check("resolve: second league in the list found the tennis match; soccer NO is the short side of the club's market; game winners, unmapped prefixes and a gateway outage give reasons", r1.ok && r1.league === "atpcq" && r1.side === "long" && r1.slug === "aec-atp-fracer-talgri-2026-10-24" && r2.ok && r2.slug === "atc-lal-bar-rea-2026-10-25-rea" && r2.side === "short" && r2.drawable === true && !r3.ok && /not a moneyline market \(sub-market\)/.test(r3.reason) && !r4.ok && /league not routable \(col/.test(r4.reason) && !r5.ok && /routing error: polymarket.us gateway 503/.test(r5.reason), JSON.stringify([r1, r2, r3, r4, r5]));
}
// ---- book math ----
{
  const book = { bids: [{ price: 0.40, size: 100 }, { price: 0.39, size: 50 }], offers: [{ price: 0.42, size: 80 }, { price: 0.43, size: 10 }] };
  const bl = usLevels(book, "BUY", "long"), bs = usLevels(book, "BUY", "short"), sl = usLevels(book, "SELL", "long"), ss = usLevels(book, "SELL", "short");
  check("levels: BUY long = offers at ask; BUY short = bids at 1-bid; SELL long = bids; SELL short = offers at 1-ask", bl[0].price === 0.42 && bl[0].yesPrice === 0.42 && bs[0].price === 0.6 && bs[0].yesPrice === 0.4 && sl[0].price === 0.4 && ss[0].price === 0.58 && ss[0].yesPrice === 0.42, JSON.stringify({ bl, bs, sl, ss }));
  check("intent names", orderIntent("BUY", "long") === "ORDER_INTENT_BUY_LONG" && orderIntent("BUY", "short") === "ORDER_INTENT_BUY_SHORT" && orderIntent("SELL", "long") === "ORDER_INTENT_SELL_LONG" && orderIntent("SELL", "short") === "ORDER_INTENT_SELL_SHORT");
  check("yes price: long is the price, short is 1 - price", yesPriceFor("long", 0.42) === 0.42 && yesPriceFor("short", 0.6) === 0.4);
  check("rounding: lifting offers rounds the YES price up, hitting bids rounds down; clamped inside (0,1)", roundYesPrice(0.4133, 0.01, "BUY", "long") === 0.42 && roundYesPrice(0.4133, 0.01, "SELL", "short") === 0.42 && roundYesPrice(0.4133, 0.01, "BUY", "short") === 0.41 && roundYesPrice(0.4133, 0.01, "SELL", "long") === 0.41 && roundYesPrice(0.0001, 0.01, "SELL", "long") === 0.01 && roundYesPrice(0.9999, 0.01, "BUY", "long") === 0.99);
  check("qty: floored to the minimum step", roundQty(24.39, 1) === 24 && roundQty(24.39, 0.01) === 24.39 && roundQty(0.6, 1) === 0);
  const o = buildUsOrder({ slug: "aec-nfl-buf-lar", action: "BUY", side: "short", effectivePrice: 0.6, tick: 0.01, quantity: 24.39, minQty: 1 });
  check("order: FOK limit in YES terms (short at cost 0.60 = YES 0.40), automatic, synchronous", o.marketSlug === "aec-nfl-buf-lar" && o.intent === "ORDER_INTENT_BUY_SHORT" && o.type === "ORDER_TYPE_LIMIT" && o.price.value === "0.40" && o.price.currency === "USD" && o.quantity === 24 && o.tif === "TIME_IN_FORCE_FILL_OR_KILL" && o.manualOrderIndicator === "MANUAL_ORDER_INDICATOR_AUTOMATIC" && o.synchronousExecution === true && o.maxBlockTime === "5", JSON.stringify(o));
  check("order: tick 0.001 keeps three decimals", buildUsOrder({ slug: "s", action: "BUY", side: "long", effectivePrice: 0.4133, tick: 0.001, quantity: 10, minQty: 0.01 }).price.value === "0.414");
  check("fee: 0.0695 x p(1-p) per contract", Math.abs(usFeePerContract(0.5) - 0.017375) < 1e-9 && Math.abs(usFeePerContract(0.5, 0.10) - 0.025) < 1e-9);
  const f = fillFromExecutions([{ lastShares: 10, lastPx: { value: "0.40" }, commissionNotionalCollected: { value: "0.17" } }, { lastShares: 14, lastPx: { value: "0.42" }, commissionNotionalCollected: { value: "0.24" } }], "long");
  check("fill from executions: vwap, fee summed; short side flips the price", f.shares === 24 && Math.abs(f.avgYesPx - 0.4117) < 1e-4 && Math.abs(f.effectivePx - 0.4117) < 1e-4 && f.feeUsd === 0.41 && Math.abs(fillFromExecutions([{ lastShares: 5, lastPx: { value: "0.40" } }], "short").effectivePx - 0.6) < 1e-9 && fillFromExecutions([], "long") === null, JSON.stringify(f));
  const fo = fillFromOrder({ state: "ORDER_STATE_FILLED", cumQuantity: 24, avgPx: { value: "0.41" }, commissionNotionalTotalCollected: { value: "0.4" } }, "long");
  check("fill from order: state, cum quantity, avg price; unfilled keeps the state", fo.shares === 24 && fo.effectivePx === 0.41 && fo.feeUsd === 0.4 && fo.state === "ORDER_STATE_FILLED" && fillFromOrder({ state: "ORDER_STATE_CANCELED", cumQuantity: 0 }, "long").state === "ORDER_STATE_CANCELED");
}
// ---- end to end routing with a mocked gateway + KV cache ----
{
  const kv = new Map(); let gwCalls = 0;
  const env = { SIGNALS_CACHE: { get: async (k) => { const v = kv.get(k); return v === undefined ? null : JSON.parse(v); }, put: async (k, v) => { kv.set(k, v); } }, PMUS_KEY_ID: "k", PMUS_SECRET_KEY: Buffer.alloc(32, 7).toString("base64") };
  const fetchMock = async (u) => {
    const url = String(u); gwCalls++;
    if (url.includes("/v2/leagues/nfl/events")) return { ok: true, json: async () => ({ events: [{ title: "BUF Bills vs. LA Rams", startDate: "2026-10-26T00:15:00Z", markets: [{ slug: "aec-nfl-buf-lar-2026-10-25", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE", marketSides: [{ description: "Rams", long: false, team: { name: "Los Angeles Rams" } }, { description: "Bills", long: true, team: { name: "Buffalo Bills" } }] }] }] }) };
    if (url.includes("/v1/market/slug/aec-nfl-buf-lar-2026-10-25")) return { ok: true, json: async () => ({ market: { slug: "aec-nfl-buf-lar-2026-10-25", orderPriceMinTickSize: 0.01, minimumTradeQty: 1, feeCoefficient: 0.0695, status: "MARKET_STATUS_OPEN" } }) };
    if (url.includes("/v1/markets/aec-nfl-buf-lar-2026-10-25/book")) return { ok: true, json: async () => ({ marketData: { bids: [{ px: { value: "0.40" }, qty: "100" }], offers: [{ px: { value: "0.42" }, qty: "80" }] } }) };
    if (url.includes("/v1/account/balances")) return { ok: true, status: 200, json: async () => ({ balances: [{ currency: "USD", currentBalance: 150, buyingPower: 140.5, assetNotional: 9.5, openOrders: 0, lastUpdated: "2026-10-25T00:00:00Z" }] }) };
    if (url.includes("/v1/portfolio/positions")) return { ok: true, status: 200, json: async () => ({ positions: { "aec-nfl-buf-lar-2026-10-25": { netPositionDecimal: "24" } } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const now = Date.parse("2026-10-25T22:00:00Z");
  const intent = { marketSlug: "nfl-buf-lar-2026-10-25", marketTitle: "Bills vs. Rams", directionRaw: "Rams", direction: "YES" };
  const r = await resolveUsMarket(env, intent, { fetchImpl: fetchMock, nowMs: now });
  check("resolve: league, game and side found; market details attached", r.ok && r.slug === "aec-nfl-buf-lar-2026-10-25" && r.side === "short" && r.tick === 0.01 && r.minQty === 1 && r.feeCoef === 0.0695 && r.opponent === "Buffalo Bills", JSON.stringify(r));
  const callsBefore = gwCalls;
  const r2 = await resolveUsMarket(env, { ...intent, directionRaw: "Bills" }, { fetchImpl: fetchMock, nowMs: now + 60e3 });
  check("resolve: second lookup served from the KV cache (no gateway calls), long side", r2.ok && r2.side === "long" && gwCalls === callsBefore, JSON.stringify({ gwCalls, callsBefore }));
  const bad = await resolveUsMarket(env, { marketSlug: "btc-updown-5m-1", marketTitle: "Bitcoin Up or Down" }, { fetchImpl: fetchMock, nowMs: now });
  const bad2 = await resolveUsMarket(env, { marketSlug: "nfl-mia-nyj-2026-10-27", marketTitle: "Dolphins vs. Jets", directionRaw: "Jets" }, { fetchImpl: fetchMock, nowMs: now });
  check("resolve: unroutable league and unmatched game give reasons, never throw", !bad.ok && /league not routable/.test(bad.reason) && !bad2.ok && /no Polymarket US NFL moneyline for Jets vs Dolphins/.test(bad2.reason), JSON.stringify([bad, bad2]));
  const pre = await resolveUsMarket(env, { usSlug: "aec-nfl-buf-lar-2026-10-25", usSide: "long" }, { fetchImpl: fetchMock, nowMs: now });
  check("resolve: a pre-routed intent (exit) reuses its slug and side", pre.ok && pre.slug === "aec-nfl-buf-lar-2026-10-25" && pre.side === "long");
  const book = await fetchUsBook("aec-nfl-buf-lar-2026-10-25", { fetchImpl: fetchMock });
  check("book: bids/offers parsed from px.value and qty", book.bids[0].price === 0.4 && book.bids[0].size === 100 && book.offers[0].price === 0.42);
  const bal = await usBalances(env, { fetchImpl: fetchMock });
  check("balances: USD row with buying power", bal.currency === "USD" && bal.buyingPower === 140.5 && bal.currentBalance === 150);
  check("position qty by slug", (await usPositionQty(env, "aec-nfl-buf-lar-2026-10-25", { fetchImpl: fetchMock })) === 24);
}
console.log(`polymarket-us: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

// Polymarket US adapter. Run with: node test/polymarket-us.test.mjs
import { generateKeyPairSync, verify as nodeVerify, createPublicKey } from "node:crypto";
import { signingMessage, decodeSecret, seedToPkcs8, importPmusKey, pmusHeaders, pmusRequest, pmusConfigured, leagueOf, teamsOfTitle, teamOfIntent, slimEvents, matchUsEvent, resolveUsMarket, fetchUsBook, usLevels, orderIntent, yesPriceFor, roundYesPrice, roundQty, buildUsOrder, usFeePerContract, fillFromExecutions, fillFromOrder, usBalances, usPositionQty, PmusError } from "../src/polymarket-us.js";
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

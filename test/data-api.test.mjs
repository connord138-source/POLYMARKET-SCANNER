// Polymarket Data API v2 behind the v1 shapes (src/data-api.js). Run with: node test/data-api.test.mjs
import { dataApi, v2Request, v1Row, camel, DATA_API, V2_PAGE_MAX, FEED_TTL_MS, FEED_BLOCK_MS, RETRY_MAX, SCAN_HISTORY_MAX, _resetFeedCache, dataApiStats, describeFailure, pushScanHistory, scanHistorySummary } from "../src/data-api.js";
const noSleep = async () => {};
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => JSON.stringify(b) });

// ---------- pure: request mapping ----------
{
  const t = v2Request(`${DATA_API}/trades?limit=5000`);
  check("trades: /v2/trades, page capped at 1000, 5000 wanted, no status", t.path === "/v2/trades" && t.params.get("limit") === "1000" && t.want === 5000 && t.statuses.length === 1 && t.statuses[0] === null, t);
  const m = v2Request(`${DATA_API}/trades?market=0xabc&limit=300`);
  check("trades: market -> condition (v2 rejects market)", m.params.get("condition") === "0xabc" && !m.params.has("market") && m.params.get("limit") === "300", m.params.toString());
  const a = v2Request("/activity?user=0xWALLET&limit=200");
  check("activity: user kept, a bare path accepted", a.path === "/v2/activity" && a.params.get("user") === "0xWALLET" && a.want === 200);
  const p = v2Request(`${DATA_API}/positions?user=0xw&limit=500&offset=500&sizeThreshold=0`);
  check("positions: offset and sizeThreshold=0 dropped, open and redeemable read (what v1 listed)", p.path === "/v2/positions" && !p.params.has("offset") && !p.params.has("sizeThreshold") && !p.params.has("filter_amount") && p.statuses.join() === "OPEN,REDEEMABLE" && p.want === 500, p.params.toString());
  const ps = v2Request(`${DATA_API}/positions?user=0xw&sizeThreshold=5`);
  check("positions: a size threshold becomes the TOKENS filter; no limit -> 100", ps.params.get("filter_type") === "TOKENS" && ps.params.get("filter_amount") === "5" && ps.want === 100);
  const c = v2Request(`${DATA_API}/closed-positions?user=0xw&limit=50&offset=100`);
  check("closed-positions: /v2/positions?status=CLOSED", c.path === "/v2/positions" && c.statuses.join() === "CLOSED" && !c.params.has("offset"));
  check("passthrough: /v2 routes and unknown v1 routes go straight to fetch", v2Request(`${DATA_API}/v2/user-pnl?user=0xw&interval=all`).passthrough === `${DATA_API}/v2/user-pnl?user=0xw&interval=all` && v2Request(`${DATA_API}/events/some-slug`).passthrough === `${DATA_API}/events/some-slug`);
  check("takerOnly maps to taker_only", v2Request(`${DATA_API}/trades?takerOnly=false&limit=10`).params.get("taker_only") === "false" && V2_PAGE_MAX === 1000);
}

// ---------- pure: row conversion ----------
{
  check("camel", camel("proxy_wallet") === "proxyWallet" && camel("usdc_size") === "usdcSize" && camel("slug") === "slug" && camel("profile_image_optimized") === "profileImageOptimized");
  const trade = v1Row({ proxy_wallet: "0xA", side: "BUY", token_id: "123", condition_id: "0xc", size: 200, price: 0.95, timestamp: 1793665069, title: "T", slug: "s", event_slug: "e", outcome: "No", outcome_index: 1, name: "n", pseudonym: "p", transaction_hash: "0xh" });
  check("trade row: camelCase keys, token_id also served as asset (v1)", trade.proxyWallet === "0xA" && trade.conditionId === "0xc" && trade.eventSlug === "e" && trade.outcomeIndex === 1 && trade.transactionHash === "0xh" && trade.asset === "123" && trade.tokenId === "123" && trade.size === 200, trade);
  const pos = v1Row({ token_id: "9", current_size: 2957.79, avg_price: 0.6172, entry_cost_usdc: 1825.6, current_price: 0.5015, current_value: 1483.33, total_size: 2957.79, realized_pnl: 0, unrealized_pnl: -342.27, total_pnl: -342.27, percent_pnl: -18.7, status: "OPEN", redeemable: false, end_date: "2026-11-02", opposite_token_id: "8", opposite_outcome: "B", condition_id: "0xc", slug: "s", outcome: "A" });
  check("position row: v1 names the worker reads (size, curPrice, currentValue, initialValue, cashPnl, realizedPnl, avgPrice, endDate, totalBought, asset)", pos.size === 2957.79 && pos.curPrice === 0.5015 && pos.currentValue === 1483.33 && pos.initialValue === 1825.6 && pos.cashPnl === -342.27 && pos.realizedPnl === 0 && pos.avgPrice === 0.6172 && pos.endDate === "2026-11-02" && pos.totalBought === 2957.79 && pos.asset === "9" && pos.oppositeAsset === "8" && pos.redeemable === false && pos.conditionId === "0xc", pos);
  const act = v1Row({ type: "TRADE", side: "SELL", usdc_size: 173.67, size: 10, price: 0.5, transaction_hash: "0xt", token_id: "5", timestamp: 1793664634 });
  check("activity row: type/side/usdcSize/transactionHash/asset", act.type === "TRADE" && act.usdcSize === 173.67 && act.transactionHash === "0xt" && act.asset === "5");
  check("an alias never overwrites a real key", v1Row({ token_id: "1", asset: "keep" }).asset === "keep" && v1Row(null) === null);
}

// ---------- the drop-in: paging, statuses, errors, legacy bodies ----------
{
  const calls = [];
  const page = (n, from, hasMore, cursor) => ({ data: Array.from({ length: n }, (_, i) => ({ proxy_wallet: `w${from + i}`, size: from + i })), pagination: { has_more: hasMore, next_cursor: hasMore ? cursor : null, limit: n, offset: from } });
  const fetchImpl = async (u) => {
    const url = new URL(u); calls.push(url.pathname + "?" + url.searchParams.toString());
    const cur = url.searchParams.get("cursor");
    if (url.pathname === "/v2/trades") return json(cur === "c2" ? page(500, 2000, false, null) : cur === "c1" ? page(1000, 1000, true, "c2") : page(1000, 0, true, "c1"));
    if (url.pathname === "/v2/positions") { const st = url.searchParams.get("status"); return json(st === "OPEN" ? page(2, 0, false, null) : st === "REDEEMABLE" ? page(3, 10, false, null) : st === "CLOSED" ? page(1, 100, false, null) : page(0, 0, false, null)); }
    if (url.pathname === "/v2/activity") return json({ error: "nope" }, 500);
    return json({}, 404);
  };
  const t = await dataApi(`${DATA_API}/trades?limit=2300`, { fetchImpl, sleep: noSleep });
  const rows = await t.json();
  check("trades: three pages followed by cursor until the v1 limit, trimmed to it, rows in v1 shape", t.ok && rows.length === 2300 && rows[0].proxyWallet === "w0" && rows[2299].proxyWallet === "w2299" && calls.filter(c => c.startsWith("/v2/trades")).length === 3 && calls[0] === "/v2/trades?limit=1000" && /cursor=c1/.test(calls[1]) && /cursor=c2/.test(calls[2]), { n: rows.length, calls });
  calls.length = 0;
  const p = await dataApi(`${DATA_API}/positions?user=0xw&limit=500&offset=0`, { fetchImpl, sleep: noSleep });
  const prow = await p.json();
  check("positions: OPEN then REDEEMABLE, one list like v1, no offset sent", p.ok && prow.length === 5 && prow[0].size === 0 && prow[2].size === 10 && calls.length === 2 && /status=OPEN/.test(calls[0]) && /status=REDEEMABLE/.test(calls[1]) && !/offset/.test(calls[0]), { prow, calls });
  calls.length = 0;
  const c = await dataApi(`${DATA_API}/closed-positions?user=0xw&limit=50&offset=50`, { fetchImpl, sleep: noSleep });
  check("closed-positions: status=CLOSED", c.ok && (await c.json()).length === 1 && /status=CLOSED/.test(calls[0]), calls);
  const e = await dataApi(`${DATA_API}/activity?user=0xw&limit=100`, { fetchImpl, sleep: noSleep });
  check("a failed first page: ok false with the venue's status, like fetch", e.ok === false && e.status === 500 && (await e.json()) === null);
  _resetFeedCache();
  const legacy = await dataApi(`${DATA_API}/trades?limit=10`, { fetchImpl: async () => json([{ proxyWallet: "old", slug: "s" }]), sleep: noSleep });
  check("a bare-array body (v1-shaped test mock) is passed through untouched", (await legacy.json())[0].proxyWallet === "old");
  let seen = null;
  const pt = await dataApi(`${DATA_API}/v2/user-pnl?user=0xw&interval=all&fidelity=1d`, { fetchImpl: async (u) => { seen = String(u); return json({ data: { points: [] } }); } });
  check("a /v2 URL passes straight through with its raw body", seen === `${DATA_API}/v2/user-pnl?user=0xw&interval=all&fidelity=1d` && (await pt.json()).data.points.length === 0);
  // a later page failing keeps what was read
  let n = 0;
  _resetFeedCache();
  const partial = await dataApi(`${DATA_API}/trades?limit=1500`, { fetchImpl: async () => (++n === 1 ? json(page(1000, 0, true, "c1")) : json({}, 503)), sleep: noSleep });
  check("a later page failing keeps the rows already read", partial.ok && (await partial.json()).length === 1000);
}

// ---------- rate limits: retries with a wait, and the shared global feed ----------
{
  const page = (n, from, hasMore, cursor) => ({ data: Array.from({ length: n }, (_, i) => ({ proxy_wallet: `w${from + i}` })), pagination: { has_more: hasMore, next_cursor: hasMore ? cursor : null } });
  const json = (b, status = 200, headers = {}) => ({ ok: status < 400, status, json: async () => b, text: async () => JSON.stringify(b), headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
  _resetFeedCache();
  let tries = 0; const waits = [];
  const r = await dataApi(`${DATA_API}/trades?limit=10`, { fetchImpl: async () => (++tries < 3 ? json({ error: "rate limited" }, 429, { "retry-after": "2" }) : json(page(10, 0, false, null))), sleep: async (ms) => { waits.push(ms); } });
  check("429: retried after a wait (Retry-After honoured), then served", r.ok && (await r.json()).length === 10 && tries === 3 && waits.length === 2 && waits[0] === 2000 && waits[1] >= 2000, { tries, waits });
  _resetFeedCache();
  let hard = 0;
  const h = await dataApi(`${DATA_API}/activity?user=0xw&limit=5`, { fetchImpl: async () => { hard++; return json({ error: "rate limited" }, 429); }, sleep: noSleep });
  check("429 on every try: gives up after RETRY_MAX retries with ok false 429", h.ok === false && h.status === 429 && hard === RETRY_MAX + 1, { hard });
  // the global feed: one paged read serves every smaller read in the window; a filtered read never touches it
  _resetFeedCache();
  let calls = 0;
  const feed = async (u) => { calls++; const cur = new URL(u).searchParams.get("cursor"); return json(cur === "c1" ? page(1000, 1000, false, null) : page(1000, 0, true, "c1")); };
  const a = await dataApi(`${DATA_API}/trades?limit=2000`, { fetchImpl: feed, sleep: noSleep, nowMs: 1_000_000 });
  const b = await dataApi(`${DATA_API}/trades?limit=500`, { fetchImpl: feed, sleep: noSleep, nowMs: 1_005_000 });
  const c = await dataApi(`${DATA_API}/trades?limit=2000`, { fetchImpl: feed, sleep: noSleep, nowMs: 1_010_000 });
  check("global feed: the 2000-row read paid two requests; the later 500 and 2000 reads in the window paid none", (await a.json()).length === 2000 && (await b.json()).length === 500 && (await b.json())[0].proxyWallet === "w0" && (await c.json()).length === 2000 && calls === 2, { calls });
  const d = await dataApi(`${DATA_API}/trades?limit=3000`, { fetchImpl: feed, sleep: noSleep, nowMs: 1_012_000 });
  check("global feed: a bigger read than the one cached is fetched fresh", (await d.json()).length === 2000 && calls === 4, { calls });
  const e = await dataApi(`${DATA_API}/trades?limit=100`, { fetchImpl: feed, sleep: noSleep, nowMs: 1_012_000 + FEED_TTL_MS + 1 });
  check("global feed: the window expires", (await e.json()).length === 100 && calls === 5, { calls });
  const before = calls;
  await dataApi(`${DATA_API}/trades?user=0xw&limit=100`, { fetchImpl: feed, sleep: noSleep, nowMs: 1_012_000 });
  await dataApi(`${DATA_API}/trades?market=0xc&limit=100`, { fetchImpl: feed, sleep: noSleep, nowMs: 1_012_000 });
  check("a user or market read is never served from the global feed", calls === before + 2, { calls });
}

// ---------- Nov 3 2026: the block after a refusal, the age rule, the stats ----------
{
  const page = (n, from, hasMore, cursor) => ({ data: Array.from({ length: n }, (_, i) => ({ proxy_wallet: `w${from + i}` })), pagination: { has_more: hasMore, next_cursor: hasMore ? cursor : null } });
  const json = (b, status = 200, headers = {}) => ({ ok: status < 400, status, json: async () => b, text: async () => (typeof b === "string" ? b : JSON.stringify(b)), headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
  // a refused global read blocks the path: the next readers fail at once, nothing is sent
  _resetFeedCache();
  let calls = 0;
  const refused = async () => { calls++; return json("<html><body>error code: 1015</body></html>", 429, { "retry-after": "30" }); };
  const r1 = await dataApi(`${DATA_API}/trades?limit=5000`, { fetchImpl: refused, sleep: noSleep, nowMs: 2_000_000 });
  check("refused after the retries: ok false 429, Retry-After and the tries carried", r1.ok === false && r1.status === 429 && r1.retryAfter === 30 && r1.attempts === RETRY_MAX + 1 && calls === RETRY_MAX + 1, { r1, calls });
  const r2 = await dataApi(`${DATA_API}/trades?limit=2000`, { fetchImpl: refused, sleep: noSleep, nowMs: 2_005_000 });
  check("a later global read in the block fails at once: no request, blocked flagged", r2.ok === false && r2.status === 429 && r2.blocked === true && r2.blockedAgoS === 5 && calls === RETRY_MAX + 1, { r2, calls });
  const r3 = await dataApi(`${DATA_API}/trades?market=0xc&limit=300`, { fetchImpl: refused, sleep: noSleep, nowMs: 2_006_000 });
  check("a filtered read of the same path is blocked too (the limit is per path)", r3.ok === false && r3.blocked === true && calls === RETRY_MAX + 1, { r3, calls });
  const other = await dataApi(`${DATA_API}/activity?user=0xw&limit=5`, { fetchImpl: async () => json(page(2, 0, false, null)), sleep: noSleep, nowMs: 2_006_000 });
  check("another path is not blocked", other.ok && (await other.json()).length === 2);
  const d2 = await describeFailure(r2);
  check("describeFailure names the block", /not retried: \/v2\/trades throttled 5s ago/.test(d2) && /retry-after 30s/.test(d2), d2);
  const d1 = await describeFailure(r1);
  check("describeFailure carries the tries, Retry-After and the body with tags stripped", /4 tries/.test(d1) && /retry-after 30s/.test(d1) && /error code: 1015/.test(d1) && !/<html>/.test(d1), d1);
  // the block is at least FEED_BLOCK_MS, longer when Retry-After says so (30s here: the floor applies)
  const r4 = await dataApi(`${DATA_API}/trades?limit=10`, { fetchImpl: async () => { calls++; return json(page(10, 0, false, null)); }, sleep: noSleep, nowMs: 2_000_000 + FEED_BLOCK_MS + 1 });
  check("the block lifts after FEED_BLOCK_MS and the read is sent", r4.ok && (await r4.json()).length === 10 && calls === RETRY_MAX + 2, { calls });
  // a long Retry-After stretches the block
  _resetFeedCache();
  await dataApi(`${DATA_API}/trades?limit=10`, { fetchImpl: async () => json({ e: 1 }, 429, { "retry-after": "90" }), sleep: noSleep, nowMs: 3_000_000 });
  const r5 = await dataApi(`${DATA_API}/trades?limit=10`, { fetchImpl: async () => json(page(1, 0, false, null)), sleep: noSleep, nowMs: 3_000_000 + 80_000 });
  const r6 = await dataApi(`${DATA_API}/trades?limit=10`, { fetchImpl: async () => json(page(1, 0, false, null)), sleep: noSleep, nowMs: 3_000_000 + 91_000 });
  check("a 90s Retry-After blocks for 90s", r5.ok === false && r5.blocked === true && r6.ok === true, { r5: r5.blocked, r6: r6.ok });
  // the retry wait honours Retry-After up to the cap
  _resetFeedCache();
  const waits = []; let n = 0;
  await dataApi(`${DATA_API}/trades?limit=10`, { fetchImpl: async () => (++n === 1 ? json({ e: 1 }, 429, { "retry-after": "30" }) : json(page(10, 0, false, null))), sleep: async (ms) => { waits.push(ms); } });
  check("a 30s Retry-After waits the cap (10s), not 4s and not 30s", waits.length === 1 && waits[0] === 10000, waits);
  // the cached feed is still served during a block, and the age rule
  _resetFeedCache();
  let fetched = 0;
  const feed = async () => { fetched++; return json(page(1000, 0, false, null)); };
  await dataApi(`${DATA_API}/trades?limit=1000`, { fetchImpl: feed, sleep: noSleep, nowMs: 4_000_000 });
  const young = await dataApi(`${DATA_API}/trades?limit=500`, { fetchImpl: feed, sleep: noSleep, nowMs: 4_000_000 + 100_000 });
  check("default readers accept a 100s-old feed (the venue's own edge serves 300s)", young.ok && young.cached === true && young.cacheAgeS === 100 && fetched === 1, { fetched, young: young.cached });
  const scan = await dataApi(`${DATA_API}/trades?limit=1000`, { fetchImpl: feed, sleep: noSleep, nowMs: 4_000_000 + 100_000, maxAgeMs: 60_000 });
  check("the scan (maxAgeMs 60s) refuses a 100s-old feed and reads fresh", scan.ok && !scan.cached && fetched === 2, { fetched });
  const old = await dataApi(`${DATA_API}/trades?limit=100`, { fetchImpl: feed, sleep: noSleep, nowMs: 4_000_000 + 100_000 + FEED_TTL_MS + 1 });
  check("FEED_TTL_MS is 4 minutes and still expires", FEED_TTL_MS === 240000 && old.ok && !old.cached && fetched === 3, { fetched });
  // stats
  _resetFeedCache();
  await dataApi(`${DATA_API}/trades?limit=1000`, { fetchImpl: feed, sleep: noSleep, nowMs: 5_000_000 });
  await dataApi(`${DATA_API}/trades?limit=100`, { fetchImpl: feed, sleep: noSleep, nowMs: 5_001_000 });
  await dataApi(`${DATA_API}/activity?user=0xw&limit=5`, { fetchImpl: refused, sleep: noSleep, nowMs: 5_002_000 });
  await dataApi(`${DATA_API}/activity?user=0xw&limit=5`, { fetchImpl: refused, sleep: noSleep, nowMs: 5_003_000 });
  const s = dataApiStats(5_010_000);
  check("dataApiStats: reads, served, blocked, throttled pages, the block with its remaining seconds, the feed's age, the last failure's body", s.reads === 4 && s.ok === 2 && s.served === 1 && s.failed === 2 && s.blocked === 1 && s.throttled === RETRY_MAX + 1 && s.requests === RETRY_MAX + 2 && s.blocked_paths["/v2/activity"] && s.blocked_paths["/v2/activity"].forS === 52 && s.feed && s.feed.rows === 1000 && s.feed.ageS === 10 && s.lastError && s.lastError.status === 429 && s.lastError.path === "/v2/activity" && /error code: 1015/.test(s.lastError.body) && s.lastError.retryAfter === 30, s);
  check("_resetFeedCache clears the block and the counters", (_resetFeedCache(), dataApiStats().reads === 0 && Object.keys(dataApiStats().blocked_paths).length === 0 && dataApiStats().feed === null));
}

// ---------- the scan's rolling record ----------
{
  let h = [];
  for (let i = 0; i < SCAN_HISTORY_MAX + 5; i++) h = pushScanHistory(h, { at: new Date(Date.UTC(2026, 10, 3, 0, 5 * i)).toISOString(), ok: i % 4 !== 3, signals: 100 + i, ms: 1000 + i });
  check("pushScanHistory keeps the last SCAN_HISTORY_MAX entries, newest last", h.length === SCAN_HISTORY_MAX && h[h.length - 1].signals === 100 + SCAN_HISTORY_MAX + 4 && pushScanHistory(null, { at: "x" }).length === 1 && pushScanHistory([{ at: "a" }, null, {}], { at: "b" }).length === 2, { n: h.length });
  const now = Date.parse("2026-11-03T04:30:00Z");
  const list = [
    { at: "2026-11-03T04:00:00Z", ok: true, signals: 10, ms: 900 },
    { at: "2026-11-03T04:05:00Z", ok: true, signals: 12, ms: 1100 },
    { at: "2026-11-03T04:10:00Z", ok: false, signals: 12, ms: 8000, error: "Trades API error: 429 (4 tries)", cached: true },
    { at: "2026-11-03T04:15:00Z", ok: false, signals: 12, ms: 20, error: "Trades API error: 429 (not retried)", cached: true },
  ];
  const sum = scanHistorySummary(list, now);
  check("scanHistorySummary: cycles, ok rate, failure streak, last ok age, last error, avg ms, last 12", sum.cycles === 4 && sum.ok === 2 && sum.failed === 2 && sum.okRate === 0.5 && sum.failedStreak === 2 && sum.lastOkAt === "2026-11-03T04:05:00Z" && sum.lastOkAgoMin === 25 && sum.lastError.at === "2026-11-03T04:15:00Z" && /not retried/.test(sum.lastError.error) && sum.avgMs === 2505 && sum.last.length === 4 && sum.last[3].ok === false && sum.last[0].error === undefined, sum);
  const empty = scanHistorySummary(null, now);
  check("scanHistorySummary on nothing", empty.cycles === 0 && empty.okRate === null && empty.failedStreak === 0 && empty.lastOkAt === null && empty.last.length === 0, empty);
}

console.log(`data-api: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

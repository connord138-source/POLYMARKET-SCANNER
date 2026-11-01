// Polymarket US stale-quote scalp lane. Run with: node test/scalp.test.mjs
import { runScalpLane, scalpReport, scalpEntryFor, scalpExitPrice, scalpPnl, scalpConfig, scalpModeFor, scalpModes, sanitizeScalpUpdates, summarizeScalps, setScalpHalt, SCALP_DEFAULTS, SCALP_KEYS } from "../src/scalp.js";
import { generateKeyPairSync } from "node:crypto";
import { rtPnlC } from "../src/us-lane.js";
import { usFee, kalshiFee, KALSHI_TAKER_RATE } from "../src/xvenue.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const kvStore = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, list: async ({ prefix } = {}) => ({ keys: [...m.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })) }) }; };
const COLS = ["id", "mode", "ts_entry", "ts_exit", "sport", "game", "team", "us_slug", "side", "entry_px", "exit_px", "shares", "usd", "fee_entry_usd", "fee_exit_usd", "pnl_c", "pnl_usd", "edge_c", "dp_c", "shown_qty", "hold_s", "exit_kind", "live", "order_id", "exit_order_id", "note", "venue", "k_ticker"];
const d1 = () => { const rows = []; return { rows, prepare: (sql) => ({ bind: (...args) => ({ run: async () => { if (/INSERT/.test(sql)) { const r = Object.fromEntries(COLS.map((c, i) => [c, args[i]])); const i = rows.findIndex(x => x.id === r.id); if (i >= 0) rows[i] = r; else rows.push(r); } return { success: true }; }, all: async () => ({ results: rows.filter(r => r.ts_entry >= args[0]).sort((a, b) => b.ts_entry - a.ts_entry) }) }), run: async () => ({ success: true }) }) }; };
const mkEnv = (extra = {}) => ({ SIGNALS_CACHE: kvStore(), DB: d1(), ...extra });
const T0 = Date.parse("2026-11-01T01:00:00Z");
const leg = (bid, ask, extra = {}) => ({ ts: Math.floor(T0 / 1000), sport: "nba", game: "Lakers vs. Celtics", team: "Lakers", p_token: "tok", us_slug: "nba-lal-bos", us_long: true, p_bid: 0.45, p_ask: 0.46, us_bid: bid, us_ask: ask, us_bid_qty: 300, us_ask_qty: 300, ...extra });
const ev = (extra = {}) => ({ ts: Math.floor(T0 / 1000), sport: "nba", game: "Lakers vs. Celtics", team: "Lakers", pToken: "tok", usSlug: "nba-lal-bos", pBid: 0.45, pAsk: 0.46, pMid: 0.455, dpC: 4, side: "buy", px: 0.40, qty: 300, fee: usFee(0.40), edgeC: 2.5, ...extra });

// ---------- pure ----------
{
  const cfg = scalpConfig({});
  check("config: defaults, dry by default", cfg.scalpMode === "dry" && cfg.scalpMaxUsd === 10 && cfg.scalpHoldMin === 5 && cfg.scalpMinQty === 50);
  const d = scalpEntryFor(ev(), { cfg, open: [], day: {}, nowMs: T0 });
  check("entry: $10 at 40c = 25 contracts long, fee on 25", d.ok && d.shares === 25 && d.side === "long" && d.usd === 10 && Math.abs(d.feeEntryUsd - usFee(0.4) * 25) < 0.01, d);
  const sell = scalpEntryFor(ev({ side: "sell", px: 0.60, qty: 8 }), { cfg: { ...cfg, scalpMinQty: 1 }, open: [], day: {}, nowMs: T0 });
  check("entry: a sell event buys the short at 1 - bid; size bounded by the shares shown", sell.ok && sell.side === "short" && sell.cost === 0.4 && sell.shares === 8 && sell.usd === 3.2, sell);
  const reasons = [
    [scalpEntryFor(ev({ usSlug: null }), { cfg }).reason, "no Polymarket US market"],
    [scalpEntryFor(ev({ edgeC: 0.5 }), { cfg }).reason, "edge under 1c"],
    [scalpEntryFor(ev({ qty: 20 }), { cfg }).reason, "under 50 shares shown"],
    [scalpEntryFor(ev({ px: 0.03 }), { cfg }).reason, "price outside 5-95c"],
    [scalpEntryFor(ev(), { cfg, open: [{ sport: "x", game: "a" }, { sport: "x", game: "b" }, { sport: "x", game: "c" }] }).reason, "max open scalps"],
    [scalpEntryFor(ev(), { cfg, open: [{ sport: "nba", game: "Lakers vs. Celtics" }] }).reason, "already in this game"],
    [scalpEntryFor(ev(), { cfg, day: { entries: 40 } }).reason, "daily scalp cap"],
    [scalpEntryFor(ev(), { cfg, day: { pnlUsd: -15 } }).reason, "daily loss stop"],
    [scalpEntryFor(ev(), { cfg: { ...cfg, scalpSports: ["nhl"] } }).reason, "sport not in the lane"],
    [scalpEntryFor(ev({ qty: 60, px: 0.9 }), { cfg: { ...cfg, scalpMaxUsd: 0.5 } }).reason, "size below one contract"],
  ];
  check("entry: every gate names itself", reasons.every(([got, want]) => got === want), reasons.filter(([g, w]) => g !== w));
  check("exit price: a buy closes at the bid, a sell at the ask, missing -> null", scalpExitPrice({ side: "buy" }, leg(0.43, 0.45)) === 0.43 && scalpExitPrice({ side: "sell" }, leg(0.43, 0.45)) === 0.45 && scalpExitPrice({ side: "buy" }, leg(null, 0.45)) === null && scalpExitPrice({ side: "buy" }, null) === null);
  const p = scalpPnl({ side: "buy", px: 0.40, shares: 25 }, 0.44);
  check("pnl: both fees, cents a share x shares", p && p.pnlC === rtPnlC({ side: "buy", px: 0.40, fee: usFee(0.40) }, 0.44) && Math.abs(p.pnlUsd - p.pnlC / 100 * 25) < 0.011, p);
  const s = sanitizeScalpUpdates({ scalpMode: "live", scalpMaxUsd: "500", scalpMaxOpen: 0, scalpHoldMin: "x", scalpSports: ["NBA", "nhl"], bogus: 1, scalpMinEdgeC: 2 });
  check("sanitize: clamped, bad numbers dropped, sports lowercased, unknown keys dropped", s.scalpMode === "live" && s.scalpMaxUsd === 200 && s.scalpMaxOpen === 1 && !("scalpHoldMin" in s) && s.scalpSports.join() === "nba,nhl" && !("bogus" in s) && s.scalpMinEdgeC === 2, s);
  check("sanitize: a bad mode is dropped; an empty sports list means all", !("scalpMode" in sanitizeScalpUpdates({ scalpMode: "yolo" })) && sanitizeScalpUpdates({ scalpSports: [] }).scalpSports === null);
  check("mode: off / dry / live needs the key", scalpModeFor({}, { scalpMode: "off" }).mode === "off" && scalpModeFor({}, { scalpMode: "live" }).mode === "dry" && /not on the worker/.test(scalpModeFor({}, { scalpMode: "live" }).liveBlocked) && scalpModeFor({ PMUS_KEY_ID: "k", PMUS_SECRET_KEY: "s" }, { scalpMode: "live" }).mode === "live");
  const sum = summarizeScalps([{ sport: "nba", mode: "dry", exitKind: "x5", usd: 10, pnlUsd: 0.5, pnlC: 2, feeEntryUsd: 0.4, feeExitUsd: 0.4 }, { sport: "nba", mode: "dry", exitKind: "x5", usd: 10, pnlUsd: -0.3, pnlC: -1.2, feeEntryUsd: 0.4, feeExitUsd: 0.4 }, { sport: "nhl", mode: "live", exitKind: "settling", usd: 8, pnlUsd: null, pnlC: null }]);
  check("summary: priced vs unpriced, hit rate, fees, by sport / kind / mode", sum.all.n === 3 && sum.all.priced === 2 && sum.all.wins === 1 && sum.all.hitRate === 0.5 && sum.all.pnlUsd === 0.2 && sum.all.feesUsd === 1.6 && sum.all.avgPnlC === 0.4 && sum.bySport.nhl.priced === 0 && sum.byKind.settling.n === 1 && sum.byMode.live.n === 1, sum);
}

// ---------- dry, end to end over the minutes ----------
{
  const env = mkEnv();
  const cfg = {};
  const m = (k) => T0 + k * 60e3;
  const r1 = await runScalpLane(env, { events: [ev()], legs: [leg(0.40, 0.40)], nowMs: m(0), config: cfg });
  const open1 = JSON.parse(env.SIGNALS_CACHE.m.get(SCALP_KEYS.OPEN));
  check("dry minute 0: one scalp opened at the stale ask for 25 contracts, exit due in 5 min, nothing sent", r1.mode === "dry" && r1.entries === 1 && r1.open === 1 && open1.length === 1 && open1[0].px === 0.40 && open1[0].shares === 25 && open1[0].exitAtMs === m(5) && open1[0].live === false, r1);
  const r2 = await runScalpLane(env, { events: [ev({ edgeC: 3 })], legs: [leg(0.43, 0.45)], nowMs: m(2), config: cfg });
  const open2 = JSON.parse(env.SIGNALS_CACHE.m.get(SCALP_KEYS.OPEN));
  check("dry minute 2: still holding, marked at the bid, the same game not entered twice", r2.entries === 0 && r2.skipped["already in this game"] === 1 && open2.length === 1 && open2[0].lastBid === 0.43 && open2[0].markC === rtPnlC({ side: "buy", px: 0.40, fee: usFee(0.40) }, 0.43), { r2, open2 });
  const r5 = await runScalpLane(env, { events: [], legs: [leg(0.44, 0.46)], nowMs: m(5), config: cfg });
  const open5 = JSON.parse(env.SIGNALS_CACHE.m.get(SCALP_KEYS.OPEN));
  const want = scalpPnl({ side: "buy", px: 0.40, shares: 25 }, 0.44);
  const row = env.DB.rows[0];
  const day = JSON.parse(env.SIGNALS_CACHE.m.get(SCALP_KEYS.DAY + "2026-11-01"));
  check("dry minute 5: closed at the bid, both fees, recorded in D1 and the day", r5.exits === 1 && open5.length === 0 && row && row.exit_kind === "x5" && row.exit_px === 0.44 && Math.abs(row.pnl_usd - want.pnlUsd) < 0.011 && row.pnl_c === want.pnlC && row.live === 0 && row.hold_s === 300 && day.exits === 1 && day.wins === 1 && Math.abs(day.pnlUsd - want.pnlUsd) < 0.011, { r5, row, day });
  const rep = await scalpReport(env, cfg, { nowMs: m(6) });
  check("report: mode, record from D1, today, nothing open, read text", rep.mode === "dry" && rep.all.n === 1 && rep.all.wins === 1 && rep.all.hitRate === 1 && rep.recent.length === 1 && rep.recent[0].exitKind === "x5" && rep.open.length === 0 && rep.today.entries === 1 && /kill switch/.test(rep.read), { all: rep.all, today: rep.today });
  // no quote at the hold: wait the grace period, then close at the last quote seen
  const env2 = mkEnv();
  await runScalpLane(env2, { events: [ev()], legs: [leg(0.40, 0.40)], nowMs: m(0), config: cfg });
  await runScalpLane(env2, { events: [], legs: [leg(0.42, 0.44)], nowMs: m(3), config: cfg });
  const g1 = await runScalpLane(env2, { events: [], legs: [], nowMs: m(5), config: cfg });
  const g2 = await runScalpLane(env2, { events: [], legs: [], nowMs: m(14), config: cfg });
  const g3 = await runScalpLane(env2, { events: [], legs: [], nowMs: m(15), config: cfg });
  check("dry, no quote at the hold: holds through the grace period, then closes at the last quote seen (late_last_quote)", g1.exits === 0 && g2.exits === 0 && g3.exits === 1 && env2.DB.rows[0].exit_kind === "late_last_quote" && env2.DB.rows[0].exit_px === 0.42, { g1, g2, g3, row: env2.DB.rows[0] });
  // caps over a day: max open 3, one per game, daily cap, loss stop
  const env3 = mkEnv();
  const evs = ["a", "b", "c", "d"].map(g => ev({ game: `G${g}`, team: `T${g}`, usSlug: `s-${g}`, edgeC: 2 }));
  const c1 = await runScalpLane(env3, { events: evs, legs: [], nowMs: m(0), config: cfg });
  check("caps: three open at most, the fourth waits", c1.entries === 3 && c1.skipped["max open scalps"] === 1, c1);
  const c2 = await runScalpLane(env3, { events: [ev({ game: "Gz", usSlug: "s-z" })], legs: [], nowMs: m(1), config: { scalpMaxPerDay: 3, scalpMaxOpen: 10 } });
  check("caps: the daily cap counts the day's entries", c2.entries === 0 && c2.skipped["daily scalp cap"] === 1, c2);
  env3.SIGNALS_CACHE.m.set(SCALP_KEYS.DAY + "2026-11-01", JSON.stringify({ date: "2026-11-01", entries: 1, exits: 1, wins: 0, pnlUsd: -16, feesUsd: 1 }));
  const c3 = await runScalpLane(env3, { events: [ev({ game: "Gz", usSlug: "s-z" })], legs: [], nowMs: m(2), config: { scalpMaxOpen: 10 } });
  check("caps: the day's loss stop", c3.entries === 0 && c3.skipped["daily loss stop"] === 1, c3);
  // off, halt
  const off = await runScalpLane(mkEnv(), { events: [ev()], legs: [], nowMs: m(0), config: { scalpMode: "off" } });
  check("off: nothing happens, mode reported", off.mode === "off" && off.entries === 0);
  const env4 = mkEnv(); await setScalpHalt(env4, true, "test");
  const h = await runScalpLane(env4, { events: [ev()], legs: [], nowMs: m(0), config: cfg });
  check("halt: no entries while halted, reported", h.entries === 0 && h.skipped["lane halted"] === 1 && h.halted === true, h);
  const blocked = await runScalpLane(mkEnv(), { events: [], legs: [], nowMs: m(0), config: { scalpMode: "live" } });
  check("live asked without the key: runs dry and says why", blocked.mode === "dry" && blocked.liveAsked && /not on the worker/.test(blocked.liveBlocked), blocked);
}

// ---------- live, against a fake venue ----------
{
  const calls = [];
  const execs = (shares, px) => [{ lastShares: String(shares), lastPx: { value: String(px) }, commissionNotionalCollected: { value: "0.17" } }];
  let closeMode = "ok";
  const fetchImpl = async (url, init = {}) => {
    const u = String(url); calls.push({ u, method: (init.method || "GET"), body: init.body ? JSON.parse(init.body) : null });
    const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => JSON.stringify(b), headers: { get: () => null } });
    if (/gateway\.polymarket\.us\/v1\/market\/slug\//.test(u)) return json({ market: { orderPriceMinTickSize: "0.01", minimumTradeQty: "1", status: "MARKET_STATUS_OPEN" } });
    if (/\/v1\/portfolio\/positions/.test(u)) return json({ positions: { "nba-lal-bos": { netPositionDecimal: closeMode === "ok" ? "0" : "25" } } });   // after a refused close the contracts are still held
    if (/\/v1\/orders$/.test(u)) return json({ id: "o-entry", executions: execs(25, 0.40) });
    if (/\/v1\/order\/close-position/.test(u)) { if (closeMode === "ok") return json({ id: "o-exit", executions: execs(25, 0.44) }); if (closeMode === "closed") return json({ message: "market is closed" }, 400); return json({ message: "boom" }, 503); }
    return json({}, 404);
  };
  const env = mkEnv({ PMUS_KEY_ID: "key-1", PMUS_SECRET_KEY: Buffer.alloc(32, 9).toString("base64") });
  const cfg = { scalpMode: "live" };
  const m = (k) => T0 + k * 60e3;
  const r1 = await runScalpLane(env, { events: [ev()], legs: [leg(0.40, 0.40)], nowMs: m(0), config: cfg, fetchImpl });
  const open1 = JSON.parse(env.SIGNALS_CACHE.m.get(SCALP_KEYS.OPEN));
  const order = calls.find(c => /\/v1\/orders$/.test(c.u));
  check("live entry: a FOK limit for 25 long contracts at 40c is sent and its fill recorded on the open scalp", r1.mode === "live" && r1.entries === 1 && open1.length === 1 && open1[0].live === true && open1[0].orderId === "o-entry" && open1[0].px === 0.40 && open1[0].shares === 25 && open1[0].feeEntryUsd === 0.17 && order && order.method === "POST" && order.body.marketSlug === "nba-lal-bos" && order.body.intent === "ORDER_INTENT_BUY_LONG" && order.body.price.value === "0.40" && order.body.quantity === 25 && order.body.tif === "TIME_IN_FORCE_FILL_OR_KILL", { r1, open1, order: order && order.body });
  const r5 = await runScalpLane(env, { events: [], legs: [leg(0.44, 0.46)], nowMs: m(5), config: cfg, fetchImpl });
  const row = env.DB.rows[0];
  check("live exit: close-position sent at the hold, the venue's fill priced the exit, fees from the venue", r5.exits === 1 && calls.some(c => /close-position/.test(c.u)) && row && row.exit_kind === "x_live" && row.exit_px === 0.44 && row.live === 1 && row.exit_order_id === "o-exit" && row.fee_exit_usd === 0.17 && row.mode === "live", { r5, row });
  // the venue refuses the close (market over): the scalp is marked settling, not retried forever
  closeMode = "closed";
  await runScalpLane(env, { events: [ev({ game: "G2", team: "T2", usSlug: "nba-lal-bos" })], legs: [], nowMs: m(10), config: cfg, fetchImpl });
  const r15 = await runScalpLane(env, { events: [], legs: [], nowMs: m(15), config: cfg, fetchImpl });
  check("live exit refused as closed: recorded as settling, P&L left to the venue", r15.exits === 1 && env.DB.rows.some(r => r.exit_kind === "settling"), { r15, kinds: env.DB.rows.map(r => r.exit_kind) });
  // the close errors out three times: the lane halts itself and keeps holding
  closeMode = "err";
  await runScalpLane(env, { events: [ev({ game: "G3", team: "T3", usSlug: "nba-lal-bos" })], legs: [], nowMs: m(20), config: cfg, fetchImpl });
  let last = null; for (let i = 0; i < 3; i++) last = await runScalpLane(env, { events: [], legs: [], nowMs: m(25 + i), config: cfg, fetchImpl });
  const halt = JSON.parse(env.SIGNALS_CACHE.m.get(SCALP_KEYS.HALT));
  check("live exit failing three times: the lane halts itself, the position stays on the book", last.halted === true && halt.halted && /exit of nba-lal-bos failed 3 times/.test(halt.why) && last.open === 1, { last, halt });
  const after = await runScalpLane(env, { events: [ev({ game: "G4", team: "T4", usSlug: "nba-lal-bos" })], legs: [], nowMs: m(30), config: cfg, fetchImpl });
  check("halted: no new entries", after.entries === 0 && after.skipped["lane halted"] === 1, after);
}

// ---------- Kalshi venue (Nov 1 2026, the Kalshi NHL scalp lane) ----------
const kleg = (bid, ask, extra = {}) => ({ ts: Math.floor(T0 / 1000), sport: "nhl", game: "Devils vs. Capitals", team: "Devils", p_token: "tokk", us_slug: null, us_long: false, p_bid: 0.45, p_ask: 0.46, us_bid: null, us_ask: null, us_bid_qty: null, us_ask_qty: null, k_ticker: "KXNHLGAME-26NOV01NJWAS-NJ", k_bid: bid, k_ask: ask, ...extra });
const kev = (extra = {}) => ({ venue: "kalshi", ts: Math.floor(T0 / 1000), sport: "nhl", game: "Devils vs. Capitals", team: "Devils", pToken: "tokk", kTicker: "KXNHLGAME-26NOV01NJWAS-NJ", usSlug: null, pBid: 0.45, pAsk: 0.46, pMid: 0.455, dpC: 4, qty: null, side: "buy", px: 0.40, fee: kalshiFee(0.40), edgeC: 3.3, ...extra });
{
  const cfg = scalpConfig({});
  check("kalshi config: dry by default, NHL only, $10 a scalp", cfg.scalpKalshiMode === "dry" && cfg.scalpKalshiSports.join() === "nhl" && cfg.scalpKalshiMaxUsd === 10);
  const d = scalpEntryFor(kev(), { cfg, open: [], day: {}, nowMs: T0 });
  check("kalshi entry: no size shown is fine, $10 at 40c = 25 YES contracts, Kalshi's fee", d.ok && d.venue === "kalshi" && d.shares === 25 && d.side === "long" && d.usd === 10 && Math.abs(d.feeEntryUsd - kalshiFee(0.4) * 25) < 0.01, d);
  const sell = scalpEntryFor(kev({ side: "sell", px: 0.60 }), { cfg: { ...cfg, scalpKalshiMaxUsd: 4 }, open: [], day: {}, nowMs: T0 });
  check("kalshi entry: a sell event buys NO at 1 - bid, sized by the Kalshi cap", sell.ok && sell.side === "short" && sell.cost === 0.4 && sell.shares === 10 && sell.usd === 4, sell);
  const reasons = [
    [scalpEntryFor(kev({ kTicker: null }), { cfg }).reason, "no Kalshi market"],
    [scalpEntryFor(kev({ sport: "nba" }), { cfg }).reason, "sport not in the lane"],
    [scalpEntryFor(kev({ sport: "nba" }), { cfg: { ...cfg, scalpKalshiSports: [] } }).ok, true],
    [scalpEntryFor(kev(), { cfg, open: [{ venue: "kalshi", sport: "x", game: "a" }, { venue: "kalshi", sport: "x", game: "b" }, { venue: "kalshi", sport: "x", game: "c" }] }).reason, "max open scalps"],
    [scalpEntryFor(kev(), { cfg, open: [{ sport: "x", game: "a" }, { sport: "x", game: "b" }, { sport: "x", game: "c" }] }).ok, true],
    [scalpEntryFor(kev(), { cfg, open: [{ sport: "nhl", game: "Devils vs. Capitals", usSlug: "us-1" }] }).reason, "already in this game"],
    [scalpEntryFor(kev(), { cfg, day: { entries: 40, byVenue: { us: { entries: 40 }, kalshi: { entries: 0 } } } }).ok, true],
    [scalpEntryFor(kev(), { cfg, day: { entries: 40, byVenue: { us: { entries: 0 }, kalshi: { entries: 40 } } } }).reason, "daily scalp cap"],
    [scalpEntryFor(kev(), { cfg, day: { pnlUsd: -15 } }).reason, "daily loss stop"],
  ];
  check("kalshi entry gates: its own market, its own sports (empty = all), open and daily caps per venue, US open scalps do not count, one per game across venues, the loss stop shared", reasons.every(([got, want]) => got === want), reasons.filter(([g, w]) => g !== w));
  check("kalshi exit price: a buy closes at Kalshi's bid, a sell at its ask", scalpExitPrice({ venue: "kalshi", side: "buy" }, kleg(0.43, 0.45)) === 0.43 && scalpExitPrice({ venue: "kalshi", side: "sell" }, kleg(0.43, 0.45)) === 0.45 && scalpExitPrice({ venue: "kalshi", side: "buy" }, kleg(null, 0.45)) === null && scalpExitPrice({ side: "buy" }, kleg(0.43, 0.45)) === null);
  const p = scalpPnl({ venue: "kalshi", side: "buy", px: 0.40, shares: 25 }, 0.44);
  check("kalshi pnl: both Kalshi taker fees", p && p.pnlC === rtPnlC({ side: "buy", px: 0.40, fee: kalshiFee(0.40) }, 0.44, KALSHI_TAKER_RATE) && Math.abs(p.feeExitUsd - kalshiFee(0.44) * 25) < 0.011, p);
  const s = sanitizeScalpUpdates({ scalpKalshiMode: "off", scalpKalshiMaxUsd: "900", scalpKalshiSports: "NHL, nba" });
  check("kalshi sanitize: mode, cap clamped, sports from a comma list; an empty list means all; a bad mode dropped", s.scalpKalshiMode === "off" && s.scalpKalshiMaxUsd === 200 && s.scalpKalshiSports.join() === "nhl,nba" && sanitizeScalpUpdates({ scalpKalshiSports: [] }).scalpKalshiSports.length === 0 && !("scalpKalshiMode" in sanitizeScalpUpdates({ scalpKalshiMode: "yes" })), s);
  const m = scalpModes({}, { scalpMode: "live", scalpKalshiMode: "live" });
  const km = scalpModes({ KALSHI_API_KEY_ID: "k", KALSHI_PRIVATE_KEY: "pem" }, { scalpMode: "dry", scalpKalshiMode: "dry" });
  check("mode: keyOnWorker says whether the venue's key is present even while dry", km.kalshi.keyOnWorker === true && km.us.keyOnWorker === false && scalpModes({}, { scalpMode: "dry", scalpKalshiMode: "off" }).kalshi.keyOnWorker === false, km);
  check("kalshi mode: live needs the Kalshi key, else dry and says why; the US venue is judged on its own key", m.kalshi.mode === "dry" && /KALSHI_API_KEY_ID/.test(m.kalshi.liveBlocked) && m.us.mode === "dry" && /PMUS_KEY_ID/.test(m.us.liveBlocked) && scalpModes({}, { scalpMode: "off", scalpKalshiMode: "dry" }).kalshi.mode === "dry", m);
  const sum = summarizeScalps([{ venue: "kalshi", sport: "nhl", mode: "dry", exitKind: "x5", usd: 10, pnlUsd: 0.5, pnlC: 2, feeEntryUsd: 0.4, feeExitUsd: 0.4 }, { sport: "nba", mode: "dry", exitKind: "x5", usd: 10, pnlUsd: -0.3, pnlC: -1.2, feeEntryUsd: 0.4, feeExitUsd: 0.4 }]);
  check("summary: byVenue splits the record, a row without a venue is US", sum.byVenue.kalshi.n === 1 && sum.byVenue.kalshi.pnlUsd === 0.5 && sum.byVenue.us.n === 1 && sum.byVenue.us.pnlUsd === -0.3, sum.byVenue);
}
{
  // dry, end to end: a stale Kalshi ask bought as YES, closed at Kalshi's bid five minutes later
  const env = mkEnv();
  const m = (k) => T0 + k * 60e3;
  const r1 = await runScalpLane(env, { events: [], kalshiEvents: [kev()], legs: [kleg(0.40, 0.40)], nowMs: m(0), config: {} });
  const open1 = JSON.parse(env.SIGNALS_CACHE.m.get(SCALP_KEYS.OPEN));
  check("kalshi dry minute 0: one scalp opened at the stale ask for 25 YES contracts, venue and ticker on it", r1.entries === 1 && r1.byVenue.kalshi.entries === 1 && r1.byVenue.us.entries === 0 && r1.kalshiEvents === 1 && open1.length === 1 && open1[0].venue === "kalshi" && open1[0].kTicker === "KXNHLGAME-26NOV01NJWAS-NJ" && open1[0].px === 0.40 && open1[0].shares === 25 && open1[0].shownQty === null && open1[0].live === false, { r1, open1 });
  const r2 = await runScalpLane(env, { events: [], kalshiEvents: [], legs: [kleg(0.43, 0.45)], nowMs: m(2), config: {} });
  const open2 = JSON.parse(env.SIGNALS_CACHE.m.get(SCALP_KEYS.OPEN));
  check("kalshi dry minute 2: marked at Kalshi's bid", r2.exits === 0 && open2[0].lastBid === 0.43 && open2[0].markC === rtPnlC({ side: "buy", px: 0.40, fee: kalshiFee(0.40) }, 0.43, KALSHI_TAKER_RATE), open2[0]);
  const r5 = await runScalpLane(env, { events: [], kalshiEvents: [], legs: [kleg(0.44, 0.46)], nowMs: m(5), config: {} });
  const row = env.DB.rows[0];
  const want = scalpPnl({ venue: "kalshi", side: "buy", px: 0.40, shares: 25 }, 0.44);
  const day = JSON.parse(env.SIGNALS_CACHE.m.get(SCALP_KEYS.DAY + "2026-11-01"));
  check("kalshi dry minute 5: closed at Kalshi's bid with both Kalshi fees, recorded with the venue, the day split by venue", r5.exits === 1 && r5.byVenue.kalshi.exits === 1 && row && row.venue === "kalshi" && row.k_ticker === "KXNHLGAME-26NOV01NJWAS-NJ" && row.exit_kind === "x5" && row.exit_px === 0.44 && row.pnl_c === want.pnlC && Math.abs(row.pnl_usd - want.pnlUsd) < 0.011 && day.byVenue.kalshi.exits === 1 && day.byVenue.kalshi.pnlUsd === want.pnlUsd && day.exits === 1 && day.pnlUsd === want.pnlUsd, { row, day });
  const rep = await scalpReport(env, {}, { nowMs: m(6) });
  check("report: modes per venue, byVenue, the Kalshi row carries its venue and ticker, the read names both venues", rep.modes.kalshi.mode === "dry" && rep.kalshi.mode === "dry" && rep.byVenue.kalshi.n === 1 && rep.recent[0].venue === "kalshi" && rep.recent[0].kTicker === "KXNHLGAME-26NOV01NJWAS-NJ" && /Kalshi/.test(rep.read) && rep.config.scalpKalshiSports.join() === "nhl", { modes: rep.modes, byVenue: rep.byVenue });
  // both venues see the same game in the same minute: the bigger edge is taken, the other waits (one scalp per game across venues)
  const env2 = mkEnv();
  const both = await runScalpLane(env2, { events: [ev({ sport: "nhl", game: "Devils vs. Capitals", team: "Devils", edgeC: 2 })], kalshiEvents: [kev({ edgeC: 3.3 })], legs: [], nowMs: m(0), config: {} });
  const open3 = JSON.parse(env2.SIGNALS_CACHE.m.get(SCALP_KEYS.OPEN));
  check("both venues, one game: the bigger edge (Kalshi) is taken, the US one is 'already in this game'", both.entries === 1 && open3[0].venue === "kalshi" && both.skipped["already in this game"] === 1, both);
  // the Kalshi venue off: its events are not even considered; the US venue runs
  const off = await runScalpLane(mkEnv(), { events: [ev()], kalshiEvents: [kev()], legs: [], nowMs: m(0), config: { scalpKalshiMode: "off" } });
  check("kalshi off: Kalshi events ignored, the US scalp still opens; both off = nothing", off.entries === 1 && off.byVenue.us.entries === 1 && off.byVenue.kalshi.entries === 0 && off.modes.kalshi.mode === "off" && (await runScalpLane(mkEnv(), { events: [ev()], kalshiEvents: [kev()], legs: [], nowMs: m(0), config: { scalpMode: "off", scalpKalshiMode: "off" } })).entries === 0, off);
  // an old open scalp without a venue is a US scalp
  const env4 = mkEnv();
  env4.SIGNALS_CACHE.m.set(SCALP_KEYS.OPEN, JSON.stringify([{ id: "old", sport: "nba", game: "Lakers vs. Celtics", team: "Lakers", usSlug: "nba-lal-bos", side: "buy", px: 0.40, shares: 25, usd: 10, feeEntryUsd: 0.42, entryMs: m(-5), exitAtMs: m(0), live: false }]));
  const old = await runScalpLane(env4, { events: [], kalshiEvents: [], legs: [leg(0.44, 0.46)], nowMs: m(0), config: {} });
  check("an open scalp from before venues is closed as a US scalp", old.exits === 1 && env4.DB.rows[0].venue === "us" && env4.DB.rows[0].exit_px === 0.44, env4.DB.rows[0]);
}
{
  // live, against a fake Kalshi: IOC bid at the stale ask, reduce-only IOC ask at the bid less slip, partial fills, refusals, halt
  const calls = [];
  let fillMode = "full";   // full | partial | none | err | closed
  let posQty = 0;
  const kPem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url); const body = init.body ? JSON.parse(init.body) : null; calls.push({ u, method: init.method || "GET", body });
    const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => JSON.stringify(b), headers: { get: () => null } });
    if (/\/portfolio\/positions\?/.test(u)) return json({ market_positions: posQty ? [{ ticker: "KXNHLGAME-26NOV01NJWAS-NJ", position_fp: String(posQty) }] : [], event_positions: [] });
    if (/\/portfolio\/events\/orders$/.test(u) && init.method === "POST") {
      if (fillMode === "err") return json({ message: "boom" }, 503);
      if (fillMode === "closed") return json({ message: "market is closed" }, 400);
      const want = Number(body.count);
      const got = fillMode === "full" ? want : fillMode === "partial" ? Math.floor(want / 2) : 0;
      if (body.side === "bid") posQty += got; else posQty -= got;
      return json({ order_id: `k-${calls.length}`, client_order_id: body.client_order_id, fill_count: got.toFixed(2), remaining_count: (want - got).toFixed(2), ...(got ? { average_fill_price: body.price, average_fee_paid: kalshiFee(Number(body.price)).toFixed(4) } : {}), ts_ms: 1 }, 201);
    }
    return json({}, 404);
  };
  const env = mkEnv({ KALSHI_API_KEY_ID: "kid", KALSHI_PRIVATE_KEY: kPem });
  const cfg = { scalpKalshiMode: "live" };
  const m = (k) => T0 + k * 60e3;
  const r1 = await runScalpLane(env, { events: [], kalshiEvents: [kev()], legs: [kleg(0.40, 0.40)], nowMs: m(0), config: cfg, fetchImpl });
  const open1 = JSON.parse(env.SIGNALS_CACHE.m.get(SCALP_KEYS.OPEN));
  const order = calls.find(c => /events\/orders$/.test(c.u) && c.method === "POST");
  check("kalshi live entry: an immediate-or-cancel bid for 25 YES at 0.40 is signed and sent; the fill and fee from the response land on the open scalp", r1.modes.kalshi.mode === "live" && r1.entries === 1 && order && order.body.ticker === "KXNHLGAME-26NOV01NJWAS-NJ" && order.body.side === "bid" && order.body.count === "25" && order.body.price === "0.40" && order.body.time_in_force === "immediate_or_cancel" && !order.body.reduce_only && open1[0].live === true && open1[0].orderId === "k-2" && open1[0].px === 0.40 && open1[0].shares === 25 && Math.abs(open1[0].feeEntryUsd - kalshiFee(0.40) * 25) < 0.02, { order, open1, r1 });
  const r5 = await runScalpLane(env, { events: [], kalshiEvents: [], legs: [kleg(0.44, 0.46)], nowMs: m(5), config: cfg, fetchImpl });
  const exit = calls.filter(c => /events\/orders$/.test(c.u) && c.method === "POST").pop();
  const row = env.DB.rows[0];
  check("kalshi live exit: a reduce-only IOC ask 3c under the bid, the venue's fill prices the exit", r5.exits === 1 && exit.body.side === "ask" && exit.body.price === "0.41" && exit.body.reduce_only === true && exit.body.count === "25" && row.exit_kind === "x_live" && row.exit_px === 0.41 && row.live === 1 && row.venue === "kalshi" && posQty === 0, { exit: exit.body, row });
  // a partial exit fill closes that part and keeps the rest for the next minute
  fillMode = "full";
  await runScalpLane(env, { events: [], kalshiEvents: [kev({ game: "G2", team: "T2", kTicker: "KXNHLGAME-26NOV01NJWAS-NJ" })], legs: [], nowMs: m(10), config: cfg, fetchImpl });
  fillMode = "partial";
  const p1 = await runScalpLane(env, { events: [], kalshiEvents: [], legs: [kleg(0.44, 0.46, { game: "G2", team: "T2" })], nowMs: m(15), config: cfg, fetchImpl });
  const openP = JSON.parse(env.SIGNALS_CACHE.m.get(SCALP_KEYS.OPEN));
  fillMode = "full";
  const p2 = await runScalpLane(env, { events: [], kalshiEvents: [], legs: [kleg(0.44, 0.46, { game: "G2", team: "T2" })], nowMs: m(16), config: cfg, fetchImpl });
  check("kalshi partial exit: 12 of 25 closed as x_live_part, 13 stay open and close the next minute", p1.exits === 1 && openP.length === 1 && openP[0].shares === 13 && env.DB.rows.some(r => r.exit_kind === "x_live_part" && r.shares === 12) && p2.exits === 1 && env.DB.rows.filter(r => r.game === "G2").length === 2 && posQty === 0, { p1, openP, kinds: env.DB.rows.map(r => [r.exit_kind, r.shares]) });
  // the venue refuses the close as closed while contracts are still held: settling
  await runScalpLane(env, { events: [], kalshiEvents: [kev({ game: "G3", team: "T3" })], legs: [], nowMs: m(20), config: cfg, fetchImpl });
  fillMode = "closed";
  const r25 = await runScalpLane(env, { events: [], kalshiEvents: [], legs: [kleg(0.44, 0.46, { game: "G3", team: "T3" })], nowMs: m(25), config: cfg, fetchImpl });
  check("kalshi exit refused as closed: recorded as settling", r25.exits === 1 && env.DB.rows.some(r => r.game === "G3" && r.exit_kind === "settling"), { r25, kinds: env.DB.rows.map(r => [r.game, r.exit_kind]) });
  // unfilled IOC exits three minutes running: the lane halts itself, the contracts stay
  fillMode = "full"; posQty = 0;
  await runScalpLane(env, { events: [], kalshiEvents: [kev({ game: "G4", team: "T4" })], legs: [], nowMs: m(30), config: cfg, fetchImpl });
  fillMode = "none";
  let last = null; for (let i = 0; i < 3; i++) last = await runScalpLane(env, { events: [], kalshiEvents: [], legs: [kleg(0.44, 0.46, { game: "G4", team: "T4" })], nowMs: m(35 + i), config: cfg, fetchImpl });
  const halt = JSON.parse(env.SIGNALS_CACHE.m.get(SCALP_KEYS.HALT));
  check("kalshi exit unfilled three times: the lane halts itself, the position stays", last.halted === true && halt.halted && /exit of KXNHLGAME-26NOV01NJWAS-NJ failed 3 times/.test(halt.why) && last.open === 1, { last, halt });
  // live asked without the Kalshi key: runs dry and says why
  const blocked = await runScalpLane(mkEnv(), { events: [], kalshiEvents: [kev()], legs: [], nowMs: m(0), config: cfg });
  check("kalshi live without the key: dry, the reason reported, the dry scalp still opens", blocked.modes.kalshi.mode === "dry" && blocked.modes.kalshi.liveAsked && /push-kalshi-key/.test(blocked.modes.kalshi.liveBlocked) && blocked.entries === 1, blocked.modes);
}

console.log(`scalp: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

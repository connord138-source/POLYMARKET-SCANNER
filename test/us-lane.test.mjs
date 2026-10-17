// Polymarket US stale-quote paper lane. Run with: node test/us-lane.test.mjs
import { detectUsLaneEvent, pnlC, marksFromSeries, settlementFromGamma, summarizeUsLane, recordUsLaneEvents, markUsLaneEvents, settleUsLaneEvents, usLaneReport, NO_DATA, FINAL_AFTER_S } from "../src/us-lane.js";
import { usFee } from "../src/xvenue.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const leg = (ts, p_bid, p_ask, us_bid, us_ask, extra = {}) => ({ ts, sport: "nhl", game: "Devils vs. Capitals", team: "Devils", p_token: "tok1", us_slug: "aec-nhl-nj-was", p_bid, p_ask, us_bid, us_ask, us_bid_qty: 1200, us_ask_qty: 800, ...extra });

{
  // +5c global move, US ask still 0.40: buy on US at 0.40, edge = 0.45 - 0.40 - fee(0.40)
  const ev = detectUsLaneEvent(leg(0, 0.40, 0.41, 0.39, 0.40), leg(60, 0.45, 0.46, 0.39, 0.40));
  check("detect: up-move -> buy at the US ask with its shown size", ev && ev.side === "buy" && ev.px === 0.40 && ev.qty === 800 && Math.abs(ev.edgeC - (0.05 - usFee(0.40)) * 100) < 0.01 && ev.dpC === 5 && ev.pMid === 0.455 && ev.pToken === "tok1", JSON.stringify(ev));
  // -5c global move, US bid still 0.45: sell on US at 0.45
  const dn = detectUsLaneEvent(leg(0, 0.45, 0.46, 0.45, 0.46), leg(60, 0.40, 0.41, 0.45, 0.46));
  check("detect: down-move -> sell at the US bid with the bid size", dn && dn.side === "sell" && dn.px === 0.45 && dn.qty === 1200 && Math.abs(dn.edgeC - (0.45 - 0.41 - usFee(0.45)) * 100) < 0.01 && dn.dpC === -5, JSON.stringify(dn));
  check("detect: a move the US book followed is not an event", detectUsLaneEvent(leg(0, 0.40, 0.41, 0.39, 0.40), leg(60, 0.45, 0.46, 0.44, 0.45)) === null);
  check("detect: a 1c edge below the fee is not an event", detectUsLaneEvent(leg(0, 0.40, 0.41, 0.39, 0.40), leg(60, 0.405, 0.415, 0.39, 0.40)) === null);
  check("detect: below moveC, a sample gap, or missing quotes -> null", detectUsLaneEvent(leg(0, 0.40, 0.41, 0.39, 0.40), leg(60, 0.42, 0.43, 0.39, 0.40)) === null && detectUsLaneEvent(leg(0, 0.40, 0.41, 0.39, 0.40), leg(600, 0.45, 0.46, 0.39, 0.40)) === null && detectUsLaneEvent(leg(0, 0.40, 0.41, null, null), leg(60, 0.45, 0.46, null, null)) === null && detectUsLaneEvent(null, leg(60, 0.45, 0.46, 0.39, 0.40)) === null);
  check("detect: moveC is configurable", detectUsLaneEvent(leg(0, 0.40, 0.41, 0.39, 0.40), leg(60, 0.42, 0.43, 0.39, 0.40), { moveC: 1.5 }) !== null);
}
{
  const buy = { side: "buy", px: 0.40, fee: usFee(0.40) };
  check("pnl: buy marked at 0.45 earns 5c less the entry fee; at settlement 1 earns 60c less fee", Math.abs(pnlC(buy, 0.45) - (5 - usFee(0.40) * 100)) < 0.01 && Math.abs(pnlC(buy, 1) - (60 - usFee(0.40) * 100)) < 0.01 && pnlC(buy, null) === null && pnlC(buy, NO_DATA) === null);
  check("pnl: sell marked lower earns", Math.abs(pnlC({ side: "sell", px: 0.45, fee: usFee(0.45) }, 0.41) - (4 - usFee(0.45) * 100)) < 0.01);
}
{
  const ev = { ts: 1000, side: "buy", px: 0.40, fee: 0.0167, m1: null, m5: null, m15: null, m60: null, final: null };
  const rows = [{ ts: 1060, p_bid: 0.44, p_ask: 0.45 }, { ts: 1300, p_bid: 0.46, p_ask: 0.47 }, { ts: 1920, p_bid: 0.50, p_ask: 0.51 }, { ts: 4600, p_bid: 0.60, p_ask: 0.61 }, { ts: 8000, p_bid: 0.90, p_ask: 0.92 }];
  const early = marksFromSeries(ev, rows, 1000 + 300 + 60);
  check("marks: only horizons that have passed (+60s slack) are filled, nearest sample within tolerance", early.m1 === 0.445 && early.m5 === 0.465 && !("m15" in early) && !("final" in early), JSON.stringify(early));
  const late = marksFromSeries(ev, rows, 1000 + FINAL_AFTER_S + 1);
  check("marks: m15 within 90s (1920 vs 1900), m60 picks 4600, final = last sample's mid", late.m15 === 0.505 && late.m60 === 0.605 && late.final === 0.91, JSON.stringify(late));
  const sparse = marksFromSeries({ ...ev }, [{ ts: 1060, p_bid: 0.44, p_ask: 0.45 }], 1000 + 3600 + 700);
  check("marks: a horizon with no sample nearby becomes NO_DATA once 10 min past it; already-set marks are untouched", sparse.m5 === NO_DATA && sparse.m15 === NO_DATA && sparse.m60 === NO_DATA && marksFromSeries({ ...ev, m1: 0.5 }, rows, 2000).m1 === undefined, JSON.stringify(sparse));
  check("marks: no later samples after the live window -> final NO_DATA", marksFromSeries(ev, [], 1000 + FINAL_AFTER_S + 1).final === NO_DATA);
}
{
  const mk = (closed, prices, extra = {}) => ({ closed, clobTokenIds: JSON.stringify(["tokA", "tokB"]), outcomePrices: JSON.stringify(prices), ...extra });
  check("settle: closed market pays 1 to the winning token, 0 to the loser", settlementFromGamma(mk(true, ["1", "0"]), "tokA") === 1 && settlementFromGamma(mk(true, ["1", "0"]), "tokB") === 0);
  check("settle: open market -> null; unknown token -> null; 50-50 close -> NO_DATA; arrays accepted", settlementFromGamma(mk(false, ["0.6", "0.4"]), "tokA") === null && settlementFromGamma(mk(true, ["1", "0"]), "tokZ") === null && settlementFromGamma(mk(true, ["0.5", "0.5"]), "tokA") === NO_DATA && settlementFromGamma({ closed: true, clobTokenIds: ["tokA", "tokB"], outcomePrices: ["0", "1"] }, "tokB") === 1 && settlementFromGamma(null, "tokA") === null);
  check("settle: umaResolutionStatus resolved counts as closed", settlementFromGamma(mk(false, ["1", "0"], { umaResolutionStatus: "resolved" }), "tokA") === 1);
}
{
  const f = usFee(0.40);
  const evs = [
    { sport: "nhl", side: "buy", px: 0.40, qty: 800, fee: f, edge_c: 3, m5: 0.45, m15: 0.50, final: 0.9, settle: 1 },
    { sport: "nhl", side: "buy", px: 0.40, qty: 200, fee: f, edge_c: 2, m5: 0.38, m15: NO_DATA, final: null, settle: 0 },
    { sport: "nba", side: "sell", px: 0.40, qty: null, fee: f, edge_c: 4, m5: 0.36, m15: 0.30, final: 0.1, settle: null },
  ];
  const s = summarizeUsLane(evs);
  check("summary: counts, sides, sizes, average edge", s.all.n === 3 && s.all.buy === 2 && s.all.sell === 1 && s.all.avgEdgeC === 3 && s.all.avgQty === 500 && s.all.medQty === 800 && s.bySport.nhl.n === 2 && s.bySport.nba.n === 1, JSON.stringify(s.all));
  const m5 = s.all.marks.m5;   // pnls: +5-f, -2-f, +4-f (cents) -> avg (7 - 3f)/3, 2 hits of 3
  check("summary: m5 average and hit rate after fee", m5.n === 3 && Math.abs(m5.avgC - (7 - 3 * f * 100) / 3) < 0.02 && Math.abs(m5.hitRate - 0.67) < 0.01 && m5.noData === 0, JSON.stringify(m5));
  check("summary: NO_DATA counted separately, nulls skipped, settlement averaged", s.all.marks.m15.n === 2 && s.all.marks.m15.noData === 1 && s.all.marks.final.n === 2 && s.all.marks.settle.n === 2 && Math.abs(s.all.marks.settle.avgC - ((60 - f * 100) + (-40 - f * 100)) / 2) < 0.02 && s.all.marks.settle.roiPct !== null, JSON.stringify(s.all.marks));
}
{
  // end to end with a mock D1 that stores events and quotes and answers the lane's queries
  const kv = new Map(); const events = []; const quotes = []; let nextId = 1; const updates = [];
  const env = {
    SIGNALS_CACHE: { get: async (k) => { const v = kv.get(k); return v === undefined ? null : JSON.parse(v); }, put: async (k, v) => { kv.set(k, v); } },
    DB: {
      prepare: (sql) => ({ bind: (...a) => ({
        sql, a,
        run: async () => { if (/UPDATE us_lane_events SET settle/.test(sql)) { for (const e of events) if (e.p_token === a[2] && e.settle == null) { e.settle = a[0]; e.settled_at = a[1]; } updates.push(a); } },
        all: async () => {
          if (/SELECT id, ts, game, team, side, px, fee/.test(sql)) return { results: events.filter(e => e.final == null && e.ts <= a[0] && (e.marked_at == null || e.marked_at <= a[1])).slice(0, a[2]) };
          if (/FROM xvenue_quotes WHERE game/.test(sql)) return { results: quotes.filter(r => r.game === a[0] && r.team === a[1] && r.ts > a[2] && r.ts <= a[3]) };
          if (/SELECT p_token, MIN\(ts\)/.test(sql)) { const m = new Map(); for (const e of events) if (e.settle == null && e.p_token && e.ts <= a[0]) m.set(e.p_token, Math.min(m.get(e.p_token) ?? 1e12, e.ts)); return { results: [...m].map(([p_token, first_ts]) => ({ p_token, first_ts })).slice(0, a[1]) }; }
          if (/FROM us_lane_events WHERE ts >=/.test(sql)) return { results: events.filter(e => e.ts >= a[0]).sort((x, y) => x.ts - y.ts) };
          return { results: [] };
        },
      }) }),
      batch: async (st) => { for (const s of st) {
        if (/INSERT INTO us_lane_events/.test(s.sql)) { const [ts, sport, game, team, p_token, us_slug, side, px, qty, fee, p_bid, p_ask, p_mid, dp_c, edge_c] = s.a; events.push({ id: nextId++, ts, sport, game, team, p_token, us_slug, side, px, qty, fee, p_bid, p_ask, p_mid, dp_c, edge_c, m1: null, m5: null, m15: null, m60: null, final: null, marked_at: null, settle: null }); }
        else if (/UPDATE us_lane_events SET/.test(s.sql)) { const cols = [...s.sql.matchAll(/(\w+) = \?/g)].map(m => m[1]); const e = events.find(x => x.id === s.a[s.a.length - 1]); cols.forEach((c, i) => { e[c] = s.a[i]; }); }
      } },
    },
  };
  const T = 1_760_000_000;
  const push = async (ts, pb, pa, ub, ua) => { quotes.push({ ts, game: "Devils vs. Capitals", team: "Devils", p_bid: pb, p_ask: pa }); return recordUsLaneEvents(env, [leg(ts, pb, pa, ub, ua)], ts * 1000); };
  const r0 = await push(T, 0.40, 0.41, 0.39, 0.40);
  const r1 = await push(T + 60, 0.45, 0.46, 0.39, 0.40);     // stale US ask -> event
  const r2 = await push(T + 120, 0.45, 0.46, 0.44, 0.45);    // US caught up, no move -> nothing
  check("record: first minute has nothing to compare, second minute logs one event, third none; prev blob rolls", r0.events === 0 && r0.compared === 0 && r1.events === 1 && r1.compared === 1 && r2.events === 0 && events.length === 1 && events[0].side === "buy" && events[0].qty === 800 && JSON.parse(kv.get("xv_prev")).legs["nhl|Devils vs. Capitals|Devils"].ts === T + 120, JSON.stringify({ r0, r1, r2, ev: events[0] }));
  for (const [dt, pb, pa] of [[300, 0.47, 0.48], [900, 0.50, 0.51], [3600, 0.55, 0.56]]) quotes.push({ ts: T + 60 + dt, game: "Devils vs. Capitals", team: "Devils", p_bid: pb, p_ask: pa });
  const m1 = await markUsLaneEvents(env, (T + 60 + 400) * 1000);
  check("mark: after 6.7 min, m1 and m5 are set (m1 from the T+120 sample), m15/m60/final wait", m1.due === 1 && m1.marked === 1 && events[0].m1 === 0.455 && events[0].m5 === 0.475 && events[0].m15 == null && events[0].final == null && events[0].marked_at === T + 460, JSON.stringify({ m1, ev: events[0] }));
  const m2 = await markUsLaneEvents(env, (T + 60 + 500) * 1000);
  check("mark: re-checked only after the marked_at cooldown", m2.due === 0, JSON.stringify(m2));
  const m3 = await markUsLaneEvents(env, (T + 60 + FINAL_AFTER_S + 5) * 1000);
  check("mark: at end of game m15, m60 and final land; the event leaves the due set", m3.marked === 1 && events[0].m15 === 0.505 && events[0].m60 === 0.555 && events[0].final === 0.555 && (await markUsLaneEvents(env, (T + 60 + FINAL_AFTER_S + 700) * 1000)).due === 0, JSON.stringify(events[0]));
  // settlement: Gamma says the Devils won
  let gammaUrl = "";
  const fetchMock = async (u) => { gammaUrl = String(u); return { ok: true, json: async () => [{ closed: true, clobTokenIds: JSON.stringify(["tok1", "tok2"]), outcomePrices: JSON.stringify(["1", "0"]) }] }; };
  const s0 = await settleUsLaneEvents(env, (T + 60 + 3600) * 1000, fetchMock);
  check("settle: not before 3h", s0.tokens === 0 && events[0].settle == null, JSON.stringify(s0));
  const s1 = await settleUsLaneEvents(env, (T + 60 + 4 * 3600) * 1000, fetchMock);
  check("settle: one Gamma call by token, event settled at 1", s1.tokens === 1 && s1.settled === 1 && events[0].settle === 1 && /clob_token_ids=tok1/.test(gammaUrl), JSON.stringify({ s1, gammaUrl }));
  const pendingFetch = async () => ({ ok: true, json: async () => [{ closed: false, clobTokenIds: JSON.stringify(["tok9"]), outcomePrices: JSON.stringify(["0.5"]) }] });
  events.push({ id: nextId++, ts: T - 11 * 86400, sport: "nba", game: "g2", team: "Lakers", p_token: "tok9", side: "buy", px: 0.5, qty: 10, fee: 0.017, edge_c: 2, m1: null, m5: null, m15: null, m60: null, final: NO_DATA, marked_at: null, settle: null });
  const s2 = await settleUsLaneEvents(env, (T + 60 + 4 * 3600) * 1000, pendingFetch);
  check("settle: an event unresolved after 10 days is voided (NO_DATA) without a Gamma call", s2.voided === 1 && events[1].settle === NO_DATA, JSON.stringify(s2));
  const rep = await usLaneReport(env, { hours: 24 * 14, nowMs: (T + 60 + 5 * 3600) * 1000 });
  check("report: counts, marks and the recent list", rep.events === 2 && rep.legs === 2 && rep.games === 2 && rep.all.marks.settle.n === 1 && Math.abs(rep.all.marks.settle.avgC - (60 - usFee(0.40) * 100)) < 0.02 && rep.all.marks.m15.n === 1 && rep.bySport.nhl.marks.final.n === 1 && rep.recent.length === 2 && rep.recent[0].sport === "nhl" && rep.recent[0].settleC > 50 && rep.prevAt && /Paper only/.test(rep.read), JSON.stringify({ all: rep.all, recent: rep.recent[0] }));
}
console.log(`us-lane: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

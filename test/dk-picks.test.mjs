// Does following the DraftKings value board make money? Record, grade,
// settle, ledger. Run with: node test/dk-picks.test.mjs
import { recordDkValuePicks, gradePick, winOn100, parseEspnFinals, settleDkPicks, dkPicksLedger, VALUE_EV_MIN } from "../src/dk-picks.js";
import { saveBrowserDkBoard } from "../src/crew.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
function makeEnv(store = {}) {
  const s = { ...store };
  return { store: s, SIGNALS_CACHE: {
    get: async (k, o) => (k in s ? (o && o.type === "json" ? JSON.parse(s[k]) : s[k]) : null),
    put: async (k, v) => { s[k] = v; }, delete: async (k) => { delete s[k]; },
  } };
}
const picksOf = (env) => JSON.parse(env.store.crew_dk_picks || "[]");
const row = (o) => ({ id: "nfl-gb-chi:sp:home", label: "Packers +1.5 (-105)", market: "spread", side: "home", team: "Green Bay Packers", line: 1.5,
  odds: -105, fair: 53.5, implied: 51.2, ev: 4.5, startTime: iso(NOW + 3 * 3600e3), sport: "nfl", espnId: "401", home: "Green Bay Packers", away: "Chicago Bears", game: "Bears vs. Packers", ...o });

// ---------- recording ----------
{
  const env = makeEnv();
  const n = await recordDkValuePicks(env, [
    row(),
    row({ id: "noise", ev: 0.6 }),                                   // inside the noise band
    row({ id: "started", startTime: iso(NOW - 60e3) }),              // already kicked off
    row({ id: "noid", espnId: null }),                               // can't be settled
    row({ id: "noline", market: "total", line: null }),
  ], NOW);
  check("record: only real value, pregame, settleable", n === 1 && picksOf(env)[0].id === "nfl-gb-chi:sp:home", JSON.stringify(picksOf(env).map(p => p.id)));
  const again = await recordDkValuePicks(env, [row({ odds: -120, ev: 3 })], NOW + 60e3);
  check("record: first sighting is the price, no duplicates", again === 0 && picksOf(env).length === 1 && picksOf(env)[0].odds === -105);
  check("value bar is +$1.50 per $100", VALUE_EV_MIN === 1.5);
}

// ---------- grading ----------
check("payout: -110 wins $90.91", Math.abs(winOn100(-110) - 90.909) < 0.01);
check("payout: +150 wins $150", winOn100(150) === 150);
{
  const sp = row();                                                  // Packers +1.5 at home
  check("spread: lose by 1 covers +1.5", gradePick(sp, { home: 20, away: 21 }).result === "win");
  check("spread: lose by 2 doesn't", gradePick(sp, { home: 20, away: 22 }).result === "loss");
  const fav = row({ side: "away", line: -3 });                       // Bears -3 on the road
  check("spread: win by exactly 3 = push", JSON.stringify(gradePick(fav, { home: 17, away: 20 })) === JSON.stringify({ result: "push", pnl: 0 }));
  const ml = row({ market: "moneyline", side: "away", line: null, odds: 140 });
  check("moneyline: road dog wins pays $140", JSON.stringify(gradePick(ml, { home: 10, away: 13 })) === JSON.stringify({ result: "win", pnl: 140 }));
  const over = row({ market: "total", side: "over", line: 46.5, odds: -105 });
  check("total: 47 points beats over 46.5", gradePick(over, { home: 24, away: 23 }).result === "win");
  const under = row({ market: "total", side: "under", line: 46.5 });
  check("total: under 46.5 loses at 47", JSON.stringify(gradePick(under, { home: 24, away: 23 })) === JSON.stringify({ result: "loss", pnl: -100 }));
}

// ---------- finals + settlement ----------
const espn = { events: [
  { id: "401", competitions: [{ status: { type: { completed: true } }, competitors: [{ homeAway: "home", score: "20" }, { homeAway: "away", score: "21" }] }] },
  { id: "402", competitions: [{ status: { type: { completed: false } }, competitors: [{ homeAway: "home", score: "7" }, { homeAway: "away", score: "3" }] }] },
] };
check("finals: completed games only", JSON.stringify(parseEspnFinals(espn)) === JSON.stringify({ "401": { home: 20, away: 21 } }));
{
  let calls = 0;
  globalThis.fetch = async (url) => { calls++; return { ok: true, json: async () => (String(url).includes("football/nfl") ? espn : { events: [] }) }; };
  const env = makeEnv({ crew_dk_picks: JSON.stringify([
    { ...row(), startTime: iso(NOW - 4 * 3600e3), result: null },                                         // final: win
    { ...row({ id: "live", espnId: "402" }), startTime: iso(NOW - 4 * 3600e3), result: null },            // not final yet
    { ...row({ id: "later" }), startTime: iso(NOW + 3600e3), result: null },                              // not started
    { ...row({ id: "ppd", espnId: "999" }), startTime: iso(NOW - 5 * 86400e3), result: null },            // postponed
  ]) });
  const r = await settleDkPicks(env, NOW);
  const ps = picksOf(env);
  check("settle: final graded at the recorded price", ps[0].result === "win" && Math.abs(ps[0].pnl - 95.24) < 0.01 && ps[0].final.home === 20, JSON.stringify(ps[0]));
  check("settle: unfinished + future left open", ps[1].result === null && ps[2].result === null);
  check("settle: no final after 4 days = void", ps[3].result === "void" && ps[3].pnl === 0);
  check("settle: counts", r.settled === 2 && r.pending === 2, JSON.stringify(r));
  calls = 0;
  await settleDkPicks(makeEnv({ crew_dk_picks: JSON.stringify([{ ...row(), result: null }]) }), NOW);
  check("settle: nothing due = no ESPN calls", calls === 0);
}

// ---------- ledger ----------
{
  const L = dkPicksLedger([
    { market: "spread", result: "win", pnl: 95.24, label: "a" },
    { market: "total", result: "loss", pnl: -100, label: "b" },
    { market: "moneyline", result: "win", pnl: 140, label: "c" },
    { market: "spread", result: "push", pnl: 0, label: "d" },
    { market: "spread", result: "void", pnl: 0, label: "e" },
    { market: "total", result: null, label: "f", startTime: iso(NOW + 3600e3) },
  ]);
  check("ledger: record + profit + roi", L.graded === 4 && L.wins === 2 && L.losses === 1 && L.pushes === 1 && L.pnl === 135.24 && L.roi === 33.8 && L.pending === 1, JSON.stringify(L));
  check("ledger: by market", L.byMarket.spread.wins === 1 && L.byMarket.spread.pushes === 1 && L.byMarket.total.losses === 1);
}

// ---------- the board upload records value picks ----------
{
  const env = makeEnv();
  const b = await saveBrowserDkBoard(env, [row(), row({ id: "fair", ev: 0.4 }), row({ id: "bad", side: "sideways", sport: "soccer" })]);
  check("upload: value row recorded with its settlement fields", b.recorded === 1 && picksOf(env)[0].espnId === "401" && picksOf(env)[0].side === "home" && picksOf(env)[0].line === 1.5, JSON.stringify(picksOf(env)));
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

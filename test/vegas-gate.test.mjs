// Vegas edge entries only open once the pregame lane (edge_lane_stats_v3)
// is proven. Run with: node test/vegas-gate.test.mjs
import { processSignals } from "../src/autotrader.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const SLUG = `nfl-kc-lv-${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`;

function makeEnv(extra = {}, cfg = {}) {
  const store = {
    autotrader_config: JSON.stringify({
      enabled: true, paperTradeMode: true, fixedSize: 10, minPositionSize: 2, maxPositionSize: 30,
      maxDailyTrades: 30, maxDailySpend: 300, maxOpenPositions: 15, useLearningData: false,
      favoritesExperiment: false, councilEnabled: false, vegasEdgeEntries: true, vegasEdgeMinEdge: 10,
      _liveV2Tuned: true, _v3ProfitOverhaul: true, _clearPositions: true, ...cfg,
    }),
    autotrader_positions: "[]",
    edge_opportunities: JSON.stringify([{
      id: "nfl:g1:home", sport: "nfl", game: "Raiders @ Chiefs", team: "Kansas City Chiefs",
      commenceTime: new Date(Date.now() + 3 * 3600e3).toISOString(), vegasProb: 62, polyPrice: 50, edgeNet: 12,
      polySlug: SLUG, honestFill: true, pregame: true, detectedAt: new Date().toISOString(), outcome: null,
    }]),
    ...extra,
  };
  return {
    store,
    SIGNALS_CACHE: {
      get: async (k, o) => (k in store ? (o && o.type === "json" ? JSON.parse(store[k]) : store[k]) : null),
      put: async (k, v) => { store[k] = v; }, delete: async (k) => { delete store[k]; }, list: async () => ({ keys: [] }),
    },
  };
}
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  if (u.includes("gamma-api") && u.includes(encodeURIComponent(SLUG))) {
    return json([{ slug: SLUG, clobTokenIds: '["t0","t1"]', outcomes: '["Kansas City Chiefs","Las Vegas Raiders"]',
      outcomePrices: '["0.50","0.50"]', closed: false, endDate: new Date(Date.now() + 6 * 3600e3).toISOString() }]);
  }
  if (u.includes("/midpoint")) return json({ t0: "0.50" });
  return json([]);
};
const posOf = (env) => JSON.parse(env.store.autotrader_positions || "[]");

// 1. No lane ledger -> no entry
{
  const env = makeEnv();
  const r = await processSignals(env, []);
  check("1: blocked", posOf(env).length === 0, JSON.stringify(posOf(env)));
  check("1: reason", r.vegasEdge && Object.keys(r.vegasEdge.skips).some(k => /lane unproven/.test(k)), JSON.stringify(r.vegasEdge));
}
// 2. Lane proven (n>=30, pnl>0) -> entry allowed
{
  const env = makeEnv({ edge_lane_stats_v3: JSON.stringify({ overall: { wins: 18, losses: 14, staked: 3200, pnl: 140 } }) });
  await processSignals(env, []);
  check("2: entered", posOf(env).length === 1, JSON.stringify(posOf(env)));
}
// 3. Lane losing -> blocked
{
  const env = makeEnv({ edge_lane_stats_v3: JSON.stringify({ overall: { wins: 14, losses: 20, staked: 3400, pnl: -300 } }) });
  await processSignals(env, []);
  check("3: losing lane blocked", posOf(env).length === 0);
}
// 4. Gate disabled -> legacy behavior
{
  const env = makeEnv({}, { vegasEdgeRequireProven: false });
  await processSignals(env, []);
  check("4: override", posOf(env).length === 1, JSON.stringify(posOf(env)));
}

console.log(`# ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

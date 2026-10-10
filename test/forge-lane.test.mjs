// Forge lane: promoted rules paper-trade matching signals; demotion; parity.
// Run with: node test/forge-lane.test.mjs
import { processSignals, forgeRuleLedger } from "../src/autotrader.js";
import { bucketSignal, matchesFilter } from "../src/forge.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const SLUG = `nba-bos-nyk-${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`;

// 1. Bucket boundaries match the SQL CASE thresholds
{
  const b = (o) => bucketSignal({ avgEntryPrice: 50, largestBet: 1000, numWallets: 1, score: 10, ...o });
  check("1: side 60 fav", b({ avgEntryPrice: 60 }).side === "fav60+");
  check("1: side 59 mid", b({ avgEntryPrice: 59 }).side === "mid40-59");
  check("1: side 39 dog", b({ avgEntryPrice: 39 }).side === "dog<40");
  check("1: size 50k", b({ largestBet: 50000 }).size === "50k+" && b({ largestBet: 49999 }).size === "20-50k");
  check("1: size 5k", b({ largestBet: 5000 }).size === "5-20k" && b({ largestBet: 4999 }).size === "<5k");
  check("1: wallets", b({ numWallets: 3 }).wallets === "3+" && b({ numWallets: 2 }).wallets === "1-2");
  check("1: score", b({ score: 100 }).score === "100+" && b({ score: 60 }).score === "60-99" && b({ score: 59 }).score === "<60");
  const t0 = "2026-10-10T00:00:00Z";
  check("1: horizon <6h", b({ detectedAt: t0, eventDate: "2026-10-10T06:00:00Z" }).horizon === "<6h");
  check("1: horizon 6h-2d", b({ detectedAt: t0, eventDate: "2026-10-11T00:00:00Z" }).horizon === "6h-2d");
  check("1: horizon 2d+", b({ detectedAt: t0, eventDate: "2026-10-13T00:00:00Z" }).horizon === "2d+");
  check("1: horizon unknown", b({}).horizon === "unknown");
  const we = (row) => bucketSignal({}, { wallets_logged: 1, wallet_scored_at: "x", ...row }).walletEdge;
  check("1: walletEdge", we({ wallet_best_n: 12, wallet_best_excess: 10 }) === "sharp10+" && we({ wallet_best_n: 12, wallet_best_excess: 3 }) === "edge3-10"
    && we({ wallet_best_n: 12, wallet_best_excess: -5 }) === "square" && we({ wallet_best_n: 12, wallet_best_excess: 0 }) === "flat"
    && we({ wallet_best_n: 9, wallet_best_excess: 30 }) === "thin");
  check("1: walletEdge nodata", bucketSignal({}, null).walletEdge === "nodata" && we({ wallets_logged: -1 }) === "nodata");
  check("1: matchesFilter", matchesFilter({ side: "fav60+", size: "5-20k" }, { side: "fav60+" }) && !matchesFilter({ side: "dog<40" }, { side: "fav60+" }));
}
// 2. Rule ledger
{
  const h = [
    { strategySource: "forge", forgeRule: "side=fav60+", outcome: "win", pnl: 2 },
    { strategySource: "forge", forgeRule: "side=fav60+", outcome: "loss", pnl: -5 },
    { strategySource: "forge", forgeRule: "other", outcome: "win", pnl: 9 },
    { strategySource: "vegas_edge", outcome: "win", pnl: 9 },
  ];
  const l = forgeRuleLedger(h, "side=fav60+");
  check("2: ledger", l.n === 2 && l.wins === 1 && l.pnl === -3, JSON.stringify(l));
}

// ---------- processSignals ----------
function makeEnv(extra = {}, cfg = {}) {
  const store = {
    autotrader_config: JSON.stringify({
      enabled: true, paperTradeMode: true, fixedSize: 10, minPositionSize: 2, maxPositionSize: 30,
      maxDailyTrades: 30, maxDailySpend: 300, maxOpenPositions: 15, useLearningData: false,
      favoritesExperiment: false, vegasEdgeEntries: false, councilEnabled: false,
      _liveV2Tuned: true, _v3ProfitOverhaul: true, _clearPositions: true, ...cfg,
    }),
    autotrader_positions: "[]",
    forge_report: JSON.stringify({ rules: { slippageCents: 2 }, promoted: [{ id: "side=fav60+", filter: { side: "fav60+" }, test: { roi: 5, n: 120 } }] }),
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
let livePx = "0.70";
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  if (u.includes("gamma-api") && u.includes(encodeURIComponent(SLUG))) {
    return json([{ slug: SLUG, clobTokenIds: '["t0","t1"]', outcomes: '["Yes","No"]',
      outcomePrices: JSON.stringify([livePx, String(1 - Number(livePx))]), closed: false, endDate: new Date(Date.now() + 5 * 3600e3).toISOString() }]);
  }
  if (u.includes("/midpoint")) return json({ t0: livePx });
  return json([]);
};
// A signal the whale gates REJECT (no winning wallet) but the forge rule matches.
const sig = (o = {}) => ({
  id: "sig1", marketSlug: SLUG, marketTitle: "Celtics vs. Knicks", direction: "Yes", directionRaw: "Yes",
  displayPrice: 70, avgEntryPrice: 70, entryPrice: 70, largestBet: 8000, numWallets: 2, uniqueWallets: 2, score: 50,
  hasWinningWallet: false, hoursUntilEnd: 5, marketType: "sports", ...o,
});
const posOf = (env) => JSON.parse(env.store.autotrader_positions || "[]");

// 3. Promoted rule matches -> forge paper position, live fill, tagged
{
  livePx = "0.71";
  const env = makeEnv();
  const r = await processSignals(env, [sig()]);
  const p = posOf(env)[0];
  check("3: entered", p && p.strategySource === "forge" && p.forgeRule === "side=fav60+", JSON.stringify(posOf(env)) + JSON.stringify(r.forgeLane));
  check("3: live fill", p && Math.abs(p.entryPrice - 71) < 0.01, p && p.entryPrice);
  check("3: hold", p && p.holdToResolution === true && p.size === 5);
  // second cycle: same market+side not re-entered
  await processSignals(env, [sig()]);
  check("3: no duplicate", posOf(env).length === 1);
}
// 4. Live price past whale + slippage -> skip
{
  livePx = "0.74";
  const env = makeEnv();
  const r = await processSignals(env, [sig()]);
  check("4: slippage skip", posOf(env).length === 0 && r.forgeLane && r.forgeLane.skips["live price past forge slippage"] === 1, JSON.stringify(r.forgeLane));
}
// 5. Non-matching signal -> nothing
{
  livePx = "0.30";
  const env = makeEnv();
  await processSignals(env, [sig({ avgEntryPrice: 30, displayPrice: 30, entryPrice: 30 })]);
  check("5: no match", posOf(env).length === 0);
}
// 6. Rule demoted by its own losing paper ledger
{
  livePx = "0.70";
  const hist = Array.from({ length: 22 }, (_, i) => ({ id: "h" + i, strategySource: "forge", forgeRule: "side=fav60+", outcome: i < 8 ? "win" : "loss", pnl: i < 8 ? 2 : -5, closedAt: new Date().toISOString() }));
  const env = makeEnv({ autotrader_history: JSON.stringify(hist) });
  const r = await processSignals(env, [sig()]);
  check("6: demoted", posOf(env).length === 0 && Object.keys(r.forgeLane.skips).some(k => /demoted/.test(k)), JSON.stringify(r.forgeLane));
}
// 7. Nothing promoted -> no entries, clear reason
{
  const env = makeEnv({ forge_report: JSON.stringify({ promoted: [] }) });
  const r = await processSignals(env, [sig()]);
  check("7: none promoted", posOf(env).length === 0 && r.forgeLane.skips["no promoted strategies"] === 1, JSON.stringify(r.forgeLane));
}

console.log(`# ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

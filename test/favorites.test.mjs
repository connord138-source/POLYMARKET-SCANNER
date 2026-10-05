// Favorites experiment: drive the real processSignals (entry + exit engine)
// with mocked KV + network. Run with: node test/favorites.test.mjs
import { processSignals, computeFavoritesExperiment } from "../src/autotrader.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const SLUG = "nfl-kc-lv-2026-10-06";

function makeEnv({ positions = [], daily = null, cfg = {} } = {}) {
  const today = new Date().toISOString().split("T")[0];
  const store = {
    autotrader_config: JSON.stringify({
      enabled: true, paperTradeMode: true, fixedSize: 10, minPositionSize: 2, maxPositionSize: 30,
      maxDailyTrades: 30, maxDailySpend: 300, maxOpenPositions: 15, maxOdds: 40, minOdds: 20,
      sportsMaxOdds: 40, sportsMinOdds: 20, takeProfitPercent: 100, stopLossPercent: 40,
      maxHoldHours: 48, minWalletWinRate: 60, minWalletBets: 5, walletTiers: ["INSIDER", "STRONG", "ELITE"],
      requireProvenEdge: true, useLearningData: false, blockedCategories: [], vegasEdgeEntries: false, entryCooldownSeconds: 0,
      _liveV2Tuned: true, _v3ProfitOverhaul: true, _clearPositions: true,
      ...cfg,
    }),
    autotrader_positions: JSON.stringify(positions),
  };
  if (daily) store[`autotrader_daily_stats_${today}`] = JSON.stringify({ date: today, ...daily });
  return {
    store,
    SIGNALS_CACHE: {
      get: async (k, o) => (k in store ? (o && o.type === "json" ? JSON.parse(store[k]) : store[k]) : null),
      put: async (k, v) => { store[k] = v; },
      delete: async (k) => { delete store[k]; },
      list: async () => ({ keys: [] }),
    },
  };
}

function installFetch({ yes = 0.84, closed = false }) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (body, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("gamma-api") && u.includes(encodeURIComponent(SLUG))) {
      return json([{ slug: SLUG, clobTokenIds: '["t0","t1"]', outcomes: '["Yes","No"]',
        outcomePrices: JSON.stringify([String(yes), String(1 - yes)]), closed,
        endDate: new Date(Date.now() + 5 * 3600e3).toISOString() }]);
    }
    if (u.includes("/midpoint")) return json({ t0: String(yes) });
    return json([]);
  };
}

const favSignal = (o = {}) => ({
  marketSlug: SLUG, marketTitle: "Will the Chiefs beat the Raiders?", direction: "Yes", directionRaw: "Yes",
  displayPrice: 84, avgEntryPrice: 84, entryPrice: 84, priceAtSignal: 84,
  edgeBand: "81-99", hasPositiveEdge: true, historicalEdgeNet: 8, historicalWinRate: 92, historicalEdgeSamples: 62,
  hasWinningWallet: true, winningWalletInfo: { winRate: 72, totalBets: 30, tier: "ELITE", record: "30 bets" },
  hoursUntilEvent: 5, hoursUntilEnd: 5, score: 90, largestBet: 30000, uniqueWallets: 3, marketType: "sports",
  ...o,
});
const posOf = (env) => JSON.parse(env.store.autotrader_positions || "[]");
const histOf = (env) => JSON.parse(env.store.autotrader_history || "[]");

// A: favorite with a positive band opens a $5 hold-to-resolution experiment position at the live price
{
  installFetch({ yes: 0.845 });
  const env = makeEnv();
  await processSignals(env, [favSignal()]);
  const p = posOf(env)[0];
  check("A: opened", !!p, JSON.stringify(posOf(env)));
  check("A: tagged experiment", p && p.experiment === "favorites" && p.holdToResolution === true, JSON.stringify(p));
  check("A: $5 size", p && p.size === 5, p && p.size);
  check("A: live fill", p && Math.abs(p.entryPrice - 84.5) < 0.01, p && p.entryPrice);
  check("A: not in grad/go-live ledgers", p && !p.isExploration && !p.graduatedEntry, JSON.stringify(p));
}
// B: experiment off => normal 40c cap rejects it
{
  installFetch({});
  const env = makeEnv({ cfg: { favoritesExperiment: false } });
  const r = await processSignals(env, [favSignal()]);
  check("B: off => no position", posOf(env).length === 0);
  check("B: off => price-cap skip", Object.keys(r.skipReasons || {}).some(k => /too high/.test(k)), JSON.stringify(r.skipReasons));
}
// C: band not proven positive => no favorite entry (auto-stops)
{
  installFetch({});
  const env = makeEnv();
  await processSignals(env, [favSignal({ hasPositiveEdge: false, historicalEdgeNet: -3 })]);
  check("C: negative band => no position", posOf(env).length === 0, JSON.stringify(posOf(env)));
}
// D: above 90c => rejected
{
  installFetch({ yes: 0.93 });
  const env = makeEnv();
  await processSignals(env, [favSignal({ displayPrice: 93, avgEntryPrice: 93, entryPrice: 93, priceAtSignal: 93 })]);
  check("D: 93c => no position", posOf(env).length === 0);
}
// E: daily cap respected
{
  installFetch({});
  const env = makeEnv({ daily: { favoritesOpened: 3, tradesOpened: 3, totalSpent: 15, realizedPnL: 0 } });
  const r = await processSignals(env, [favSignal()]);
  check("E: capped => no position", posOf(env).length === 0);
  check("E: cap skip reason", Object.keys(r.skipReasons || {}).some(k => /daily cap/.test(k)), JSON.stringify(r.skipReasons));
}
// F: live price ran out of range (signal 84, live 95) => skipped at honest fill
{
  installFetch({ yes: 0.95 });
  const env = makeEnv();
  await processSignals(env, [favSignal()]);
  check("F: out-of-range live => no position", posOf(env).length === 0, JSON.stringify(posOf(env)));
}
// G: open favorite is NOT stopped out on a dip (hold to resolution), and settles on resolution
{
  const open = { id: "fav1", marketSlug: SLUG, marketTitle: "Will the Chiefs beat the Raiders?", direction: "Yes",
    directionRaw: "Yes", entryPrice: 84, size: 5, shares: 5 / 0.84, openedAt: new Date(Date.now() - 3 * 3600e3).toISOString(),
    paperTrade: true, experiment: "favorites", holdToResolution: true, marketCategory: "sports_binary" };
  installFetch({ yes: 0.45 });   // -46%: would trip the 40% stop on a normal position
  let env = makeEnv({ positions: [open] });
  await processSignals(env, []);
  check("G: dip does not exit", histOf(env).length === 0 && posOf(env).some(p => p.id === "fav1"), JSON.stringify(histOf(env)));
  installFetch({ yes: 1, closed: true });
  env = makeEnv({ positions: [open] });
  await processSignals(env, []);
  const h = histOf(env);
  check("G: resolution settles win", h.length === 1 && h[0].exitType === "market_resolved" && h[0].pnl > 0, JSON.stringify(h.map(t => [t.exitType, t.pnl])));
  check("G: ledger counts it", computeFavoritesExperiment(h, []).wins === 1);
}
// H: ledger math
{
  const L = computeFavoritesExperiment([
    { experiment: "favorites", outcome: "win", pnl: 0.95, size: 5 },
    { experiment: "favorites", outcome: "loss", pnl: -5, size: 5 },
    { experiment: "favorites", outcome: "void", pnl: 0, size: 5 },
    { outcome: "win", pnl: 10, size: 10 },
  ], [{ experiment: "favorites" }, {}]);
  check("H: ledger", L.settled === 2 && L.wins === 1 && L.pnl === -4.05 && L.open === 1 && L.roi === -40.5, JSON.stringify(L));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

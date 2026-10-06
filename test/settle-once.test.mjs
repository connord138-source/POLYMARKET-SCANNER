// A position settles exactly once. Oct 6 2026: a sports favorite at 85.5c
// priced >= 98 while Gamma still had the market open; the exit loop settled
// it, but the still-open filter kept it, so every 5-minute cycle booked the
// same win again (13x). Run with: node test/settle-once.test.mjs
import { processSignals, dedupeSettledHistory } from "../src/autotrader.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const SLUG = "nfl-atl-no-2026-10-06";

function makeEnv({ positions = [], store: extra = {}, cfg = {} } = {}) {
  const store = {
    autotrader_config: JSON.stringify({
      enabled: true, paperTradeMode: true, fixedSize: 10, maxOdds: 40, minOdds: 20,
      takeProfitPercent: 100, stopLossPercent: 40, maxHoldHours: 48, requireProvenEdge: true,
      useLearningData: false, blockedCategories: [], vegasEdgeEntries: false, entryCooldownSeconds: 0,
      _liveV2Tuned: true, _v3ProfitOverhaul: true, _clearPositions: true,
      ...cfg,
    }),
    autotrader_positions: JSON.stringify(positions),
    ...extra,
  };
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

// Market resolved on price (our side 0.995) but Gamma hasn't flipped `closed` yet.
function installFetch({ yes, closed = false }) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (body, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("gamma-api") && u.includes(encodeURIComponent(SLUG))) {
      return json([{ slug: SLUG, clobTokenIds: '["t0","t1"]', outcomes: '["Yes","No"]',
        outcomePrices: JSON.stringify([String(yes), String(1 - yes)]), closed,
        endDate: new Date(Date.now() - 1 * 3600e3).toISOString() }]);
    }
    if (u.includes("/midpoint")) return json({ t0: String(yes) });
    return json([]);
  };
}

const pos = (o = {}) => ({
  id: "at_fav_falcons", marketSlug: SLUG, marketTitle: "Will the Falcons beat the Saints?", direction: "Yes",
  directionRaw: "Yes", entryPrice: 85.5, size: 5, shares: 5 / 0.855, tokenId: "t0",
  openedAt: new Date(Date.now() - 4 * 3600e3).toISOString(), paperTrade: true, marketCategory: "sports_binary",
  ...o,
});
const posOf = (env) => JSON.parse(env.store.autotrader_positions || "[]");
const histOf = (env) => JSON.parse(env.store.autotrader_history || "[]");
const today = () => new Date().toISOString().split("T")[0];
const dailyOf = (env) => JSON.parse(env.store[`autotrader_daily_stats_${today()}`] || "{}");

async function runCycles(env, n) { for (let i = 0; i < n; i++) await processSignals(env, []); }

// A: hold-to-resolution favorite at 99.5 with Gamma still open => one settlement, then gone
{
  installFetch({ yes: 0.995 });
  const env = makeEnv({ positions: [pos({ experiment: "favorites", holdToResolution: true })] });
  await runCycles(env, 3);
  const h = histOf(env);
  check("A: settled exactly once", h.length === 1, JSON.stringify(h.map(t => [t.exitType, t.pnl])));
  check("A: as a resolved win", h[0]?.exitType === "market_resolved" && h[0]?.pnl === 0.85, JSON.stringify(h[0]));
  check("A: removed from open positions", posOf(env).length === 0, JSON.stringify(posOf(env)));
  check("A: daily stats count it once", dailyOf(env).wins === 1 && dailyOf(env).realizedPnL === 0.85, JSON.stringify(dailyOf(env)));
}
// B: ordinary position bought at 60c (98/60 = +63% < 100% take-profit) => same trap, one settlement
{
  installFetch({ yes: 0.99 });
  const env = makeEnv({ positions: [pos({ id: "at_norm_60", entryPrice: 60, size: 10, shares: 10 / 0.6 })] });
  await runCycles(env, 3);
  const h = histOf(env);
  check("B: settled exactly once", h.length === 1, JSON.stringify(h.map(t => [t.exitType, t.pnl])));
  check("B: removed from open positions", posOf(env).length === 0);
}
// C: a position that doesn't exit stays open (and records nothing)
{
  installFetch({ yes: 0.7 });
  const env = makeEnv({ positions: [pos({ experiment: "favorites", holdToResolution: true })] });
  await runCycles(env, 2);
  check("C: no settlement", histOf(env).length === 0);
  check("C: still open", posOf(env).length === 1 && posOf(env)[0].id === "at_fav_falcons");
}
// D: Gamma-closed resolution of a live position stuck in pendingExit settles once and leaves
{
  installFetch({ yes: 1, closed: true });
  const pending = pos({ id: "at_live_pend", paperTrade: false, pendingExit: true,
    pendingExitSince: new Date(Date.now() - 3 * 3600e3).toISOString() });
  const queue = [{ id: "exit_1", action: "SELL", status: "PENDING", positionId: "at_live_pend",
    tokenId: "t0", queuedAt: new Date().toISOString() }];
  const env = makeEnv({ positions: [pending], store: { autotrader_exec_queue: JSON.stringify(queue) } });
  await runCycles(env, 2);
  check("D: settled exactly once", histOf(env).length === 1, JSON.stringify(histOf(env).map(t => [t.id, t.exitType])));
  check("D: removed from open positions", posOf(env).length === 0, JSON.stringify(posOf(env)));
}

// E: repair — duplicate settlements of one position are removed and the day's stats rebuilt
{
  const base = { id: "at_dup", marketSlug: SLUG, marketTitle: "Falcons", entryPrice: 85.5, size: 5,
    openedAt: "2026-10-06T01:36:00Z", exitType: "market_resolved", outcome: "win", pnl: 0.85, experiment: "favorites" };
  const hist = [
    { id: "at_other", marketSlug: "x", openedAt: "2026-10-05T10:00:00Z", closedAt: "2026-10-05T12:00:00Z", outcome: "loss", pnl: -4, size: 10 },
    ...Array.from({ length: 13 }, (_, i) => ({ ...base, closedAt: new Date(Date.parse("2026-10-06T02:41:00Z") + i * 300e3).toISOString() })),
    { id: "at_later", marketSlug: "y", openedAt: "2026-10-06T05:00:00Z", closedAt: "2026-10-06T09:00:00Z", outcome: "loss", pnl: -10, size: 10 },
  ];
  const env = makeEnv({ store: {
    autotrader_history: JSON.stringify(hist),
    "autotrader_daily_stats_2026-10-06": JSON.stringify({ date: "2026-10-06", tradesClosed: 14, wins: 13, losses: 1,
      realizedPnL: 1.05, totalReturned: 76.05 }),
  } });
  const r = await dedupeSettledHistory(env);
  const h = histOf(env);
  check("E: removed 12 duplicates", r.removed === 12 && Math.abs(r.pnlRemoved - 10.2) < 1e-9, JSON.stringify(r));
  check("E: keeps first settlement + others in order", h.length === 3 && h[0].id === "at_other" &&
    h[1].id === "at_dup" && h[1].closedAt === "2026-10-06T02:41:00.000Z" && h[2].id === "at_later", JSON.stringify(h.map(t => [t.id, t.closedAt])));
  const d = JSON.parse(env.store["autotrader_daily_stats_2026-10-06"]);
  check("E: day rebuilt", d.tradesClosed === 2 && d.wins === 1 && d.losses === 1 && d.realizedPnL === -9.15 && d.totalReturned === 5.85, JSON.stringify(d));
  check("E: performance recalculated", JSON.parse(env.store.autotrader_performance || "{}").totalPnL === -13.15,
    env.store.autotrader_performance);
  const r2 = await dedupeSettledHistory(env);
  check("E: idempotent", r2.removed === 0 && histOf(env).length === 3);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

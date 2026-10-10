// Agent hub payload: events, council board, room assembly, cache.
// Run with: node test/agent-hub.test.mjs
import { buildEvents, councilBoard, buildAgentHub } from "../src/agent-hub.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };

// 1. events: types -> rooms, newest first, deduped
{
  const ev = buildEvents({
    tradeLog: [
      { type: "PAPER_TRADE", market: "A", entryPrice: 31.5, size: 5, timestamp: "2026-10-10T01:00:00Z", walletTier: "FORGE" },
      { type: "SKIP", market: "B", reason: "No winning wallet", timestamp: "2026-10-10T01:01:00Z" },
      { type: "EXIT", market: "C", pnl: -2.5, timestamp: "2026-10-10T00:59:00Z" },
    ],
    council: [{ at: "2026-10-10T01:02:00Z", market: "A", verdict: "APPROVE", reason: "4-1" }],
    history: [{ marketTitle: "C", pnl: -2.5, outcome: "loss", closedAt: "2026-10-10T00:58:00Z" }],
  });
  check("1: newest first", ev[0].room === "council" && ev[1].room === "research", JSON.stringify(ev.map(e => e.room)));
  check("1: entry desk", ev.some(e => e.room === "desk" && e.kind === "entry" && e.lane === "FORGE"));
  check("1: exit vault loss", ev.some(e => e.room === "vault" && e.kind === "loss"));
  check("1: count", ev.length === 5, ev.length);
}
// 2. council board sorts by accuracy, unseen agents null
{
  const b = councilBoard({ agents: { GREED: { calls: 10, correct: 7 }, PANIC: { calls: 10, correct: 4 } } });
  check("2: top GREED", b[0].agent === "GREED" && b[0].accuracy === 70);
  check("2: six agents", b.length === 6 && b.find(x => x.agent === "QUANT").accuracy === null);
}
// 3. assembly + cache
{
  const store = {
    cron_last_run: JSON.stringify({ completedAt: "2026-10-10T01:05:00Z", scan: { signals: 512 }, investigations: { skipped: "anthropic credits exhausted" }, autotrader: { evaluated: 512, tradesPaperTraded: 0, forgeLane: { entered: 0, skips: { "no promoted strategies": 1 } } } }),
    forge_report: JSON.stringify({ ranAt: "x", verdict: "Nothing promoted.", counts: { generated: 90, promoted: 0 }, promoted: [], nearMisses: [{ id: "side=fav60+", train: { n: 900, roi: -1 }, test: { n: 300, roi: 1 }, fails: ["a", "b", "c"] }], overfit: [] }),
  };
  let calls = 0;
  const env = { SIGNALS_CACHE: { get: async (k, o) => (k in store ? (o && o.type === "json" ? JSON.parse(store[k]) : store[k]) : null), put: async (k, v) => { store[k] = v; } } };
  const deps = {
    getBotPerformance: async () => { calls++; return { totalTrades: 244, wins: 116, losses: 128, winRate: 48, totalPnL: -39.789 }; },
    getOpenPositions: async () => [{ id: "p1", marketTitle: "X", marketCategory: "politics", entryPrice: 40, size: 5, strategySource: "forge" }],
    getTradeLog: async () => [], getTradeHistory: async () => [], getDailyStats: async () => ({ realizedPnL: -6.9, wins: 2, losses: 2 }),
    getAutotraderConfig: async () => ({ paperTradeMode: true, councilMode: "shadow" }),
  };
  const h = await buildAgentHub(env, deps);
  check("3: mode", h.mode === "PAPER");
  check("3: vault pnl", h.rooms.vault.lifetime.pnl === -39.79, JSON.stringify(h.rooms.vault));
  check("3: research offline flag", h.rooms.research.agentsOnline === false && h.rooms.research.signals === 512);
  check("3: desk by category", h.rooms.desk.byCategory.politics[0].lane === "forge");
  check("3: lanes", h.rooms.desk.lanes.forge.skips["no promoted strategies"] === 1);
  check("3: backtest trims fails", h.rooms.backtest.nearMisses[0].fails.length === 2);
  await buildAgentHub(env, deps);
  check("3: cached", calls === 1, calls);
}

console.log(`# ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

// Council: persona votes, chair verdicts, ledger math, and the processSignals
// wiring (shadow records, gate enforces). Run with: node test/council.test.mjs
import { conveneCouncil, applyOutcomeToStats, agentWeight, leaderboard } from "../src/council.js";
import { processSignals, manualClosePosition } from "../src/autotrader.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };

const baseCfg = { bankroll: 1000, maxPortfolioRisk: 50, dailyLossLimit: 100, councilCloseMargin: 0.2 };
const ctxOf = (o = {}) => ({
  signal: {
    marketTitle: "Test market", direction: "Yes", directionRaw: "Yes",
    avgEntryPrice: 30, edgeBand: "21-40", historicalEdgeNet: 6, historicalEdgeSamples: 80,
    factors: ["lastMinute2h", "whaleSize25k", "eliteWallet"], uniqueWallets: 3, largestBet: 30000,
    ...(o.signal || {}),
  },
  evaluation: { entryPrice: 30, positionSize: 5, walletBets: 40, isExploration: false, isHighConviction: false, ...(o.evaluation || {}) },
  config: { ...baseCfg, ...(o.config || {}) },
  dailyStats: { realizedPnL: 0, ...(o.dailyStats || {}) },
  openPositions: o.openPositions || [],
  perf: { currentStreak: 0, ...(o.perf || {}) },
  agentView: o.agentView ?? null,
  category: o.category || "sports",
});

// 1. Strong setup => APPROVE, all six agents vote
{
  const s = conveneCouncil(ctxOf(), null);
  check("1: six votes", s.votes.length === 6);
  check("1: approve", s.verdict === "APPROVE", JSON.stringify(s));
  check("1: GREED yes", s.votes.find(v => v.agent === "GREED").vote === "YES");
}
// 2. Negative band + thin sample + exploration => VETO
{
  const s = conveneCouncil(ctxOf({
    signal: { historicalEdgeNet: -6, historicalEdgeSamples: 8, factors: [], uniqueWallets: 1, largestBet: 2000 },
    evaluation: { isExploration: true, walletBets: 5 },
  }), null);
  check("2: veto", s.verdict === "VETO", JSON.stringify(s.votes.map(v => [v.agent, v.vote, v.conviction])));
}
// 3. PANIC + RISK hard NO override a GREED yes
{
  const open = Array.from({ length: 4 }, (_, i) => ({ size: 120, marketCategory: "sports" }));
  const s = conveneCouncil(ctxOf({
    evaluation: { entryPrice: 38 },             // chasing +8c past whale 30c
    dailyStats: { realizedPnL: -80 },
    perf: { currentStreak: -4 },
    openPositions: open,
  }), null);
  check("3: hard veto", s.verdict === "VETO" && /PANIC and RISK/.test(s.reason), JSON.stringify(s));
}
// 4. NO-side chase math uses our side of the book
{
  const s = conveneCouncil(ctxOf({ signal: { direction: "NO", avgEntryPrice: 70 }, evaluation: { entryPrice: 30 } }), null);
  check("4: no false chase on NO side", s.votes.find(v => v.agent === "PANIC").vote === "YES", JSON.stringify(s.votes));
}
// 5. QUANT uses the investigator when present
{
  const s = conveneCouncil(ctxOf({ agentView: { agentProb: 0.2, agentEdgePts: -10 } }), null);
  check("5: quant no", s.votes.find(v => v.agent === "QUANT").vote === "NO");
}
// 6. Ledger math + weights
{
  let st = null;
  const rec = { v: [["GREED", "YES", 0.6], ["PANIC", "NO", 0.4], ["QUANT", "ABSTAIN", 0]], verdict: "APPROVE" };
  for (let i = 0; i < 30; i++) st = applyOutcomeToStats(st, rec, i < 21 ? 5 : -5);  // 21W 9L
  check("6: greed calls", st.agents.GREED.calls === 30 && st.agents.GREED.correct === 21, JSON.stringify(st.agents.GREED));
  check("6: panic inverse", st.agents.PANIC.correct === 9);
  check("6: abstain ignored", !st.agents.QUANT);
  check("6: chair ledger", st.chair.APPROVE.trades === 30 && st.chair.APPROVE.pnl === 60, JSON.stringify(st.chair));
  check("6: greed upweighted", agentWeight(st, "GREED") > 1, agentWeight(st, "GREED"));
  check("6: panic downweighted", agentWeight(st, "PANIC") < 1, agentWeight(st, "PANIC"));
  check("6: unseen agent = 1", agentWeight(st, "RISK") === 1);
  const lb = leaderboard(st);
  check("6: leaderboard top", lb[0].agent === "GREED" && lb[0].accuracy === 70, JSON.stringify(lb[0]));
}

// ---------- processSignals wiring ----------
const SLUG = `nba-bos-nyk-${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`;
function makeEnv(cfg = {}) {
  const store = {
    autotrader_config: JSON.stringify({
      enabled: true, paperTradeMode: true, fixedSize: 10, minPositionSize: 2, maxPositionSize: 30,
      maxDailyTrades: 30, maxDailySpend: 300, maxOpenPositions: 15, maxOdds: 40, minOdds: 20,
      sportsMaxOdds: 40, sportsMinOdds: 20, takeProfitPercent: 100, stopLossPercent: 40,
      maxHoldHours: 48, minWalletWinRate: 60, minWalletBets: 5, walletTiers: ["INSIDER", "STRONG", "ELITE"],
      requireProvenEdge: true, useLearningData: false, blockedCategories: [], vegasEdgeEntries: false, entryCooldownSeconds: 0,
      favoritesExperiment: false, _liveV2Tuned: true, _v3ProfitOverhaul: true, _clearPositions: true,
      ...cfg,
    }),
    autotrader_positions: "[]",
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
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  if (u.includes("gamma-api") && u.includes(encodeURIComponent(SLUG))) {
    return json([{ slug: SLUG, clobTokenIds: '["t0","t1"]', outcomes: '["Yes","No"]',
      outcomePrices: '["0.30","0.70"]', closed: false, endDate: new Date(Date.now() + 5 * 3600e3).toISOString() }]);
  }
  if (u.includes("/midpoint")) return json({ t0: "0.30" });
  return json([]);
};
const sig = (o = {}) => ({
  marketSlug: SLUG, marketTitle: "Celtics vs. Knicks", direction: "Yes", directionRaw: "Yes",
  displayPrice: 30, avgEntryPrice: 30, entryPrice: 30, priceAtSignal: 30,
  edgeBand: "21-40", hasPositiveEdge: true, historicalEdgeNet: 6, historicalWinRate: 42, historicalEdgeSamples: 80,
  hasWinningWallet: true, winningWalletInfo: { winRate: 72, totalBets: 40, tier: "ELITE", record: "40 bets" },
  hoursUntilEvent: 5, hoursUntilEnd: 5, score: 90, largestBet: 30000, uniqueWallets: 3, marketType: "sports",
  signalSubType: "moneyline", factors: ["lastMinute2h", "whaleSize25k"],
  ...o,
});
const badSig = () => sig({ historicalEdgeNet: -4, historicalEdgeSamples: 8, hasPositiveEdge: false, factors: [], uniqueWallets: 1, largestBet: 2000,
  winningWalletInfo: { winRate: 61, totalBets: 6, tier: "STRONG", record: "6 bets" } });
const posOf = (env) => JSON.parse(env.store.autotrader_positions || "[]");

// 7. Shadow (default): position opens, council recorded on it, feed written
{
  const env = makeEnv();
  await processSignals(env, [sig()]);
  const p = posOf(env)[0];
  check("7: opened", !!p, JSON.stringify(posOf(env)));
  check("7: council on position", p && p.council && p.council.v.length === 6 && p.council.mode === "shadow", JSON.stringify(p && p.council));
  const feed = JSON.parse(env.store.council_feed || "[]");
  check("7: feed entry", feed.length === 1 && feed[0].votes.length === 6, env.store.council_feed);
}
// 8. Shadow never blocks a VETO
{
  const env = makeEnv();
  await processSignals(env, [badSig()]);
  const p = posOf(env)[0];
  check("8: shadow veto still opens", p && p.council && p.council.verdict === "VETO", JSON.stringify(p && p.council));
}
// 9. Gate mode enforces the VETO
{
  const env = makeEnv({ councilMode: "gate" });
  const r = await processSignals(env, [badSig()]);
  check("9: gate veto blocks", posOf(env).length === 0, JSON.stringify(posOf(env)));
  check("9: skip reason", Object.keys(r.skipReasons || {}).some(k => /Council VETO/.test(k)), JSON.stringify(r.skipReasons));
}
// 10. Disabled => no council field
{
  const env = makeEnv({ councilEnabled: false });
  await processSignals(env, [sig()]);
  const p = posOf(env)[0];
  check("10: disabled", p && !p.council, JSON.stringify(p));
}

// 11. Settling a council trade credits the ledger
{
  const env = makeEnv();
  await processSignals(env, [sig()]);
  const p = posOf(env)[0];
  await manualClosePosition(env, p.id, 45);   // 30c -> 45c = win
  const st = JSON.parse(env.store.council_agent_stats || "null");
  check("11: ledger written", st && st.agents && st.agents.GREED && st.agents.GREED.calls === 1 && st.agents.GREED.correct === 1, env.store.council_agent_stats);
  check("11: chair bucket", st && st.chair && Object.values(st.chair).reduce((a, c) => a + c.trades, 0) === 1, JSON.stringify(st && st.chair));
}

console.log(`# ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

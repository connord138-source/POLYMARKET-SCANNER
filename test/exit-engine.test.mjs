// Integration: run the REAL processSignals exit engine against the exact
// Sep 26 phantom scenario with mocked KV + network.
import { processSignals } from "../src/autotrader.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const SLUG = "cfb-tx-tenn-2026-09-26";

function makeEnv(extra = {}) {
  const store = {
    autotrader_config: JSON.stringify({
      enabled: true, paperTradeMode: true, takeProfitPercent: 50, stopLossPercent: 40,
      maxHoldHours: 48, fixedSize: 10, maxDailyTrades: 30, maxDailySpend: 300,
      _liveV2Tuned: true, _v3ProfitOverhaul: true, _clearPositions: true,
      vegasEdgeEntries: false, requireProvenEdge: true,
    }),
    autotrader_positions: JSON.stringify([{
      id: "at_test", marketSlug: SLUG, marketTitle: "Texas vs. Tennessee",
      direction: "Tennessee", directionRaw: "Tennessee", entryPrice: 33.5, size: 5,
      shares: 5 / 0.335, openedAt: new Date(Date.now() - 5 * 60000).toISOString(),
      paperTrade: true, marketCategory: "sports_binary", isExploration: true,
    }]),
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

function installFetch({ gammaClosed = false, gammaPrices = ["0.665", "0.335"], clobGet = null, clobPost = null }) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (body, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes("gamma-api") && u.includes(encodeURIComponent(SLUG))) {
      return json([{ slug: SLUG, clobTokenIds: '["t0","t1"]', outcomes: '["Texas","Tennessee"]',
        outcomePrices: JSON.stringify(gammaPrices), closed: gammaClosed, endDate: new Date(Date.now() + 86400e3).toISOString() }]);
    }
    if (u.includes("/midpoints") && (init.method || "GET") === "POST") return clobPost ? json(clobPost) : json({}, false);
    if (u.includes("/midpoints")) return clobGet ? json(clobGet) : json({}, false);
    if (u.includes("/midpoint?")) return json({}, false);
    return json([]);
  };
}

// The opposing-side whale signal that caused the phantom: Texas at 67.
const texasSignal = { marketSlug: SLUG, marketTitle: "Texas vs. Tennessee", direction: "Texas", directionRaw: "Texas",
  displayPrice: 67, avgEntryPrice: 67, score: 40, largestBet: 5000, hoursUntilEvent: 3 };

const histOf = (env) => JSON.parse(env.store.autotrader_history || "[]");
const posOf = (env) => JSON.parse(env.store.autotrader_positions || "[]");

// A: CLOB down entirely (the production condition) + opposing signal => NO phantom exit, Gamma prices it at 33.5
{
  installFetch({});
  const env = makeEnv();
  const r = await processSignals(env, [texasSignal]);
  check("A: no phantom close", histOf(env).length === 0, JSON.stringify(histOf(env)));
  check("A: position still open", posOf(env).some(p => p.id === "at_test"), JSON.stringify(posOf(env)));
  check("A: priced via gamma_live", r.priceSources && r.priceSources.gamma_live === 1, JSON.stringify(r.priceSources));
}
// B: POST batch works => clob_midpoint, correct side (Texas mid 0.66 => Tennessee 34), no exit
{
  installFetch({ clobPost: { t0: "0.66" } });
  const env = makeEnv();
  const r = await processSignals(env, [texasSignal]);
  check("B: clob via POST", r.priceSources && r.priceSources.clob_midpoint === 1, JSON.stringify(r.priceSources));
  check("B: no exit at 34", histOf(env).length === 0);
}
// C: price genuinely at the complement 5 min in => tripwire defers, doesn't book
{
  installFetch({ clobGet: { t0: "0.33" } });   // Texas 33 => Tennessee 67
  const env = makeEnv();
  const r = await processSignals(env, [texasSignal]);
  check("C: tripwire deferred", r.complementDeferred === 1, JSON.stringify(r));
  check("C: not booked", histOf(env).length === 0);
  const p = posOf(env).find(x => x.id === "at_test");
  check("C: peak not inflated", !p || !(p.peakPctGain > 50), JSON.stringify(p));
}
// D: genuine resolution (Tennessee won) still settles as a real win
{
  installFetch({ gammaClosed: true, gammaPrices: ["0", "1"] });
  const env = makeEnv();
  await processSignals(env, []);
  const h = histOf(env);
  check("D: resolved win recorded", h.length === 1 && h[0].exitType === "market_resolved" && h[0].pnl > 0, JSON.stringify(h.map(t => [t.exitType, t.pnl])));
  check("D: removed from open", !posOf(env).some(p => p.id === "at_test"));
}
// E: real take-profit after the tripwire window (move persisted 45 min) still exits
{
  installFetch({ clobGet: { t0: "0.33" } });
  const env = makeEnv();
  const ps = JSON.parse(env.store.autotrader_positions); ps[0].openedAt = new Date(Date.now() - 45 * 60000).toISOString();
  env.store.autotrader_positions = JSON.stringify(ps);
  await processSignals(env, []);
  const h = histOf(env);
  check("E: genuine TP after window exits", h.length === 1 && h[0].exitType === "take_profit", JSON.stringify(h.map(t => [t.exitType, t.pnl])));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

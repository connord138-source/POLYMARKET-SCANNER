// Strategy Forge: promotion rules, overfit detection, SQL shape, run+persist.
// Run with: node test/forge.test.mjs
import { judgeCandidate, buildForgeSql, runForge, FORGE_DEFAULTS } from "../src/forge.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const cfg = { ...FORGE_DEFAULTS };

// Per-bet ROI moments for a binary bet at price p (slip added): win -> 100/(p)-1, loss -> -100.
function row(dimVals, ntr, mtr, nte, mte, sd = 60) {
  return { ...dimVals, ntr, mtr, m2tr: sd * sd + mtr * mtr, nte, mte, m2te: sd * sd + mte * mte };
}

// 1. Clears everything -> promoted
{
  const c = judgeCandidate(["side"], row({ side: "fav60+" }, 400, 6, 200, 8, 40), cfg);
  check("1: promoted", c.promoted, JSON.stringify(c));
  check("1: id", c.id === "side=fav60+");
}
// 2. Great train, negative test -> overfit, not promoted
{
  const c = judgeCandidate(["side", "size"], row({ side: "dog<40", size: "50k+" }, 300, 7, 100, -10.5), cfg);
  check("2: not promoted", !c.promoted);
  check("2: overfit flag", c.overfit === true, JSON.stringify(c));
}
// 3. Positive test but tiny n / weak t -> not promoted
{
  const c = judgeCandidate(["side"], row({ side: "dog<40" }, 300, 5, 40, 34, 150), cfg);
  check("3: small test n blocks", !c.promoted && c.fails.some(f => /test n/.test(f)), JSON.stringify(c.fails));
}
// 4. Positive but noisy -> t-stat blocks
{
  const c = judgeCandidate(["side"], row({ side: "mid40-59" }, 500, 3, 200, 3, 200), cfg);
  check("4: t-stat blocks", !c.promoted && c.fails.some(f => /test t/.test(f)), JSON.stringify(c));
}
// 5. SQL: dedupe, slippage, windows
{
  const q = buildForgeSql(["side", "size"], { ...cfg, slippageCents: 3 }, "2026-10-10T00:00:00Z");
  check("5: dedupe", /ROW_NUMBER\(\) OVER \(PARTITION BY market_slug, direction_raw/.test(q.sql));
  check("5: slippage", /avg_entry_price \+ 3/.test(q.sql));
  check("5: test start", q.params[1] === "2026-09-19T00:00:00.000Z", q.params[1]);
  check("5: train start", q.params[0] === "2026-08-05T00:00:00.000Z", q.params[0]);
}
// 6. runForge with fake D1: persists report, honest verdict when nothing passes
{
  const store = {};
  const env = {
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [
      { side: "fav60+", size: "5-20k", wallets: "3+", type: "other", horizon: "<6h", score: "60-99", ntr: 900, mtr: -1.2, m2tr: 4200, nte: 300, mte: -0.8, m2te: 4100 },
    ] }) }) }) },
    SIGNALS_CACHE: { get: async (k) => store[k] ?? null, put: async (k, v) => { store[k] = v; } },
  };
  const rep = await runForge(env);
  check("6: success", rep.success);
  check("6: nothing promoted", rep.counts.promoted === 0 && /Nothing promoted/.test(rep.verdict), rep.verdict);
  check("6: persisted", !!store.forge_report && !!store.forge_last_run);
}
// 7. No DB -> clean error
{
  const rep = await runForge({});
  check("7: no DB", rep.success === false);
}

console.log(`# ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

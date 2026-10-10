// ============================================================
// FORGE.JS — Strategy Forge -> Backtest Chamber -> Promotion
// ============================================================
//
// Generates strategy candidates as combinations of signal filters, backtests
// each one walk-forward over settled signals in D1 (signals_log), and only
// PROMOTES a candidate when it is profitable in BOTH windows after realistic
// fills. Everything else is reported with why it failed.
//
// Honesty rules baked in (each one learned from this dataset):
//  - DEDUPE: the scanner re-logs the same market+side many times (19k rows,
//    ~9.4k unique bets). Only the first signal per market+side counts, or
//    every result is double-weighted toward long-running markets.
//  - SLIPPAGE: ROI is computed at whale entry + FORGE_SLIPPAGE_CENTS, never
//    at the whale's own fill (the "print fill" trap that made
//    vegas_edge_print look +12%).
//  - WALK-FORWARD: train window, then a later, untouched test window. In Oct
//    2026 the best train candidates all flipped negative in test; in-sample
//    ROI alone means nothing.
//  - SIGNIFICANCE: test-window t-stat on per-bet ROI must clear a bar, so a
//    +34% on n=40 cannot promote.
// ============================================================

export const FORGE_KEYS = {
  REPORT: 'forge_report',
  LAST_RUN: 'forge_last_run',
};

export const FORGE_DEFAULTS = {
  slippageCents: 2,
  trainDays: 45,      // train window length, ending where test starts
  testDays: 21,       // most recent N days = untouched test window
  minTrainN: 150,
  minTestN: 60,
  minTrainRoi: 2,     // % per bet after slippage
  minTestRoi: 2,
  minTestT: 1.5,      // test-window t-stat on per-bet ROI
  runEveryHours: 24,
};

// Dimensions the forge combines. Each maps to a SQL expression over
// signals_log; the value is a bucket label.
const DIMENSIONS = {
  side: "CASE WHEN avg_entry_price >= 60 THEN 'fav60+' WHEN avg_entry_price >= 40 THEN 'mid40-59' ELSE 'dog<40' END",
  size: "CASE WHEN largest_bet >= 50000 THEN '50k+' WHEN largest_bet >= 20000 THEN '20-50k' WHEN largest_bet >= 5000 THEN '5-20k' ELSE '<5k' END",
  wallets: "CASE WHEN num_wallets >= 3 THEN '3+' ELSE '1-2' END",
  type: "COALESCE(market_type, 'other')",
  horizon: "CASE WHEN event_date IS NULL THEN 'unknown' WHEN julianday(event_date) - julianday(detected_at) <= 0.25 THEN '<6h' WHEN julianday(event_date) - julianday(detected_at) <= 2 THEN '6h-2d' ELSE '2d+' END",
  score: "CASE WHEN score >= 100 THEN '100+' WHEN score >= 60 THEN '60-99' ELSE '<60' END",
};

// Pairs of dimensions (single dims are covered by grouping on one).
const COMBOS = [
  ['side'], ['size'], ['wallets'], ['type'], ['horizon'], ['score'],
  ['side', 'size'], ['side', 'wallets'], ['side', 'horizon'], ['side', 'score'],
  ['side', 'type'], ['size', 'wallets'], ['horizon', 'score'],
  ['side', 'size', 'wallets'],
];

export function buildForgeSql(dims, cfg, nowIso) {
  const now = new Date(nowIso).getTime();
  const testStart = new Date(now - cfg.testDays * 86400e3).toISOString();
  const trainStart = new Date(now - (cfg.testDays + cfg.trainDays) * 86400e3).toISOString();
  const slip = Number(cfg.slippageCents) || 0;
  const cols = dims.map(d => `${DIMENSIONS[d]} AS ${d}`).join(', ');
  const groupBy = dims.join(', ');
  return {
    sql:
      `WITH r AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY market_slug, direction_raw ORDER BY detected_at) rn ` +
      `FROM signals_log WHERE outcome IN ('WIN','LOSS') AND avg_entry_price BETWEEN 5 AND 95 AND detected_at >= ?1), ` +
      `d AS (SELECT ${cols}, CASE WHEN detected_at < ?2 THEN 'train' ELSE 'test' END per, ` +
      `CASE WHEN outcome = 'WIN' THEN (100.0 / (avg_entry_price + ${slip}) - 1) * 100 ELSE -100 END roi ` +
      `FROM r WHERE rn = 1) ` +
      `SELECT ${groupBy}, ` +
      `SUM(per='train') ntr, AVG(CASE WHEN per='train' THEN roi END) mtr, AVG(CASE WHEN per='train' THEN roi*roi END) m2tr, ` +
      `SUM(per='test') nte, AVG(CASE WHEN per='test' THEN roi END) mte, AVG(CASE WHEN per='test' THEN roi*roi END) m2te ` +
      `FROM d GROUP BY ${groupBy}`,
    params: [trainStart, testStart],
    trainStart, testStart,
  };
}

function tStat(n, mean, meanSq) {
  if (!n || n < 2 || mean == null || meanSq == null) return 0;
  const variance = Math.max(meanSq - mean * mean, 1e-9) * (n / (n - 1));
  return mean / Math.sqrt(variance / n);
}

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// Pure: score one aggregated row into a candidate with a verdict.
export function judgeCandidate(dims, row, cfg) {
  const rule = dims.map(d => `${d}=${row[d]}`).join(' & ');
  const trainRoi = r1(row.mtr), testRoi = r1(row.mte);
  const testT = Math.round(tStat(row.nte, row.mte, row.m2te) * 100) / 100;
  const fails = [];
  if ((row.ntr || 0) < cfg.minTrainN) fails.push(`train n ${row.ntr || 0} < ${cfg.minTrainN}`);
  if ((row.nte || 0) < cfg.minTestN) fails.push(`test n ${row.nte || 0} < ${cfg.minTestN}`);
  if (trainRoi == null || trainRoi < cfg.minTrainRoi) fails.push(`train ROI ${trainRoi}% < ${cfg.minTrainRoi}%`);
  if (testRoi == null || testRoi < cfg.minTestRoi) fails.push(`test ROI ${testRoi}% < ${cfg.minTestRoi}%`);
  if (testT < cfg.minTestT) fails.push(`test t ${testT} < ${cfg.minTestT}`);
  // Overfit flag: looked good in-sample, fell apart out-of-sample.
  const overfit = trainRoi != null && testRoi != null && trainRoi >= cfg.minTrainRoi && testRoi < 0;
  return {
    id: rule,
    dims,
    filter: Object.fromEntries(dims.map(d => [d, row[d]])),
    train: { n: row.ntr || 0, roi: trainRoi },
    test: { n: row.nte || 0, roi: testRoi, t: testT },
    promoted: fails.length === 0,
    overfit,
    fails,
  };
}

export async function runForge(env, overrides = {}) {
  if (!env.DB) return { success: false, error: 'D1 binding (DB) not configured' };
  const cfg = { ...FORGE_DEFAULTS, ...overrides };
  const nowIso = new Date().toISOString();
  const candidates = [];
  let window = null;
  for (const dims of COMBOS) {
    const q = buildForgeSql(dims, cfg, nowIso);
    window = { trainStart: q.trainStart, testStart: q.testStart, end: nowIso };
    try {
      const res = await env.DB.prepare(q.sql).bind(...q.params).all();
      for (const row of (res.results || [])) candidates.push(judgeCandidate(dims, row, cfg));
    } catch (e) {
      candidates.push({ id: dims.join('&'), error: e.message, promoted: false, fails: ['query error'] });
    }
  }
  const eligible = candidates.filter(c => !c.error && c.train && c.train.n >= cfg.minTrainN && c.test.n >= cfg.minTestN);
  const promoted = candidates.filter(c => c.promoted).sort((a, b) => b.test.roi - a.test.roi);
  const overfit = eligible.filter(c => c.overfit).sort((a, b) => b.train.roi - a.train.roi);
  const report = {
    success: true,
    ranAt: nowIso,
    window,
    rules: cfg,
    counts: { generated: candidates.length, eligible: eligible.length, promoted: promoted.length, overfit: overfit.length },
    promoted,
    // Best-looking near misses so the UI's Backtest Chamber has something to show.
    nearMisses: eligible.filter(c => !c.promoted).sort((a, b) => (b.test.roi ?? -999) - (a.test.roi ?? -999)).slice(0, 15),
    overfit: overfit.slice(0, 10),
    verdict: promoted.length
      ? `${promoted.length} strategy candidate(s) cleared walk-forward + slippage + significance.`
      : 'No candidate cleared walk-forward + slippage + significance. Nothing promoted.',
  };
  if (env.SIGNALS_CACHE) {
    try {
      await env.SIGNALS_CACHE.put(FORGE_KEYS.REPORT, JSON.stringify(report));
      await env.SIGNALS_CACHE.put(FORGE_KEYS.LAST_RUN, nowIso);
    } catch (e) {}
  }
  return report;
}

// Cron hook: runs at most once per runEveryHours.
export async function maybeRunForge(env) {
  if (!env.DB || !env.SIGNALS_CACHE) return { skipped: 'no DB/KV' };
  try {
    const last = await env.SIGNALS_CACHE.get(FORGE_KEYS.LAST_RUN);
    if (last && Date.now() - new Date(last).getTime() < FORGE_DEFAULTS.runEveryHours * 3600e3) {
      return { skipped: 'ran recently', lastRun: last };
    }
    const rep = await runForge(env);
    return { ran: true, counts: rep.counts, verdict: rep.verdict };
  } catch (e) {
    return { error: e.message };
  }
}

export async function getForgeReport(env) {
  try {
    return (await env.SIGNALS_CACHE.get(FORGE_KEYS.REPORT, { type: 'json' })) || { success: true, ranAt: null, verdict: 'Forge has not run yet.' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================
// BRIER-REPORT.JS — the agent's calibration against the market (GET /learning/brier)
// ============================================================
//
// Nov 21 2026: the route read the KV `investigation_index` one key at a
// time. The index holds up to 1000 keys, so a request made up to 1000 KV
// reads in a row: past the Worker's subrequest limit and far past the
// snapshot's 45 seconds. The route had answered nothing since about Nov 2
// (the Learning page's calibration panel with it). The report is now built
// from one D1 read of `investigations` (every row, not the capped index),
// with a bounded, parallel KV read as the fallback. Pure helpers; index.js
// does the reads.

const round4 = (x) => Math.round(x * 10000) / 10000;

// A D1 `investigations` row in the shape the report reads (the KV record's names).
export function brierRecordFromRow(row) {
  if (!row) return null;
  return {
    status: row.status || null,
    agentBrier: typeof row.agent_brier === 'number' ? row.agent_brier : null,
    marketBrier: typeof row.market_brier === 'number' ? row.market_brier : null,
    edgePts: typeof row.edge_pts === 'number' ? row.edge_pts : null,
    y: row.y === 0 || row.y === 1 ? row.y : null,
    confidence: row.confidence || null,
    source: row.source || null,
  };
}

// The report from investigation records ({ status, agentBrier, marketBrier, edgePts, y, confidence, source }).
// `total` is the number of records on file when the caller read only a part of them.
export function buildBrierFromRecords(records, { total = null, from = null } = {}) {
  const list = (records || []).filter(Boolean);
  const counts = { total: total == null ? list.length : total, done: 0, pending: 0, error: 0, scored: 0 };
  const scored = [];
  for (const inv of list) {
    if (inv.status === 'done') counts.done++;
    else if (typeof inv.status === 'string' && inv.status.indexOf('error') === 0) counts.error++;
    else counts.pending++;
    if (typeof inv.agentBrier === 'number' && typeof inv.marketBrier === 'number') scored.push(inv);
  }
  counts.scored = scored.length;
  if (!scored.length) {
    return {
      note: 'No ground-truth-settled investigations yet. The agent must call markets that later resolve via Gamma before calibration can be measured.',
      counts, overall: null, byConfidence: null, ...(from ? { from } : {}),
    };
  }
  let sumAgent = 0, sumMarket = 0, agentBeats = 0, edgeDirCorrect = 0, edgeDirTotal = 0;
  const byConf = {}, bySource = {};
  const add = (bag, key, r) => {
    const b = bag[key] || (bag[key] = { n: 0, agent: 0, market: 0 });
    b.n++; b.agent += r.agentBrier; b.market += r.marketBrier;
  };
  for (const r of scored) {
    sumAgent += r.agentBrier;
    sumMarket += r.marketBrier;
    if (r.agentBrier < r.marketBrier) agentBeats++;
    // did the sign of the edge predict the outcome?
    if (typeof r.edgePts === 'number' && r.edgePts !== 0 && (r.y === 0 || r.y === 1)) {
      edgeDirTotal++;
      if ((r.edgePts > 0 && r.y === 1) || (r.edgePts < 0 && r.y === 0)) edgeDirCorrect++;
    }
    add(byConf, r.confidence || 'UNKNOWN', r);
    add(bySource, r.source || 'whale', r);
  }
  const view = (bag) => Object.fromEntries(Object.keys(bag).map((k) => [k, {
    n: bag[k].n, meanAgentBrier: round4(bag[k].agent / bag[k].n), meanMarketBrier: round4(bag[k].market / bag[k].n),
  }]));
  const n = scored.length;
  return {
    note: 'Brier score (lower is better). agentBeatsMarket / edgeDirection are honest but small-sample: this is a survivorship-biased set of markets that happened to resolve, self-reported confidence is uncalibrated (shown for description, not weighting), and N is small. Treat as directional until N is large.',
    counts,
    overall: {
      n,
      meanAgentBrier: round4(sumAgent / n),
      meanMarketBrier: round4(sumMarket / n),
      meanPairedDiff: round4((sumMarket - sumAgent) / n),   // >0 means agent beats market on average
      agentBeatsMarketRate: Math.round((agentBeats / n) * 100),
      edgeDirectionHitRate: edgeDirTotal > 0 ? Math.round((edgeDirCorrect / edgeDirTotal) * 100) : null,
      edgeDirectionN: edgeDirTotal,
    },
    byConfidence: view(byConf),
    bySource: view(bySource),
    ...(from ? { from } : {}),
  };
}

// The KV fallback's bounds: the newest keys only, read a batch at a time.
export const BRIER_KV_MAX = 300;
export const BRIER_KV_BATCH = 25;

// Read a list of keys through `getOne` in parallel batches; a failed read is skipped.
export async function readInBatches(keys, getOne, batch = BRIER_KV_BATCH) {
  const out = [];
  for (let i = 0; i < keys.length; i += batch) {
    const part = await Promise.all(keys.slice(i, i + batch).map((k) => Promise.resolve().then(() => getOne(k)).catch(() => null)));
    for (const v of part) if (v) out.push(v);
  }
  return out;
}

// Wait for `promise` at most `ms`; resolves { done: true } or { done: false } and never throws.
export function settleWithin(promise, ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return new Promise((resolve) => {
    const t = setTimer(() => resolve({ done: false }), ms);
    Promise.resolve(promise).then(() => { clearTimer(t); resolve({ done: true }); }, () => { clearTimer(t); resolve({ done: true, failed: true }); });
  });
}

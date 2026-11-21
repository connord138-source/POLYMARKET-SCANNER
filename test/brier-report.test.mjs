// The agent's calibration report and the bounded reads behind it (src/brier-report.js).
import { readFileSync } from "node:fs";
import { brierRecordFromRow, buildBrierFromRecords, readInBatches, settleWithin, BRIER_KV_MAX, BRIER_KV_BATCH } from "../src/brier-report.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x === undefined ? "" : JSON.stringify(x)); } };

// ---------- a D1 row in the report's shape ----------
{
  const r = brierRecordFromRow({ status: "done", agent_brier: 0.04, market_brier: 0.16, edge_pts: 22.5, y: 1, confidence: "HIGH", source: "sweep" });
  check("row: the D1 names map onto the record's", r.status === "done" && r.agentBrier === 0.04 && r.marketBrier === 0.16 && r.edgePts === 22.5 && r.y === 1 && r.confidence === "HIGH" && r.source === "sweep", r);
  const open = brierRecordFromRow({ status: "done", agent_brier: null, market_brier: null, edge_pts: null, y: null, confidence: null, source: null });
  check("row: an unsettled row carries no scores and no outcome", open.agentBrier === null && open.marketBrier === null && open.y === null && open.edgePts === null && brierRecordFromRow(null) === null, open);
}

// ---------- the report ----------
{
  const empty = buildBrierFromRecords([{ status: "done" }, { status: "error_transient" }, { status: "pending" }, null]);
  check("report: nothing settled yet says so, with the counts", empty.overall === null && empty.byConfidence === null && /No ground-truth/.test(empty.note) && JSON.stringify(empty.counts) === JSON.stringify({ total: 3, done: 1, pending: 1, error: 1, scored: 0 }), empty);

  const recs = [
    { status: "done", agentBrier: 0.04, marketBrier: 0.16, edgePts: 20, y: 1, confidence: "HIGH", source: "sweep" },   // agent closer, edge right
    { status: "done", agentBrier: 0.36, marketBrier: 0.25, edgePts: 10, y: 0, confidence: "HIGH", source: "sweep" },   // market closer, edge wrong
    { status: "done", agentBrier: 0.09, marketBrier: 0.49, edgePts: -40, y: 0, confidence: "MEDIUM" },                  // edge right, no source
    { status: "done", agentBrier: 0.25, marketBrier: 0.25, edgePts: 0, y: 1 },                                          // no edge, no confidence
    { status: "done" },                                                                                                  // not settled
    { status: "error_permanent" },
  ];
  const rep = buildBrierFromRecords(recs, { from: "d1" });
  check("report: counts every record and scores the settled ones", JSON.stringify(rep.counts) === JSON.stringify({ total: 6, done: 5, pending: 0, error: 1, scored: 4 }), rep.counts);
  check("report: mean scores and the paired difference", rep.overall.n === 4 && rep.overall.meanAgentBrier === 0.185 && rep.overall.meanMarketBrier === 0.2875 && rep.overall.meanPairedDiff === 0.1025, rep.overall);
  check("report: a tie is not a win; the edge's direction is judged only where there is one", rep.overall.agentBeatsMarketRate === 50 && rep.overall.edgeDirectionN === 3 && rep.overall.edgeDirectionHitRate === 67, rep.overall);
  check("report: by confidence and by source, with the defaults", rep.byConfidence.HIGH.n === 2 && rep.byConfidence.HIGH.meanAgentBrier === 0.2 && rep.byConfidence.MEDIUM.n === 1 && rep.byConfidence.UNKNOWN.n === 1 && rep.bySource.sweep.n === 2 && rep.bySource.whale.n === 2 && rep.bySource.whale.meanMarketBrier === 0.37, { c: rep.byConfidence, s: rep.bySource });
  check("report: says where it was read from, and a partial read keeps the full total", rep.from === "d1" && buildBrierFromRecords(recs.slice(0, 2), { total: 1000, from: "kv" }).counts.total === 1000 && buildBrierFromRecords(recs).from === undefined);
  check("report: an edge with no recorded outcome is not judged", buildBrierFromRecords([{ status: "done", agentBrier: 0.1, marketBrier: 0.2, edgePts: 15, y: null }]).overall.edgeDirectionN === 0);
}

// ---------- the bounded KV read ----------
{
  let inFlight = 0, peak = 0, calls = 0;
  const keys = Array.from({ length: 60 }, (_, i) => "k" + i);
  const getOne = async (k) => {
    calls++; inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    if (k === "k7") throw new Error("kv read failed");
    if (k === "k9") return null;
    return { key: k };
  };
  const out = await readInBatches(keys, getOne);
  check("batches: every key read, never more than a batch at once", calls === 60 && peak <= BRIER_KV_BATCH && peak > 1, { calls, peak });
  check("batches: a failed or empty read is skipped, the order kept", out.length === 58 && out[0].key === "k0" && out[7].key === "k8" && out[57].key === "k59", { n: out.length });
  check("batches: the fallback's bounds stay under the Worker's limits", BRIER_KV_MAX <= 400 && BRIER_KV_BATCH <= 50 && (await readInBatches([], getOne)).length === 0);
}

// ---------- a wait that gives up ----------
{
  let fire = null, cleared = 0;
  const timers = { setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => { cleared++; } };
  const never = new Promise(() => {});
  const p1 = settleWithin(never, 8000, timers);
  fire();
  check("wait: gives up at the limit and says so", JSON.stringify(await p1) === JSON.stringify({ done: false }));
  const p2 = await settleWithin(Promise.resolve("x"), 8000, timers);
  check("wait: answers at once when the work finishes, and drops its timer", p2.done === true && cleared === 1, p2);
  const p3 = await settleWithin(Promise.reject(new Error("gamma down")), 8000, timers);
  check("wait: a failed read is finished too, never thrown", p3.done === true && p3.failed === true, p3);
}

// ---------- the worker and the snapshot job use them ----------
{
  const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  check("index: the brier report is one D1 read, with the bounded KV read behind it", /SELECT status, agent_brier, market_brier, edge_pts, y, confidence, source FROM investigations/.test(src) && /readInBatches\(idx\.slice\(-BRIER_KV_MAX\)/.test(src) && !/var inv = await env\.SIGNALS_CACHE\.get\(idx\[i\], \{ type: "json" \}\);\s*if \(!inv\) continue;\s*if \(inv\.status === "done"\) counts\.done\+\+/.test(src));
  check("index: the investigator route waits a bounded time for live prices", /await settleWithin\(drift, LIVE_PRICE_WAIT_MS\)/.test(src) && /var LIVE_PRICE_WAIT_MS = 8000;/.test(src));
  const wf = readFileSync(new URL("../.github/workflows/backend-snapshot.yml", import.meta.url), "utf8");
  check("snapshot: a failed read is tried once more", /curl -sf --max-time 45 --retry 1 --retry-delay 3 --retry-all-errors/.test(wf));
}

console.log(`brier-report: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

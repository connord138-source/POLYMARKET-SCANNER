// When each stage of the 5-minute cycle finished (src/stage-clock.js).
import { readFileSync } from "node:fs";
import { withStageClock, slowestStages } from "../src/stage-clock.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x === undefined ? "" : JSON.stringify(x)); } };

{
  let t = 1000;
  const st = withStageClock({ startedAt: "x", scan: null, error: null }, { now: () => t, startMs: 1000 });
  t = 1090; st.cryptoFv = { ok: true };
  t = 90000; st.scan = { signals: 240 };
  t = 91000; st.sweep = { running: true };
  t = 380000; st.settlement = { processed: 0 };
  t = 381000; st.error = "boom"; st.completedAt = "y";
  t = 400000; st.sweep = { done: 1 };
  check("clock: each stage's finish is recorded in ms from the start", st.stageMs.cryptoFv === 90 && st.stageMs.scan === 89000 && st.stageMs.settlement === 379000, st.stageMs);
  check("clock: a stage that reports twice keeps the later time", st.stageMs.sweep === 399000, st.stageMs);
  check("clock: bookkeeping keys are not stages", !("error" in st.stageMs) && !("completedAt" in st.stageMs) && !("stageMs" in st.stageMs) && st.error === "boom" && st.completedAt === "y");
  check("clock: the status still reads and serialises as a plain object", st.scan.signals === 240 && JSON.parse(JSON.stringify(st)).stageMs.scan === 89000 && Object.keys(st).includes("settlement") && { ...st }.cryptoFv.ok === true);
  const slow = slowestStages(st.stageMs, 3);
  check("slowest: the gap since the stage before, biggest first", slow.length === 3 && slow[0].stage === "settlement" && slow[0].ms === 290000 && slow[1].stage === "scan" && slow[1].ms === 88910 && slow[0].doneAtMs === 379000, slow);
  st.slowest = slow;
  check("slowest: storing the list is not a stage", !("slowest" in st.stageMs));
}
{
  check("slowest: nothing recorded, nothing listed", slowestStages({}).length === 0 && slowestStages(null).length === 0 && slowestStages({ a: "x" }).length === 0);
  const boom = withStageClock({}, { now: () => { throw new Error("clock broke"); }, startMs: 0 });
  boom.scan = { ok: 1 };
  check("clock: a broken clock never stops a stage's result being stored", boom.scan.ok === 1 && !("scan" in boom.stageMs));
}
{
  const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  check("index: the cycle's status is clocked and the slowest stages are stored", /const cronStatus = withStageClock\(\{/.test(src) && /cronStatus\.slowest = slowestStages\(cronStatus\.stageMs\)/.test(src));
}
console.log(`stage-clock: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

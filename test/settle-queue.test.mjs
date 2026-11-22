// The pending-signals list across a bounded settlement pass (src/settle-queue.js).
import { readFileSync } from "node:fs";
import { SETTLE_WALL_MS, SETTLE_CURSOR_KEY, PENDING_CAP, settleOrder, nextPendingList } from "../src/settle-queue.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x === undefined ? "" : JSON.stringify(x)); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- where a pass starts ----------
{
  const list = ["a", "b", "c", "d", "e"];
  check("order: no cursor, the list as stored", eq(settleOrder(list, null), list) && eq(settleOrder(list, ""), list));
  check("order: resumes at the signal the last pass stopped before, then wraps", eq(settleOrder(list, "d"), ["d", "e", "a", "b", "c"]));
  check("order: a cursor that settled or expired meanwhile starts from the top", eq(settleOrder(list, "zz"), list) && eq(settleOrder(list, "a"), list));
  check("order: never changes the stored list, and an empty one is fine", eq(list, ["a", "b", "c", "d", "e"]) && eq(settleOrder([], "a"), []) && eq(settleOrder(null, "a"), []));
}

// ---------- what is stored after a pass ----------
{
  const start = ["a", "b", "c", "d", "e"];
  // a full pass: b and d settled
  check("next: a full pass keeps the open ones in the stored order", eq(nextPendingList({ start, kept: ["a", "c", "e"], unchecked: [], fresh: start }), ["a", "c", "e"]));
  // the budget ran out after d, e (resumed at d): d settled, e open; a, b, c never reached
  check("next: signals the budget did not reach stay on the list, order kept", eq(nextPendingList({ start, kept: ["e"], unchecked: ["a", "b", "c"], fresh: start }), ["a", "b", "c", "e"]));
  // a scan added f and g while the pass ran
  check("next: a signal added while the pass ran is kept, not overwritten", eq(nextPendingList({ start, kept: ["a", "c", "e"], unchecked: [], fresh: ["a", "b", "c", "d", "e", "f", "g"] }), ["a", "c", "e", "f", "g"]));
  check("next: a settled signal still on the fresh list is not brought back", eq(nextPendingList({ start, kept: ["a"], unchecked: [], fresh: ["b", "c", "d", "e", "a"] }), ["a"]));
  check("next: the list could not be read again: what the pass knows is stored", eq(nextPendingList({ start, kept: ["a", "c"], unchecked: ["e"], fresh: null }), ["a", "c", "e"]));
  check("next: no duplicates", eq(nextPendingList({ start: ["a", "a", "b"], kept: ["a", "b"], unchecked: [], fresh: ["a", "b", "c", "c"] }), ["a", "b", "c"]));
  const big = Array.from({ length: PENDING_CAP }, (_, i) => "s" + i);
  const capped = nextPendingList({ start: big, kept: big, unchecked: [], fresh: big.concat(["n1", "n2"]) });
  check("next: the cap drops the oldest, as the scan's own cap does", capped.length === PENDING_CAP && capped[0] === "s2" && capped[capped.length - 1] === "n2");
}

// ---------- the worker uses them ----------
{
  check("budget: under two minutes, so a slow Gamma cannot hold the cycle past the next one", SETTLE_WALL_MS >= 30000 && SETTLE_WALL_MS <= 120000 && SETTLE_CURSOR_KEY === "settle_cursor");
  const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  check("index: the pass stops at its deadline and resumes at the cursor", /const settleList = settleOrder\(pendingSignals, settleCursor\);/.test(src) && /if \(Date\.now\(\) > settleDeadline\) break;/.test(src));
  check("index: the list is read again and merged before it is written", /nextPendingList\(\{ start: pendingSignals, kept: stillPending, unchecked: settleUnchecked, fresh: pendingNow \}\)/.test(src) && !/PENDING_SIGNALS, JSON\.stringify\(stillPending\)\)/.test(src));
}

console.log(`settle-queue: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

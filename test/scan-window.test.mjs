// The whale scan's window (src/scan-window.js). Run with: node test/scan-window.test.mjs
import { scanWindow, scanResultShape, scanParams } from "../src/scan-window.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };

const now = Date.parse("2026-11-03T19:00:00Z");
const h = (hrs) => new Date(now - hrs * 3600e3).toISOString();
const sig = (id, hrsAgo, score, extra = {}) => ({ id, firstTradeTime: h(hrsAgo), score, avgEntryPrice: 50, ...extra });

// a week of stored signals: only the last 48h with a live event and score >= 30 survive
const stored = [
  sig("fresh-high", 2, 90),
  sig("fresh-mid", 30, 45),
  sig("fresh-low", 5, 10),                                 // under the score cut
  sig("old", 60, 99),                                      // outside 48h
  sig("week-old", 160, 99),
  sig("started", 3, 80, { marketTitle: "STARTED" }),       // event already started
  sig("over", 4, 80, { marketTitle: "OVER" }),             // event date + buffer passed
  sig("resolved-hi", 1, 80, { currentPrice: 99 }),         // priced at a resolution level
  sig("resolved-lo", 1, 80, { currentPrice: 1, avgEntryPrice: 40 }),
  sig("no-time", 1, 80, { firstTradeTime: undefined }),   // no first trade time: out
  null, "junk",
];
const isStarted = (s) => s.marketTitle === "STARTED";
const isOver = (s) => s.marketTitle === "OVER";
const w = scanWindow(stored, { hoursBack: 48, minScore: 30, nowMs: now, isStarted, isOver });
check("final: only fresh, live, unresolved signals at the score cut, best first", w.final.map(s => s.id).join() === "fresh-high,fresh-mid", w.final.map(s => s.id));
check("windowed counts the 48h window only (the scan's filteredByTimeWindow)", w.windowed.length === 7 && !w.windowed.some(s => s.id === "old" || s.id === "week-old" || s.id === "no-time"), w.windowed.map(s => s.id));
check("notStarted drops the started event (afterEventStartedFilter)", w.notStarted.length === 6 && !w.notStarted.some(s => s.id === "started"));
check("active drops resolved prices and past events, keeps the low score for the debug view", w.active.map(s => s.id).sort().join() === "fresh-high,fresh-low,fresh-mid", w.active.map(s => s.id));
check("currentPrice wins over avgEntryPrice; a missing price is kept", scanWindow([sig("np", 1, 50, { avgEntryPrice: undefined })], { hoursBack: 48, minScore: 30, nowMs: now }).final.length === 1);
check("the boundary: exactly hoursBack ago is in", scanWindow([sig("edge", 48, 50)], { hoursBack: 48, minScore: 30, nowMs: now }).final.length === 1 && scanWindow([sig("past", 48.01, 50)], { hoursBack: 48, minScore: 30, nowMs: now }).final.length === 0);
check("nothing in, nothing out; predicates default to keep", scanWindow(null, { hoursBack: 48, minScore: 30, nowMs: now }).final.length === 0 && scanWindow([sig("a", 1, 30)], { hoursBack: 48, minScore: 30, nowMs: now }).final.length === 1);
// the Nov 3 case: a 15k-row week cut to the scan's size
const week = Array.from({ length: 15000 }, (_, i) => sig(`s${i}`, (i % 168) + 0.5, 30 + (i % 70)));
const cut = scanWindow(week, { hoursBack: 48, minScore: 30, nowMs: now }).final;
check("a week of 15,000 stored signals is cut to the last 48h (~2/7 of them), never the whole list", cut.length > 4000 && cut.length < 4400 && cut.every(s => Date.parse(s.firstTradeTime) >= now - 48 * 3600e3), cut.length);
check("final is sorted best first", cut.every((s, i) => i === 0 || cut[i - 1].score >= s.score));

// the route's answer from the stored list: runScan's shape
{
  const final = [
    { id: "a", score: 120, suspiciousVolume: 50000, hasWinningWallet: true },
    { id: "b", score: 90, suspiciousVolume: 20000 },
    { id: "c", score: 65, suspiciousVolume: "1000" },
    { id: "d", score: 45 },
  ];
  const r = scanResultShape(final, { hoursBack: 24, scanTime: "2026-11-04T01:00:00Z", whaleSkill: { annotated: 4 }, debug: { servedFrom: "stored" } });
  const keys = ["success", "scanTime", "hoursScanned", "totalSignals", "signalsWithWinners", "whaleSkill", "criticalCount", "highRiskCount", "mediumRiskCount", "totalSuspiciousVolume", "signals", "_debug"];
  check("scanResultShape carries every key runScan returns", keys.every(k => k in r), Object.keys(r));
  check("scanResultShape counts: total, winners, bands, volume (a missing or string volume does not poison the sum)", r.success === true && r.totalSignals === 4 && r.signalsWithWinners === 1 && r.criticalCount === 1 && r.highRiskCount === 1 && r.mediumRiskCount === 1 && r.totalSuspiciousVolume === 71000 && r.hoursScanned === 24 && r.scanTime === "2026-11-04T01:00:00Z" && r.signals === final && r._debug.servedFrom === "stored", r);
  check("scanResultShape on nothing", scanResultShape(null, { hoursBack: 48 }).totalSignals === 0 && scanResultShape(null, {}).signals.length === 0);
}
// the route's parameters
{
  const d = scanParams(null, null);
  check("scanParams: defaults 48h / 40 when absent", d.hours === 48 && d.minScore === 40, d);
  check("scanParams: the pages' values pass through", JSON.stringify(scanParams("24", "15")) === JSON.stringify({ hours: 24, minScore: 15 }));
  check("scanParams: hours clamped to the stored week, junk takes the defaults, 0 minScore kept", scanParams("9999", "0").hours === 168 && scanParams("9999", "0").minScore === 0 && scanParams("abc", "-5").hours === 48 && scanParams("abc", "-5").minScore === 40 && scanParams("0", "x").hours === 48);
}

console.log(`scan-window: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

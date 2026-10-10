// Speed telemetry: once-per-side tracking, lag, checkpoint scheduling.
// Run with: node test/speed.test.mjs
import { trackSpeed, updateSpeed, dueCheckpoints } from "../src/speed.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };

function env() {
  const store = {}, writes = [];
  return {
    store, writes,
    SIGNALS_CACHE: {
      get: async (k, o) => (k in store ? (o && o.type === "json" ? JSON.parse(store[k]) : store[k]) : null),
      put: async (k, v) => { store[k] = v; },
    },
    DB: { prepare: (sql) => { const st = { sql, args: [] }; st.bind = (...a) => { st.args = a; return st; }; st.run = async () => { writes.push(st); }; return st; } },
  };
}

// 1. tracks once per market+side, records lag + detect price
{
  const e = env();
  const sig = { id: "s1", marketSlug: "m1", directionRaw: "Yes", detectedAt: "2026-10-10T00:05:00Z", lastTradeTime: "2026-10-10T00:02:00Z" };
  const r = await trackSpeed(e, sig, async () => 41.5);
  check("1: lag 180s", r && r.lagSec === 180, JSON.stringify(r));
  check("1: detect price", e.writes[0].args[2] === 41.5 && /price_detect/.test(e.writes[0].sql));
  const again = await trackSpeed(e, { ...sig, id: "s2" }, async () => 99);
  check("1: second detection ignored", again === null && JSON.parse(e.store.speed_watch).length === 1);
  const other = await trackSpeed(e, { ...sig, id: "s3", directionRaw: "No" }, async () => 58);
  check("1: other side tracked", other && JSON.parse(e.store.speed_watch).length === 2);
}
// 2. checkpoint schedule
{
  const t0 = 0, ent = { t0, done: [] };
  check("2: none at 3m", dueCheckpoints(ent, 3 * 60000).length === 0);
  check("2: 5m due at 6m", dueCheckpoints(ent, 6 * 60000).map(c => c.col).join() === "price_5m");
  check("2: all due at 70m", dueCheckpoints(ent, 70 * 60000).length === 3);
}
// 3. updateSpeed writes the right column, late run only writes latest, drops finished
{
  const e = env();
  const now = Date.now();
  e.store.speed_watch = JSON.stringify([
    { id: "a", slug: "m", side: "Yes", t0: now - 6 * 60000, done: [] },        // 5m due
    { id: "b", slug: "m2", side: "No", t0: now - 40 * 60000, done: [] },        // 5m+15m due, late
    { id: "c", slug: "m3", side: "Yes", t0: now - 61 * 60000, done: ["price_5m", "price_15m"] }, // 60m -> finished
  ]);
  let calls = 0;
  const r = await updateSpeed(e, async () => { calls++; return 50; });
  const cols = e.writes.map(w => [w.args[0], (w.sql.match(/SET (\w+)=/) || [])[1]]);
  check("3: a -> 5m", cols.some(([id, c]) => id === "a" && c === "price_5m"), JSON.stringify(cols));
  check("3: b late -> only 15m", cols.filter(([id]) => id === "b").length === 1 && cols.some(([id, c]) => id === "b" && c === "price_15m"), JSON.stringify(cols));
  check("3: c -> 60m", cols.some(([id, c]) => id === "c" && c === "price_60m"));
  const w = JSON.parse(e.store.speed_watch);
  check("3: c dropped", !w.some(x => x.id === "c") && r.dropped === 1, JSON.stringify(r));
  check("3: 3 gamma calls", calls === 3, calls);
}
// 4. call budget respected
{
  const e = env();
  const now = Date.now();
  e.store.speed_watch = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ id: "x" + i, slug: "m" + i, side: "Yes", t0: now - 6 * 60000, done: [] })));
  let calls = 0;
  await updateSpeed(e, async () => { calls++; return 50; }, 4);
  check("4: budget", calls === 4, calls);
  check("4: unpriced stay pending", JSON.parse(e.store.speed_watch).filter(x => x.done.length === 0).length === 6);
}

console.log(`# ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

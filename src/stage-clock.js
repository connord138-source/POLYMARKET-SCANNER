// ============================================================
// STAGE-CLOCK.JS — when each stage of the 5-minute cycle finished
// ============================================================
//
// Nov 22 2026: the cycle that starts at 15:00 UTC ran 312s, 402s and 437s
// on three of five days (60-180s otherwise), past the five minutes between
// cycles, and the status record could not say which stage took the time.
// Every stage ends by assigning its result to the status object, so the
// clock simply watches those assignments: `stageMs.<key>` is the number of
// milliseconds into the cycle at which <key> was last set, and `slowest`
// lists the biggest gaps between one stage finishing and the next.

const SKIP = new Set(['stageMs', 'slowest', 'error', 'startedAt', 'completedAt']);

// Wrap a status object. Assigning any other key records the time it was set.
export function withStageClock(status, { now = Date.now, startMs = now() } = {}) {
  const stageMs = {};
  status.stageMs = stageMs;
  return new Proxy(status, {
    set(target, key, value) {
      target[key] = value;
      if (typeof key === 'string' && !SKIP.has(key)) {
        // a stage that reports twice (running, then its result) keeps the later time
        try { stageMs[key] = Math.max(0, Math.round(now() - startMs)); } catch (e) { /* never fatal */ }
      }
      return true;
    },
  });
}

// The stages that took longest: each stage's time is the gap since the stage
// that finished before it. A stage that runs beside the others (the research
// sweep) reads long here because it is long, not because it held the cycle.
export function slowestStages(stageMs, top = 5) {
  const rows = Object.entries(stageMs || {}).filter(([, v]) => typeof v === 'number').sort((a, b) => a[1] - b[1]);
  const out = [];
  let prev = 0;
  for (const [key, at] of rows) { out.push({ stage: key, ms: at - prev, doneAtMs: at }); prev = at; }
  return out.sort((a, b) => b.ms - a.ms).slice(0, top);
}

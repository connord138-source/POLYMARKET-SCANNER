// ============================================================
// SCAN-WINDOW.JS — the whale scan's own window over a signal list
// ============================================================
//
// runScan merges each run's fresh signals into the stored 7-day list (KV
// `signals`, ~15k rows) and returns only a window of it: first trade within
// hoursBack, the event not started, not priced at a resolution level, the
// event not past, then the score cut, best first. The cron's failed-scan
// fallback (Nov 3 2026, after Data API v2 started answering 429) must apply
// the same window to the stored list; it first handed the auto-trader the
// whole week (15,059 signals on the 15:25 UTC cycle, every one skipped by the
// entry gates, none entered, but nothing guaranteed that).
//
// The event-date checks live in index.js (hasEventStarted, getEventDate) and
// come in as predicates, so this stays pure:
//   isStarted(s) -> true drops the signal (the "afterEventStartedFilter" step)
//   isOver(s)    -> true drops the signal (event date + buffer passed)
// Returns every step, for the scan's debug counts:
//   { windowed, notStarted, active, final }
export function scanWindow(signals, { hoursBack, minScore, nowMs = Date.now(), isStarted = () => false, isOver = () => false } = {}) {
  const cutoff = nowMs - hoursBack * 60 * 60 * 1000;
  const list = Array.isArray(signals) ? signals.filter(s => s && typeof s === 'object') : [];
  const windowed = list.filter(s => new Date(s.firstTradeTime).getTime() >= cutoff);
  const notStarted = windowed.filter(s => !isStarted(s));
  const active = notStarted.filter(s => {
    const price = s.currentPrice || s.avgEntryPrice;
    if (price >= 99 || price <= 1) return false;    // resolved on the price
    return !isOver(s);
  });
  const final = active.filter(s => s.score >= minScore).sort((a, b) => b.score - a.score);
  return { windowed, notStarted, active, final };
}

// The scan route's answer from a windowed list, in the shape runScan returns
// (Nov 4 2026: GET /scan used to run a full live scan on every page load,
// 45-160s each and refused about 40% of the time by Data API v2, so the
// Today page, the Scanner and Vegas Odds sat on their loaders and needed
// refreshes; the route now serves the list the 5-minute cron keeps fresh).
// Call after the wallet-skill annotation, which sets hasWinningWallet.
export function scanResultShape(final, { hoursBack, scanTime, whaleSkill = null, debug = {} } = {}) {
  const list = Array.isArray(final) ? final : [];
  return {
    success: true,
    scanTime,
    hoursScanned: hoursBack,
    totalSignals: list.length,
    signalsWithWinners: list.filter((s) => s.hasWinningWallet).length,
    whaleSkill,
    criticalCount: list.filter((s) => s.score >= 100).length,
    highRiskCount: list.filter((s) => s.score >= 80 && s.score < 100).length,
    mediumRiskCount: list.filter((s) => s.score >= 60 && s.score < 80).length,
    totalSuspiciousVolume: list.reduce((sum, s) => sum + (Number(s.suspiciousVolume) || 0), 0),
    signals: list,
    _debug: debug,
  };
}

// The route's parameters, clamped: hours 1-168 (the stored list is 7 days),
// minScore 0-1000; anything unreadable takes the route's defaults.
export function scanParams(hoursRaw, minScoreRaw, { hours = 48, minScore = 40 } = {}) {
  const h = parseInt(hoursRaw, 10), m = parseInt(minScoreRaw, 10);
  return {
    hours: Number.isFinite(h) && h > 0 ? Math.min(h, 168) : hours,
    minScore: Number.isFinite(m) && m >= 0 ? Math.min(m, 1000) : minScore,
  };
}

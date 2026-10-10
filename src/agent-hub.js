// ============================================================
// AGENT-HUB.JS — one payload for the Agent Hub / Council / Orbit views
// ============================================================
//
// The frontend's "spaceship" shows each part of the pipeline as a room with
// agents working in it. Every number here is read from the same KV/D1 state
// the bot trades on: nothing is simulated. Cached 60s in KV so a page left
// open doesn't hammer D1.
//
// Rooms:
//   research  scanner        signals scanned, last cron, tracked wallets
//   forge     strategy forge  candidates generated / promoted / overfit
//   backtest  backtest        best near-misses (train vs test ROI)
//   council   council         recent sessions + "who called it"
//   desk      trading desk    open positions, today's entries by lane
//   vault     win/loss vault  lifetime + today P&L, recent closes
//   bridge    captain         mode (paper/live), kill switches, alerts
// ============================================================

const CACHE_KEY = 'agent_hub_cache';
const CACHE_TTL_MS = 60 * 1000;
const COUNCIL_AGENTS = ['GREED', 'FOMO', 'PANIC', 'DOUBT', 'QUANT', 'RISK'];

const kvJson = async (env, key) => {
  try { return await env.SIGNALS_CACHE.get(key, { type: 'json' }); } catch (e) { return null; }
};
const r2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x);

// Pure: unify decisions, council sessions and closes into one time-ordered
// event list the hub animates (an agent walks to the room for each event).
export function buildEvents({ tradeLog = [], council = [], history = [] }, limit = 40) {
  const ev = [];
  for (const d of tradeLog) {
    const t = d.timestamp || d.at;
    if (!t) continue;
    if (d.type === 'PAPER_TRADE' || d.type === 'LIVE_TRADE' || d.type === 'QUEUED') {
      ev.push({ at: t, room: 'desk', kind: 'entry', text: `${d.market} @ ${r2(d.entryPrice)}¢ $${d.size}`, lane: d.walletTier || null });
    } else if (d.type === 'EXIT') {
      ev.push({ at: t, room: 'vault', kind: (d.pnl || 0) >= 0 ? 'win' : 'loss', text: `${d.market} ${d.pnl >= 0 ? '+' : ''}$${r2(d.pnl)}` });
    } else if (d.type === 'SKIP') {
      ev.push({ at: t, room: 'research', kind: 'skip', text: `${d.market}: ${d.reason}` });
    }
  }
  for (const c of council) {
    ev.push({ at: c.at, room: 'council', kind: (c.tiebreak && c.tiebreak.verdict) || c.verdict, text: `${c.market}: ${c.verdict} (${c.reason})` });
  }
  for (const h of history) {
    const t = h.closedAt || h.settledAt;
    if (!t || (h.outcome !== 'win' && h.outcome !== 'loss')) continue;
    ev.push({ at: t, room: 'vault', kind: h.outcome, text: `${h.marketTitle} ${h.pnl >= 0 ? '+' : ''}$${r2(h.pnl)}` });
  }
  const seen = new Set();
  return ev
    .filter(e => { const k = e.at + e.room + e.text; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit);
}

export function councilBoard(stats) {
  const agents = (stats && stats.agents) || {};
  return COUNCIL_AGENTS.map(agent => {
    const a = agents[agent] || { calls: 0, correct: 0 };
    return { agent, calls: a.calls || 0, accuracy: a.calls ? Math.round((a.correct / a.calls) * 100) : null };
  }).sort((x, y) => (y.accuracy ?? -1) - (x.accuracy ?? -1));
}

export async function buildAgentHub(env, deps) {
  const { getBotPerformance, getOpenPositions, getTradeLog, getTradeHistory, getDailyStats, getAutotraderConfig } = deps;
  if (env.SIGNALS_CACHE) {
    const cached = await kvJson(env, CACHE_KEY);
    if (cached && cached.builtAt && Date.now() - new Date(cached.builtAt).getTime() < CACHE_TTL_MS) return cached;
  }
  const [perf, positions, tradeLog, history, daily, config, cron, forge, councilFeed, councilStats, laneV3] = await Promise.all([
    getBotPerformance(env).catch(() => null),
    getOpenPositions(env).catch(() => []),
    getTradeLog(env, 40).catch(() => []),
    getTradeHistory(env, 40).catch(() => []),
    getDailyStats(env).catch(() => null),
    getAutotraderConfig(env).catch(() => ({})),
    kvJson(env, 'cron_last_run'),
    kvJson(env, 'forge_report'),
    kvJson(env, 'council_feed'),
    kvJson(env, 'council_agent_stats'),
    kvJson(env, 'edge_lane_stats_v3'),
  ]);

  let wallets = { tracked: null, top: [] };
  if (env.DB) {
    try {
      const c = await env.DB.prepare('SELECT COUNT(DISTINCT wallet) n FROM signal_wallets').first();
      wallets.tracked = c ? c.n : null;
    } catch (e) {}
  }

  const at = (cron && cron.autotrader) || {};
  const lanes = {
    whale: { entered: at.tradesPaperTraded ?? null, evaluated: at.evaluated ?? null },
    vegas: (at.vegasEdge) || null,
    forge: (at.forgeLane) || null,
  };
  const byCat = {};
  for (const p of positions || []) {
    const k = p.marketCategory || 'other';
    (byCat[k] = byCat[k] || []).push({
      id: p.id, title: p.marketTitle, side: p.directionRaw || p.direction, entry: p.entryPrice,
      size: p.size, openedAt: p.openedAt, lane: p.strategySource || (p.isExploration ? 'exploration' : 'whale'),
      council: p.council ? p.council.verdict : null,
    });
  }

  const hub = {
    success: true,
    builtAt: new Date().toISOString(),
    mode: config.paperTradeMode === false ? 'LIVE' : 'PAPER',
    rooms: {
      research: {
        lastScanAt: cron ? (cron.completedAt || cron.startedAt) : null,
        signals: cron && cron.scan ? cron.scan.signals : null,
        trackedWallets: wallets.tracked,
        walletLedger: cron ? cron.walletLedger || null : null,
        speed: cron ? cron.speed || null : null,
        agentsOnline: !(cron && cron.investigations && /credits/.test(cron.investigations.skipped || '')),
      },
      forge: forge ? {
        ranAt: forge.ranAt, verdict: forge.verdict, counts: forge.counts || null,
        promoted: (forge.promoted || []).map(p => ({ id: p.id, test: p.test, train: p.train })),
      } : { ranAt: null, verdict: 'Forge has not run yet.' },
      backtest: forge ? {
        nearMisses: (forge.nearMisses || []).slice(0, 6).map(c => ({ id: c.id, train: c.train, test: c.test, fails: (c.fails || []).slice(0, 2) })),
        overfit: (forge.overfit || []).slice(0, 4).map(c => ({ id: c.id, train: c.train, test: c.test })),
      } : { nearMisses: [], overfit: [] },
      council: {
        mode: config.councilMode || 'shadow',
        enabled: config.councilEnabled !== false,
        board: councilBoard(councilStats),
        chair: (councilStats && councilStats.chair) || {},
        recent: (councilFeed || []).slice(0, 8),
      },
      desk: { open: (positions || []).length, byCategory: byCat, lanes, today: daily },
      vault: {
        lifetime: perf ? { trades: perf.totalTrades, wins: perf.wins, losses: perf.losses, winRate: perf.winRate, pnl: r2(perf.totalPnL) } : null,
        today: daily ? { pnl: r2(daily.realizedPnL), wins: daily.wins, losses: daily.losses } : null,
        recent: (history || []).slice(0, 8).map(h => ({ title: h.marketTitle, pnl: r2(h.pnl), outcome: h.outcome, closedAt: h.closedAt, lane: h.strategySource || 'whale' })),
        vegasLane: laneV3 ? laneV3.overall : null,
      },
      bridge: {
        enabled: config.enabled !== false,
        dailyLossLimit: config.dailyLossLimit ?? null,
        maxOpenPositions: config.maxOpenPositions ?? null,
        cronError: cron ? cron.error || null : null,
      },
    },
    events: buildEvents({ tradeLog: tradeLog || [], council: councilFeed || [], history: history || [] }),
  };
  if (env.SIGNALS_CACHE) {
    try { await env.SIGNALS_CACHE.put(CACHE_KEY, JSON.stringify(hub), { expirationTtl: 300 }); } catch (e) {}
  }
  return hub;
}

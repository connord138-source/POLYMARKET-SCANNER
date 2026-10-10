// ============================================================
// COUNCIL.JS — persona agents vote on every entry the gates pass
// ============================================================
//
// Six rule-based personas each read a different slice of the evidence the
// scanner already computes and cast YES / NO / ABSTAIN with a conviction.
// The CHAIR tallies the votes, weighting each agent by its settled track
// record (its "Who called it?" accuracy), and returns APPROVE / TRIM / VETO.
//
// No LLM call per agent. A single cheap Claude call is used only as a
// TIEBREAK on close votes, and only when councilLlmTiebreak is on, the API
// key is set, credits aren't exhausted, and the daily cap isn't spent.
//
// Modes (config.councilMode):
//   'shadow'   (default) record votes + verdict, never change the trade.
//              Settled outcomes build the per-agent ledger and the chair's
//              counterfactual (how VETO'd trades actually did).
//   'advisory' apply TRIM sizing only; VETO is still recorded, not enforced.
//   'gate'     enforce VETO (skip) and TRIM (size x councilTrimMultiplier).
//
// Promote shadow -> gate only when GET /autotrader/council shows the VETO
// bucket losing money over a real sample. Same discipline as the agent
// opinion ledger: nothing blocks entries until it has proven it should.
// ============================================================

export const COUNCIL_AGENTS = ['GREED', 'FOMO', 'PANIC', 'DOUBT', 'QUANT', 'RISK'];

export const COUNCIL_KEYS = {
  STATS: 'council_agent_stats',   // per-agent call accuracy + chair verdict ledger
  FEED: 'council_feed',           // ring buffer of recent sessions (for the UI)
  LLM_DAY: 'council_llm:',        // + YYYY-MM-DD daily tiebreak counter
};

const FEED_MAX = 60;
const MIN_CALLS_FOR_WEIGHT = 20;  // agent keeps weight 1.0 until it has this many settled calls

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2 = (x) => Math.round(x * 100) / 100;

function vote(agent, v, conviction, line) {
  return { agent, vote: v, conviction: r2(clamp(conviction, 0, 1)), line };
}

// ---------- the personas ----------
// Every persona is a pure function of (ctx) so the whole council can be
// replayed over historical signals by the backtester.

// GREED — "is there money on the table?" Reads the entry band's settled
// historical edge (win rate − price − spread) the scanner attaches.
function greed(ctx) {
  const { signal } = ctx;
  const e = typeof signal.historicalEdgeNet === 'number' ? signal.historicalEdgeNet : null;
  if (e === null) return vote('GREED', 'ABSTAIN', 0, 'No band history. Nothing to count yet.');
  if (e >= 2) return vote('GREED', 'YES', e / 10, `Band ${signal.edgeBand} pays +${e}pt net. Take it.`);
  if (e <= -2) return vote('GREED', 'NO', -e / 10, `Band ${signal.edgeBand} bleeds ${e}pt. No money here.`);
  return vote('GREED', 'ABSTAIN', 0.1, `Band ${signal.edgeBand} is flat (${e}pt).`);
}

// FOMO — "is the smart money piling in right now?" Flow, size, timing.
function fomo(ctx) {
  const { signal } = ctx;
  const f = new Set(signal.factors || []);
  let pts = 0;
  const why = [];
  if (f.has('lastMinute2h')) { pts += 2; why.push('last-2h flow'); }
  else if (f.has('lastMinute6h')) { pts += 1; why.push('last-6h flow'); }
  if (f.has('coordinated')) { pts += 2; why.push('coordinated wallets'); }
  if (f.has('whaleSize50k')) { pts += 2; why.push('$50k+ whale'); }
  else if (f.has('whaleSize25k')) { pts += 1.5; why.push('$25k+ whale'); }
  else if (f.has('whaleSize15k')) { pts += 1; why.push('$15k+ whale'); }
  if ((signal.uniqueWallets || signal.numWallets || 0) >= 3) { pts += 1; why.push(`${signal.uniqueWallets || signal.numWallets} wallets`); }
  if (f.has('sharpVsPublic')) { pts += 1; why.push('sharp vs public'); }
  const largest = signal.largestBet || 0;
  if (pts >= 2) return vote('FOMO', 'YES', pts / 6, `${why.join(', ')}. Everyone's in, GET IN.`);
  if (pts === 0 && largest < 5000) return vote('FOMO', 'NO', 0.4, `One $${Math.round(largest / 1000)}k ticket and no crowd. Boring.`);
  return vote('FOMO', 'ABSTAIN', 0.1, why.length ? `Some heat: ${why.join(', ')}.` : 'Lukewarm flow.');
}

// PANIC — "what's about to go wrong?" Chasing a moved price, a bad day,
// a losing streak.
function panic(ctx) {
  const { signal, evaluation, dailyStats, perf, config } = ctx;
  const whale = signal.avgEntryPrice ?? signal.entryPrice ?? null;
  const ours = evaluation.entryPrice;
  const alarms = [];
  let sev = 0;
  if (typeof whale === 'number' && typeof ours === 'number') {
    const ourSideWhale = signal.direction === 'NO' ? 100 - whale : whale;
    const chase = ours - ourSideWhale;
    if (chase >= 3) { sev += chase / 10; alarms.push(`chasing +${Math.round(chase)}¢ past the whale`); }
  }
  const lossLimit = Math.abs(config.dailyLossLimit || 0);
  const pnl = dailyStats.realizedPnL || 0;
  if (lossLimit > 0 && pnl < 0 && -pnl >= lossLimit * 0.5) { sev += 0.4; alarms.push(`down $${Math.abs(Math.round(pnl))} today`); }
  if ((perf && perf.currentStreak) <= -3) { sev += 0.3; alarms.push(`${Math.abs(perf.currentStreak)}-loss streak`); }
  if (alarms.length) return vote('PANIC', 'NO', sev, `${alarms.join(', ')}. My chair is shaking.`);
  return vote('PANIC', 'YES', 0.2, 'Nothing on fire. Fine. FINE.');
}

// DOUBT — "is any of this real or just a small sample?"
function doubt(ctx) {
  const { signal, evaluation } = ctx;
  const walletBets = evaluation.walletBets || 0;
  const bandN = signal.historicalEdgeSamples || 0;
  const issues = [];
  if (evaluation.isExploration) issues.push('exploration entry (unproven band)');
  if (evaluation.isHighConviction) issues.push('no verified wallet');
  else if (walletBets < 10) issues.push(`wallet only ${walletBets} bets`);
  if (bandN < 30) issues.push(`band n=${bandN}`);
  if (issues.length >= 2) return vote('DOUBT', 'NO', 0.25 * issues.length, `${issues.join(', ')}. Could be luck.`);
  if (issues.length === 0) return vote('DOUBT', 'YES', 0.5, `Wallet ${walletBets} bets, band n=${bandN}. I'll allow it.`);
  return vote('DOUBT', 'ABSTAIN', 0.2, `${issues[0]}. Not convinced either way.`);
}

// QUANT — "what does an independent price say?" Investigator probability
// first, Vegas devig second.
function quant(ctx) {
  const { agentView, signal, evaluation } = ctx;
  if (agentView && typeof agentView.agentEdgePts === 'number') {
    const e = agentView.agentEdgePts;
    if (e >= 3) return vote('QUANT', 'YES', e / 15, `Model ${Math.round(agentView.agentProb * 100)}% vs ${evaluation.entryPrice}¢. edge ${e}¢ after fees. take it.`);
    if (e <= -3) return vote('QUANT', 'NO', -e / 15, `Model ${Math.round(agentView.agentProb * 100)}% vs ${evaluation.entryPrice}¢. negative edge. pass.`);
    return vote('QUANT', 'ABSTAIN', 0.1, `Model agrees with the price (${e}¢).`);
  }
  if (typeof signal.vegasProb === 'number' && typeof evaluation.entryPrice === 'number') {
    const e = Math.round((signal.vegasProb - evaluation.entryPrice) * 10) / 10;
    if (e >= 3) return vote('QUANT', 'YES', e / 15, `Vegas ${signal.vegasProb}% vs ${evaluation.entryPrice}¢. +${e}.`);
    if (e <= -3) return vote('QUANT', 'NO', -e / 15, `Vegas ${signal.vegasProb}% vs ${evaluation.entryPrice}¢. ${e}.`);
  }
  return vote('QUANT', 'ABSTAIN', 0, 'No independent price. Abstain.');
}

// RISK — "what does this do to the book?"
function risk(ctx) {
  const { config, openPositions, evaluation, category } = ctx;
  const atRisk = openPositions.reduce((s, p) => s + (p.size || 0), 0);
  const cap = (config.bankroll || 1000) * ((config.maxPortfolioRisk || 50) / 100);
  const util = cap > 0 ? (atRisk + (evaluation.positionSize || 0)) / cap : 0;
  const sameCat = openPositions.filter(p => p.marketCategory === category).length;
  const issues = [];
  if (util >= 0.8) issues.push(`book ${Math.round(util * 100)}% of risk cap`);
  if (sameCat >= 3) issues.push(`${sameCat} open in ${category}`);
  if (issues.length) return vote('RISK', 'NO', 0.35 * issues.length + (util - 0.8), `${issues.join(', ')}. Too correlated.`);
  return vote('RISK', 'YES', clamp(0.6 - util, 0.1, 0.6), `Book at ${Math.round(util * 100)}%. Room for it.`);
}

const PERSONAS = { GREED: greed, FOMO: fomo, PANIC: panic, DOUBT: doubt, QUANT: quant, RISK: risk };

// ---------- weights from the ledger ----------
// Accuracy is smoothed with a Beta(5,5) prior so a 3-for-3 agent doesn't
// get max weight. weight = 1 + 4*(acc - 0.5), clamped to [0.25, 2].
export function agentWeight(stats, agent) {
  const s = stats && stats.agents && stats.agents[agent];
  if (!s || (s.calls || 0) < MIN_CALLS_FOR_WEIGHT) return 1;
  const acc = ((s.correct || 0) + 5) / ((s.calls || 0) + 10);
  return r2(clamp(1 + 4 * (acc - 0.5), 0.25, 2));
}

// ---------- the session ----------
export function conveneCouncil(ctx, stats) {
  const votes = COUNCIL_AGENTS.map(a => {
    const v = PERSONAS[a](ctx);
    v.weight = agentWeight(stats, a);
    return v;
  });
  let wYes = 0, wNo = 0, yes = 0, no = 0;
  for (const v of votes) {
    const w = v.weight * Math.max(v.conviction, 0.05);
    if (v.vote === 'YES') { wYes += w; yes++; }
    else if (v.vote === 'NO') { wNo += w; no++; }
  }
  const total = wYes + wNo;
  const margin = total > 0 ? r2((wYes - wNo) / total) : 0;
  const band = ctx.config.councilCloseMargin ?? 0.2;

  let verdict, reason;
  const panicV = votes.find(v => v.agent === 'PANIC');
  const riskV = votes.find(v => v.agent === 'RISK');
  if (panicV.vote === 'NO' && riskV.vote === 'NO' && panicV.conviction >= 0.5 && riskV.conviction >= 0.5) {
    verdict = 'VETO'; reason = 'PANIC and RISK both hard NO';
  } else if (total === 0) {
    verdict = 'TRIM'; reason = 'Council abstained';
  } else if (margin >= band) {
    verdict = 'APPROVE'; reason = `${yes}-${no} (margin ${margin})`;
  } else if (margin <= -band) {
    verdict = 'VETO'; reason = `${yes}-${no} (margin ${margin})`;
  } else {
    verdict = 'TRIM'; reason = `Split ${yes}-${no} (margin ${margin})`;
  }
  return { votes, yes, no, margin, verdict, reason, close: Math.abs(margin) < band, tiebreak: null };
}

// ---------- LLM tiebreak (optional, capped) ----------
export async function llmTiebreak(env, config, signal, session) {
  if (!config.councilLlmTiebreak || !env.ANTHROPIC_API_KEY || !env.SIGNALS_CACHE) return null;
  try {
    if (await env.SIGNALS_CACHE.get('anthropic_billing_down')) return null;
    const day = new Date().toISOString().slice(0, 10);
    const key = COUNCIL_KEYS.LLM_DAY + day;
    const used = parseInt((await env.SIGNALS_CACHE.get(key)) || '0', 10);
    if (used >= (config.councilLlmDailyCap ?? 10)) return null;
    await env.SIGNALS_CACHE.put(key, String(used + 1), { expirationTtl: 3 * 86400 });

    const prompt =
      `You chair a trading council for a Polymarket paper bot. The council split on this entry.\n` +
      `Market: ${signal.marketTitle}\nSide: ${signal.directionRaw || signal.direction}\n` +
      `Votes:\n${session.votes.map(v => `- ${v.agent} ${v.vote} (${v.conviction}): ${v.line}`).join('\n')}\n\n` +
      `Reply with JSON only: {"verdict":"APPROVE"|"VETO","line":"<one short sentence in character as the chair>"}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.councilLlmModel || 'claude-haiku-4-5',
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(t);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (/credit balance is too low/i.test(JSON.stringify(body))) {
        await env.SIGNALS_CACHE.put('anthropic_billing_down', JSON.stringify({ at: Date.now() }), { expirationTtl: 3600 });
      }
      return null;
    }
    const text = (body.content || []).map(c => c.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    if (!parsed || !/^(APPROVE|VETO)$/.test(parsed.verdict)) return null;
    return { verdict: parsed.verdict, line: String(parsed.line || '').slice(0, 160) };
  } catch (e) {
    return null;
  }
}

// ---------- persistence ----------
export async function getCouncilStats(env) {
  try {
    return (await env.SIGNALS_CACHE.get(COUNCIL_KEYS.STATS, { type: 'json' })) || { agents: {}, chair: {} };
  } catch (e) {
    return { agents: {}, chair: {} };
  }
}

export async function getCouncilFeed(env, limit = 30) {
  try {
    const feed = (await env.SIGNALS_CACHE.get(COUNCIL_KEYS.FEED, { type: 'json' })) || [];
    return feed.slice(0, limit);
  } catch (e) {
    return [];
  }
}

export async function recordCouncilSession(env, signal, session, mode, applied) {
  try {
    const feed = (await env.SIGNALS_CACHE.get(COUNCIL_KEYS.FEED, { type: 'json' })) || [];
    feed.unshift({
      at: new Date().toISOString(),
      market: signal.marketTitle,
      marketSlug: signal.marketSlug,
      side: signal.directionRaw || signal.direction,
      mode,
      applied,
      verdict: session.verdict,
      reason: session.reason,
      margin: session.margin,
      tiebreak: session.tiebreak,
      votes: session.votes,
    });
    await env.SIGNALS_CACHE.put(COUNCIL_KEYS.FEED, JSON.stringify(feed.slice(0, FEED_MAX)));
  } catch (e) {}
}

// Compact form stored on the position (feeds the ledger at settle).
export function compactSession(session, mode) {
  return {
    v: session.votes.map(x => [x.agent, x.vote, x.conviction]),
    m: session.margin,
    verdict: session.verdict,
    tb: session.tiebreak ? session.tiebreak.verdict : null,
    mode,
  };
}

// Pure ledger update — exported for tests and the backtester.
export function applyOutcomeToStats(stats, council, pnl) {
  const s = stats || { agents: {}, chair: {} };
  s.agents = s.agents || {};
  s.chair = s.chair || {};
  const won = pnl > 0;
  for (const [agent, v] of council.v || []) {
    if (v !== 'YES' && v !== 'NO') continue;
    const a = s.agents[agent] || (s.agents[agent] = { calls: 0, correct: 0, yes: 0, no: 0, yesPnl: 0, noPnl: 0 });
    a.calls++;
    if ((v === 'YES') === won) a.correct++;
    if (v === 'YES') { a.yes++; a.yesPnl = r2(a.yesPnl + pnl); }
    else { a.no++; a.noPnl = r2(a.noPnl + pnl); }
  }
  const verdict = council.tb || council.verdict;
  if (verdict) {
    const c = s.chair[verdict] || (s.chair[verdict] = { trades: 0, wins: 0, losses: 0, pnl: 0 });
    c.trades++;
    won ? c.wins++ : c.losses++;
    c.pnl = r2(c.pnl + pnl);
  }
  s.updatedAt = new Date().toISOString();
  return s;
}

export async function recordCouncilOutcome(env, closedTrade, pnl) {
  if (!closedTrade || !closedTrade.council || !env.SIGNALS_CACHE) return;
  try {
    const stats = await getCouncilStats(env);
    applyOutcomeToStats(stats, closedTrade.council, pnl);
    await env.SIGNALS_CACHE.put(COUNCIL_KEYS.STATS, JSON.stringify(stats));
  } catch (e) {}
}

// "Who called it?" leaderboard.
export function leaderboard(stats) {
  return COUNCIL_AGENTS.map(agent => {
    const a = (stats.agents || {})[agent] || { calls: 0, correct: 0 };
    return {
      agent,
      calls: a.calls || 0,
      accuracy: a.calls ? Math.round((a.correct / a.calls) * 100) : null,
      weight: agentWeight(stats, agent),
      yesPnl: a.yesPnl || 0,
      noPnl: a.noPnl || 0,
    };
  }).sort((x, y) => (y.accuracy ?? -1) - (x.accuracy ?? -1));
}

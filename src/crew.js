// ============================================================
// CREW.JS — operator orders + directed hunt for the Agent Crew page
// ============================================================
//
// The operator types an order in the Agent Crew chat ("Focus CFB today").
// While an order is active, every ~15 min the crew:
//   1. HUNTS  — pulls every pregame moneyline on Polymarket for the ordered
//               sport(s) (Gamma, by sport tag) and prices both sides against
//               the sportsbooks' devigged consensus (The Odds API, the same
//               15-min KV cache the edge scanner uses: no extra credits).
//   2. DEBATES — the biggest gaps go before the persona council
//               (council.js): QUANT reads the Vegas gap, FOMO any whale flow
//               on the same game, DOUBT the missing track record, RISK the
//               book, PANIC chasing. The chair returns APPROVE / TRIM / VETO.
//   3. SUBMITS — non-vetoed picks clearing crewMinEdge are queued; the
//               auto-trader opens them as PAPER positions (enterCrewPicks,
//               autotrader.js) after re-checking the edge at the live ask.
//
// Crew bets are their own lane (strategySource 'crew_hunt'): never counted
// in graduation, the go-live milestone, or the favorites experiment.
// Fills use the ASK for the side bought (what an order would actually pay),
// not the midpoint.
// ============================================================

import { conveneCouncil, llmTiebreak, getCouncilStats, compactSession } from './council.js';
import { americanToProb, teamNamesOverlap, SPORT_KEY_MAP } from './odds.js';

export const CREW_KEYS = {
  DIRECTIVE: 'crew_directive',
  CHAT: 'crew_chat',
  HUNT: 'crew_hunt_last',
  PICKS: 'crew_picks',
  ENTERED: 'crew_entered_ids',
};

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CHAT_MAX = 40;
const HUNT_EVERY_MS = 14 * 60 * 1000;       // odds are cached 15 min
const PREGAME_MIN_MS = 10 * 60 * 1000;      // never price a game about to start
const HORIZON_MS = 30 * 3600 * 1000;        // today's slate (+ late west-coast games)
const DEBATE_TOP = 8;                       // biggest gaps that go before the council
const MAX_QUEUED_PER_HUNT = 3;              // no burst-filling a whole slate at once
const MAX_SPREAD = 0.05;                    // skip books wider than 5c (thin, fills lie)

// Polymarket sport tag ids (Gamma /sports — tags minus the generic 1 and 100639).
const SPORT_TAG = { cfb: 100351, nfl: 450, nba: 745, wnba: 100254, mlb: 100381, nhl: 899, ncaab: 100149 };
export const HUNTABLE = Object.keys(SPORT_TAG);
const SPORT_LABEL = { cfb: 'CFB', nfl: 'NFL', nba: 'NBA', wnba: 'WNBA', mlb: 'MLB', nhl: 'NHL', ncaab: 'college hoops' };

const SPORT_WORDS = [
  ['cfb', /\b(cfb|ncaaf|college football|ncaa football|cfb saturday)\b/i],
  ['nfl', /\b(nfl|pro football)\b/i],
  ['wnba', /\bwnba\b/i],
  ['nba', /\bnba\b/i],
  ['mlb', /\b(mlb|baseball)\b/i],
  ['nhl', /\b(nhl|hockey)\b/i],
  ['ncaab', /\b(ncaab|college basketball|college hoops)\b/i],
];
const UNHUNTABLE_WORDS = /\b(politic\w*|elections?|crypto|bitcoin|btc|eth|soccer|epl|tennis|ufc|mma|golf|f1|formula 1|esports?|lol|csgo|cs2|valorant)\b/i;
const STAND_DOWN = /^\s*(stand ?down|clear|cancel|reset|stop|at ease)\b|\bstand ?down\b/i;

const r1 = (x) => Math.round(x * 10) / 10;
const kvJson = async (env, key) => {
  try { return await env.SIGNALS_CACHE.get(key, { type: 'json' }); } catch (e) { return null; }
};

// ---------- orders ----------

// Pure: turn the operator's message into an order. Returns
// { kind: 'focus'|'stand_down'|'unhuntable'|'unknown', sports, minEdge, maxBets, days }.
export function parseDirective(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'unknown', sports: [] };
  const sports = SPORT_WORDS.filter(([, re]) => re.test(t)).map(([s]) => s);
  // "stop ignoring CFB" is an order to focus, not to stand down.
  if (STAND_DOWN.test(t) && sports.length === 0) return { kind: 'stand_down', sports: [] };
  const edgeM = t.match(/(\d+(?:\.\d+)?)\s*(?:pt|pts|point|points|%)\s*(?:edge|gap)?/i) || t.match(/\bedge\s*(?:of|>=?|at least)?\s*(\d+(?:\.\d+)?)/i);
  const betsM = t.match(/(?:up to|max(?:imum)?|at most|no more than)\s*(\d+)\s*(?:bets?|picks?|plays?)/i) || t.match(/\b(\d+)\s*(?:bets?|picks?|plays?)\b/i);
  const minEdge = edgeM ? Math.max(1, Math.min(15, parseFloat(edgeM[1]))) : null;
  const maxBets = betsM ? Math.max(1, Math.min(10, parseInt(betsM[1], 10))) : null;
  const days = /\b(week|weekend)\b/i.test(t) ? (/\bweekend\b/i.test(t) ? 3 : 7) : null;
  if (sports.length) return { kind: 'focus', sports, minEdge, maxBets, days };
  const other = t.match(UNHUNTABLE_WORDS);
  if (other) return { kind: 'unhuntable', sports: [], topic: other[1] };
  return { kind: 'unknown', sports: [] };
}

export async function getActiveDirective(env, nowMs = Date.now()) {
  const d = await kvJson(env, CREW_KEYS.DIRECTIVE);
  if (!d || !d.expiresAt || Date.parse(d.expiresAt) <= nowMs) return null;
  return d;
}

export async function appendCrewChat(env, from, text, extra = {}) {
  if (!env.SIGNALS_CACHE) return;
  try {
    const chat = (await kvJson(env, CREW_KEYS.CHAT)) || [];
    chat.push({ at: new Date().toISOString(), from, text: String(text).slice(0, 1200), ...extra });
    await env.SIGNALS_CACHE.put(CREW_KEYS.CHAT, JSON.stringify(chat.slice(-CHAT_MAX)));
  } catch (e) {}
}

function fmtEt(ms) {
  try {
    return new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' ET';
  } catch (e) { return new Date(ms).toISOString(); }
}

// Handle a message from the chat box. Returns the crew's reply text.
export async function handleCrewOrder(env, text, config = {}, nowMs = Date.now()) {
  const p = parseDirective(text);
  await appendCrewChat(env, 'you', text);
  let reply;
  if (p.kind === 'stand_down') {
    await env.SIGNALS_CACHE.delete(CREW_KEYS.DIRECTIVE);
    await env.SIGNALS_CACHE.put(CREW_KEYS.PICKS, '[]');
    reply = 'Standing down. Queued picks cleared; open crew bets ride to settlement. Back to the normal lanes.';
  } else if (p.kind === 'focus') {
    const expiresMs = nowMs + (p.days ? p.days * 86400e3 : 18 * 3600e3);
    const minEdge = p.minEdge ?? config.crewMinEdge ?? 3;
    const maxBets = p.maxBets ?? config.crewMaxPerDay ?? 6;
    const directive = {
      id: `ord_${nowMs.toString(36)}`, text: String(text).slice(0, 300), sports: p.sports, minEdge, maxBets,
      createdAt: new Date(nowMs).toISOString(), expiresAt: new Date(expiresMs).toISOString(),
    };
    await env.SIGNALS_CACHE.put(CREW_KEYS.DIRECTIVE, JSON.stringify(directive));
    await env.SIGNALS_CACHE.put(CREW_KEYS.PICKS, '[]');
    const size = config.crewBetSize ?? 5;
    reply = `Copy. Hunting ${p.sports.map(s => SPORT_LABEL[s]).join(' + ')} moneylines until ${fmtEt(expiresMs)}. ` +
      `Every pregame game gets priced against the sportsbooks; the council debates the biggest gaps; ` +
      `picks with ${minEdge}+ pts of edge that aren't vetoed go in as paper bets ($${size}, half on a split vote, up to ${maxBets} a day). ` +
      `First sweep within 5 minutes.`;
  } else if (p.kind === 'unhuntable') {
    reply = `Logged, but I can't hunt ${p.topic} yet. The crew prices bets against sportsbook lines, which only exist here for ${HUNTABLE.map(s => SPORT_LABEL[s]).join(', ')}.`;
  } else {
    reply = `I didn't catch a sport. Try "Focus CFB today", "NFL tomorrow, min edge 4", or "stand down".`;
  }
  await appendCrewChat(env, 'crew', reply);
  return { reply, parsed: p };
}

// ---------- pricing ----------

// Pure: consensus devigged win probability per team across every book that
// quotes both sides, plus DraftKings' own line for the operator.
export function consensusMoneyline(game) {
  const home = [], away = [];
  let dk = null;
  for (const b of game.bookmakers || []) {
    const m = (b.markets || []).find(x => x.key === 'h2h');
    if (!m) continue;
    const h = (m.outcomes || []).find(o => o.name === game.home_team);
    const a = (m.outcomes || []).find(o => o.name === game.away_team);
    if (!h || !a || typeof h.price !== 'number' || typeof a.price !== 'number') continue;
    const ph = americanToProb(h.price), pa = americanToProb(a.price);
    if (!(ph > 0 && pa > 0)) continue;
    home.push(ph / (ph + pa));
    away.push(pa / (ph + pa));
    if (b.key === 'draftkings') dk = { home: h.price, away: a.price };
  }
  if (!home.length) return null;
  const med = (xs) => { const s = [...xs].sort((x, y) => x - y); const k = Math.floor(s.length / 2); return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  return { home: r1(med(home) * 100), away: r1(med(away) * 100), books: home.length, dk };
}

const parseArr = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch (e) { return null; } };

// Pure: what buying outcome `idx` of a two-outcome Gamma market costs right
// now, in cents. Outcome 0 lifts the ask; outcome 1 lifts (1 - best bid).
export function quoteOutcome(market, idx) {
  const prices = (parseArr(market.outcomePrices) || []).map(Number);
  const bid = Number(market.bestBid), ask = Number(market.bestAsk);
  const hasBook = bid > 0 && ask > 0 && ask >= bid;
  const mid = typeof prices[idx] === 'number' && !isNaN(prices[idx]) ? prices[idx] : null;
  let buy = null;
  if (hasBook) buy = idx === 0 ? ask : 1 - bid;
  else if (mid !== null) buy = mid;
  return {
    buy: buy === null ? null : r1(buy * 100),
    mid: mid === null ? null : r1(mid * 100),
    spread: hasBook ? Math.round((ask - bid) * 1000) / 1000 : null,
  };
}

// Match strength between a Polymarket outcome label ("James Madison") and an
// Odds API team ("James Madison Dukes"): 2 = label is the school prefix,
// 1 = loose overlap, 0 = no match.
// Polymarket short labels the sportsbooks spell out.
const LABEL_ALIAS = {
  'umass': 'massachusetts', 'tennessee martin': 'ut martin', 'app state': 'appalachian state',
  'fiu': 'florida international', 'southern university': 'southern jaguars', 'pitt': 'pittsburgh',
  'uconn': 'connecticut', 'ole miss': 'mississippi rebels',
};
const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/['\u2019]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function nameScore(label, team) {
  const b = normName(team);
  let best = 0;
  for (const a of [normName(label), LABEL_ALIAS[normName(label)]]) {
    if (!a || !b) continue;
    if (a === b || b.startsWith(a + ' ')) return 2;
    if (teamNamesOverlap(a, b)) best = 1;
  }
  return best;
}

// Pure: pair Polymarket moneyline markets with Odds API games and emit one
// candidate per side. Unmatched markets are counted, not guessed.
export function buildCandidates(sport, markets, oddsGames, nowMs = Date.now()) {
  const out = [];
  let matched = 0, unmatched = 0, skipped = 0;
  for (const m of markets || []) {
    const startMs = Date.parse(String(m.gameStartTime || m.endDate || '').replace(' ', 'T').replace(/\+00$/, 'Z'));
    if (!startMs || startMs - nowMs < PREGAME_MIN_MS || startMs - nowMs > HORIZON_MS || m.closed) { skipped++; continue; }
    const outcomes = parseArr(m.outcomes) || [];
    if (outcomes.length !== 2) { skipped++; continue; }
    let best = null;
    for (const g of oddsGames || []) {
      const gMs = Date.parse(g.commence_time);
      if (!gMs || Math.abs(gMs - startMs) > 3 * 3600e3) continue;
      const s00 = nameScore(outcomes[0], g.away_team), s11 = nameScore(outcomes[1], g.home_team);
      const s01 = nameScore(outcomes[0], g.home_team), s10 = nameScore(outcomes[1], g.away_team);
      const straight = s00 && s11 ? s00 + s11 : 0;
      const swapped = s01 && s10 ? s01 + s10 : 0;
      const score = Math.max(straight, swapped);
      if (score > 0 && (!best || score > best.score)) best = { g, score, swapped: swapped > straight };
    }
    if (!best) { unmatched++; continue; }
    const cons = consensusMoneyline(best.g);
    if (!cons) { unmatched++; continue; }
    matched++;
    for (let i = 0; i < 2; i++) {
      const side = (i === 0) !== best.swapped ? 'away' : 'home';
      const q = quoteOutcome(m, i);
      const vegasProb = cons[side];
      out.push({
        id: `${m.slug}:${i}`,
        sport,
        marketSlug: m.slug,
        game: m.question || `${outcomes[0]} vs. ${outcomes[1]}`,
        team: String(outcomes[i]),
        teamFull: side === 'home' ? best.g.home_team : best.g.away_team,
        outcomeIndex: i,
        startTime: new Date(startMs).toISOString(),
        vegasProb,
        books: cons.books,
        dkOdds: cons.dk ? cons.dk[side] : null,
        buyPrice: q.buy,
        midPrice: q.mid,
        spread: q.spread,
        edge: q.buy === null ? null : r1(vegasProb - q.buy),
        volume: Math.round(Number(m.volumeNum || m.volume || 0)),
      });
    }
  }
  return { candidates: out, matched, unmatched, skipped };
}

async function fetchSportMoneylines(sport, nowMs) {
  const tag = SPORT_TAG[sport];
  if (!tag) return [];
  const min = new Date(nowMs).toISOString(), max = new Date(nowMs + HORIZON_MS).toISOString();
  const all = [];
  for (let offset = 0; offset < 300; offset += 100) {
    const url = `${GAMMA_API}/markets?closed=false&limit=100&offset=${offset}&sports_market_types=moneyline&tag_id=${tag}&end_date_min=${encodeURIComponent(min)}&end_date_max=${encodeURIComponent(max)}`;
    const res = await fetch(url);
    if (!res.ok) break;
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page.filter(m => String(m.slug || '').startsWith(`${sport}-`)));
    if (page.length < 100) break;
  }
  return all;
}

// Live quote for one queued pick, used by the auto-trader at entry time.
export async function fetchMoneylineQuote(slug, outcomeIndex) {
  try {
    const res = await fetch(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const arr = await res.json();
    const m = Array.isArray(arr) ? arr[0] : null;
    if (!m) return null;
    const outcomes = parseArr(m.outcomes) || [];
    return { closed: !!m.closed || m.acceptingOrders === false, outcome: outcomes[outcomeIndex], ...quoteOutcome(m, outcomeIndex) };
  } catch (e) { return null; }
}

// ---------- the debate ----------

// Pure: the council context for a hunt candidate. A whale signal on the same
// market (if the scan has one) feeds FOMO/PANIC/DOUBT; otherwise the council
// sees exactly what it is: a Vegas gap with no wallet behind it and no lane
// record yet.
export function councilContext(c, { config, dailyStats, perf, openPositions, whale }) {
  const size = config.crewBetSize ?? 5;
  const signal = {
    marketTitle: `${c.game} — ${c.team}`,
    marketSlug: c.marketSlug,
    direction: c.team,
    directionRaw: c.team,
    vegasProb: c.vegasProb,
    edgeBand: 'crew',
    historicalEdgeNet: null,
    historicalEdgeSamples: 0,
    factors: whale ? whale.factors || [] : [],
    uniqueWallets: whale ? whale.uniqueWallets || 0 : 0,
    largestBet: whale ? whale.largestBet || 0 : 0,
    avgEntryPrice: whale ? whale.avgEntryPrice : undefined,
  };
  const evaluation = {
    entryPrice: c.buyPrice,
    positionSize: size,
    walletBets: whale ? (whale.winningWalletInfo && whale.winningWalletInfo.totalBets) || 0 : 0,
    isExploration: false,
    isHighConviction: !whale,
  };
  return { signal, evaluation, dailyStats: dailyStats || {}, perf: perf || {}, config, openPositions: openPositions || [], category: 'sports_binary', agentView: null };
}

export function crewLedger(history, openPositions) {
  let wins = 0, losses = 0, pnl = 0, staked = 0;
  const byVerdict = {};
  for (const t of history || []) {
    if (!t || t.strategySource !== 'crew_hunt' || (t.outcome !== 'win' && t.outcome !== 'loss')) continue;
    t.outcome === 'win' ? wins++ : losses++;
    pnl += t.pnl || 0;
    staked += t.size || 0;
    const v = (t.council && (t.council.tb || t.council.verdict)) || 'n/a';
    const b = byVerdict[v] || (byVerdict[v] = { wins: 0, losses: 0, pnl: 0 });
    t.outcome === 'win' ? b.wins++ : b.losses++;
    b.pnl = Math.round((b.pnl + (t.pnl || 0)) * 100) / 100;
  }
  const settled = wins + losses;
  return {
    settled, wins, losses, pnl: Math.round(pnl * 100) / 100, staked,
    roi: staked > 0 ? Math.round((pnl / staked) * 1000) / 10 : null,
    open: (openPositions || []).filter(p => p.strategySource === 'crew_hunt').length,
    byVerdict,
  };
}

// ---------- the hunt (cron) ----------

export async function runCrewHunt(env, deps, nowMs = Date.now()) {
  if (!env.SIGNALS_CACHE) return { skipped: 'no kv' };
  const directive = await getActiveDirective(env, nowMs);
  if (!directive) return { skipped: 'no orders' };
  const last = await kvJson(env, CREW_KEYS.HUNT);
  if (last && last.directiveId === directive.id && nowMs - Date.parse(last.at) < HUNT_EVERY_MS) {
    return { skipped: 'throttled', nextInMin: Math.ceil((HUNT_EVERY_MS - (nowMs - Date.parse(last.at))) / 60000) };
  }

  const { getAutotraderConfig, getGameOdds, getDailyStats, getOpenPositions, getBotPerformance, signals = [] } = deps;
  const [config, dailyStats, openPositions, perf, stats] = await Promise.all([
    getAutotraderConfig(env), getDailyStats(env), getOpenPositions(env),
    getBotPerformance(env).catch(() => ({})), getCouncilStats(env),
  ]);

  const perSport = {};
  let candidates = [];
  for (const sport of directive.sports.filter(s => SPORT_TAG[s])) {
    try {
      const [markets, odds] = await Promise.all([
        fetchSportMoneylines(sport, nowMs),
        getGameOdds(env, SPORT_KEY_MAP[sport], 'h2h,spreads'),
      ]);
      const built = buildCandidates(sport, markets, odds || [], nowMs);
      perSport[sport] = { markets: markets.length, oddsGames: (odds || []).length, matched: built.matched, unmatched: built.unmatched };
      candidates.push(...built.candidates);
    } catch (e) {
      perSport[sport] = { error: e.message };
    }
  }

  // Rank tradeable sides by edge at the ask; one side per game.
  const tradeable = candidates
    .filter(c => typeof c.edge === 'number' && c.buyPrice >= 5 && c.buyPrice <= 95 && (c.spread === null || c.spread <= MAX_SPREAD))
    .sort((a, b) => b.edge - a.edge);
  const seenGame = new Set();
  const top = [];
  for (const c of tradeable) {
    if (seenGame.has(c.marketSlug)) continue;
    seenGame.add(c.marketSlug);
    top.push(c);
    if (top.length >= DEBATE_TOP) break;
  }

  const whaleBySlug = new Map();
  for (const s of signals || []) if (s && s.marketSlug) whaleBySlug.set(s.marketSlug, s);

  const minEdge = directive.minEdge ?? config.crewMinEdge ?? 3;
  const debated = [];
  for (const c of top) {
    const whale = whaleBySlug.get(c.marketSlug);
    const whaleSameSide = whale && String(whale.directionRaw || whale.direction || '').toLowerCase() === c.team.toLowerCase() ? whale : null;
    const session = conveneCouncil(councilContext(c, { config, dailyStats, perf, openPositions, whale: whaleSameSide }), stats);
    if (session.close && c.edge >= minEdge) {
      session.tiebreak = await llmTiebreak(env, config, { marketTitle: `${c.game} — ${c.team}`, direction: c.team }, session);
    }
    const verdict = (session.tiebreak && session.tiebreak.verdict) || session.verdict;
    debated.push({
      ...c,
      whale: whaleSameSide ? { wallets: whaleSameSide.uniqueWallets || null, largestBet: whaleSameSide.largestBet || null } : null,
      verdict,
      reason: session.reason,
      margin: session.margin,
      votes: session.votes.map(v => ({ agent: v.agent, vote: v.vote, conviction: v.conviction, line: v.line })),
      tiebreak: session.tiebreak,
      council: compactSession(session, 'crew'),
      qualifies: c.edge >= minEdge && verdict !== 'VETO',
    });
  }

  // Queue: keep still-pending older picks, add new qualifiers (capped).
  const entered = new Set((await kvJson(env, CREW_KEYS.ENTERED)) || []);
  const prevQueue = ((await kvJson(env, CREW_KEYS.PICKS)) || []).filter(p => !entered.has(p.id) && Date.parse(p.startTime) - nowMs > PREGAME_MIN_MS);
  const queuedIds = new Set(prevQueue.map(p => p.id));
  const fresh = debated.filter(d => d.qualifies && !entered.has(d.id) && !queuedIds.has(d.id)).slice(0, MAX_QUEUED_PER_HUNT);
  const queue = [...prevQueue, ...fresh.map(d => ({
    id: d.id, marketSlug: d.marketSlug, outcomeIndex: d.outcomeIndex, team: d.team, game: d.game, sport: d.sport,
    startTime: d.startTime, vegasProb: d.vegasProb, buyPrice: d.buyPrice, edge: d.edge, verdict: d.verdict,
    council: d.council, directiveId: directive.id, minEdge, queuedAt: new Date(nowMs).toISOString(),
  }))];
  await env.SIGNALS_CACHE.put(CREW_KEYS.PICKS, JSON.stringify(queue));

  const counts = { APPROVE: 0, TRIM: 0, VETO: 0 };
  for (const d of debated) counts[d.verdict] = (counts[d.verdict] || 0) + 1;
  const priced = candidates.length / 2;
  const hunt = {
    at: new Date(nowMs).toISOString(),
    directiveId: directive.id,
    sports: directive.sports,
    minEdge,
    perSport,
    priced,
    board: debated,
    alsoRan: tradeable.filter(c => !top.includes(c)).slice(0, 12)
      .map(c => ({ game: c.game, team: c.team, vegasProb: c.vegasProb, buyPrice: c.buyPrice, edge: c.edge, startTime: c.startTime, dkOdds: c.dkOdds })),
    counts,
    queued: fresh.map(d => d.id),
  };
  await env.SIGNALS_CACHE.put(CREW_KEYS.HUNT, JSON.stringify(hunt));

  // Report to the chat on the first sweep of an order, or when picks change.
  if (!last || last.directiveId !== directive.id || fresh.length > 0) {
    const label = directive.sports.map(s => SPORT_LABEL[s]).join(' + ');
    let msg;
    if (priced === 0) {
      const why = Object.entries(perSport).map(([s, p]) => p.error ? `${SPORT_LABEL[s]}: ${p.error}` :
        `${SPORT_LABEL[s]}: ${p.markets} Polymarket games, ${p.oddsGames} sportsbook games, ${p.matched} matched`).join('; ');
      msg = `${label} sweep: nothing priced yet (${why}). Games that already kicked off are skipped. Trying again in 15 min.`;
    } else {
      const best = debated.slice(0, 3).map(d => `${d.team} ${d.edge > 0 ? '+' : ''}${d.edge} (${d.buyPrice}¢ vs ${d.vegasProb}%)`).join(', ');
      msg = `${label} sweep: ${priced} pregame games priced against the books. Biggest gaps: ${best || 'none'}. ` +
        `Council: ${counts.APPROVE} approve, ${counts.TRIM} split, ${counts.VETO} veto. ` +
        (fresh.length ? `Submitting ${fresh.length}: ${fresh.map(d => `${d.team} @ ${d.buyPrice}¢`).join(', ')}.`
          : debated.some(d => d.edge >= minEdge) ? 'Nothing new cleared the council.' : `No gap reaches ${minEdge} pts. Books and Polymarket agree right now; no bet beats forcing one.`);
    }
    await appendCrewChat(env, 'crew', msg);
  }

  return { priced, debated: debated.length, queued: fresh.length, counts, perSport };
}

export async function getCrewState(env, deps) {
  const [directive, chat, hunt, picks, history, open] = await Promise.all([
    getActiveDirective(env),
    kvJson(env, CREW_KEYS.CHAT),
    kvJson(env, CREW_KEYS.HUNT),
    kvJson(env, CREW_KEYS.PICKS),
    deps.getTradeHistory(env, 1000).catch(() => []),
    deps.getOpenPositions(env).catch(() => []),
  ]);
  const crewOpen = (open || []).filter(p => p.strategySource === 'crew_hunt').map(p => ({
    id: p.id, title: p.marketTitle, side: p.directionRaw || p.direction, entry: p.entryPrice, size: p.size,
    edge: p.edgeAtEntry, verdict: p.council ? (p.council.tb || p.council.verdict) : null, openedAt: p.openedAt,
  }));
  const crewClosed = (history || []).filter(t => t.strategySource === 'crew_hunt').slice(-10).reverse().map(t => ({
    title: t.marketTitle, side: t.directionRaw || t.direction, entry: t.entryPrice, size: t.size, pnl: t.pnl, outcome: t.outcome, closedAt: t.closedAt,
  }));
  return {
    success: true,
    directive,
    chat: chat || [],
    hunt: hunt || null,
    queue: picks || [],
    ledger: crewLedger(history, open),
    open: crewOpen,
    recent: crewClosed,
    huntable: HUNTABLE,
  };
}

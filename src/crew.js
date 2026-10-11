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
import { crewLlmStatus, chief, debate } from './crew-llm.js';
import { recordDkValuePicks, getDkPicksLedger } from './dk-picks.js';

export const CREW_KEYS = {
  DIRECTIVE: 'crew_directive',
  CHAT: 'crew_chat',
  HUNT: 'crew_hunt_last',
  PICKS: 'crew_picks',
  ENTERED: 'crew_entered_ids',
  DK_BOARD: 'crew_dk_board',      // DraftKings value board as the operator's browser last computed it
};
const ALL_MARKETS = ['moneyline', 'spread', 'total'];

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CHAT_MAX = 40;
const HUNT_EVERY_MS = 14 * 60 * 1000;       // odds are cached 15 min
const PREGAME_MIN_MS = 10 * 60 * 1000;      // never price a game about to start
const HORIZON_MS = 30 * 3600 * 1000;        // today's slate (+ late west-coast games)
const DEBATE_TOP = 8;                       // biggest gaps that go before the council
const MAX_QUEUED_PER_HUNT = 3;              // no burst-filling a whole slate at once
const MAX_SPREAD = 0.05;                    // skip books wider than 5c (thin, fills lie)
const MAX_BETS_CAP = 25;                    // hard ceiling on an order's bets/day
const OPEN_ENDED_DAYS = 30;                 // "until I tell you" = until stand down (30d safety expiry)
const DK_BOARD_SIZE = 15;
const DK_FAIR_MAX_SPREAD = 0.04;            // Polymarket only counts as a fair price when its book is tight

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
  const maxBets = betsM ? Math.max(1, Math.min(MAX_BETS_CAP, parseInt(betsM[1], 10))) : null;
  const days = /\buntil (i|we) (tell|say)|until further notice|until told|indefinitely|from now on\b/i.test(t) ? OPEN_ENDED_DAYS
    : /\b(week|weekend)\b/i.test(t) ? (/\bweekend\b/i.test(t) ? 3 : 7) : null;
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

// Next ~6am ET (10:00 UTC) after `ms`: "today" covers late West Coast games.
function endOfSportsDay(ms) {
  const d = new Date(ms);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0, 0);
  return t > ms + 2 * 3600e3 ? t : t + 86400e3;
}

// Apply the chief's structured decision. The code — not the model — owns
// validation: unknown sports/markets dropped, numbers clamped, durations capped.
async function applyChiefAction(env, decision, config, nowMs) {
  const current = await getActiveDirective(env, nowMs);
  if (decision.action === 'stand_down') {
    await env.SIGNALS_CACHE.delete(CREW_KEYS.DIRECTIVE);
    await env.SIGNALS_CACHE.put(CREW_KEYS.PICKS, '[]');
    return { changed: true, directive: null };
  }
  if ((decision.action !== 'set_focus' && decision.action !== 'update_focus') || !decision.focus) return { changed: false, directive: current };
  const f = decision.focus;
  let sports = (f.sports || []).filter(x => SPORT_TAG[x]);
  if (!sports.length) sports = current ? current.sports : [];
  if (!sports.length) return { changed: false, directive: current };
  const markets = (f.markets || []).filter(m => ALL_MARKETS.includes(m));
  const minEdge = typeof f.minEdge === 'number' ? Math.max(1, Math.min(15, f.minEdge)) : (current ? current.minEdge : (config.crewMinEdge ?? 3));
  const maxBets = Number.isInteger(f.maxBets) ? Math.max(1, Math.min(MAX_BETS_CAP, f.maxBets)) : (current ? current.maxBets : (config.crewMaxPerDay ?? 6));
  const expiresMs = f.until === 'stand_down' ? nowMs + OPEN_ENDED_DAYS * 86400e3
    : f.until === 'hours' && typeof f.hours === 'number' ? nowMs + Math.max(1, Math.min(168, f.hours)) * 3600e3
    : endOfSportsDay(nowMs);
  const sameSports = current && [...current.sports].sort().join() === [...sports].sort().join();
  const directive = {
    id: sameSports ? current.id : `ord_${nowMs.toString(36)}`,
    text: current && sameSports ? current.text : 'set in chat',
    sports, markets: markets.length ? markets : ALL_MARKETS, minEdge, maxBets,
    createdAt: sameSports ? current.createdAt : new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    openEnded: f.until === 'stand_down',
  };
  await env.SIGNALS_CACHE.put(CREW_KEYS.DIRECTIVE, JSON.stringify(directive));
  if (!sameSports) await env.SIGNALS_CACHE.put(CREW_KEYS.PICKS, '[]');
  return { changed: true, directive };
}

const fmtEtShort = (iso) => {
  try { return new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' ET'; }
  catch (e) { return iso; }
};

// What the chief sees: the crew's live view, compact.
async function crewStateForLlm(env, config, nowMs) {
  const [directive, hunt, queue, browserDk, llm] = await Promise.all([
    getActiveDirective(env, nowMs), kvJson(env, CREW_KEYS.HUNT), kvJson(env, CREW_KEYS.PICKS),
    kvJson(env, CREW_KEYS.DK_BOARD), crewLlmStatus(env),
  ]);
  const dkFresh = browserDk && nowMs - Date.parse(browserDk.at) < 45 * 60e3 ? browserDk : null;
  return {
    now: fmtEtShort(new Date(nowMs).toISOString()),
    orders: directive ? {
      sports: directive.sports, markets: directive.markets || ALL_MARKETS, minEdge: directive.minEdge, maxBetsPerDay: directive.maxBets,
      until: directive.openEnded ? 'until the operator says stand down' : fmtEtShort(directive.expiresAt),
    } : null,
    lastSweep: hunt ? {
      at: fmtEtShort(hunt.at), sports: hunt.sports, gamesPriced: hunt.priced,
      polymarketGaps: (hunt.board || []).slice(0, 6).map(d => ({
        team: d.team, game: d.game, kickoff: fmtEtShort(d.startTime), polymarketPrice: d.buyPrice, fairProb: d.vegasProb,
        edgePts: d.edge, councilVerdict: d.verdict, chairReason: d.chairReason || null,
      })),
      chairSummary: hunt.debate && hunt.debate.summary ? hunt.debate.summary : null,
    } : null,
    draftKingsBoard: dkFresh ? {
      computed: fmtEtShort(dkFresh.at),
      rows: dkFresh.rows.slice(0, 10).map(r => ({ pick: r.label || `${r.team} ML`, odds: r.odds, fair: r.fair, dkImplied: r.implied, per100: r.ev, kickoff: fmtEtShort(r.startTime) })),
    } : 'not reported yet (the operator\'s browser computes it when the Agent Crew page is open)',
    paperBetsQueued: (queue || []).map(q => `${q.team} @ ${q.buyPrice}c (${q.verdict})`),
    draftKingsValuePicksRecord: await getDkPicksLedger(env).then(l => ({ graded: l.graded, wins: l.wins, losses: l.losses, pushes: l.pushes, profitOn100PerPick: l.pnl, roiPct: l.roi, pending: l.pending })),
    claudeBudget: { spentToday: Math.round(llm.spent * 100) / 100, dailyCap: llm.cap },
  };
}

// Handle a message from the chat box. Claude (the chief) when available,
// the keyword parser otherwise. Returns the crew's reply text.
export async function handleCrewOrder(env, text, config = {}, nowMs = Date.now()) {
  const priorChat = (await kvJson(env, CREW_KEYS.CHAT)) || [];
  await appendCrewChat(env, 'you', text);
  const llm = await crewLlmStatus(env);
  let fallbackNote = '';
  if (llm.ok) {
    const r = await chief(env, { text, chat: priorChat, state: await crewStateForLlm(env, config, nowMs) });
    if (r.ok && r.data && typeof r.data.reply === 'string' && r.data.reply.trim()) {
      const applied = await applyChiefAction(env, r.data, config, nowMs);
      await appendCrewChat(env, 'crew', r.data.reply, { by: 'chief' });
      return { reply: r.data.reply, parsed: { kind: r.data.action, focus: r.data.focus, applied: applied.changed }, via: 'claude' };
    }
    fallbackNote = ` (The chief couldn't answer just now: ${r.error || 'empty reply'}. Using the basic parser.)`;
  } else if (env.ANTHROPIC_API_KEY) {
    fallbackNote = ` (Basic parser only: ${llm.why}.)`;
  }

  const p = parseDirective(text);
  let reply;
  if (p.kind === 'stand_down') {
    await env.SIGNALS_CACHE.delete(CREW_KEYS.DIRECTIVE);
    await env.SIGNALS_CACHE.put(CREW_KEYS.PICKS, '[]');
    reply = 'Standing down. Queued picks cleared; open crew bets ride to settlement. Back to the normal lanes.';
  } else if (p.kind === 'focus') {
    const expiresMs = nowMs + (p.days ? p.days * 86400e3 : 18 * 3600e3);
    const openEnded = p.days === OPEN_ENDED_DAYS;
    const minEdge = p.minEdge ?? config.crewMinEdge ?? 3;
    const maxBets = p.maxBets ?? config.crewMaxPerDay ?? 6;
    const directive = {
      id: `ord_${nowMs.toString(36)}`, text: String(text).slice(0, 300), sports: p.sports, markets: ALL_MARKETS, minEdge, maxBets,
      createdAt: new Date(nowMs).toISOString(), expiresAt: new Date(expiresMs).toISOString(), openEnded,
    };
    await env.SIGNALS_CACHE.put(CREW_KEYS.DIRECTIVE, JSON.stringify(directive));
    await env.SIGNALS_CACHE.put(CREW_KEYS.PICKS, '[]');
    const size = config.crewBetSize ?? 5;
    reply = `Copy. Hunting ${p.sports.map(s => SPORT_LABEL[s]).join(' + ')} only, ${openEnded ? 'until you say stand down' : `until ${fmtEt(expiresMs)}`}. ` +
      `Every pregame game gets priced two ways: DraftKings' line vs the Polymarket price (the DraftKings value board, for your slips), ` +
      `and Polymarket vs the books (paper bets: ${minEdge}+ pts of edge, not vetoed by the council, $${size} or half on a split vote, up to ${maxBets} a day). ` +
      `First sweep within 5 minutes.`;
  } else if (p.kind === 'unhuntable') {
    reply = `Logged, but I can't hunt ${p.topic} yet. The crew prices bets against sportsbook lines, which only exist here for ${HUNTABLE.map(s => SPORT_LABEL[s]).join(', ')}.`;
  } else {
    reply = `I didn't catch a sport. Try "Focus CFB today", "NFL tomorrow, min edge 4", or "stand down".`;
  }
  reply += fallbackNote;
  await appendCrewChat(env, 'crew', reply);
  return { reply, parsed: p, via: 'parser' };
}

// The operator's browser computes the DraftKings value board (ESPN only
// serves odds to US visitors) and reports it so the chief and the debate
// can talk about DraftKings value too.
export async function saveBrowserDkBoard(env, rows) {
  const clean = (Array.isArray(rows) ? rows : []).slice(0, 25).map(r => ({
    id: String(r.id || '').slice(0, 120), label: String(r.label || '').slice(0, 80), team: String(r.team || '').slice(0, 60),
    game: String(r.game || '').slice(0, 120), market: String(r.market || 'moneyline').slice(0, 12),
    odds: Number(r.odds), fair: Number(r.fair), implied: Number(r.implied), ev: Number(r.ev),
    startTime: String(r.startTime || '').slice(0, 30),
    side: ['home', 'away', 'over', 'under'].includes(r.side) ? r.side : null,
    line: typeof r.line === 'number' && isFinite(r.line) ? r.line : null,
    espnId: r.espnId != null ? String(r.espnId).slice(0, 20) : null,
    sport: SPORT_TAG[r.sport] ? r.sport : null,
    home: String(r.home || '').slice(0, 60), away: String(r.away || '').slice(0, 60),
  })).filter(r => isFinite(r.odds) && isFinite(r.ev));
  const board = { at: new Date().toISOString(), rows: clean };
  await env.SIGNALS_CACHE.put(CREW_KEYS.DK_BOARD, JSON.stringify(board), { expirationTtl: 6 * 3600 });
  board.recorded = await recordDkValuePicks(env, clean);
  return board;
}

// ---------- DraftKings lines (ESPN scoreboard, free) ----------

const ESPN_PATH = {
  cfb: 'football/college-football', nfl: 'football/nfl', nba: 'basketball/nba', wnba: 'basketball/wnba',
  mlb: 'baseball/mlb', nhl: 'hockey/nhl', ncaab: 'basketball/mens-college-basketball',
};
const ESPN_GROUPS = { cfb: ['80', '81'], ncaab: ['50'] };   // FBS + FCS; all D-I hoops

const amOdds = (v) => {
  if (typeof v === 'number') return v;
  const t = String(v || '').trim().toUpperCase();
  if (t === 'EVEN' || t === 'EV') return 100;
  const n = parseInt(t.replace('+', ''), 10);
  return isNaN(n) || n === 0 ? null : n;
};
// ESPN wraps DraftKings bet links in a tracking redirect; keep the DK URL.
const dkHref = (link) => {
  const h = link && link.href;
  if (!h) return null;
  const m = h.match(/[?&]preurl=([^&]+)/);
  try { return m ? decodeURIComponent(m[1]) : h; } catch (e) { return h; }
};
const lineNum = (v) => { const n = parseFloat(String(v || '').replace(/^[ou]/i, '')); return isNaN(n) ? null : n; };

// Pure: ESPN scoreboard JSON -> pregame games with DraftKings lines.
export function parseEspnGames(json) {
  const out = [];
  for (const e of (json && json.events) || []) {
    const c = (e.competitions || [])[0];
    if (!c || !c.status || !c.status.type || c.status.type.state !== 'pre') continue;
    const o = (c.odds || []).find(x => /draftkings/i.test((x.provider && x.provider.name) || ''));
    if (!o) continue;
    const team = (ha) => {
      const t = ((c.competitors || []).find(x => x.homeAway === ha) || {}).team || {};
      return { name: t.displayName || t.location || '', loc: t.location || '', abbr: t.abbreviation || '' };
    };
    const ml = o.moneyline || {}, ps = o.pointSpread || {}, tot = o.total || {};
    const cur = (x) => (x && (x.close || x.current || x.open)) || {};
    out.push({
      id: e.id,
      startMs: Date.parse(c.date || e.date),
      home: team('home'),
      away: team('away'),
      dk: {
        ml: {
          home: { odds: amOdds(cur(ml.home).odds), link: dkHref(cur(ml.home).link) },
          away: { odds: amOdds(cur(ml.away).odds), link: dkHref(cur(ml.away).link) },
        },
        spread: {
          home: { line: lineNum(cur(ps.home).line), odds: amOdds(cur(ps.home).odds), link: dkHref(cur(ps.home).link) },
          away: { line: lineNum(cur(ps.away).line), odds: amOdds(cur(ps.away).odds), link: dkHref(cur(ps.away).link) },
        },
        total: {
          line: lineNum(cur(tot.over).line) ?? (typeof o.overUnder === 'number' ? o.overUnder : null),
          over: { odds: amOdds(cur(tot.over).odds), link: dkHref(cur(tot.over).link) },
          under: { odds: amOdds(cur(tot.under).odds), link: dkHref(cur(tot.under).link) },
        },
      },
    });
  }
  return out;
}

function etYmd(ms) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    const g = (t) => (p.find(x => x.type === t) || {}).value;
    return `${g('year')}${g('month')}${g('day')}`;
  } catch (e) { return new Date(ms).toISOString().slice(0, 10).replace(/-/g, ''); }
}

// ESPN's edge rejects header-less requests (a Worker sends no User-Agent),
// so present as a browser and record what each call returned.
const ESPN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.espn.com/',
};
async function fetchDkLines(sport, nowMs) {
  const path = ESPN_PATH[sport];
  const diag = [];
  if (!path) return { games: [], diag };
  const dates = [...new Set([etYmd(nowMs), etYmd(nowMs + 24 * 3600e3)])];
  const groups = ESPN_GROUPS[sport] || [null];
  const byId = new Map();
  for (const d of dates) {
    for (const g of groups) {
      try {
        const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${d}&limit=400${g ? `&groups=${g}` : ''}`, { headers: ESPN_HEADERS });
        if (!res.ok) { diag.push(`${d}/${g || '-'}: HTTP ${res.status}`); continue; }
        const json = await res.json();
        const parsed = parseEspnGames(json);
        diag.push(`${d}/${g || '-'}: ${(json.events || []).length} events, ${parsed.length} pregame w/ DK`);
        for (const game of parsed) byId.set(game.id, game);
      } catch (e) { diag.push(`${d}/${g || '-'}: ${e.message}`); }
    }
  }
  return { games: [...byId.values()], diag };
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

// Find the game whose two teams match a market's two outcome labels and
// whose start is within 3h. Returns { g, swapped } (swapped: outcome 0 is home).
function matchGame(outcomes, startMs, games, awayOf, homeOf, msOf) {
  let best = null;
  for (const g of games || []) {
    const gMs = msOf(g);
    if (!gMs || Math.abs(gMs - startMs) > 3 * 3600e3) continue;
    const s00 = nameScore(outcomes[0], awayOf(g)), s11 = nameScore(outcomes[1], homeOf(g));
    const s01 = nameScore(outcomes[0], homeOf(g)), s10 = nameScore(outcomes[1], awayOf(g));
    const straight = s00 && s11 ? s00 + s11 : 0;
    const swapped = s01 && s10 ? s01 + s10 : 0;
    const score = Math.max(straight, swapped);
    if (score > 0 && (!best || score > best.score)) best = { g, score, swapped: swapped > straight };
  }
  return best;
}

// Pure: DraftKings two-way moneyline -> implied (with vig) and no-vig %.
export function dkMoneyline(dk) {
  const h = dk && dk.ml && dk.ml.home && dk.ml.home.odds, a = dk && dk.ml && dk.ml.away && dk.ml.away.odds;
  if (typeof h !== 'number' || typeof a !== 'number') return null;
  const ph = americanToProb(h), pa = americanToProb(a);
  if (!(ph > 0 && pa > 0)) return null;
  return {
    home: { odds: h, implied: r1(ph * 100), fair: r1((ph / (ph + pa)) * 100) },
    away: { odds: a, implied: r1(pa * 100), fair: r1((pa / (ph + pa)) * 100) },
  };
}

// Pure: pair Polymarket moneyline markets with sportsbook prices and emit one
// candidate per side. Two references: the Odds API consensus (all books) and
// DraftKings (ESPN). The paper lane's reference is the consensus when the
// Odds API answers, else DraftKings' no-vig line. Separately, every side with
// a DraftKings price and a tight Polymarket book gets a DraftKings value:
// how much more DraftKings pays than the fair price (Polymarket, blended
// with the consensus when available) says it should. Unmatched markets are
// counted, not guessed.
export function buildCandidates(sport, markets, oddsGames, nowMs = Date.now(), dkGames = []) {
  const out = [];
  let matched = 0, unmatched = 0, skipped = 0, dkMatched = 0;
  const unmatchedGames = [];
  for (const m of markets || []) {
    const startMs = Date.parse(String(m.gameStartTime || m.endDate || '').replace(' ', 'T').replace(/\+00$/, 'Z'));
    if (!startMs || startMs - nowMs < PREGAME_MIN_MS || startMs - nowMs > HORIZON_MS || m.closed) { skipped++; continue; }
    const outcomes = parseArr(m.outcomes) || [];
    if (outcomes.length !== 2) { skipped++; continue; }
    const ob = matchGame(outcomes, startMs, oddsGames, g => g.away_team, g => g.home_team, g => Date.parse(g.commence_time));
    const cons = ob ? consensusMoneyline(ob.g) : null;
    const db = matchGame(outcomes, startMs, dkGames, g => g.away.name, g => g.home.name, g => g.startMs);
    const dkMl = db ? dkMoneyline(db.g.dk) : null;
    if (!cons && !dkMl) { unmatched++; if (unmatchedGames.length < 12) unmatchedGames.push(m.question || outcomes.join(' vs. ')); continue; }
    matched++;
    if (dkMl) dkMatched++;
    for (let i = 0; i < 2; i++) {
      const cSide = ob ? ((i === 0) !== ob.swapped ? 'away' : 'home') : null;
      const dSide = db ? ((i === 0) !== db.swapped ? 'away' : 'home') : null;
      const q = quoteOutcome(m, i);
      const booksProb = cons ? cons[cSide] : null;
      const dkSide = dkMl ? dkMl[dSide] : null;
      const vegasProb = booksProb ?? (dkSide ? dkSide.fair : null);
      const tight = q.spread !== null && q.spread <= DK_FAIR_MAX_SPREAD && q.mid !== null && q.mid > 2 && q.mid < 98;
      const fairForDk = tight ? r1(booksProb != null ? (q.mid + booksProb) / 2 : q.mid) : null;
      let dk = null;
      if (dkSide) {
        const g = db.g.dk;
        const opp = dSide === 'home' ? 'away' : 'home';
        dk = {
          odds: dkSide.odds,
          implied: dkSide.implied,
          fair: dkSide.fair,
          link: g.ml[dSide].link,
          ev: fairForDk !== null ? r1((fairForDk / dkSide.implied - 1) * 100) : null,
          fairUsed: fairForDk,
          spread: { line: g.spread[dSide].line, odds: g.spread[dSide].odds, link: g.spread[dSide].link },
          total: { line: g.total.line, over: g.total.over.odds, under: g.total.under.odds, overLink: g.total.over.link, underLink: g.total.under.link },
          opponent: db.g[opp].name,
        };
      }
      out.push({
        id: `${m.slug}:${i}`,
        sport,
        marketSlug: m.slug,
        game: m.question || `${outcomes[0]} vs. ${outcomes[1]}`,
        team: String(outcomes[i]),
        teamFull: cSide ? (cSide === 'home' ? ob.g.home_team : ob.g.away_team) : (dSide ? db.g[dSide].name : String(outcomes[i])),
        outcomeIndex: i,
        startTime: new Date(startMs).toISOString(),
        vegasProb,
        refSource: booksProb != null ? 'books' : 'dk',
        books: cons ? cons.books : 0,
        dkOdds: dkSide ? dkSide.odds : (cons && cons.dk ? cons.dk[cSide] : null),
        dk,
        buyPrice: q.buy,
        midPrice: q.mid,
        spread: q.spread,
        edge: q.buy === null || vegasProb === null ? null : r1(vegasProb - q.buy),
        volume: Math.round(Number(m.volumeNum || m.volume || 0)),
      });
    }
  }
  return { candidates: out, matched, unmatched, skipped, dkMatched, unmatchedGames };
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

// Full-game spread and total markets, most-traded first so each game's main
// lines come back without pulling every alternate line (a CFB Saturday has
// ~3k of them). Polymarket frames spreads as "Spread: Ravens (-1.5)",
// outcomes [Ravens, Falcons], line -1.5: P(outcome 0) = Ravens cover -1.5.
async function fetchSportLines(sport, type, nowMs, pages) {
  const tag = SPORT_TAG[sport];
  if (!tag) return [];
  const min = new Date(nowMs).toISOString(), max = new Date(nowMs + HORIZON_MS).toISOString();
  const out = [];
  for (let i = 0; i < pages; i++) {
    try {
      const res = await fetch(`${GAMMA_API}/markets?closed=false&limit=100&offset=${i * 100}&sports_market_types=${type}&tag_id=${tag}&order=volumeNum&ascending=false&end_date_min=${encodeURIComponent(min)}&end_date_max=${encodeURIComponent(max)}`);
      if (!res.ok) break;
      const page = await res.json();
      if (!Array.isArray(page) || !page.length) break;
      for (const m of page) {
        if (!String(m.slug || '').startsWith(`${sport}-`) || typeof m.line !== 'number') continue;
        const outcomes = parseArr(m.outcomes) || [];
        if (outcomes.length !== 2) continue;
        const q0 = quoteOutcome(m, 0), q1 = quoteOutcome(m, 1);
        out.push({ slug: m.slug, t: type === 'spreads' ? 's' : 't', l: m.line, o: outcomes.map(String), m: [q0.mid, q1.mid], w: q0.spread });
      }
      if (page.length < 100) break;
    } catch (e) { break; }
  }
  return out;
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

// Pure: every pregame Polymarket moneyline in the window with its live
// prices (and the books consensus where matched). The Agent Crew page pairs
// these with DraftKings lines fetched in the operator's browser: ESPN only
// serves betting odds to US visitors, and the Worker's cron runs elsewhere.
export function polyGameRows(markets, candidates, nowMs = Date.now(), lines = []) {
  const byId = new Map((candidates || []).map(c => [c.id, c]));
  const rows = [];
  for (const m of markets || []) {
    const startMs = Date.parse(String(m.gameStartTime || m.endDate || '').replace(' ', 'T').replace(/\+00$/, 'Z'));
    if (!startMs || startMs - nowMs < PREGAME_MIN_MS || startMs - nowMs > HORIZON_MS || m.closed) continue;
    const outcomes = parseArr(m.outcomes) || [];
    if (outcomes.length !== 2) continue;
    const q0 = quoteOutcome(m, 0), q1 = quoteOutcome(m, 1);
    const c0 = byId.get(`${m.slug}:0`), c1 = byId.get(`${m.slug}:1`);
    rows.push({
      slug: m.slug,
      game: m.question || outcomes.join(' vs. '),
      outcomes: outcomes.map(String),
      startTime: new Date(startMs).toISOString(),
      mid: [q0.mid, q1.mid],
      spread: q0.spread,
      books: [c0 && c0.refSource === 'books' ? c0.vegasProb : null, c1 && c1.refSource === 'books' ? c1.vegasProb : null],
      lines: (lines || []).filter(x => x.slug.startsWith(`${m.slug}-`)).map(({ slug, ...rest }) => rest),
    });
  }
  return rows;
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

  // Odds API is a paid/limited feed; when it's nearly spent, price off
  // DraftKings (ESPN, free) alone rather than burn the last credits.
  const oddsStatus = await kvJson(env, 'odds_api_status');
  const creditsLeft = oddsStatus && oddsStatus.remaining != null ? parseInt(oddsStatus.remaining, 10) : null;
  const useOddsApi = !(creditsLeft !== null && !isNaN(creditsLeft) && creditsLeft < 150);

  const perSport = {};
  let candidates = [];
  const polyGames = [];
  for (const sport of directive.sports.filter(s => SPORT_TAG[s])) {
    try {
      const markets = await fetchSportMoneylines(sport, nowMs);
      const wanted = directive.markets || ALL_MARKETS;
      const linePages = Math.max(1, Math.min(5, Math.ceil((markets.length * 6) / 100)));
      const [odds, dk, spreads, totals] = await Promise.all([
        useOddsApi ? Promise.resolve(getGameOdds(env, SPORT_KEY_MAP[sport], 'h2h,spreads')).catch(() => null) : null,
        fetchDkLines(sport, nowMs),
        wanted.includes('spread') ? fetchSportLines(sport, 'spreads', nowMs, linePages) : [],
        wanted.includes('total') ? fetchSportLines(sport, 'totals', nowMs, linePages) : [],
      ]);
      const built = buildCandidates(sport, markets, odds || [], nowMs, dk.games);
      perSport[sport] = {
        markets: markets.length, oddsGames: (odds || []).length, dkGames: dk.games.length,
        matched: built.matched, dkMatched: built.dkMatched, unmatched: built.unmatched,
        unmatchedGames: built.unmatchedGames, dkFeed: dk.diag,
      };
      candidates.push(...built.candidates);
      polyGames.push(...polyGameRows(markets, built.candidates, nowMs, [...spreads, ...totals]).map(r => ({ ...r, sport })));
      perSport[sport].lines = spreads.length + totals.length;
    } catch (e) {
      perSport[sport] = { error: e.message };
    }
  }
  const oddsApi = await kvJson(env, 'odds_api_status');

  // DraftKings value board: best price DraftKings offers vs the fair price,
  // one side per game.
  const dkSeen = new Set();
  const dkBoard = [];
  for (const c of candidates.filter(c => c.dk && typeof c.dk.ev === 'number').sort((a, b) => b.dk.ev - a.dk.ev)) {
    if (dkSeen.has(c.marketSlug)) continue;
    dkSeen.add(c.marketSlug);
    dkBoard.push({
      id: c.id, game: c.game, team: c.team, opponent: c.dk.opponent, startTime: c.startTime,
      odds: c.dk.odds, implied: c.dk.implied, fair: c.dk.fairUsed, dkNoVig: c.dk.fair, ev: c.dk.ev,
      polyMid: c.midPrice, booksProb: c.refSource === 'books' ? c.vegasProb : null, link: c.dk.link,
      spread: c.dk.spread, total: c.dk.total,
    });
    if (dkBoard.length >= DK_BOARD_SIZE) break;
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

  // THE DEBATE (Claude): the personas argue the board with the real numbers
  // and the chair rules. Runs on a new order, when the top plays change
  // (30 min apart at most), or every 90 min; otherwise the last ruling stands.
  const browserDk = await kvJson(env, CREW_KEYS.DK_BOARD);
  const dkForDebate = browserDk && nowMs - Date.parse(browserDk.at) < 45 * 60e3 ? browserDk.rows.slice(0, 10)
    : dkBoard.length ? dkBoard.slice(0, 10).map(r => ({ label: `${r.team} ML`, odds: r.odds, fair: r.fair, implied: r.implied, ev: r.ev, startTime: r.startTime })) : null;
  const topSet = debated.slice(0, 5).map(d => d.id).sort().join(',');
  const lastDebate = last && last.debate && last.directiveId === directive.id ? last.debate : null;
  const sinceDebate = lastDebate ? nowMs - Date.parse(lastDebate.at) : Infinity;
  const needDebate = debated.length > 0 &&
    (!lastDebate || (lastDebate.ids !== topSet && sinceDebate >= 30 * 60e3) || sinceDebate >= 90 * 60e3);
  let debateOut = lastDebate;
  let debatedNow = false;
  if (needDebate) {
    const llm = await crewLlmStatus(env);
    if (llm.ok) {
      const r = await debate(env, {
        candidates: debated.map(d => ({
          id: d.id, game: d.game, team: d.team, kickoff: fmtEtShort(d.startTime),
          polymarketPriceCents: d.buyPrice, fairProbPct: d.vegasProb,
          fairSource: d.refSource === 'books' ? `sportsbook consensus (${d.books} books)` : 'DraftKings no-vig line',
          edgePts: d.edge, draftKingsOdds: d.dkOdds, whaleFlow: d.whale, placeable: d.edge >= minEdge,
          openingVotes: d.votes.map(v => `${v.agent}: ${v.vote.toLowerCase()} (${v.conviction}) — ${v.line}`),
        })),
        dkBoard: dkForDebate && dkForDebate.map(r => ({ pick: r.label, odds: r.odds, fairPct: r.fair, dkImpliedPct: r.implied, per100: r.ev, kickoff: fmtEtShort(r.startTime) })),
        context: {
          now: fmtEtShort(new Date(nowMs).toISOString()), sports: directive.sports, minEdgePts: minEdge,
          paperBetsLeftToday: Math.max(0, (directive.maxBets ?? 6) - (dailyStats.crewOpened || 0)),
          openPositions: openPositions.length, crewLaneRecord: 'no settled crew bets yet unless stated', betSize: config.crewBetSize ?? 5,
        },
      });
      debatedNow = r.ok;
      debateOut = r.ok
        ? { at: new Date(nowMs).toISOString(), ids: topSet, lines: (r.data.debate || []).slice(0, 14), verdicts: r.data.verdicts || [], summary: r.data.summary, usd: Math.round((r.usd || 0) * 1000) / 1000 }
        : { ...(lastDebate || {}), at: lastDebate ? lastDebate.at : new Date(nowMs).toISOString(), error: r.error };
    } else if (!lastDebate) {
      debateOut = { at: new Date(nowMs).toISOString(), ids: topSet, skipped: llm.why };
    }
  }
  if (debateOut && Array.isArray(debateOut.verdicts)) {
    const byId = new Map(debateOut.verdicts.map(v => [v.id, v]));
    for (const d of debated) {
      const v = byId.get(d.id);
      if (!v) continue;
      d.ruleVerdict = d.verdict;
      d.verdict = v.verdict;
      d.chairReason = v.reason;
      d.qualifies = d.edge >= minEdge && v.verdict !== 'VETO';
      d.council = { ...d.council, verdict: v.verdict, tb: null, chair: 'claude' };
    }
  }

  // Queue: keep still-pending older picks, add new qualifiers (capped).
  const entered = new Set((await kvJson(env, CREW_KEYS.ENTERED)) || []);
  const prevQueue = ((await kvJson(env, CREW_KEYS.PICKS)) || []).filter(p => !entered.has(p.id) && Date.parse(p.startTime) - nowMs > PREGAME_MIN_MS);
  const queuedIds = new Set(prevQueue.map(p => p.id));
  const fresh = debated.filter(d => d.qualifies && !entered.has(d.id) && !queuedIds.has(d.id)).slice(0, MAX_QUEUED_PER_HUNT);
  const queue = [...prevQueue, ...fresh.map(d => ({
    id: d.id, marketSlug: d.marketSlug, outcomeIndex: d.outcomeIndex, team: d.team, game: d.game, sport: d.sport,
    startTime: d.startTime, vegasProb: d.vegasProb, buyPrice: d.buyPrice, edge: d.edge, verdict: d.verdict,
    council: d.council, directiveId: directive.id, minEdge, maxBets: directive.maxBets, queuedAt: new Date(nowMs).toISOString(),
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
    oddsApi: oddsApi || null,
    priced,
    board: debated,
    dkBoard,
    polyGames,
    dkFairMaxSpread: DK_FAIR_MAX_SPREAD,
    alsoRan: tradeable.filter(c => !top.includes(c)).slice(0, 12)
      .map(c => ({ game: c.game, team: c.team, vegasProb: c.vegasProb, buyPrice: c.buyPrice, edge: c.edge, startTime: c.startTime, dkOdds: c.dkOdds })),
    counts,
    queued: fresh.map(d => d.id),
    markets: directive.markets || ALL_MARKETS,
    debate: debateOut || null,
  };
  await env.SIGNALS_CACHE.put(CREW_KEYS.HUNT, JSON.stringify(hunt));

  // Report to the chat on the first sweep of an order, or when picks change.
  // Report on the first sweep of an order, when picks change, when pricing
  // recovers from nothing, and at least hourly so the chat never goes stale.
  const lastReport = last && (last.reportedAt || last.at);
  const report = !last || last.directiveId !== directive.id || fresh.length > 0 || debatedNow ||
    ((last.priced || 0) === 0 && priced > 0) || !lastReport || nowMs - Date.parse(lastReport) >= 60 * 60 * 1000;
  if (report) hunt.reportedAt = hunt.at;
  else hunt.reportedAt = lastReport;
  await env.SIGNALS_CACHE.put(CREW_KEYS.HUNT, JSON.stringify(hunt));
  if (report) {
    const label = directive.sports.map(s => SPORT_LABEL[s]).join(' + ');
    const am = (n) => (n > 0 ? `+${n}` : `${n}`);
    const feed = oddsApi && oddsApi.ok === false
      ? ` (Sportsbook consensus feed is down: The Odds API answered HTTP ${oddsApi.status}${oddsApi.error ? ` "${String(oddsApi.error).slice(0, 80)}"` : ''}; using DraftKings via ESPN instead.)`
      : '';
    let msg;
    if (debatedNow && debateOut.summary) {
      msg = `${label} sweep: ${priced} games priced, ${debated.length} plays debated (read it on the board). ${debateOut.summary}` +
        (fresh.length ? ` Placing ${fresh.length} paper: ${fresh.map(d => `${d.team} @ ${d.buyPrice}¢`).join(', ')}.` : '') + feed;
    } else if (priced === 0) {
      const why = Object.entries(perSport).map(([s, p]) => p.error ? `${SPORT_LABEL[s]}: ${p.error}` :
        `${SPORT_LABEL[s]}: ${p.markets} Polymarket games, ${p.dkGames} DraftKings games, ${p.oddsGames} consensus games, ${p.matched} matched`).join('; ');
      msg = `${label} sweep: nothing priced yet (${why}). Games that already kicked off are skipped. Trying again in 15 min.${feed}`;
    } else {
      const plusEv = dkBoard.filter(d => d.ev > 0);
      const dkLine = plusEv.length
        ? `DraftKings value: ${plusEv.slice(0, 4).map(d => `${d.team} ML ${am(d.odds)} (+${d.ev}% EV)`).join(', ')}. Full list with links on the board.`
        : dkBoard.length ? `DraftKings: no moneyline pays more than fair right now (best is ${dkBoard[0].team} ${am(dkBoard[0].odds)}, ${dkBoard[0].ev}% EV).` : '';
      const best = debated.slice(0, 3).map(d => `${d.team} ${d.edge > 0 ? '+' : ''}${d.edge} (${d.buyPrice}¢ vs ${d.vegasProb}%)`).join(', ');
      msg = `${label} sweep: ${priced} pregame games priced. ${dkLine} ` +
        `Polymarket gaps: ${best || 'none'}. Council: ${counts.APPROVE} approve, ${counts.TRIM} split, ${counts.VETO} veto. ` +
        (fresh.length ? `Submitting ${fresh.length} paper: ${fresh.map(d => `${d.team} @ ${d.buyPrice}¢`).join(', ')}.`
          : debated.some(d => d.edge >= minEdge) ? 'No new paper bet cleared the council.' : `No Polymarket gap reaches ${minEdge} pts; no paper bet beats forcing one.`) + feed;
    }
    await appendCrewChat(env, 'crew', msg);
  }

  return { priced, debated: debated.length, queued: fresh.length, dkPlusEv: dkBoard.filter(d => d.ev > 0).length, counts, perSport,
    debate: debatedNow ? `ran ($${debateOut.usd})` : debateOut && debateOut.error ? `failed: ${debateOut.error}` : debateOut && debateOut.skipped ? `skipped: ${debateOut.skipped}` : 'carried over' };
}

export async function getCrewState(env, deps) {
  const [directive, chat, hunt, picks, history, open, oddsApi, llm, dkRecord, browserDk] = await Promise.all([
    getActiveDirective(env),
    kvJson(env, CREW_KEYS.CHAT),
    kvJson(env, CREW_KEYS.HUNT),
    kvJson(env, CREW_KEYS.PICKS),
    deps.getTradeHistory(env, 1000).catch(() => []),
    deps.getOpenPositions(env).catch(() => []),
    kvJson(env, 'odds_api_status'),
    crewLlmStatus(env),
    getDkPicksLedger(env),
    kvJson(env, CREW_KEYS.DK_BOARD),
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
    oddsApi: oddsApi || null,
    claude: { on: llm.ok, why: llm.ok ? null : llm.why, spentToday: Math.round((llm.spent || 0) * 100) / 100, dailyCap: llm.cap },
    dkRecord,
    // When the operator's browser last shared its DraftKings board with the crew.
    dkBoardReport: browserDk ? { at: browserDk.at, rows: (browserDk.rows || []).length } : null,
  };
}

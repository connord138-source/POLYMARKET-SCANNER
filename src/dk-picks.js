// ============================================================
// DK-PICKS.JS — does following the DraftKings value board make money?
// ============================================================
//
// Every DraftKings line the board shows at or above the value bar
// (VALUE_EV_MIN, +$1.50 per $100) is recorded the first time it appears,
// at the price shown, as a $100 paper bet. After the game, it settles from
// ESPN's final score (moneyline: winner; spread: score + line; total:
// combined score vs the number). The running record answers the only
// question that matters: are the green rows profitable?
//
// Picks come from the operator's browser (it computes the board because
// ESPN only serves DraftKings odds to US visitors); final scores are not
// geo-gated, so settlement runs in the cron.
// ============================================================

export const VALUE_EV_MIN = 1.5;        // $ per $100: below this is inside Polymarket's 1-cent price noise
const PICKS_KEY = 'crew_dk_picks';
const MAX_PICKS = 600;
const SETTLE_AFTER_MS = 3.5 * 3600e3;   // a game is usually final ~3.5h after kickoff
const GIVE_UP_AFTER_MS = 4 * 86400e3;   // no final after 4 days (postponed) -> void

const ESPN_PATH = {
  cfb: 'football/college-football', nfl: 'football/nfl', nba: 'basketball/nba', wnba: 'basketball/wnba',
  mlb: 'baseball/mlb', nhl: 'hockey/nhl', ncaab: 'basketball/mens-college-basketball',
};
const ESPN_GROUPS = { cfb: ['80', '81'], ncaab: ['50'] };
const ESPN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

const r2 = (x) => Math.round(x * 100) / 100;
const kvJson = async (env, key) => {
  try { return await env.SIGNALS_CACHE.get(key, { type: 'json' }); } catch (e) { return null; }
};

// Profit on a $100 stake at American odds.
export const winOn100 = (odds) => (odds > 0 ? odds : 10000 / Math.abs(odds));

// Record the board's value rows the first time each appears (pregame only).
export async function recordDkValuePicks(env, rows, nowMs = Date.now()) {
  const picks = (await kvJson(env, PICKS_KEY)) || [];
  const seen = new Set(picks.map(p => p.id));
  let added = 0;
  for (const r of rows || []) {
    const start = Date.parse(r.startTime);
    if (!r.id || seen.has(r.id) || !(r.ev >= VALUE_EV_MIN) || !start || start - nowMs < 5 * 60e3) continue;
    if (!r.espnId || !r.sport || !['moneyline', 'spread', 'total'].includes(r.market)) continue;
    if (r.market !== 'moneyline' && typeof r.line !== 'number') continue;
    picks.push({
      id: r.id, label: r.label, market: r.market, side: r.side, team: r.team, line: r.market === 'moneyline' ? null : r.line,
      odds: r.odds, fair: r.fair, implied: r.implied, ev: r.ev, startTime: r.startTime, sport: r.sport,
      espnId: String(r.espnId), home: r.home, away: r.away, game: r.game, recordedAt: new Date(nowMs).toISOString(),
      result: null, pnl: null, final: null,
    });
    seen.add(r.id);
    added++;
  }
  if (added) await env.SIGNALS_CACHE.put(PICKS_KEY, JSON.stringify(picks.slice(-MAX_PICKS)));
  return added;
}

// Pure: grade one pick against a final score.
export function gradePick(p, fin) {
  const ours = p.side === 'home' ? fin.home : p.side === 'away' ? fin.away : null;
  const theirs = p.side === 'home' ? fin.away : p.side === 'away' ? fin.home : null;
  let margin;
  if (p.market === 'moneyline') margin = ours - theirs;
  else if (p.market === 'spread') margin = ours + p.line - theirs;
  else if (p.market === 'total') margin = p.side === 'over' ? fin.home + fin.away - p.line : p.line - (fin.home + fin.away);
  if (typeof margin !== 'number' || isNaN(margin)) return null;
  const result = margin > 0 ? 'win' : margin < 0 ? 'loss' : 'push';
  return { result, pnl: result === 'win' ? r2(winOn100(p.odds)) : result === 'loss' ? -100 : 0 };
}

// Pure: ESPN scoreboard JSON -> { [eventId]: { home, away } } for finished games.
export function parseEspnFinals(json) {
  const out = {};
  for (const e of (json && json.events) || []) {
    const c = (e.competitions || [])[0];
    if (!c || !c.status || !c.status.type || !c.status.type.completed) continue;
    const score = (ha) => parseFloat(((c.competitors || []).find(x => x.homeAway === ha) || {}).score);
    const home = score('home'), away = score('away');
    if (isNaN(home) || isNaN(away)) continue;
    out[String(e.id)] = { home, away };
  }
  return out;
}

const etYmd = (ms) => {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    const g = (t) => (p.find(x => x.type === t) || {}).value;
    return `${g('year')}${g('month')}${g('day')}`;
  } catch (e) { return new Date(ms).toISOString().slice(0, 10).replace(/-/g, ''); }
};

// Cron: settle picks whose games should be over.
export async function settleDkPicks(env, nowMs = Date.now()) {
  const picks = (await kvJson(env, PICKS_KEY)) || [];
  const due = picks.filter(p => !p.result && nowMs - Date.parse(p.startTime) > SETTLE_AFTER_MS);
  if (!due.length) return { pending: picks.filter(p => !p.result).length, settled: 0 };
  const finals = {};
  const groups = new Set(due.map(p => `${p.sport}|${etYmd(Date.parse(p.startTime))}`));
  for (const key of groups) {
    const [sport, ymd] = key.split('|');
    const path = ESPN_PATH[sport];
    if (!path) continue;
    for (const g of ESPN_GROUPS[sport] || [null]) {
      try {
        const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${ymd}&limit=400${g ? `&groups=${g}` : ''}`, { headers: ESPN_HEADERS });
        if (res.ok) Object.assign(finals, parseEspnFinals(await res.json()));
      } catch (e) {}
    }
  }
  let settled = 0;
  for (const p of due) {
    const fin = finals[p.espnId];
    if (fin) {
      const g = gradePick(p, fin);
      if (g) { Object.assign(p, g, { final: fin, settledAt: new Date(nowMs).toISOString() }); settled++; }
    } else if (nowMs - Date.parse(p.startTime) > GIVE_UP_AFTER_MS) {
      Object.assign(p, { result: 'void', pnl: 0, settledAt: new Date(nowMs).toISOString() });
      settled++;
    }
  }
  if (settled) await env.SIGNALS_CACHE.put(PICKS_KEY, JSON.stringify(picks));
  return { pending: picks.filter(p => !p.result).length, settled };
}

// Pure: the running record.
export function dkPicksLedger(picks) {
  let wins = 0, losses = 0, pushes = 0, pnl = 0;
  const byMarket = {};
  for (const p of picks || []) {
    if (p.result !== 'win' && p.result !== 'loss' && p.result !== 'push') continue;
    p.result === 'win' ? wins++ : p.result === 'loss' ? losses++ : pushes++;
    pnl += p.pnl || 0;
    const m = byMarket[p.market] || (byMarket[p.market] = { wins: 0, losses: 0, pushes: 0, pnl: 0 });
    p.result === 'win' ? m.wins++ : p.result === 'loss' ? m.losses++ : m.pushes++;
    m.pnl = r2(m.pnl + (p.pnl || 0));
  }
  const graded = wins + losses + pushes;
  return {
    bar: VALUE_EV_MIN,
    graded, wins, losses, pushes,
    pnl: r2(pnl),                                   // dollars, on $100 per pick
    roi: graded ? Math.round((pnl / (graded * 100)) * 1000) / 10 : null,
    pending: (picks || []).filter(p => !p.result).length,
    byMarket,
    recent: (picks || []).filter(p => p.result && p.result !== 'void').slice(-8).reverse()
      .map(p => ({ label: p.label, game: p.game, result: p.result, pnl: p.pnl, ev: p.ev, final: p.final })),
    open: (picks || []).filter(p => !p.result).slice(-8).reverse().map(p => ({ label: p.label, game: p.game, ev: p.ev, startTime: p.startTime })),
  };
}

export async function getDkPicksLedger(env) {
  return dkPicksLedger((await kvJson(env, PICKS_KEY)) || []);
}

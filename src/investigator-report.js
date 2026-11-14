// The AI investigator's record, broken down (Nov 14 2026, owner's "go ahead
// with step 1"). The paper leaderboard carries one line for it (+17% on 58
// settled bets at the recorded price); this module answers what a new engine
// needs to know before it is built on that record:
//   - which KINDS of markets the money came from (weather, politics, ...),
//   - at which prices and disagreement sizes,
//   - what is left after costs (a worse fill plus an exchange fee),
//   - how much of it is a few lucky long shots, and how many independent
//     events stand behind the bets (ten temperature buckets of one city on
//     one day are one event, not ten).
// Pure: the route in index.js reads D1 `investigations` and hands the rows in.
//
// A bet: the agent's probability for the investigated direction against the
// market's price for it (edge_pts = agent - market, in points). It backs the
// direction when the edge is positive and the other side when it is negative,
// for a flat stake, held to settlement (y: 1 = the direction won).

export const STAKE = 100;
// Cost scenarios: `slipC` cents paid over the recorded price (the recorded
// price is Gamma's displayed probability, not an offer), `feeCoef` x p(1-p)
// per contract (Kalshi's taker fee is 0.07 x p(1-p), Polymarket US 0.0695).
export const COSTS = [
  { key: 'recorded', label: 'at the recorded price, no costs', slipC: 0, feeCoef: 0 },
  { key: 'c1', label: '1c worse fill + exchange fee', slipC: 1, feeCoef: 0.07 },
  { key: 'c2', label: '2c worse fill + exchange fee', slipC: 2, feeCoef: 0.07 },
  { key: 'c3', label: '3c worse fill + exchange fee', slipC: 3, feeCoef: 0.07 },
];
export const CORE_MIN_EDGE = 12;   // the paper leaderboard's rule: |edge| >= 12 points, confidence not LOW
export const WIDE_MIN_EDGE = 5;

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;

// ---------- what kind of market is it ----------
// First match wins, most specific first. Heuristic on the title and slug;
// the report lists sample titles per kind and every "other" so it can be read
// against the real markets and tightened.
const KINDS = [
  ['weather', /temperature|°\s?[cf]\b|\brain(fall)?\b|\bsnow(fall)?\b|hurricane|\bweather\b|precipitation|heat ?wave|tornado/i],
  ['esports', /counter-?strike|\bcs2\b|\bdota\b|league of legends|\blol:|valorant|call of duty|esports|\(bo[135]\)|\bbo[135]\b/i],
  ['social', /\btweets?\b|\bposts?\b.*\bfrom\b|\bpost \d|truth social|\bmentions?\b|\bsay\b.*\bduring\b|followers|subscribers|youtube views/i],
  ['entertainment', /grammy|oscars?\b|academy award|emmy|golden globe|\balbum\b|billboard|netflix|box office|\bmovie\b|\bfilm\b|\bsong\b|spotify|eurovision|rotten tomatoes|game awards|\bauction\b|sell for|time person of the year|\bnominated\b/i],
  ['crypto', /bitcoin|\bbtc\b|ethereum|\beth\b|solana|\bsol\b|crypto|\btoken\b|airdrop|\bfdv\b|coinbase|binance|kraken|memecoin|dogecoin|\bxrp\b|stablecoin|microstrategy/i],
  ['economy', /inflation|\bcpi\b|\bfed\b|fomc|rate cut|rate hike|interest rate|\bgdp\b|unemployment|jobs report|payrolls|recession|treasury|\byield\b|s&p|nasdaq|\bdow\b|\bstock\b|earnings|\bipo\b|valuation|market cap|gas prices?|oil price/i],
  ['tech', /\bai\b|openai|anthropic|\bgpt|gemini|\bllm\b|ai model|ai lab|nvidia|jensen huang|\bapple\b|tesla|spacex|starship|iphone|google|microsoft|\bmeta\b|elon musk|sam altman/i],
  ['politics', /election|president|senate|congress|governor|parliament|prime minister|\bminister\b|\bseats\b|\bbloc\b|\bparty\b|\bvote\b|\bpolls?\b|referendum|\bmayor\b|trump|biden|supreme court|impeach|cabinet|tariff|ceasefire|\bwar\b|\bnato\b|ukraine|israel|\biran\b|sanction|shutdown|resign/i],
  ['sports', /\bvs\.?\b|\bnba\b|\bnfl\b|\bnhl\b|\bmlb\b|ncaa|premier league|la liga|serie a|bundesliga|champions league|nations league|world cup|grand prix|\bf1\b|\bufc\b|boxing|tennis|\batp\b|\bwta\b|\bgolf\b|\bpga\b|super bowl|playoffs?|\bmvp\b|heisman|championship|\bwin the\b|\bgroup [a-h]\d?\b/i],
];
export function marketKind(title, slug) {
  const t = `${title || ''} ${String(slug || '').replace(/-/g, ' ')}`;
  for (const [kind, re] of KINDS) if (re.test(t)) return kind;
  return 'other';
}
// Markets that are one event cut into buckets (a city's temperature on a day,
// "resigns by Nov 11 / Nov 12 / Dec 31") share a slug once the numbers and
// dates are taken out. Used to count independent events behind the bets.
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
export function clusterKey(slug) {
  return String(slug || '').toLowerCase()
    .replace(new RegExp(`\\b(${MONTHS})\\b`, 'g'), ' ')
    .replace(/\d+(\.\d+)?[a-z%]*/g, ' ')
    .replace(/\b(or|and|to|by|on|in|between|above|below|higher|lower|more|less|than|the|be|c|f|pt|k|m|b)\b/g, ' ')
    .replace(/[^a-z]+/g, ' ').trim().replace(/\s+/g, '-');
}

// ---------- one bet ----------
// null when the row is not a settled, priced investigation or the price is at
// the extremes (under 3c / over 97c, as the paper leaderboard skips them).
export function betOf(row) {
  if (!row || (row.y !== 0 && row.y !== 1)) return null;
  const mp = Number(row.market_prob), edge = Number(row.edge_pts);
  if (!(mp > 0 && mp < 1) || !Number.isFinite(edge) || edge === 0) return null;
  const backs = edge > 0;                               // backs the investigated direction
  const entry = backs ? mp : 1 - mp;
  if (entry < 0.03 || entry > 0.97) return null;
  const won = backs ? row.y === 1 : row.y === 0;
  const hours = row.event_date && row.investigated_at ? (Date.parse(row.event_date) - Date.parse(row.investigated_at)) / 3600e3 : null;
  return {
    key: row.inv_key || `${row.market_slug}::${row.direction_raw}`, title: row.market_title || row.market_slug || '', slug: row.market_slug || '',
    kind: marketKind(row.market_title, row.market_slug), cluster: clusterKey(row.market_slug),
    side: backs ? 'with' : 'against', entry: r4(entry), absEdge: Math.abs(edge), won,
    confidence: row.confidence || 'UNKNOWN', source: row.source || 'whale', model: row.model || 'unknown',
    horizonH: Number.isFinite(hours) ? hours : null, at: row.investigated_at || null, settledAt: row.settled_at || null,
    agentBrier: typeof row.agent_brier === 'number' ? row.agent_brier : null, marketBrier: typeof row.market_brier === 'number' ? row.market_brier : null,
  };
}
// Dollars won or lost on the flat stake under a cost scenario: the stake buys
// stake / (entry + slip + fee) contracts, each paying $1 when the side wins.
export function betPnl(bet, cost = COSTS[0], stake = STAKE) {
  const per = bet.entry + (cost.slipC || 0) / 100 + (cost.feeCoef || 0) * bet.entry * (1 - bet.entry);
  if (!(per > 0 && per < 1)) return bet.won ? 0 : -stake;   // costs ate the whole payout
  return bet.won ? stake / per - stake : -stake;
}

// ---------- a group of bets ----------
// roi per cost scenario (% of money staked); hit vs breakEven (the average
// price paid: the hit rate that only pays the stake back); t = the mean return
// over its standard error, with the bets of one event summed first (tEvents),
// so ten buckets of one event do not pass for ten independent bets.
export function summarize(bets, { stake = STAKE } = {}) {
  const n = bets.length;
  if (!n) return { n: 0 };
  const wins = bets.filter(b => b.won).length;
  const out = { n, events: new Set(bets.map(b => b.cluster)).size, wins, losses: n - wins, hitPct: r1(100 * wins / n), breakEvenPct: r1(100 * bets.reduce((a, b) => a + b.entry, 0) / n), avgEdgePts: r1(bets.reduce((a, b) => a + b.absEdge, 0) / n), roi: {}, pnl: {} };
  for (const c of COSTS) {
    const p = bets.map(b => betPnl(b, c, stake));
    const tot = p.reduce((a, x) => a + x, 0);
    out.roi[c.key] = r1(100 * tot / (n * stake)); out.pnl[c.key] = r2(tot);
    if (c.key === 'recorded' || c.key === 'c2') {
      const mean = tot / n;
      const byEvent = new Map();
      bets.forEach((b, i) => byEvent.set(b.cluster, (byEvent.get(b.cluster) || 0) + (p[i] - mean)));
      const ss = [...byEvent.values()].reduce((a, x) => a + x * x, 0);
      const se = byEvent.size > 1 ? Math.sqrt(ss * byEvent.size / (byEvent.size - 1)) / n : null;
      out[c.key === 'recorded' ? 'tEvents' : 'tEventsC2'] = se > 0 ? r2(mean / se) : null;
    }
  }
  const scored = bets.filter(b => b.agentBrier != null && b.marketBrier != null);
  if (scored.length) {
    out.brier = { n: scored.length, agent: r4(scored.reduce((a, b) => a + b.agentBrier, 0) / scored.length), market: r4(scored.reduce((a, b) => a + b.marketBrier, 0) / scored.length), agentCloserPct: r1(100 * scored.filter(b => b.agentBrier < b.marketBrier).length / scored.length) };
  }
  return out;
}
const band = (x, cuts, labels) => { for (let i = 0; i < cuts.length; i++) if (x < cuts[i]) return labels[i]; return labels[labels.length - 1]; };
export const entryBand = (b) => band(b.entry * 100, [15, 35, 65, 85], ['under 15c', '15-35c', '35-65c', '65-85c', '85c+']);
export const edgeBand = (b) => band(b.absEdge, [8, 12, 20, 30], ['5-8', '8-12', '12-20', '20-30', '30+']);
export const horizonBand = (b) => (b.horizonH == null ? 'unknown' : band(b.horizonH, [24, 72, 168, 720], ['under 1 day', '1-3 days', '3-7 days', '7-30 days', '30+ days']));
function groupBy(bets, keyOf) {
  const m = new Map();
  for (const b of bets) { const k = keyOf(b); if (!m.has(k)) m.set(k, []); m.get(k).push(b); }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, summarize(v)]));
}
export function breakdown(bets) {
  return {
    byKind: groupBy(bets, b => b.kind), byEntry: groupBy(bets, entryBand), byEdge: groupBy(bets, edgeBand), byConfidence: groupBy(bets, b => b.confidence),
    bySource: groupBy(bets, b => b.source), bySide: groupBy(bets, b => b.side), byHorizon: groupBy(bets, horizonBand), byModel: groupBy(bets, b => b.model),
    byMonth: groupBy(bets, b => String(b.settledAt || b.at || '').slice(0, 7) || 'unknown'),
  };
}
// How much of the result is a few bets: the biggest wins and losses, and the
// record with the three biggest wins taken out.
export function concentration(bets, cost = COSTS[0]) {
  const rows = bets.map(b => ({ title: String(b.title).slice(0, 90), kind: b.kind, side: b.side, entryC: r1(b.entry * 100), edgePts: r1(b.absEdge), won: b.won, pnl: r2(betPnl(b, cost)) })).sort((a, b) => b.pnl - a.pnl);
  const top3 = new Set(bets.map((b, i) => ({ i, p: betPnl(b, cost) })).sort((a, b) => b.p - a.p).slice(0, 3).map(x => x.i));
  const rest = bets.filter((_, i) => !top3.has(i));
  return { biggestWins: rows.slice(0, 5), biggestLosses: rows.slice(-3).reverse(), withoutTop3: rest.length ? { n: rest.length, roi: summarize(rest).roi } : null };
}
// Open investigations: has the market moved toward the agent since it looked?
// `market_prob_now` is the live price the route annotates. An early read that
// does not wait for settlement: cents moved in the agent's direction.
export function openDrift(rows, { minEdge = WIDE_MIN_EDGE } = {}) {
  const xs = [];
  for (const r of rows || []) {
    if (!r || r.y === 0 || r.y === 1 || r.status !== 'done') continue;
    const mp = Number(r.market_prob), now = Number(r.market_prob_now), edge = Number(r.edge_pts);
    if (!(mp > 0 && mp < 1) || !(now >= 0 && now <= 1) || r.market_prob_now == null || !Number.isFinite(edge) || Math.abs(edge) < minEdge) continue;
    xs.push({ moveC: (now - mp) * 100 * Math.sign(edge), absEdge: Math.abs(edge), kind: marketKind(r.market_title, r.market_slug) });
  }
  const sum = (ys) => (ys.length ? { n: ys.length, avgMoveC: r2(ys.reduce((a, x) => a + x.moveC, 0) / ys.length), towardPct: r1(100 * ys.filter(x => x.moveC > 0).length / ys.length), awayPct: r1(100 * ys.filter(x => x.moveC < 0).length / ys.length) } : { n: 0 });
  return { minEdge, all: sum(xs), core: sum(xs.filter(x => x.absEdge >= CORE_MIN_EDGE)) };
}

// ---------- the report ----------
export function buildInvestigatorReport(rows, { nowMs = Date.now() } = {}) {
  const all = Array.isArray(rows) ? rows : [];
  const status = {};
  for (const r of all) { const s = r.status && String(r.status).startsWith('error') ? 'error' : (r.status || 'unknown'); status[s] = (status[s] || 0) + 1; }
  const settledRows = all.filter(r => r.y === 0 || r.y === 1);
  const bets = settledRows.map(betOf).filter(Boolean);
  const notLow = bets.filter(b => b.confidence !== 'LOW');
  const core = notLow.filter(b => b.absEdge >= CORE_MIN_EDGE);
  const wide = bets.filter(b => b.absEdge >= WIDE_MIN_EDGE);
  // the rule at every threshold: a real edge should grow with the size of the disagreement
  const byMinEdge = {};
  for (const m of [0, 5, 8, 12, 15, 20, 30]) byMinEdge[`${m}+`] = summarize(notLow.filter(b => b.absEdge >= m));
  // calibration on every scored investigation, whatever the edge: where is the agent closer to the truth than the market
  const scored = settledRows.filter(r => typeof r.agent_brier === 'number' && typeof r.market_brier === 'number');
  const calib = new Map();
  for (const r of scored) { const k = marketKind(r.market_title, r.market_slug); if (!calib.has(k)) calib.set(k, []); calib.get(k).push(r); }
  const calibByKind = Object.fromEntries([...calib.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, { n: v.length, agent: r4(v.reduce((a, r) => a + r.agent_brier, 0) / v.length), market: r4(v.reduce((a, r) => a + r.market_brier, 0) / v.length), agentCloserPct: r1(100 * v.filter(r => r.agent_brier < r.market_brier).length / v.length) }]));
  // what is still open, by kind, and the pace
  const openRows = all.filter(r => r.status === 'done' && r.y !== 0 && r.y !== 1);
  const openByKind = {};
  for (const r of openRows) { const k = marketKind(r.market_title, r.market_slug); openByKind[k] = (openByKind[k] || 0) + 1; }
  const openCore = openRows.filter(r => Math.abs(Number(r.edge_pts)) >= CORE_MIN_EDGE && r.confidence !== 'LOW').length;
  const times = core.map(b => Date.parse(b.settledAt || b.at)).filter(Number.isFinite).sort((a, b) => a - b);
  const days = times.length > 1 ? Math.max(1, (times[times.length - 1] - times[0]) / 86400e3) : null;
  const last14 = core.filter(b => Date.parse(b.settledAt || b.at) >= nowMs - 14 * 86400e3).length;
  // sample titles per kind, and every "other", to read the classifier against the real markets
  const samples = {};
  for (const b of bets) { (samples[b.kind] = samples[b.kind] || []); if (samples[b.kind].length < (b.kind === 'other' ? 15 : 3)) samples[b.kind].push(String(b.title).slice(0, 80)); }
  return {
    success: true, at: new Date(nowMs).toISOString(), stake: STAKE, costs: COSTS,
    counts: { investigations: all.length, status, settled: settledRows.length, bets: bets.length, open: openRows.length, openCore },
    core: { rule: `|edge| >= ${CORE_MIN_EDGE} points, confidence not LOW (the paper leaderboard's rule)`, all: summarize(core), ...breakdown(core), concentration: concentration(core) },
    wide: { rule: `|edge| >= ${WIDE_MIN_EDGE} points, any confidence`, all: summarize(wide), ...breakdown(wide) },
    byMinEdge,
    calibration: { n: scored.length, byKind: calibByKind },
    openDrift: openDrift(all),
    pace: { firstAt: times.length ? new Date(times[0]).toISOString() : null, lastAt: times.length ? new Date(times[times.length - 1]).toISOString() : null, days: days != null ? r1(days) : null, corePerWeek: days ? r1(core.length / days * 7) : null, coreLast14d: last14, openByKind },
    samples,
    read: `The AI investigator's settled record as bets: it backs the investigated direction when its probability is above the market's and the other side when below, a flat $${STAKE}, held to settlement. core = the paper leaderboard's rule; wide = every disagreement of ${WIDE_MIN_EDGE}+ points. roi.recorded is at the price recorded when it looked (Gamma's displayed probability, not an offer); c1/c2/c3 pay 1/2/3 cents more per contract plus a 0.07 x p(1-p) exchange fee, which is the range a real fill on Kalshi or Polymarket US would land in. hitPct against breakEvenPct (the average price paid) is the edge in points. events = distinct events behind the bets (buckets of one event share a cluster); tEvents / tEventsC2 = mean return over its standard error with one event's bets summed first, at the recorded price and under c2: about 2 or more is evidence, under 1 is noise. byMinEdge runs the rule at each disagreement size: a real edge grows with it. concentration shows how much is a few long shots. calibration compares Brier scores (lower is better) on every scored investigation by kind. openDrift = on the open investigations, cents the market has moved toward the agent's view since it looked. Markets are global Polymarket's; a US account would trade the same question on Kalshi where it lists one.`,
  };
}

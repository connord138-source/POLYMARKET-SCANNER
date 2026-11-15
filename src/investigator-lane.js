// The investigator's test lane (Nov 15 2026, owner's "Can you run it at 10 a
// day in dry mode simulated real?"). The settled record (investigator-report.js)
// said one pattern has the shape of an edge and too few bets to prove it: big
// disagreements with the market, on questions that settle within days, outside
// weather. This lane tests that pattern going forward with the rule fixed in
// advance, as a live bot would trade it:
//   - the sweep researches only what the rule can bet (`sweepPool`: settles
//     within SWEEP_MAX_DAYS, not weather, a two-sided order book, at most two
//     questions of one event a day, kinds taken in turn);
//   - the moment an investigation finishes, the order book of the side it
//     backs is read and the bet is the order a live bot would send: buy up to
//     the stake from the asks, best first, never paying more than the agent's
//     probability minus the required edge (`walkAsks` with a limit). What is
//     offered at or under that limit is the fill; nothing offered there is no
//     bet. The price moved while it researched? Then the real price decides.
//   - the bet is held to settlement; the result is read off the
//     investigation's ground-truth outcome (D1 `investigations.y`).
// Every finished investigation is recorded with its book, pass or not, so the
// same rule can be read at other thresholds later. Nothing is ever sent: the
// markets are global Polymarket's and the book is public. A US account would
// trade the same question on Kalshi where it lists one; fees are charged at
// Kalshi's rate (0.07 x p(1-p)) next to Polymarket's own schedule.
import { marketKind, clusterKey } from './investigator-report.js';

export const CLOB_API = 'https://clob.polymarket.com';
// The rule, fixed on Nov 15 2026. Changing it restarts the test: bump `version`.
export const LANE = {
  version: 1,
  stakeUsd: 25,          // dollars per bet
  minEdgePts: 20,        // agent's probability for the side minus the price PAID, in points
  maxHorizonH: 72,       // the question settles within this many hours of the bet
  minFillUsd: 5,         // less than this offered under the limit = no bet
  feeCoef: 0.07,         // Kalshi's taker fee, x p(1-p) per contract (the US venue's cost)
  excludeKinds: ['weather'],
};
export const INV_LANE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS investigator_bets (
    inv_key TEXT PRIMARY KEY, ts INTEGER NOT NULL, version INTEGER, market_slug TEXT, title TEXT, kind TEXT, cluster TEXT,
    side TEXT, outcome TEXT, token_id TEXT, agent_p REAL, shown_p REAL, best_ask REAL, best_bid REAL, ask_px REAL, limit_px REAL,
    fill_px REAL, fill_usd REAL, shares REAL, fee_poly_usd REAL, fee_k_usd REAL, edge_fill_pts REAL, horizon_h REAL,
    confidence TEXT, source TEXT, rule INTEGER, why TEXT, lag_s INTEGER, event_date TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_invbets_ts ON investigator_bets(ts)`,
];
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const arr = (v) => { if (Array.isArray(v)) return v; if (typeof v === 'string') { try { const x = JSON.parse(v); return Array.isArray(x) ? x : null; } catch (e) { return null; } } return null; };

// ---------- the book ----------
// A CLOB book's asks as [price, size], cheapest first.
export function asksOf(book) {
  return ((book && book.asks) || []).map(a => [Number(a.price), Number(a.size)]).filter(a => a[0] > 0 && a[0] < 1 && a[1] > 0).sort((a, b) => a[0] - b[0]);
}
export function bestBidOf(book) {
  const b = ((book && book.bids) || []).map(x => Number(x.price)).filter(x => x > 0 && x < 1);
  return b.length ? Math.max(...b) : null;
}
// Buy up to `usd` dollars from the asks, cheapest first, paying no more than
// `maxPx` a contract. { usd, shares, avgPx, worstPx } of what is there; usd 0
// when nothing is offered at or under the limit.
export function walkAsks(asks, usd, maxPx = 1) {
  let left = usd, shares = 0, spent = 0, worst = null;
  for (const [px, size] of asks || []) {
    if (left <= 1e-9 || px > maxPx + 1e-9) break;
    const take = Math.min(size, left / px);
    shares += take; spent += take * px; left -= take * px; worst = px;
  }
  if (!(shares > 0)) return { usd: 0, shares: 0, avgPx: null, worstPx: null };
  return { usd: r2(spent), shares: r4(shares), avgPx: r4(spent / shares), worstPx: worst };
}

// ---------- the decision (pure) ----------
// inv: { agentProb, marketProb, edgePts, confidence, title, slug, eventDate, source }
// market: { outcomes, tokens, winIndex } (winIndex = the investigated direction's outcome)
// book: the CLOB book of the token the bet would buy (null when it could not be read)
export function laneSide(inv, market) {
  const edge = Number(inv.edgePts);
  const outs = arr(market && market.outcomes) || [], toks = arr(market && market.tokens) || [];
  const wi = market ? market.winIndex : -1;
  if (!Number.isFinite(edge) || edge === 0 || !(wi >= 0)) return null;
  if (edge > 0) return { side: 'with', outcome: outs[wi] != null ? String(outs[wi]) : null, tokenId: toks[wi] || null };
  if (outs.length !== 2) return { side: 'against', outcome: null, tokenId: null };     // the other side of a multi-outcome market is not one token
  return { side: 'against', outcome: String(outs[1 - wi]), tokenId: toks[1 - wi] || null };
}
export function laneDecision(inv, market, book, { cfg = LANE, nowMs = Date.now(), feeSchedule = null, startedMs = null } = {}) {
  const kind = marketKind(inv.title, inv.slug);
  const s = laneSide(inv, market);
  const ap = Number(inv.agentProb), mp = Number(inv.marketProb);
  const horizonH = inv.eventDate && Number.isFinite(Date.parse(inv.eventDate)) ? (Date.parse(inv.eventDate) - nowMs) / 3600e3 : null;
  const row = {
    version: cfg.version, kind, cluster: clusterKey(inv.slug), side: s ? s.side : null, outcome: s ? s.outcome : null, tokenId: s ? s.tokenId : null,
    agentP: null, shownP: null, bestAsk: null, bestBid: null, askPx: null, limitPx: null, fillPx: null, fillUsd: 0, shares: 0, feePolyUsd: 0, feeKUsd: 0,
    edgeFillPts: null, horizonH: horizonH != null ? r1(horizonH) : null, confidence: inv.confidence || null, source: inv.source || 'whale',
    rule: 0, why: null, lagS: startedMs ? Math.round((nowMs - startedMs) / 1000) : null,
  };
  if (!s || !(ap >= 0 && ap <= 1) || !(mp > 0 && mp < 1)) { row.why = 'no disagreement to bet'; return row; }
  row.agentP = r4(s.side === 'with' ? ap : 1 - ap); row.shownP = r4(s.side === 'with' ? mp : 1 - mp);
  // the book, whatever the rule says, so other thresholds can be read later
  const asks = asksOf(book);
  if (asks.length) {
    row.bestAsk = asks[0][0]; row.bestBid = bestBidOf(book);
    const full = walkAsks(asks, cfg.stakeUsd);
    row.askPx = full.usd >= cfg.stakeUsd - 0.01 ? full.avgPx : null;        // the whole stake at whatever it costs; null when the book is too thin
    row.limitPx = Math.floor((row.agentP - cfg.minEdgePts / 100) * 100 + 1e-9) / 100;
    if (row.limitPx >= 0.01) {
      const f = walkAsks(asks, cfg.stakeUsd, row.limitPx);
      if (f.usd >= cfg.minFillUsd) {
        const sched = feeSchedule && typeof feeSchedule.rate === 'number' ? feeSchedule : null;
        row.fillPx = f.avgPx; row.fillUsd = f.usd; row.shares = f.shares; row.edgeFillPts = r1((row.agentP - f.avgPx) * 100);
        row.feePolyUsd = sched ? r2(f.shares * sched.rate * Math.pow(f.avgPx * (1 - f.avgPx), typeof sched.exponent === 'number' ? sched.exponent : 1)) : 0;
        row.feeKUsd = r2(f.shares * cfg.feeCoef * f.avgPx * (1 - f.avgPx));
      }
    }
  }
  // the rule, first failure named
  if ((cfg.excludeKinds || []).includes(kind)) row.why = `${kind} is left out`;
  else if (row.confidence === 'LOW') row.why = 'low confidence';
  else if (horizonH == null) row.why = 'no settlement date';
  else if (horizonH <= 0) row.why = 'already past its end';
  else if (horizonH > cfg.maxHorizonH) row.why = `settles more than ${cfg.maxHorizonH}h out`;
  else if (Math.abs(Number(inv.edgePts)) < cfg.minEdgePts) row.why = `disagreement under ${cfg.minEdgePts} points`;
  else if (!s.tokenId) row.why = 'no single contract for that side';
  else if (!asks.length) row.why = 'no offers in the order book';
  else if (!(row.fillUsd >= cfg.minFillUsd)) row.why = `under ${cfg.minEdgePts} points at the real offer`;
  else { row.rule = 1; row.why = 'bet'; }
  if (!row.rule) { row.fillPx = null; row.fillUsd = 0; row.shares = 0; row.feePolyUsd = 0; row.feeKUsd = 0; row.edgeFillPts = null; }
  return row;
}

// ---------- record one finished investigation (never throws) ----------
export async function recordLaneBet(env, rec, { market, baseline, startedMs = null, fetchImpl = fetch, nowMs = Date.now(), cfg = LANE, retryMs = 800 } = {}) {
  try {
    if (!env.DB || !rec || rec.status !== 'done' || !rec.invKey) return null;
    const m = market || {};
    const mk = { outcomes: arr(m.outcomes), tokens: arr(m.clobTokenIds), winIndex: baseline ? baseline.winIndex : -1 };
    const inv = { agentProb: rec.agentProb, marketProb: rec.marketProbAtInvestigation, edgePts: rec.edgePts, confidence: rec.confidence, title: rec.marketTitle, slug: rec.marketSlug, eventDate: rec.eventDate, source: rec.source };
    const s = laneSide(inv, mk);
    let book = null;
    if (s && s.tokenId) {
      try { const res = await fetchImpl(`${CLOB_API}/book?token_id=${encodeURIComponent(s.tokenId)}`); if (res.ok) book = await res.json(); } catch (e) { book = null; }
    }
    const row = laneDecision(inv, mk, book, { cfg, nowMs, feeSchedule: m.feeSchedule || null, startedMs });
    const write = () => env.DB.prepare(
      `INSERT OR REPLACE INTO investigator_bets (inv_key, ts, version, market_slug, title, kind, cluster, side, outcome, token_id, agent_p, shown_p, best_ask, best_bid, ask_px, limit_px, fill_px, fill_usd, shares, fee_poly_usd, fee_k_usd, edge_fill_pts, horizon_h, confidence, source, rule, why, lag_s, event_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(rec.invKey, Math.floor(nowMs / 1000), row.version, rec.marketSlug || null, String(rec.marketTitle || '').slice(0, 200), row.kind, row.cluster, row.side, row.outcome, row.tokenId,
      row.agentP, row.shownP, row.bestAsk, row.bestBid, row.askPx, row.limitPx, row.fillPx, row.fillUsd, row.shares, row.feePolyUsd, row.feeKUsd, row.edgeFillPts, row.horizonH,
      row.confidence, row.source, row.rule, row.why, row.lagS, rec.eventDate || null).run();
    // D1 can answer "overloaded" mid-cycle: the bet is worth two more tries
    for (let i = 0; ; i++) {
      try { await write(); break; }
      catch (e) { if (i >= 2) throw e; await new Promise(r => setTimeout(r, retryMs * (i + 1))); }
    }
    return row;
  } catch (e) { return { error: String(e.message).slice(0, 120) }; }
}

// ---------- what the sweep researches (pure) ----------
// Gamma markets -> the questions the rule can bet: Yes/No, with resolution
// text, still uncertain (8-92c), ending inside the window, a two-sided book no
// wider than `maxSpread`, not sports / esports / short-term gambling (the
// caller's `investigable`), not an excluded kind.
export function sweepPool(markets, { nowMs = Date.now(), maxDays = 3, minHours = 1, maxSpread = 0.08, excludeKinds = LANE.excludeKinds, investigable = () => true } = {}) {
  const out = [];
  for (const m of markets || []) {
    if (!m || !m.slug || !m.description) continue;
    const names = arr(m.outcomes), prices = arr(m.outcomePrices);
    if (!names || !prices || names.length !== 2) continue;
    const yi = names.findIndex(n => String(n).trim().toLowerCase() === 'yes');
    if (yi < 0) continue;
    const yes = parseFloat(prices[yi]);
    if (!(yes >= 0.08 && yes <= 0.92)) continue;
    const end = m.endDate ? Date.parse(m.endDate) : NaN;
    if (!Number.isFinite(end) || end < nowMs + minHours * 3600e3 || end > nowMs + maxDays * 86400e3) continue;
    const q = m.question || '';
    if (!investigable({ marketTitle: q, marketSlug: m.slug })) continue;
    const bid = Number(m.bestBid), ask = Number(m.bestAsk);
    if (!(bid > 0 && ask > 0 && ask - bid <= maxSpread + 1e-9) || m.acceptingOrders === false) continue;
    const kind = marketKind(q, m.slug);
    if ((excludeKinds || []).includes(kind)) continue;
    out.push({ marketSlug: m.slug, directionRaw: 'Yes', marketTitle: q, avgEntryPrice: Math.round(yes * 100), eventDate: m.endDate, kind, cluster: clusterKey(m.slug), vol24: Number(m.volume24hr) || 0 });
  }
  return out;
}
// Kinds taken in turn (busiest question of each first), so one busy kind
// (crypto price ladders) does not take the whole day's research.
export function interleaveByKind(pool) {
  const by = new Map();
  for (const c of [...(pool || [])].sort((a, b) => b.vol24 - a.vol24)) { if (!by.has(c.kind)) by.set(c.kind, []); by.get(c.kind).push(c); }
  const lists = [...by.values()], out = [];
  for (let i = 0; lists.some(l => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}
// The next questions to research: not done before (`doneKeys`: inv keys), and
// at most `perEvent` of one event today (`eventCounts`: cluster -> researched today).
export function pickFresh(pool, { doneKeys = new Set(), eventCounts = {}, limit = 1, perEvent = 2, keyOf = (c) => `investigation:${c.marketSlug}::${c.directionRaw}` } = {}) {
  const counts = { ...eventCounts }, out = [];
  for (const c of pool || []) {
    if (out.length >= limit) break;
    if (doneKeys.has(keyOf(c))) continue;
    if ((counts[c.cluster] || 0) >= perEvent) continue;
    counts[c.cluster] = (counts[c.cluster] || 0) + 1;
    out.push(c);
  }
  return out;
}

// ---------- the test's report (pure) ----------
// bets: investigator_bets rows; outcomes: Map inv_key -> { y, settledAt } from investigations.
const pnlOf = (b, won, fee) => (won ? b.shares - b.fill_usd : -b.fill_usd) - (fee === 'kalshi' ? b.fee_k_usd || 0 : fee === 'poly' ? b.fee_poly_usd || 0 : 0);
function summarizeLane(rows) {
  const n = rows.length;
  if (!n) return { n: 0 };
  const wins = rows.filter(r => r.won).length, staked = rows.reduce((a, r) => a + r.fill_usd, 0);
  const out = { n, events: new Set(rows.map(r => r.cluster)).size, wins, losses: n - wins, hitPct: r1(100 * wins / n), breakEvenPct: r1(100 * rows.reduce((a, r) => a + r.fill_px, 0) / n), stakedUsd: r2(staked), avgEdgePts: r1(rows.reduce((a, r) => a + (r.edge_fill_pts || 0), 0) / n) };
  for (const fee of ['none', 'poly', 'kalshi']) {
    const p = rows.map(r => pnlOf(r, r.won, fee)), tot = p.reduce((a, x) => a + x, 0);
    out[fee === 'none' ? 'beforeFees' : fee === 'poly' ? 'polymarketFees' : 'kalshiFees'] = { pnlUsd: r2(tot), roiPct: staked > 0 ? r1(100 * tot / staked) : null };
    if (fee === 'kalshi') {
      // mean return per bet over its standard error, one event's bets summed first
      const ret = rows.map((r, i) => p[i] / r.fill_usd), mean = ret.reduce((a, x) => a + x, 0) / n, by = new Map();
      rows.forEach((r, i) => by.set(r.cluster, (by.get(r.cluster) || 0) + (ret[i] - mean)));
      const ss = [...by.values()].reduce((a, x) => a + x * x, 0), se = by.size > 1 ? Math.sqrt(ss * by.size / (by.size - 1)) / n : null;
      out.tEvents = se > 0 ? r2(mean / se) : null;
    }
  }
  return out;
}
export function laneReport(bets, outcomes, { nowMs = Date.now(), cfg = LANE } = {}) {
  const all = (bets || []).filter(b => b.version == null || b.version === cfg.version);
  const oc = outcomes || new Map();
  const withY = (b) => { const o = oc.get(b.inv_key); const y = o ? o.y : null; return { ...b, y, settledAt: o ? o.settledAt : null, won: y === 0 || y === 1 ? (b.side === 'with' ? y === 1 : y === 0) : null }; };
  const rows = all.map(withY);
  const passed = rows.filter(r => r.rule === 1);
  const settled = passed.filter(r => r.won != null), open = passed.filter(r => r.won == null);
  const whyNot = {};
  for (const r of rows) if (r.rule !== 1) whyNot[r.why || 'unknown'] = (whyNot[r.why || 'unknown'] || 0) + 1;
  const byKind = {};
  for (const k of [...new Set(settled.map(r => r.kind))]) byKind[k] = summarizeLane(settled.filter(r => r.kind === k));
  // the same rule at other thresholds, at the real offer for the whole stake (ask_px), on every researched question the filters allow
  const base = rows.filter(r => r.ask_px > 0 && r.agent_p != null && r.won != null && r.confidence !== 'LOW' && !(cfg.excludeKinds || []).includes(r.kind) && r.horizon_h != null && r.horizon_h > 0 && r.horizon_h <= cfg.maxHorizonH);
  const atEdge = {};
  for (const m of [5, 10, 15, 20, 30]) {
    const xs = base.filter(r => (r.agent_p - r.ask_px) * 100 >= m).map(r => { const shares = cfg.stakeUsd / r.ask_px; return { ...r, fill_px: r.ask_px, fill_usd: cfg.stakeUsd, shares, fee_k_usd: shares * cfg.feeCoef * r.ask_px * (1 - r.ask_px), fee_poly_usd: 0, edge_fill_pts: (r.agent_p - r.ask_px) * 100 }; });
    const s = summarizeLane(xs);
    atEdge[`${m}+`] = s.n ? { n: s.n, events: s.events, hitPct: s.hitPct, breakEvenPct: s.breakEvenPct, roiPct: s.kalshiFees.roiPct, tEvents: s.tEvents } : { n: 0 };
  }
  const slip = passed.filter(r => r.fill_px != null && r.shown_p != null);
  const view = (r) => ({ at: new Date(r.ts * 1000).toISOString(), title: String(r.title || '').slice(0, 90), kind: r.kind, backs: r.outcome || r.side, agentPct: r1(r.agent_p * 100), paidC: r1(r.fill_px * 100), shownC: r.shown_p != null ? r1(r.shown_p * 100) : null, stakeUsd: r.fill_usd, ends: r.event_date || null, confidence: r.confidence, won: r.won, pnlUsd: r.won == null ? null : r2(pnlOf(r, r.won, 'kalshi')) });
  const ts = rows.map(r => r.ts).filter(Number.isFinite);
  const days = ts.length ? Math.max(1 / 24, (nowMs / 1000 - Math.min(...ts)) / 86400) : null;
  return {
    rule: `Bet $${cfg.stakeUsd} when the AI investigator's probability for a side is ${cfg.minEdgePts}+ points above the price actually paid for it in the order book, the question settles within ${cfg.maxHorizonH} hours, its confidence is not LOW and the market is not ${(cfg.excludeKinds || []).join(' / ')}. Held to settlement. Paper only.`,
    version: cfg.version, since: ts.length ? new Date(Math.min(...ts) * 1000).toISOString() : null, days: days != null ? r1(days) : null,
    researched: rows.length, bets: passed.length, open: open.length, settled: summarizeLane(settled), byKind, whyNot,
    perDay: days ? { researched: r1(rows.length / days), bets: r1(passed.length / days) } : null,
    fill: slip.length ? { avgPaidOverShownC: r2(slip.reduce((a, r) => a + (r.fill_px - r.shown_p) * 100, 0) / slip.length), avgResearchS: Math.round(slip.reduce((a, r) => a + (r.lag_s || 0), 0) / slip.length), partial: passed.filter(r => r.fill_usd < cfg.stakeUsd - 0.01).length } : null,
    atEdge,
    openBets: open.sort((a, b) => b.ts - a.ts).slice(0, 25).map(view),
    recentSettled: settled.sort((a, b) => b.ts - a.ts).slice(0, 20).map(view),
    read: `The pattern from the settled record, tested forward with the rule fixed in advance (version ${cfg.version}). Each bet is the order a live bot would send the moment the research finishes: buy up to $${cfg.stakeUsd} from the real asks of the side it backs, cheapest first, never above its probability minus ${cfg.minEdgePts} points; what is offered there is the fill (partial when the book is thin), nothing offered there is no bet (whyNot). settled: hitPct against breakEvenPct (the average price paid), and the result before fees, with Polymarket's own fee schedule and with Kalshi's 0.07 x p(1-p) (the US venue's cost: the number to read). events = distinct events behind the bets; tEvents = mean return over its standard error with one event's bets summed first (about 2 or more is evidence, under 1 is noise). fill.avgPaidOverShownC = cents paid over the price shown when the research started. atEdge = the rule at other disagreement sizes, the whole stake at the real offer. The book is global Polymarket's; Kalshi's price for the same question can differ.`,
  };
}

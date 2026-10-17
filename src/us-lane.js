// Polymarket US stale-quote paper lane. The sampler (src/xvenue.js) showed
// that when global Polymarket's in-game mid moves 3c+ inside a minute, the
// Polymarket US book is often still crossable after its taker fee (Oct 16
// 2026: NHL 21% of moves, 6.5c average; NBA/CFB clear the bar on larger
// samples). That is a lag signal, not an arbitrage - a US trader cannot sell
// into global Polymarket - so this lane logs a hypothetical taker fill on the
// US book at every qualifying minute and marks it against global Polymarket's
// mid 1 / 5 / 15 / 60 minutes later, at the end of the game, and at
// settlement. No orders are placed anywhere. Rows live in D1 `us_lane_events`;
// `GET /xvenue/uslane` reads them back.
import { US_TAKER_RATE, usFee } from './xvenue.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';

export const US_LANE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS us_lane_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, sport TEXT NOT NULL, game TEXT NOT NULL, team TEXT NOT NULL,
    p_token TEXT, us_slug TEXT, side TEXT NOT NULL, px REAL NOT NULL, qty REAL, fee REAL NOT NULL,
    p_bid REAL, p_ask REAL, p_mid REAL, dp_c REAL, edge_c REAL,
    m1 REAL, m5 REAL, m15 REAL, m60 REAL, final REAL, marked_at INTEGER, settle REAL, settled_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_usl_ts ON us_lane_events(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_usl_open ON us_lane_events(final, settle, ts)`,
];

export const US_LANE_KEYS = { PREV: 'xv_prev' };
export const HORIZONS = { m1: 60, m5: 300, m15: 900, m60: 3600 };
export const MARK_TOLERANCE_S = 90;            // nearest sample within +-90s of the horizon
export const FINAL_AFTER_S = 4.5 * 3600;       // = XV_LIVE_AFTER_MS: the game is over once the sampler's live window has passed
export const NO_DATA = -1;                     // sentinel: horizon passed with no sample / market voided
export const SETTLE_AFTER_S = 3 * 3600;        // first Gamma look 3h after the event
export const SETTLE_GIVE_UP_S = 10 * 86400;    // unresolved after 10 days -> NO_DATA
export const SETTLE_TOKENS_PER_RUN = 15;
export const MARK_EVENTS_PER_RUN = 120;

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const mid = (b, a) => (b != null && a != null ? (b + a) / 2 : null);

// Pure: did this minute's sample leave a crossable Polymarket US quote after
// a global Polymarket move? `prev` / `row` are the same leg one minute apart
// with p_bid/p_ask (global) and us_bid/us_ask(/qty) (Polymarket US).
//   up-move:   global bid above the US ask + fee  -> buy on US at the ask
//   down-move: US bid above the global ask + fee  -> sell on US at the bid (buy its short side)
export function detectUsLaneEvent(prev, row, { moveC = 3, usRate = US_TAKER_RATE, maxGapS = 180 } = {}) {
  if (!prev || !row || !(row.ts - prev.ts <= maxGapS) || row.ts <= prev.ts) return null;
  const pm = mid(row.p_bid, row.p_ask), ppm = mid(prev.p_bid, prev.p_ask);
  if (pm == null || ppm == null || row.us_bid == null || row.us_ask == null) return null;
  const dP = (pm - ppm) * 100;
  if (Math.abs(dP) < moveC) return null;
  const base = { ts: row.ts, sport: row.sport, game: row.game, team: row.team, pToken: row.p_token || null, usSlug: row.us_slug || null, pBid: row.p_bid, pAsk: row.p_ask, pMid: r4(pm), dpC: r2(dP) };
  if (dP > 0) {
    const fee = usFee(row.us_ask, usRate), edge = row.p_bid - row.us_ask - fee;
    if (edge <= 0) return null;
    return { ...base, side: 'buy', px: row.us_ask, qty: row.us_ask_qty ?? null, fee: r4(fee), edgeC: r2(edge * 100) };
  }
  const fee = usFee(row.us_bid, usRate), edge = row.us_bid - row.p_ask - fee;
  if (edge <= 0) return null;
  return { ...base, side: 'sell', px: row.us_bid, qty: row.us_bid_qty ?? null, fee: r4(fee), edgeC: r2(edge * 100) };
}

// Pure: cents per share at a mark (global mid, or 0/1 at settlement), after
// the entry fee. Exit costs (a second fee and the US spread) are NOT charged:
// the question is whether the US quote was wrong, not what a round trip costs.
export function pnlC(ev, mark) {
  if (mark == null || mark < 0) return null;
  const gross = ev.side === 'buy' ? mark - ev.px : ev.px - mark;
  return r2((gross - ev.fee) * 100);
}

// Pure: fill the marks of one event from the leg's later samples
// ([{ts, p_bid, p_ask}] sorted by ts). A horizon gets the nearest sample within
// MARK_TOLERANCE_S once the horizon (+ one minute of slack) has passed, or
// NO_DATA if the samples are too sparse there. `final` is the last sample's
// mid once the live window has closed (NO_DATA when none exist).
export function marksFromSeries(ev, rows, nowS) {
  const out = {};
  const usable = (rows || []).filter(r => r.ts > ev.ts && r.p_bid != null && r.p_ask != null);
  for (const [k, h] of Object.entries(HORIZONS)) {
    if (ev[k] != null) continue;
    if (nowS < ev.ts + h + 60) continue;
    let best = null;
    for (const r of usable) { const d = Math.abs(r.ts - (ev.ts + h)); if (d <= MARK_TOLERANCE_S && (!best || d < best.d)) best = { d, m: mid(r.p_bid, r.p_ask) }; }
    out[k] = best ? r4(best.m) : (nowS >= ev.ts + h + 600 ? NO_DATA : undefined);
    if (out[k] === undefined) delete out[k];
  }
  if (ev.final == null && nowS >= ev.ts + FINAL_AFTER_S) {
    const last = usable.length ? usable[usable.length - 1] : null;
    out.final = last ? r4(mid(last.p_bid, last.p_ask)) : NO_DATA;
  }
  return out;
}

// Pure: settlement price of `token` from a Gamma market row (closed markets
// carry outcomePrices of "1"/"0"). null = not resolved yet; NO_DATA = closed
// without a clean winner (void / 50-50).
export function settlementFromGamma(market, token) {
  if (!market) return null;
  const parse = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v || '[]'); } catch { return []; } };
  const toks = parse(market.clobTokenIds), prices = parse(market.outcomePrices).map(Number);
  const idx = toks.indexOf(token);
  if (idx < 0) return null;
  const closed = market.closed === true || market.umaResolutionStatus === 'resolved';
  if (!closed) return null;
  const p = prices[idx];
  if (p === 1 || p === 0) return p;
  if (p > 0.99) return 1;
  if (p < 0.01) return 0;
  return NO_DATA;
}

// Pure: aggregate events (with marks) into the report shape.
export const TRADABLE_QTY = 50;   // shares shown at the stale price for an event to count as fillable
const mkMarks = () => Object.fromEntries([...Object.keys(HORIZONS), 'final', 'settle'].map(k => [k, { n: 0, sumC: 0, hits: 0, noData: 0, usdSum: 0 }]));
export function summarizeUsLane(events, { tradableQty = TRADABLE_QTY } = {}) {
  const mk = () => ({ n: 0, buy: 0, sell: 0, edgeSumC: 0, qtySum: 0, qtyN: 0, qtys: [], pxSum: 0, marks: mkMarks(), tradable: { n: 0, pxSum: 0, marks: mkMarks() } });
  const all = mk(), bySport = {};
  const addMarks = (marks, ev, usd) => {
    for (const k of Object.keys(marks)) {
      const m = ev[k]; if (m == null) continue;
      if (m < 0) { marks[k].noData++; continue; }
      const p = pnlC({ side: ev.side, px: ev.px, fee: ev.fee }, m);
      marks[k].n++; marks[k].sumC += p; if (p > 0) marks[k].hits++;
      if (usd) marks[k].usdSum += p / 100 * Math.min(ev.qty, 1000);   // dollars on the shown size, capped at 1000 shares
    }
  };
  const add = (s, ev) => {
    s.n++; s[ev.side]++; s.edgeSumC += ev.edge_c || 0; s.pxSum += ev.px;
    if (ev.qty != null) { s.qtySum += ev.qty; s.qtyN++; s.qtys.push(ev.qty); }
    addMarks(s.marks, ev, false);
    if (ev.qty != null && ev.qty >= tradableQty) { s.tradable.n++; s.tradable.pxSum += ev.px; addMarks(s.tradable.marks, ev, true); }
  };
  for (const ev of events || []) { add(all, ev); add(bySport[ev.sport] || (bySport[ev.sport] = mk()), ev); }
  const finishMarks = (marks, avgPx, usd) => Object.fromEntries(Object.entries(marks).map(([k, m]) => [k, { n: m.n, avgC: m.n ? r2(m.sumC / m.n) : null, hitRate: m.n ? r2(m.hits / m.n) : null, noData: m.noData, roiPct: m.n && avgPx ? r2((m.sumC / m.n) / (avgPx * 100) * 100) : null, ...(usd ? { usd: r2(m.usdSum) } : {}) }]));
  const finish = (s) => {
    const o = { n: s.n, buy: s.buy, sell: s.sell, avgEdgeC: s.n ? r2(s.edgeSumC / s.n) : null, avgPx: s.n ? r4(s.pxSum / s.n) : null, avgQty: s.qtyN ? Math.round(s.qtySum / s.qtyN) : null, medQty: null };
    if (s.qtys.length) { const q = [...s.qtys].sort((a, b) => a - b); o.medQty = Math.round(q[Math.floor(q.length / 2)]); }
    o.marks = finishMarks(s.marks, o.avgPx, false);
    const tp = s.tradable.n ? s.tradable.pxSum / s.tradable.n : null;
    o.tradable = { minQty: tradableQty, n: s.tradable.n, share: s.n ? r2(s.tradable.n / s.n) : null, marks: finishMarks(s.tradable.marks, tp, true) };
    return o;
  };
  const out = { all: finish(all), bySport: {} };
  for (const [k, v] of Object.entries(bySport)) out.bySport[k] = finish(v);
  return out;
}

// Sampler hook: compare this minute's sampled legs with the previous minute
// (KV `xv_prev`), insert any qualifying events, roll the prev blob forward.
// `legs` = [{ts, sport, game, team, p_token, us_slug, p_bid, p_ask, us_bid, us_ask, us_bid_qty, us_ask_qty}].
// Only the leg the US instrument actually quotes (`us_long`) is examined: the
// other leg's US bid/ask are that quote's complements, so an up-move there is
// the same trade seen from the other side and would double-count every event.
export async function recordUsLaneEvents(env, legs, nowMs = Date.now(), opts = {}) {
  let prev = null; try { prev = await env.SIGNALS_CACHE.get(US_LANE_KEYS.PREV, { type: 'json' }); } catch (e) {}
  const prevMap = (prev && prev.legs) || {};
  const key = (l) => `${l.sport}|${l.game}|${l.team}`;
  const events = []; const next = {};
  for (const l of legs || []) {
    if (!l.us_long) continue;
    next[key(l)] = { ts: l.ts, p_bid: l.p_bid, p_ask: l.p_ask, us_bid: l.us_bid, us_ask: l.us_ask, us_bid_qty: l.us_bid_qty ?? null, us_ask_qty: l.us_ask_qty ?? null };
    const ev = detectUsLaneEvent(prevMap[key(l)], l, opts);
    if (ev) events.push(ev);
  }
  try { await env.SIGNALS_CACHE.put(US_LANE_KEYS.PREV, JSON.stringify({ at: nowMs, legs: next }), { expirationTtl: 3600 }); } catch (e) {}
  if (events.length && env.DB) {
    const stmts = events.map(ev => env.DB.prepare(`INSERT INTO us_lane_events (ts, sport, game, team, p_token, us_slug, side, px, qty, fee, p_bid, p_ask, p_mid, dp_c, edge_c) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(ev.ts, ev.sport, ev.game, ev.team, ev.pToken, ev.usSlug, ev.side, ev.px, ev.qty, ev.fee, ev.pBid, ev.pAsk, ev.pMid, ev.dpC, ev.edgeC));
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  }
  return { events: events.length, compared: Object.keys(prevMap).length };
}

// Pure: when is this event next worth re-reading? The earliest unfilled
// horizon (+60s slack), else the end of the live window for `final`.
export function nextDueS(ev) {
  for (const [k, h] of Object.entries(HORIZONS)) if (ev[k] == null) return ev.ts + h + 60;
  return ev.ts + FINAL_AFTER_S;
}

// Minute cron: fill marks for events whose horizons have passed, from the
// leg's later rows in xvenue_quotes. D1 only.
export async function markUsLaneEvents(env, nowMs = Date.now()) {
  if (!env.DB) return { marked: 0 };
  const nowS = Math.floor(nowMs / 1000);
  const due = await env.DB.prepare(`SELECT id, ts, game, team, side, px, fee, m1, m5, m15, m60, final FROM us_lane_events WHERE final IS NULL AND ts <= ? AND (marked_at IS NULL OR marked_at <= ?) ORDER BY ts LIMIT ?`).bind(nowS - 120, nowS - 120, MARK_EVENTS_PER_RUN).all();
  const events = (due && due.results) || [];
  let marked = 0; const stmts = [];
  for (const ev of events) {
    const q = await env.DB.prepare(`SELECT ts, p_bid, p_ask FROM xvenue_quotes WHERE game = ? AND team = ? AND ts > ? AND ts <= ? AND p_bid IS NOT NULL ORDER BY ts LIMIT 400`).bind(ev.game, ev.team, ev.ts, ev.ts + FINAL_AFTER_S + 600).all();
    const m = marksFromSeries(ev, (q && q.results) || [], nowS);
    const cols = Object.keys(m);
    // marked_at doubles as "not before": the row is re-read when its next unfilled horizon is due, not every two minutes
    const dueS = nextDueS({ ...ev, ...m });
    const notBefore = Math.max(nowS, dueS - 120);
    if (!cols.length) { stmts.push(env.DB.prepare(`UPDATE us_lane_events SET marked_at = ? WHERE id = ?`).bind(notBefore, ev.id)); continue; }
    stmts.push(env.DB.prepare(`UPDATE us_lane_events SET ${cols.map(c => `${c} = ?`).join(', ')}, marked_at = ? WHERE id = ?`).bind(...cols.map(c => m[c]), notBefore, ev.id));
    marked++;
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { due: events.length, marked };
}

// 5-minute cron: settle events through Gamma (one call per distinct token,
// capped per run). Events on the same token settle together.
export async function settleUsLaneEvents(env, nowMs = Date.now(), fetchImpl = fetch) {
  if (!env.DB) return { settled: 0 };
  const nowS = Math.floor(nowMs / 1000);
  const q = await env.DB.prepare(`SELECT p_token, MIN(ts) AS first_ts FROM us_lane_events WHERE settle IS NULL AND p_token IS NOT NULL AND ts <= ? GROUP BY p_token ORDER BY first_ts LIMIT ?`).bind(nowS - SETTLE_AFTER_S, SETTLE_TOKENS_PER_RUN).all();
  const toks = (q && q.results) || [];
  let settled = 0, voided = 0, pending = 0, errors = 0;
  for (const t of toks) {
    try {
      let price = null;
      if (nowS - t.first_ts > SETTLE_GIVE_UP_S) price = NO_DATA;
      else {
        const res = await fetchImpl(`${GAMMA_API}/markets?clob_token_ids=${encodeURIComponent(t.p_token)}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) { errors++; continue; }
        const ms = await res.json();
        price = settlementFromGamma(Array.isArray(ms) ? ms[0] : null, t.p_token);
      }
      if (price == null) { pending++; continue; }
      await env.DB.prepare(`UPDATE us_lane_events SET settle = ?, settled_at = ? WHERE p_token = ? AND settle IS NULL`).bind(price, nowS, t.p_token).run();
      if (price < 0) voided++; else settled++;
    } catch (e) { errors++; }
  }
  return { tokens: toks.length, settled, voided, pending, errors };
}

export async function usLaneReport(env, { hours = 168, recent = 20, nowMs = Date.now() } = {}) {
  const since = Math.floor(nowMs / 1000) - hours * 3600;
  const q = await env.DB.prepare(`SELECT id, ts, sport, game, team, side, px, qty, fee, p_bid, p_ask, p_mid, dp_c, edge_c, m1, m5, m15, m60, final, settle FROM us_lane_events WHERE ts >= ? ORDER BY ts LIMIT 20000`).bind(since).all();
  const rows = (q && q.results) || [];
  const sum = summarizeUsLane(rows);
  const legs = new Set(rows.map(r => `${r.sport}|${r.game}|${r.team}`)).size;
  const games = new Set(rows.map(r => `${r.sport}|${r.game}`)).size;
  const rec = rows.slice(-recent).reverse().map(r => ({ at: new Date(r.ts * 1000).toISOString(), sport: r.sport, game: r.game, team: r.team, side: r.side, px: r.px, qty: r.qty, dpC: r.dp_c, edgeC: r.edge_c, m5C: pnlC(r, r.m5), m15C: pnlC(r, r.m15), finalC: pnlC(r, r.final), settleC: pnlC(r, r.settle) }));
  let prev = null; try { prev = await env.SIGNALS_CACHE.get(US_LANE_KEYS.PREV, { type: 'json' }); } catch (e) {}
  return {
    success: true, hours, events: rows.length, legs, games, ...sum, recent: rec, prevAt: prev && prev.at ? new Date(prev.at).toISOString() : null,
    read: `Paper only: each event is a hypothetical taker fill on Polymarket US at the sampled quote (px, qty = shares shown at that price; one event per game minute, on the leg the US instrument quotes). tradable = the subset with at least ${TRADABLE_QTY} shares shown (usd = dollars on the shown size, capped at 1000 shares) in a minute where global Polymarket's mid moved >= 3c and the US quote was still crossable after the ${US_TAKER_RATE * 100}% x p(1-p) taker fee (edgeC = cents of edge at entry). marks.* = cents per share after the entry fee, marked at global Polymarket's mid 1/5/15/60 minutes later and at the end of the game (final), and at settlement (0/1). Exit fees and the US spread are not charged. roiPct = avg mark pnl / avg entry price. noData = horizon passed with no sample. Decision rule (docs/PROFIT-AVENUES.md Part 2): after ~200 events, if m15 and settle are both positive after fees with a hit rate above 50% and the shown size is tradable, a Polymarket US lane is worth building; the real-money flip stays the operator's call.`,
  };
}

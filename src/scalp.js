// ============================================================
// SCALP.JS — the Polymarket US stale-quote scalp lane
// ============================================================
//
// Owner, Oct 31 2026: "build the US scalp lane". The paper US lane
// (src/us-lane.js) has logged, since Oct 17, every live-game minute where
// global Polymarket's mid moved 3c+ and the Polymarket US quote had not
// followed yet and was still crossable after its taker fee. On 571 tradable
// events in the week to Oct 31 the round trip closed on the US book five
// minutes later made +1.6c a share after both fees, right 58% of the time.
// This lane acts on those same minutes: in the sampler's minute, it buys the
// stale US quote (or sells it, by buying the short side) for a small size,
// and closes on the US book `scalpHoldMin` minutes later as a taker.
//
// Modes (config.scalpMode, Auto-trader Config): 'off'; 'dry' (default) =
// every decision is made and recorded at the sampled quotes, nothing is
// sent; 'live' = orders go to Polymarket US (FOK entry, close-position exit)
// with the account key, only when the key is on the worker. The flip to live
// is the owner's. Independent of paperTradeMode: the whale bot can stay
// paper while this lane runs live, or the other way round.
//
// Risk: size per scalp (scalpMaxUsd), open scalps (scalpMaxOpen), scalps per
// day (scalpMaxPerDay), a daily loss stop (scalpDailyLossUsd), one scalp per
// game at a time, and a kill switch (POST /xvenue/scalp/halt; the lane also
// halts itself on an ambiguous send or a failed exit it cannot reconcile).
import { usFee, US_TAKER_RATE } from './xvenue.js';
import { rtPnlC, TRADABLE_QTY } from './us-lane.js';
import { pmusConfigured, fetchUsMarket, buildUsOrder, placeUsOrder, closeUsPosition, usPositionQty, fillFromExecutions, fillFromOrder, getUsOrder, PmusError } from './polymarket-us.js';

export const SCALP_KEYS = { OPEN: 'scalp_open', HALT: 'scalp_halt', LAST: 'scalp_last', DAY: 'scalp_day:', RECENT: 'scalp_recent' };
export const SCALP_DEFAULTS = {
  scalpMode: 'dry',          // off | dry | live
  scalpMaxUsd: 10,           // dollars per scalp at the entry price
  scalpMaxOpen: 3,           // scalps open at once
  scalpMaxPerDay: 40,
  scalpDailyLossUsd: 15,     // the day stops at this realized loss
  scalpHoldMin: 5,           // close on the US book this many minutes after entry (the x5 mark)
  scalpMinEdgeC: 1,          // cents of edge after the entry fee at detection (the lane's own floor; the sampler needs > 0)
  scalpMinQty: TRADABLE_QTY, // shares shown at the stale quote
  scalpExitGraceMin: 10,     // dry: minutes to wait for a US quote after the hold before closing at the last one seen
  scalpSports: null,         // null = every sport the sampler covers, else ['nba','nhl',...]
};
export const SCALP_LIMITS = { scalpMaxUsd: [1, 200], scalpMaxOpen: [1, 20], scalpMaxPerDay: [1, 500], scalpDailyLossUsd: [1, 1000], scalpHoldMin: [1, 60], scalpMinEdgeC: [0, 20], scalpMinQty: [1, 100000], scalpExitGraceMin: [1, 60] };
export const SCALP_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS scalp_trades (
    id TEXT PRIMARY KEY, mode TEXT, ts_entry INTEGER, ts_exit INTEGER, sport TEXT, game TEXT, team TEXT, us_slug TEXT, side TEXT,
    entry_px REAL, exit_px REAL, shares REAL, usd REAL, fee_entry_usd REAL, fee_exit_usd REAL, pnl_c REAL, pnl_usd REAL,
    edge_c REAL, dp_c REAL, shown_qty REAL, hold_s INTEGER, exit_kind TEXT, live INTEGER, order_id TEXT, exit_order_id TEXT, note TEXT
  )`,                                                                    // migrations/0012_scalp_trades.sql
  `CREATE INDEX IF NOT EXISTS idx_scalp_trades_ts ON scalp_trades(ts_entry)`,
];
const MAX_EXIT_TRIES = 3;
const RECENT_KEEP = 60;
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

async function kvJson(env, key, fallback) { try { const v = await env.SIGNALS_CACHE.get(key, { type: 'json' }); return v == null ? fallback : v; } catch (e) { return fallback; } }
async function kvPut(env, key, value, ttlSec) { await env.SIGNALS_CACHE.put(key, JSON.stringify(value), ttlSec ? { expirationTtl: ttlSec } : undefined); }

// The lane's settings out of the auto-trader config (defaults filled in).
export function scalpConfig(config = {}) {
  const out = { ...SCALP_DEFAULTS };
  for (const k of Object.keys(SCALP_DEFAULTS)) if (config[k] !== undefined && config[k] !== null) out[k] = config[k];
  return out;
}
// Pure: the scalp* keys of a config update, checked and clamped; unknown keys dropped.
export function sanitizeScalpUpdates(updates = {}) {
  const out = {};
  for (const [k, v] of Object.entries(updates || {})) {
    if (!(k in SCALP_DEFAULTS)) continue;
    if (k === 'scalpMode') { if (['off', 'dry', 'live'].includes(v)) out[k] = v; continue; }
    if (k === 'scalpSports') { out[k] = Array.isArray(v) && v.length ? v.map(s => String(s).toLowerCase()) : null; continue; }
    const n = Number(v); if (!Number.isFinite(n)) continue;
    const [lo, hi] = SCALP_LIMITS[k]; out[k] = Math.min(hi, Math.max(lo, n));
  }
  return out;
}
// What the lane actually runs as: live needs the venue key on the worker.
export function scalpModeFor(env, cfg) {
  if (cfg.scalpMode === 'off') return { mode: 'off', liveAsked: false, liveBlocked: null };
  if (cfg.scalpMode === 'live') return pmusConfigured(env) ? { mode: 'live', liveAsked: true, liveBlocked: null } : { mode: 'dry', liveAsked: true, liveBlocked: 'PMUS_KEY_ID / PMUS_SECRET_KEY are not on the worker (push-polymarket-us-key.yml); running dry' };
  return { mode: 'dry', liveAsked: false, liveBlocked: null };
}

// ---------- pure decisions ----------
// Entry for one sampler event (us-lane.js detectUsLaneEvent shape: side buy|sell,
// px = the US quote in long terms, qty shown, fee per share, edgeC, usSlug).
export function scalpEntryFor(ev, { cfg, open = [], day = {}, nowMs = Date.now(), minQtyVenue = 1 } = {}) {
  if (!ev || !ev.usSlug) return { ok: false, reason: 'no Polymarket US market' };
  if (Array.isArray(cfg.scalpSports) && cfg.scalpSports.length && !cfg.scalpSports.includes(String(ev.sport).toLowerCase())) return { ok: false, reason: 'sport not in the lane' };
  if (!(ev.edgeC >= cfg.scalpMinEdgeC)) return { ok: false, reason: `edge under ${cfg.scalpMinEdgeC}c` };
  if (ev.qty == null || ev.qty < cfg.scalpMinQty) return { ok: false, reason: `under ${cfg.scalpMinQty} shares shown` };
  if (!(ev.px > 0.05 && ev.px < 0.95)) return { ok: false, reason: 'price outside 5-95c' };
  if (open.length >= cfg.scalpMaxOpen) return { ok: false, reason: 'max open scalps' };
  if (open.some(p => p.sport === ev.sport && p.game === ev.game)) return { ok: false, reason: 'already in this game' };
  if ((day.entries || 0) >= cfg.scalpMaxPerDay) return { ok: false, reason: 'daily scalp cap' };
  if ((day.pnlUsd || 0) <= -Math.abs(cfg.scalpDailyLossUsd)) return { ok: false, reason: 'daily loss stop' };
  const cost = ev.side === 'buy' ? ev.px : 1 - ev.px;           // what one contract costs us (long at the ask; short at 1 - bid)
  const step = Number(minQtyVenue) > 0 ? Number(minQtyVenue) : 1;
  const shares = Math.floor(Math.min(ev.qty, cfg.scalpMaxUsd / cost) / step) * step;
  if (!(shares >= step)) return { ok: false, reason: 'size below one contract' };
  return { ok: true, shares, cost: r4(cost), usd: r2(shares * cost), side: ev.side === 'buy' ? 'long' : 'short', feeEntryUsd: r2(usFee(ev.px) * shares) };
}
// The US quote the scalp closes against this minute (long terms): a buy sells at the bid, a sell buys back at the ask.
export function scalpExitPrice(pos, leg) {
  if (!leg) return null;
  const px = pos.side === 'buy' ? leg.us_bid : leg.us_ask;
  return px != null && px > 0 && px < 1 ? px : null;
}
// Per-share and dollar P&L of the round trip, both taker fees charged (us-lane.js rtPnlC).
export function scalpPnl(pos, exitPx) {
  const pnlC = rtPnlC({ side: pos.side, px: pos.px, fee: usFee(pos.px) }, exitPx);
  if (pnlC == null) return null;
  return { pnlC, pnlUsd: r2(pnlC / 100 * pos.shares), feeExitUsd: r2(usFee(exitPx) * pos.shares) };
}
export const legKey = (l) => `${l.sport}|${l.game}|${l.team}`;

async function recordTrade(env, row) {
  if (env.DB) {
    try {
      await env.DB.prepare(`INSERT OR REPLACE INTO scalp_trades (id, mode, ts_entry, ts_exit, sport, game, team, us_slug, side, entry_px, exit_px, shares, usd, fee_entry_usd, fee_exit_usd, pnl_c, pnl_usd, edge_c, dp_c, shown_qty, hold_s, exit_kind, live, order_id, exit_order_id, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(row.id, row.mode, row.tsEntry, row.tsExit, row.sport, row.game, row.team, row.usSlug, row.side, row.entryPx, row.exitPx, row.shares, row.usd, row.feeEntryUsd, row.feeExitUsd, row.pnlC, row.pnlUsd, row.edgeC, row.dpC, row.shownQty, row.holdS, row.exitKind, row.live ? 1 : 0, row.orderId || null, row.exitOrderId || null, row.note || null).run();
    } catch (e) { row.note = `${row.note || ''} (d1: ${String(e.message).slice(0, 60)})`.trim(); }
  }
  const recent = await kvJson(env, SCALP_KEYS.RECENT, []);
  recent.push(row);
  await kvPut(env, SCALP_KEYS.RECENT, recent.slice(-RECENT_KEEP), 30 * 24 * 3600);
}

// ---------- live venue calls (Polymarket US), each confirmed or reconciled ----------
async function liveEnter(env, ev, dec, { fetchImpl, nowMs }) {
  const market = await fetchUsMarket(env, ev.usSlug, { fetchImpl, nowMs });
  if (market.status && market.status !== 'MARKET_STATUS_OPEN') return { ok: false, reason: `US market ${market.status}` };
  const shares = Math.floor(dec.shares / (market.minQty || 1)) * (market.minQty || 1);
  if (!(shares > 0)) return { ok: false, reason: 'size below the venue minimum' };
  const order = buildUsOrder({ slug: ev.usSlug, action: 'BUY', side: dec.side, effectivePrice: dec.cost, tick: market.tick, quantity: shares, minQty: market.minQty });
  let before = null; try { before = await usPositionQty(env, ev.usSlug, { fetchImpl }); } catch (e) { before = null; }
  let res;
  try { res = await placeUsOrder(env, order, { fetchImpl }); }
  catch (e) {
    if (e instanceof PmusError && e.status >= 400 && e.status < 500) return { ok: false, reason: `venue rejected: ${String(e.message).slice(0, 80)}` };
    let after = null; try { after = await usPositionQty(env, ev.usSlug, { fetchImpl }); } catch (e2) { after = null; }
    if (before != null && after != null && after !== before) return { ok: true, fill: { shares: Math.abs(after - before), effectivePx: dec.cost, feeUsd: r2(usFee(ev.px) * Math.abs(after - before)) }, orderId: 'reconciled', note: `placement error (${String(e.message).slice(0, 60)}); position moved ${before} -> ${after}` };
    return { ok: false, halt: true, reason: `ambiguous placement: ${String(e.message).slice(0, 80)}` };
  }
  let fill = fillFromExecutions(res && res.executions, dec.side);
  if (!fill && res && res.id) {
    try { const o = await getUsOrder(env, res.id, { fetchImpl }); const f = fillFromOrder(o, dec.side); if (f && f.shares > 0) fill = f; else return { ok: false, reason: `order ${res.id} ${f && f.state ? f.state : 'unfilled'} (FOK)` }; }
    catch (e) { return { ok: false, halt: true, reason: `order ${res.id} sent, state unknown` }; }
  }
  if (!fill) return { ok: false, reason: 'no executions returned' };
  return { ok: true, fill, orderId: res && res.id ? res.id : null };
}
async function liveExit(env, pos, { fetchImpl }) {
  try {
    const res = await closeUsPosition(env, pos.usSlug, { fetchImpl });
    const fill = fillFromExecutions(res && res.executions, pos.side === 'buy' ? 'long' : 'short');
    if (fill) return { ok: true, fill, orderId: res && res.id ? res.id : null };
    let qty = null; try { qty = await usPositionQty(env, pos.usSlug, { fetchImpl }); } catch (e) { qty = null; }
    if (qty === 0) return { ok: true, fill: null, orderId: res && res.id ? res.id : null, note: 'closed, fill not reported' };
    return { ok: false, reason: 'close sent, position still open' };
  } catch (e) {
    if (e instanceof PmusError && e.status >= 400 && e.status < 500) {
      let qty = null; try { qty = await usPositionQty(env, pos.usSlug, { fetchImpl }); } catch (e2) { qty = null; }
      if (qty === 0) return { ok: true, fill: null, orderId: null, note: `venue: ${String(e.message).slice(0, 60)}; nothing left to close` };
      return { ok: false, settling: /closed|resolved|not open|halted/i.test(String(e.message)), reason: `venue rejected close: ${String(e.message).slice(0, 80)}` };
    }
    return { ok: false, reason: `close error: ${String(e.message).slice(0, 80)}` };
  }
}

// ---------- the minute pass ----------
// `events` = this minute's stale-quote events (recordUsLaneEvents), `legs` =
// every live leg the sampler quoted this minute (for exits and marks).
export async function runScalpLane(env, { events = [], legs = [], nowMs = Date.now(), config = {}, fetchImpl = fetch } = {}) {
  const cfg = scalpConfig(config);
  const { mode, liveAsked, liveBlocked } = scalpModeFor(env, cfg);
  const nowIso = new Date(nowMs).toISOString();
  const last = { at: nowIso, mode, liveAsked, liveBlocked, entries: 0, exits: 0, open: 0, skipped: {}, events: events.length };
  if (mode === 'off') { await kvPut(env, SCALP_KEYS.LAST, last, 86400); return last; }
  const halt = await kvJson(env, SCALP_KEYS.HALT, { halted: false });
  let halted = !!(halt && halt.halted);
  const open = await kvJson(env, SCALP_KEYS.OPEN, []);
  const dayKey = SCALP_KEYS.DAY + dayOf(nowMs);
  const day = await kvJson(env, dayKey, { date: dayOf(nowMs), entries: 0, exits: 0, wins: 0, pnlUsd: 0, feesUsd: 0 });
  const legMap = new Map((legs || []).map(l => [legKey(l), l]));
  const skip = (why) => { last.skipped[why] = (last.skipped[why] || 0) + 1; };
  const setHalt = async (why) => { halted = true; await kvPut(env, SCALP_KEYS.HALT, { halted: true, at: nowIso, why }); last.haltedWhy = why; };

  // 1. exits (and marks) on the open scalps
  const still = [];
  for (const pos of open) {
    const leg = legMap.get(legKey(pos));
    if (leg) { pos.lastBid = leg.us_bid ?? pos.lastBid; pos.lastAsk = leg.us_ask ?? pos.lastAsk; pos.lastQuoteAt = nowIso; const mx = scalpExitPrice(pos, leg); const m = mx != null ? scalpPnl(pos, mx) : null; pos.markC = m ? m.pnlC : pos.markC; pos.markUsd = m ? m.pnlUsd : pos.markUsd; }
    if (nowMs < pos.exitAtMs) { still.push(pos); continue; }
    const close = async (exitPx, exitKind, extra = {}) => {
      const p = exitPx != null ? scalpPnl(pos, exitPx) : null;
      const row = {
        id: pos.id, mode: pos.live ? 'live' : 'dry', tsEntry: Math.floor(pos.entryMs / 1000), tsExit: Math.floor(nowMs / 1000), sport: pos.sport, game: pos.game, team: pos.team, usSlug: pos.usSlug, side: pos.side,
        entryPx: pos.px, exitPx: exitPx ?? null, shares: pos.shares, usd: pos.usd, feeEntryUsd: pos.feeEntryUsd, feeExitUsd: p ? p.feeExitUsd : null, pnlC: p ? p.pnlC : null, pnlUsd: p ? p.pnlUsd : null,
        edgeC: pos.edgeC, dpC: pos.dpC, shownQty: pos.shownQty, holdS: Math.round((nowMs - pos.entryMs) / 1000), exitKind, live: !!pos.live, orderId: pos.orderId || null, ...extra,
        entryAt: new Date(pos.entryMs).toISOString(), exitAt: nowIso,
      };
      await recordTrade(env, row);
      day.exits++; if (p) { day.pnlUsd = r2(day.pnlUsd + p.pnlUsd); day.feesUsd = r2(day.feesUsd + pos.feeEntryUsd + p.feeExitUsd); if (p.pnlUsd > 0) day.wins++; }
      last.exits++;
    };
    if (pos.live) {
      if (halted) { still.push(pos); continue; }   // a halted lane still holds; the owner closes by hand or un-halts
      const r = await liveExit(env, pos, { fetchImpl });
      if (r.ok) {
        const exitPx = r.fill ? (pos.side === 'buy' ? r.fill.effectivePx : r4(1 - r.fill.effectivePx)) : null;
        await close(exitPx, r.fill ? 'x_live' : 'x_live_unpriced', { exitOrderId: r.orderId, note: r.note || null, feeExitUsd: r.fill ? r.fill.feeUsd : null });
        continue;
      }
      pos.exitTries = (pos.exitTries || 0) + 1;
      if (r.settling) { await close(null, 'settling', { note: r.reason }); continue; }   // the venue will settle it; P&L lands in the balance
      if (pos.exitTries >= MAX_EXIT_TRIES) { await setHalt(`exit of ${pos.usSlug} failed ${pos.exitTries} times: ${r.reason}`); }
      pos.lastExitError = r.reason;
      still.push(pos);
      continue;
    }
    // dry: close at this minute's quote; else wait up to the grace period for one; else the last quote seen
    const exitPx = scalpExitPrice(pos, leg);
    if (exitPx != null) { await close(exitPx, 'x5'); continue; }
    if (nowMs - pos.exitAtMs < cfg.scalpExitGraceMin * 60e3) { still.push(pos); continue; }
    const lastPx = pos.side === 'buy' ? pos.lastBid : pos.lastAsk;
    await close(lastPx != null && lastPx > 0 && lastPx < 1 ? lastPx : null, lastPx != null ? 'late_last_quote' : 'no_quote', { note: 'no US quote at the hold; closed at the last quote seen' });
  }

  // 2. entries on this minute's events, biggest edge first
  const sorted = [...(events || [])].sort((a, b) => (b.edgeC || 0) - (a.edgeC || 0));
  for (const ev of sorted) {
    if (halted) { skip('lane halted'); continue; }
    const dec = scalpEntryFor(ev, { cfg, open: still, day, nowMs });
    if (!dec.ok) { skip(dec.reason); continue; }
    let pos = {
      id: `sc_${nowMs}_${Math.random().toString(36).slice(2, 7)}`, sport: ev.sport, game: ev.game, team: ev.team, usSlug: ev.usSlug, pToken: ev.pToken || null,
      side: ev.side, px: ev.px, shares: dec.shares, usd: dec.usd, feeEntryUsd: dec.feeEntryUsd, edgeC: ev.edgeC, dpC: ev.dpC, pMid: ev.pMid, shownQty: ev.qty,
      entryMs: nowMs, entryAt: nowIso, exitAtMs: nowMs + cfg.scalpHoldMin * 60e3, live: false, orderId: null, lastBid: null, lastAsk: null,
    };
    if (mode === 'live') {
      const r = await liveEnter(env, ev, dec, { fetchImpl, nowMs });
      if (!r.ok) { skip(r.reason); if (r.halt) await setHalt(r.reason); continue; }
      const px = dec.side === 'long' ? r.fill.effectivePx : r4(1 - r.fill.effectivePx);   // back to long terms
      pos = { ...pos, live: true, orderId: r.orderId, px, shares: r.fill.shares, usd: r2(r.fill.shares * (dec.side === 'long' ? px : 1 - px)), feeEntryUsd: r.fill.feeUsd ?? dec.feeEntryUsd, note: r.note || null };
    }
    still.push(pos);
    day.entries++;
    last.entries++;
  }

  await kvPut(env, SCALP_KEYS.OPEN, still, 7 * 86400);
  await kvPut(env, dayKey, day, 3 * 86400);
  last.open = still.length; last.halted = halted; last.day = day;
  await kvPut(env, SCALP_KEYS.LAST, last, 86400);
  return last;
}

export async function setScalpHalt(env, on, why = 'operator') {
  const v = { halted: !!on, at: new Date().toISOString(), why: on ? why : null };
  await kvPut(env, SCALP_KEYS.HALT, v);
  return v;
}

// ---------- the report (GET /xvenue/scalp, snapshot key `scalp`) ----------
export function summarizeScalps(rows) {
  const mk = () => ({ n: 0, priced: 0, wins: 0, pnlUsd: 0, feesUsd: 0, pnlCSum: 0, usd: 0 });
  const all = mk(), bySport = {}, byKind = {}, byMode = {};
  for (const r of rows || []) {
    const add = (s) => {
      s.n++; s.usd = r2(s.usd + (r.usd || 0));
      if (r.pnlUsd != null) { s.priced++; s.pnlUsd = r2(s.pnlUsd + r.pnlUsd); s.pnlCSum += r.pnlC || 0; s.feesUsd = r2(s.feesUsd + (r.feeEntryUsd || 0) + (r.feeExitUsd || 0)); if (r.pnlUsd > 0) s.wins++; }
    };
    add(all); add(bySport[r.sport] || (bySport[r.sport] = mk())); add(byKind[r.exitKind] || (byKind[r.exitKind] = mk())); add(byMode[r.mode] || (byMode[r.mode] = mk()));
  }
  const fin = (s) => ({ n: s.n, priced: s.priced, wins: s.wins, hitRate: s.priced ? r2(s.wins / s.priced) : null, pnlUsd: s.pnlUsd, feesUsd: s.feesUsd, avgPnlC: s.priced ? r2(s.pnlCSum / s.priced) : null, usd: s.usd, roiPct: s.usd ? r2(100 * s.pnlUsd / s.usd) : null });
  const map = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fin(v)]));
  return { all: fin(all), bySport: map(bySport), byKind: map(byKind), byMode: map(byMode) };
}
const rowFromD1 = (r) => ({ id: r.id, mode: r.mode, entryAt: new Date(r.ts_entry * 1000).toISOString(), exitAt: r.ts_exit ? new Date(r.ts_exit * 1000).toISOString() : null, sport: r.sport, game: r.game, team: r.team, usSlug: r.us_slug, side: r.side, entryPx: r.entry_px, exitPx: r.exit_px, shares: r.shares, usd: r.usd, feeEntryUsd: r.fee_entry_usd, feeExitUsd: r.fee_exit_usd, pnlC: r.pnl_c, pnlUsd: r.pnl_usd, edgeC: r.edge_c, dpC: r.dp_c, shownQty: r.shown_qty, holdS: r.hold_s, exitKind: r.exit_kind, live: !!r.live, orderId: r.order_id, exitOrderId: r.exit_order_id, note: r.note });

export async function scalpReport(env, config = {}, { hours = 168, nowMs = Date.now() } = {}) {
  const cfg = scalpConfig(config);
  const { mode, liveAsked, liveBlocked } = scalpModeFor(env, cfg);
  const [halt, open, last, recent] = await Promise.all([kvJson(env, SCALP_KEYS.HALT, { halted: false }), kvJson(env, SCALP_KEYS.OPEN, []), kvJson(env, SCALP_KEYS.LAST, null), kvJson(env, SCALP_KEYS.RECENT, [])]);
  const day = await kvJson(env, SCALP_KEYS.DAY + dayOf(nowMs), { date: dayOf(nowMs), entries: 0, exits: 0, wins: 0, pnlUsd: 0, feesUsd: 0 });
  let rows = [];
  if (env.DB) {
    try { const q = await env.DB.prepare(`SELECT * FROM scalp_trades WHERE ts_entry >= ? ORDER BY ts_entry DESC LIMIT 2000`).bind(Math.floor(nowMs / 1000) - hours * 3600).all(); rows = ((q && q.results) || []).map(rowFromD1); }
    catch (e) { rows = (recent || []).filter(r => Date.parse(r.entryAt) >= nowMs - hours * 3600e3); }
  } else rows = (recent || []).filter(r => Date.parse(r.entryAt) >= nowMs - hours * 3600e3);
  const sum = summarizeScalps(rows);
  return {
    success: true, hours, mode, liveAsked, liveBlocked, halted: !!(halt && halt.halted), halt, config: cfg, last,
    open: open.map(p => ({ ...p, holdLeftS: Math.max(0, Math.round((p.exitAtMs - nowMs) / 1000)) })),
    today: day, ...sum, recent: rows.slice(0, 30),
    read: `The Polymarket US stale-quote scalp lane (src/scalp.js). Each minute the sampler sees global Polymarket's mid move 3c+ while the US quote has not followed and is still crossable after its taker fee, the lane takes the stale quote for up to $${cfg.scalpMaxUsd} (never more than the shares shown) and closes on the US book ${cfg.scalpHoldMin} minutes later as a taker, both fees charged; pnlC is cents a share after both fees, the same number the paper lane's x5 mark reads. Modes: off / dry (decisions and fills at the sampled quotes, nothing sent) / live (FOK entry and close-position exit on Polymarket US with the account key; only when the key is on the worker). Risk: ${cfg.scalpMaxOpen} open, ${cfg.scalpMaxPerDay} a day, stop at -$${cfg.scalpDailyLossUsd} realized on the day, one scalp per game, edge >= ${cfg.scalpMinEdgeC}c and ${cfg.scalpMinQty}+ shares shown; POST /xvenue/scalp/halt is the kill switch and the lane halts itself on an ambiguous send or an exit it cannot reconcile. exitKind: x5 = closed at the hold on a US quote; late_last_quote / no_quote = no US quote at the hold (dry), closed at the last quote seen or unpriced; x_live = the venue's close fill; settling = the venue refused the close (market over), the position settles there and its P&L lands in the account balance, not here. The live flip is the owner's.`,
  };
}

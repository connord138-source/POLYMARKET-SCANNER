// ============================================================
// FILL-PROBE.JS — does the stale quote survive long enough to be hit?
// ============================================================
//
// Owner, Nov 2 2026 ("Lets do it!"). The scalp lane's dry record assumes the
// order fills at the quote the sampler saw, but the sampler looks once a
// minute and a live order would go out seconds later; stale quotes get
// picked off, and the ones left may be the ones nobody wanted. This probe
// answers that before any money moves: every dry scalp entry re-reads the
// venue's book right away (t0, a few seconds after the sampler's look) and
// again PROBE_DELAY_MS later (t1), recording whether the entry price is still
// there, how many contracts sit at it, and how far it moved against us.
// Polymarket US: the market's /book (top of book with shares shown). Kalshi:
// the market's orderbook (YES bids and NO bids with contract counts; a NO
// bid at p is a YES ask at 1 - p), which also gives the Kalshi sizes the
// sampler never had. Nothing is sent; one or two reads per scalp.
//
// Position fields read: venue, side ('buy' takes the ask, 'sell' takes the
// bid; prices in long/YES terms), px, shares, usSlug / kTicker.
import { usTopOfBook } from './xvenue.js';
import { kalshiOrderbook } from './kalshi.js';

export const PROBE_DELAY_MS = 10000;   // the second look

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const defaultSleep = (ms) => new Promise(res => setTimeout(res, ms));

// Pure: one book read against the scalp's entry. `book` = { bid, ask, bidQty,
// askQty } in long/YES terms (qty null when the venue does not say).
//   there  = the entry price (or better) is still quoted on our side
//   enough = ... with at least the scalp's size behind it (null when sizes are unknown)
//   moveC  = cents the quote moved against the entry (negative = better than the entry)
export function probeRead(pos, book, atS) {
  const s = atS == null ? null : r2(atS);
  if (!book) return { s, there: null, enough: null, px: null, qty: null, moveC: null, note: 'no book' };
  const px = pos.side === 'buy' ? book.ask : book.bid;
  const qty = pos.side === 'buy' ? book.askQty : book.bidQty;
  if (px == null || !(px > 0)) return { s, there: false, enough: false, px: null, qty: null, moveC: null, note: 'side empty' };
  const moveC = r2((pos.side === 'buy' ? px - pos.px : pos.px - px) * 100);
  const there = moveC <= 0.0001;
  const q = qty == null ? null : Math.round(Number(qty));
  return { s, there, enough: there ? (q == null ? null : q >= pos.shares) : false, px: r4(px), qty: q, moveC };
}

// One read of the venue's book for a position, never throwing.
export async function readBook(env, pos, { fetchImpl } = {}) {
  try {
    if (pos.venue === 'kalshi') return pos.kTicker ? await kalshiOrderbook(env, pos.kTicker, { fetchImpl, depth: 5 }) : null;
    return pos.usSlug ? await usTopOfBook(pos.usSlug, { fetchImpl }) : null;
  } catch (e) { return null; }
}

// Probe every position given (dry entries of this minute): t0 now, t1 after
// the delay, all positions read in parallel, one shared wait. Results land on
// each position as `probe` and travel with it onto the trade row.
export async function runFillProbe(env, positions, { fetchImpl, nowMs = Date.now(), delayMs = PROBE_DELAY_MS, sleep = defaultSleep, clock = Date.now } = {}) {
  const list = (positions || []).filter(p => p && !p.live && (p.venue === 'kalshi' ? p.kTicker : p.usSlug));
  if (!list.length) return { probed: 0 };
  const at = () => (clock() - nowMs) / 1000;
  const t0 = await Promise.all(list.map(async (p) => probeRead(p, await readBook(env, p, { fetchImpl }), at())));
  await sleep(delayMs);
  const t1 = await Promise.all(list.map(async (p) => probeRead(p, await readBook(env, p, { fetchImpl }), at())));
  list.forEach((p, i) => { p.probe = { t0: t0[i], t1: t1[i], delayS: r2(delayMs / 1000) }; });
  return { probed: list.length, there0: t0.filter(x => x.there).length, there1: t1.filter(x => x.there).length };
}

// Pure: the record. rows = trade rows and/or open positions carrying `probe`.
// Per venue and look: how often the entry price was still there, how often
// with enough size behind it, the median contracts left when it was, the
// average move against us when it was not, and how many seconds after the
// sampler's look the read happened.
// pnlThere / pnlGone (Nov 5 2026): the closed scalps' dry result split by that
// look's answer. A live order only fills when the price is still there, so
// pnlThere at t0 is the record a live lane would have booked; the 27 most
// recent Polymarket US scalps read -0.25c a share where it was there and
// +21.3c where it was gone, i.e. the dry profit can sit in quotes a live
// order never gets.
export function summarizeProbes(rows) {
  const pk = () => ({ n: 0, wins: 0, cSum: 0, usd: 0, staked: 0 });
  const mk = () => ({ n: 0, there: 0, sized: 0, enough: 0, qtys: [], moveSum: 0, moveN: 0, sSum: 0, sN: 0, noBook: 0, pThere: pk(), pGone: pk() });
  const out = {};
  for (const r of rows || []) {
    const p = r && r.probe; if (!p || !p.t0) continue;
    const v = r.venue === 'kalshi' ? 'kalshi' : 'us';
    const o = out[v] || (out[v] = { n: 0, t0: mk(), t1: mk() });
    o.n++;
    for (const k of ['t0', 't1']) {
      const x = p[k]; if (!x) continue;
      const s = o[k]; s.n++;
      if (x.s != null) { s.sSum += x.s; s.sN++; }
      if (x.there == null) { s.noBook++; continue; }
      if (x.there) { s.there++; if (x.qty != null) { s.sized++; s.qtys.push(x.qty); if (x.enough) s.enough++; } }
      else if (x.moveC != null) { s.moveSum += x.moveC; s.moveN++; }
      if (r.pnlC != null && r.pnlUsd != null) {
        const b = x.there ? s.pThere : s.pGone;
        b.n++; b.cSum += r.pnlC; b.usd += r.pnlUsd; b.staked += r.usd || 0; if (r.pnlUsd > 0) b.wins++;
      }
    }
  }
  const fin = (s) => {
    const read = s.n - s.noBook;
    const q = [...s.qtys].sort((a, b) => a - b);
    const pf = (b) => ({ n: b.n, wins: b.wins, hitRate: b.n ? r2(b.wins / b.n) : null, avgPnlC: b.n ? r2(b.cSum / b.n) : null, pnlUsd: r2(b.usd), roiPct: b.staked ? r2(100 * b.usd / b.staked) : null });
    return { n: s.n, read, there: s.there, thereRate: read ? r2(s.there / read) : null, enough: s.enough, enoughRate: s.sized ? r2(s.enough / s.sized) : null, qtyMed: q.length ? q[Math.floor(q.length / 2)] : null, goneAvgMoveC: s.moveN ? r2(s.moveSum / s.moveN) : null, avgS: s.sN ? r2(s.sSum / s.sN) : null, noBook: s.noBook, pnlThere: pf(s.pThere), pnlGone: pf(s.pGone) };
  };
  return Object.fromEntries(Object.entries(out).map(([v, o]) => [v, { n: o.n, t0: fin(o.t0), t1: fin(o.t1) }]));
}

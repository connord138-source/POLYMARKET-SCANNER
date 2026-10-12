// Execution shadow ledger. The paper bot fills at Polymarket's quoted price
// (Gamma's mid) and exits at the CLOB midpoint, so its P&L pays neither the
// spread nor the taker fee - it is the most optimistic ledger possible. This
// module records, for every paper entry, what two real executions would have
// done on the same trade:
//   taker : buy at the ask, pay the taker fee (rate x p(1-p), takerOnly)
//   maker : post at the bid; filled only if the tape printed a sell at or
//           below that bid before the order's TTL; earn the maker rebate
// and settles both against the position's actual exit. After a few dozen
// trades the ledger says whether "be the maker" flips the sign of the book -
// the cheapest mechanical edge left after the Oct 2026 structural-arb scans
// (neg-risk, strike monotonicity, cross-venue, settlement lag) all came back
// empty or below fees.

const CLOB_API = 'https://clob.polymarket.com';
const POLY_DATA_API = 'https://data-api.polymarket.com';

export const EXEC_KEYS = { LEDGER: 'exec_ledger' };
export const DEFAULT_TTL_MIN = 60;

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

// Gamma's feeSchedule: {rate, exponent, takerOnly, rebateRate}. Missing -> no fees.
export function feeSched(src) {
  const s = src && src.feeSchedule ? src.feeSchedule : src;
  if (!s || typeof s.rate !== 'number') return { rate: 0, exponent: 1, rebateRate: 0 };
  return { rate: s.rate, exponent: typeof s.exponent === 'number' ? s.exponent : 1, rebateRate: typeof s.rebateRate === 'number' ? s.rebateRate : 0 };
}
// Per-share taker fee in dollars at price p (0..1).
export const takerFee = (p, sched) => { const s = feeSched(sched); return s.rate * Math.pow(p * (1 - p), s.exponent); };
// Per-share maker rebate in dollars: a share of the taker fee the other side paid.
export const makerRebate = (p, sched) => feeSched(sched).rebateRate * takerFee(p, sched);

export function bestOfBook(book) {
  const asks = (book?.asks || []).map(a => [Number(a.price), Number(a.size)]).filter(a => a[0] > 0);
  const bids = (book?.bids || []).map(a => [Number(a.price), Number(a.size)]).filter(a => a[0] > 0);
  if (!asks.length || !bids.length) return null;
  const ask = asks.reduce((m, a) => (a[0] < m[0] ? a : m)), bid = bids.reduce((m, a) => (a[0] > m[0] ? a : m));
  return { bid: bid[0], ask: ask[0], bidSz: bid[1], askSz: ask[1] };
}

// Which CLOB token the position holds: outcome label match, then Yes/No.
export function sideTokenId(gamma, directionRaw) {
  if (!gamma) return null;
  const toks = Array.isArray(gamma.tokenIds) ? gamma.tokenIds : [gamma.yesTokenId, gamma.noTokenId];
  const outs = Array.isArray(gamma.outcomes) ? gamma.outcomes : ['Yes', 'No'];
  const dir = String(directionRaw || 'Yes').trim().toLowerCase();
  const idx = outs.findIndex(o => String(o).trim().toLowerCase() === dir);
  if (idx >= 0) return toks[idx] || null;
  if (dir === 'yes') return toks[0] || null;
  if (dir === 'no') return toks[1] || null;
  return null;
}

// Pure: record the book at entry and open the shadow maker order at the bid.
export function shadowOnEntry(position, book, sched, nowIso = new Date().toISOString(), ttlMin = DEFAULT_TTL_MIN) {
  const b = bestOfBook(book);
  if (!b || b.ask <= 0 || b.bid <= 0 || b.ask > 1 || b.bid >= b.ask) { position.exec = null; return null; }
  const s = feeSched(sched);
  const exec = {
    bidC: r2(b.bid * 100), askC: r2(b.ask * 100), midC: r2((b.bid + b.ask) * 50), spreadC: r2((b.ask - b.bid) * 100),
    limitC: r2(b.bid * 100), status: 'pending', placedAt: nowIso, ttlMin,
    feeRate: s.rate, exponent: s.exponent, rebateRate: s.rebateRate,
    takerFeeC: r3(takerFee(b.ask, s) * 100), rebateC: r3(makerRebate(b.bid, s) * 100),
  };
  position.exec = exec;
  return exec;
}

// Pure: would the resting bid have filled? A print on our token at or below
// our limit, after we posted, with the taker selling (hitting bids). Trades
// without a side are counted on price alone.
export function shadowCheckFills(exec, trades, tokenId, nowMs = Date.now()) {
  if (!exec || exec.status !== 'pending') return exec ? exec.status : null;
  const placedMs = Date.parse(exec.placedAt);
  let fill = null;
  for (const t of trades || []) {
    const asset = t.asset || t.asset_id || t.tokenId;
    if (asset && tokenId && String(asset) !== String(tokenId)) continue;
    const ts = typeof t.timestamp === 'number' ? (t.timestamp > 1e12 ? t.timestamp : t.timestamp * 1000) : Date.parse(t.timestamp || '');
    if (!Number.isFinite(ts) || ts < placedMs) continue;
    if (t.side && String(t.side).toUpperCase() !== 'SELL') continue;
    const priceC = Number(t.price) * 100;
    if (!(priceC <= exec.limitC + 1e-9)) continue;
    if (!fill || ts < fill.ts) fill = { ts, priceC: r2(priceC) };
  }
  if (fill) { exec.status = 'filled'; exec.filledAt = new Date(fill.ts).toISOString(); exec.fillMin = Math.round((fill.ts - placedMs) / 60e3); return exec.status; }
  if (nowMs - placedMs > exec.ttlMin * 60e3) exec.status = 'expired';
  return exec.status;
}

// Pure: settle the three ledgers against the same exit. Exits by resolution
// cost nothing; any other exit is assumed to be a taker sell at the bid
// (half the entry spread) plus the taker fee at the exit price.
export function shadowOnExit(position, exitPriceC, exitType) {
  const exec = position.exec;
  if (!exec || typeof exitPriceC !== 'number' || !(position.size > 0)) return null;
  const s = { rate: exec.feeRate, exponent: exec.exponent, rebateRate: exec.rebateRate };
  const exit = exitPriceC / 100;
  const resolved = exitType === 'market_resolved' || exit >= 0.999 || exit <= 0.001;
  const exitCost = resolved ? 0 : exec.spreadC / 200 + takerFee(exit, s);
  const sharesT = position.size / (exec.askC / 100);
  const taker = r2(sharesT * (exit - exitCost) - position.size - sharesT * takerFee(exec.askC / 100, s));
  let maker = null;
  if (exec.status === 'filled') {
    const sharesM = position.size / (exec.limitC / 100);
    maker = r2(sharesM * (exit - exitCost) - position.size + sharesM * makerRebate(exec.limitC / 100, s));
  }
  const out = { paper: r2(position.pnl || 0), taker, maker, status: exec.status === 'pending' ? 'expired' : exec.status, spreadC: exec.spreadC, exitType };
  exec.settled = out;
  return out;
}

export function emptyLedger() {
  return { n: 0, filled: 0, expired: 0, pending: 0, paper: 0, taker: 0, makerOnFilled: 0, paperOnFilled: 0, takerOnFilled: 0, spreadCSum: 0, fillMinSum: 0, updatedAt: null };
}

// Pure: fold one settled shadow into the running ledger.
export function ledgerAdd(ledger, res, exec) {
  const L = ledger || emptyLedger();
  if (!res) return L;
  L.n++; L.paper = r2(L.paper + res.paper); L.taker = r2(L.taker + res.taker); L.spreadCSum = r2(L.spreadCSum + (res.spreadC || 0));
  if (res.status === 'filled') { L.filled++; L.makerOnFilled = r2(L.makerOnFilled + res.maker); L.paperOnFilled = r2(L.paperOnFilled + res.paper); L.takerOnFilled = r2(L.takerOnFilled + res.taker); L.fillMinSum += exec && typeof exec.fillMin === 'number' ? exec.fillMin : 0; }
  else if (res.status === 'expired') L.expired++;
  else L.pending++;
  L.updatedAt = new Date().toISOString();
  return L;
}

export function ledgerSummary(L) {
  const l = L || emptyLedger();
  return {
    ...l,
    fillRate: l.n ? r3(l.filled / l.n) : null,
    avgSpreadC: l.n ? r2(l.spreadCSum / l.n) : null,
    avgFillMin: l.filled ? Math.round(l.fillMinSum / l.filled) : null,
    takerMinusPaper: r2(l.taker - l.paper),
    makerMinusTakerOnFilled: l.filled ? r2(l.makerOnFilled - l.takerOnFilled) : null,
    read: 'paper = the bot\'s own ledger (mid in, mid out, no fees). taker = same trades bought at the ask with taker fees: what real money would have made. makerOnFilled = the subset where a bid at the entry-time best bid got hit before the TTL, bought there with the maker rebate; compare with takerOnFilled/paperOnFilled on the same subset. Unfilled makers are missed trades, not losses.',
  };
}

// ---- IO ----

export async function attachShadow(env, position, gamma, tokenId, ttlMin) {
  if (!tokenId) { position.exec = null; return null; }
  try {
    const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`);
    if (!res.ok) { position.exec = null; return null; }
    const book = await res.json();
    position.execToken = tokenId;
    position.execCond = (gamma && gamma.conditionId) || null;
    return shadowOnEntry(position, book, gamma && gamma.feeSchedule, new Date().toISOString(), ttlMin);
  } catch (e) { position.exec = null; return null; }
}

// Check every pending shadow against the tape since it was posted.
export async function refreshShadows(env, positions, nowMs = Date.now()) {
  let checked = 0, filled = 0, expired = 0;
  for (const p of positions || []) {
    if (!p || !p.exec || p.exec.status !== 'pending' || !p.execCond || !p.execToken) continue;
    checked++;
    let trades = [];
    try {
      const res = await fetch(`${POLY_DATA_API}/trades?market=${p.execCond}&limit=300`);
      if (res.ok) trades = await res.json();
    } catch (e) { continue; }
    const st = shadowCheckFills(p.exec, trades, p.execToken, nowMs);
    if (st === 'filled') filled++; else if (st === 'expired') expired++;
  }
  return { checked, filled, expired };
}

export async function settleShadow(env, closedTrade) {
  if (!closedTrade || !closedTrade.exec) return null;
  if (closedTrade.exec.status === 'pending') closedTrade.exec.status = 'expired';   // closed before the shadow filled
  const res = shadowOnExit(closedTrade, typeof closedTrade.exitPrice === 'number' ? closedTrade.exitPrice : null, closedTrade.exitType);
  if (!res) return null;
  try {
    const cur = await env.SIGNALS_CACHE.get(EXEC_KEYS.LEDGER, { type: 'json' });
    await env.SIGNALS_CACHE.put(EXEC_KEYS.LEDGER, JSON.stringify(ledgerAdd(cur, res, closedTrade.exec)));
  } catch (e) {}
  return res;
}

export async function getExecReport(env, history, openPositions) {
  let L = null; try { L = await env.SIGNALS_CACHE.get(EXEC_KEYS.LEDGER, { type: 'json' }); } catch (e) {}
  const recent = (history || []).filter(t => t && t.exec && t.exec.settled).slice(-30).reverse().map(t => ({
    market: (t.marketTitle || t.marketSlug || '').slice(0, 60), direction: t.direction, size: t.size, entryPrice: t.entryPrice, exitPrice: t.exitPrice, exitType: t.exitType,
    bidC: t.exec.bidC, askC: t.exec.askC, spreadC: t.exec.spreadC, status: t.exec.status, fillMin: t.exec.fillMin ?? null, ...t.exec.settled,
  }));
  const pending = (openPositions || []).filter(p => p && p.exec).map(p => ({ market: (p.marketTitle || '').slice(0, 60), status: p.exec.status, bidC: p.exec.bidC, askC: p.exec.askC, placedAt: p.exec.placedAt }));
  return { success: true, ledger: ledgerSummary(L), recent, open: pending };
}

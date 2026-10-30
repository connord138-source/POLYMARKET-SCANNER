// A wallet's recent book, rebuilt from Polymarket's activity feed (its last
// 500 actions) and the positions on file. Pure: no fetches, no clock but
// `nowMs`. index.js's getWalletPnL fetches, this classifies.
//
// What the venue shows and what it hides (Oct 30 2026). A winning leg is
// cashed (a REDEEM that pays out) and listed under Closed. A losing leg
// resolves to zero and is NEVER listed under Closed: either it stays on the
// Active tab at $0 (a wallet that never cashes it), or the wallet redeems the
// condition and the feed shows a REDEEM that paid $0 with the tokens burned,
// so nothing is left on file at all. Both are losses. A $0 redeem used to
// fall into "could not be classified", which is how an account whose own
// book read -$2.8k lifetime read +$78k here: its 88 cashed wins counted, its
// 84 burned losses did not.
//
// Each market in the window is one of:
//   redeemed        -> WIN/LOSS by net (payout - cost + sales); $0 payout = LOSS
//   redeemed, but bought before the window -> outsideWindow (no cost basis)
//   no position, sold at least half  -> WIN/LOSS by the sale
//   no position, not sold            -> unknown (dust, a transfer)
//   position resolved (redeemable, priced 1, or priced 0 past its end)
//                   -> WIN/LOSS by net at today's value
//   position open   -> open (or a LOSS when it already sits at $0)

const SOLD_OUT_SHARE = 0.5;

function usd(a) { return parseFloat(a.usdcSize) || parseFloat(a.usd_value) || 0; }
function ms(ts) { return ts < 1e12 ? ts * 1000 : ts; }

export function groupActivity(activity) {
  const markets = {};
  for (const a of activity || []) {
    const market = a.slug || a.conditionId;
    if (!market) continue;
    if (!markets[market]) {
      markets[market] = { title: a.title || market, slug: a.slug, icon: a.icon, buys: [], sells: [], redeems: [], merges: [], splits: [], outcome: a.outcome };
    }
    const m = markets[market];
    if (a.outcome && !m.outcome) m.outcome = a.outcome;
    const amount = usd(a); const time = ms(a.timestamp);
    if (a.type === 'BUY' || a.side === 'BUY') m.buys.push({ amount, time, price: parseFloat(a.price) || 0, outcome: a.outcome });
    else if (a.type === 'SELL' || a.side === 'SELL') m.sells.push({ amount, time, price: parseFloat(a.price) || 0 });
    else if (a.type === 'REDEEM') m.redeems.push({ amount, time });
    else if (a.type === 'MERGE') m.merges.push({ amount, time });   // YES+NO pairs merged back into cash: proceeds
    else if (a.type === 'SPLIT') m.splits.push({ amount, time });   // cash split into YES+NO pairs: cost
  }
  return markets;
}

export function rebuildWalletBook(activity, positions, nowMs = Date.now()) {
  const marketBets = groupActivity(activity);
  positions = Array.isArray(positions) ? positions : [];
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const resolvedBets = [], openBets = [];
  let totalWins = 0, totalLosses = 0, winCount = 0, lossCount = 0;
  let unknownCount = 0, outsideWindow = 0, zeroRedeems = 0, bothSides = 0, marketsBought = 0;
  const sum = (rows) => rows.reduce((s, r) => s + r.amount, 0);
  const lastTime = (rows) => (rows.length && rows[rows.length - 1].time ? new Date(rows[rows.length - 1].time).toISOString() : null);

  for (const [market, data] of Object.entries(marketBets)) {
    if (new Set(data.buys.map(b => b.outcome).filter(Boolean)).size > 1) bothSides++;
    marketsBought++;
    const totalBought = sum(data.buys) + sum(data.splits);
    const totalSold = sum(data.sells) + sum(data.merges);
    const totalRedeemed = sum(data.redeems);
    const avgBuyPrice = data.buys.length ? data.buys.reduce((s, b) => s + b.price, 0) / data.buys.length : 0;
    const base = { market: data.title, marketSlug: data.slug, outcome: data.outcome, invested: Math.round(totalBought), avgPrice: Math.round(avgBuyPrice * 100), icon: data.icon };
    const book = (profit, returned, time, note) => {
      const won = profit > 0;
      if (won) { totalWins += profit; winCount++; } else { totalLosses += Math.abs(profit); lossCount++; }
      resolvedBets.push({ ...base, result: won ? 'WIN' : 'LOSS', returned: Math.round(returned), profit: Math.round(profit), profitPct: totalBought > 0 ? Math.round((profit / totalBought) * 100) : 0, time, ...(note ? { note } : {}) });
    };

    const position = positions.find(p => p.slug === market || p.conditionId === market);
    const hasPosition = !!position && parseFloat(position.size || 0) > 0;

    if (data.redeems.length > 0) {
      // Cashed. A redeem whose buys fell before the window has no cost basis
      // here: it is neither a win nor a loss of this window.
      if (totalBought === 0) { outsideWindow++; continue; }
      if (totalRedeemed === 0) zeroRedeems++;
      // Net, not the mere presence of a payout: a wallet can cash a winner and
      // still be down on the market (it bought more than the winner returned).
      book(totalRedeemed - totalBought + totalSold, totalRedeemed + totalSold, data.redeems[0]?.time ? new Date(data.redeems[0].time).toISOString() : null, totalRedeemed === 0 ? 'Cashed at $0' : undefined);
      continue;
    }
    if (totalBought === 0) continue;   // sells or merges of something bought before the window

    if (!hasPosition) {
      // Nothing on file and never cashed: sold out (the sale is the result)
      // or gone some other way (dust under the API's size floor, a transfer).
      if (totalSold >= totalBought * SOLD_OUT_SHARE) book(totalSold - totalBought, totalSold, lastTime(data.sells.length ? data.sells : data.merges), 'Sold');
      else unknownCount++;
      continue;
    }

    // A position on file. Resolved when the position says so: redeemable,
    // priced at 1, or priced at 0 past its end date. (A title/date heuristic
    // used to call every game played TODAY settled.)
    const curPrice = parseFloat(position.curPrice || position.currentPrice || 0);
    const currentValue = parseFloat(position.currentValue || position.value || 0);
    const endDate = position.endDate ? String(position.endDate).slice(0, 10) : null;
    const endPast = endDate ? endDate < today : false;
    const resolved = position.redeemable === true || curPrice >= 0.99 || (curPrice <= 0.01 && endPast);
    if (resolved) {
      // Unredeemed, resolved: the result is the net at today's value (a wallet
      // that bought both sides can hold the winner and still be net down).
      if (currentValue > totalBought * 0.5 || curPrice >= 0.95) book(currentValue - totalBought + totalSold, currentValue + totalSold, lastTime(data.buys), 'Unredeemed');
      else {
        const loss = totalBought - totalSold - currentValue;
        if (loss > 0) book(-loss, totalSold + currentValue, lastTime(data.buys));
      }
      continue;
    }
    // Open. A position already worth nothing on a real stake is a loss that
    // has not been written down yet.
    if ((currentValue < 1 || curPrice < 0.02) && totalBought > 100) { book(-(totalBought - totalSold), totalSold, lastTime(data.buys)); continue; }
    const unrealizedPnL = currentValue - totalBought + totalSold;
    openBets.push({ market: data.title, marketSlug: data.slug, outcome: data.outcome || position.outcome || data.buys[0]?.outcome || null, invested: Math.round(totalBought), currentValue: Math.round(currentValue), unrealizedPnL: Math.round(unrealizedPnL), unrealizedPct: totalBought > 0 ? Math.round((unrealizedPnL / totalBought) * 100) : 0, avgPrice: Math.round(avgBuyPrice * 100), currentPrice: Math.round((parseFloat(position.curPrice) || 0) * 100), icon: data.icon });
  }

  resolvedBets.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
  // How much time the window covers. A wallet trading thousands of times a
  // day fits a day or two in it; the pages keep money out of the call when
  // the window is short.
  const stamps = (activity || []).map(a => ms(a.timestamp)).filter(t => t > 0);
  const windowDays = stamps.length ? Math.round(10 * (nowMs - Math.min(...stamps)) / 86400000) / 10 : null;
  const totalInvested = Object.values(marketBets).reduce((s, m) => s + sum(m.buys), 0);
  const realizedPnL = totalWins - totalLosses;
  const unrealizedPnL = openBets.reduce((s, b) => s + b.unrealizedPnL, 0);
  return {
    resolvedBets, openBets,
    totals: { totalWins, totalLosses, winCount, lossCount, unknownCount, outsideWindow, zeroRedeems, bothSides, marketsBought, windowDays, totalInvested, realizedPnL, unrealizedPnL }
  };
}

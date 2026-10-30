// rebuildWalletBook: a wallet's recent book from the activity feed + positions.
import { rebuildWalletBook } from '../src/wallet-book.js';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) pass++; else { fail++; console.log('FAIL', name, extra); } };
const NOW = Date.parse('2026-10-30T12:00:00Z');
const t = (daysAgo) => Math.floor((NOW - daysAgo * 86400e3) / 1000);   // feed timestamps are seconds
const buy = (slug, usd, price, daysAgo, outcome = 'Yes') => ({ type: 'TRADE', side: 'BUY', slug, usdcSize: usd, price, size: usd / price, timestamp: t(daysAgo), outcome, title: slug });
const sell = (slug, usd, price, daysAgo) => ({ type: 'TRADE', side: 'SELL', slug, usdcSize: usd, price, timestamp: t(daysAgo), title: slug });
const redeem = (slug, usd, daysAgo) => ({ type: 'REDEEM', slug, usdcSize: usd, size: 100, timestamp: t(daysAgo), title: slug });

// 1. A $0 redeem is a losing leg being burned: a LOSS of the stake, not unknown.
{
  const b = rebuildWalletBook([redeem('m1', 0, 1), buy('m1', 600, 0.6, 3)], [], NOW);
  check('zero redeem is a loss', b.totals.lossCount === 1 && b.totals.winCount === 0 && b.totals.unknownCount === 0, JSON.stringify(b.totals));
  check('zero redeem loses the stake', b.resolvedBets[0].profit === -600 && b.resolvedBets[0].note === 'Cashed at $0');
  check('zero redeem counted', b.totals.zeroRedeems === 1);
}
// 2. A paid redeem is a WIN by net; a payout below cost is still a LOSS.
{
  const b = rebuildWalletBook([redeem('w', 1000, 1), buy('w', 600, 0.6, 3), redeem('n', 300, 1), buy('n', 500, 0.5, 2)], [], NOW);
  const w = b.resolvedBets.find(r => r.marketSlug === 'w'), n = b.resolvedBets.find(r => r.marketSlug === 'n');
  check('paid redeem wins by net', w.result === 'WIN' && w.profit === 400);
  check('payout below cost is a loss', n.result === 'LOSS' && n.profit === -200);
  check('realized is wins minus losses', b.totals.realizedPnL === 200);
}
// 3. A redeem whose buys fell before the window is neither: outsideWindow.
{
  const b = rebuildWalletBook([redeem('old', 900, 1), buy('x', 100, 0.5, 2)], [{ slug: 'x', size: 200, curPrice: 0.55, currentValue: 110 }], NOW);
  check('redeem without a buy in window is outside', b.totals.outsideWindow === 1 && b.totals.winCount === 0 && b.totals.lossCount === 0, JSON.stringify(b.totals));
  check('open position stays open', b.openBets.length === 1 && b.openBets[0].unrealizedPnL === 10);
}
// 4. Nothing on file, never cashed: sold out is a result (either way), otherwise unknown.
{
  const b = rebuildWalletBook([sell('p', 700, 0.7, 1), buy('p', 500, 0.5, 2), sell('q', 300, 0.3, 1), buy('q', 500, 0.5, 2), buy('u', 500, 0.5, 2)], [], NOW);
  const p = b.resolvedBets.find(r => r.marketSlug === 'p'), q = b.resolvedBets.find(r => r.marketSlug === 'q');
  check('sold out at a profit is a WIN', p && p.result === 'WIN' && p.profit === 200 && p.note === 'Sold', JSON.stringify(p));
  check('sold out at a loss is a LOSS', q && q.result === 'LOSS' && q.profit === -200);
  check('bought, not sold, nothing on file is unknown', b.totals.unknownCount === 1);
}
// 5. Positions on file: resolved by the position (redeemable / priced 1 / 0 past end), open otherwise.
{
  const pos = [
    { slug: 'rw', size: 1000, curPrice: 1, currentValue: 1000, redeemable: true },
    { slug: 'rl', size: 1000, curPrice: 0, currentValue: 0, endDate: '2026-10-20T00:00:00Z' },
    { slug: 'live', size: 1000, curPrice: 0.004, currentValue: 4, endDate: '2026-11-05T00:00:00Z' },   // a long shot still trading
  ];
  const b = rebuildWalletBook([buy('rw', 600, 0.6, 3), buy('rl', 600, 0.6, 3), buy('live', 50, 0.05, 3)], pos, NOW);
  const rw = b.resolvedBets.find(r => r.marketSlug === 'rw'), rl = b.resolvedBets.find(r => r.marketSlug === 'rl');
  check('unredeemed winner is a WIN by net', rw && rw.result === 'WIN' && rw.profit === 400 && rw.note === 'Unredeemed');
  check('dead leg at $0 past its end is a LOSS', rl && rl.result === 'LOSS' && rl.profit === -600);
  check('a small long shot still trading stays open', b.openBets.some(o => o.marketSlug === 'live'), JSON.stringify(b.openBets));
}
// 6. Merges are proceeds, splits are cost; window days from the oldest stamp.
{
  const acts = [{ type: 'MERGE', slug: 'mm', usdcSize: 980, timestamp: t(1) }, { type: 'SPLIT', slug: 'mm', usdcSize: 1000, timestamp: t(2) }, buy('mm', 0, 0.5, 9.5)];
  const b = rebuildWalletBook(acts, [], NOW);
  const mm = b.resolvedBets.find(r => r.marketSlug === 'mm');
  check('split cost, merge proceeds: sold out at -20', mm && mm.result === 'LOSS' && mm.profit === -20, JSON.stringify(mm));
  check('window days from the oldest stamp', b.totals.windowDays === 9.5, String(b.totals.windowDays));
}
// 7. Empty input is a clean zero.
{
  const b = rebuildWalletBook([], null, NOW);
  check('empty feed', b.resolvedBets.length === 0 && b.openBets.length === 0 && b.totals.windowDays === null && b.totals.realizedPnL === 0);
}
console.log(`wallet-book: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

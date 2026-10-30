// Kalshi as the US venue for crypto contracts. Run with: node test/kalshi-crypto.test.mjs
import { slimMarket, matchUsVenue, attachUsVenue, fetchUsBoard, getUsBoard, etDate, etHour, US_BOARD_KEY } from '../src/kalshi-crypto.js';
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error('FAIL:', n, x ?? ''); } };

// Fixtures shaped like Kalshi's /markets rows (Oct 30 2026).
const daily = (event, floor, close, bid, ask, last) => ({ ticker: `${event}-T${floor}`, event_ticker: event, title: 'BTC price on Oct 30, 2026 at 5pm EDT?', strike_type: 'greater', floor_strike: floor, close_time: close, yes_bid_dollars: bid, yes_ask_dollars: ask, last_price_dollars: last, volume_24h_fp: '310606.72', status: 'active' });
const FIVE = '2026-10-30T21:00:00Z', NOON = '2026-10-30T16:00:00Z', MONTH_END = '2026-11-01T03:59:59Z';
const board = { at: '2026-10-30T02:10:00Z', venue: 'Kalshi', assets: {
  BTC: [
    ...[76999.99, 77499.99, 77999.99, 78499.99, 78999.99, 79999.99].map(f => ({ ...slimMarket(daily('KXBTCD-26OCT3017', f, FIVE, '0.4800', '0.4900', '0.5000'), 'daily'), series: 'KXBTCD' })),
    { ...slimMarket({ ticker: 'KXBTCMINMON-BTC-26OCT31-7500000', event_ticker: 'KXBTCMINMON-BTC-26OCT31', title: 'Will BTC trimmed mean be below $75000.00 by 11:59 PM ET on Oct 31, 2026?', strike_type: 'less', cap_strike: 75000, close_time: MONTH_END, yes_bid_dollars: '0.1700', yes_ask_dollars: '0.2400', last_price_dollars: '0.2800', volume_24h_fp: '36540.36', status: 'active' }, 'min'), series: 'KXBTCMINMON' },
  ],
  ETH: [{ ...slimMarket({ ticker: 'KXETHMAXMON-ETH-26OCT31-300000', event_ticker: 'KXETHMAXMON-ETH-26OCT31', title: 'Will ETH trimmed mean be above $3000.00 by 11:59 PM ET on Oct 31, 2026?', strike_type: 'greater', floor_strike: 3000, close_time: MONTH_END, yes_bid_dollars: '0.0000', yes_ask_dollars: '0.0200', last_price_dollars: '0.0100', volume_24h_fp: '304.08', status: 'active' }, 'max'), series: 'KXETHMAXMON' }],
  SOL: [],
} };

check('slim: a daily floor of 77,999.99 is the $78,000 contract, dollars parsed, volume rounded', (() => { const r = board.assets.BTC[2]; return r.strike === 78000 && r.yesBid === 0.48 && r.yesAsk === 0.49 && r.last === 0.5 && r.vol24h === 310607 && r.kind === 'daily'; })(), board.assets.BTC[2]);
check('slim: a one-touch min uses its cap strike', board.assets.BTC[6].strike === 75000 && board.assets.BTC[6].kind === 'min');
check('ET helpers', etDate(Date.parse(FIVE)) === '2026-10-30' && etDate(Date.parse('2026-10-31T03:30:00Z')) === '2026-10-30' && etHour(Date.parse(FIVE)) === '5pm' && etHour(Date.parse(NOON)) === '12pm');

// 1. above $78,000 on Oct 30 (noon ET): only the 5pm event is open -> same strike, five hours later
const above = matchUsVenue({ asset: 'BTC', kind: 'above', K: 78000, resolvesAt: NOON }, board);
check('above on date -> Kalshi 5pm event, same strike, YES, +5h', above && above.venue === 'Kalshi' && above.ticker === 'KXBTCD-26OCT3017-T77999.99' && above.match === 'same' && above.side === 'YES' && above.settleHours === 5 && above.when === '5pm ET' && above.yes.ask === 0.49 && above.url === 'https://kalshi.com/markets/kxbtcd', above);
// 2. once the noon event opens it wins
const withNoon = { ...board, assets: { ...board.assets, BTC: [...board.assets.BTC, { ...slimMarket(daily('KXBTCD-26OCT3012', 77999.99, NOON, '0.5100', '0.5200', '0.5100'), 'daily'), series: 'KXBTCD' }] } };
const noon = matchUsVenue({ asset: 'BTC', kind: 'above', K: 78000, resolvesAt: NOON }, withNoon);
check('the noon event is preferred when open', noon && noon.event === 'KXBTCD-26OCT3012' && noon.settleHours === 0 && noon.when === '12pm ET', noon);
// 3. below $78,250 -> nearest strike, NO side
const below = matchUsVenue({ asset: 'BTC', kind: 'below', K: 78250, resolvesAt: NOON }, board);
check('below -> the NO of the nearest above contract, flagged near', below && below.side === 'NO' && below.match === 'near' && (below.strike === 78000 || below.strike === 78500), below);
// 4. too far from any strike, or another day -> nothing
check('no strike within 1.2% -> null', matchUsVenue({ asset: 'BTC', kind: 'above', K: 81500, resolvesAt: NOON }, board) === null);
check('no event on that ET date -> null', matchUsVenue({ asset: 'BTC', kind: 'above', K: 78000, resolvesAt: '2026-10-31T16:00:00Z' }, board) === null);
// 5. one-touch
const dip = matchUsVenue({ asset: 'BTC', kind: 'dip', K: 75000, resolvesAt: '2026-11-01T04:00:00Z' }, board);
check('dip to $75k in October -> the monthly min one-touch, month end', dip && dip.series === 'KXBTCMINMON' && dip.match === 'same' && dip.side === 'YES' && dip.when === 'month end', dip);
const reach = matchUsVenue({ asset: 'ETH', kind: 'reach', K: 3000, resolvesAt: '2026-11-01T04:00:00Z' }, board);
check('reach $3,000 ETH by Oct 31 -> the monthly max one-touch', reach && reach.series === 'KXETHMAXMON' && reach.match === 'same', reach);
check('a window ending a week later matches no month-end contract', matchUsVenue({ asset: 'BTC', kind: 'dip', K: 75000, resolvesAt: '2026-11-08T04:00:00Z' }, board) === null);
check('an asset with no board rows -> null; attach puts us on every row', matchUsVenue({ asset: 'SOL', kind: 'above', K: 100, resolvesAt: NOON }, board) === null && attachUsVenue([{ asset: 'BTC', kind: 'above', K: 78000, resolvesAt: NOON }, { asset: 'SOL', kind: 'above', K: 100, resolvesAt: NOON }], board).map(r => !!r.us).join() === 'true,false');

// board fetch + cache
const kv = () => { const m = new Map(); return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, _m: m }; };
const calls = [];
const okFetch = async (path) => { calls.push(path); const markets = path.includes('KXBTCD') ? [daily('KXBTCD-26OCT3017', 77999.99, FIVE, '0.48', '0.49', '0.5'), { ...daily('KXBTCD-26OCT3017', 70999.99, FIVE, null, null, null), status: 'finalized' }] : []; return { ok: true, json: async () => ({ markets }) }; };
{
  const env = { SIGNALS_CACHE: kv() };
  const b = await fetchUsBoard(env, Date.parse('2026-10-30T02:10:00Z'), okFetch);
  check('fetch: nine series asked, only active markets kept', calls.length === 9 && b.assets.BTC.length === 1 && b.assets.BTC[0].series === 'KXBTCD' && !b.errors, { n: calls.length, btc: b.assets.BTC });
  const t0 = Date.parse('2026-10-30T02:10:00Z');
  const g1 = await getUsBoard(env, t0, okFetch); const n1 = calls.length;
  const g2 = await getUsBoard(env, t0 + 5 * 60e3, okFetch);
  check('cache: a board younger than 10 min is served without a fetch', g2.at === g1.at && calls.length === n1);
  const failing = async () => ({ ok: false, status: 429 });
  const g3 = await getUsBoard(env, t0 + 20 * 60e3, failing);
  check('cache: a 429 keeps the old board, flagged stale, with the errors', g3.stale === true && g3.assets.BTC.length === 1 && g3.errors && g3.errors.KXBTCD === 'kalshi KXBTCD 429', g3.errors);
  const g4 = await getUsBoard({ SIGNALS_CACHE: kv() }, t0, failing);
  check('no cache and a 429 -> an empty board with its errors', g4.assets.BTC.length === 0 && g4.errors && Object.keys(g4.errors).length === 9);
}
console.log(`kalshi-crypto: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

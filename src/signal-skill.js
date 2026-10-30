// ============================================================
// SIGNAL-SKILL.JS — the proven record behind a whale signal
// ============================================================
//
// A scan signal names the wallets that put the money in (topTrades and the
// involved list). This module scores those wallets with the same number the
// Top wallets page uses, excess = win rate − average entry price in points
// (src/wallet-ledger.js), from two records:
//   signals  the D1 ledger of the scanner's own graded signal bets
//   onchain  the wallet's recent resolved markets (KV wallet_onchain:<addr>,
//            refreshed by the cron for the ranked and copied wallets only)
// and attaches `whaleSkill` to the signal: every wallet's row with the money
// it put in, the best trusted wallet, the worst, the biggest, and a one-word
// call the pages turn into words. A record is trusted from LEDGER_MIN_N
// settled bets. Read-only; the auto-trader's own gates do not use it.
import { walletsFromSignal, LEDGER_MIN_N } from './wallet-ledger.js';

export const PROVEN_PTS = 8;      // a trusted record this far over its prices is "proven"
export const EDGE_PTS = 3;        // a modest, real edge
export const LOSER_PTS = -8;      // the biggest wallet this far under its prices makes the signal a fade candidate
const ONCHAIN_INDEX_KEY = 'wallet_onchain_index';
const ONCHAIN_PREFIX = 'wallet_onchain:';
const CHUNK = 60;                 // wallets per D1 query
const ONCHAIN_MAX = 150;          // KV reads per annotation

const norm = (w) => (typeof w === 'string' ? w.trim().toLowerCase() : null);
const pts = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(0)}`;

// D1: one skill row per wallet over every settled signal bet, as of now.
// Map addr -> { n, winRate, avgPrice, excess, source: 'signals' }.
export async function walletSkillMany(env, addresses) {
  const out = new Map();
  const addrs = [...new Set((addresses || []).map(norm).filter(Boolean))];
  if (!env || !env.DB || !addrs.length) return out;
  for (let i = 0; i < addrs.length; i += CHUNK) {
    const chunk = addrs.slice(i, i + CHUNK);
    const ph = chunk.map((_, j) => `?${j + 1}`).join(',');
    const sql =
      `WITH h AS (SELECT sw.wallet, sl.market_slug || '|' || sl.direction_raw k, MAX(sl.outcome='WIN') win, AVG(sl.avg_entry_price) px ` +
      `FROM signal_wallets sw JOIN signals_log sl ON sl.id = sw.signal_id WHERE sw.wallet IN (${ph}) AND sl.outcome IN ('WIN','LOSS') GROUP BY sw.wallet, k) ` +
      `SELECT wallet, COUNT(*) n, ROUND(100.0*AVG(win),1) wr, ROUND(AVG(px),1) px, ROUND(100.0*AVG(win) - AVG(px),1) excess FROM h GROUP BY wallet`;
    const res = await env.DB.prepare(sql).bind(...chunk).all();
    for (const r of (res && res.results) || []) {
      const a = norm(r.wallet);
      if (a && r.n) out.set(a, { n: r.n, winRate: r.wr, avgPrice: r.px, excess: r.excess, source: 'signals' });
    }
  }
  return out;
}

// KV: the on-chain record for the wallets that have one (the index says
// which, so the reads are bounded by the ranked list, not the signal count).
// Map addr -> { n, winRate, avgPrice, excess, source: 'onchain', totalPnL, windowDays }.
export async function onChainSkillMany(env, addresses, { max = ONCHAIN_MAX } = {}) {
  const out = new Map();
  if (!env || !env.SIGNALS_CACHE) return out;
  const index = (await env.SIGNALS_CACHE.get(ONCHAIN_INDEX_KEY, { type: 'json' }).catch(() => null)) || {};
  const have = [...new Set((addresses || []).map(norm).filter(a => a && index[a]))].slice(0, max);
  const recs = await Promise.all(have.map(a => env.SIGNALS_CACHE.get(ONCHAIN_PREFIX + a, { type: 'json' }).catch(() => null)));
  have.forEach((a, i) => {
    const r = recs[i];
    if (r && r.skill && r.skill.n) out.set(a, { n: r.skill.n, winRate: r.skill.winRate, avgPrice: r.skill.avgPrice, excess: r.skill.excess, source: 'onchain', totalPnL: r.totalPnL ?? null, windowDays: r.windowDays ?? null });
  });
  return out;
}

// Pure: one row per wallet in the signal with the money it put in and its
// record: the signal ledger when trusted, else the on-chain book when
// trusted, else whichever exists (untrusted), else null.
export function skillRows(sig, ledger, chain, minN = LEDGER_MIN_N) {
  return walletsFromSignal(sig).map(({ wallet, usd }) => {
    const l = (ledger && ledger.get(wallet)) || null, c = (chain && chain.get(wallet)) || null;
    const pick = (l && l.n >= minN) ? l : (c && c.n >= minN) ? c : (l || c);
    const skill = pick ? { n: pick.n, winRate: pick.winRate, avgPrice: pick.avgPrice, excess: pick.excess, source: pick.source, trusted: pick.n >= minN } : null;
    return { wallet, usd, skill };
  });
}

// Pure: the call on a signal's wallets.
//   proven   the best trusted wallet is PROVEN_PTS or more over its prices
//   edge     EDGE_PTS or more
//   flat     within EDGE_PTS either way
//   losing   EDGE_PTS or more under
//   unproven no wallet has a trusted record (`thin` = the most history seen)
// `fade` is set when the wallet with the most money in is a trusted loser
// (LOSER_PTS or worse): the money itself is the warning, whoever else is in.
export function whaleCall(rows, minN = LEDGER_MIN_N) {
  const list = rows || [];
  const trusted = list.filter(r => r.skill && r.skill.trusted);
  const byExcess = [...trusted].sort((a, b) => (b.skill.excess - a.skill.excess) || (b.skill.n - a.skill.n));
  const best = byExcess[0] || null;
  const worst = byExcess.length > 1 ? byExcess[byExcess.length - 1] : null;
  const sized = list.filter(r => r.usd != null).sort((a, b) => b.usd - a.usd);
  const biggest = sized[0] || list[0] || null;
  const fade = !!(biggest && biggest.skill && biggest.skill.trusted && biggest.skill.excess <= LOSER_PTS);
  let call = 'unproven';
  if (best) { const x = best.skill.excess; call = x >= PROVEN_PTS ? 'proven' : x >= EDGE_PTS ? 'edge' : x > -EDGE_PTS ? 'flat' : 'losing'; }
  const thin = best ? null : (list.filter(r => r.skill).sort((a, b) => b.skill.n - a.skill.n)[0] || null);
  return { call, fade, trusted: trusted.length, best, worst, biggest, thin, minN };
}

// Attach `whaleSkill` to every signal (one D1 pass over every wallet named,
// one KV pass over the ranked ones) plus the per-trade `skill` rows and the
// legacy flags the pages already read (hasWinningWallet, winningWalletInfo,
// topTrades[].isWinner / winnerInfo). Never throws: a record source that
// fails reads as empty and the signals go out unproven.
export async function annotateSignalWalletSkill(env, signals, { minN = LEDGER_MIN_N } = {}) {
  const list = Array.isArray(signals) ? signals : [];
  if (!list.length) return { annotated: 0, wallets: 0, ledger: 0, onchain: 0 };
  const addrs = new Set();
  for (const s of list) for (const w of walletsFromSignal(s)) addrs.add(w.wallet);
  const all = [...addrs];
  const ledger = await walletSkillMany(env, all).catch(() => new Map());
  // the on-chain book is only needed where the signal ledger has no trusted row
  const need = all.filter(a => !(ledger.get(a) && ledger.get(a).n >= minN));
  const chain = await onChainSkillMany(env, need).catch(() => new Map());
  const at = new Date().toISOString();
  let proven = 0, fades = 0;
  for (const s of list) {
    const rows = skillRows(s, ledger, chain, minN);
    const c = whaleCall(rows, minN);
    s.whaleSkill = { ...c, wallets: rows, at };
    const byW = new Map(rows.map(r => [r.wallet, r.skill]));
    for (const t of s.topTrades || []) {
      const k = norm(t.wallet);
      const sk = (k && byW.get(k)) || null;
      t.skill = sk;
      t.isWinner = !!(sk && sk.trusted && sk.excess >= PROVEN_PTS);
      t.winnerInfo = t.isWinner ? { winRate: Math.round(sk.winRate), n: sk.n, excess: sk.excess, source: sk.source } : null;
    }
    s.hasWinningWallet = c.call === 'proven';
    s.winningWalletInfo = c.call === 'proven'
      ? { wallet: c.best.wallet, record: `${c.best.skill.n} settled bets, ${pts(c.best.skill.excess)} pts over price`, winRate: Math.round(c.best.skill.winRate), totalBets: c.best.skill.n, excess: c.best.skill.excess, source: c.best.skill.source }
      : null;
    if (s.hasWinningWallet) proven++;
    if (c.fade) fades++;
  }
  return { annotated: list.length, wallets: all.length, ledger: ledger.size, onchain: chain.size, proven, fades };
}

// Pure: the wallets behind a list of signals, largest single stake first,
// for the on-chain refresher's queue: a whale's own recent markets then back
// a call within hours of it appearing, instead of waiting for ten of its
// signals to settle. One entry per wallet (its biggest stake), capped.
export function signalWalletsByMoney(signals, limit = 60) {
  const best = new Map();
  for (const s of Array.isArray(signals) ? signals : []) {
    for (const { wallet, usd } of walletsFromSignal(s)) {
      const v = usd == null ? 0 : usd;
      if (!best.has(wallet) || v > best.get(wallet)) best.set(wallet, v);
    }
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}

// Pure: the same signal with every wallet address shortened (the Free plan's
// view of /scan). `mask` is the site's address shortener.
export function maskWhaleSkill(ws, mask) {
  if (!ws) return ws;
  const row = (r) => (r ? { ...r, wallet: mask(r.wallet) } : r);
  return { ...ws, best: row(ws.best), worst: row(ws.worst), biggest: row(ws.biggest), thin: row(ws.thin), wallets: (ws.wallets || []).map(row) };
}

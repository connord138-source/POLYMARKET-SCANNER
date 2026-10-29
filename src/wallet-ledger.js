// ============================================================
// WALLET-LEDGER.JS — point-in-time wallet skill, stored in D1
// ============================================================
//
// The KV wallet stats (wallet:{addr}) are a running total: reading one tells
// you a wallet's record TODAY, which leaks the future into any backtest of an
// older signal. This ledger instead records which wallets were in each signal
// (signal_wallets) and scores a signal using only bets that SETTLED BEFORE
// the signal was detected. The same score is used live and in the Forge, so
// a promoted wallet strategy is tested exactly as it would trade.
//
// Skill metric: "excess" = win rate − average entry price, in points, over
// the wallet's prior settled bets (one per market+side). A wallet that buys
// at 70¢ and wins 70% has zero skill; one that buys at 40¢ and wins 55% has
// +15. Win rate alone rewards favorite-buyers.
// ============================================================

export const LEDGER_MIN_N = 10;       // bets before a wallet's excess is trusted
const MAX_WALLETS_PER_SIGNAL = 10;
const KV_SIGNAL_PREFIX = 'signal:';

const norm = (w) => (typeof w === 'string' ? w.trim().toLowerCase() : null);

// Wallets in a live signal object: topTrades carry size, the full set may not.
export function walletsFromSignal(sig) {
  const out = new Map();
  for (const t of (sig.topTrades || [])) {
    const w = norm(t.wallet);
    if (w && !out.has(w)) out.set(w, Math.round(t._usdValue || t.usdValue || t.amount || t.size || 0) || null);
  }
  for (const w0 of (sig.wallets || sig.involvedWallets || [])) {
    const w = norm(w0);
    if (w && !out.has(w)) out.set(w, null);
  }
  return [...out.entries()].slice(0, MAX_WALLETS_PER_SIGNAL).map(([wallet, usd]) => ({ wallet, usd }));
}

// Pure: pick the signal's best wallet from per-wallet as-of history rows.
// rows: [{ wallet, n, wr, px }]
export function bestWallet(rows, minN = LEDGER_MIN_N) {
  let best = null;
  for (const r of rows || []) {
    const excess = (r.wr != null && r.px != null) ? Math.round((r.wr - r.px) * 10) / 10 : null;
    const cand = { wallet: r.wallet, n: r.n || 0, excess };
    if (!best) { best = cand; continue; }
    const cTrusted = cand.n >= minN, bTrusted = best.n >= minN;
    if (cTrusted && !bTrusted) best = cand;
    else if (cTrusted === bTrusted) {
      if (cTrusted ? (cand.excess ?? -999) > (best.excess ?? -999) : cand.n > best.n) best = cand;
    }
  }
  return best || { wallet: null, n: 0, excess: null };
}

// As-of history for a set of wallets: one row per wallet over bets that
// settled strictly before `asOf`. One bet per wallet per market+side.
async function walletHistoryAsOf(env, wallets, asOf) {
  if (!wallets.length) return [];
  const ph = wallets.map((_, i) => `?${i + 2}`).join(',');
  const sql =
    `WITH h AS (SELECT sw.wallet, sl.market_slug || '|' || sl.direction_raw k, ` +
    `MAX(sl.outcome = 'WIN') win, AVG(sl.avg_entry_price) px ` +
    `FROM signal_wallets sw JOIN signals_log sl ON sl.id = sw.signal_id ` +
    `WHERE sw.wallet IN (${ph}) AND sl.outcome IN ('WIN','LOSS') AND sl.settled_at < ?1 ` +
    `GROUP BY sw.wallet, k) ` +
    `SELECT wallet, COUNT(*) n, 100.0 * AVG(win) wr, AVG(px) px FROM h GROUP BY wallet`;
  const res = await env.DB.prepare(sql).bind(asOf, ...wallets).all();
  return res.results || [];
}

export async function scoreSignalAsOf(env, signalId, wallets, asOf) {
  const rows = await walletHistoryAsOf(env, wallets, asOf);
  const best = bestWallet(rows);
  await env.DB.prepare(
    'UPDATE signals_log SET wallet_best=?2, wallet_best_n=?3, wallet_best_excess=?4, wallet_scored_at=?5 WHERE id=?1'
  ).bind(signalId, best.wallet, best.n, best.excess, new Date().toISOString()).run();
  return best;
}

// Live path: called right after the signals_log insert. Logs wallets +
// factors and scores the signal against history as of now.
export async function logSignalWallets(env, sig) {
  if (!env.DB || !sig || !sig.id) return null;
  try {
    const ws = walletsFromSignal(sig);
    const detectedAt = sig.detectedAt || new Date().toISOString();
    const stmts = ws.map(({ wallet, usd }) =>
      env.DB.prepare('INSERT OR IGNORE INTO signal_wallets (signal_id, wallet, usd, detected_at) VALUES (?1,?2,?3,?4)')
        .bind(sig.id, wallet, usd, detectedAt));
    stmts.push(env.DB.prepare('UPDATE signals_log SET wallets_logged=1, factors=?2 WHERE id=?1')
      .bind(sig.id, Array.isArray(sig.factors) ? JSON.stringify(sig.factors) : null));
    await env.DB.batch(stmts);
    return await scoreSignalAsOf(env, sig.id, ws.map(w => w.wallet), detectedAt);
  } catch (e) {
    console.log('wallet ledger log error:', e.message);
    return null;
  }
}

// Backfill, two phases, bounded per cron run:
//  A. rows with wallets_logged IS NULL: pull wallets/factors from the KV
//     signal record (30d TTL); mark -1 when the record is gone.
//  B. once A has no backlog, score rows oldest-first (scoring before the
//     history is loaded would undercount early wallets' records).
export async function backfillWalletLedger(env, limit = 150) {
  if (!env.DB || !env.SIGNALS_CACHE) return { skipped: 'no DB/KV' };
  const out = { logged: 0, unavailable: 0, scored: 0, phase: 'A' };
  try {
    const pend = await env.DB.prepare(
      'SELECT id, detected_at FROM signals_log WHERE wallets_logged IS NULL ORDER BY detected_at DESC LIMIT ?1'
    ).bind(limit).all();
    const rows = pend.results || [];
    if (rows.length) {
      const recs = await Promise.all(rows.map(r =>
        env.SIGNALS_CACHE.get(KV_SIGNAL_PREFIX + r.id, { type: 'json' }).catch(() => null)));
      const stmts = [];
      rows.forEach((r, i) => {
        const rec = recs[i];
        if (!rec) {
          stmts.push(env.DB.prepare('UPDATE signals_log SET wallets_logged=-1 WHERE id=?1').bind(r.id));
          out.unavailable++;
          return;
        }
        for (const { wallet, usd } of walletsFromSignal(rec)) {
          stmts.push(env.DB.prepare('INSERT OR IGNORE INTO signal_wallets (signal_id, wallet, usd, detected_at) VALUES (?1,?2,?3,?4)')
            .bind(r.id, wallet, usd, r.detected_at));
        }
        stmts.push(env.DB.prepare('UPDATE signals_log SET wallets_logged=1, factors=COALESCE(factors, ?2) WHERE id=?1')
          .bind(r.id, Array.isArray(rec.factors) ? JSON.stringify(rec.factors) : null));
        out.logged++;
      });
      for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
      return out;
    }
    out.phase = 'B';
    const toScore = await env.DB.prepare(
      'SELECT id, detected_at FROM signals_log WHERE wallets_logged=1 AND wallet_scored_at IS NULL ORDER BY detected_at ASC LIMIT ?1'
    ).bind(Math.min(limit, 60)).all();
    for (const r of (toScore.results || [])) {
      const ws = await env.DB.prepare('SELECT wallet FROM signal_wallets WHERE signal_id=?1').bind(r.id).all();
      await scoreSignalAsOf(env, r.id, (ws.results || []).map(x => x.wallet), r.detected_at);
      out.scored++;
    }
    if (!out.scored) out.phase = 'done';
    return out;
  } catch (e) {
    return { ...out, error: e.message };
  }
}

// Leaderboard of wallets by as-of-now skill (for the UI + sanity checks).
// `worst: true` returns the other end of the ranking (lowest excess first):
// the wallets worth fading.
export async function topWallets(env, limit = 25, minN = LEDGER_MIN_N, { worst = false } = {}) {
  if (!env.DB) return [];
  const res = await env.DB.prepare(
    `WITH h AS (SELECT sw.wallet, sl.market_slug || '|' || sl.direction_raw k, MAX(sl.outcome='WIN') win, AVG(sl.avg_entry_price) px ` +
    `FROM signal_wallets sw JOIN signals_log sl ON sl.id = sw.signal_id WHERE sl.outcome IN ('WIN','LOSS') GROUP BY sw.wallet, k) ` +
    `SELECT wallet, COUNT(*) n, ROUND(100.0*AVG(win),1) wr, ROUND(AVG(px),1) px, ROUND(100.0*AVG(win) - AVG(px),1) excess ` +
    `FROM h GROUP BY wallet HAVING n >= ?1 ORDER BY excess ${worst ? 'ASC' : 'DESC'} LIMIT ?2`
  ).bind(minN, limit).all();
  return res.results || [];
}

// The Top wallets list: the KV running records (wallet:{addr}, what the
// scanner has seen a wallet do since it was first tracked) merged with the
// D1 skill ledger above (topWallets rows { wallet, n, wr, px, excess }).
// Pure. Rank: wallets with a trusted skill score (n >= minN) by excess, then
// wallets with settled KV bets by win rate, then pending-only wallets by
// volume. A wallet that fell off the 500-entry KV index keeps its row when
// the ledger still knows it; a KV wallet with nothing settled or pending is
// dropped. `tier` is the earned KV tier, NEW (settled but unranked) or
// PENDING (nothing settled yet); null when only the ledger knows the wallet.
// Once the skill score is trusted, the row's record, win rate and settled
// count are the LEDGER's (the same bets the score is built on), so a row
// tells one story; the KV counts stay under `kv` for the detail view. KV
// only tracks a wallet that bet $1k+ on a signal, the ledger every wallet
// on it, so the two can disagree on how many bets have settled.
export function buildWalletLeaderboard(kvRows, ledgerRows, { minN = LEDGER_MIN_N, limit = 100 } = {}) {
  const byAddr = new Map();
  for (const r of ledgerRows || []) {
    const a = norm(r && r.wallet);
    if (!a) continue;
    byAddr.set(a, { address: a, skill: { n: r.n || 0, winRate: r.wr ?? null, avgPrice: r.px ?? null, excess: r.excess ?? null } });
  }
  for (const s of kvRows || []) {
    const a = norm(s && s.address);
    if (!a) continue;
    const live = (s.totalBets > 0) || (s.pending > 0);
    if (!live && !byAddr.has(a)) continue;
    const row = byAddr.get(a) || { address: a, skill: null };
    const tier = s.tier || (s.tierInfo && s.tierInfo.tier) || (s.totalBets > 0 ? 'NEW' : 'PENDING');
    Object.assign(row, {
      tier, winRate: s.winRate || 0, wins: s.wins || 0, losses: s.losses || 0,
      record: `${s.wins || 0}W-${s.losses || 0}L`, totalBets: s.totalBets || 0, pending: s.pending || 0,
      totalVolume: s.totalVolume || 0, avgBetSize: s.avgBetSize || 0,
      currentStreak: s.currentStreak || 0, bestStreak: s.bestStreak || 0,
      lastSeen: s.lastSeen || null, firstSeen: s.firstSeen || null,
    });
    byAddr.set(a, row);
  }
  const blank = { tier: null, winRate: 0, wins: 0, losses: 0, record: '0W-0L', totalBets: 0, pending: 0, totalVolume: 0, avgBetSize: 0, currentStreak: 0, bestStreak: 0, lastSeen: null, firstSeen: null };
  const rows = [...byAddr.values()].map(r => {
    const row = { ...blank, ...r };
    const s = row.skill;
    if (s && s.n >= minN && typeof s.winRate === 'number') {
      row.kv = { totalBets: row.totalBets, wins: row.wins, losses: row.losses, winRate: row.winRate };
      const wins = Math.round(s.n * s.winRate / 100);
      Object.assign(row, { totalBets: s.n, wins, losses: s.n - wins, winRate: Math.round(s.winRate), record: `${wins}W-${s.n - wins}L` });
    }
    return row;
  });
  const bucket = (r) => (r.skill && r.skill.n >= minN) ? 0 : r.totalBets > 0 ? 1 : 2;
  rows.sort((a, b) => {
    const ba = bucket(a), bb = bucket(b);
    if (ba !== bb) return ba - bb;
    if (ba === 0) return ((b.skill.excess ?? -999) - (a.skill.excess ?? -999)) || (b.skill.n - a.skill.n);
    if (ba === 1) return (b.winRate - a.winRate) || (b.totalBets - a.totalBets);
    return b.totalVolume - a.totalVolume;
  });
  return rows.slice(0, limit);
}

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
export async function topWallets(env, limit = 25, minN = LEDGER_MIN_N) {
  if (!env.DB) return [];
  const res = await env.DB.prepare(
    `WITH h AS (SELECT sw.wallet, sl.market_slug || '|' || sl.direction_raw k, MAX(sl.outcome='WIN') win, AVG(sl.avg_entry_price) px ` +
    `FROM signal_wallets sw JOIN signals_log sl ON sl.id = sw.signal_id WHERE sl.outcome IN ('WIN','LOSS') GROUP BY sw.wallet, k) ` +
    `SELECT wallet, COUNT(*) n, ROUND(100.0*AVG(win),1) wr, ROUND(AVG(px),1) px, ROUND(100.0*AVG(win) - AVG(px),1) excess ` +
    `FROM h GROUP BY wallet HAVING n >= ?1 ORDER BY excess DESC LIMIT ?2`
  ).bind(minN, limit).all();
  return res.results || [];
}

// Wallet ledger: wallet extraction, best-wallet selection, backfill phases.
// Run with: node test/wallet-ledger.test.mjs
import { walletsFromSignal, bestWallet, backfillWalletLedger, logSignalWallets } from "../src/wallet-ledger.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };

// 1. Extraction: lowercases, dedupes, prefers topTrades size, caps at 10
{
  const ws = walletsFromSignal({
    topTrades: [{ wallet: "0xAA", amount: 50000 }, { wallet: "0xaa", amount: 100 }, { wallet: "0xBB", amount: 9000 }],
    wallets: ["0xbb", "0xCC", ...Array.from({ length: 20 }, (_, i) => `0x${i}`)],
  });
  check("1: dedupe+lower", ws[0].wallet === "0xaa" && ws[0].usd === 50000 && ws.filter(w => w.wallet === "0xaa").length === 1, JSON.stringify(ws));
  check("1: keeps topTrades size over bare list", ws.find(w => w.wallet === "0xbb").usd === 9000);
  check("1: bare wallet null usd", ws.find(w => w.wallet === "0xcc").usd === null);
  check("1: cap 10", ws.length === 10, ws.length);
}
// 2. bestWallet: trusted (n>=10) beats untrusted even with lower excess; among trusted, max excess
{
  const b = bestWallet([
    { wallet: "a", n: 4, wr: 100, px: 40 },     // +60 but n=4
    { wallet: "b", n: 25, wr: 60, px: 50 },     // +10
    { wallet: "c", n: 30, wr: 70, px: 65 },     // +5
  ]);
  check("2: trusted max excess", b.wallet === "b" && b.excess === 10 && b.n === 25, JSON.stringify(b));
  const u = bestWallet([{ wallet: "x", n: 3, wr: 66, px: 50 }, { wallet: "y", n: 7, wr: 40, px: 50 }]);
  check("2: none trusted -> most history", u.wallet === "y", JSON.stringify(u));
  check("2: empty", bestWallet([]).wallet === null);
}

// Fake D1 that records statements and answers the few SELECTs used.
function fakeEnv({ pending = [], toScore = [], kv = {}, history = [] }) {
  const writes = [];
  const DB = {
    prepare(sql) {
      const st = { sql, args: [] };
      st.bind = (...a) => { st.args = a; return st; };
      st.all = async () => {
        if (/wallets_logged IS NULL/.test(sql)) return { results: pending };
        if (/wallet_scored_at IS NULL/.test(sql)) return { results: toScore };
        if (/FROM signal_wallets WHERE signal_id/.test(sql)) return { results: [{ wallet: "0xaa" }] };
        if (/WITH h AS/.test(sql)) return { results: history };
        return { results: [] };
      };
      st.run = async () => { writes.push(st); return {}; };
      return st;
    },
    batch: async (stmts) => { writes.push(...stmts); return []; },
  };
  return { DB, SIGNALS_CACHE: { get: async (k) => kv[k] ?? null }, writes };
}

// 3. Phase A: logs wallets from KV, marks missing records -1
{
  const env = fakeEnv({
    pending: [{ id: "s1", detected_at: "2026-10-01T00:00:00Z" }, { id: "s2", detected_at: "2026-10-01T00:00:00Z" }],
    kv: { "signal:s1": { wallets: ["0xAA", "0xBB"], factors: ["eliteWallet"] } },
  });
  const r = await backfillWalletLedger(env, 10);
  check("3: phase A", r.phase === "A" && r.logged === 1 && r.unavailable === 1, JSON.stringify(r));
  const ins = env.writes.filter(w => /INSERT OR IGNORE INTO signal_wallets/.test(w.sql));
  check("3: two wallet rows", ins.length === 2 && ins[0].args[3] === "2026-10-01T00:00:00Z", JSON.stringify(ins.map(i => i.args)));
  check("3: -1 for missing", env.writes.some(w => /wallets_logged=-1/.test(w.sql) && w.args[0] === "s2"));
  check("3: factors saved", env.writes.some(w => /factors=COALESCE/.test(w.sql) && w.args[1] === '["eliteWallet"]'));
}
// 4. Phase B: scores oldest-first using as-of = detected_at
{
  const env = fakeEnv({ toScore: [{ id: "s9", detected_at: "2026-09-20T00:00:00Z" }], history: [{ wallet: "0xaa", n: 12, wr: 58, px: 45 }] });
  const r = await backfillWalletLedger(env, 10);
  check("4: phase B scored", r.phase === "B" && r.scored === 1, JSON.stringify(r));
  const hist = env.writes.length; // history query isn't a write; check the UPDATE
  const upd = env.writes.find(w => /SET wallet_best=/.test(w.sql));
  check("4: score written", upd && upd.args[1] === "0xaa" && upd.args[2] === 12 && upd.args[3] === 13, JSON.stringify(upd && upd.args));
}
// 5. Nothing pending -> done
{
  const r = await backfillWalletLedger(fakeEnv({}), 10);
  check("5: done", r.phase === "done", JSON.stringify(r));
}
// 6. Live path writes wallets + factors and scores as of detection
{
  const env = fakeEnv({ history: [] });
  const best = await logSignalWallets(env, { id: "L1", detectedAt: "2026-10-10T00:00:00Z", factors: ["lastMinute2h"], topTrades: [{ wallet: "0xAA", amount: 20000 }] });
  check("6: wallet row", env.writes.some(w => /INSERT OR IGNORE INTO signal_wallets/.test(w.sql) && w.args[2] === 20000));
  check("6: logged flag", env.writes.some(w => /wallets_logged=1, factors=\?2/.test(w.sql) && w.args[1] === '["lastMinute2h"]'));
  check("6: score with no history", best && best.n === 0, JSON.stringify(best));
}
// 7. No DB -> no throw
{
  check("7: no DB", (await logSignalWallets({}, { id: "x" })) === null);
}

console.log(`# ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

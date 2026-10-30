// The proven record behind a whale signal. Run with: node test/signal-skill.test.mjs
import { walletSkillMany, onChainSkillMany, skillRows, whaleCall, annotateSignalWalletSkill, maskWhaleSkill, PROVEN_PTS, LOSER_PTS } from "../src/signal-skill.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const row = (n, wr, px, source = 'signals') => ({ n, winRate: wr, avgPrice: px, excess: Math.round((wr - px) * 10) / 10, source });

{
  // skillRows: trusted ledger beats on-chain, on-chain stands in when the ledger is thin, untrusted rows still show
  const sig = { topTrades: [{ wallet: "0xAA", amount: 50000 }, { wallet: "0xBB", amount: 9000 }, { wallet: "0xCC", amount: 500 }], wallets: ["0xdd"] };
  const ledger = new Map([["0xaa", row(25, 60, 50)], ["0xbb", row(4, 75, 50)], ["0xcc", row(12, 40, 52)]]);
  const chain = new Map([["0xaa", row(80, 55, 54, 'onchain')], ["0xbb", row(30, 58, 47, 'onchain')]]);
  const rows = skillRows(sig, ledger, chain);
  check("rows: ledger when trusted, on-chain when the ledger is thin, untrusted kept, unknown null",
    rows.length === 4 && rows[0].wallet === "0xaa" && rows[0].usd === 50000 && rows[0].skill.source === 'signals' && rows[0].skill.excess === 10 && rows[0].skill.trusted
    && rows[1].skill.source === 'onchain' && rows[1].skill.excess === 11 && rows[1].skill.trusted
    && rows[2].skill.source === 'signals' && rows[2].skill.excess === -12 && rows[2].skill.trusted
    && rows[3].skill === null, JSON.stringify(rows));
  const c = whaleCall(rows);
  check("call: best trusted by excess is proven, worst is the trusted loser, biggest money named, no fade when the big wallet is a winner",
    c.call === 'proven' && c.best.wallet === "0xbb" && c.worst.wallet === "0xcc" && c.biggest.wallet === "0xaa" && c.fade === false && c.trusted === 3 && c.thin === null, JSON.stringify(c));
  // thresholds
  const one = (x, n = 20) => whaleCall([{ wallet: "w", usd: 100, skill: { n, winRate: 50 + x, avgPrice: 50, excess: x, source: 'signals', trusted: n >= 10 } }]);
  check("call: thresholds", one(PROVEN_PTS).call === 'proven' && one(7.9).call === 'edge' && one(3).call === 'edge' && one(2.9).call === 'flat' && one(-2.9).call === 'flat' && one(-3).call === 'losing' && one(-20).call === 'losing');
  check("call: untrusted record -> unproven with `thin` = the most history", one(30, 4).call === 'unproven' && one(30, 4).thin.skill.n === 4 && one(30, 4).best === null);
  check("call: the biggest wallet a trusted loser -> fade, even beside a proven one",
    whaleCall([{ wallet: "big", usd: 90000, skill: { ...row(15, 40, 55), trusted: true } }, { wallet: "small", usd: 2000, skill: { ...row(40, 70, 50), trusted: true } }]).fade === true
    && whaleCall([{ wallet: "big", usd: 90000, skill: { ...row(15, 40, 55), trusted: true } }, { wallet: "small", usd: 2000, skill: { ...row(40, 70, 50), trusted: true } }]).call === 'proven'
    && whaleCall([{ wallet: "big", usd: 90000, skill: { ...row(5, 40, 55), trusted: false } }]).fade === false);
  check("call: empty", whaleCall([]).call === 'unproven' && whaleCall([]).best === null && whaleCall([]).biggest === null);
  const masked = maskWhaleSkill({ ...c, wallets: rows }, (w) => w.slice(0, 4) + "…");
  check("mask: every address shortened", masked.best.wallet === "0xbb…" && masked.worst.wallet === "0xcc…" && masked.wallets[0].wallet === "0xaa…" && masked.wallets[3].skill === null && maskWhaleSkill(null, (w) => w) === null, JSON.stringify(masked));
}
{
  // D1 + KV with mocks: chunking, index-bounded KV reads, the annotation and its legacy flags
  const queries = []; const kvReads = [];
  const ledgerRows = { "0xaa": { wallet: "0xaa", n: 25, wr: 60, px: 50, excess: 10 }, "0xcc": { wallet: "0xcc", n: 12, wr: 40, px: 52, excess: -12 }, "0xzz": { wallet: "0xzz", n: 3, wr: 100, px: 30, excess: 70 } };
  const env = {
    DB: { prepare: (sql) => ({ bind: (...a) => ({ all: async () => { queries.push(a.length); return { results: a.map(w => ledgerRows[w]).filter(Boolean) }; } }) }) },
    SIGNALS_CACHE: { get: async (k) => { kvReads.push(k); if (k === "wallet_onchain_index") return { "0xbb": { at: "x", v: 3 }, "0xqq": { at: "x", v: 3 } }; if (k === "wallet_onchain:0xbb") return { skill: { n: 30, winRate: 58, avgPrice: 47, excess: 11 }, totalPnL: 1200, windowDays: 20 }; return null; } },
  };
  const many = Array.from({ length: 130 }, (_, i) => `0x${String(i).padStart(3, "0")}`);
  await walletSkillMany(env, many);
  check("ledger: 130 wallets -> 3 chunked queries", queries.length === 3 && queries[0] === 60 && queries[2] === 10, JSON.stringify(queries));
  queries.length = 0;
  const chain = await onChainSkillMany(env, ["0xaa", "0xbb", "0xcc", "0xqq"]);
  check("on-chain: only indexed wallets are read, a record without skill is skipped", chain.size === 1 && chain.get("0xbb").source === 'onchain' && kvReads.filter(k => k.startsWith("wallet_onchain:")).length === 2, JSON.stringify(kvReads));
  const signals = [
    { id: "s1", topTrades: [{ wallet: "0xAA", amount: 50000 }, { wallet: "0xBB", amount: 9000 }], wallets: ["0xzz"] },
    { id: "s2", topTrades: [{ wallet: "0xCC", amount: 20000 }, { wallet: "0xAA", amount: 1000 }] },
    { id: "s3", topTrades: [{ wallet: "0xZZ", amount: 3000 }] },
  ];
  const st = await annotateSignalWalletSkill(env, signals);
  const [s1, s2, s3] = signals;
  check("annotate: stats", st.annotated === 3 && st.wallets === 4 && st.ledger === 3 && st.onchain === 1 && st.proven === 2 && st.fades === 1, JSON.stringify(st));
  check("annotate: s1 proven via the on-chain wallet, legacy flags set on the trades and the signal",
    s1.whaleSkill.call === 'proven' && s1.whaleSkill.best.wallet === "0xbb" && s1.hasWinningWallet === true && /30 settled bets, \+11 pts/.test(s1.winningWalletInfo.record) && s1.winningWalletInfo.source === 'onchain'
    && s1.topTrades[0].skill.excess === 10 && s1.topTrades[0].isWinner === true && s1.topTrades[1].isWinner === true && s1.topTrades[1].winnerInfo.n === 30, JSON.stringify(s1.whaleSkill));
  check("annotate: s2 is a fade (the big wallet is a trusted loser) though 0xaa is proven", s2.whaleSkill.fade === true && s2.whaleSkill.call === 'proven' && s2.whaleSkill.biggest.wallet === "0xcc" && s2.topTrades[0].isWinner === false, JSON.stringify(s2.whaleSkill));
  check("annotate: s3 unproven, thin record shown, no winner flags", s3.whaleSkill.call === 'unproven' && s3.whaleSkill.thin.skill.n === 3 && s3.hasWinningWallet === false && s3.winningWalletInfo === null && s3.topTrades[0].isWinner === false);
  // a failing D1 never fails the scan
  const bad = { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("boom"); } }) }) }, SIGNALS_CACHE: env.SIGNALS_CACHE };
  const sig = [{ id: "x", topTrades: [{ wallet: "0xaa", amount: 5 }] }];
  const st2 = await annotateSignalWalletSkill(bad, sig);
  check("annotate: D1 failure -> unproven, no throw", st2.ledger === 0 && sig[0].whaleSkill.call === 'unproven');
  check("annotate: empty list", (await annotateSignalWalletSkill(env, [])).annotated === 0);
}
console.log(`signal-skill: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

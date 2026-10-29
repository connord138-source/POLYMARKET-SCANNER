// Top wallets list: KV records merged with the D1 skill ledger. Run with: node test/wallet-leaderboard.test.mjs
import { buildWalletLeaderboard } from "../src/wallet-ledger.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };

const kv = (address, o = {}) => ({ address, totalBets: 0, wins: 0, losses: 0, pending: 0, winRate: 0, totalVolume: 0, avgBetSize: 0, currentStreak: 0, bestStreak: 0, tier: null, ...o });
const ledger = [
  { wallet: "0xAAA", n: 14, wr: 78.6, px: 42, excess: 36.5 },
  { wallet: "0xbbb", n: 10, wr: 100, px: 65.8, excess: 34.2 },
  { wallet: "0xccc", n: 12, wr: 40, px: 55, excess: -15 },
  { wallet: "0xold", n: 11, wr: 70, px: 50, excess: 20 },   // fell off the KV index
  { wallet: "0xfew", n: 3, wr: 100, px: 30, excess: 70 },   // not trusted yet
];
const kvRows = [
  kv("0xaaa", { totalBets: 14, wins: 11, losses: 3, winRate: 79, totalVolume: 120000, tier: "ELITE", pending: 2, currentStreak: 3 }),
  kv("0xbbb", { totalBets: 10, wins: 10, losses: 0, winRate: 100, totalVolume: 9000, tierInfo: { tier: "AVERAGE" } }),
  kv("0xccc", { totalBets: 12, wins: 5, losses: 7, winRate: 42, totalVolume: 30000 }),
  kv("0xfew", { totalBets: 3, wins: 3, losses: 0, winRate: 100, totalVolume: 4000 }),
  kv("0xsettled", { totalBets: 6, wins: 4, losses: 2, winRate: 67, totalVolume: 2000 }),
  kv("0xpend1", { pending: 3, totalVolume: 50000 }),
  kv("0xpend2", { pending: 1, totalVolume: 80000 }),
  kv("0xnothing", {}),
  null,
];

const rows = buildWalletLeaderboard(kvRows, ledger, { minN: 10 });
const order = rows.map(r => r.address);
check("trusted skill first, by excess; then settled by win rate; then pending by volume",
  JSON.stringify(order) === JSON.stringify(["0xaaa", "0xbbb", "0xold", "0xccc", "0xfew", "0xsettled", "0xpend2", "0xpend1"]), order);
check("a wallet with nothing settled or pending is dropped", !order.includes("0xnothing"));
const a = rows[0];
check("KV fields and skill merge on one row; record follows the ledger once the score is trusted", a.tier === "ELITE" && a.record === "11W-3L" && a.totalBets === 14 && a.winRate === 79 && a.pending === 2 && a.currentStreak === 3 && a.skill.excess === 36.5 && a.skill.n === 14 && a.skill.avgPrice === 42 && a.kv.totalBets === 14, a);
const b = rows[1];
check("ledger record overrides a KV record that counted different bets, KV kept under kv", b.record === "10W-0L" && b.winRate === 100 && b.kv.wins === 10, b);
check("tierInfo.tier is used when tier is unset", rows[1].tier === "AVERAGE");
check("settled but unranked reads NEW, pending-only reads PENDING", rows[3].tier === "NEW" && rows[6].tier === "PENDING" && rows[7].tier === "PENDING");
const old = rows.find(r => r.address === "0xold");
check("ledger-only wallet: no tier, record from the ledger", old && old.tier === null && old.totalBets === 11 && old.record === "8W-3L" && old.winRate === 70 && old.pending === 0 && old.skill.excess === 20, old);
check("untrusted skill rides along but does not rank the wallet or replace its KV record", rows[4].address === "0xfew" && rows[4].skill.n === 3 && rows[4].record === "3W-0L" && !rows[4].kv);
check("limit applies", buildWalletLeaderboard(kvRows, ledger, { minN: 10, limit: 2 }).length === 2);
check("empty inputs", buildWalletLeaderboard([], []).length === 0 && buildWalletLeaderboard(null, undefined).length === 0);

console.log(`wallet-leaderboard: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

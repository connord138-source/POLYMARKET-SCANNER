// Market-making depth collector. Run with: node test/mm-collector.test.mjs
import { pickMarkets, scoreBook, collectBooks, kindOf } from "../src/mm-collector.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };

check("kind", kindOf("nfl-sf-sea-2026-10-11") === "nfl" && kindOf("will-x-happen") === "other" && kindOf("cfb-a-b-2026-10-10-spread") === "cfb");
{
  const g = (o) => ({ conditionId: "c" + Math.random(), clobTokenIds: '["t0","t1"]', slug: "x", question: "q", clobRewards: [{ rewardsDailyRate: 500 }], rewardsMinSize: 100, rewardsMaxSpread: 3.5, ...o });
  const picked = pickMarkets([g({ clobRewards: [{ rewardsDailyRate: 50 }] }), g({ closed: true }), g({ acceptingOrders: false }),
    g({ slug: "nfl-a-b-2026-10-12", gameStartTime: "2026-10-12 00:20:00+00", clobRewards: [{ rewardsDailyRate: 15771 }], rewardsMinSize: 1000, rewardsMaxSpread: 2.5 }), g({})], { max: 10 });
  check("pick: pool floor, closed, not-accepting dropped; sorted by pool", picked.length === 2 && picked[0].pool === 15771 && picked[0].kind === "nfl" && picked[0].gameStart === Math.floor(Date.parse("2026-10-12T00:20:00Z") / 1000) && picked[0].tokenId === "t0", JSON.stringify(picked));
  check("pick: cap", pickMarkets(Array.from({ length: 80 }, () => g({})), { max: 60 }).length === 60);
}
{
  // v = 2.5c; mid 0.345; a 1c spread puts the touch 0.5c from mid -> weight ((2.5-0.5)/2.5)^2 = 0.64
  const s = scoreBook({ bids: [{ price: "0.34", size: "1000" }, { price: "0.33", size: "500" }, { price: "0.30", size: "9999" }], asks: [{ price: "0.35", size: "2000" }, { price: "0.37", size: "100" }], last_trade_price: "0.35" }, 2.5);
  check("score: touch weight 0.64, 1.5c level 0.16, beyond band 0", Math.abs(s.qBid - (1000 * 0.64 + 500 * 0.16)) < 1e-6 && Math.abs(s.qAsk - (2000 * 0.64 + 0)) < 1e-6, JSON.stringify(s));
  check("score: best/mid/spread/depth", s.bestBid === 0.34 && s.bestAsk === 0.35 && s.mid === 0.345 && s.spreadC === 1 && Math.abs(s.depthBidUsd - (340 + 165)) < 1e-6 && s.touchAskSh === 2000 && s.lastTrade === 0.35);
  check("score: empty side -> null", scoreBook({ bids: [], asks: [{ price: "0.5", size: "1" }] }, 2.5) === null);
}
{
  // end-to-end with mocked Gamma, CLOB and D1
  const rows = []; let batches = 0;
  const env = { DB: { prepare: (sql) => ({ bind: (...a) => ({ sql, a, run: async () => {} }), run: async () => {} }), batch: async (st) => { batches++; rows.push(...st); } } };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("gamma-api")) return { ok: true, json: async () => [{ conditionId: "c1", clobTokenIds: '["t0","t1"]', slug: "nfl-a-b-2026-10-12", question: "A vs. B", clobRewards: [{ rewardsDailyRate: 15771 }], rewardsMinSize: 1000, rewardsMaxSpread: 2.5, gameStartTime: "2026-10-12 00:20:00+00" }, { conditionId: "c2", clobTokenIds: '["t2","t3"]', slug: "y", question: "Y", clobRewards: [{ rewardsDailyRate: 400 }], rewardsMaxSpread: 3.5 }] };
    if (u.includes("/book?token_id=t0")) return { ok: true, json: async () => ({ bids: [{ price: "0.61", size: "100" }], asks: [{ price: "0.62", size: "100" }] }) };
    return { ok: false, status: 500 };
  };
  const r = await collectBooks(env, Date.parse("2026-10-11T23:10:00Z"));
  check("collect: one row per fetched book, failures counted", r.markets === 2 && r.rows === 1 && r.failed === 1 && batches === 1 && rows[0].a[1] === "c1" && rows[0].a[12] === 0.615, JSON.stringify(r));
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

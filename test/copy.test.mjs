// Copy-a-whale lane: pick building, queue merging, the ledger. Run with: node test/copy.test.mjs
import { picksFromActivity, mergePicks, copyLedger, isWalletAddress, addCopyWallet, pollCopyWallets, listCopyWallets, setCopyWalletMode, modeOf } from "../src/copy.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const kv = () => { const m = new Map(); return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, _m: m }; };

const W = "0xF3CE7f04dde4f8c5aed19a20e5ecd8520e5ca57a";
const now = Date.parse("2026-10-30T02:00:00Z");
const t = (minAgo) => Math.round((now - minAgo * 60e3) / 1000);   // seconds, like the data-api
const acts = [
  { type: "TRADE", side: "BUY", slug: "lol-kc-vs-ctbc-g2", eventSlug: "lol-kc-vs-ctbc", title: "LoL: KC vs CTBC - Game 2", outcome: "Karmine Corp", outcomeIndex: 0, usdcSize: "5554", price: "0.58", timestamp: t(4) },
  { type: "TRADE", side: "BUY", slug: "lol-kc-vs-ctbc-g2", eventSlug: "lol-kc-vs-ctbc", title: "LoL: KC vs CTBC - Game 2", outcome: "Karmine Corp", outcomeIndex: 0, usdcSize: "6304", price: "0.56", timestamp: t(3) },
  { type: "TRADE", side: "BUY", slug: "nba-lal-bos-2026-10-30", title: "Lakers vs. Celtics", outcome: "Lakers", usdcSize: "202", price: "0.44", timestamp: t(2) },   // too small
  { type: "TRADE", side: "SELL", slug: "nba-x", title: "x", outcome: "Yes", usdcSize: "9000", price: "0.5", timestamp: t(1) },                                         // a sell
  { type: "TRADE", side: "BUY", slug: "old-market", title: "old", outcome: "Yes", usdcSize: "9000", price: "0.5", timestamp: t(400) },                                   // older than the window
  { type: "TRADE", side: "BUY", slug: "before-add", title: "before", outcome: "No", usdcSize: "9000", price: "0.5", timestamp: t(30) },                                    // before sinceTs
  { type: "REDEEM", usdcSize: "1200", timestamp: t(1) },
];
const picks = picksFromActivity(W, acts, (now - 20 * 60e3), { minUsd: 500, nowMs: now, maxAgeMin: 60 });
check("one pick: two clips grouped, small / sell / old / pre-add skipped", picks.length === 1 && picks[0].marketSlug === "lol-kc-vs-ctbc-g2", picks);
const p = picks[0];
check("pick carries the wallet (lowercase), outcome, size and share-weighted price", p.wallet === W.toLowerCase() && p.outcome === "Karmine Corp" && p.usd === 11858 && p.price === 57 && p.trades === 2 && p.eventSlug === "lol-kc-vs-ctbc", p);
check("pick id is stable", p.id === `${W.toLowerCase()}:lol-kc-vs-ctbc-g2:karmine corp:${t(4)}`, p.id);
check("address check", isWalletAddress(W) && !isWalletAddress("0x123") && !isWalletAddress("leungchihang"));

const m1 = mergePicks([], picks, []);
const m2 = mergePicks(m1.queue, picks, []);
const m3 = mergePicks([], picks, [p.id]);
check("merge: adds once, never a duplicate, never an entered pick", m1.added === 1 && m2.added === 0 && m2.queue.length === 1 && m3.added === 0);

const led = copyLedger(
  [{ strategySource: "whale_copy", copyOf: "0xa", outcome: "win", pnl: 4.2, size: 5 }, { strategySource: "whale_copy", copyOf: "0xa", outcome: "loss", pnl: -5, size: 5 }, { strategySource: "crew_hunt", copyOf: "0xa", outcome: "win", pnl: 9 }],
  [{ strategySource: "whale_copy", copyOf: "0xa" }, { strategySource: "whale_copy", copyOf: "0xb" }], []);
check("ledger per wallet and total", led.perWallet["0xa"].wins === 1 && led.perWallet["0xa"].losses === 1 && led.perWallet["0xa"].open === 1 && led.perWallet["0xa"].pnl === -0.8 && led.perWallet["0xb"].open === 1 && led.total.open === 2 && led.total.pnl === -0.8, led);

// add + poll against a fake feed
const env = { SIGNALS_CACHE: kv() };
const add = await addCopyWallet(env, { address: W, nickname: "heater" }, now - 20 * 60e3, { officialBook: async () => ({ lifetime: 580358, pnl30d: 158111, at: "2026-10-29T23:00:00Z" }) });
check("add: lowercased, enabled, follow-only by default, starts from now, book marked", add.ok && add.wallet.address === W.toLowerCase() && add.wallet.enabled && add.wallet.mode === "follow" && add.wallet.lastSeenTs === now - 20 * 60e3 && add.wallet.bookAtAdd.lifetime === 580358, add);
check("add: duplicate refused", (await addCopyWallet(env, { address: W })).ok === false);
check("entries from before modes count as copy", modeOf({ address: "0xa" }) === "copy" && modeOf({ mode: "follow" }) === "follow");
const fakeFetch = async () => ({ ok: true, json: async () => acts });
const stat = await pollCopyWallets(env, { copyMinWhaleUsd: 500 }, now, fakeFetch);
const queue = JSON.parse(env.SIGNALS_CACHE._m.get("copy_picks"));
const wl = await listCopyWallets(env);
const recent = JSON.parse(env.SIGNALS_CACHE._m.get("copy_recent:" + W.toLowerCase()));
check("poll a followed wallet: the bet is recorded, nothing queued, wallet advanced", stat.polled === 1 && stat.seen === 1 && stat.queued === 0 && queue.length === 0 && recent.length === 1 && recent[0].outcome === "Karmine Corp" && wl[0].lastSeenTs === t(1) * 1000 && wl[0].seen === 1, { stat, queue, wl, recent });
const flip = await setCopyWalletMode(env, W, "copy", now - 10 * 60e3);
check("flip to copy: the clock never moves backwards, nothing replayed", flip.ok && flip.wallet.mode === "copy" && flip.wallet.lastSeenTs === t(1) * 1000, flip);
const acts2 = [...acts, { type: "TRADE", side: "BUY", slug: "nba-gsw-min-2026-10-30", title: "Warriors vs. Timberwolves", outcome: "Warriors", usdcSize: "4000", price: "0.52", timestamp: t(0.5) }];
const stat2 = await pollCopyWallets(env, { copyMinWhaleUsd: 500 }, now + 60e3, async () => ({ ok: true, json: async () => acts2 }));
const queue2 = JSON.parse(env.SIGNALS_CACHE._m.get("copy_picks"));
check("poll a copied wallet: the new bet is queued with the nickname, the old one is not replayed", stat2.queued === 1 && queue2.length === 1 && queue2[0].outcome === "Warriors" && queue2[0].nickname === "heater", { stat2, queue2 });
const back = await setCopyWalletMode(env, W, "follow", now + 120e3);
check("flip back to follow: queue cleared", back.ok && JSON.parse(env.SIGNALS_CACHE._m.get("copy_picks")).length === 0);

console.log(`copy: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

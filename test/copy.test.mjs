// Copy-a-whale lane: pick building, queue merging, the ledger. Run with: node test/copy.test.mjs
import { picksFromActivity, mergePicks, copyLedger, isWalletAddress, addCopyWallet, pollCopyWallets, listCopyWallets } from "../src/copy.js";
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
const add = await addCopyWallet(env, { address: W, nickname: "heater" }, now - 20 * 60e3);
check("add: lowercased, enabled, starts from now", add.ok && add.wallet.address === W.toLowerCase() && add.wallet.enabled && add.wallet.lastSeenTs === now - 20 * 60e3, add);
check("add: duplicate refused", (await addCopyWallet(env, { address: W })).ok === false);
const fakeFetch = async () => ({ ok: true, json: async () => acts });
const stat = await pollCopyWallets(env, { copyMinWhaleUsd: 500 }, now, fakeFetch);
const queue = JSON.parse(env.SIGNALS_CACHE._m.get("copy_picks"));
const wl = await listCopyWallets(env);
check("poll: one pick queued with the nickname, wallet advanced to the newest trade", stat.polled === 1 && stat.queued === 1 && queue.length === 1 && queue[0].nickname === "heater" && wl[0].lastSeenTs === t(1) * 1000 && wl[0].queued === 1, { stat, queue, wl });
const stat2 = await pollCopyWallets(env, { copyMinWhaleUsd: 500 }, now + 60e3, fakeFetch);
check("poll again: nothing new", stat2.queued === 0 && JSON.parse(env.SIGNALS_CACHE._m.get("copy_picks")).length === 1);

console.log(`copy: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

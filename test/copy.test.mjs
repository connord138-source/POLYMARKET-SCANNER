// Copy-a-whale lane: pick building, queue merging, the ledger. Run with: node test/copy.test.mjs
import { picksFromActivity, mergePicks, copyLedger, isWalletAddress, addCopyWallet, pollCopyWallets, listCopyWallets, setCopyWalletMode, modeOf, copySettingsUpdates, setCopyWalletSize, unseenBets, getUnseenBets, markCopySeen, UNSEEN_FIRST_LOOK_H } from "../src/copy.js";
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

// amounts: lane settings (validated, mapped to the autotrader config keys)
const s1 = copySettingsUpdates({ betSize: "12.5", maxOpen: 20, minWhaleUsd: 1000, entries: false, maxAgeMin: "" });
check("settings: a valid body maps to the config keys, blanks ignored", s1.ok && s1.updates.copyBetSize === 12.5 && s1.updates.copyMaxOpen === 20 && s1.updates.copyMinWhaleUsd === 1000 && s1.updates.copyEntries === false && Object.keys(s1.updates).length === 4, s1);
check("settings: out of range or not a number refused", copySettingsUpdates({ betSize: 0 }).ok === false && copySettingsUpdates({ maxSlipPts: 99 }).ok === false && copySettingsUpdates({ maxOpen: "x" }).ok === false && copySettingsUpdates({ betSize: 501 }).ok === false);
check("settings: nothing to change refused", copySettingsUpdates({}).ok === false && copySettingsUpdates({ bogus: 3 }).ok === false);
check("settings: whole numbers rounded, stake to cents", copySettingsUpdates({ maxPerDay: 7.6, betSize: 9.999 }).updates.copyMaxPerDay === 8 && copySettingsUpdates({ betSize: 9.999 }).updates.copyBetSize === 10);
// amounts: a wallet's own stake rides on the picks it queues
const env2 = { SIGNALS_CACHE: kv() };
await addCopyWallet(env2, { address: W, nickname: "heater", mode: "copy" }, now - 20 * 60e3, {});
const sz = await setCopyWalletSize(env2, W, 25);
check("size: stored on the wallet", sz.ok && sz.wallet.betSize === 25, sz);
check("size: out of range or unknown wallet refused", (await setCopyWalletSize(env2, W, 5000)).ok === false && (await setCopyWalletSize(env2, "0x" + "1".repeat(40), 5)).ok === false);
await pollCopyWallets(env2, { copyMinWhaleUsd: 500 }, now, fakeFetch);
const q2 = JSON.parse(env2.SIGNALS_CACHE._m.get("copy_picks"));
check("size: the queued pick carries the wallet's stake", q2.length === 1 && q2[0].betSize === 25, q2);
const cleared = await setCopyWalletSize(env2, W, null);
check("size: cleared back to the lane default", cleared.ok && cleared.wallet.betSize === undefined && (await listCopyWallets(env2))[0].betSize === undefined);
const sizedLog = JSON.parse(env2.SIGNALS_CACHE._m.get("copy_log")).filter(e => e.type === "sized");
check("size: logged both ways", sizedLog.length === 2 && sizedLog[0].betSize === 25 && sizedLog[1].betSize === null, sizedLog);

// ---------- what a member has not seen yet ----------
{
  check("poll: a recorded bet carries when the poller found it", recent[0].foundAt === new Date(now).toISOString(), recent[0]);
  const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40);
  const T0 = Date.parse("2026-10-31T12:00:00Z");
  const wallets = [{ address: A, nickname: "Ace", mode: "follow", enabled: true }, { address: B, nickname: "", mode: "copy", enabled: true }];
  const recents = {
    [A]: [{ id: "a1", title: "Lakers vs. Celtics", outcome: "Lakers", usd: 1200, price: 44, at: new Date(T0 - 3 * 3600e3).toISOString(), foundAt: new Date(T0 - 2 * 3600e3).toISOString() },
          { id: "a2", title: "Old one", outcome: "Yes", usd: 900, price: 60, at: new Date(T0 - 30 * 3600e3).toISOString(), foundAt: new Date(T0 - 29 * 3600e3).toISOString() },
          { id: "a0", title: "Legacy row without foundAt", outcome: "No", usd: 700, price: 30, at: new Date(T0 - 1 * 3600e3).toISOString() }],
    [B]: [{ id: "b1", title: "BTC above 100k", outcome: "Yes", usd: 2500, price: 52, at: new Date(T0 - 10 * 3600e3).toISOString(), foundAt: new Date(T0 - 20 * 60e3).toISOString() }],
  };
  const u = unseenBets(wallets, recents, T0 - 24 * 3600e3);
  check("unseen: bets found after the mark, newest found first, the legacy row read by its trade time, the old one left out", u.count === 3 && u.bets.map(b => b.id).join() === "b1,a0,a1" && u.wallets === 2 && u.usd === 4400 && u.perWallet[A] === 2 && u.perWallet[B] === 1 && u.newestAt === recents[B][0].foundAt && u.bets[0].nickname === null && u.bets[0].mode === "copy" && u.bets[2].nickname === "Ace", JSON.stringify(u));
  check("unseen: a bet found minutes after the member looked is still new to them (foundAt beats the trade time)", unseenBets(wallets, recents, T0 - 90 * 60e3).bets.map(b => b.id).join() === "b1,a0" && unseenBets(wallets, recents, T0).count === 0);
  check("unseen: max rows", unseenBets(wallets, recents, 0, { max: 1 }).bets.length === 1 && unseenBets(wallets, recents, 0).count === 4);
  // KV round trip: the first look covers the last day; the mark clears it; a mark in the future is clamped to now
  const kv = new Map();
  const env = { SIGNALS_CACHE: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => { kv.set(k, v); } } };
  kv.set("copy_wallets", JSON.stringify(wallets)); kv.set("copy_recent:" + A, JSON.stringify(recents[A])); kv.set("copy_recent:" + B, JSON.stringify(recents[B]));
  const first = await getUnseenBets(env, "u1", T0);
  check("unseen: first look = the last 24h, flagged firstLook", first.firstLook && first.seenAt === null && first.count === 3 && first.since === new Date(T0 - UNSEEN_FIRST_LOOK_H * 3600e3).toISOString(), JSON.stringify({ ...first, bets: first.bets.length }));
  const mark = await markCopySeen(env, "u1", new Date(T0 + 3600e3).toISOString(), T0);
  const after = await getUnseenBets(env, "u1", T0 + 60e3);
  check("unseen: the mark is per member, clamped to now, and clears the list; another member still sees theirs", mark.at === new Date(T0).toISOString() && after.count === 0 && !after.firstLook && after.seenAt === mark.at && (await getUnseenBets(env, "u2", T0)).count === 3, JSON.stringify({ mark, after: { ...after, bets: after.bets.length } }));
  kv.set("copy_recent:" + A, JSON.stringify([...recents[A], { id: "a9", title: "Fresh", outcome: "Yes", usd: 600, price: 50, at: new Date(T0 - 5 * 60e3).toISOString(), foundAt: new Date(T0 + 5 * 60e3).toISOString() }]));
  check("unseen: a bet the poller finds after the mark shows up, even though it traded before it", (await getUnseenBets(env, "u1", T0 + 10 * 60e3)).bets.map(b => b.id).join() === "a9");
}
console.log(`copy: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

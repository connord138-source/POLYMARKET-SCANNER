// Member scalpers (src/scalp-accounts.js). Run with: node test/scalp-accounts.test.mjs
import { sealCreds, openCreds, credsEnv, memberSettingsUpdate, effectiveMode, memberConfig, publicAccount, connectAccount, updateAccountSettings, disconnectAccount, setLiveAllowed, memberState, listAccounts, runMemberScalpers, getAccount, accountIds, ACCT_KEYS, MEMBER_DEFAULTS } from "../src/scalp-accounts.js";
import { runScalpLane, scalpReport, scalpKeys, SCALP_KEYS } from "../src/scalp.js";
import { usFee } from "../src/xvenue.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const kvStore = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } }; };
const COLS = ["id", "mode", "ts_entry", "ts_exit", "sport", "game", "team", "us_slug", "side", "entry_px", "exit_px", "shares", "usd", "fee_entry_usd", "fee_exit_usd", "pnl_c", "pnl_usd", "edge_c", "dp_c", "shown_qty", "hold_s", "exit_kind", "live", "order_id", "exit_order_id", "note", "venue", "k_ticker", "probe", "account"];
const d1 = () => { const rows = []; return { rows, prepare: (sql) => ({ bind: (...args) => ({ run: async () => { if (/INSERT/.test(sql)) { const r = Object.fromEntries(COLS.map((c, i) => [c, args[i]])); const i = rows.findIndex(x => x.id === r.id); if (i >= 0) rows[i] = r; else rows.push(r); } return { success: true }; }, all: async () => ({ results: rows.filter(r => r.ts_entry >= args[0] && (/account = \?/.test(sql) ? r.account === args[1] : /account IS NULL/.test(sql) ? r.account == null : true)).sort((a, b) => b.ts_entry - a.ts_entry) }) }), run: async () => ({ success: true }) }) }; };
const OWNER_SECRET = Buffer.alloc(32, 9).toString("base64"), MEMBER_SECRET = Buffer.alloc(32, 7).toString("base64"), MEMBER2_SECRET = Buffer.alloc(32, 5).toString("base64");
const mkEnv = (extra = {}) => ({ SIGNALS_CACHE: kvStore(), DB: d1(), ADMIN_TOKEN: "admin-token-xyz", PMUS_KEY_ID: "owner-key-0001", PMUS_SECRET_KEY: OWNER_SECRET, KALSHI_API_KEY_ID: "k", KALSHI_PRIVATE_KEY: "p", ...extra });
const T0 = Date.parse("2026-11-09T23:00:00Z");
const m = (k) => T0 + k * 60e3;
const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => JSON.stringify(b), headers: { get: () => null } });
const ev = (extra = {}) => ({ ts: Math.floor(T0 / 1000), sport: "nba", game: "Lakers vs. Celtics", team: "Lakers", pToken: "tok", usSlug: "nba-lal-bos", pBid: 0.45, pAsk: 0.46, pMid: 0.455, dpC: 4, side: "buy", px: 0.40, qty: 300, fee: usFee(0.40), edgeC: 2.5, ...extra });
const leg = (bid, ask) => ({ ts: Math.floor(T0 / 1000), sport: "nba", game: "Lakers vs. Celtics", team: "Lakers", p_token: "tok", us_slug: "nba-lal-bos", us_long: true, p_bid: 0.45, p_ask: 0.46, us_bid: bid, us_ask: ask, us_bid_qty: 300, us_ask_qty: 300 });
// a fake Polymarket US: records which key signed each call
const venue = ({ balanceStatus = 200 } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url), h = init.headers || {};
    calls.push({ u, method: init.method || "GET", key: h["X-PM-Access-Key"] || null, body: init.body ? JSON.parse(init.body) : null });
    if (/\/v1\/account\/balances/.test(u)) return balanceStatus === 200 ? json({ balances: [{ currency: "USD", currentBalance: "52.10", buyingPower: "52.10", assetNotional: "0", openOrders: "0" }] }) : json({ message: "forbidden" }, balanceStatus);
    if (/gateway\.polymarket\.us\/v1\/market\/slug\//.test(u)) return json({ market: { orderPriceMinTickSize: "0.01", minimumTradeQty: "1", status: "MARKET_STATUS_OPEN" } });
    if (/\/v1\/portfolio\/positions/.test(u)) return json({ positions: { "nba-lal-bos": { netPositionDecimal: "0" } } });
    if (/\/v1\/orders$/.test(u)) return json({ id: "o-entry", executions: [{ lastShares: "25", lastPx: { value: "0.40" }, commissionNotionalCollected: { value: "0.17" } }] });
    if (/\/v1\/order\/close-position/.test(u)) return json({ id: "o-exit", executions: [{ lastShares: "25", lastPx: { value: "0.44" }, commissionNotionalCollected: { value: "0.17" } }] });
    return json({}, 404);
  };
  return { calls, fetchImpl };
};

// ---------- sealing ----------
{
  const env = mkEnv();
  const sealed = await sealCreds(env, "user-1", { keyId: "member-key-1234", secret: MEMBER_SECRET });
  const back = await openCreds(env, "user-1", sealed);
  check("seal: the key round-trips for its own user, sealed with the admin-token-derived key when MEMBER_KEY_SECRET is absent", back.keyId === "member-key-1234" && back.secret === MEMBER_SECRET && sealed.kid === "adm" && !JSON.stringify(sealed).includes(MEMBER_SECRET), sealed);
  let moved = null; try { await openCreds(env, "user-2", sealed); moved = "opened"; } catch (e) { moved = "refused"; }
  check("seal: a sealed key cannot be opened for another user (the user id is bound in)", moved === "refused");
  const env2 = mkEnv({ MEMBER_KEY_SECRET: "a-dedicated-secret" });
  const s2 = await sealCreds(env2, "user-1", { keyId: "k", secret: "s" });
  check("seal: a dedicated MEMBER_KEY_SECRET is preferred, and only it opens that blob", s2.kid === "mks" && (await openCreds(env2, "user-1", s2)).secret === "s");
  const ce = credsEnv(env, { keyId: "member-key-1234", secret: MEMBER_SECRET });
  check("creds env: the member's key replaces the owner's, the Kalshi key is dropped, storage is shared", ce.PMUS_KEY_ID === "member-key-1234" && ce.PMUS_SECRET_KEY === MEMBER_SECRET && ce.KALSHI_API_KEY_ID === undefined && ce.SIGNALS_CACHE === env.SIGNALS_CACHE && env.PMUS_KEY_ID === "owner-key-0001");
}

// ---------- pure ----------
{
  const u = memberSettingsUpdate({ mode: "live", maxUsd: "500", maxOpen: 9.6, maxPerDay: 0, dailyLossUsd: "x" });
  check("settings: a bad number is refused", u.error && /dailyLossUsd/.test(u.error));
  const v = memberSettingsUpdate({ mode: "live", maxUsd: "500", maxOpen: 9.6, maxPerDay: 0, dailyLossUsd: 20, bogus: 1 });
  check("settings: clamped to the member limits, whole counts rounded, unknown keys dropped", v.mode === "live" && v.settings.maxUsd === 100 && v.settings.maxOpen === 5 && v.settings.maxPerDay === 1 && v.settings.dailyLossUsd === 20 && !("bogus" in v.settings), v);
  check("settings: an unknown mode is refused", memberSettingsUpdate({ mode: "turbo" }).error);
  const blocked = effectiveMode({ mode: "live", liveAllowed: false }), allowed = effectiveMode({ mode: "live", liveAllowed: true });
  check("mode: live runs only once the owner allows it, else dry and says why", blocked.mode === "dry" && /waiting for the site owner/.test(blocked.liveBlocked) && allowed.mode === "live" && !allowed.liveBlocked && effectiveMode({ mode: "off" }).mode === "off");
  const c = memberConfig({ scalpHoldMin: 5, scalpMinEdgeC: 1.5, scalpSports: ["nhl"], scalpMaxUsd: 10, scalpMode: "live", scalpKalshiMode: "dry" }, { mode: "dry", settings: { maxUsd: 20, maxOpen: 2, maxPerDay: 15, dailyLossUsd: 30 } });
  check("config: the owner's lane rules, the member's sizes and limits, US venue only", c.scalpHoldMin === 5 && c.scalpMinEdgeC === 1.5 && c.scalpSports.join() === "nhl" && c.scalpMode === "dry" && c.scalpKalshiMode === "off" && c.scalpMaxUsd === 20 && c.scalpMaxOpen === 2 && c.scalpMaxPerDay === 15 && c.scalpDailyLossUsd === 30, c);
  const pub = publicAccount({ userId: "u", sealed: { ct: "secret!" }, mode: "live", liveAllowed: false });
  check("public account: no sealed key; effective mode and the reason shown", !("sealed" in pub) && pub.effectiveMode === "dry" && pub.liveBlocked && pub.settings.maxUsd === MEMBER_DEFAULTS.maxUsd);
  check("keys: the owner's lane keeps its keys; a member's are suffixed", scalpKeys(null) === SCALP_KEYS && scalpKeys("u1").OPEN === "scalp_open@u1" && scalpKeys("u1").DAY === "scalp_day@u1:");
}

// ---------- connect, settings, disconnect ----------
{
  const env = mkEnv(), user = { id: "friend-1", email: "f@example.com" };
  const v = venue();
  check("connect: a malformed Key ID is refused before any call", (await connectAccount(env, user, { keyId: "x", secretKey: MEMBER_SECRET }, { fetchImpl: v.fetchImpl })).status === 400 && v.calls.length === 0);
  check("connect: a secret that is not an Ed25519 key is refused", /does not look like a Polymarket US key/.test((await connectAccount(env, user, { keyId: "member-key-1234", secretKey: "short" }, { fetchImpl: v.fetchImpl })).error));
  const bad = venue({ balanceStatus: 403 });
  const r403 = await connectAccount(env, user, { keyId: "member-key-1234", secretKey: MEMBER_SECRET }, { fetchImpl: bad.fetchImpl, nowMs: m(0) });
  check("connect: a key the venue refuses is not kept", r403.ok === false && /refused this key/.test(r403.error) && !(await getAccount(env, user.id)), r403);
  const ok = await connectAccount(env, user, { keyId: "member-key-1234", secretKey: MEMBER_SECRET }, { fetchImpl: v.fetchImpl, nowMs: m(0) });
  const stored = await getAccount(env, user.id);
  check("connect: checked with the member's own key, stored sealed, dry by default, live not allowed, indexed", ok.ok && v.calls[0].key === "member-key-1234" && stored.sealed && stored.mode === "dry" && stored.liveAllowed === false && stored.balance.currentBalance === 52.1 && (await accountIds(env)).includes(user.id), { ok, stored });
  check("connect: nothing returned or stored in the clear carries the secret or the whole Key ID", !JSON.stringify(ok).includes(MEMBER_SECRET) && !JSON.stringify(ok).includes("member-key-1234") && ok.account.keyTail === "1234" && !env.SIGNALS_CACHE.m.get(ACCT_KEYS.ACCT + user.id).includes(MEMBER_SECRET), ok);
  const s = await updateAccountSettings(env, user.id, { mode: "live", maxUsd: 5 });
  check("settings: saved; live asked but waiting for the owner", s.ok && s.account.mode === "live" && s.account.effectiveMode === "dry" && s.account.settings.maxUsd === 5);
  check("settings: no account -> 404", (await updateAccountSettings(env, "nobody", { mode: "dry" })).status === 404);
  const st = await memberState(env, user.id, {}, { fetchImpl: v.fetchImpl, nowMs: m(0) + 30e3 });
  check("state: connected, his own lane, balance cached (no venue call within a minute), no key in it", st.connected && st.lane && st.lane.mode === "dry" && /waiting for the site owner/.test(st.lane.liveBlocked) && v.calls.length === 1 && !JSON.stringify(st).includes(MEMBER_SECRET) && !JSON.stringify(st).includes("member-key-1234"), st);
  const lst = await listAccounts(env, {});
  check("owner list: the member, his mode and the live switch, no key", lst.accounts.length === 1 && lst.accounts[0].account.userId === user.id && lst.accounts[0].account.liveAllowed === false && !JSON.stringify(lst).includes(MEMBER_SECRET), lst);
}

// ---------- the minute pass: separate lanes, the member's own key, the owner's switch ----------
{
  const env = mkEnv(), v = venue();
  const a = { id: "friend-1", email: "a@x" }, b = { id: "friend-2", email: "b@x" };
  await connectAccount(env, a, { keyId: "member-key-1234", secretKey: MEMBER_SECRET }, { fetchImpl: v.fetchImpl, nowMs: m(0) });
  await connectAccount(env, b, { keyId: "member-key-5678", secretKey: MEMBER2_SECRET }, { fetchImpl: v.fetchImpl, nowMs: m(0) });
  await updateAccountSettings(env, a.id, { mode: "live" });                    // asks for live, not allowed yet
  await updateAccountSettings(env, b.id, { mode: "live" });
  await setLiveAllowed(env, b.id, true, { nowMs: m(0) });                      // the owner allows member b
  const before = v.calls.length;
  const r = await runMemberScalpers(env, { events: [ev()], legs: [leg(0.40, 0.40)], nowMs: m(0), ownerConfig: { scalpMode: "live" }, fetchImpl: v.fetchImpl, drySim: false });
  const orders = v.calls.slice(before).filter(c => /\/v1\/orders$/.test(c.u));
  const openA = JSON.parse(env.SIGNALS_CACHE.m.get(scalpKeys(a.id).OPEN)), openB = JSON.parse(env.SIGNALS_CACHE.m.get(scalpKeys(b.id).OPEN));
  check("minute pass: both lanes ran; a (live not allowed) entered dry, b (allowed) sent one order signed with b's own key", r.ran === 2 && r.live === 1 && r.entries === 2 && openA.length === 1 && openA[0].live === false && openB.length === 1 && openB[0].live === true && orders.length === 1 && orders[0].key === "member-key-5678", { r, orders });
  check("minute pass: the owner's lane keys are untouched", !env.SIGNALS_CACHE.m.has(SCALP_KEYS.OPEN) && !env.SIGNALS_CACHE.m.has(SCALP_KEYS.LAST));
  await runMemberScalpers(env, { events: [], legs: [leg(0.44, 0.46)], nowMs: m(5), ownerConfig: {}, fetchImpl: v.fetchImpl, drySim: false });
  const closeB = v.calls.find(c => /close-position/.test(c.u));
  const rowsA = env.DB.rows.filter(x => x.account === a.id), rowsB = env.DB.rows.filter(x => x.account === b.id);
  check("minute pass: exits closed each lane; b's close signed with b's key; rows tagged with the member", closeB && closeB.key === "member-key-5678" && rowsA.length === 1 && rowsA[0].live === 0 && rowsB.length === 1 && rowsB[0].live === 1 && rowsB[0].exit_kind === "x_live", { rowsA, rowsB });
  const ownerRep = await scalpReport(env, {}, { nowMs: m(6) }), bRep = await scalpReport(env, {}, { nowMs: m(6), account: b.id });
  check("report: the owner's record leaves the members out; a member's holds only his", ownerRep.all.n === 0 && bRep.all.n === 1 && bRep.byMode.live.n === 1, { owner: ownerRep.all, b: bRep.all });
  // switching off: no new entries, and an open scalp still closes (it used to be stranded when every venue was off)
  await updateAccountSettings(env, a.id, { mode: "dry" });
  await runMemberScalpers(env, { events: [ev({ game: "G2", team: "T2", usSlug: "s2" })], legs: [], nowMs: m(10), ownerConfig: {}, fetchImpl: v.fetchImpl, drySim: false });
  check("disconnect: refused while a scalp is open", (await disconnectAccount(env, a.id)).status === 409);
  await updateAccountSettings(env, a.id, { mode: "off" });
  const r2 = await runMemberScalpers(env, { events: [ev({ game: "G3", team: "T3", usSlug: "s3" })], legs: [leg(0.44, 0.46)], nowMs: m(30), ownerConfig: {}, fetchImpl: v.fetchImpl, drySim: false });
  const openA2 = JSON.parse(env.SIGNALS_CACHE.m.get(scalpKeys(a.id).OPEN));
  check("off: no new entry, the open scalp still closed", openA2.length === 0 && env.DB.rows.filter(x => x.account === a.id).length === 2 && r2.entries === 1, { openA2, r2 });   // r2.entries = b's
  const disc = await disconnectAccount(env, a.id);
  check("disconnect: with nothing open the key is deleted and the member leaves the pass", disc.ok && disc.removed && !(await getAccount(env, a.id)) && !(await accountIds(env)).includes(a.id));
  const r3 = await runMemberScalpers(env, { events: [], legs: [], nowMs: m(40), ownerConfig: {}, fetchImpl: v.fetchImpl, drySim: false });
  check("minute pass: an off lane holding nothing is skipped", r3.accounts === 1 && r3.ran === 1);   // only b (live, holding) runs
}

// ---------- the owner's lane: off with a scalp open still closes it ----------
{
  const env = mkEnv(), v = venue();
  await runScalpLane(env, { events: [ev()], legs: [], nowMs: m(0), config: { scalpMode: "dry", scalpKalshiMode: "off" }, fetchImpl: v.fetchImpl, probe: { sleep: async () => {}, clock: () => m(0) }, drySim: false });
  const r = await runScalpLane(env, { events: [], legs: [leg(0.44, 0.46)], nowMs: m(5), config: { scalpMode: "off", scalpKalshiMode: "off" }, fetchImpl: v.fetchImpl, drySim: false });
  check("owner lane: both venues off still closes the open scalp", r.exits === 1 && JSON.parse(env.SIGNALS_CACHE.m.get(SCALP_KEYS.OPEN)).length === 0 && env.DB.rows.length === 1 && env.DB.rows[0].account == null, r);
}

// ---------- a member's dry lane acts as live too (Nov 12 2026): the order matched on the book at send time ----------
{
  const env = mkEnv(), v = venue();
  const a = { id: "friend-9", email: "z@x" };
  await connectAccount(env, a, { keyId: "member-key-9999", secretKey: MEMBER_SECRET }, { fetchImpl: v.fetchImpl, nowMs: m(0) });
  const thin = async (url, init) => (/\/v1\/markets\/nba-lal-bos\/book/.test(String(url)) ? json({ marketData: { bids: [{ px: { value: "0.39" }, qty: "100" }], offers: [{ px: { value: "0.40" }, qty: "5" }] } }) : v.fetchImpl(url, init));
  const r = await runMemberScalpers(env, { events: [ev()], legs: [leg(0.39, 0.40)], nowMs: m(0), ownerConfig: {}, fetchImpl: thin });
  const lastA = JSON.parse(env.SIGNALS_CACHE.m.get(scalpKeys(a.id).LAST));
  check("member dry = live: only 5 offered at the limit, so the FOK would not fill and nothing is entered", r.ran === 1 && r.entries === 0 && Object.keys(lastA.skipped || {}).some(k => /FOK would not fill \(dry\)/.test(k)) && !v.calls.some(c => /\/v1\/orders$/.test(c.u)), { r, skipped: lastA.skipped });
}

console.log(`scalp-accounts: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

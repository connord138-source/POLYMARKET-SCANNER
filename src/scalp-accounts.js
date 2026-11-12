// ============================================================
// SCALP-ACCOUNTS.JS — member scalpers (Nov 9 2026)
// ============================================================
//
// Owner: "he would have access to his own auto-scalper that he would connect
// his own polymarket us account to via his desk interface on our site". A
// Desk member connects his own Polymarket US API key (made by him at
// polymarket.us/developer, revocable by him there at any time); the minute
// cron runs the same scalp lane (src/scalp.js) on his account with his own
// settings, limits, open scalps and record. The site never holds or moves his
// money and charges nothing for it.
//
// Safety:
//   - the key is checked with a balance read before it is kept, then sealed
//     with AES-GCM (key derived by HKDF from the worker secret
//     MEMBER_KEY_SECRET, or ADMIN_TOKEN when that is not set; the user id is
//     the additional data, so a sealed key cannot be moved to another
//     account). It is never returned by any route: only its last 4 characters.
//   - live trading for a member is OFF until the owner allows it for that
//     account (POST /scalper/accounts/live, admin). Until then a member who
//     picks live runs dry and is told why.
//   - US venue only (the Kalshi venue never runs for members); the owner's
//     lane rules (hold, minimum edge, shares shown, sports) apply, the member
//     picks his size, open scalps, daily cap and daily loss stop within
//     MEMBER_LIMITS.
//   - a member can only disconnect with no scalp open (switch to Off, the
//     open ones close at their hold), so no live position is left unmanaged.
//
// KV: `scalper_accts` (the member ids), `scalper_acct:<userId>` (the record),
// the lane's own keys per member via scalpKeys(userId); D1 scalp_trades rows
// carry `account`.

import { runScalpLane, scalpReport, scalpKeys, setScalpHalt } from './scalp.js';
import { decodeSecret, usBalances, PmusError } from './polymarket-us.js';

export const ACCT_KEYS = { INDEX: 'scalper_accts', ACCT: 'scalper_acct:', RUN: 'scalper_run_last' };
export const MEMBER_DEFAULTS = { maxUsd: 10, maxOpen: 3, maxPerDay: 40, dailyLossUsd: 15 };
export const MEMBER_LIMITS = { maxUsd: [1, 100], maxOpen: [1, 5], maxPerDay: [1, 100], dailyLossUsd: [1, 500] };
export const MEMBER_MODES = ['off', 'dry', 'live'];
const BALANCE_TTL_MS = 60e3;
const LIVE_WAIT = 'live trading for this account is waiting for the site owner to switch it on; running dry';

const te = new TextEncoder(), td = new TextDecoder();
const b64 = (u8) => { let s = ''; for (const c of u8) s += String.fromCharCode(c); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function kvJson(env, key, fallback) { try { const v = await env.SIGNALS_CACHE.get(key, { type: 'json' }); return v == null ? fallback : v; } catch (e) { return fallback; } }
async function kvPut(env, key, value, ttlSec) { await env.SIGNALS_CACHE.put(key, JSON.stringify(value), ttlSec ? { expirationTtl: ttlSec } : undefined); }

// ---------- sealing the member's key ----------
function sealSource(env, kid = null) {
  if ((kid === null || kid === 'mks') && env.MEMBER_KEY_SECRET) return { kid: 'mks', secret: env.MEMBER_KEY_SECRET };
  if ((kid === null || kid === 'adm') && env.ADMIN_TOKEN) return { kid: 'adm', secret: env.ADMIN_TOKEN };
  return null;
}
async function aesKey(secret) {
  const raw = await crypto.subtle.importKey('raw', te.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('edgerunner-scalper'), info: te.encode('member venue keys v1') }, raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function sealCreds(env, userId, creds) {
  const src = sealSource(env);
  if (!src) throw new Error('no key-encryption secret on the worker (MEMBER_KEY_SECRET or ADMIN_TOKEN)');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(String(userId)) }, await aesKey(src.secret), te.encode(JSON.stringify(creds))));
  return { v: 1, kid: src.kid, iv: b64(iv), ct: b64(ct) };
}
export async function openCreds(env, userId, sealed) {
  const src = sealed && sealSource(env, sealed.kid);
  if (!src) throw new Error('the secret that sealed this key is not on the worker');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: te.encode(String(userId)) }, await aesKey(src.secret), unb64(sealed.ct));
  return JSON.parse(td.decode(pt));
}
// The worker env with this member's Polymarket US key in place of the owner's (and no Kalshi key).
export const credsEnv = (env, creds) => ({ ...env, PMUS_KEY_ID: creds.keyId, PMUS_SECRET_KEY: creds.secret, KALSHI_API_KEY_ID: undefined, KALSHI_PRIVATE_KEY: undefined });

// ---------- pure ----------
// A member's settings update, checked and clamped; unknown keys dropped.
export function memberSettingsUpdate(body = {}) {
  const out = {};
  if (body.mode !== undefined) { if (!MEMBER_MODES.includes(body.mode)) return { error: `mode must be one of ${MEMBER_MODES.join(', ')}` }; out.mode = body.mode; }
  const settings = {};
  for (const [k, [lo, hi]] of Object.entries(MEMBER_LIMITS)) {
    if (body[k] === undefined || body[k] === null || body[k] === '') continue;
    const n = Number(body[k]); if (!Number.isFinite(n)) return { error: `${k} must be a number` };
    settings[k] = k === 'maxOpen' || k === 'maxPerDay' ? Math.round(Math.min(hi, Math.max(lo, n))) : Math.min(hi, Math.max(lo, n));
  }
  if (Object.keys(settings).length) out.settings = settings;
  return out;
}
// What the member's lane runs as: live only when he asked for it AND the owner allowed it.
export function effectiveMode(acct) {
  const asked = (acct && acct.mode) || 'off';
  if (asked === 'live' && !acct.liveAllowed) return { mode: 'dry', asked, liveBlocked: LIVE_WAIT };
  return { mode: asked, asked, liveBlocked: null };
}
// The lane config for a member: the owner's lane rules, the member's size and limits, US venue only.
export function memberConfig(ownerCfg = {}, acct = {}) {
  const s = { ...MEMBER_DEFAULTS, ...((acct && acct.settings) || {}) };
  const pick = (k) => (ownerCfg[k] !== undefined && ownerCfg[k] !== null ? { [k]: ownerCfg[k] } : {});
  return {
    ...pick('scalpHoldMin'), ...pick('scalpMinEdgeC'), ...pick('scalpMinQty'), ...pick('scalpExitGraceMin'), ...pick('scalpSports'),
    scalpMode: effectiveMode(acct).mode, scalpKalshiMode: 'off',
    scalpMaxUsd: s.maxUsd, scalpMaxOpen: s.maxOpen, scalpMaxPerDay: s.maxPerDay, scalpDailyLossUsd: s.dailyLossUsd,
  };
}
// The record without the sealed key.
export function publicAccount(acct) {
  if (!acct) return null;
  const { sealed, ...rest } = acct;
  const eff = effectiveMode(acct);
  return { ...rest, settings: { ...MEMBER_DEFAULTS, ...(acct.settings || {}) }, effectiveMode: eff.mode, liveBlocked: eff.liveBlocked };
}

// ---------- storage ----------
export const getAccount = (env, userId) => kvJson(env, ACCT_KEYS.ACCT + userId, null);
const saveAccount = (env, acct) => kvPut(env, ACCT_KEYS.ACCT + acct.userId, acct);
export const accountIds = async (env) => { const ids = await kvJson(env, ACCT_KEYS.INDEX, []); return Array.isArray(ids) ? ids : []; };
async function setIndex(env, userId, present) {
  const ids = await accountIds(env);
  const next = present ? [...new Set([...ids, userId])] : ids.filter((x) => x !== userId);
  if (next.length !== ids.length || present !== ids.includes(userId)) await kvPut(env, ACCT_KEYS.INDEX, next);
}

// ---------- member actions ----------
// Connect (or replace) a member's key: checked with a balance read, then sealed.
export async function connectAccount(env, user, body = {}, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const keyId = String((body && body.keyId) || '').trim(), secret = String((body && body.secretKey) || '').trim();
  if (!user || !user.id) return { ok: false, status: 401, error: 'sign in first' };
  if (!/^[A-Za-z0-9._:-]{6,200}$/.test(keyId)) return { ok: false, status: 400, error: 'that Key ID does not look right: copy it from polymarket.us/developer' };
  try { decodeSecret(secret); } catch (e) { return { ok: false, status: 400, error: 'that secret key does not look like a Polymarket US key: copy the secret shown when you created the key' }; }
  let balance = null;
  try { balance = await usBalances(credsEnv(env, { keyId, secret }), { fetchImpl, nowMs }); }
  catch (e) {
    const st = e instanceof PmusError ? e.status : 0;
    if (st === 401 || st === 403) return { ok: false, status: 400, error: 'Polymarket US refused this key: check the Key ID and secret, and that the key is still active at polymarket.us/developer' };
    return { ok: false, status: 502, error: `could not reach Polymarket US to check the key (${String(e.message).slice(0, 80)}); try again` };
  }
  const prev = await getAccount(env, user.id);
  const nowIso = new Date(nowMs).toISOString();
  const acct = {
    userId: user.id, email: user.email || (prev && prev.email) || null, keyTail: keyId.slice(-4),
    sealed: await sealCreds(env, user.id, { keyId, secret }),
    connectedAt: (prev && prev.connectedAt) || nowIso, keyCheckedAt: nowIso,
    balance: balance ? { ...balance, at: nowIso } : null,
    mode: (prev && prev.mode) || 'dry', liveAllowed: !!(prev && prev.liveAllowed), liveAllowedAt: (prev && prev.liveAllowedAt) || null,
    settings: { ...MEMBER_DEFAULTS, ...((prev && prev.settings) || {}) }, updatedAt: nowIso,
  };
  await saveAccount(env, acct);
  await setIndex(env, user.id, true);
  return { ok: true, account: publicAccount(acct) };
}
export async function updateAccountSettings(env, userId, body = {}, { nowMs = Date.now() } = {}) {
  const acct = await getAccount(env, userId);
  if (!acct) return { ok: false, status: 404, error: 'connect your Polymarket US key first' };
  const u = memberSettingsUpdate(body);
  if (u.error) return { ok: false, status: 400, error: u.error };
  if (u.mode) acct.mode = u.mode;
  if (u.settings) acct.settings = { ...MEMBER_DEFAULTS, ...(acct.settings || {}), ...u.settings };
  acct.updatedAt = new Date(nowMs).toISOString();
  await saveAccount(env, acct);
  return { ok: true, account: publicAccount(acct) };
}
// Disconnect: only with nothing open, so no live scalp is left without its exit.
export async function disconnectAccount(env, userId) {
  const acct = await getAccount(env, userId);
  if (!acct) return { ok: true, removed: false };
  const open = await kvJson(env, scalpKeys(userId).OPEN, []);
  if (open.length) return { ok: false, status: 409, error: `${open.length} scalp${open.length > 1 ? 's are' : ' is'} still open: switch to Off, they close within a few minutes, then disconnect`, open: open.length };
  await env.SIGNALS_CACHE.delete(ACCT_KEYS.ACCT + userId);
  await setIndex(env, userId, false);
  return { ok: true, removed: true };
}
// The member clears his own lane's halt (an ambiguous send or exits it could not reconcile) after checking his account.
export const resumeAccount = (env, userId) => setScalpHalt(env, false, null, userId);

// ---------- the owner's actions ----------
export async function setLiveAllowed(env, userId, on, { nowMs = Date.now() } = {}) {
  const acct = await getAccount(env, userId);
  if (!acct) return { ok: false, status: 404, error: 'no connected account for that user' };
  acct.liveAllowed = !!on; acct.liveAllowedAt = on ? new Date(nowMs).toISOString() : null; acct.updatedAt = new Date(nowMs).toISOString();
  await saveAccount(env, acct);
  return { ok: true, account: publicAccount(acct) };
}

// ---------- reads ----------
const slimReport = (r) => ({
  mode: r.mode, liveAsked: r.liveAsked, liveBlocked: r.liveBlocked, halted: r.halted, halt: r.halt,
  open: (r.open || []).map((p) => ({ team: p.team, game: p.game, sport: p.sport, side: p.side, px: p.px, shares: p.shares, usd: p.usd, live: !!p.live, entryAt: p.entryAt, holdLeftS: p.holdLeftS, markUsd: p.markUsd ?? null, lastExitError: p.lastExitError || null })),
  today: r.today ? { date: r.today.date, entries: r.today.entries, exits: r.today.exits, wins: r.today.wins, pnlUsd: r.today.pnlUsd, livePnlUsd: r.today.livePnlUsd || 0, feesUsd: r.today.feesUsd, skipped: r.today.skipped, liveSent: r.today.liveSent || 0, liveFilled: r.today.liveFilled || 0, drySent: r.today.drySent || 0, dryFilled: r.today.dryFilled || 0, wouldHalt: r.today.wouldHalt || 0 } : null,
  all: r.all, byMode: r.byMode, bySport: r.bySport, byKind: r.byKind, fresh: r.fresh ? { since: r.fresh.since, all: r.fresh.all, byMode: r.fresh.byMode } : null,
  recent: (r.recent || []).map((x) => ({ entryAt: x.entryAt, exitAt: x.exitAt, sport: x.sport, game: x.game, team: x.team, side: x.side, entryPx: x.entryPx, exitPx: x.exitPx, shares: x.shares, usd: x.usd, pnlUsd: x.pnlUsd, pnlC: x.pnlC, feesUsd: Math.round(((x.feeEntryUsd || 0) + (x.feeExitUsd || 0)) * 100) / 100, exitKind: x.exitKind, live: !!x.live, mode: x.mode })),
});
// A member's own view: his account (no key), his lane's state and record, his balance (refreshed at most once a minute).
export async function memberState(env, userId, ownerCfg = {}, { fetchImpl = fetch, nowMs = Date.now(), hours = 168 } = {}) {
  const acct = await getAccount(env, userId);
  const base = { success: true, connected: !!acct, limits: MEMBER_LIMITS, defaults: MEMBER_DEFAULTS };
  if (!acct) return base;
  let aenv = env, keyError = null;
  try { aenv = credsEnv(env, await openCreds(env, userId, acct.sealed)); } catch (e) { aenv = { ...env, PMUS_KEY_ID: undefined, PMUS_SECRET_KEY: undefined }; keyError = 'the stored key could not be opened: reconnect it'; }
  if (!keyError && (!acct.balance || nowMs - Date.parse(acct.balance.at || 0) > BALANCE_TTL_MS)) {
    try { const b = await usBalances(aenv, { fetchImpl, nowMs }); acct.balance = b ? { ...b, at: new Date(nowMs).toISOString() } : acct.balance; acct.keyCheckedAt = new Date(nowMs).toISOString(); acct.keyError = null; await saveAccount(env, acct); }
    catch (e) { const st = e instanceof PmusError ? e.status : 0; keyError = st === 401 || st === 403 ? 'Polymarket US refused the key: it may have been revoked; reconnect a new one' : null; if (keyError) { acct.keyError = keyError; await saveAccount(env, acct); } }
  }
  const rep = await scalpReport(aenv, memberConfig(ownerCfg, acct), { hours, nowMs, account: userId });
  const lane = slimReport(rep);
  const eff = effectiveMode(acct);
  if (eff.liveBlocked) { lane.liveAsked = true; lane.liveBlocked = eff.liveBlocked; }   // live picked, waiting for the owner's switch
  return { ...base, account: publicAccount(acct), keyError: keyError || acct.keyError || null, lane };
}
// The owner's list of connected members.
export async function listAccounts(env, ownerCfg = {}, { nowMs = Date.now() } = {}) {
  const ids = await accountIds(env);
  const out = [];
  for (const id of ids) {
    const acct = await getAccount(env, id);
    if (!acct) continue;
    const rep = await scalpReport(env, memberConfig(ownerCfg, acct), { hours: 168, nowMs, account: id });
    out.push({ account: publicAccount(acct), halted: rep.halted, open: (rep.open || []).length, today: rep.today ? { entries: rep.today.entries, exits: rep.today.exits, wins: rep.today.wins, pnlUsd: rep.today.pnlUsd, livePnlUsd: rep.today.livePnlUsd || 0, events: rep.today.events || 0, drySent: rep.today.drySent || 0, dryFilled: rep.today.dryFilled || 0, liveSent: rep.today.liveSent || 0, liveFilled: rep.today.liveFilled || 0, wouldHalt: rep.today.wouldHalt || 0 } : null, all: rep.all, byMode: rep.byMode, fresh: rep.fresh ? { since: rep.fresh.since, all: rep.fresh.all, byMode: rep.fresh.byMode, bySport: rep.fresh.bySport } : null });
  }
  return { success: true, accounts: out, last: await kvJson(env, ACCT_KEYS.RUN, null) };
}

// ---------- the minute pass ----------
// Runs every connected member's lane on this minute's stale US quotes, after
// the owner's. A member whose lane is off and holds nothing is skipped; one
// member's failure never touches another's.
export async function runMemberScalpers(env, { events = [], legs = [], nowMs = Date.now(), ownerConfig = {}, fetchImpl = fetch, drySim = true } = {}) {
  const ids = await accountIds(env);
  const out = { at: new Date(nowMs).toISOString(), accounts: ids.length, ran: 0, live: 0, entries: 0, exits: 0, errors: [] };
  for (const id of ids) {
    try {
      const acct = await getAccount(env, id);
      if (!acct) continue;
      const eff = effectiveMode(acct);
      const open = await kvJson(env, scalpKeys(id).OPEN, []);
      if (eff.mode === 'off' && !open.length) continue;
      const creds = await openCreds(env, id, acct.sealed);
      const r = await runScalpLane(credsEnv(env, creds), { events, kalshiEvents: [], legs, nowMs, config: memberConfig(ownerConfig, acct), fetchImpl, account: id, drySim });
      out.ran++; if (r.mode === 'live') out.live++; out.entries += r.entries || 0; out.exits += r.exits || 0;
    } catch (e) { out.errors.push({ account: String(id).slice(0, 8), error: String(e.message).slice(0, 80) }); }
  }
  if (ids.length) { try { await kvPut(env, ACCT_KEYS.RUN, out, 3600); } catch (e) {} }
  return out;
}

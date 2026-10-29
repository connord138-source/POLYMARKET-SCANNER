import test from 'node:test';
import assert from 'node:assert/strict';
import { listUsers } from '../src/business.js';

// A KV namespace with two entitlement rows and a Supabase auth admin API with
// three accounts, stubbed.
const kv = () => {
  const rows = {
    'ent:u1': { userId: 'u1', plan: 'pro', status: 'active', currentPeriodEnd: new Date(Date.now() + 10 * 86400e3).toISOString(), founding: true },
    'ent:u2': { userId: 'u2', plan: 'desk', status: 'comped', currentPeriodEnd: new Date(Date.now() - 40 * 86400e3).toISOString() }, // comp that ran out, past the grace days
  };
  return {
    list: async () => ({ keys: Object.keys(rows).map(name => ({ name })), list_complete: true }),
    get: async (k) => rows[k] || null,
  };
};
const env = () => ({ SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'srk', SIGNALS_CACHE: kv() });
const users = [
  { id: 'u1', email: 'ann@example.com', created_at: '2026-10-01T00:00:00Z', last_sign_in_at: '2026-10-28T00:00:00Z', email_confirmed_at: '2026-10-01T00:01:00Z' },
  { id: 'u2', email: 'bob@example.com', created_at: '2026-10-20T00:00:00Z', last_sign_in_at: null, email_confirmed_at: null },
  { id: 'u3', email: 'cat@example.com', created_at: '2026-10-27T00:00:00Z', last_sign_in_at: '2026-10-27T01:00:00Z', email_confirmed_at: '2026-10-27T00:01:00Z' },
];

test('listUsers: newest first, plans from entitlements, expired comps read free', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ users }) }; };
  const r = await listUsers(env());
  assert.equal(r.success, true); assert.equal(r.configured, true); assert.equal(r.total, 3);
  assert.deepEqual(r.users.map(u => u.id), ['u3', 'u2', 'u1']);
  const byId = Object.fromEntries(r.users.map(u => [u.id, u]));
  assert.equal(byId.u1.plan, 'pro'); assert.equal(byId.u1.founding, true); assert.equal(byId.u1.confirmed, true);
  assert.equal(byId.u2.plan, 'free'); assert.equal(byId.u2.status, 'comped'); assert.equal(byId.u2.confirmed, false);
  assert.equal(byId.u3.plan, 'free'); assert.equal(byId.u3.status, null);
  assert.match(calls[0].url, /\/auth\/v1\/admin\/users\?page=1&per_page=1000$/);
  assert.equal(calls[0].init.headers.apikey, 'srk');
});

test('listUsers: q filters by email or id, case-insensitive', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ users }) });
  assert.deepEqual((await listUsers(env(), { q: 'BOB' })).users.map(u => u.id), ['u2']);
  assert.deepEqual((await listUsers(env(), { q: 'u3' })).users.map(u => u.id), ['u3']);
});

test('listUsers: unconfigured and upstream failure are reported, never thrown', async () => {
  assert.deepEqual(await listUsers({ SIGNALS_CACHE: kv() }), { success: true, configured: false, users: [], total: 0 });
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  const r = await listUsers(env());
  assert.equal(r.success, false); assert.equal(r.error, 'supabase 401');
});

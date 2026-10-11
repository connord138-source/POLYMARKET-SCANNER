// Pro waitlist: email validation, honeypot, dedupe, cap, admin summary, IP throttle.
// Run with: node test/waitlist.test.mjs
import {
  validateEmail, normalizeWants, addToWaitlist, waitlistSummary, loadWaitlist,
  isIpThrottled, markIpSubmitted, ipThrottleKey,
  WAITLIST_KEY, WAITLIST_CAP, IP_THROTTLE_SECONDS
} from "../src/waitlist.js";

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };

function env() {
  const store = {}, puts = [];
  return {
    store, puts,
    SIGNALS_CACHE: {
      get: async (k, o) => (k in store ? (o && o.type === "json" ? JSON.parse(store[k]) : store[k]) : null),
      put: async (k, v, opts) => { store[k] = v; puts.push({ k, v, opts }); },
    },
  };
}

// 1. validateEmail
{
  check("1: plain ok", validateEmail("Bob@Example.com") === "bob@example.com");
  check("1: trims + lowercases", validateEmail("  A.B+tag@sub.Domain.io \n") === "a.b+tag@sub.domain.io");
  check("1: no at", validateEmail("bobexample.com") === null);
  check("1: no tld", validateEmail("bob@example") === null);
  check("1: spaces inside", validateEmail("bo b@example.com") === null);
  check("1: double at", validateEmail("bob@@example.com") === null);
  check("1: empty", validateEmail("") === null && validateEmail("   ") === null);
  check("1: non-string", validateEmail(null) === null && validateEmail(42) === null && validateEmail(undefined) === null);
  check("1: too long", validateEmail("a".repeat(115) + "@x.com") === null);
  check("1: 120 chars ok", validateEmail("a".repeat(114) + "@x.com") !== null);
}

// 2. normalizeWants only keeps the known keys, deduped
{
  const w = normalizeWants(["alerts", "ALERTS", " api ", "drop-tables", 7, null, "intel", "dkboard"]);
  check("2: filtered", JSON.stringify(w) === JSON.stringify(["alerts", "api", "intel", "dkboard"]), JSON.stringify(w));
  check("2: non-array", normalizeWants("alerts").length === 0 && normalizeWants(undefined).length === 0);
}

// 3. happy path stores a normalized entry and reports position/count
{
  const e = env();
  const r = await addToWaitlist(e, { email: " First@Example.com ", wants: ["alerts", "api"], source: "pro_page", website: "", country: "US" });
  check("3: success #1", r.success === true && r.position === 1 && r.count === 1, JSON.stringify(r));
  const list = JSON.parse(e.store[WAITLIST_KEY]);
  check("3: one entry", list.length === 1);
  check("3: email normalized", list[0].email === "first@example.com");
  check("3: wants kept", JSON.stringify(list[0].wants) === JSON.stringify(["alerts", "api"]));
  check("3: source kept", list[0].source === "pro_page");
  check("3: country kept", list[0].country === "US");
  check("3: at is ISO", typeof list[0].at === "string" && !Number.isNaN(Date.parse(list[0].at)));
  const r2 = await addToWaitlist(e, { email: "second@example.com", wants: [], source: "", website: "" });
  check("3: success #2", r2.position === 2 && r2.count === 2, JSON.stringify(r2));
  const l2 = JSON.parse(e.store[WAITLIST_KEY]);
  check("3: blank source -> unknown", l2[1].source === "unknown" && l2[1].country === null);
}

// 4. invalid email is rejected and nothing is stored
{
  const e = env();
  const r = await addToWaitlist(e, { email: "not-an-email", wants: ["alerts"], source: "x", website: "" });
  check("4: rejected", r.success === false && r.status === 400 && /email/i.test(r.error), JSON.stringify(r));
  check("4: nothing stored", !(WAITLIST_KEY in e.store) && e.puts.length === 0);
  const r2 = await addToWaitlist(e, { wants: ["alerts"], website: "" });
  check("4: missing email rejected", r2.success === false);
}

// 5. honeypot: looks like success, stores nothing
{
  const e = env();
  const r = await addToWaitlist(e, { email: "bot@example.com", wants: ["alerts"], source: "x", website: "http://spam.example" });
  check("5: success:true", r.success === true, JSON.stringify(r));
  check("5: nothing stored", !(WAITLIST_KEY in e.store) && e.puts.length === 0);
  const r2 = await addToWaitlist(e, { email: "bot2@example.com", website: "   " });
  check("5: whitespace honeypot is empty -> stored", r2.success === true && r2.position === 1, JSON.stringify(r2));
  const r3 = await addToWaitlist(e, { email: "bot3@example.com", website: 123 });
  check("5: non-string honeypot value treated as filled", r3.success === true && r3.position === null && JSON.parse(e.store[WAITLIST_KEY]).length === 1);
}

// 6. dedupe by email: same position, refreshed wants/at, no duplicate row
{
  const e = env();
  await addToWaitlist(e, { email: "a@example.com", wants: ["alerts"], source: "pro_page", website: "" });
  await addToWaitlist(e, { email: "b@example.com", wants: ["api"], source: "pro_page", website: "" });
  const before = JSON.parse(e.store[WAITLIST_KEY])[0].at;
  await new Promise(r => setTimeout(r, 5));
  const r = await addToWaitlist(e, { email: "A@EXAMPLE.COM ", wants: ["intel", "dkboard"], source: "banner", website: "" });
  check("6: same position", r.success === true && r.position === 1 && r.count === 2, JSON.stringify(r));
  const list = JSON.parse(e.store[WAITLIST_KEY]);
  check("6: still two rows", list.length === 2);
  check("6: wants replaced", JSON.stringify(list[0].wants) === JSON.stringify(["intel", "dkboard"]), JSON.stringify(list[0]));
  check("6: at refreshed", Date.parse(list[0].at) > Date.parse(before));
  check("6: original source kept", list[0].source === "pro_page");
  check("6: order unchanged", list[1].email === "b@example.com");
}

// 7. cap: the 5001st new email is refused, repeats still update
{
  const e = env();
  const full = Array.from({ length: WAITLIST_CAP }, (_, i) => ({ email: `u${i}@example.com`, wants: [], source: "seed", at: "2026-10-01T00:00:00.000Z", country: null }));
  e.store[WAITLIST_KEY] = JSON.stringify(full);
  const r = await addToWaitlist(e, { email: "late@example.com", wants: ["alerts"], website: "" });
  check("7: refused", r.success === false && r.status === 409, JSON.stringify(r));
  check("7: still capped", JSON.parse(e.store[WAITLIST_KEY]).length === WAITLIST_CAP);
  const r2 = await addToWaitlist(e, { email: "u7@example.com", wants: ["api"], website: "" });
  check("7: repeat still updates", r2.success === true && r2.position === 8 && r2.count === WAITLIST_CAP, JSON.stringify(r2));
  check("7: length unchanged", JSON.parse(e.store[WAITLIST_KEY]).length === WAITLIST_CAP);
}

// 8. summary: counts, byWant, last7d, newest first
{
  const now = Date.now();
  const iso = (ms) => new Date(now - ms).toISOString();
  const list = [
    { email: "old@example.com", wants: ["alerts", "api"], source: "x", at: iso(30 * 86400000), country: "US" },
    { email: "mid@example.com", wants: ["alerts"], source: "x", at: iso(3 * 86400000), country: null },
    { email: "new@example.com", wants: ["intel", "dkboard", "alerts"], source: "y", at: iso(60000), country: "CA" },
    { email: "bad@example.com", wants: "nope", source: "y", at: "garbage", country: null },
  ];
  const s = waitlistSummary(list);
  check("8: count", s.count === 4, JSON.stringify(s));
  check("8: byWant", s.byWant.alerts === 3 && s.byWant.api === 1 && s.byWant.intel === 1 && s.byWant.dkboard === 1, JSON.stringify(s.byWant));
  check("8: last7d", s.last7d === 2, s.last7d);
  check("8: newest first", s.entries[0].email === "bad@example.com" && s.entries[1].email === "new@example.com" && s.entries[3].email === "old@example.com");
  check("8: positions", s.entries[3].position === 1 && s.entries[0].position === 4);
  const empty = waitlistSummary(null);
  check("8: empty/invalid input", empty.count === 0 && empty.last7d === 0 && empty.entries.length === 0 && empty.byWant.alerts === 0);
  check("8: loadWaitlist tolerates missing key", (await loadWaitlist(env())).length === 0);
}

// 9. IP throttle: hashed key, 60s TTL, no raw IP in KV
{
  const e = env();
  check("9: not throttled initially", (await isIpThrottled(e, "203.0.113.9")) === false);
  await markIpSubmitted(e, "203.0.113.9");
  check("9: throttled after submit", (await isIpThrottled(e, "203.0.113.9")) === true);
  check("9: other ip free", (await isIpThrottled(e, "203.0.113.10")) === false);
  const key = await ipThrottleKey("203.0.113.9");
  check("9: key is wl_ip:<sha256>", /^wl_ip:[0-9a-f]{64}$/.test(key) && key in e.store, key);
  check("9: ttl 60", e.puts[0].opts && e.puts[0].opts.expirationTtl === IP_THROTTLE_SECONDS, JSON.stringify(e.puts[0]));
  check("9: raw ip not in store", !Object.keys(e.store).some(k => k.includes("203.0.113.9")));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// An Anthropic failure that is the account's, not the question's (src/investigator-outage.js).
import { OUTAGE_KEYS, OUTAGE_REPROBE_MS, outageKind, outageLabel, outageActive, priorAttempt, countedToday, KNOWN_SQL } from "../src/investigator-outage.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x === undefined ? "" : JSON.stringify(x)); } };
const NOW = Date.parse("2026-11-19T15:00:00Z");
const E401 = 'Anthropic API 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_1"}';
const ECREDIT = 'Anthropic API 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';

// ---------- which failures are the account's ----------
{
  check("kind: a rejected key and an empty account are outages, named apart", outageKind(E401) === "key" && outageKind(ECREDIT) === "credits" && outageKind("Anthropic API 403: permission_error") === "key" && outageKind("invalid x-api-key") === "key");
  check("kind: a question's own failures are not outages", outageKind("refusal") === null && outageKind("Anthropic API 529: overloaded") === null && outageKind("Anthropic API 429: rate limited") === null && outageKind("Anthropic API 400: bad request") === null && outageKind("timeout") === null && outageKind(null) === null && outageKind("") === null);
  check("label: what the cron says it is waiting for", outageLabel("key") === "anthropic key rejected" && outageLabel("credits") === "anthropic credits exhausted" && outageLabel(null) === null);
  check("flags: one KV key per kind", OUTAGE_KEYS.credits === "anthropic_billing_down" && OUTAGE_KEYS.key === "anthropic_key_down");
}

// ---------- the flag holds the cron off, then lets one call through ----------
{
  check("active: a fresh flag holds; ten minutes on, one call is let through; no flag, no hold", outageActive({ at: NOW - 60e3 }, NOW) === true && outageActive({ at: NOW - OUTAGE_REPROBE_MS - 1 }, NOW) === false && outageActive(null, NOW) === false && outageActive({}, NOW) === true);
}

// ---------- an old record against a new attempt ----------
{
  check("prior: nothing on file starts at zero", JSON.stringify(priorAttempt(null, 2)) === JSON.stringify({ skip: null, attempts: 0 }));
  check("prior: done is done", priorAttempt({ status: "done", attempts: 1 }, 2).skip === "already_done");
  check("prior: a real permanent failure, or attempts used up on real failures, still skip", priorAttempt({ status: "error_permanent", lastError: "refusal", attempts: 1 }, 2).skip === "permanent_error" && priorAttempt({ status: "error_transient", lastError: "Anthropic API 529: overloaded", attempts: 2 }, 2).skip === "attempts_exhausted");
  check("prior: a question marked failed by an outage was never tried: not skipped, attempts back to zero", JSON.stringify(priorAttempt({ status: "error_permanent", lastError: E401, attempts: 2 }, 2)) === JSON.stringify({ skip: null, attempts: 0 }) && JSON.stringify(priorAttempt({ status: "error_transient", lastError: ECREDIT, attempts: 5 }, 2)) === JSON.stringify({ skip: null, attempts: 0 }));
  check("prior: a transient failure with tries left carries its count", JSON.stringify(priorAttempt({ status: "error_transient", lastError: "timeout", attempts: 1 }, 2)) === JSON.stringify({ skip: null, attempts: 1 }));
}

// ---------- the day's count ----------
{
  check("count: a day with nothing billed has researched nothing; a billed day counts as stored", countedToday({ count: 150, usd: 0 }) === 0 && countedToday({ count: 53, usd: 10.1 }) === 53 && countedToday(null) === 0 && countedToday({ usd: 1 }) === 0);
}

// ---------- the sweep's "already researched" read ----------
{
  check("known: done and real permanent failures are known; outage failures are not", /status = 'done'/.test(KNOWN_SQL) && /error_permanent/.test(KNOWN_SQL) && /NOT LIKE 'Anthropic API 401%'/.test(KNOWN_SQL) && /NOT LIKE '%credit balance is too low%'/.test(KNOWN_SQL) && /updated_at >= \?1/.test(KNOWN_SQL));
}

console.log(`investigator-outage: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

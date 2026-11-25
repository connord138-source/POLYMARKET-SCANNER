// An Anthropic failure that is the account's, not the question's (src/investigator-outage.js).
import { readFileSync } from "node:fs";
import { OUTAGE_KEYS, OUTAGE_REPROBE_MS, outageKind, outageLabel, outageActive, priorAttempt, healable, countedToday, KNOWN_SQL, PAUSED_LABEL, researchPaused } from "../src/investigator-outage.js";
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

// ---------- the heal step ----------
{
  check("heal: a record a rejected key or an empty account marked failed is reset", healable({ status: "error_permanent", attempts: 2, lastError: E401 }) === true && healable({ status: "error_transient", attempts: 1, lastError: ECREDIT }) === true && healable({ status: "error_permanent", attempts: 0, lastError: E401 }) === true);
  check("heal: nothing to heal on a fresh transient record, a real failure, or a finished one", healable({ status: "error_transient", attempts: 0, lastError: E401 }) === false && healable({ status: "error_permanent", attempts: 2, lastError: "refusal" }) === false && healable({ status: "error_transient", attempts: 2, lastError: "timeout" }) === false && healable({ status: "done", attempts: 1, lastError: E401 }) === false && healable(null) === false && healable({}) === false);
}

// ---------- the worker uses one judgement everywhere ----------
{
  const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  check("index: the sweep passes a question over on priorAttempt, not on its own rule", /var priorS = priorAttempt\(existing, maxTries\);\s*if \(existing && priorS\.skip\)/.test(src) && !/existing\.status === "error_transient" && \(existing\.attempts \|\| 0\) < maxTries/.test(src));
  check("index: the heal step and both research loops know an outage", /if \(healable\(inv\)\)/.test(src) && /res\.outage = outageLabel\(outageKind\(r\.error\)\); break;/.test(src) && /anthropicDown = true; anthropicWhy = outageLabel\(outageKind\(r\.error\)\); break;/.test(src));
}

// ---------- the day's count ----------
{
  check("count: a day with nothing billed has researched nothing; a billed day counts as stored", countedToday({ count: 150, usd: 0 }) === 0 && countedToday({ count: 53, usd: 10.1 }) === 53 && countedToday(null) === 0 && countedToday({ usd: 1 }) === 0);
}

// ---------- the sweep's "already researched" read ----------
{
  check("known: done and real permanent failures are known; outage failures are not", /status = 'done'/.test(KNOWN_SQL) && /error_permanent/.test(KNOWN_SQL) && /NOT LIKE 'Anthropic API 401%'/.test(KNOWN_SQL) && /NOT LIKE '%credit balance is too low%'/.test(KNOWN_SQL) && /updated_at >= \?1/.test(KNOWN_SQL));
}

// ---------- the owner's pause ----------
{
  check("pause: only the word paused parks the research, however it is typed", researchPaused({ INVESTIGATOR: "paused" }) === true && researchPaused({ INVESTIGATOR: " Paused " }) === true && researchPaused({ INVESTIGATOR: "on" }) === false && researchPaused({ INVESTIGATOR: "" }) === false && researchPaused({}) === false && researchPaused(null) === false);
  check("pause: it is not an outage and says whose choice it is", PAUSED_LABEL === "paused by the owner" && outageKind(PAUSED_LABEL) === null && outageLabel("key") !== PAUSED_LABEL);
  const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  check("index: the pause is decided before any flag is read, and both research stages stand down on it", /if \(researchPaused\(env\)\) \{ anthropicDown = true; anthropicWhy = PAUSED_LABEL; \}\s*else try \{\s*for \(const kind of \["key", "credits"\]\)/.test(src) && /if \(!anthropicDown && env\.ANTHROPIC_API_KEY && alertableSignals\.length > 0\)/.test(src) && /if \(!anthropicDown && env\.ANTHROPIC_API_KEY && \(env\.SWEEP_ENABLED \|\| "true"\) !== "false"\)/.test(src));
  check("index: the report says the test is paused", /paused: researchPaused\(env\) \};/.test(src));
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const m = toml.match(/^INVESTIGATOR = "([^"]*)"$/m);
  check("wrangler: the switch is a plain variable the worker reads", !!m && (m[1] === "paused" || m[1] === "on"), m && m[1]);
  check("wrangler: the test's rule settings are untouched by the pause", /^INVESTIGATION_DAILY_USD = "5"$/m.test(toml) && /^SWEEP_MAX_DAYS = "3"$/m.test(toml) && /^SWEEP_EXCLUDE_KINDS = "weather"$/m.test(toml) && /^SWEEP_PER_EVENT = "2"$/m.test(toml));
}

console.log(`investigator-outage: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

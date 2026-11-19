// ============================================================
// INVESTIGATOR-OUTAGE.JS — an Anthropic failure that is the ACCOUNT's, not the question's
// ============================================================
//
// Nov 19 2026: after the owner changed something on the Anthropic account,
// every call answered `401 invalid x-api-key`. Only "credit balance is too
// low" was treated as an account outage, so each refused call was counted as
// a researched question (150 "researched" for $0 by midday, the day's
// question cap gone) and each question was marked failed for good after two
// tries without ever being researched. An account outage (no credits, or a
// key the API rejects) is never the question's fault: it does not count, it
// burns no attempt, and the cron stops calling until a re-probe succeeds.
// Pure helpers; index.js does the KV and the calls.

export const OUTAGE_KEYS = { credits: 'anthropic_billing_down', key: 'anthropic_key_down' };
export const OUTAGE_REPROBE_MS = 10 * 60e3;   // a refused call is free, so look again soon
export const OUTAGE_TTL_S = 3600;

// 'credits' | 'key' | null for an error string from the investigator's call.
export function outageKind(error) {
  const e = String(error || '');
  if (/credit balance is too low/i.test(e)) return 'credits';
  if (/Anthropic API 40[13]\b|invalid x-api-key|authentication_error|permission_error/i.test(e)) return 'key';
  return null;
}
export const outageLabel = (kind) => (kind === 'key' ? 'anthropic key rejected' : kind === 'credits' ? 'anthropic credits exhausted' : null);

// Is a stored outage flag still holding the cron off? After OUTAGE_REPROBE_MS one call is let through.
export function outageActive(flag, nowMs = Date.now()) {
  return !!flag && !(flag.at && nowMs - flag.at > OUTAGE_REPROBE_MS);
}

// What an existing investigation record means for a new attempt. A record
// whose last error was an account outage was never really tried: it is not
// done, not permanent, and its attempts start again.
export function priorAttempt(existing, maxAttempts) {
  if (!existing) return { skip: null, attempts: 0 };
  if (existing.status === 'done') return { skip: 'already_done', attempts: existing.attempts || 0 };
  if (outageKind(existing.lastError)) return { skip: null, attempts: 0 };
  if (existing.status === 'error_permanent') return { skip: 'permanent_error', attempts: existing.attempts || 0 };
  if (existing.status === 'error_transient' && (existing.attempts || 0) >= maxAttempts) return { skip: 'attempts_exhausted', attempts: existing.attempts || 0 };
  return { skip: null, attempts: existing.attempts || 0 };
}

// The day's count of researched questions for the cap. A day on which
// nothing was billed has researched nothing, whatever the counter says (the
// counter of Nov 19 2026 read 150 on refused calls).
export function countedToday(spend) {
  return spend && spend.usd > 0 ? (spend.count || 0) : 0;
}

// The sweep must not treat a question as already researched because an
// outage marked it failed.
export const KNOWN_SQL = "SELECT inv_key FROM investigations WHERE (status = 'done' OR (status = 'error_permanent' AND (last_error IS NULL OR (last_error NOT LIKE 'Anthropic API 401%' AND last_error NOT LIKE 'Anthropic API 403%' AND last_error NOT LIKE '%credit balance is too low%')))) AND updated_at >= ?1";

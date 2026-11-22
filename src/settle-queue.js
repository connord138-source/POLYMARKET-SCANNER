// ============================================================
// SETTLE-QUEUE.JS — the pending-signals list across a bounded settlement pass
// ============================================================
//
// Nov 22 2026: the settlement stage looked up every pending signal (up to
// 500) on Gamma, one after another, with no time limit: about 50 seconds on
// a normal cycle and 285 seconds when Gamma was slow (the 15:00 UTC cycle of
// Nov 18, 19 and 22 ran past the five minutes between cycles). It also wrote
// back the list it had read at the start, so a signal the next cycle's scan
// added while a slow pass was still running was dropped from the list and
// never settled. The pass now has a wall budget, resumes where it stopped,
// and merges what was added meanwhile. Pure helpers; index.js does the KV.

export const SETTLE_WALL_MS = 90000;      // one pass's wall budget
export const SETTLE_CURSOR_KEY = 'settle_cursor';
export const PENDING_CAP = 500;

// The order to check this pass: the list as stored, starting at the signal
// the last pass stopped before (the whole list when that id is gone).
export function settleOrder(list, cursorId) {
  const ids = Array.isArray(list) ? list : [];
  const at = cursorId ? ids.indexOf(cursorId) : -1;
  return at > 0 ? ids.slice(at).concat(ids.slice(0, at)) : ids.slice();
}

// The list to store after a pass. `start` = the list read at the start (its
// order is kept), `kept` = ids checked and still open, `unchecked` = ids the
// budget did not reach, `fresh` = the list as stored now (ids in it that were
// not in `start` were added while the pass ran and are kept at the end).
export function nextPendingList({ start, kept, unchecked, fresh, cap = PENDING_CAP }) {
  const keep = new Set([...(kept || []), ...(unchecked || [])]);
  const seen = new Set(start || []);
  const out = [];
  const have = new Set();
  for (const id of start || []) if (keep.has(id) && !have.has(id)) { out.push(id); have.add(id); }
  for (const id of Array.isArray(fresh) ? fresh : []) if (!seen.has(id) && !have.has(id)) { out.push(id); have.add(id); }
  return out.length > cap ? out.slice(-cap) : out;
}

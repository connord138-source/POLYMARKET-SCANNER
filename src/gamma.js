// Polymarket Gamma API - ground-truth settlement helpers.
// Extracted from index.js (behaviourally identical).

// ============================================================
// GAMMA API - GROUND-TRUTH SETTLEMENT
// Polymarket's Gamma API reports authoritative market resolution
// (closed flag + final outcome prices). This replaces the old
// "infer settlement from recent trade prices" heuristic as the
// primary settlement source; Odds API and the trades heuristic
// remain as fallbacks when Gamma can't locate the market.
// ============================================================

var GAMMA_API = "https://gamma-api.polymarket.com";

// Gamma returns outcomes/outcomePrices as JSON-encoded strings on some
// endpoints and real arrays on others - normalize both.
function parseGammaArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      var parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }
  return null;
}

function normalizeOutcomeText(text) {
  return (text || "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Match a signal direction against a list of outcome names.
// Tries exact normalized match first, then substring containment.
// Returns -1 when no unambiguous match exists - a wrong label is
// worse for the learning system than an honest UNKNOWN.
function matchOutcomeIndex(outcomeNames, direction) {
  if (!outcomeNames || !direction) return -1;
  var dir = normalizeOutcomeText(direction);
  if (!dir) return -1;

  for (var i = 0; i < outcomeNames.length; i++) {
    if (normalizeOutcomeText(outcomeNames[i]) === dir) return i;
  }

  var hits = [];
  for (var j = 0; j < outcomeNames.length; j++) {
    var name = normalizeOutcomeText(outcomeNames[j]);
    if (!name) continue;
    if (name.includes(dir) || dir.includes(name)) hits.push(j);
  }
  return hits.length === 1 ? hits[0] : -1;
}

async function fetchGammaJson(path) {
  var res = await fetch(GAMMA_API + path, {
    headers: { "Accept": "application/json" }
  });
  if (!res.ok) {
    console.log("Gamma API error " + res.status + " for " + path);
    return null;
  }
  return await res.json();
}

// Title-token overlap (containment-style). Used only to accept a confident
// public-search match; loose matches are rejected to avoid mis-settlement.
function titleTokens(text) {
  var set = new Set();
  (text || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).forEach(function (w) {
    if (w.length > 2) set.add(w);
  });
  return set;
}
function titleSimilarity(a, b) {
  var A = titleTokens(a), B = titleTokens(b);
  if (!A.size || !B.size) return 0;
  var inter = 0;
  A.forEach(function (w) { if (B.has(w)) inter++; });
  return inter / Math.min(A.size, B.size);
}

// Multi-market event resolution. Order of preference:
//   1. Moneyline - a market whose OUTCOMES exactly match the direction and
//      whose groupItemTitle is NOT a sub-period (set/game/map/period...). This
//      disambiguates tennis (moneyline vs "Set 1 Winner") and esports
//      (Match Winner vs "Game N Winner") where several sub-markets share the
//      same competitor-name outcomes.
//   2. A single exact outcome match anywhere.
//   3. Grouped Yes/No: the direction names the sub-market via groupItemTitle
//      (candidate/team) and outcomes are Yes/No -> settle as a YES bet.
//   4. A single substring outcome hit.
// Anything ambiguous returns market:null so the caller grades UNKNOWN rather
// than guess.
function resolveMultiMarket(event, direction) {
  var dirN = normalizeOutcomeText(direction);

  var exact = [];
  for (var i = 0; i < event.markets.length; i++) {
    var names = parseGammaArray(event.markets[i].outcomes);
    if (names && names.some(function (n) { return normalizeOutcomeText(n) === dirN; })) {
      exact.push(i);
    }
  }
  var primary = exact.filter(function (idx) {
    var t = normalizeOutcomeText(event.markets[idx].groupItemTitle);
    if (t === "") return true; // moneyline often has no group title
    return !/set|game|map|period|quarter|half|inning|leg|round/.test(t);
  });
  if (primary.length === 1) return { market: event.markets[primary[0]], via: "event-moneyline" };
  if (exact.length === 1) return { market: event.markets[exact[0]], via: "event-outcome-exact" };

  var titles = event.markets.map(function (m) { return m.groupItemTitle || m.question || ""; });
  var gi = matchOutcomeIndex(titles, direction);
  if (gi >= 0) return { market: event.markets[gi], via: "event-group-item" };

  var subs = [];
  for (var k = 0; k < event.markets.length; k++) {
    var nk = parseGammaArray(event.markets[k].outcomes);
    if (nk && matchOutcomeIndex(nk, direction) >= 0) subs.push(k);
  }
  if (subs.length === 1) return { market: event.markets[subs[0]], via: "event-outcome" };

  return { market: null, via: "event-ambiguous", event: event };
}

// Last resort when the scanner's slug isn't a Gamma slug: search by title and
// accept only a confident event match. Re-fetches the matched event by its
// real slug so we get its full markets array.
async function searchGammaEvent(title) {
  if (!title) return null;
  var data = await fetchGammaJson("/public-search?q=" + encodeURIComponent(title) + "&limit_per_type=5");
  var events = (data && data.events) || [];
  if (!events.length) return null;
  var best = null, bestScore = 0;
  for (var i = 0; i < events.length; i++) {
    var s = titleSimilarity(title, events[i].title || "");
    if (s > bestScore) { bestScore = s; best = events[i]; }
  }
  if (!best || bestScore < 0.6 || !best.slug) return null;
  var bySlug = await fetchGammaJson("/events?closed=true&slug=" + encodeURIComponent(best.slug));
  var ev = bySlug && bySlug[0];
  if (ev && Array.isArray(ev.markets) && ev.markets.length) return ev;
  return null;
}

// Resolve a market object from Gamma by slug. Signals sometimes carry an
// event slug instead of a market slug (trades expose both), so fall back to
// the events endpoint, then to a title search.
//
// IMPORTANT: /markets?slug and /events?slug HIDE closed markets by default, so
// a resolved market returns nothing unless we also query with closed=true.
// Since settlement lookups are overwhelmingly for closed markets, we try the
// default (open) query first, then the closed query.
async function findGammaMarket(marketSlug, direction, title) {
  var markets = await fetchGammaJson("/markets?slug=" + encodeURIComponent(marketSlug));
  if (!markets || markets.length === 0) {
    markets = await fetchGammaJson("/markets?closed=true&slug=" + encodeURIComponent(marketSlug));
  }
  if (markets && markets.length > 0) {
    return { market: markets[0], via: "market-slug" };
  }

  var events = await fetchGammaJson("/events?slug=" + encodeURIComponent(marketSlug));
  if (!events || events.length === 0) {
    events = await fetchGammaJson("/events?closed=true&slug=" + encodeURIComponent(marketSlug));
  }
  var event = events && events[0];

  if (!event || !Array.isArray(event.markets) || event.markets.length === 0) {
    event = await searchGammaEvent(title);
  }
  if (!event || !Array.isArray(event.markets) || event.markets.length === 0) {
    return null;
  }
  if (event.markets.length === 1) {
    return { market: event.markets[0], via: "event-slug" };
  }
  return resolveMultiMarket(event, direction);
}

// Ground-truth settlement check. Returns one of:
//   { status: "not_found" }
//   { status: "open", currentPrice }
//   { status: "closed_unresolved" }  - trading closed, resolution not final
//   { status: "settled", outcome: "WIN"|"LOSS"|"UNKNOWN", winningOutcome, note }
async function settleWithGamma(marketSlug, direction, title) {
  var found = await findGammaMarket(marketSlug, direction, title);
  if (!found) return { status: "not_found" };

  if (!found.market) {
    // Event exists but we can't tell which sub-market the signal was on.
    // If every sub-market is closed the event is over - grade UNKNOWN so
    // it stops polling; otherwise keep waiting.
    var allClosed = found.event.markets.every(function (m) { return m.closed === true; });
    if (allClosed) {
      return {
        status: "settled",
        outcome: "UNKNOWN",
        winningOutcome: null,
        note: "Event resolved but direction '" + direction + "' matched no sub-market"
      };
    }
    return { status: "open", currentPrice: null };
  }

  var market = found.market;
  var names = parseGammaArray(market.outcomes);
  var prices = parseGammaArray(market.outcomePrices);

  if (market.closed !== true) {
    var openIdx = (names && prices) ? matchOutcomeIndex(names, direction) : -1;
    return {
      status: "open",
      currentPrice: openIdx >= 0 ? parseFloat(prices[openIdx]) : null
    };
  }

  if (!names || !prices || names.length === 0 || names.length !== prices.length) {
    return {
      status: "settled",
      outcome: "UNKNOWN",
      winningOutcome: null,
      note: "Market closed but Gamma returned no usable outcome data"
    };
  }

  // Winner = outcome whose final price is ~1. If no outcome is near 1 the
  // market closed without final resolution (e.g. UMA dispute in progress).
  var winnerIdx = 0;
  var winnerPrice = -1;
  for (var p = 0; p < prices.length; p++) {
    var price = parseFloat(prices[p]);
    if (price > winnerPrice) {
      winnerPrice = price;
      winnerIdx = p;
    }
  }
  if (!(winnerPrice >= 0.95)) {
    return { status: "closed_unresolved" };
  }

  var winningOutcome = names[winnerIdx];
  var directionIdx = matchOutcomeIndex(names, direction);
  if (directionIdx < 0 && found.via === "event-group-item") {
    // The direction named the sub-market (candidate/team via groupItemTitle),
    // not one of its Yes/No outcome labels. Betting on that side == betting
    // YES on this sub-market.
    directionIdx = matchOutcomeIndex(names, "Yes");
  }
  if (directionIdx < 0) {
    return {
      status: "settled",
      outcome: "UNKNOWN",
      winningOutcome: winningOutcome,
      note: "Resolved (winner: " + winningOutcome + ") but direction '" + direction + "' matched no outcome"
    };
  }

  return {
    status: "settled",
    outcome: directionIdx === winnerIdx ? "WIN" : "LOSS",
    winningOutcome: winningOutcome,
    resolutionPrice: winnerPrice,
    via: found.via
  };
}


export {
  GAMMA_API, parseGammaArray, normalizeOutcomeText, matchOutcomeIndex,
  fetchGammaJson, findGammaMarket, settleWithGamma
};

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

// Resolve a market object from Gamma by slug. Signals sometimes carry an
// event slug instead of a market slug (trades expose both), so fall back
// to the events endpoint and pick the sub-market matching the direction.
async function findGammaMarket(marketSlug, direction) {
  var markets = await fetchGammaJson("/markets?slug=" + encodeURIComponent(marketSlug));
  if (markets && markets.length > 0) {
    return { market: markets[0], via: "market-slug" };
  }

  var events = await fetchGammaJson("/events?slug=" + encodeURIComponent(marketSlug));
  var event = events && events[0];
  if (!event || !Array.isArray(event.markets) || event.markets.length === 0) {
    return null;
  }
  if (event.markets.length === 1) {
    return { market: event.markets[0], via: "event-slug" };
  }

  // Multi-market event: match direction against groupItemTitle (the option
  // name, e.g. a team or candidate) first, then against outcome names.
  var titles = event.markets.map(function (m) { return m.groupItemTitle || m.question || ""; });
  var idx = matchOutcomeIndex(titles, direction);
  if (idx >= 0) {
    return { market: event.markets[idx], via: "event-group-item" };
  }
  var outcomeHits = [];
  for (var i = 0; i < event.markets.length; i++) {
    var names = parseGammaArray(event.markets[i].outcomes);
    if (names && matchOutcomeIndex(names, direction) >= 0) outcomeHits.push(i);
  }
  if (outcomeHits.length === 1) {
    return { market: event.markets[outcomeHits[0]], via: "event-outcome" };
  }
  return { market: null, via: "event-ambiguous", event: event };
}

// Ground-truth settlement check. Returns one of:
//   { status: "not_found" }
//   { status: "open", currentPrice }
//   { status: "closed_unresolved" }  - trading closed, resolution not final
//   { status: "settled", outcome: "WIN"|"LOSS"|"UNKNOWN", winningOutcome, note }
async function settleWithGamma(marketSlug, direction) {
  var found = await findGammaMarket(marketSlug, direction);
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

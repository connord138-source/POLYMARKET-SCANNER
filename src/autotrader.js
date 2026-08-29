// ============================================================
// AUTOTRADER.JS - Autonomous Trading Engine for EDGERUNNER
// v1.3.0 - Data-driven upgrade: sports position scaling, smart mirror exits,
//           AI score override, market categorization, skip dedup, category tracking,
//           whale-deferred take profit with trailing stop protection
// ============================================================
// 
// Architecture:
// 1. Cron fires → checks latest signals for wallet activity
// 2. Filters through risk parameters (daily limits, wallet WR, etc.)
// 3. Calculates position size (Kelly Criterion or fixed)
// 4. Places/exits trades via Polymarket CLOB (Phase 3)
// 5. Tracks all positions, settles outcomes, feeds learning loop
// ============================================================

import { calculateConfidence, getFactorStats, hasStrongCombo } from './at-learning.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const POLY_DATA_API = 'https://data-api.polymarket.com';

// ============================================================
// KV KEY CONSTANTS
// ============================================================
const AT_KEYS = {
  CONFIG: 'autotrader_config',
  POSITIONS: 'autotrader_positions',        // Open positions
  HISTORY: 'autotrader_history',            // Closed/settled trades
  DAILY_STATS: 'autotrader_daily_stats',    // Per-day P&L tracking
  PERFORMANCE: 'autotrader_performance',    // Lifetime bot performance
  WATCHLIST: 'autotrader_watchlist',        // Wallets to mirror
  TRADE_LOG: 'autotrader_trade_log',        // Detailed log of all decisions
  LEARNING: 'autotrader_learning',          // Bot-specific factor performance
  RECENT_MARKETS: 'autotrader_recent_markets', // Cross-cycle duplicate tracking
  SKIP_LOG_MEMORY: 'autotrader_skip_log_memory', // Cross-cycle skip-log dedupe
  TOKEN_CACHE: 'autotrader_token_cache',    // slug → tokenId mapping cache
  EXEC_QUEUE: 'autotrader_exec_queue',      // Pending trades for executor to place
};

// ============================================================
// LIVE PRICE FETCHING from Polymarket CLOB API
// ============================================================
// Flow: position.marketSlug → Gamma API (get clobTokenIds) → CLOB API (get midpoint)
// Caches slug→tokenId mappings in KV to avoid repeated Gamma lookups

async function getTokenCache(env) {
  try {
    return await env.SIGNALS_CACHE.get(AT_KEYS.TOKEN_CACHE, { type: 'json' }) || {};
  } catch (e) { return {}; }
}

async function saveTokenCache(env, cache) {
  try {
    await env.SIGNALS_CACHE.put(AT_KEYS.TOKEN_CACHE, JSON.stringify(cache), {
      expirationTtl: 7 * 24 * 60 * 60 // 7 days
    });
  } catch (e) {}
}

/**
 * Look up clobTokenIds for a market slug via Gamma API
 * Returns { yesTokenId, noTokenId, conditionId, closed } or null
 */
async function lookupMarketTokens(slug) {
  try {
    let res = await fetch(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}&limit=1`);
    let markets = res.ok ? await res.json() : null;
    if (!markets || markets.length === 0) {
      // Gamma HIDES closed markets from the default slug listing (see the
      // note in src/gamma.js) — a resolved market returns [] unless queried
      // with closed=true. Without this retry, settlement can never find the
      // very markets it exists to settle.
      res = await fetch(`${GAMMA_API}/markets?closed=true&slug=${encodeURIComponent(slug)}&limit=1`);
      markets = res.ok ? await res.json() : null;
    }
    if (!markets || markets.length === 0) return null;

    const market = markets[0];
    const tokenIds = typeof market.clobTokenIds === 'string' 
      ? JSON.parse(market.clobTokenIds) 
      : market.clobTokenIds;
    const outcomes = typeof market.outcomes === 'string'
      ? JSON.parse(market.outcomes)
      : market.outcomes;
    const outcomePrices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices)
      : market.outcomePrices;
    
    if (!tokenIds || tokenIds.length < 2) return null;
    
    return {
      yesTokenId: tokenIds[0],
      noTokenId: tokenIds[1],
      conditionId: market.conditionId || null,
      closed: market.closed || false,
      resolved: market.closed || false,
      endDate: market.endDate || null,
      outcomes: outcomes || ['Yes', 'No'],
      // Include Gamma's own prices as fallback
      gammaPrices: outcomePrices ? outcomePrices.map(p => parseFloat(p)) : null,
    };
  } catch (e) {
    console.error(`Gamma lookup failed for ${slug}:`, e.message);
    return null;
  }
}

// A closed market is safely settle-able when one side is ~certain (>=95c,
// same convention as src/gamma.js) or when it resolved as an explicit 50/50
// refund. In-between prices usually mean trading closed but resolution isn't
// final (e.g. UMA dispute) — keep waiting instead of settling at a non-final
// price.
function isSettledPrice(gp) {
  if (!gp || !gp.length || typeof gp[0] !== 'number' || isNaN(gp[0])) return false;
  return Math.max(gp[0], 1 - gp[0]) >= 0.95 || gp[0] === 0.5;
}

/**
 * Price the side a position actually holds. liveData.price is always the
 * YES-token (outcomes[0]) price, but positions can hold either side — "No",
 * a team name (outcomes[1]), "Under 8.5", etc. Match the position's direction
 * against the market's real outcome labels; unmatched directions fall back to
 * the legacy rule (flip only on literal NO).
 */
function priceForPosition(liveData, position) {
  const yes = liveData.price;
  const outcomes = Array.isArray(liveData.outcomes) && liveData.outcomes.length >= 2
    ? liveData.outcomes
    : ['Yes', 'No'];
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const o0 = norm(outcomes[0]);
  const o1 = norm(outcomes[1]);
  for (const raw of [position.directionRaw, position.direction]) {
    const dir = norm(raw);
    if (!dir || dir === 'unknown') continue;
    if (dir === o0) return yes;
    if (dir === o1) return 100 - yes;
    // Prefix match covers "Under 8.5" (direction) vs "Under" (outcome)
    const p0 = o0 && (dir.startsWith(o0) || o0.startsWith(dir));
    const p1 = o1 && (dir.startsWith(o1) || o1.startsWith(dir));
    if (p0 && !p1) return yes;
    if (p1 && !p0) return 100 - yes;
  }
  return norm(position.direction) === 'no' ? 100 - yes : yes;
}

/**
 * Fetch live prices for all open positions from Polymarket CLOB
 * Returns a Map of marketSlug → { price (as percent), source, closed, outcomes }
 */
async function fetchLivePrices(env, positions) {
  const priceMap = new Map(); // marketSlug → { price, source }
  if (!positions || positions.length === 0) return priceMap;
  
  // Load cached slug → tokenId mappings
  const tokenCache = await getTokenCache(env);
  let cacheUpdated = false;
  
  // Step 1: Resolve all slugs to token IDs
  const tokenLookups = [];
  for (const pos of positions) {
    const slug = pos.marketSlug;
    if (priceMap.has(slug)) continue; // Already handling this slug
    
    // Check if we have cached token info
    if (tokenCache[slug]) {
      tokenLookups.push({ slug, tokens: tokenCache[slug], position: pos });
    } else {
      // Need to look up via Gamma API
      tokenLookups.push({ slug, tokens: null, position: pos, needsLookup: true });
    }
  }
  
  // Step 2: Batch Gamma lookups for unknown slugs (parallel, max 5 at a time)
  const needsLookup = tokenLookups.filter(t => t.needsLookup);
  if (needsLookup.length > 0) {
    const batchSize = 5;
    for (let i = 0; i < needsLookup.length; i += batchSize) {
      const batch = needsLookup.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          const tokens = await lookupMarketTokens(item.slug);
          if (tokens) {
            tokenCache[item.slug] = tokens;
            cacheUpdated = true;
            item.tokens = tokens;
          }
          return tokens;
        })
      );
    }
  }
  
  // Step 3: Fetch midpoints from CLOB for all tokens we have
  const tokenIdToSlug = new Map(); // tokenId → { slug, direction }
  for (const item of tokenLookups) {
    if (!item.tokens) continue;
    
    // If market is closed/resolved, use Gamma prices — but only when the
    // resolution looks final (same gate as the fresh-lookup path below).
    if (item.tokens.closed || item.tokens.resolved) {
      const gammaPrice = item.tokens.gammaPrices;
      if (gammaPrice && isSettledPrice(gammaPrice)) {
        // YES price = gammaPrices[0], NO price = 1 - YES price
        const yesPercent = Math.round(gammaPrice[0] * 100);
        priceMap.set(item.slug, {
          price: yesPercent,
          source: 'gamma_resolved',
          closed: true,
          outcomes: item.tokens.outcomes
        });
      }
      continue;
    }

    // Map the YES token to this slug
    // We always fetch YES token midpoint — NO price is just (100 - YES)
    tokenIdToSlug.set(item.tokens.yesTokenId, {
      slug: item.slug,
      direction: item.position.direction,
      outcomes: item.tokens.outcomes
    });
  }
  
  // Batch fetch midpoints from CLOB (supports comma-separated token_ids)
  const allTokenIds = [...tokenIdToSlug.keys()];
  if (allTokenIds.length > 0) {
    try {
      // CLOB supports batch midpoint queries
      const batchSize = 20; // Max per request
      for (let i = 0; i < allTokenIds.length; i += batchSize) {
        const batch = allTokenIds.slice(i, i + batchSize);
        const idsParam = batch.join(',');
        const res = await fetch(`${CLOB_API}/midpoints?token_ids=${idsParam}`);
        
        if (res.ok) {
          const data = await res.json();
          // Response: { "tokenId1": "0.65", "tokenId2": "0.30", ... }
          for (const [tokenId, midStr] of Object.entries(data)) {
            const mid = parseFloat(midStr);
            if (isNaN(mid)) continue;
            
            const info = tokenIdToSlug.get(tokenId);
            if (info) {
              // Midpoint is a decimal (e.g. 0.65 = 65%)
              const yesPercent = Math.round(mid * 100);
              priceMap.set(info.slug, {
                price: yesPercent,
                source: 'clob_midpoint',
                closed: false,
                outcomes: info.outcomes
              });
            }
          }
        }
      }
    } catch (e) {
      console.error('CLOB midpoint batch fetch error:', e.message);
    }
  }

  // Step 4: Any slug still without a price usually means the order book is
  // gone — which on Polymarket means the market RESOLVED. The token cache
  // pinned closed:false at entry time, so re-check Gamma fresh; if the market
  // settled, emit its final price so the exit engine records the real
  // win/loss instead of voiding the trade after maxHoldHours (stale_timeout).
  const missingSlugs = [...new Set(
    tokenLookups.filter(t => !priceMap.has(t.slug)).map(t => t.slug)
  )];
  for (let i = 0; i < missingSlugs.length; i += 5) {
    const batch = missingSlugs.slice(i, i + 5);
    await Promise.allSettled(batch.map(async (slug) => {
      const fresh = await lookupMarketTokens(slug);
      if (!fresh) return;
      tokenCache[slug] = fresh;
      cacheUpdated = true;
      const gp = fresh.gammaPrices;
      if (fresh.closed && isSettledPrice(gp)) {
        priceMap.set(slug, {
          price: Math.round(gp[0] * 100),
          source: 'gamma_resolved',
          closed: true,
          outcomes: fresh.outcomes
        });
      }
    }));
  }

  // Save updated token cache
  if (cacheUpdated) {
    await saveTokenCache(env, tokenCache);
  }

  return priceMap;
}

// Detect whether the whale we mirrored has since sold/reduced their position.
// For each open position we watch its whaleWallet's recent Polymarket activity;
// a SELL (or REDEEM/MERGE) in the same market after we entered means the smart
// money is heading out — the reason we entered is gone, so we mirror the exit.
// Returns a Set of marketSlugs where the whale has exited.
async function detectWhaleExits(env, positions) {
  const exited = new Set();
  if (!positions || positions.length === 0) return exited;

  // Group positions by the wallet to watch (dedupe API calls).
  const byWallet = {};
  for (const p of positions) {
    const w = (p.whaleWallet || '').toLowerCase();
    if (!w || w === 'unknown' || !p.marketSlug) continue;
    (byWallet[w] = byWallet[w] || []).push(p);
  }
  const wallets = Object.keys(byWallet);

  for (const wallet of wallets.slice(0, 30)) {   // cap per run
    try {
      const res = await fetch(`${POLY_DATA_API}/activity?user=${wallet}&limit=100`);
      if (!res.ok) continue;
      const acts = await res.json();
      if (!Array.isArray(acts)) continue;
      for (const p of byWallet[wallet]) {
        const slug = (p.marketSlug || '').toLowerCase();
        const openedMs = new Date(p.openedAt).getTime();
        const sold = acts.some((a) => {
          const aSlug = String(a.slug || a.eventSlug || '').toLowerCase();
          if (!aSlug || !(aSlug === slug || aSlug.includes(slug) || slug.includes(aSlug))) return false;
          let ts = a.timestamp || 0;
          if (ts && ts < 1e12) ts *= 1000;
          if (ts <= openedMs) return false;   // only sells AFTER we entered
          const side = String(a.side || '').toUpperCase();
          const type = String(a.type || '').toUpperCase();
          return side === 'SELL' || type === 'REDEEM' || type === 'MERGE';
        });
        if (sold) exited.add(p.marketSlug);
      }
    } catch (e) { /* skip this wallet */ }
  }
  return exited;
}

// Normalize market title for duplicate matching
// Strips dates, extra whitespace, and common suffixes
function normalizeMarketKey(title) {
  if (!title) return '';
  return title
    .replace(/\d{4}-\d{2}-\d{2}/g, '')     // Remove YYYY-MM-DD dates
    .replace(/on \d{4}-\d{2}-\d{2}/g, '')   // Remove "on 2026-02-15"
    .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/gi, '') // Remove "Feb 15"
    .replace(/\s+/g, ' ')                    // Collapse whitespace
    .trim()
    .toLowerCase();
}

// Track markets traded recently (across cron cycles)
async function getRecentMarkets(env) {
  try {
    return await env.SIGNALS_CACHE.get(AT_KEYS.RECENT_MARKETS, { type: 'json' }) || {};
  } catch (e) { return {}; }
}

async function addRecentMarket(env, marketSlug, marketTitle) {
  const recent = await getRecentMarkets(env);
  const now = Date.now();
  // Clean entries older than 2 hours
  for (const key of Object.keys(recent)) {
    if (now - recent[key].timestamp > 2 * 60 * 60 * 1000) {
      delete recent[key];
    }
  }
  recent[marketSlug] = { title: marketTitle, normalizedTitle: normalizeMarketKey(marketTitle), timestamp: now };
  if (marketTitle) {
    const normKey = normalizeMarketKey(marketTitle);
    recent[`title_${normKey}`] = { slug: marketSlug, timestamp: now };
  }
  await env.SIGNALS_CACHE.put(AT_KEYS.RECENT_MARKETS, JSON.stringify(recent), {
    expirationTtl: 4 * 60 * 60 // 4 hours
  });
}

// ============================================================
// DEFAULT CONFIGURATION (user overrides via UI)
// ============================================================
const DEFAULT_CONFIG = {
  // Master switch
  enabled: false,
  paperTradeMode: true,           // Log trades but don't execute

  // Risk Controls
  bankroll: 2500,                 // Total trading capital (USDC)
  maxDailyTrades: 5,              // Max new positions per day
  maxDailySpend: 500,             // Max USDC deployed per day
  maxPositionSize: 100,           // Max per single trade (USDC)
  minPositionSize: 10,            // Min per trade (avoid dust)
  maxOpenPositions: 10,           // Total concurrent positions
  maxPortfolioRisk: 20,           // % of bankroll at risk at any time
  dailyLossLimit: -150,           // Stop trading for the day once realized P&L falls to this (USDC, negative)

  // Signal Filters
  minWalletWinRate: 70,           // Minimum wallet WR to mirror (%)
  minWalletBets: 10,              // Minimum settled bets before trusting
  walletTiers: ['INSIDER'],       // Which tiers to follow
  allowedMarketTypes: ['moneyline'], // moneyline, over-under, spread, politics, crypto
  allowedSports: ['nba', 'nfl', 'nhl', 'mlb', 'ncaab', 'soccer'],
  blockedCategories: ['politics', 'other'],   // Categories to skip entirely
  minOdds: 15,                    // Min entry price (avoid extreme longshots)
  maxOdds: 85,                    // Max entry price (avoid extreme favorites)
  sportsMaxOdds: 48,              // Max entry for sports moneyline (data shows 50%+ loses)
  sportsMinOdds: 20,              // Min entry for sports (below 20% is extreme longshot)
  derivativeMaxOdds: 55,          // Max entry for O/U, BTTS, spread markets
  derivativeMinOdds: 25,          // Min for derivative markets
  minExpectedValue: 0.10,         // Minimum EV to enter (0.10 = +10%)
  maxEntryCentsSlippage: 5,       // Max absolute cents difference from whale entry
  minAiScore: 40,                 // Minimum AI score to consider
  maxEventHorizonHours: 168,      // Skip markets resolving further out than this (0 = disabled)
  staleVoidGraceHours: 48,        // Extra hours past maxHoldHours to wait for resolution before voiding a no-price position
  requireProvenEdge: true,        // Only trade signals whose entry band has a proven positive historical edge (signal.hasPositiveEdge)
  // v21.3.0 EXPLORATION FLOOR. Even with the 14d rolling edge window
  // (edge_profile_v2), a strict edgeNet>0 gate can deadlock: when every band
  // reads slightly negative, nothing trades and the operator sees "Scanning
  // for signals..." indefinitely (Aug 13-19: 266/266 signals skipped on
  // "No proven edge" for six straight days). The floor lets a small daily
  // quota of entries through UNPROVEN or MILDLY negative bands at reduced
  // size, so the ledger keeps learning and a recovering edge can requalify
  // itself even while the window reads cold. Decisively negative bands
  // (edgeNet <= edgeHardNegativePts) stay blocked outright. Set
  // edgeExplorationTradesPerDay: 0 to restore the old hard lockout behavior.
  edgeExplorationTradesPerDay: 5,     // Daily quota of exploration entries through the edge gate
  edgeExplorationSizeMultiplier: 0.5, // Position-size haircut for exploration entries
  edgeHardNegativePts: -5,            // Bands at or below this net edge are never explored
  onlyBuySignals: false,          // If true, ignore SELL signals (safer for start)
  maxEntrySlippage: 15,           // Max % price can move from whale entry before we skip
  entryCooldownSeconds: 120,      // Minimum seconds between new entries

  // Position Sizing
  sizingMethod: 'fixed',          // 'fixed', 'kelly', 'quarter_kelly', 'half_kelly'
  fixedSize: 50,                  // Fixed position size in USDC (when sizingMethod='fixed')
  kellyFraction: 0.25,            // Fraction of Kelly (0.25 = quarter Kelly)
  maxKellySize: 200,              // Cap Kelly sizing

  // Exit Rules
  stopLossPercent: 30,            // Exit if price drops X% from entry
  takeProfitPercent: 50,          // Exit if price rises X% from entry
  trailingStopActivation: 30,     // Activate trailing stop after +X% gain
  trailingStopPercent: 20,        // Trail X% below peak
  sportsTrailingActivation: 15,    // Activate trailing stop at +15% for sports
  sportsTrailingPercent: 10,      // Trail 10% below peak for sports
  whaleDefersTakeProfit: true,   // If whale is still holding, defer take profit exit
  mirrorExits: true,              // Exit when tracked wallet exits
  mirrorExitMinLossPercent: 10,   // Only mirror exit if loss > 10%
  exitBeforeEventHours: 2,        // Exit X hours before event if not settled
  maxHoldHours: 72,               // Max time to hold a position

  sportsPositionScale: 0.5,       // Half position size on binary sports markets
  sportsBetSize: 0,              // Override size for sports (0 = use default)
  nonSportsBetSize: 0,           // Override for non-sports (0 = use default)
  cryptoBetSize: 0,
  politicsBetSize: 0,
  weatherBetSize: 25,
  // High conviction bypass — allows trades WITHOUT a winning wallet match when signal is strong enough
  allowHighConvictionBypass: true,
  highConvictionMinScore: 80,         // Signal score must be >= this
  highConvictionMinBet: 50000,        // Largest bet must be >= $50K
  highConvictionMinWallets: 3,       // Must have 3+ unique wallets
  highConvictionMaxOdds: 48,         // Cap odds tighter for unknown wallets
  highConvictionSizeMultiplier: 0.5,  // Half position size for unverified whales
  deduplicateSkipLogs: true,     // Only log first SKIP per market per cycle
  trackMarketCategory: true,     // Tag trades with category for analytics

  // Learning
  adaptiveSizing: false,          // Scale size based on bot's own track record (Phase 4)

  // AI Learning Integration
  useLearningData: true,          // Use learning.js factor/pattern data in trade decisions
  minLearningConfidence: 35,      // Min AI confidence score to enter (0-100)
  learningBoostThreshold: 65,     // Confidence above this boosts position size
  learningBoostMultiplier: 1.25,  // Size multiplier when confidence is high
  learningPenaltyThreshold: 40,   // Confidence below this reduces size
  learningPenaltyMultiplier: 0.6, // Size multiplier when confidence is low
  minFactorWinRate: 40,           // Block entry if signal's market type factor WR is below this
  useFactorCombos: true,          // Check factor combo data for edge validation
};

// ============================================================
// GET / SET CONFIG
// ============================================================
export async function getAutotraderConfig(env) {
  if (!env.SIGNALS_CACHE) return { ...DEFAULT_CONFIG };
  try {
    const saved = await env.SIGNALS_CACHE.get(AT_KEYS.CONFIG, { type: 'json' });
    return { ...DEFAULT_CONFIG, ...(saved || {}) };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

export async function updateAutotraderConfig(env, updates) {
  const current = await getAutotraderConfig(env);
  const merged = { ...current, ...updates, updatedAt: new Date().toISOString() };
  
  // Validate critical fields
  if (merged.maxPositionSize > merged.bankroll * 0.5) {
    return { error: 'maxPositionSize cannot exceed 50% of bankroll' };
  }
  if (merged.maxDailySpend > merged.bankroll) {
    return { error: 'maxDailySpend cannot exceed bankroll' };
  }
  
  await env.SIGNALS_CACHE.put(AT_KEYS.CONFIG, JSON.stringify(merged), {
    expirationTtl: 365 * 24 * 60 * 60  // 1 year
  });
  return { success: true, config: merged };
}

// ============================================================
// POSITION MANAGEMENT
// ============================================================
export async function getOpenPositions(env) {
  if (!env.SIGNALS_CACHE) return [];
  try {
    return await env.SIGNALS_CACHE.get(AT_KEYS.POSITIONS, { type: 'json' }) || [];
  } catch (e) { return []; }
}

async function savePositions(env, positions) {
  await env.SIGNALS_CACHE.put(AT_KEYS.POSITIONS, JSON.stringify(positions), {
    expirationTtl: 30 * 24 * 60 * 60
  });
}

// ============================================================
// EXECUTION QUEUE — Trades waiting for executor to place on-chain
// ============================================================
export async function getExecQueue(env) {
  try {
    return await env.SIGNALS_CACHE.get(AT_KEYS.EXEC_QUEUE, { type: 'json' }) || [];
  } catch (e) { return []; }
}

async function addToExecQueue(env, trade) {
  const queue = await getExecQueue(env);

  // Dedup: don't add if same tokenId + action is already PENDING
  const isDupe = queue.some(q =>
    q.status === 'PENDING' &&
    q.action === trade.action &&
    (
      (q.tokenId && q.tokenId === trade.tokenId) ||
      (q.marketSlug && q.marketSlug === trade.marketSlug)
    )
  );

  if (isDupe) {
    console.log(`[DEDUP] Skipping duplicate queue entry: ${trade.action} ${trade.marketTitle}`);
    return;
  }

  queue.push({
    ...trade,
    queuedAt: new Date().toISOString(),
    status: 'PENDING',  // PENDING → EXECUTING → FILLED / FAILED
  });
  await env.SIGNALS_CACHE.put(AT_KEYS.EXEC_QUEUE, JSON.stringify(queue));
}

export async function updateExecQueueItem(env, tradeId, updates) {
  const queue = await getExecQueue(env);
  const idx = queue.findIndex(t => t.id === tradeId);
  if (idx >= 0) {
    queue[idx] = { ...queue[idx], ...updates };
    await env.SIGNALS_CACHE.put(AT_KEYS.EXEC_QUEUE, JSON.stringify(queue));
    return queue[idx];
  }
  return null;
}

export async function removeFromExecQueue(env, tradeId) {
  const queue = await getExecQueue(env);
  const filtered = queue.filter(t => t.id !== tradeId);
  await env.SIGNALS_CACHE.put(AT_KEYS.EXEC_QUEUE, JSON.stringify(filtered));
}

export async function clearCompletedFromQueue(env) {
  const queue = await getExecQueue(env);
  const active = queue.filter(t => t.status === 'PENDING' || t.status === 'EXECUTING');
  await env.SIGNALS_CACHE.put(AT_KEYS.EXEC_QUEUE, JSON.stringify(active));
}

export async function getTradeHistory(env, limit = 50) {
  if (!env.SIGNALS_CACHE) return [];
  try {
    const history = await env.SIGNALS_CACHE.get(AT_KEYS.HISTORY, { type: 'json' }) || [];
    return history.slice(-limit);
  } catch (e) { return []; }
}

async function addToHistory(env, trade) {
  if (trade.openedAt) trade.entryHourUTC = new Date(trade.openedAt).getUTCHours();
  if (trade.closedAt) trade.exitHourUTC = new Date(trade.closedAt).getUTCHours();
  const history = await getTradeHistory(env, 1000);
  history.push(trade);
  // Keep last 1000 trades
  const trimmed = history.slice(-1000);
  await env.SIGNALS_CACHE.put(AT_KEYS.HISTORY, JSON.stringify(trimmed), {
    expirationTtl: 180 * 24 * 60 * 60  // 6 months
  });
}

// ============================================================
// DAILY STATS
// ============================================================
async function getDailyStats(env) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  try {
    const stats = await env.SIGNALS_CACHE.get(`${AT_KEYS.DAILY_STATS}_${today}`, { type: 'json' });
    return stats || {
      date: today,
      tradesOpened: 0,
      tradesClosed: 0,
      totalSpent: 0,
      totalReturned: 0,
      realizedPnL: 0,
      wins: 0,
      losses: 0,
      explorationTradesOpened: 0,
      skippedReasons: {},
    };
  } catch (e) {
    return { date: today, tradesOpened: 0, tradesClosed: 0, totalSpent: 0, totalReturned: 0, realizedPnL: 0, wins: 0, losses: 0, explorationTradesOpened: 0, skippedReasons: {} };
  }
}

async function saveDailyStats(env, stats) {
  const today = new Date().toISOString().split('T')[0];
  await env.SIGNALS_CACHE.put(`${AT_KEYS.DAILY_STATS}_${today}`, JSON.stringify(stats), {
    expirationTtl: 90 * 24 * 60 * 60  // 90 days
  });
}

// Get P&L aggregated over multiple time periods
// Returns { today, week, month, ninety } each with { pnl, trades, wins, losses }
async function getPnLSummary(env) {
  const now = new Date();
  const periods = {
    today: { pnl: 0, trades: 0, wins: 0, losses: 0, spent: 0, returned: 0 },
    week: { pnl: 0, trades: 0, wins: 0, losses: 0, spent: 0, returned: 0 },
    month: { pnl: 0, trades: 0, wins: 0, losses: 0, spent: 0, returned: 0 },
    ninety: { pnl: 0, trades: 0, wins: 0, losses: 0, spent: 0, returned: 0 },
  };
  
  // Iterate over last 90 days and check for daily stats
  for (let i = 0; i < 90; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().split('T')[0];
    
    try {
      const stats = await env.SIGNALS_CACHE.get(`${AT_KEYS.DAILY_STATS}_${dateKey}`, { type: 'json' });
      if (!stats) continue;
      
      const addTo = (period) => {
        period.pnl += stats.realizedPnL || 0;
        period.trades += (stats.tradesClosed || 0);
        period.wins += (stats.wins || 0);
        period.losses += (stats.losses || 0);
        period.spent += (stats.totalSpent || 0);
        period.returned += (stats.totalReturned || 0);
      };
      
      if (i === 0) addTo(periods.today);
      if (i < 7) addTo(periods.week);
      if (i < 30) addTo(periods.month);
      addTo(periods.ninety);
    } catch (e) { /* skip missing days */ }
  }
  
  // Round values
  for (const p of Object.values(periods)) {
    p.pnl = Math.round(p.pnl * 100) / 100;
    p.spent = Math.round(p.spent * 100) / 100;
    p.returned = Math.round(p.returned * 100) / 100;
    p.winRate = p.trades > 0 ? Math.round((p.wins / p.trades) * 100) : 0;
  }
  
  return periods;
}

// ============================================================
// PERFORMANCE TRACKING (lifetime)
// ============================================================
export async function getBotPerformance(env) {
  if (!env.SIGNALS_CACHE) return null;
  try {
    return await env.SIGNALS_CACHE.get(AT_KEYS.PERFORMANCE, { type: 'json' }) || {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      pending: 0,
      winRate: 0,
      totalPnL: 0,
      bestTrade: null,
      worstTrade: null,
      avgReturn: 0,
      currentStreak: 0,
      longestWinStreak: 0,
      longestLoseStreak: 0,
      byMarketType: {},
      byWalletTier: {},
      bySport: {},
      startedAt: new Date().toISOString(),
    };
  } catch (e) { return null; }
}

// ============================================================
// AGENT SECOND OPINION (advisory — annotates, never gates)
// ============================================================
// When the AI investigator has already priced this market (whale-path
// investigations cover the same alert-tier signals the bot trades), attach
// its independent probability to the position. Advisory only: entries are
// never blocked. The settled counterfactual ledger (agent_gate_stats)
// accumulates how trades the agent liked/disliked actually performed — the
// evidence required before any veto/boost is wired into the entry gates.
async function lookupAgentOpinion(env, marketSlug, directionRaw, entryPrice) {
  if (!env.SIGNALS_CACHE || !marketSlug) return null;
  try {
    const dir = directionRaw || '';
    let inv = await env.SIGNALS_CACHE.get(`investigation:${marketSlug}::${dir}`, { type: 'json' });
    let probForSide = (inv && inv.status === 'done' && typeof inv.agentProb === 'number')
      ? inv.agentProb : null;
    if (probForSide === null && !/^yes$/i.test(dir)) {
      // Sweep investigations always price the "Yes" side; the complement is
      // only safe when our side is literally the binary "No" outcome.
      inv = await env.SIGNALS_CACHE.get(`investigation:${marketSlug}::Yes`, { type: 'json' });
      if (inv && inv.status === 'done' && typeof inv.agentProb === 'number' && /^no$/i.test(dir)) {
        probForSide = 1 - inv.agentProb;
      }
    }
    if (typeof probForSide !== 'number') return null;
    const edgePts = Math.round((probForSide * 100 - entryPrice) * 10) / 10;
    return {
      agentProb: Math.round(probForSide * 1000) / 1000,
      agentEdgePts: edgePts,
      agentConfidence: inv.confidence || null,
      agentOpinion: edgePts >= 5 ? 'agrees' : edgePts <= -5 ? 'disagrees' : 'neutral',
    };
  } catch (e) {
    return null;
  }
}

async function updatePerformance(env, closedTrade) {
  const perf = await getBotPerformance(env) || {};
  
  perf.totalTrades = (perf.totalTrades || 0) + 1;
  const pnl = closedTrade.pnl || 0;
  perf.totalPnL = (perf.totalPnL || 0) + pnl;
  
  // Skip stale/manual $0 closes — don't count them as wins or losses
  const isBreakeven = pnl === 0 && (closedTrade.exitType === 'manual' || closedTrade.exitType === 'stale_timeout' || closedTrade.exitType === 'stale_no_signal' || closedTrade.exitType === 'timeout' || closedTrade.outcome === 'stale' || closedTrade.outcome === 'push');
  
  if (isBreakeven) {
    // Don't count in totalTrades, wins, losses, or streak — it's not a real trade outcome
    perf.totalTrades = (perf.totalTrades || 0); // undo the +1 above
    perf.totalTrades = Math.max(0, perf.totalTrades - 1);
    perf.pushes = (perf.pushes || 0) + 1;
  } else if (pnl > 0) {
    perf.wins = (perf.wins || 0) + 1;
    perf.currentStreak = Math.max(1, (perf.currentStreak || 0) + 1);
    perf.longestWinStreak = Math.max(perf.longestWinStreak || 0, perf.currentStreak);
  } else {
    perf.losses = (perf.losses || 0) + 1;
    perf.currentStreak = Math.min(-1, (perf.currentStreak || 0) - 1);
    perf.longestLoseStreak = Math.max(perf.longestLoseStreak || 0, Math.abs(perf.currentStreak));
  }
  
  perf.winRate = perf.totalTrades > 0 ? Math.round((perf.wins / perf.totalTrades) * 100) : 0;
  perf.avgReturn = perf.totalTrades > 0 ? Math.round((perf.totalPnL / perf.totalTrades) * 100) / 100 : 0;
  
  if (!perf.bestTrade || pnl > (perf.bestTrade.pnl || 0)) {
    perf.bestTrade = { market: closedTrade.marketTitle, pnl, date: closedTrade.closedAt };
  }
  if (!perf.worstTrade || pnl < (perf.worstTrade.pnl || 0)) {
    perf.worstTrade = { market: closedTrade.marketTitle, pnl, date: closedTrade.closedAt };
  }
  
  // Track by category (skip breakeven/stale trades)
  if (!isBreakeven) {
    const mType = closedTrade.marketType || 'unknown';
    if (!perf.byMarketType) perf.byMarketType = {};
    if (!perf.byMarketType[mType]) perf.byMarketType[mType] = { wins: 0, losses: 0, pnl: 0 };
    perf.byMarketType[mType].pnl += pnl;
    pnl > 0 ? perf.byMarketType[mType].wins++ : perf.byMarketType[mType].losses++;

    const tier = closedTrade.walletTier || 'unknown';
    if (!perf.byWalletTier) perf.byWalletTier = {};
    if (!perf.byWalletTier[tier]) perf.byWalletTier[tier] = { wins: 0, losses: 0, pnl: 0 };
    perf.byWalletTier[tier].pnl += pnl;
    pnl > 0 ? perf.byWalletTier[tier].wins++ : perf.byWalletTier[tier].losses++;
  }

  const entryPct = closedTrade.entryPrice ?? 50;
  const oddsRange = entryPct <= 30 ? '20-30%' : entryPct <= 45 ? '30-45%' : entryPct <= 60 ? '45-60%' : entryPct <= 75 ? '60-75%' : '75%+';
  try {
    const oddsPerfRaw = await env.SIGNALS_CACHE.get('autotrader_odds_performance');
    const oddsPerf = oddsPerfRaw ? JSON.parse(oddsPerfRaw) : {};
    if (!oddsPerf[oddsRange]) oddsPerf[oddsRange] = { wins: 0, losses: 0, totalPnl: 0, trades: 0 };
    oddsPerf[oddsRange].trades++;
    if (closedTrade.pnl > 0) oddsPerf[oddsRange].wins++;
    else if (closedTrade.pnl < 0) oddsPerf[oddsRange].losses++;
    oddsPerf[oddsRange].totalPnl = Math.round((oddsPerf[oddsRange].totalPnl + (closedTrade.pnl || 0)) * 100) / 100;
    await env.SIGNALS_CACHE.put('autotrader_odds_performance', JSON.stringify(oddsPerf));
  } catch (e) {}

  // Agent counterfactual ledger: settle how trades the investigator agreed /
  // disagreed with actually performed. This is the evidence base for ever
  // promoting the agent's opinion from advisory into a real entry gate.
  if (closedTrade.agentOpinion && !isBreakeven) {
    try {
      const gsRaw = await env.SIGNALS_CACHE.get('agent_gate_stats');
      const gs = gsRaw ? JSON.parse(gsRaw) : {};
      const bucket = gs[closedTrade.agentOpinion] || { trades: 0, wins: 0, losses: 0, pnl: 0 };
      bucket.trades++;
      if (pnl > 0) bucket.wins++; else bucket.losses++;
      bucket.pnl = Math.round((bucket.pnl + pnl) * 100) / 100;
      gs[closedTrade.agentOpinion] = bucket;
      await env.SIGNALS_CACHE.put('agent_gate_stats', JSON.stringify(gs));
    } catch (e) {}
  }
  
  await env.SIGNALS_CACHE.put(AT_KEYS.PERFORMANCE, JSON.stringify(perf), {
    expirationTtl: 365 * 24 * 60 * 60
  });
}

// ============================================================
// TRADE LOG (detailed decision audit trail)
// ============================================================
async function logDecision(env, decision) {
  try {
    const log = await env.SIGNALS_CACHE.get(AT_KEYS.TRADE_LOG, { type: 'json' }) || [];

    // Deduplicate: don't log identical SKIP entries within the same hour
    if (decision.type === 'SKIP') {
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      const isDuplicate = log.some(entry =>
        entry.type === 'SKIP' &&
        entry.market === decision.market &&
        entry.reason === decision.reason &&
        new Date(entry.timestamp).getTime() > oneHourAgo
      );
      if (isDuplicate) return; // Don't log duplicate skips
    }

    log.push({
      ...decision,
      timestamp: new Date().toISOString(),
    });

    // Keep last 2000 decisions, 30 day TTL
    await env.SIGNALS_CACHE.put(AT_KEYS.TRADE_LOG, JSON.stringify(log.slice(-2000)), {
      expirationTtl: 30 * 24 * 60 * 60
    });
  } catch (e) {}
}

export async function getTradeLog(env, limit = 50) {
  try {
    const log = await env.SIGNALS_CACHE.get(AT_KEYS.TRADE_LOG, { type: 'json' }) || [];
    return log.slice(-limit);
  } catch (e) { return []; }
}

// ============================================================
// POSITION SIZING
// ============================================================
function calculatePositionSize(config, walletWinRate, entryPrice, perf) {
  if (config.sizingMethod === 'fixed') {
    return Math.min(config.fixedSize, config.maxPositionSize);
  }
  
  // Kelly Criterion: f = (bp - q) / b
  // b = net odds received (payout ratio)
  // p = probability of winning (wallet win rate)
  // q = probability of losing (1 - p)
  const p = walletWinRate / 100;
  const q = 1 - p;
  
  // For binary markets: if entry price is 40%, payout is 100/40 = 2.5x
  // Net odds = (payout - 1) = 1.5
  const priceFraction = entryPrice / 100;
  const payout = 1 / priceFraction;  // e.g., 40% entry → 2.5x payout
  const b = payout - 1;              // Net odds
  
  let kellyFraction = (b * p - q) / b;
  
  // Negative Kelly = don't bet (expected to lose)
  if (kellyFraction <= 0) return 0;
  
  // Apply fraction (quarter/half Kelly for safety)
  const fraction = config.kellyFraction || 0.25;
  kellyFraction *= fraction;
  
  // Convert to dollar amount
  let size = Math.round(config.bankroll * kellyFraction);
  
  // Adaptive sizing: scale by bot's own performance if enabled
  if (config.adaptiveSizing && perf && perf.totalTrades >= 20) {
    const botWR = perf.winRate / 100;
    if (botWR > 0.6) {
      size = Math.round(size * 1.2);  // Scale up if bot is hot
    } else if (botWR < 0.4) {
      size = Math.round(size * 0.6);  // Scale down if bot is cold
    }
  }
  
  // Enforce limits
  size = Math.max(config.minPositionSize, size);
  size = Math.min(config.maxPositionSize, size);
  size = Math.min(config.maxKellySize || 200, size);
  
  return size;
}

// ============================================================
// MARKET CATEGORIZATION (for analytics and position scaling)
// ============================================================
function categorizeMarket(marketTitle) {
  if (!marketTitle) return 'other';
  const t = marketTitle.toLowerCase();
  if (/bitcoin|btc|ethereum|eth|solana|sol|crypto|doge/.test(t)) return 'crypto';
  if (/tennis|atp|wta|open:|championships:/.test(t) && !/counter-strike/i.test(t)) return 'tennis';
  if (/counter-strike|csgo|cs2|dota|league of legends|valorant|overwatch/.test(t)) return 'esports';
  if (/will .+ win on \d{4}|will .+ win on \d{4}-\d{2}/.test(t)) return 'sports_binary';
  if (/nba|nfl|nhl|mlb|soccer|football|hockey|basketball|baseball|gold medal|olympic/.test(t)) return 'sports_other';
  if (/trump|biden|election|congress|senate|governor|tax|iran|strike|war|fed |tariff/.test(t)) return 'politics';
  if (/temperature|weather|rain|snow|degrees|celsius|fahrenheit/.test(t)) return 'weather';
  return 'other';
}

function getAutotraderCategory(signal) {
  const title = (signal.marketTitle || signal.title || '').toLowerCase();
  const marketType = (signal.marketType || signal.signalSubType || '').toLowerCase();

  // Weather detection (title + marketType)
  if (marketType === 'weather' || title.includes('temperature') || title.includes('weather') || title.includes('°f') || title.includes('°c') || title.includes('rainfall') || title.includes('snowfall')) {
    return 'weather';
  }

  const mt = marketType;
  if (mt.startsWith('sports-nba') || mt.startsWith('sports-nfl') || mt.startsWith('sports-mlb') || mt.startsWith('sports-nhl') || mt.startsWith('sports-ncaa')) return 'sports_binary';
  if (mt.startsWith('sports-soccer') || mt === 'sports-other') {
    if (title.includes('o/u') || title.includes('both teams') || title.includes('total')) return 'sports_other';
    return 'sports_binary';
  }
  if (mt.startsWith('sports-tennis')) return 'tennis';
  if (mt.startsWith('sports-esports')) return 'esports';
  if (mt === 'crypto') return 'crypto';
  if (mt === 'politics') return 'politics';
  if (title.includes('will') && title.includes('win on')) return 'sports_binary';
  if (title.includes('vs.') || title.includes('vs ')) {
    if (title.includes('o/u') || title.includes('both teams')) return 'sports_other';
    return 'sports_binary';
  }
  return 'other';
}

// ============================================================
// SIGNAL EVALUATION (should we trade this signal?)
// ============================================================
function evaluateSignal(signal, config, dailyStats, openPositions, perf) {
  const reasons = [];

  // ========== GATE 1: Can we trade at all? ==========
  if (!config.enabled) return { shouldTrade: false, reason: 'Bot disabled' };
  if (config.maxDailyTrades > 0 && dailyStats.tradesOpened >= config.maxDailyTrades) {
    return { shouldTrade: false, reason: `Daily trade limit reached (${config.maxDailyTrades})` };
  }
  if (config.maxDailySpend > 0 && dailyStats.totalSpent >= config.maxDailySpend) {
    return { shouldTrade: false, reason: `Daily spend limit reached ($${config.maxDailySpend})` };
  }
  // dailyLossLimit is stored as -150 by the defaults but as a positive
  // magnitude (e.g. 100) by the dashboard's input — normalize to a negative
  // threshold. Comparing raw against a positive limit made 0 <= 100 true and
  // froze all entries.
  if (config.dailyLossLimit) {
    const lossThreshold = -Math.abs(config.dailyLossLimit);
    if ((dailyStats.realizedPnL || 0) <= lossThreshold) {
      return { shouldTrade: false, reason: `Daily loss limit hit ($${dailyStats.realizedPnL} <= $${lossThreshold})` };
    }
  }
  if (config.maxOpenPositions > 0 && openPositions.length >= config.maxOpenPositions) {
    return { shouldTrade: false, reason: `Max open positions reached (${config.maxOpenPositions})` };
  }

  // Portfolio risk check
  const totalAtRisk = openPositions.reduce((sum, p) => sum + p.size, 0);
  const maxRisk = config.bankroll * (config.maxPortfolioRisk / 100);
  if (totalAtRisk >= maxRisk) {
    return { shouldTrade: false, reason: `Portfolio risk limit ($${totalAtRisk} / $${maxRisk})` };
  }

  // ========== GATE 1b: Proven edge ==========
  // Don't trade a signal whose entry band hasn't shown a positive historical
  // edge (win rate - price - spread, >= 5 settled samples). This is the
  // "nothing reaches the bot until it's proven profitable" safety, tied to the
  // same edge profile the Scanner filters on. Disable with requireProvenEdge:false.
  //
  // v21.3.0: exploration floor (see DEFAULT_CONFIG). Full-size entries still
  // require proof; a capped daily quota of half-size entries may pass through
  // unproven / mildly-negative bands so the gate can never deadlock the bot.
  // The quota is only consumed when a trade actually OPENS (processSignals
  // increments explorationTradesOpened), not when a later gate rejects it.
  let isExploration = false;
  if (config.requireProvenEdge !== false && signal.hasPositiveEdge !== true) {
    const en = (signal.historicalEdgeNet === null || signal.historicalEdgeNet === undefined) ? "no history" : `${signal.historicalEdgeNet}pt`;
    const exploreCap = config.edgeExplorationTradesPerDay ?? 5;
    const explored = dailyStats.explorationTradesOpened || 0;
    const hardNegative = config.edgeHardNegativePts ?? -5;
    const edgeNet = (typeof signal.historicalEdgeNet === 'number') ? signal.historicalEdgeNet : null;
    const bandExplorable = edgeNet === null || edgeNet > hardNegative;
    if (!(exploreCap > 0 && bandExplorable && explored < exploreCap)) {
      return { shouldTrade: false, reason: `No proven edge for entry band ${signal.edgeBand || "?"} (${en})` };
    }
    isExploration = true;
    reasons.push(`🧪 Exploration entry ${explored + 1}/${exploreCap}: band ${signal.edgeBand || "?"} (${en})`);
  }

  // ========== GATE 2: Is this a new market? ==========
  // A position without a market slug can never be priced or settled — it
  // just rides to the stale void. Refuse it up front.
  if (!signal.marketSlug) {
    return { shouldTrade: false, reason: 'Signal has no market slug — cannot price or settle' };
  }
  const signalNormTitle = normalizeMarketKey(signal.marketTitle);
  const isDuplicate = openPositions.some(p =>
    p.marketSlug === signal.marketSlug ||
    (signalNormTitle && normalizeMarketKey(p.marketTitle) === signalNormTitle)
  );
  if (isDuplicate) return { shouldTrade: false, reason: 'Already have position in this market' };

  // ========== GATE 3: Is the event still active? ==========
  const slugDateMatch = (signal.marketSlug || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (slugDateMatch) {
    const eventDate = new Date(`${slugDateMatch[1]}-${slugDateMatch[2]}-${slugDateMatch[3]}T23:59:59Z`);
    const hoursUntilDayEnd = (eventDate.getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursUntilDayEnd < -2) {
      return { shouldTrade: false, reason: `Event day passed (${Math.abs(Math.round(hoursUntilDayEnd))}h ago)` };
    }
  } else if (signal.hoursUntilEnd != null && signal.hoursUntilEnd < -2) {
    return { shouldTrade: false, reason: `Event has ended (${Math.abs(Math.round(signal.hoursUntilEnd))}h ago)` };
  }

  // ========== GATE 3b: Is the event too far out? ==========
  // Whale-mirroring is a short-horizon edge and maxHoldHours caps holds at a
  // few days; a market that resolves weeks from now just occupies a position
  // slot until the hold timer voids it. Unknown horizons are allowed through.
  const horizonHours = config.maxEventHorizonHours ?? 168;
  if (horizonHours > 0 && signal.hoursUntilEnd != null && signal.hoursUntilEnd > horizonHours) {
    return { shouldTrade: false, reason: `Event too far out (${Math.round(signal.hoursUntilEnd / 24)}d > ${Math.round(horizonHours / 24)}d horizon)` };
  }

  // ========== GATE 4: Basic signal filters ==========
  if (config.onlyBuySignals && signal.whaleIsSelling) {
    return { shouldTrade: false, reason: 'SELL signal filtered (onlyBuySignals=true)' };
  }

  if (config.blockedCategories?.length > 0) {
    const mCat = categorizeMarket(signal.marketTitle || signal.title || '');
    if (config.blockedCategories.includes(mCat)) {
      return { shouldTrade: false, reason: `Category "${mCat}" is blocked` };
    }
  }

  let subType = signal.signalSubType || 'moneyline';
  const MONEYLINE_ALIASES = ['will-win', 'will_win', 'winner', 'match-winner', 'to-win'];
  if (MONEYLINE_ALIASES.includes(subType)) subType = 'moneyline';
  if (!config.allowedMarketTypes.includes(subType) && !config.allowedMarketTypes.includes('all')) {
    return { shouldTrade: false, reason: `Market type '${subType}' not allowed` };
  }

  // ========== GATE 5: WHO is betting? (The core edge) ==========
  let isHighConviction = false;
  let tier = 'UNKNOWN';
  let walletInfo = {};

  if (signal.hasWinningWallet) {
    walletInfo = signal.winningWalletInfo || {};

    if ((walletInfo.winRate || 0) < config.minWalletWinRate) {
      return { shouldTrade: false, reason: `Wallet WR too low (${walletInfo.winRate}% < ${config.minWalletWinRate}%)` };
    }
    if ((walletInfo.totalBets || 0) < config.minWalletBets) {
      return { shouldTrade: false, reason: `Wallet history too short (${walletInfo.totalBets} < ${config.minWalletBets} bets)` };
    }

    tier = walletInfo.tier || 'UNKNOWN';
    if (tier === 'WINNER') tier = 'INSIDER';
    if (!config.walletTiers.includes(tier)) {
      return { shouldTrade: false, reason: `Wallet tier ${tier} not in allowed list` };
    }

    reasons.push(`✅ Winning wallet: ${walletInfo.winRate}% WR (${walletInfo.record || ''}) [${tier}]`);
  } else {
    const hcBypass = config.allowHighConvictionBypass &&
      (signal.score || 0) >= (config.highConvictionMinScore || 80) &&
      (signal.largestBet || 0) >= (config.highConvictionMinBet || 50000) &&
      (signal.uniqueWallets || 0) >= (config.highConvictionMinWallets || 3);

    if (!hcBypass) {
      return { shouldTrade: false, reason: 'No winning wallet on signal' };
    }

    isHighConviction = true;
    tier = 'HIGH_CONVICTION';
    walletInfo = { winRate: 0, totalBets: 0, tier: 'HIGH_CONVICTION' };
    reasons.push(`🐋 HC: score=${signal.score}, bet=$${Math.round((signal.largestBet || 0) / 1000)}K, wallets=${signal.uniqueWallets}`);
  }

  // ========== GATE 6: Price in range? ==========
  const entryPrice = signal.displayPrice || 50;
  const effectivePrice = signal.direction === 'NO' ? (100 - entryPrice) : entryPrice;

  const oddsCategory = getAutotraderCategory(signal);
  let categoryMaxOdds = config.maxOdds;
  let categoryMinOdds = config.minOdds;
  if (oddsCategory === 'sports_binary') {
    categoryMaxOdds = config.sportsMaxOdds ?? 60;
    categoryMinOdds = config.sportsMinOdds ?? 20;
  } else if (oddsCategory === 'sports_other') {
    categoryMaxOdds = config.derivativeMaxOdds ?? 60;
    categoryMinOdds = config.derivativeMinOdds ?? 20;
  }

  if (effectivePrice < categoryMinOdds) {
    return { shouldTrade: false, reason: `Entry price too low for ${oddsCategory} (${effectivePrice}% < ${categoryMinOdds}%)` };
  }
  if (effectivePrice > categoryMaxOdds) {
    return { shouldTrade: false, reason: `Entry price too high for ${oddsCategory} (${effectivePrice}% > ${categoryMaxOdds}%)` };
  }

  if (isHighConviction && effectivePrice > (config.highConvictionMaxOdds ?? 60)) {
    return { shouldTrade: false, reason: `High conviction odds too high (${effectivePrice}% > ${config.highConvictionMaxOdds ?? 60}% cap)` };
  }

  const whaleEntryPrice = signal.avgEntryPrice ?? signal.entryPrice ?? signal.priceAtSignal;
  if (whaleEntryPrice && entryPrice) {
    const pctSlippage = ((entryPrice - whaleEntryPrice) / whaleEntryPrice) * 100;
    if (pctSlippage > (config.maxEntrySlippage ?? 15)) {
      return { shouldTrade: false, reason: `Slippage too high: +${pctSlippage.toFixed(1)}% from whale entry` };
    }
    const absCentsSlippage = Math.abs(entryPrice - whaleEntryPrice) * 100;
    if (absCentsSlippage > (config.maxEntryCentsSlippage ?? 5)) {
      return { shouldTrade: false, reason: `Abs slippage too high: ${absCentsSlippage.toFixed(0)}¢ from whale entry` };
    }
  }

  // ========== SIZING ==========
  let positionSize = config.fixedSize || 5;

  const category = signal.marketType || '';
  if (category === 'crypto' && config.cryptoBetSize > 0) positionSize = config.cryptoBetSize;
  else if (category === 'weather' && config.weatherBetSize > 0) positionSize = config.weatherBetSize;
  else if (category.startsWith('sports') && config.sportsBetSize > 0) positionSize = config.sportsBetSize;
  else if (category === 'politics' && config.politicsBetSize > 0) positionSize = config.politicsBetSize;

  if (isHighConviction) {
    const hcMultiplier = config.highConvictionSizeMultiplier ?? 0.5;
    positionSize = Math.max(config.minPositionSize, Math.round(positionSize * hcMultiplier));
    reasons.push(`HC size: $${positionSize}`);
  }

  if (isExploration) {
    const exMultiplier = config.edgeExplorationSizeMultiplier ?? 0.5;
    positionSize = Math.max(config.minPositionSize, Math.round(positionSize * exMultiplier));
    reasons.push(`Exploration size: $${positionSize}`);
  }

  positionSize = Math.min(positionSize, config.maxPositionSize || 30);

  if (positionSize < (config.minPositionSize || 2)) {
    return { shouldTrade: false, reason: `Position size too small ($${positionSize} < $${config.minPositionSize})` };
  }
  if (config.maxDailySpend > 0 && dailyStats.totalSpent + positionSize > config.maxDailySpend) {
    return { shouldTrade: false, reason: `Would exceed daily spend limit ($${dailyStats.totalSpent} + $${positionSize} > $${config.maxDailySpend})` };
  }

  // ========== ALL CHECKS PASSED ==========
  return {
    shouldTrade: true,
    positionSize,
    entryPrice: Math.round(effectivePrice * 100) / 100,
    walletTier: tier,
    walletWinRate: walletInfo.winRate,
    walletBets: walletInfo.totalBets,
    whaleAction: signal.whaleAction || 'BUY',
    isHighConviction,
    isExploration,
    reasons,
    aiConfidence: null,
    aiComponents: null,
    strongCombo: null,
  };
}

// ============================================================
// CHECK EXIT CONDITIONS for open positions
// ============================================================
function shouldExitPosition(position, currentPrice, config, signal, hasLivePrice = true) {
  const entryPrice = position.entryPrice;
  const priceDelta = currentPrice - entryPrice;
  const pctChange = (priceDelta / entryPrice) * 100;

  // Update peak gain tracking
  if (pctChange > (position.peakPctGain || 0)) {
    position.peakPctGain = pctChange;
  }

  // === TRAILING STOP LOSS ===
  const isSportsPosition = (position.marketCategory || '').includes('sports');
  const trailingActivation = isSportsPosition
    ? (config.sportsTrailingActivation ?? 15)
    : (config.trailingStopActivation ?? 30);
  const baseTrailingPercent = isSportsPosition
    ? (config.sportsTrailingPercent ?? 10)
    : (config.trailingStopPercent ?? 20);
  const holdMinutes = (Date.now() - new Date(position.openedAt).getTime()) / (1000 * 60);
  let effectiveTrailingPercent = baseTrailingPercent;
  if (holdMinutes > 240) effectiveTrailingPercent = Math.min(baseTrailingPercent, 5);
  else if (holdMinutes > 120) effectiveTrailingPercent = Math.min(baseTrailingPercent, 10);
  else if (holdMinutes > 60) effectiveTrailingPercent = Math.min(baseTrailingPercent, 15);

  if (position.peakPctGain >= trailingActivation) {
    position.trailingStopActive = true;
    const trailingStopLevel = position.peakPctGain - effectiveTrailingPercent;
    position.trailingStopLevel = trailingStopLevel;

    if (pctChange <= trailingStopLevel) {
      return {
        shouldExit: true,
        reason: `Trailing stop hit (peak +${position.peakPctGain.toFixed(1)}%, dropped to +${pctChange.toFixed(1)}%, stop was +${trailingStopLevel.toFixed(1)}%)`,
        exitType: 'trailing_stop'
      };
    }
  }

  // === FLAT STOP LOSS (only if trailing stop not yet active) ===
  if (!position.trailingStopActive && config.stopLossPercent && pctChange <= -config.stopLossPercent) {
    return { shouldExit: true, reason: `Stop loss hit (${pctChange.toFixed(1)}% drop)`, exitType: 'stop_loss' };
  }

  // === TAKE PROFIT ===
  if (config.takeProfitPercent && pctChange >= config.takeProfitPercent) {
    return { shouldExit: true, reason: `Take profit hit (+${pctChange.toFixed(1)}%)`, exitType: 'take_profit' };
  }

  // === MAX HOLD TIME ===
  // Only close on timeout when we have a real price to close AT. With a
  // stale price this just re-books the entry price as a fake $0 outcome —
  // the stale-void path (with its resolution grace period) owns that case.
  const holdHours = (Date.now() - new Date(position.openedAt).getTime()) / (1000 * 60 * 60);
  if (hasLivePrice && config.maxHoldHours && holdHours > config.maxHoldHours) {
    return { shouldExit: true, reason: `Max hold time exceeded (${Math.round(holdHours)}h > ${config.maxHoldHours}h)`, exitType: 'timeout' };
  }

  // === EXIT BEFORE EVENT ===
  if (config.exitBeforeEventHours && position.hoursUntilEvent !== null) {
    const currentHoursUntil = position.hoursUntilEvent - holdHours;
    if (currentHoursUntil <= config.exitBeforeEventHours && currentHoursUntil > 0) {
      return { shouldExit: true, reason: `Event starting soon (~${currentHoursUntil.toFixed(1)}h)`, exitType: 'pre_event' };
    }
  }

  // === MIRROR EXIT ===
  // The whale we copied has sold. The edge that justified the position is gone,
  // so follow them out regardless of current P&L.
  if (config.mirrorExits && signal?.whaleIsSelling) {
    return { shouldExit: true, reason: 'Whale exited — mirroring their sell', exitType: 'mirror_exit' };
  }

  return { shouldExit: false };
}

// ============================================================
// MAIN ENGINE: Process signals and make trade decisions
// Called by cron or manually
// ============================================================
export async function processSignals(env, signals) {
  const config = await getAutotraderConfig(env);

  // One-time live config migration — tighten settings for live trading
  if (!config._liveV2Tuned) {
    config.fixedSize = 25;
    config.sportsPositionScale = 0.25;
    config.minWalletWinRate = 65;
    config.walletTiers = ['INSIDER', 'STRONG'];
    config.maxOdds = 80;  // Don't buy above 80% (terrible risk/reward like Atletico at 90%)
    config._liveV2Tuned = true;
    await env.SIGNALS_CACHE.put(AT_KEYS.CONFIG, JSON.stringify(config), {
      expirationTtl: 365 * 24 * 60 * 60
    });
  }

  // v3 profitability overhaul + AI learning integration
  if (!config._v3ProfitOverhaul) {
    config.sportsMaxOdds = 48;
    config.sportsMinOdds = 20;
    config.derivativeMaxOdds = 55;
    config.derivativeMinOdds = 25;
    config.minExpectedValue = 0.10;
    config.maxEntryCentsSlippage = 5;
    config.sportsTrailingActivation = 15;
    config.sportsTrailingPercent = 10;
    config.maxOdds = 55;
    config.maxDailyTrades = 6;
    config.minWalletWinRate = 68;
    config.minWalletBets = 8;
    config.useLearningData = true;
    config.minLearningConfidence = 35;
    config.learningBoostThreshold = 65;
    config.learningBoostMultiplier = 1.25;
    config.learningPenaltyThreshold = 40;
    config.learningPenaltyMultiplier = 0.6;
    config.minFactorWinRate = 40;
    config.useFactorCombos = true;
    config.weatherBetSize = 25;
    if (!config.allowHighConvictionBypass) config.allowHighConvictionBypass = true;
    if (config.highConvictionMinScore === undefined) config.highConvictionMinScore = 80;
    if (config.highConvictionMinBet === undefined) config.highConvictionMinBet = 50000;
    if (config.highConvictionMinWallets === undefined) config.highConvictionMinWallets = 3;
    if (config.highConvictionMaxOdds === undefined) config.highConvictionMaxOdds = 48;
    if (config.highConvictionSizeMultiplier === undefined) config.highConvictionSizeMultiplier = 0.5;
    if (!config.weatherBetSize) config.weatherBetSize = 25;
    config._v3ProfitOverhaul = true;
    await env.SIGNALS_CACHE.put(AT_KEYS.CONFIG, JSON.stringify(config), {
      expirationTtl: 365 * 24 * 60 * 60
    });
    console.log('[MIGRATION] v3 profitability overhaul + AI learning config applied');
  }

  if (!config.enabled) {
    return { status: 'disabled', message: 'Autotrader is disabled' };
  }
  
  const dailyStats = await getDailyStats(env);
  const openPositions = await getOpenPositions(env);
  const perf = await getBotPerformance(env);

  const lastEntryTime = await env.SIGNALS_CACHE.get('autotrader_last_entry_time');
  const timeSinceLastEntry = lastEntryTime ? (Date.now() - parseInt(lastEntryTime, 10)) / 1000 : Infinity;
  const entryCooldownSeconds = config.entryCooldownSeconds ?? 120;
  
  const results = {
    evaluated: 0,
    tradesOpened: 0,
    tradesPaperTraded: 0,
    tradesQueued: 0,
    skipped: 0,
    skipReasons: {},
    exitChecks: 0,
    positionsExited: 0,
    errors: [],
  };
  const skippedMarketsThisCycle = new Set();

  // Cross-cycle skip-log dedupe. A persistent signal re-evaluates every
  // cycle and used to re-log the same skip for hours ("No proven edge" on
  // the same match 20+ times a day), burying the trade log. Only log a
  // market's skip when its reason CHANGES or 6h have passed; skipReasons
  // counters still count every occurrence.
  let skipLogMemory = {};
  try {
    skipLogMemory = await env.SIGNALS_CACHE.get(AT_KEYS.SKIP_LOG_MEMORY, { type: 'json' }) || {};
  } catch (e) {}
  const skipLogNow = Date.now();
  for (const key of Object.keys(skipLogMemory)) {
    if (skipLogNow - (skipLogMemory[key].ts || 0) > 24 * 60 * 60 * 1000) delete skipLogMemory[key];
  }
  const shouldLogSkip = (skipKey, reason) => {
    const prev = skipLogMemory[skipKey];
    if (prev && prev.reason === reason && skipLogNow - prev.ts < 6 * 60 * 60 * 1000) return false;
    skipLogMemory[skipKey] = { reason, ts: skipLogNow };
    return true;
  };

  // Clean up stale queue entries (stuck PENDING for >10 min)
  const execQueueForCleanup = await getExecQueue(env);
  const now = Date.now();
  const staleThreshold = 10 * 60 * 1000; // 10 minutes
  const freshQueue = execQueueForCleanup.filter(q => {
    if (q.status !== 'PENDING') return true;
    if (!q.queuedAt) return true; // keep if no timestamp
    const queuedTime = new Date(q.queuedAt).getTime();
    return (now - queuedTime) < staleThreshold;
  });
  if (freshQueue.length !== execQueueForCleanup.length) {
    await env.SIGNALS_CACHE.put(AT_KEYS.EXEC_QUEUE, JSON.stringify(freshQueue));
  }

  // --- STEP 1: Fetch live prices for all open positions from Polymarket ---
  const livePriceMap = await fetchLivePrices(env, openPositions);

  // Which positions' whales have already sold (mirror-exit signal).
  const whaleExitedSlugs = config.mirrorExits !== false
    ? await detectWhaleExits(env, openPositions)
    : new Set();

  // --- STEP 2: Check exit conditions on open positions ---
  // Clean up stale pendingExit flags — but only if pending for > 30 minutes with no queue entry
  // This prevents clearing pendingExit immediately after executor fills a sell
  const currentExecQueue = await getExecQueue(env);
  for (const position of openPositions) {
    if (position.pendingExit) {
      const hasPendingSell = currentExecQueue.some(q =>
        (q.status === 'PENDING' || q.status === 'EXECUTING') &&
        q.action === 'SELL' &&
        (q.positionId === position.id || q.tokenId === position.tokenId)
      );
      if (!hasPendingSell) {
        const pendingSince = position.pendingExitSince || position.openedAt;
        const pendingMinutes = (Date.now() - new Date(pendingSince).getTime()) / (1000 * 60);
        if (pendingMinutes > 30) {
          position.pendingExit = false;
          console.log(`Cleared stale pendingExit for ${position.marketTitle} (pending ${Math.round(pendingMinutes)}min)`);
        }
      }
    }
  }
  for (const position of openPositions) {
    results.exitChecks++;
    
    // Priority: 1) Live CLOB price, 2) Signal scan price, 3) Entry price (stale)
    let currentSignal = signals.find(s => s.marketSlug === position.marketSlug);
    // Flag whale-exit so shouldExitPosition can mirror it, even when there's no
    // fresh signal for this market this scan.
    if (whaleExitedSlugs.has(position.marketSlug)) {
      currentSignal = { ...(currentSignal || {}), whaleIsSelling: true };
    }
    const liveData = livePriceMap.get(position.marketSlug);
    
    let currentPrice;
    let priceSource;
    
    if (liveData) {
      // We have a real price from Polymarket CLOB or Gamma.
      // liveData.price is the YES-outcome price; convert to the side we hold.
      currentPrice = priceForPosition(liveData, position);
      priceSource = liveData.source;
    } else if (currentSignal?.displayPrice) {
      currentPrice = currentSignal.displayPrice;
      priceSource = 'signal_scan';
    } else {
      currentPrice = position.entryPrice;
      priceSource = 'stale';
    }
    
    const hasLivePrice = priceSource !== 'stale';
    const holdHours = (Date.now() - new Date(position.openedAt).getTime()) / (1000 * 60 * 60);

    // Warn about suspicious prices (low liquidity markets returning extreme values)
    if (hasLivePrice && !liveData?.closed && (currentPrice <= 5 || currentPrice >= 95)) {
      const isSports = (position.marketSlug || '').match(/\d{4}-\d{2}-\d{2}/);
      if (!isSports) {
        console.log(`⚠️ Suspicious price for ${position.marketTitle}: ${currentPrice}% from ${priceSource} (not Gamma-closed). Ignoring for resolution check.`);
      }
    }

    // --- PENDING EXIT CHECK (must be FIRST) ---
    if (position.pendingExit) {
      const pendingSince = position.pendingExitSince || position.openedAt;
      const pendingHours = (Date.now() - new Date(pendingSince).getTime()) / (1000 * 60 * 60);
      if (pendingHours < 2) {
        continue; // Skip ALL exit checks — let executor handle it
      }
      // Pending for >2 hours — executor probably failed, allow cron to close
    }

    // RESOLVED MARKET CHECK: If Gamma says market is closed, force exit with real price
    if (liveData?.closed) {
      const pnl = calculatePnL(position, currentPrice);
      
      const closedTrade = {
        ...position,
        marketCategory: position.marketCategory || categorizeMarket(position.marketTitle || ''),
        closedAt: new Date().toISOString(),
        exitPrice: currentPrice,
        exitType: 'market_resolved',
        exitReason: `Market resolved (${priceSource}). Final price: ${currentPrice}%`,
        pnl: pnl.amount,
        pnlPercent: pnl.percent,
        outcome: pnl.amount > 0 ? 'win' : pnl.amount < 0 ? 'loss' : 'push',
      };
      
      await addToHistory(env, closedTrade);
      await updatePerformance(env, closedTrade);
      
      dailyStats.tradesClosed++;
      dailyStats.realizedPnL += pnl.amount;
      dailyStats.totalReturned += position.size + pnl.amount;
      pnl.amount > 0 ? dailyStats.wins++ : pnl.amount < 0 ? dailyStats.losses++ : null;
      
      results.positionsExited++;
      
      await logDecision(env, {
        type: 'EXIT',
        market: position.marketTitle,
        reason: closedTrade.exitReason,
        exitType: 'market_resolved',
        pnl: pnl.amount,
        paperTrade: config.paperTradeMode,
      });
      continue;
    }

    // Check if market has resolved (price is at 0-2% or 98-100%)
    // For non-sports markets, CLOB midpoints can be misleading (thin order books)
    const isSportsEvent = (position.marketSlug || '').match(/\d{4}-\d{2}-\d{2}/) ||
                          (position.marketCategory || '').startsWith('sports');
    const isTrustedResolvedPrice = liveData?.closed || isSportsEvent || priceSource === 'gamma_resolved';

    if ((currentPrice <= 2 || currentPrice >= 98) && isTrustedResolvedPrice) {
      // currentPrice is already direction-adjusted: >= 98 means OUR side won
      const isWin = currentPrice >= 98;
      const settlementPrice = isWin ? 100 : 0;
      const pnlPercent = ((settlementPrice - position.entryPrice) / position.entryPrice) * 100;
      const pnlDollar = Math.round((pnlPercent / 100) * position.size * 100) / 100;

      const closedTrade = {
        ...position,
        marketCategory: position.marketCategory || categorizeMarket(position.marketTitle || ''),
        closedAt: new Date().toISOString(),
        exitPrice: settlementPrice,
        exitType: 'market_resolved',
        exitReason: `Market resolved: ${isWin ? 'WIN' : 'LOSS'} (price: ${currentPrice}%)`,
        pnl: pnlDollar,
        pnlPercent: Math.round(pnlPercent * 100) / 100,
        outcome: isWin ? 'win' : 'loss',
      };
      await addToHistory(env, closedTrade);
      await updatePerformance(env, closedTrade);
      dailyStats.tradesClosed = (dailyStats.tradesClosed || 0) + 1;
      dailyStats.realizedPnL = (dailyStats.realizedPnL || 0) + pnlDollar;
      dailyStats.totalReturned = (dailyStats.totalReturned || 0) + position.size + pnlDollar;
      pnlDollar > 0 ? dailyStats.wins++ : dailyStats.losses++;
      results.positionsExited = (results.positionsExited || 0) + 1;
      await logDecision(env, {
        type: 'EXIT',
        market: position.marketTitle,
        reason: closedTrade.exitReason,
        exitType: 'market_resolved',
        pnl: pnlDollar,
        paperTrade: config.paperTradeMode,
      });
      console.log(`Market resolved: ${position.marketTitle} | Dir: ${position.direction} | Our price: ${currentPrice}% | ${isWin ? 'WIN' : 'LOSS'} | P&L: $${pnlDollar}`);
      continue;
    }
    
    // STALE FALLBACK: No price from ANY source after max hold time + grace.
    // The grace period exists because entries often happen ~24h before a game:
    // the hold timer expires mid-game, before Gamma marks the market closed.
    // Waiting a bit longer lets the fresh-Gamma settlement path record the
    // real outcome instead of voiding the trade at its entry price.
    const staleGraceHours = config.staleVoidGraceHours ?? 48;
    if (!hasLivePrice && config.maxHoldHours && holdHours > config.maxHoldHours + staleGraceHours) {
      const closedTrade = {
        ...position,
        marketCategory: position.marketCategory || categorizeMarket(position.marketTitle || ''),
        closedAt: new Date().toISOString(),
        exitPrice: position.entryPrice,
        exitType: 'stale_timeout',
        exitReason: `No price data from any source for ${Math.round(holdHours)}h — force closed`,
        pnl: 0,
        pnlPercent: 0,
        outcome: 'stale',
      };
      
      await addToHistory(env, closedTrade);
      await updatePerformance(env, closedTrade);
      
      dailyStats.tradesClosed++;
      dailyStats.totalReturned += position.size;
      
      results.positionsExited++;
      
      await logDecision(env, {
        type: 'EXIT',
        market: position.marketTitle,
        reason: closedTrade.exitReason,
        exitType: 'stale_timeout',
        pnl: 0,
        paperTrade: config.paperTradeMode,
      });
      continue;
    }
    
    // Track peak gain for trailing protection on deferred take profits
    const currentPctChange = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    if (!position.peakPctGain || currentPctChange > position.peakPctGain) {
      position.peakPctGain = currentPctChange;
    }
    
    // Normal exit check (with real live price)
    const exitCheck = shouldExitPosition(position, currentPrice, config, currentSignal, hasLivePrice);
    
    // Log deferred take profit (whale still holding)
    if (!exitCheck.shouldExit && config.takeProfitPercent && hasLivePrice) {
      const posPctChange = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      if (posPctChange >= config.takeProfitPercent) {
        await logDecision(env, {
          type: 'HOLD',
          market: position.marketTitle,
          reason: `TP deferred — whale still holding (+${posPctChange.toFixed(1)}%, peak +${(position.peakPctGain || posPctChange).toFixed(1)}%)`,
          pnl: null,
          paperTrade: config.paperTradeMode,
        });
      }
    }
    
    if (exitCheck.shouldExit) {
      // Skip if already queued for exit (waiting for executor)
      if (position.pendingExit) continue;
      
      // LIVE MODE: Queue exit for executor (don't close until executor confirms)
      if (!config.paperTradeMode && position.onChainOrderId && position.onChainOrderId !== 'unknown' && !position.paperTrade) {
        // Check if exit is already queued
        const execQueueExit = await getExecQueue(env);
        const alreadyQueuedExit = execQueueExit.some(q =>
          q.status === 'PENDING' &&
          q.tokenId === position.tokenId &&
          q.action === 'SELL'
        );
        if (alreadyQueuedExit) continue;
        
        await addToExecQueue(env, {
          id: `exit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          action: 'SELL',
          marketSlug: position.marketSlug,
          marketTitle: position.marketTitle,
          conditionId: position.conditionId || null,
          tokenId: position.tokenId || null,
          negRisk: position.negRisk || false,
          tickSize: position.tickSize || '0.01',
          exitPrice: currentPrice / 100,
          entryPrice: position.entryPrice / 100,  // Convert from percentage to decimal for executor
          stopLossPercent: config.stopLossPercent ?? 40,
          size: position.size,
          exitType: exitCheck.exitType,
          exitReason: exitCheck.reason,
          originalTradeId: position.tradeId || null,
          positionId: position.id,
          shares: position.shares,
        });
        position.pendingExit = true;
        position.pendingExitSince = new Date().toISOString();
        continue; // Wait for executor to confirm before closing
      }

      // PAPER MODE or position not on-chain: close immediately
      const pnl = calculatePnL(position, currentPrice);
      
      const closedTrade = {
        ...position,
        marketCategory: position.marketCategory || categorizeMarket(position.marketTitle || ''),
        closedAt: new Date().toISOString(),
        exitPrice: currentPrice,
        exitType: exitCheck.exitType,
        exitReason: exitCheck.reason,
        pnl: pnl.amount,
        pnlPercent: pnl.percent,
        outcome: pnl.amount > 0 ? 'win' : pnl.amount < 0 ? 'loss' : 'push',
      };
      
      await addToHistory(env, closedTrade);
      await updatePerformance(env, closedTrade);
      
      // Update daily stats
      dailyStats.tradesClosed++;
      dailyStats.realizedPnL += pnl.amount;
      dailyStats.totalReturned += position.size + pnl.amount;
      pnl.amount > 0 ? dailyStats.wins++ : pnl.amount < 0 ? dailyStats.losses++ : null;
      
      results.positionsExited++;
      
      await logDecision(env, {
        type: 'EXIT',
        market: position.marketTitle,
        ...exitCheck,
        pnl: pnl.amount,
        paperTrade: config.paperTradeMode,
      });
    }
  }
  
  // Remove exited positions from open list (keep pendingExit positions until executor confirms)
  const stillOpen = openPositions.filter(p => {
    if (p.pendingExit) return true; // Keep — waiting for executor to confirm
    const currentSignal = signals.find(s => s.marketSlug === p.marketSlug);
    const liveData = livePriceMap.get(p.marketSlug);
    const holdHours = (Date.now() - new Date(p.openedAt).getTime()) / (1000 * 60 * 60);
    
    let currentPrice;
    let hasLivePrice = true;
    
    if (liveData) {
      currentPrice = priceForPosition(liveData, p);
      if (liveData.closed) return false; // Resolved market — already exited above
    } else if (currentSignal?.displayPrice) {
      currentPrice = currentSignal.displayPrice;
    } else {
      currentPrice = p.entryPrice;
      hasLivePrice = false;
    }
    
    // Stale fallback — must mirror the stale-void condition above (incl. grace)
    if (!hasLivePrice && config.maxHoldHours && holdHours > config.maxHoldHours + (config.staleVoidGraceHours ?? 48)) return false;
    
    return !shouldExitPosition(p, currentPrice, config, currentSignal, hasLivePrice).shouldExit;
  });

  // Save updated positions (peak gain tracking updates)
  await savePositions(env, stillOpen);

  // --- STEP 2: Evaluate new signals for entry ---
  const marketsTraded = new Set(stillOpen.map(p => p.marketSlug));
  const marketTitlesTraded = new Set(stillOpen.map(p => normalizeMarketKey(p.marketTitle)));
  const teamsEnteredThisCycle = new Set();
  
  // Also load cross-cycle recent markets
  const recentMarkets = await getRecentMarkets(env);
  for (const key of Object.keys(recentMarkets)) {
    if (key.startsWith('title_')) continue;
    marketsTraded.add(key);
    if (recentMarkets[key].normalizedTitle) {
      marketTitlesTraded.add(recentMarkets[key].normalizedTitle);
    }
  }
  
  for (const signal of signals) {
    results.evaluated++;
    
    // Skip if we already opened a position in this market this cycle or recently
    const normTitle = normalizeMarketKey(signal.marketTitle);
    if (marketsTraded.has(signal.marketSlug) || (normTitle && marketTitlesTraded.has(normTitle))) {
      results.skipped++;
      results.skipReasons['Duplicate market (already traded)'] = 
        (results.skipReasons['Duplicate market (already traded)'] || 0) + 1;
      continue;
    }

    // Blocked categories check — run BEFORE evaluation/queuing so politics etc. never get queued
    const signalCategory = getAutotraderCategory(signal);
    if (config.blockedCategories && config.blockedCategories.length > 0 && config.blockedCategories.includes(signalCategory)) {
      results.skipped++;
      results.skipReasons[`Category "${signalCategory}" is blocked`] = (results.skipReasons[`Category "${signalCategory}" is blocked`] || 0) + 1;
      const skipKey = signal.marketSlug || signal.marketTitle || signal.title;
      if ((!config.deduplicateSkipLogs || !skippedMarketsThisCycle.has(skipKey)) && shouldLogSkip(skipKey, `Category "${signalCategory}" is blocked`)) {
        skippedMarketsThisCycle.add(skipKey);
        await logDecision(env, {
          type: 'SKIP',
          market: signal.marketTitle || signal.title,
          reason: `Category "${signalCategory}" is blocked`,
          marketCategory: signalCategory,
        });
      }
      continue;
    }
    
    const evaluation = evaluateSignal(signal, config, dailyStats, stillOpen, perf);
    
    if (!evaluation.shouldTrade) {
      results.skipped++;
      const reason = evaluation.reason || 'unknown';
      results.skipReasons[reason] = (results.skipReasons[reason] || 0) + 1;
      
      // Log skips for learning (dedupe: only first SKIP per market per cycle)
      const skipKey = signal.marketSlug || signal.marketTitle || signal.title;
      if (signal.hasWinningWallet && (!config.deduplicateSkipLogs || !skippedMarketsThisCycle.has(skipKey)) && shouldLogSkip(skipKey, evaluation.reason)) {
        skippedMarketsThisCycle.add(skipKey);
        await logDecision(env, {
          type: 'SKIP',
          market: signal.marketTitle || signal.title,
          reason: evaluation.reason,
          walletTier: evaluation.walletTier || signal.winningWalletInfo?.tier,
          aiScore: signal.aiScore,
          marketCategory: categorizeMarket(signal.marketTitle || signal.title || ''),
        });
      }
      continue;
    }

    // --- MARKET SANITY CHECK (one Gamma lookup per accepted entry) ---
    // Two protections:
    // 1. Refuse markets that are already closed/resolved. Whale signals
    //    linger in the scanner after a market resolves; entering one "buys"
    //    at the signal's stale price and instantly settles at 0/100 — a
    //    phantom outcome that never existed on the exchange.
    // 2. Signals with no event time slip past Gate 3b (null passes through),
    //    so long-dated markets cycle forever: enter → maxHold timeout →
    //    re-enter. Apply the horizon gate using Gamma's endDate.
    const entryHorizonHours = config.maxEventHorizonHours ?? 168;
    try {
      const tk = await lookupMarketTokens(signal.marketSlug);
      let skipReason = null;
      if (tk?.closed) {
        skipReason = 'Market already closed/resolved on Gamma';
      } else if (entryHorizonHours > 0 && signal.hoursUntilEnd == null) {
        const endMs = tk?.endDate ? new Date(tk.endDate).getTime() : NaN;
        if (!isNaN(endMs)) {
          const hrsUntilEnd = (endMs - Date.now()) / (1000 * 60 * 60);
          if (hrsUntilEnd > entryHorizonHours) {
            skipReason = `Event too far out (${Math.round(hrsUntilEnd / 24)}d > ${Math.round(entryHorizonHours / 24)}d horizon)`;
          }
        }
      }
      if (skipReason) {
        results.skipped++;
        results.skipReasons[skipReason] = (results.skipReasons[skipReason] || 0) + 1;
        const skipKey = signal.marketSlug || signal.marketTitle || signal.title;
        if ((!config.deduplicateSkipLogs || !skippedMarketsThisCycle.has(skipKey)) && shouldLogSkip(skipKey, skipReason)) {
          skippedMarketsThisCycle.add(skipKey);
          await logDecision(env, {
            type: 'SKIP',
            market: signal.marketTitle || signal.title,
            reason: skipReason,
            marketCategory: categorizeMarket(signal.marketTitle || signal.title || ''),
          });
        }
        continue;
      }
    } catch (e) {
      // Gamma unreachable — don't block the entry on a lookup failure
    }

    // --- AI LEARNING INTEGRATION ---
    // Use learning.js factor/pattern/combo data to validate edge before entering
    if (config.useLearningData !== false) {
      try {
        // 1. Get AI confidence score from the learning system
        const signalFactors = signal.scoreBreakdown?.map(f => f.factor || f.name) || [];
        const learningConfidence = await calculateConfidence(env, signalFactors, signal);

        if (learningConfidence && learningConfidence.confidence > 0) {
          const minConfidence = config.minLearningConfidence ?? 35;
          let aiConfidence = learningConfidence.confidence;

          // Boost confidence floor for historically strong categories
          const strongCategories = ['crypto', 'weather'];
          if (strongCategories.includes(signal.marketType)) {
            // Crypto: 90% paper WR, Weather: 100% paper WR — lower the confidence gate
            aiConfidence = Math.max(aiConfidence, 50); // Floor at 50% for these categories
          }

          // Block very low confidence signals
          if (aiConfidence < minConfidence) {
            results.skipped++;
            const reason = `AI confidence too low: ${learningConfidence.confidence}% (min ${minConfidence}%, ${learningConfidence.components.map(c => `${c.source}:${c.confidence}%`).join(', ')})`;
            results.skipReasons[reason] = (results.skipReasons[reason] || 0) + 1;
            await logDecision(env, {
              type: 'SKIP',
              market: signal.marketTitle || signal.title,
              reason,
              aiConfidence: learningConfidence.confidence,
              aiComponents: learningConfidence.components,
              marketCategory: categorizeMarket(signal.marketTitle || signal.title || ''),
            });
            continue;
          }

          // Store confidence for position sizing and tracking
          evaluation.aiConfidence = learningConfidence.confidence;
          evaluation.aiComponents = learningConfidence.components;
          evaluation.reasons.push(`AI confidence: ${learningConfidence.confidence}% (${learningConfidence.dataPoints} data sources)`);
        }

        // 2. Check market type factor performance from learning system
        const factorStats = await getFactorStats(env);
        const marketType = signal.marketType || '';
        if (factorStats[marketType]) {
          const mtStats = factorStats[marketType];
          const mtTotal = (mtStats.wins || 0) + (mtStats.losses || 0);
          if (mtTotal >= 10 && mtStats.winRate < (config.minFactorWinRate ?? 40)) {
            results.skipped++;
            const reason = `Market type "${marketType}" underperforming: ${mtStats.winRate}% WR over ${mtTotal} signals (min ${config.minFactorWinRate ?? 40}%)`;
            results.skipReasons[reason] = (results.skipReasons[reason] || 0) + 1;
            await logDecision(env, {
              type: 'SKIP',
              market: signal.marketTitle || signal.title,
              reason,
              marketCategory: categorizeMarket(signal.marketTitle || signal.title || ''),
            });
            continue;
          }
        }

        // 3. Check factor combo edge
        if (config.useFactorCombos !== false && signalFactors.length >= 2) {
          const comboResult = await hasStrongCombo(env, signalFactors);
          if (comboResult) {
            evaluation.reasons.push(`Strong combo: ${comboResult.combo} (${comboResult.winRate}% WR, ${comboResult.record})`);
            evaluation.strongCombo = comboResult;
          }
        }
      } catch (learningErr) {
        // Learning check failed — proceed without it (non-blocking)
        console.log(`Learning check error for ${signal.marketTitle}: ${learningErr.message}`);
      }
    }

    // AI Learning-based position size adjustment
    if (evaluation.aiConfidence && config.useLearningData !== false) {
      const originalSize = evaluation.positionSize;
      if (evaluation.aiConfidence >= (config.learningBoostThreshold ?? 65)) {
        evaluation.positionSize = Math.min(
          config.maxPositionSize,
          Math.round(evaluation.positionSize * (config.learningBoostMultiplier ?? 1.25))
        );
        if (evaluation.positionSize !== originalSize) {
          evaluation.reasons.push(`AI boost: $${originalSize} → $${evaluation.positionSize} (confidence ${evaluation.aiConfidence}%)`);
        }
      } else if (evaluation.aiConfidence <= (config.learningPenaltyThreshold ?? 40)) {
        evaluation.positionSize = Math.max(
          config.minPositionSize || 5,
          Math.round(evaluation.positionSize * (config.learningPenaltyMultiplier ?? 0.6))
        );
        if (evaluation.positionSize !== originalSize) {
          evaluation.reasons.push(`AI penalty: $${originalSize} → $${evaluation.positionSize} (confidence ${evaluation.aiConfidence}%)`);
        }
      }
    }

    // Agent second opinion (advisory — never blocks the entry): if the
    // investigator has independently priced this market, record its view so
    // the settled ledger can show how agent-liked vs -disliked trades do.
    const agentView = await lookupAgentOpinion(
      env, signal.marketSlug, signal.directionRaw || signal.direction, evaluation.entryPrice
    );
    if (agentView) {
      evaluation.reasons.push(
        `Agent ${agentView.agentOpinion}: prices this ${Math.round(agentView.agentProb * 100)}% vs ${evaluation.entryPrice}¢ entry`
      );
    }

    // --- CREATE POSITION ---
    const position = {
      id: `at_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      marketSlug: signal.marketSlug,
      marketTitle: signal.marketTitle,
      marketType: signal.marketType,
      signalSubType: signal.signalSubType || 'moneyline',
      direction: signal.direction,
      directionRaw: signal.directionRaw || null, // exact Polymarket outcome label
      whaleAction: evaluation.whaleAction,
      entryPrice: evaluation.entryPrice,
      size: evaluation.positionSize,
      walletAddress: signal.winningWalletInfo?.wallet,
      walletTier: evaluation.walletTier,
      walletWinRate: evaluation.walletWinRate,
      walletBets: evaluation.walletBets,
      aiScore: signal.aiScore,
      score: signal.score,
      confidence: signal.confidence,
      hoursUntilEvent: signal.hoursUntilEvent,
      betSummary: signal.betSummary,
      openedAt: new Date().toISOString(),
      paperTrade: config.paperTradeMode,
      marketCategory: categorizeMarket(signal.marketTitle || signal.title || ''),
      aiConfidence: evaluation.aiConfidence || null,
      strongCombo: evaluation.strongCombo || null,
      isHighConviction: evaluation.isHighConviction || false,
      isExploration: evaluation.isExploration || false,
      // Investigator's independent view of this entry (advisory)
      agentProb: agentView ? agentView.agentProb : null,
      agentEdgePts: agentView ? agentView.agentEdgePts : null,
      agentOpinion: agentView ? agentView.agentOpinion : null,
      // For P&L calculation
      shares: evaluation.positionSize / (evaluation.entryPrice / 100), // shares = USDC / price
    };

    marketsTraded.add(signal.marketSlug); // Prevent duplicate entries this cycle
    marketTitlesTraded.add(normalizeMarketKey(signal.marketTitle));
    await addRecentMarket(env, signal.marketSlug, signal.marketTitle); // Cross-cycle tracking
    
    // Update daily stats
    dailyStats.tradesOpened++;
    dailyStats.totalSpent += evaluation.positionSize;
    if (evaluation.isExploration) {
      dailyStats.explorationTradesOpened = (dailyStats.explorationTradesOpened || 0) + 1;
    }

    if (config.paperTradeMode) {
      // PAPER MODE — record immediately as before
      stillOpen.push(position);
      results.tradesPaperTraded++;
      await logDecision(env, {
        type: 'PAPER_TRADE',
        market: signal.marketTitle || signal.title,
        size: evaluation.positionSize,
        entryPrice: evaluation.entryPrice,
        walletTier: evaluation.walletTier,
        walletWR: evaluation.walletWinRate,
        betSummary: signal.betSummary || null,
        whaleAction: evaluation.whaleAction,
        exploration: evaluation.isExploration || undefined,
        agentCheck: agentView
          ? `${agentView.agentOpinion} (agent ${Math.round(agentView.agentProb * 100)}% vs ${evaluation.entryPrice}¢)`
          : undefined,
        marketCategory: categorizeMarket(signal.marketTitle || signal.title || ''),
      });
    } else {
      // LIVE MODE — queue for executor to place on-chain
      // Block duplicate: check if we already hold this market
      const existingPosition = stillOpen.find(p =>
        p.marketSlug === signal.marketSlug || p.tokenId === (signal.tokenId || signal.token_id)
      );
      if (existingPosition) {
        results.skipped++;
        results.skipReasons['Already have position in this market'] =
          (results.skipReasons['Already have position in this market'] || 0) + 1;
        continue;
      }

      const execQueue = await getExecQueue(env);
      // Block duplicate: check if a BUY is already pending in exec queue
      const pendingBuy = execQueue.find(q =>
        q.status === 'PENDING' && q.action === 'BUY' &&
        (q.marketSlug === signal.marketSlug || q.tokenId === (signal.tokenId || signal.token_id))
      );
      if (pendingBuy) {
        results.skipped++;
        results.skipReasons['Buy already pending in exec queue'] =
          (results.skipReasons['Buy already pending in exec queue'] || 0) + 1;
        continue;
      }

      const alreadyQueued = execQueue.some(q =>
        q.status === 'PENDING' &&
        (
          (q.tokenId && q.tokenId === (signal.tokenId || signal.token_id)) ||
          (q.marketSlug && q.marketSlug === signal.marketSlug)
        ) &&
        q.action === (evaluation.whaleAction || 'BUY')
      );

      const alreadyOpen = stillOpen.some(p =>
        p.tokenId === (signal.tokenId || signal.token_id) ||
        p.marketSlug === signal.marketSlug
      );

      if (alreadyQueued) {
        await logDecision(env, {
          type: 'SKIP',
          market: signal.marketTitle || signal.title,
          reason: 'Already queued for execution',
          marketCategory: categorizeMarket(signal.marketTitle || signal.title || ''),
        });
        continue;
      }

      if (alreadyOpen) {
        await logDecision(env, {
          type: 'SKIP',
          market: signal.marketTitle || signal.title,
          reason: 'Position already open',
          marketCategory: categorizeMarket(signal.marketTitle || signal.title || ''),
        });
        continue;
      }

      if (timeSinceLastEntry < entryCooldownSeconds) {
        results.skipped++;
        results.skipReasons['Entry cooldown active'] =
          (results.skipReasons['Entry cooldown active'] || 0) + 1;
        continue;
      }

      const teamMatch = signal.marketTitle?.match(/^Will (.+?) win on/);
      const teamName = teamMatch ? teamMatch[1].toLowerCase() : null;
      if (teamName && teamsEnteredThisCycle.has(teamName)) {
        results.skipped++;
        results.skipReasons['Already entering this team this cycle'] =
          (results.skipReasons['Already entering this team this cycle'] || 0) + 1;
        continue;
      }

      const tradeId = `trade_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const tokens = await lookupMarketTokens(signal.marketSlug);
      const tokenId = tokens
        ? (signal.direction === 'NO' ? tokens.noTokenId : tokens.yesTokenId)
        : (signal.tokenId || signal.token_id || null);
      const conditionId = tokens?.conditionId ?? signal.conditionId ?? signal.condition_id ?? null;
      
      await addToExecQueue(env, {
        id: tradeId,
        action: evaluation.whaleAction || 'BUY',
        marketSlug: signal.marketSlug,
        marketTitle: signal.marketTitle || signal.title,
        conditionId,
        tokenId,
        negRisk: signal.negRisk ?? signal.neg_risk ?? false,
        tickSize: signal.tickSize ?? signal.tick_size ?? '0.01',
        entryPrice: evaluation.entryPrice / 100,  // Convert from percentage to decimal (67% → 0.67)
        size: evaluation.positionSize,
        walletTier: evaluation.walletTier,
        walletWR: evaluation.walletWinRate,
        whaleWallet: signal.largestWallet || signal.topTrades?.[0]?.wallet || null,
        whaleWalletTier: evaluation.walletTier,
        whaleWalletWinRate: evaluation.walletWinRate,
        whaleEntryPrice: (() => {
          const v = signal.avgEntryPrice ?? signal.entryPrice ?? signal.priceAtSignal;
          return v != null ? (v <= 2 ? v : v / 100) : null;
        })(),
        marketCategory: categorizeMarket(signal.marketTitle || signal.title || ''),
        direction: signal.direction,
        aiConfidence: evaluation.aiConfidence || null,
        aiComponents: evaluation.aiComponents || null,
        strongCombo: evaluation.strongCombo || null,
        isHighConviction: evaluation.isHighConviction || false,
      });
      await env.SIGNALS_CACHE.put('autotrader_last_entry_time', String(Date.now()));
      if (teamName) teamsEnteredThisCycle.add(teamName);

      await logDecision(env, {
        type: 'QUEUED',
        market: signal.marketTitle || signal.title,
        size: evaluation.positionSize,
        entryPrice: evaluation.entryPrice,
        walletTier: evaluation.walletTier,
        walletWR: evaluation.walletWinRate,
        whaleAction: evaluation.whaleAction,
        marketCategory: categorizeMarket(signal.marketTitle || signal.title || ''),
        tradeId,
      });
      
      results.tradesQueued = (results.tradesQueued || 0) + 1;
    }
  }
  
  // Save updated state
  await savePositions(env, stillOpen);
  await saveDailyStats(env, dailyStats);
  try {
    await env.SIGNALS_CACHE.put(AT_KEYS.SKIP_LOG_MEMORY, JSON.stringify(skipLogMemory), { expirationTtl: 48 * 60 * 60 });
  } catch (e) {}

  return {
    ...results,
    openPositions: stillOpen.length,
    dailyPnL: dailyStats.realizedPnL,
    totalPnL: perf?.totalPnL || 0,
  };
}

// ============================================================
// P&L CALCULATION
// ============================================================
function calculatePnL(position, currentPrice) {
  // Binary market P&L:
  // If you BUY at 40% for $100, you get 250 shares ($100 / 0.40)
  // If market resolves YES (100%), you get 250 * $1 = $250 → P&L = +$150
  // If market goes to 60%, your shares are worth 250 * $0.60 = $150 → P&L = +$50
  // If market goes to 30%, your shares are worth 250 * $0.30 = $75 → P&L = -$25
  
  const shares = position.shares || (position.size / (position.entryPrice / 100));
  const currentValue = shares * (currentPrice / 100);
  const pnl = currentValue - position.size;
  const pctReturn = position.size > 0 ? (pnl / position.size) * 100 : 0;
  
  return {
    amount: Math.round(pnl * 100) / 100,
    percent: Math.round(pctReturn * 10) / 10,
    currentValue: Math.round(currentValue * 100) / 100,
  };
}

// ============================================================
// MANUAL ACTIONS (from admin UI)
// ============================================================
export async function manualClosePosition(env, positionId, exitPrice) {
  const positions = await getOpenPositions(env);
  const idx = positions.findIndex(p => p.id === positionId);
  if (idx === -1) return { error: 'Position not found' };
  
  const position = positions[idx];
  const pnl = calculatePnL(position, exitPrice || position.entryPrice);
  
  const closedTrade = {
    ...position,
    marketCategory: position.marketCategory || categorizeMarket(position.marketTitle || ''),
    closedAt: new Date().toISOString(),
    exitPrice: exitPrice || position.entryPrice,
    exitType: 'manual',
    exitReason: 'Manually closed by admin',
    pnl: pnl.amount,
    pnlPercent: pnl.percent,
    outcome: pnl.amount > 0 ? 'win' : 'loss',
  };
  
  await addToHistory(env, closedTrade);
  await updatePerformance(env, closedTrade);
  
  positions.splice(idx, 1);
  await savePositions(env, positions);
  
  return { success: true, closedTrade };
}

/**
 * Record a closed trade (history, performance, daily stats, log) without touching open positions.
 * Caller removes the position from KV. exitPrice is in percent (same units as position.entryPrice).
 */
export async function recordClosedTrade(env, position, exitPrice, exitType, exitReason) {
  const pnl = calculatePnL(position, exitPrice);
  const closedTrade = {
    ...position,
    marketCategory: position.marketCategory || categorizeMarket(position.marketTitle || ''),
    closedAt: new Date().toISOString(),
    exitPrice,
    exitType,
    exitReason,
    pnl: pnl.amount,
    pnlPercent: pnl.percent,
    outcome: pnl.amount > 0 ? 'win' : pnl.amount < 0 ? 'loss' : 'push',
  };
  await addToHistory(env, closedTrade);
  await updatePerformance(env, closedTrade);

  const dailyStats = await getDailyStats(env);
  dailyStats.tradesClosed = (dailyStats.tradesClosed || 0) + 1;
  dailyStats.realizedPnL = (dailyStats.realizedPnL || 0) + pnl.amount;
  dailyStats.totalReturned = (dailyStats.totalReturned || 0) + position.size + pnl.amount;
  if (pnl.amount > 0) dailyStats.wins++;
  else if (pnl.amount < 0) dailyStats.losses++;
  await saveDailyStats(env, dailyStats);

  await logDecision(env, {
    type: 'EXIT',
    market: position.marketTitle,
    reason: exitReason,
    exitType,
    pnl: pnl.amount,
    paperTrade: position.paperTrade === true,
  });
}

export async function emergencyStopAll(env) {
  const config = await getAutotraderConfig(env);
  config.enabled = false;
  await env.SIGNALS_CACHE.put(AT_KEYS.CONFIG, JSON.stringify(config));
  
  const positions = await getOpenPositions(env);
  const closed = [];
  
  for (const position of positions) {
    const closedTrade = {
      ...position,
      marketCategory: position.marketCategory || categorizeMarket(position.marketTitle || ''),
      closedAt: new Date().toISOString(),
      exitPrice: position.entryPrice,
      exitType: 'emergency_stop',
      exitReason: 'Emergency stop - all positions closed',
      pnl: 0,
      pnlPercent: 0,
      outcome: 'cancelled',
    };
    await addToHistory(env, closedTrade);
    closed.push(closedTrade);
  }
  
  await savePositions(env, []);
  
  await logDecision(env, {
    type: 'EMERGENCY_STOP',
    positionsClosed: closed.length,
  });
  
  return { success: true, positionsClosed: closed.length, botDisabled: true };
}

// ============================================================
// SELF-LEARNING: Track bot's own performance by factor
// ============================================================
export async function recordBotTradeOutcome(env, closedTrade) {
  if (!env.SIGNALS_CACHE) return;
  
  try {
    const learning = await env.SIGNALS_CACHE.get(AT_KEYS.LEARNING, { type: 'json' }) || {};
    
    const factors = [
      closedTrade.walletTier,
      closedTrade.marketType,
      closedTrade.signalSubType,
      closedTrade.whaleAction,
      `wr_${Math.floor((closedTrade.walletWinRate || 0) / 10) * 10}`, // wr_70, wr_80, etc.
      `entry_${Math.floor((closedTrade.entryPrice || 50) / 10) * 10}`, // entry_40, entry_50, etc.
    ].filter(Boolean);
    
    for (const factor of factors) {
      if (!learning[factor]) {
        learning[factor] = { wins: 0, losses: 0, totalPnL: 0, avgPnL: 0 };
      }
      
      if (closedTrade.pnl > 0) {
        learning[factor].wins++;
      } else {
        learning[factor].losses++;
      }
      learning[factor].totalPnL += closedTrade.pnl || 0;
      const total = learning[factor].wins + learning[factor].losses;
      learning[factor].avgPnL = total > 0 ? Math.round((learning[factor].totalPnL / total) * 100) / 100 : 0;
      learning[factor].winRate = total > 0 ? Math.round((learning[factor].wins / total) * 100) : 0;
    }
    
    await env.SIGNALS_CACHE.put(AT_KEYS.LEARNING, JSON.stringify(learning), {
      expirationTtl: 365 * 24 * 60 * 60
    });
  } catch (e) {}
}

export async function getBotLearning(env) {
  try {
    return await env.SIGNALS_CACHE.get(AT_KEYS.LEARNING, { type: 'json' }) || {};
  } catch (e) { return {}; }
}

// ============================================================
// RECALCULATE PERFORMANCE from trade history
// Use this to fix corrupted stats (e.g. after $0 trades were counted as losses)
// ============================================================
async function recalcPerformance(env) {
  const history = await getTradeHistory(env, 500);
  
  const perf = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    winRate: 0,
    totalPnL: 0,
    bestTrade: null,
    worstTrade: null,
    avgReturn: 0,
    currentStreak: 0,
    longestWinStreak: 0,
    longestLoseStreak: 0,
    byMarketType: {},
    byWalletTier: {},
    bySport: {},
    startedAt: history.length > 0 ? history[0].openedAt : new Date().toISOString(),
  };
  
  for (const trade of history) {
    const pnl = trade.pnl || 0;
    const isBreakeven = pnl === 0;
    
    if (isBreakeven) {
      perf.pushes++;
      continue; // Don't count in W/L record
    }
    
    perf.totalTrades++;
    perf.totalPnL += pnl;
    
    if (pnl > 0) {
      perf.wins++;
      perf.currentStreak = Math.max(1, perf.currentStreak + 1);
      perf.longestWinStreak = Math.max(perf.longestWinStreak, perf.currentStreak);
    } else {
      perf.losses++;
      perf.currentStreak = Math.min(-1, perf.currentStreak - 1);
      perf.longestLoseStreak = Math.max(perf.longestLoseStreak, Math.abs(perf.currentStreak));
    }
    
    if (!perf.bestTrade || pnl > (perf.bestTrade.pnl || 0)) {
      perf.bestTrade = { market: trade.marketTitle, pnl, date: trade.closedAt };
    }
    if (!perf.worstTrade || pnl < (perf.worstTrade.pnl || 0)) {
      perf.worstTrade = { market: trade.marketTitle, pnl, date: trade.closedAt };
    }
    
    // By market type
    const mType = trade.marketType || 'unknown';
    if (!perf.byMarketType[mType]) perf.byMarketType[mType] = { wins: 0, losses: 0, pnl: 0 };
    perf.byMarketType[mType].pnl += pnl;
    pnl > 0 ? perf.byMarketType[mType].wins++ : perf.byMarketType[mType].losses++;
    
    // By wallet tier
    const tier = trade.walletTier || 'unknown';
    if (!perf.byWalletTier[tier]) perf.byWalletTier[tier] = { wins: 0, losses: 0, pnl: 0 };
    perf.byWalletTier[tier].pnl += pnl;
    pnl > 0 ? perf.byWalletTier[tier].wins++ : perf.byWalletTier[tier].losses++;
  }
  
  perf.winRate = perf.totalTrades > 0 ? Math.round((perf.wins / perf.totalTrades) * 100) : 0;
  perf.avgReturn = perf.totalTrades > 0 ? Math.round((perf.totalPnL / perf.totalTrades) * 100) / 100 : 0;
  perf.totalPnL = Math.round(perf.totalPnL * 100) / 100;
  
  await env.SIGNALS_CACHE.put(AT_KEYS.PERFORMANCE, JSON.stringify(perf), {
    expirationTtl: 365 * 24 * 60 * 60
  });
  
  return perf;
}

// ============================================================
// CATEGORY PERFORMANCE (analytics by market category)
// ============================================================
export async function getCategoryPerformance(env) {
  const history = await getTradeHistory(env, 500);
  const categories = {};
  
  for (const trade of history) {
    const cat = trade.marketCategory || categorizeMarket(trade.marketTitle || '');
    if (!categories[cat]) {
      categories[cat] = {
        category: cat,
        trades: 0,
        wins: 0,
        losses: 0,
        flat: 0,
        totalPnl: 0,
        avgPnl: 0,
        bestTrade: 0,
        worstTrade: 0,
        avgHoldHours: 0,
        totalHoldHours: 0,
        winRate: 0,
      };
    }
    const c = categories[cat];
    c.trades++;
    c.totalPnl += (trade.pnl || 0);
    if ((trade.pnl || 0) > 0) c.wins++;
    else if ((trade.pnl || 0) < 0) c.losses++;
    else c.flat++;
    if ((trade.pnl || 0) > c.bestTrade) c.bestTrade = trade.pnl;
    if ((trade.pnl || 0) < c.worstTrade) c.worstTrade = trade.pnl;
    if (trade.openedAt && trade.closedAt) {
      c.totalHoldHours += (new Date(trade.closedAt) - new Date(trade.openedAt)) / 3600000;
    }
  }
  
  for (const cat of Object.values(categories)) {
    cat.avgPnl = cat.trades > 0 ? +(cat.totalPnl / cat.trades).toFixed(2) : 0;
    cat.avgHoldHours = cat.trades > 0 ? +(cat.totalHoldHours / cat.trades).toFixed(1) : 0;
    cat.winRate = (cat.wins + cat.losses) > 0 ? Math.round((cat.wins / (cat.wins + cat.losses)) * 100) : 0;
  }
  
  return categories;
}

// ============================================================
// EXEC CONFIRM — Executor reports back: trade filled or failed
// ============================================================
export async function handleExecConfirm(env, body) {
  // Executor may send "id" / "orderId" or "tradeId" / "orderID"
  const tradeId = body.id ?? body.tradeId;
  const orderId = body.orderId ?? body.orderID;
  const { status, error } = body;

  const queue = await getExecQueue(env);
  let queueItem = queue.find(t => t.id === tradeId);
  let tradeFromQueue = true;

  if (!queueItem && body.tradeData) {
    queueItem = {
      id: body.tradeId ?? tradeId,
      action: body.tradeData.action,
      marketSlug: body.tradeData.marketSlug,
      marketTitle: body.tradeData.marketTitle,
      conditionId: body.tradeData.conditionId,
      tokenId: body.tradeData.tokenId,
      negRisk: body.tradeData.negRisk || false,
      tickSize: body.tradeData.tickSize || '0.01',
      direction: body.tradeData.direction || 'YES',
      size: body.tradeData.size,
      entryPrice: body.tradeData.entryPrice,
      walletTier: body.tradeData.walletTier,
      walletWinRate: body.tradeData.walletWinRate,
      marketCategory: body.tradeData.marketCategory,
      whaleWallet: body.tradeData.whaleWallet,
      whaleWalletTier: body.tradeData.whaleWalletTier,
      whaleWalletWinRate: body.tradeData.whaleWalletWinRate,
      whaleEntryPrice: body.tradeData.whaleEntryPrice ?? body.tradeData.entryPrice,
    };
    tradeFromQueue = false;
    console.log(`Trade ${tradeId} not in queue — using confirm payload data`);
  }

  if (!queueItem) {
    return { ok: false, error: 'Trade not found in queue and no tradeData in confirm' };
  }

  if (status === 'FILLED') {
    if (queueItem.action === 'BUY') {
      const positions = await getOpenPositions(env);

      const existingPosition = positions.find(p =>
        p.tokenId === queueItem.tokenId && p.marketSlug === queueItem.marketSlug
      );
      if (existingPosition) {
        console.log(`Position already exists for ${queueItem.marketTitle} — skipping duplicate creation`);
        if (tradeFromQueue) {
          const updatedQueue = queue.filter(q => q.id !== tradeId);
          await env.SIGNALS_CACHE.put(AT_KEYS.EXEC_QUEUE, JSON.stringify(updatedQueue));
        }
        return { ok: true, message: 'Position already exists', positionId: existingPosition.id };
      }

      const actualShares = body.filledShares ?? (queueItem.size / (queueItem.entryPrice || 0.5));
      const actualEntryPrice = body.filledPrice != null
        ? Math.round(body.filledPrice * 10000) / 100
        : Math.round((queueItem.entryPrice || 0.5) * 10000) / 100;

      const position = {
        id: `at_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        marketSlug: queueItem.marketSlug,
        marketTitle: queueItem.marketTitle,
        conditionId: queueItem.conditionId,
        tokenId: queueItem.tokenId,
        negRisk: queueItem.negRisk || false,
        tickSize: queueItem.tickSize || '0.01',
        direction: queueItem.direction || 'YES',
        entryPrice: actualEntryPrice,
        size: queueItem.size,
        walletTier: queueItem.walletTier,
        marketCategory: queueItem.marketCategory,
        openedAt: new Date().toISOString(),
        onChainOrderId: body.orderID ?? body.orderId ?? 'unknown',
        tradeId: queueItem.id ?? body.tradeId ?? tradeId,
        paperTrade: false,
        shares: actualShares,
        peakPctGain: 0,
        trailingStopActive: false,
        trailingStopLevel: null,
        whaleWallet: queueItem.whaleWallet ?? null,
        whaleWalletTier: queueItem.whaleWalletTier ?? queueItem.walletTier ?? null,
        whaleWalletWinRate: queueItem.whaleWalletWinRate ?? null,
        whaleEntryPrice: queueItem.whaleEntryPrice ?? queueItem.entryPrice ?? null,
        aiConfidence: queueItem.aiConfidence || null,
        ourEntryPrice: actualEntryPrice,
        entrySlippage: queueItem.whaleEntryPrice != null
          ? Math.round(((actualEntryPrice - (queueItem.whaleEntryPrice * 100)) / (queueItem.whaleEntryPrice * 100)) * 1000) / 10
          : null,
      };

      positions.push(position);
      await env.SIGNALS_CACHE.put(AT_KEYS.POSITIONS, JSON.stringify(positions), {
        expirationTtl: 30 * 24 * 60 * 60
      });

      console.log(`Position created from fill: ${position.id} | ${position.marketTitle} | ${actualShares} shares @ ${actualEntryPrice}%`);

      await logDecision(env, {
        type: 'EXECUTED',
        market: queueItem.marketTitle,
        size: position.size,
        entryPrice: position.entryPrice,
        walletTier: queueItem.walletTier,
        orderID: orderId,
        marketCategory: queueItem.marketCategory,
      });
    } else if (queueItem.action === 'SELL') {
      const positions = await getOpenPositions(env);
      const position = positions.find(p =>
        p.id === queueItem.positionId ||
        p.tradeId === queueItem.originalTradeId ||
        p.tokenId === queueItem.tokenId
      );

      if (position) {
        const entryPricePct = position.entryPrice;
        const exitPricePct = body.filledPrice != null
          ? Math.round(body.filledPrice * 10000) / 100
          : entryPricePct;
        const pnlPercent = ((exitPricePct - entryPricePct) / entryPricePct) * 100;
        const pnlDollar = Math.round((pnlPercent / 100) * position.size * 100) / 100;
        const outcome = pnlDollar > 0 ? 'win' : pnlDollar < 0 ? 'loss' : 'push';

        const closedTrade = {
          ...position,
          marketCategory: position.marketCategory || categorizeMarket(position.marketTitle || ''),
          exitPrice: exitPricePct,
          exitType: queueItem.exitType || 'unknown',
          exitReason: queueItem.exitReason || '',
          closedAt: new Date().toISOString(),
          pnl: pnlDollar,
          pnlPercent: Math.round(pnlPercent * 100) / 100,
          onChainExitOrderId: body.orderID ?? body.orderId,
          outcome,
        };
        await addToHistory(env, closedTrade);
        await updatePerformance(env, closedTrade);

        const dailyStats = await getDailyStats(env);
        dailyStats.tradesClosed++;
        dailyStats.realizedPnL += pnlDollar;
        dailyStats.totalReturned += position.size + pnlDollar;
        if (pnlDollar > 0) dailyStats.wins++;
        else if (pnlDollar < 0) dailyStats.losses++;
        await saveDailyStats(env, dailyStats);
        await logDecision(env, { type: 'EXIT', market: position.marketTitle, reason: queueItem.exitReason || '', exitType: queueItem.exitType, pnl: pnlDollar, paperTrade: false });

        const remaining = positions.filter(p => p.id !== position.id);
        await env.SIGNALS_CACHE.put(AT_KEYS.POSITIONS, JSON.stringify(remaining), {
          expirationTtl: 30 * 24 * 60 * 60
        });
        console.log(`Position closed: ${position.marketTitle} | P&L: $${pnlDollar} (${pnlPercent.toFixed(1)}%)`);
      } else {
        // Position was already closed by cron — try to find in recent history and update with real exit data
        const history = await env.SIGNALS_CACHE.get(AT_KEYS.HISTORY, { type: 'json' }) || [];
        const recentClose = history.find(h =>
          (h.tokenId === queueItem.tokenId || h.marketSlug === queueItem.marketSlug) &&
          h.exitType !== 'executor_sell' &&
          new Date(h.closedAt).getTime() > Date.now() - (2 * 60 * 60 * 1000) // Within last 2 hours
        );

        if (recentClose && body.filledPrice != null) {
          const realExitPrice = Math.round(body.filledPrice * 10000) / 100;
          const realPnlPercent = ((realExitPrice - recentClose.entryPrice) / recentClose.entryPrice) * 100;
          const realPnlDollar = Math.round((realPnlPercent / 100) * recentClose.size * 100) / 100;

          recentClose.exitPrice = realExitPrice;
          recentClose.exitType = queueItem.exitType || 'executor_sell';
          recentClose.pnl = realPnlDollar;
          recentClose.pnlPercent = Math.round(realPnlPercent * 100) / 100;
          recentClose.outcome = realPnlDollar > 0 ? 'win' : realPnlDollar < 0 ? 'loss' : 'push';
          recentClose.correctedByExecutor = true;

          const trimmed = history.slice(-1000);
          await env.SIGNALS_CACHE.put(AT_KEYS.HISTORY, JSON.stringify(trimmed), {
            expirationTtl: 180 * 24 * 60 * 60
          });

          console.log(`Corrected exit data for ${recentClose.marketTitle}: exit ${realExitPrice}%, P&L $${realPnlDollar}`);
        } else {
          console.log(`SELL confirmed but position not found and no matching history for ${queueItem.marketTitle}`);
        }
      }
    }
    if (tradeFromQueue) {
      const updatedQueue = queue.filter(q => q.id !== tradeId);
      await env.SIGNALS_CACHE.put(AT_KEYS.EXEC_QUEUE, JSON.stringify(updatedQueue));
    }
  } else if (status === 'FAILED') {
    await logDecision(env, {
      type: 'EXEC_FAILED',
      market: queueItem.marketTitle || 'Unknown',
      reason: error || 'Order execution failed',
      tradeId,
    });
    if (tradeFromQueue) {
      const updatedQueue = queue.filter(q => q.id !== tradeId);
      await env.SIGNALS_CACHE.put(AT_KEYS.EXEC_QUEUE, JSON.stringify(updatedQueue));
    }
  }

  return { ok: true };
}

// ============================================================
// EXPORTS
// ============================================================
export {
  AT_KEYS,
  DEFAULT_CONFIG,
  addToExecQueue,
  calculatePositionSize,
  evaluateSignal,
  getDailyStats,
  getPnLSummary,
  recalcPerformance,
};

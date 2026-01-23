// src/index.js
var POLYMARKET_API = "https://data-api.polymarket.com";
// SCORING SYSTEM v6 - Balanced whale/insider probability
// Higher score = higher confidence this is insider/whale activity
// Target: 100+ score should be "very likely insider", not impossible to reach
var SCORES = {
  // WHALE BET SIZE (single bet)
  WHALE_BET_MASSIVE: 70,    // $75k+ single bet - definite whale
  WHALE_BET_LARGE: 50,      // $30k+ single bet - very likely whale
  WHALE_BET_NOTABLE: 30,    // $15k+ single bet - possible whale
  WHALE_BET_MEDIUM: 15,     // $8k+ single bet - notable bet
  // Bets under $8k get 0 points
  
  // CONCENTRATION (few wallets controlling the action)
  CONCENTRATION_SINGLE_WHALE: 25,  // 1 wallet has >80% AND bet $15k+
  CONCENTRATION_WHALE_DUO: 15,     // 2 wallets have >80% AND both bet $8k+
  CONCENTRATION_HIGH: 10,          // Top wallet has >60% of volume AND $10k+
  
  // FRESH WALLET + BIG MONEY (hiding identity - strong insider signal)
  // Does NOT stack with whale bet - it's one or the other
  FRESH_WHALE_HUGE: 60,     // Fresh wallet betting $50k+ (VERY suspicious)
  FRESH_WHALE_LARGE: 45,    // Fresh wallet betting $25k+
  FRESH_WHALE_NOTABLE: 30,  // Fresh wallet betting $10k+
  FRESH_WHALE_MEDIUM: 15,   // Fresh wallet betting $5k+
  
  // COORDINATED (multiple wallets acting together)
  COORDINATED_WHALES: 30,   // 3+ wallets ALL betting $8k+ within 2hrs
  COORDINATED_LARGE: 15,    // 3+ wallets ALL betting $3k+ within 2hrs
  
  // VOLUME
  VOLUME_MASSIVE: 15,       // >$150k total
  VOLUME_LARGE: 10,         // >$75k total
  VOLUME_NOTABLE: 5,        // >$40k total
  
  // MARKET TYPE (minor factor)
  POLITICAL: 5,             // Elections can have insider info
  SPORTS: 3,                // Injury news, etc
  CRYPTO: 3,                // Less insider advantage
  
  // TIMING/ODDS
  EXTREME_ODDS: 10,         // Betting heavy on long shots (>80% or <20%)
  RAPID_ACCUMULATION: 10,   // Large position built quickly
  
  // LAST-MINUTE WHALE (urgent insider info)
  // Only applies if bet is $15k+ AND placed close to event
  LAST_MINUTE_WHALE_2H: 25, // $15k+ whale bet within 2 hours of event
  LAST_MINUTE_WHALE_6H: 15, // $15k+ whale bet within 6 hours of event
  LAST_MINUTE_WHALE_12H: 10, // $15k+ whale bet within 12 hours of event
  
  // PROVEN WINNER WALLET (track record - THE HOLY GRAIL)
  // Requires 10+ resolved bets in last 30 days AND $50k+ current bet
  PROVEN_WINNER_ELITE: 80,  // 70%+ win rate - this wallet KNOWS something
  PROVEN_WINNER_STRONG: 50, // 65-70% win rate - very profitable bettor
  PROVEN_WINNER_GOOD: 30,   // 60-65% win rate - consistently profitable
  PROVEN_WINNER_EDGE: 15,   // 55-60% win rate - slight edge
  
  // WHALE + PROVEN WINNER COMBO
  WHALE_PROVEN_WINNER: 30   // $50k+ bet from a proven winner wallet
};

// Minimum requirements for wallet track record
var WALLET_TRACK_RECORD = {
  MIN_BETS: 10,             // Minimum resolved bets to count
  LOOKBACK_DAYS: 30,        // Only count bets from last 30 days
  MIN_BET_FOR_CHECK: 50000, // Only check win rate for wallets betting $50k+
  CACHE_HOURS: 6            // How long to cache wallet stats
};

var POLITICAL_KEYWORDS = ["election", "trump", "biden", "president", "senate", "congress", "governor", "republican", "democrat", "vote", "primary", "inauguration", "impeach", "pardon", "executive order", "cabinet", "nominee"];
var CRYPTO_KEYWORDS = ["bitcoin", "btc", "ethereum", "eth", "crypto", "sec", "etf", "regulation", "gensler", "solana", "sol", "doge", "xrp"];
var SPORTS_KEYWORDS = ["nba", "nfl", "mlb", "nhl", "super bowl", "championship", "playoffs", "world series", "mvp"];

var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

// Filter out short-term gambling/speculation markets
function isShortTermGamblingMarket(title) {
  if (!title) return false;
  const lowerTitle = title.toLowerCase();
  
  const gamblingPatterns = [
    /up or down/i,
    /will.*(?:btc|bitcoin|eth|ethereum|sol|solana|xrp|doge).*(?:above|below|higher|lower).*(?:at|by)\s*\d/i,
    /\d{1,2}:\d{2}\s*(?:am|pm)?\s*[-–to]+\s*\d{1,2}:\d{2}\s*(?:am|pm)/i,
    /(?:\d+\s*)?(?:minute|min|hour|hr)\s*(?:candle|close|window)/i,
    /price.*(?:at|by)\s*\d{1,2}:\d{2}/i,
    /hourly\s*(?:close|high|low|price)/i,
  ];
  
  for (const pattern of gamblingPatterns) {
    if (pattern.test(lowerTitle)) {
      return true;
    }
  }
  
  return false;
}

// Extract event date from title or slug - returns Date object or null
// Used for calculating time until event for last-minute whale scoring
function getEventDate(title, slug) {
  const now = new Date();
  
  // Try to extract date from slug (format: 2026-01-21)
  const slugDateMatch = (slug || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (slugDateMatch) {
    const eventYear = parseInt(slugDateMatch[1]);
    const eventMonth = parseInt(slugDateMatch[2]) - 1;
    const eventDay = parseInt(slugDateMatch[3]);
    // Assume event is at 7pm EST (common for sports)
    return new Date(eventYear, eventMonth, eventDay, 19, 0, 0);
  }
  
  // Try to extract date from title
  const titleText = title || '';
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 
                      'july', 'august', 'september', 'october', 'november', 'december',
                      'jan', 'feb', 'mar', 'apr', 'may', 'jun', 
                      'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  
  const titleDateMatch = titleText.toLowerCase().match(
    new RegExp(`(${monthNames.join('|')})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`, 'i')
  );
  
  if (titleDateMatch) {
    const monthStr = titleDateMatch[1].toLowerCase();
    const day = parseInt(titleDateMatch[2]);
    const year = titleDateMatch[3] ? parseInt(titleDateMatch[3]) : now.getFullYear();
    
    let month;
    const fullMonthIndex = monthNames.slice(0, 12).indexOf(monthStr);
    const shortMonthIndex = monthNames.slice(12).indexOf(monthStr);
    if (fullMonthIndex !== -1) {
      month = fullMonthIndex;
    } else if (shortMonthIndex !== -1) {
      month = shortMonthIndex;
    } else {
      return null;
    }
    
    // Assume event is at 7pm EST
    return new Date(year, month, day, 19, 0, 0);
  }
  
  // Check for ISO date in title
  const isoDateMatch = titleText.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoDateMatch) {
    return new Date(
      parseInt(isoDateMatch[1]),
      parseInt(isoDateMatch[2]) - 1,
      parseInt(isoDateMatch[3]),
      19, 0, 0
    );
  }
  
  return null;
}

// ============================================
// WALLET WIN RATE TRACKING
// ============================================

// Fetch wallet's resolved bets and calculate win rate
async function getWalletWinRate(walletAddress, env) {
  // Check cache first
  if (env.SIGNALS_CACHE) {
    try {
      const cacheKey = `wallet_stats:${walletAddress}`;
      const cached = await env.SIGNALS_CACHE.get(cacheKey, { type: "json" });
      if (cached && cached.cachedAt) {
        const cacheAge = (Date.now() - cached.cachedAt) / (1000 * 60 * 60);
        if (cacheAge < WALLET_TRACK_RECORD.CACHE_HOURS) {
          return cached;
        }
      }
    } catch (e) {
      console.log("Cache read error for wallet stats:", e.message);
    }
  }
  
  // Fetch from Polymarket API
  try {
    // Get wallet's activity including resolved positions
    const [activityRes, positionsRes] = await Promise.all([
      fetch(`${POLYMARKET_API}/activity?user=${walletAddress}&limit=500`),
      fetch(`${POLYMARKET_API}/positions?user=${walletAddress}&status=all`)
    ]);
    
    if (!activityRes.ok || !positionsRes.ok) {
      return null;
    }
    
    const activity = await activityRes.json();
    const positions = await positionsRes.json();
    
    // Calculate cutoff date (30 days ago)
    const cutoffDate = Date.now() - (WALLET_TRACK_RECORD.LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    
    // Find REDEEM events (winning bets that paid out)
    const redeems = (activity || []).filter(a => {
      if (a.type !== 'REDEEM') return false;
      const timestamp = a.timestamp < 1e12 ? a.timestamp * 1000 : a.timestamp;
      return timestamp >= cutoffDate;
    });
    
    // Find resolved positions (both winning and losing)
    // A position is "resolved" if the market has ended
    // We need to look at positions with outcome determined
    
    let wins = 0;
    let losses = 0;
    let totalResolved = 0;
    let totalWinnings = 0;
    let totalLost = 0;
    const resolvedBets = [];
    
    // Process redeems as wins
    for (const redeem of redeems) {
      const payout = parseFloat(redeem.usdcSize) || 0;
      if (payout > 0) {
        wins++;
        totalWinnings += payout;
        totalResolved++;
        resolvedBets.push({
          market: redeem.title || redeem.slug,
          result: 'WIN',
          payout: payout,
          timestamp: redeem.timestamp < 1e12 ? redeem.timestamp * 1000 : redeem.timestamp
        });
      }
    }
    
    // To find losses, we need to look at positions where:
    // 1. The position is no longer active (resolved)
    // 2. There was no corresponding REDEEM (they lost)
    // This is tricky - we'll estimate based on activity patterns
    
    // Look for TRADE buys that don't have matching REDEEMs on resolved markets
    const trades = (activity || []).filter(a => {
      if (a.type !== 'TRADE' || a.side !== 'BUY') return false;
      const timestamp = a.timestamp < 1e12 ? a.timestamp * 1000 : a.timestamp;
      return timestamp >= cutoffDate;
    });
    
    // Group trades by market
    const marketTrades = {};
    for (const trade of trades) {
      const marketKey = trade.slug || trade.conditionId;
      if (!marketTrades[marketKey]) {
        marketTrades[marketKey] = {
          market: trade.title || trade.slug,
          totalInvested: 0,
          outcome: trade.outcome,
          trades: []
        };
      }
      marketTrades[marketKey].totalInvested += parseFloat(trade.usdcSize) || 0;
      marketTrades[marketKey].trades.push(trade);
    }
    
    // Check which markets have redeems (wins) vs no redeems (potential losses)
    const redeemMarkets = new Set(redeems.map(r => r.slug || r.conditionId));
    
    // Markets with trades but no redeems could be:
    // 1. Still open (not resolved)
    // 2. Resolved as a loss
    // We need to check if the market is resolved
    
    // For now, use positions endpoint to get more accurate data
    // Positions with curPrice = 0 or 1 and no value = resolved
    for (const pos of (positions || [])) {
      const curPrice = parseFloat(pos.curPrice) || parseFloat(pos.currentPrice) || 0;
      const initialValue = parseFloat(pos.initialValue) || 0;
      const currentValue = parseFloat(pos.currentValue) || parseFloat(pos.value) || 0;
      
      // Check if this is a resolved position (price went to 0 or 1)
      if (curPrice <= 0.02 || curPrice >= 0.98) {
        // Check timestamp if available
        const marketKey = pos.slug || pos.conditionId;
        
        if (curPrice >= 0.98 && currentValue > initialValue * 0.5) {
          // Likely a win (price went to 1 and has value)
          // Already counted in redeems probably
        } else if (curPrice <= 0.02 && currentValue < initialValue * 0.1) {
          // Likely a loss (price went to 0)
          if (!redeemMarkets.has(marketKey) && initialValue > 0) {
            losses++;
            totalLost += initialValue;
            totalResolved++;
            resolvedBets.push({
              market: pos.title || pos.slug,
              result: 'LOSS',
              lost: initialValue,
              timestamp: Date.now() // We don't have exact resolution time
            });
          }
        }
      }
    }
    
    // Calculate win rate
    const winRate = totalResolved > 0 ? (wins / totalResolved) * 100 : 0;
    const profitLoss = totalWinnings - totalLost;
    
    const stats = {
      walletAddress,
      wins,
      losses,
      totalResolved,
      winRate: Math.round(winRate * 10) / 10,
      totalWinnings: Math.round(totalWinnings),
      totalLost: Math.round(totalLost),
      profitLoss: Math.round(profitLoss),
      meetsMinimum: totalResolved >= WALLET_TRACK_RECORD.MIN_BETS,
      cachedAt: Date.now(),
      recentBets: resolvedBets.slice(0, 10)
    };
    
    // Cache the results
    if (env.SIGNALS_CACHE) {
      try {
        const cacheKey = `wallet_stats:${walletAddress}`;
        await env.SIGNALS_CACHE.put(cacheKey, JSON.stringify(stats), {
          expirationTtl: 60 * 60 * WALLET_TRACK_RECORD.CACHE_HOURS
        });
      } catch (e) {
        console.log("Cache write error for wallet stats:", e.message);
      }
    }
    
    return stats;
  } catch (error) {
    console.log("Error fetching wallet win rate:", error.message);
    return null;
  }
}

// Get win rate bonus score for a wallet
function getWinRateBonus(walletStats) {
  if (!walletStats || !walletStats.meetsMinimum) {
    return { bonus: 0, tier: null };
  }
  
  const winRate = walletStats.winRate;
  
  if (winRate >= 70) {
    return { bonus: SCORES.PROVEN_WINNER_ELITE, tier: 'ELITE', winRate };
  } else if (winRate >= 65) {
    return { bonus: SCORES.PROVEN_WINNER_STRONG, tier: 'STRONG', winRate };
  } else if (winRate >= 60) {
    return { bonus: SCORES.PROVEN_WINNER_GOOD, tier: 'GOOD', winRate };
  } else if (winRate >= 55) {
    return { bonus: SCORES.PROVEN_WINNER_EDGE, tier: 'EDGE', winRate };
  }
  
  return { bonus: 0, tier: null, winRate };
}

// Check if event has already started based on date in title or slug
// Now properly handles same-day events based on typical start times
function hasEventStarted(title, slug, avgPrice) {
  const now = Date.now();
  
  // Calculate EST time (UTC - 5 hours)
  // Note: This doesn't account for DST but is close enough for our purposes
  const EST_OFFSET = -5 * 60 * 60 * 1000;
  const estNow = new Date(now + EST_OFFSET);
  const currentHourEST = estNow.getUTCHours();
  
  // Get today's date in EST as YYYY-MM-DD string
  const todayYear = estNow.getUTCFullYear();
  const todayMonth = estNow.getUTCMonth() + 1;
  const todayDay = estNow.getUTCDate();
  const todayStr = `${todayYear}-${String(todayMonth).padStart(2, '0')}-${String(todayDay).padStart(2, '0')}`;
  
  // If odds are VERY extreme (>95% or <5%), event is likely decided or in progress
  if (avgPrice > 0.95 || avgPrice < 0.05) {
    return true;
  }
  
  // Check if this looks like a sports event
  const lowerTitle = (title || '').toLowerCase();
  const lowerSlug = (slug || '').toLowerCase();
  const isSportsEvent = 
    lowerSlug.includes('nba-') || 
    lowerSlug.includes('nfl-') || 
    lowerSlug.includes('nhl-') || 
    lowerSlug.includes('mlb-') ||
    lowerSlug.includes('cbb-') ||
    lowerSlug.includes('cfb-') ||
    lowerSlug.includes('ucl-') ||
    lowerSlug.includes('ufc-') ||
    lowerTitle.includes(' vs ') ||
    lowerTitle.includes(' vs. ') ||
    lowerTitle.includes('spread:') ||
    lowerTitle.includes('o/u ') ||
    lowerTitle.includes('over/under');
  
  // Try to extract date from slug (format: 2026-01-22)
  const slugDateMatch = (slug || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (slugDateMatch) {
    const eventYear = parseInt(slugDateMatch[1]);
    const eventMonth = parseInt(slugDateMatch[2]) - 1; // 0-indexed
    const eventDay = parseInt(slugDateMatch[3]);
    
    // Compare just the date portions as strings (YYYY-MM-DD)
    const eventDateStr = `${eventYear}-${String(eventMonth + 1).padStart(2, '0')}-${String(eventDay).padStart(2, '0')}`;
    // todayStr is already computed at the top of the function
    
    // If event date is before today, it has definitely started/ended
    if (eventDateStr < todayStr) {
      return true;
    }
    
    // Same-day filtering for sports events
    if (eventDateStr === todayStr && isSportsEvent) {
      // Most sports events start in the evening
      // If it's after 11pm EST, most games are done or in progress
      if (currentHourEST >= 23) {
        return true;
      }
      // If odds are getting extreme on game day, likely in progress
      if (currentHourEST >= 19 && (avgPrice > 0.90 || avgPrice < 0.10)) {
        return true;
      }
    }
  }
  
  // Try to extract date from title (various formats)
  const titleText = title || '';
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 
                      'july', 'august', 'september', 'october', 'november', 'december',
                      'jan', 'feb', 'mar', 'apr', 'may', 'jun', 
                      'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  
  const titleDateMatch = titleText.toLowerCase().match(
    new RegExp(`(${monthNames.join('|')})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`, 'i')
  );
  
  if (titleDateMatch) {
    const monthStr = titleDateMatch[1].toLowerCase();
    const day = parseInt(titleDateMatch[2]);
    const year = titleDateMatch[3] ? parseInt(titleDateMatch[3]) : new Date().getFullYear();
    
    let month;
    const fullMonthIndex = monthNames.slice(0, 12).indexOf(monthStr);
    const shortMonthIndex = monthNames.slice(12).indexOf(monthStr);
    if (fullMonthIndex !== -1) {
      month = fullMonthIndex;
    } else if (shortMonthIndex !== -1) {
      month = shortMonthIndex;
    } else {
      return false;
    }
    
    const eventDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    // todayStr is already computed at the top of the function
    
    if (eventDateStr < todayStr) {
      return true;
    }
    
    if (eventDateStr === todayStr && isSportsEvent && currentHourEST >= 23) {
      return true;
    }
  }
  
  // Match "on 2026-01-21" format in title
  const isoDateMatch = titleText.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoDateMatch) {
    const eventDateStr = `${isoDateMatch[1]}-${isoDateMatch[2]}-${isoDateMatch[3]}`;
    if (eventDateStr < todayStr) {
      return true;
    }
    // REMOVED: Same-day time-based filtering
  }
  
  return false;
}

export default {
  // HTTP request handler
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    
    try {
      if (path === "/scan" || path === "/api/scan") {
        const hours = parseInt(url.searchParams.get("hours") || "48");
        const minScore = parseInt(url.searchParams.get("minScore") || "40");
        const result = await runScan(hours, minScore, env);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      if (path.startsWith("/wallet/") && path.includes("/positions")) {
        const address = path.split("/")[2];
        const result = await getWalletPositions(address);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      if (path.startsWith("/wallet/") && path.includes("/pnl")) {
        const address = path.split("/")[2];
        const result = await getWalletPnL(address);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Wallet win rate endpoint
      if (path.startsWith("/wallet/") && path.includes("/winrate")) {
        const address = path.split("/")[2];
        const result = await getWalletWinRate(address, env);
        if (result) {
          const bonus = getWinRateBonus(result);
          return new Response(JSON.stringify({
            ...result,
            scoreBonus: bonus.bonus,
            tier: bonus.tier
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ error: "Could not fetch wallet data" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      if (path.startsWith("/wallet/")) {
        const address = path.split("/").pop();
        const result = await getWalletDetails(address);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Send SMS alert endpoint
      if (path === "/send-alert" && request.method === "POST") {
        const body = await request.json();
        const result = await sendSMSAlert(body, env);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Debug endpoint - shows ALL signals and filtering stats
      if (path === "/debug" || path === "/debug-scan") {
        const hours = parseInt(url.searchParams.get("hours") || "24");
        const minScore = parseInt(url.searchParams.get("minScore") || "0"); // Default to 0 to see everything
        const result = await runScan(hours, minScore, env, true); // true = debug mode
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Test SMS endpoint (for verifying setup)
      if (path === "/test-sms") {
        const phone = url.searchParams.get("phone");
        if (!phone) {
          return new Response(JSON.stringify({ error: "Phone number required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        const result = await sendSMS(phone, "🚨 Polymarket Scanner test alert! Your SMS notifications are working.", env);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Subscribe to alerts endpoint (POST)
      if (path === "/alerts/subscribe" && request.method === "POST") {
        const body = await request.json();
        const result = await subscribeToAlerts(body, env);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Easy subscribe via GET (just use URL params)
      if (path === "/alerts/subscribe" && request.method === "GET") {
        const phone = url.searchParams.get("phone");
        const minScore = parseInt(url.searchParams.get("minScore") || "100");
        const minBet = parseInt(url.searchParams.get("minBet") || "20000");
        const categories = url.searchParams.get("categories")?.split(",") || ["all"];
        
        if (!phone) {
          return new Response(JSON.stringify({ error: "Phone number required. Use: /alerts/subscribe?phone=+1XXXXXXXXXX" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        const result = await subscribeToAlerts({ phone, minScore, minBet, categories }, env);
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Get alert subscribers (for admin)
      if (path === "/alerts/subscribers") {
        const subscribers = await getAlertSubscribers(env);
        return new Response(JSON.stringify(subscribers), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Clear cache endpoint (use after scoring changes)
      if (path === "/clear-cache") {
        if (env.SIGNALS_CACHE) {
          try {
            await env.SIGNALS_CACHE.delete("signals");
            return new Response(JSON.stringify({ 
              success: true, 
              message: "Cache cleared. Next scan will rebuild with fresh scores." 
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
          } catch (e) {
            return new Response(JSON.stringify({ success: false, error: e.message }), {
              status: 500,
              headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
          }
        }
        return new Response(JSON.stringify({ success: false, error: "No cache configured" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      if (path === "/health" || path === "/") {
        // Get cache stats
        let cacheStats = { signalCount: 0, oldestSignal: null, newestSignal: null };
        if (env.SIGNALS_CACHE) {
          try {
            const cached = await env.SIGNALS_CACHE.get("signals", { type: "json" });
            if (cached && Array.isArray(cached)) {
              cacheStats.signalCount = cached.length;
              if (cached.length > 0) {
                const sorted = cached.sort((a, b) => new Date(a.firstTradeTime) - new Date(b.firstTradeTime));
                cacheStats.oldestSignal = sorted[0]?.firstTradeTime;
                cacheStats.newestSignal = sorted[sorted.length - 1]?.firstTradeTime;
              }
            }
          } catch (e) {}
        }
        
        return new Response(JSON.stringify({
          status: "ok",
          timestamp: new Date().toISOString(),
          version: "14.0.0 - Balanced scoring + debug endpoint",
          cache: cacheStats
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        error: error.message,
        stack: error.stack
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  },
  
  // Cron trigger handler - runs every 5 minutes
  async scheduled(event, env, ctx) {
    console.log("Cron triggered at:", new Date().toISOString());
    try {
      // Run scan with 48h window and low minScore to capture everything
      const result = await runScan(48, 30, env);
      console.log("Cron scan completed successfully");
      
      // Check for new high-value signals and send alerts
      if (result.success && result.signals && result.signals.length > 0) {
        // Only check signals that meet alert thresholds (score >= 100, bet >= $20k)
        const alertableSignals = result.signals.filter(s => s.score >= 100 && s.largestBet >= 20000);
        if (alertableSignals.length > 0) {
          await checkAndSendAlerts(alertableSignals, env);
          console.log(`Checked ${alertableSignals.length} signals for alerts`);
        }
      }
    } catch (error) {
      console.error("Cron scan failed:", error.message);
    }
  }
};

async function runScan(hoursBack, minScore, env, debugMode = false) {
  const now = Date.now();
  const cutoffTime = now - hoursBack * 60 * 60 * 1000;
  
  // Fetch fresh trades from API - INCREASED LIMIT from 2000 to 5000
  console.log("Fetching trades...");
  const tradesRes = await fetch(`${POLYMARKET_API}/trades?limit=5000`);
  if (!tradesRes.ok) throw new Error("Trades API error: " + tradesRes.status);
  const allTrades = await tradesRes.json();
  console.log(`Fetched ${allTrades.length} trades`);
  
  let debugCounts = {
    tooOld: 0,
    settlement: 0,
    tooSmall: 0,
    gamblingMarket: 0,
    passed: 0
  };
  
  const validTrades = allTrades.filter((t) => {
    const marketTitle = t.title || t.market || '';
    if (isShortTermGamblingMarket(marketTitle)) {
      debugCounts.gamblingMarket++;
      return false;
    }
    
    let tradeTime = t.timestamp;
    if (tradeTime && tradeTime < 1e10) {
      tradeTime = tradeTime * 1000;
    }
    if (!tradeTime || tradeTime < cutoffTime) {
      debugCounts.tooOld++;
      return false;
    }
    t._tradeTime = tradeTime;
    
    const price = parseFloat(t.price) || 0;
    if (price >= 0.99 || price <= 0.01) {
      debugCounts.settlement++;
      return false;
    }
    
    let usdValue = parseFloat(t.usd_value) || 0;
    if (!usdValue && t.size && t.price) {
      usdValue = parseFloat(t.size) * parseFloat(t.price);
    }
    t._usdValue = usdValue;
    
    if (usdValue < 10) {
      debugCounts.tooSmall++;
      return false;
    }
    
    debugCounts.passed++;
    return true;
  });
  
  console.log("Filter debug:", debugCounts);
  
  // Profile wallets - includes freshness AND win rate tracking
  const uniqueWallets = [...new Set(validTrades.map((t) => t.proxyWallet || t.user || t.maker))].slice(0, 100);
  const walletProfiles = {};
  const walletWinRates = {}; // Track win rates separately for top wallets
  
  // First pass: get basic wallet profiles (freshness)
  for (let i = 0; i < uniqueWallets.length; i += 10) {
    const batch = uniqueWallets.slice(i, i + 10);
    await Promise.all(batch.map(async (wallet) => {
      try {
        const res = await fetch(`${POLYMARKET_API}/activity?user=${wallet}&limit=20`);
        if (res.ok) {
          const activity = await res.json();
          walletProfiles[wallet] = {
            totalTrades: activity?.length || 0,
            isFresh: (activity?.length || 0) < 10,
            isVeryFresh: (activity?.length || 0) < 3
          };
        } else {
          walletProfiles[wallet] = { totalTrades: 0, isFresh: true, isVeryFresh: true };
        }
      } catch (e) {
        walletProfiles[wallet] = { totalTrades: 0, isFresh: true, isVeryFresh: true };
      }
    }));
  }
  
  // Second pass: get win rates for wallets with WHALE-SIZED bets ($50k+)
  // Only worth checking track record for serious money
  const whaleWallets = [];
  const walletLargestBet = {};
  validTrades.forEach(t => {
    const wallet = t.proxyWallet || t.user || t.maker;
    walletLargestBet[wallet] = Math.max(walletLargestBet[wallet] || 0, t._usdValue);
  });
  
  for (const [wallet, largestBet] of Object.entries(walletLargestBet)) {
    // Only check win rate for wallets placing $50k+ single bets
    if (largestBet >= 50000 && !walletProfiles[wallet]?.isFresh) {
      whaleWallets.push({ wallet, largestBet });
    }
  }
  
  // Sort by largest bet and check top whales
  whaleWallets.sort((a, b) => b.largestBet - a.largestBet);
  const walletsToCheck = whaleWallets.slice(0, 20).map(w => w.wallet);
  console.log(`Checking win rates for ${walletsToCheck.length} whale wallets ($50k+ bets)`);
  
  for (let i = 0; i < walletsToCheck.length; i += 5) {
    const batch = walletsToCheck.slice(i, i + 5);
    await Promise.all(batch.map(async (wallet) => {
      try {
        const winRateStats = await getWalletWinRate(wallet, env);
        if (winRateStats) {
          walletWinRates[wallet] = winRateStats;
        }
      } catch (e) {
        console.log(`Error fetching win rate for ${wallet}:`, e.message);
      }
    }));
  }
  
  console.log(`Fetched win rates for ${Object.keys(walletWinRates).length} wallets`);
  
  // Group trades by market+direction
  const groups = {};
  validTrades.forEach((t) => {
    const marketKey = t.slug || t.eventSlug || t.conditionId;
    const direction = t.side === "BUY" ? "YES" : "NO";
    const key = `${marketKey}:${direction}`;
    
    if (!groups[key]) {
      groups[key] = {
        marketKey,
        marketTitle: t.title || "Unknown Market",
        marketSlug: t.slug || t.eventSlug,
        marketIcon: t.icon,
        direction,
        trades: [],
        wallets: new Set(),
        totalVolume: 0,
        largestBet: 0,
        timestamps: []
      };
    }
    
    const wallet = t.proxyWallet || t.user || t.maker;
    groups[key].trades.push(t);
    groups[key].wallets.add(wallet);
    groups[key].totalVolume += t._usdValue;
    groups[key].largestBet = Math.max(groups[key].largestBet, t._usdValue);
    groups[key].timestamps.push(t._tradeTime);
  });
  
  console.log(`Groups to analyze: ${Object.keys(groups).length}`);
  
  // Score each group and create signals
  const newSignals = [];
  
  for (const [key, g] of Object.entries(groups)) {
    if (isShortTermGamblingMarket(g.marketTitle)) {
      continue;
    }
    
    let score = 0;
    const breakdown = {};
    const numWallets = g.wallets.size;
    const avgBetPerWallet = g.totalVolume / numWallets;
    
    // Calculate wallet volume distribution for concentration scoring
    const walletVolumes = {};
    let largestFreshWalletBet = 0;
    let freshWalletCount = 0;
    let freshWalletVolume = 0;
    
    g.trades.forEach((t) => {
      const wallet = t.proxyWallet || t.user || t.maker;
      walletVolumes[wallet] = (walletVolumes[wallet] || 0) + t._usdValue;
      
      const profile = walletProfiles[wallet];
      if (profile?.isFresh) {
        freshWalletCount++;
        freshWalletVolume += t._usdValue;
        largestFreshWalletBet = Math.max(largestFreshWalletBet, t._usdValue);
      }
    });
    
    // Sort wallets by volume and get individual bet sizes
    const walletVolumeEntries = Object.entries(walletVolumes).sort((a, b) => b[1] - a[1]);
    const sortedWalletVolumes = walletVolumeEntries.map(e => e[1]);
    const topWalletVolume = sortedWalletVolumes[0] || 0;
    const secondWalletVolume = sortedWalletVolumes[1] || 0;
    const top2WalletsVolume = sortedWalletVolumes.slice(0, 2).reduce((a, b) => a + b, 0);
    
    // Check if largest bet is from a fresh wallet (for either/or logic)
    const isLargestBetFresh = largestFreshWalletBet >= g.largestBet * 0.95; // Within 5%
    
    // ============================================
    // WHALE BET SIZE OR FRESH WALLET (one or the other, not both)
    // ============================================
    if (isLargestBetFresh && largestFreshWalletBet >= 50000) {
      // Fresh wallet with huge bet - use fresh wallet scoring (higher value)
      score += SCORES.FRESH_WHALE_HUGE;
      breakdown[`🚨 Fresh wallet WHALE ($${Math.round(largestFreshWalletBet / 1000)}k bet)`] = SCORES.FRESH_WHALE_HUGE;
    } else if (isLargestBetFresh && largestFreshWalletBet >= 25000) {
      score += SCORES.FRESH_WHALE_LARGE;
      breakdown[`🚨 Fresh wallet whale ($${Math.round(largestFreshWalletBet / 1000)}k bet)`] = SCORES.FRESH_WHALE_LARGE;
    } else if (isLargestBetFresh && largestFreshWalletBet >= 10000) {
      score += SCORES.FRESH_WHALE_NOTABLE;
      breakdown[`⚠️ Fresh wallet bet ($${Math.round(largestFreshWalletBet / 1000)}k)`] = SCORES.FRESH_WHALE_NOTABLE;
    } else if (isLargestBetFresh && largestFreshWalletBet >= 5000) {
      score += SCORES.FRESH_WHALE_MEDIUM;
      breakdown[`Fresh wallet ($${Math.round(largestFreshWalletBet / 1000)}k)`] = SCORES.FRESH_WHALE_MEDIUM;
    } else if (g.largestBet >= 75000) {
      // Not fresh - use regular whale scoring
      score += SCORES.WHALE_BET_MASSIVE;
      breakdown[`🐋 Massive whale bet ($${Math.round(g.largestBet / 1000)}k)`] = SCORES.WHALE_BET_MASSIVE;
    } else if (g.largestBet >= 30000) {
      score += SCORES.WHALE_BET_LARGE;
      breakdown[`🐋 Large whale bet ($${Math.round(g.largestBet / 1000)}k)`] = SCORES.WHALE_BET_LARGE;
    } else if (g.largestBet >= 15000) {
      score += SCORES.WHALE_BET_NOTABLE;
      breakdown[`🐋 Notable whale bet ($${Math.round(g.largestBet / 1000)}k)`] = SCORES.WHALE_BET_NOTABLE;
    } else if (g.largestBet >= 8000) {
      score += SCORES.WHALE_BET_MEDIUM;
      breakdown[`Whale bet ($${Math.round(g.largestBet / 1000)}k)`] = SCORES.WHALE_BET_MEDIUM;
    }
    
    // ============================================
    // CONCENTRATION (whale-sized AND concentrated)
    // ============================================
    const topWalletPct = topWalletVolume / g.totalVolume;
    const top2Pct = top2WalletsVolume / g.totalVolume;
    
    // Single whale concentration: 1 wallet has >80% AND that wallet bet $15k+
    if (numWallets <= 2 && topWalletPct >= 0.80 && topWalletVolume >= 15000) {
      score += SCORES.CONCENTRATION_SINGLE_WHALE;
      breakdown[`🎯 Concentrated whale (${Math.round(topWalletPct * 100)}% from 1 wallet)`] = SCORES.CONCENTRATION_SINGLE_WHALE;
    } 
    // Whale duo: 2 wallets have >80% AND both bet $8k+
    else if (numWallets === 2 && top2Pct >= 0.80 && topWalletVolume >= 8000 && secondWalletVolume >= 8000) {
      score += SCORES.CONCENTRATION_WHALE_DUO;
      breakdown[`🎯 Whale duo (2 wallets, both $8k+)`] = SCORES.CONCENTRATION_WHALE_DUO;
    }
    // High concentration with decent bet
    else if (topWalletPct >= 0.60 && topWalletVolume >= 10000) {
      score += SCORES.CONCENTRATION_HIGH;
      breakdown[`🎯 High concentration (${Math.round(topWalletPct * 100)}% from top wallet)`] = SCORES.CONCENTRATION_HIGH;
    }
    
    // ============================================
    // PROVEN WINNER WALLET (track record - THE HOLY GRAIL)
    // ============================================
    let bestWinRateBonus = { bonus: 0, tier: null };
    let bestWinRateWallet = null;
    const provenWinners = [];
    
    // Check win rates for wallets in this signal
    for (const wallet of g.wallets) {
      const winRateStats = walletWinRates[wallet];
      if (winRateStats) {
        const winRateBonus = getWinRateBonus(winRateStats);
        if (winRateBonus.bonus > 0) {
          provenWinners.push({
            wallet,
            winRate: winRateStats.winRate,
            totalBets: winRateStats.totalResolved,
            tier: winRateBonus.tier
          });
          if (winRateBonus.bonus > bestWinRateBonus.bonus) {
            bestWinRateBonus = winRateBonus;
            bestWinRateWallet = wallet;
          }
        }
      }
    }
    
    if (bestWinRateBonus.bonus > 0) {
      score += bestWinRateBonus.bonus;
      const tierEmoji = bestWinRateBonus.tier === 'ELITE' ? '🏆' : 
                        bestWinRateBonus.tier === 'STRONG' ? '⭐' : 
                        bestWinRateBonus.tier === 'GOOD' ? '✅' : '📈';
      breakdown[`${tierEmoji} Proven winner (${bestWinRateBonus.winRate}% win rate)`] = bestWinRateBonus.bonus;
      
      // Extra bonus if whale bet comes from proven winner
      if (g.largestBet >= 15000 && bestWinRateBonus.tier) {
        score += SCORES.WHALE_PROVEN_WINNER;
        breakdown[`💎 Whale + proven winner combo`] = SCORES.WHALE_PROVEN_WINNER;
      }
    }
    
    // ============================================
    // COORDINATED (only valuable if bets are large)
    // ============================================
    if (numWallets >= 3 && g.timestamps.length >= 3) {
      const sortedTimes = [...g.timestamps].sort((a, b) => a - b);
      const timeSpan = sortedTimes[sortedTimes.length - 1] - sortedTimes[0];
      const twoHours = 2 * 60 * 60 * 1000;
      
      if (timeSpan <= twoHours) {
        // Check if ALL wallets are whales, not just average
        const minBetInGroup = Math.min(...sortedWalletVolumes.slice(0, numWallets));
        
        if (minBetInGroup >= 8000) {
          // ALL wallets bet $8k+ = real coordinated whales
          score += SCORES.COORDINATED_WHALES;
          breakdown[`🔗 Coordinated whales (${numWallets} wallets, ALL $8k+)`] = SCORES.COORDINATED_WHALES;
        } else if (minBetInGroup >= 3000) {
          // ALL wallets bet $3k+ = coordinated large
          score += SCORES.COORDINATED_LARGE;
          breakdown[`Coordinated (${numWallets} wallets, ALL $3k+)`] = SCORES.COORDINATED_LARGE;
        }
      }
    }
    
    // ============================================
    // VOLUME
    // ============================================
    if (g.totalVolume >= 150000) {
      score += SCORES.VOLUME_MASSIVE;
      breakdown[`Volume >$150k`] = SCORES.VOLUME_MASSIVE;
    } else if (g.totalVolume >= 75000) {
      score += SCORES.VOLUME_LARGE;
      breakdown[`Volume >$75k`] = SCORES.VOLUME_LARGE;
    } else if (g.totalVolume >= 40000) {
      score += SCORES.VOLUME_NOTABLE;
      breakdown[`Volume >$40k`] = SCORES.VOLUME_NOTABLE;
    }
    
    // ============================================
    // RAPID ACCUMULATION
    // ============================================
    const sortedTimes = [...g.timestamps].sort((a, b) => a - b);
    const timeSpan = sortedTimes[sortedTimes.length - 1] - sortedTimes[0];
    const thirtyMinutes = 30 * 60 * 1000;
    
    if (timeSpan <= thirtyMinutes && g.totalVolume >= 25000) {
      score += SCORES.RAPID_ACCUMULATION;
      breakdown[`Rapid accumulation ($${Math.round(g.totalVolume / 1000)}k in ${Math.round(timeSpan / 60000)}min)`] = SCORES.RAPID_ACCUMULATION;
    }
    
    // ============================================
    // MARKET TYPE (minor factor)
    // ============================================
    const marketText = (g.marketTitle || "").toLowerCase();
    if (POLITICAL_KEYWORDS.some((k) => marketText.includes(k))) {
      score += SCORES.POLITICAL;
      breakdown["Political market"] = SCORES.POLITICAL;
    } else if (SPORTS_KEYWORDS.some((k) => marketText.includes(k))) {
      score += SCORES.SPORTS;
      breakdown["Sports market"] = SCORES.SPORTS;
    } else if (CRYPTO_KEYWORDS.some((k) => marketText.includes(k))) {
      score += SCORES.CRYPTO;
      breakdown["Crypto market"] = SCORES.CRYPTO;
    }
    
    // ============================================
    // EXTREME ODDS (betting on long shots)
    // ============================================
    const avgPrice = g.trades.reduce((sum, t) => sum + parseFloat(t.price || 0), 0) / g.trades.length;
    if ((avgPrice < 0.20 || avgPrice > 0.80) && g.largestBet >= 5000) {
      score += SCORES.EXTREME_ODDS;
      breakdown[`Extreme odds bet (${Math.round(avgPrice * 100)}%)`] = SCORES.EXTREME_ODDS;
    }
    
    // ============================================
    // LAST-MINUTE WHALE (urgent insider info)
    // Only for $15k+ bets close to event
    // ============================================
    const eventDate = getEventDate(g.marketTitle, g.marketSlug);
    if (eventDate && g.largestBet >= 15000) {
      const lastTradeTimestamp = Math.max(...g.timestamps);
      const hoursUntilEvent = (eventDate.getTime() - lastTradeTimestamp) / (1000 * 60 * 60);
      
      // Only apply if event is in the future
      if (hoursUntilEvent > 0 && hoursUntilEvent <= 12) {
        if (hoursUntilEvent <= 2) {
          score += SCORES.LAST_MINUTE_WHALE_2H;
          breakdown[`⏰ Last-minute whale (${hoursUntilEvent.toFixed(1)}h before)`] = SCORES.LAST_MINUTE_WHALE_2H;
        } else if (hoursUntilEvent <= 6) {
          score += SCORES.LAST_MINUTE_WHALE_6H;
          breakdown[`⏰ Pre-event whale (${hoursUntilEvent.toFixed(1)}h before)`] = SCORES.LAST_MINUTE_WHALE_6H;
        } else if (hoursUntilEvent <= 12) {
          score += SCORES.LAST_MINUTE_WHALE_12H;
          breakdown[`⏰ Same-day whale (${hoursUntilEvent.toFixed(1)}h before)`] = SCORES.LAST_MINUTE_WHALE_12H;
        }
      }
    }
    
    // Skip events that have already started
    if (hasEventStarted(g.marketTitle, g.marketSlug, avgPrice)) {
      continue;
    }
    
    // Store signals with score >= 15 (lowered threshold to catch more signals)
    if (score >= 15) {
      const sortedTimes = [...g.timestamps].sort((a, b) => a - b);
      const firstTradeTime = new Date(sortedTimes[0]);
      const lastTradeTime = new Date(sortedTimes[sortedTimes.length - 1]);
      const avgEntry = Math.round(avgPrice * 100);
      
      // Calculate hours until event for display
      const eventDateForSignal = getEventDate(g.marketTitle, g.marketSlug);
      let hoursUntilEvent = null;
      if (eventDateForSignal) {
        hoursUntilEvent = Math.round((eventDateForSignal.getTime() - Date.now()) / (1000 * 60 * 60) * 10) / 10;
        if (hoursUntilEvent < 0) hoursUntilEvent = null; // Event passed
      }
      
      const signal = {
        id: `${g.marketSlug}:${g.direction}:${sortedTimes[0]}`,
        marketTitle: g.marketTitle,
        marketSlug: g.marketSlug,
        marketUrl: `https://polymarket.com/market/${g.marketSlug}`,
        marketIcon: g.marketIcon,
        direction: g.direction,
        currentPrice: avgEntry,
        avgEntryPrice: avgEntry,
        suspiciousVolume: Math.round(g.totalVolume),
        numWallets,
        numTrades: g.trades.length,
        largestBet: Math.round(g.largestBet),
        freshWallets: freshWalletCount,
        score,
        scoreBreakdown: breakdown,
        firstTradeTime: firstTradeTime.toISOString(),
        lastTradeTime: lastTradeTime.toISOString(),
        eventDate: eventDateForSignal ? eventDateForSignal.toISOString() : null,
        hoursUntilEvent: hoursUntilEvent,
        provenWinners: provenWinners.length > 0 ? provenWinners : null,
        bestWinRate: bestWinRateBonus.winRate || null,
        detectedAt: new Date().toISOString(),
        topTrades: g.trades.sort((a, b) => b._usdValue - a._usdValue).slice(0, 5).map((t) => {
          const wallet = t.proxyWallet || t.user || t.maker;
          const profile = walletProfiles[wallet];
          const winRateStats = walletWinRates[wallet];
          return {
            wallet: wallet || "",
            amount: Math.round(t._usdValue),
            price: Math.round(parseFloat(t.price || 0) * 100),
            time: new Date(t._tradeTime).toISOString(),
            isFresh: profile?.isFresh || false,
            winRate: winRateStats?.meetsMinimum ? winRateStats.winRate : null,
            totalBets: winRateStats?.totalResolved || null
          };
        })
      };
      
      newSignals.push(signal);
    }
  }
  
  // Load cached signals from KV
  let cachedSignals = [];
  if (env.SIGNALS_CACHE) {
    try {
      const cached = await env.SIGNALS_CACHE.get("signals", { type: "json" });
      if (cached && Array.isArray(cached)) {
        cachedSignals = cached;
      }
    } catch (e) {
      console.log("KV read error:", e.message);
    }
  }
  
  // Merge new signals with cached ones
  const signalMap = new Map();
  
  // Add cached signals first
  cachedSignals.forEach(s => {
    signalMap.set(s.id, s);
  });
  
  // Update/add new signals (new signals take priority)
  newSignals.forEach(s => {
    const existing = signalMap.get(s.id);
    if (!existing || s.score > existing.score || s.suspiciousVolume > existing.suspiciousVolume) {
      signalMap.set(s.id, s);
    }
  });
  
  // Convert back to array
  let allSignals = Array.from(signalMap.values());
  
  // Filter out signals older than 7 days
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  allSignals = allSignals.filter(s => {
    const signalTime = new Date(s.firstTradeTime).getTime();
    return (now - signalTime) < maxAge;
  });
  
  // Save merged signals back to KV
  if (env.SIGNALS_CACHE) {
    try {
      await env.SIGNALS_CACHE.put("signals", JSON.stringify(allSignals), {
        expirationTtl: 60 * 60 * 24 * 7 // 7 days
      });
      console.log(`Saved ${allSignals.length} signals to KV`);
    } catch (e) {
      console.log("KV write error:", e.message);
    }
  }
  
  // Filter by requested time window
  const filteredSignals = allSignals.filter(s => {
    const signalTime = new Date(s.firstTradeTime).getTime();
    return signalTime >= cutoffTime;
  });
  
  // Filter out events that have already started (check cached signals too)
  // Using less aggressive hasEventStarted now
  const activeSignals = filteredSignals.filter(s => {
    return !hasEventStarted(s.marketTitle, s.marketSlug, s.avgEntryPrice / 100);
  });
  
  // Filter by min score and sort
  const finalSignals = activeSignals
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score);
  
  // In debug mode, include all signals before score filtering
  const debugAllSignals = debugMode ? activeSignals.sort((a, b) => b.score - a.score).map(s => ({
    market: s.marketTitle,
    score: s.score,
    largestBet: s.largestBet,
    volume: s.suspiciousVolume,
    numWallets: s.numWallets,
    freshWallets: s.freshWallets,
    breakdown: s.scoreBreakdown,
    filteredOut: s.score < minScore ? `Score ${s.score} < minScore ${minScore}` : null
  })) : null;
  
  // Score distribution for debug
  const scoreDistribution = debugMode ? {
    '100+': activeSignals.filter(s => s.score >= 100).length,
    '80-99': activeSignals.filter(s => s.score >= 80 && s.score < 100).length,
    '60-79': activeSignals.filter(s => s.score >= 60 && s.score < 80).length,
    '40-59': activeSignals.filter(s => s.score >= 40 && s.score < 60).length,
    '20-39': activeSignals.filter(s => s.score >= 20 && s.score < 40).length,
    '1-19': activeSignals.filter(s => s.score >= 1 && s.score < 20).length,
    '0': activeSignals.filter(s => s.score === 0).length
  } : null;
  
  // REMOVED: .slice(0, 50) - now returns ALL signals
  return {
    success: true,
    scanTime: new Date().toISOString(),
    hoursScanned: hoursBack,
    totalSignals: finalSignals.length,
    criticalCount: finalSignals.filter((s) => s.score >= 100).length,
    highRiskCount: finalSignals.filter((s) => s.score >= 80 && s.score < 100).length,
    mediumRiskCount: finalSignals.filter((s) => s.score >= 60 && s.score < 80).length,
    totalSuspiciousVolume: finalSignals.reduce((sum, s) => sum + s.suspiciousVolume, 0),
    signals: finalSignals,
    _debug: {
      filterCounts: debugCounts,
      cutoffTime: new Date(cutoffTime).toISOString(),
      currentTime: new Date(now).toISOString(),
      totalTradesFetched: allTrades.length,
      validTradesCount: validTrades.length,
      groupsAnalyzed: Object.keys(groups).length,
      walletsProfiled: Object.keys(walletProfiles).length,
      cachedSignalsCount: cachedSignals.length,
      newSignalsCount: newSignals.length,
      mergedSignalsCount: allSignals.length,
      filteredByTimeWindow: filteredSignals.length,
      afterEventStartedFilter: activeSignals.length,
      ...(debugMode && { 
        scoreDistribution, 
        allSignalsBeforeScoreFilter: debugAllSignals,
        minScoreUsed: minScore
      })
    }
  };
}

async function getWalletDetails(address) {
  try {
    // Fetch activity with more results
    const res = await fetch(`${POLYMARKET_API}/activity?user=${address}&limit=500`);
    if (!res.ok) throw new Error("Wallet API error: " + res.status);
    const activity = await res.json();
    
    if (!activity || activity.length === 0) {
      return {
        success: true,
        profile: { totalTrades: 0, isFresh: true, totalVolume: 0 },
        recentActivity: []
      };
    }
    
    // Filter to only TRADE types (not SPLIT, MERGE, REDEEM, etc.)
    const trades = activity.filter(t => t.type === 'TRADE');
    
    // Calculate total volume using usdcSize (the correct field from API)
    const totalVolume = trades.reduce((sum, t) => sum + (parseFloat(t.usdcSize) || 0), 0);
    
    // Get first seen date (oldest trade)
    const sortedByTime = [...trades].sort((a, b) => a.timestamp - b.timestamp);
    const firstSeen = sortedByTime.length > 0 ? sortedByTime[0].timestamp : null;
    
    // Format timestamp properly
    const formatTimestamp = (ts) => {
      if (!ts) return null;
      // If timestamp is in seconds, convert to milliseconds
      const msTimestamp = ts < 1e12 ? ts * 1000 : ts;
      return new Date(msTimestamp).toISOString();
    };
    
    return {
      success: true,
      profile: {
        address: address,
        totalTrades: trades.length,
        isFresh: trades.length < 10,
        isVeryFresh: trades.length < 3,
        totalVolume: Math.round(totalVolume),
        firstSeen: formatTimestamp(firstSeen)
      },
      recentActivity: trades.slice(0, 50).map((t) => ({
        market: t.title || t.slug || 'Unknown Market',
        marketSlug: t.slug,
        eventSlug: t.eventSlug,
        marketUrl: t.slug ? `https://polymarket.com/market/${t.slug}` : null,
        side: t.side,
        outcome: t.outcome,
        amount: Math.round(parseFloat(t.usdcSize) || 0),
        size: parseFloat(t.size) || 0,
        price: Math.round((parseFloat(t.price) || 0) * 100),
        time: formatTimestamp(t.timestamp),
        transactionHash: t.transactionHash,
        icon: t.icon
      }))
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Get current open positions for a wallet
async function getWalletPositions(address) {
  try {
    const res = await fetch(`${POLYMARKET_API}/positions?user=${address}`);
    if (!res.ok) throw new Error("Positions API error: " + res.status);
    const positions = await res.json();
    
    if (!positions || positions.length === 0) {
      return {
        success: true,
        totalPositions: 0,
        totalValue: 0,
        positions: []
      };
    }
    
    // Calculate total current value
    const totalValue = positions.reduce((sum, p) => {
      const value = parseFloat(p.currentValue) || parseFloat(p.value) || 0;
      return sum + value;
    }, 0);
    
    return {
      success: true,
      totalPositions: positions.length,
      totalValue: Math.round(totalValue),
      positions: positions.map(p => ({
        market: p.title || p.market || 'Unknown',
        marketSlug: p.slug,
        marketUrl: p.slug ? `https://polymarket.com/market/${p.slug}` : null,
        outcome: p.outcome,
        size: parseFloat(p.size) || 0,
        avgPrice: Math.round((parseFloat(p.avgPrice) || 0) * 100),
        currentPrice: Math.round((parseFloat(p.curPrice) || parseFloat(p.currentPrice) || 0) * 100),
        initialValue: Math.round(parseFloat(p.initialValue) || 0),
        currentValue: Math.round(parseFloat(p.currentValue) || parseFloat(p.value) || 0),
        pnl: Math.round((parseFloat(p.currentValue) || 0) - (parseFloat(p.initialValue) || 0)),
        pnlPercent: parseFloat(p.initialValue) > 0 
          ? Math.round(((parseFloat(p.currentValue) - parseFloat(p.initialValue)) / parseFloat(p.initialValue)) * 100)
          : 0,
        icon: p.icon
      }))
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Get closed positions (resolved bets) and calculate PnL
async function getWalletPnL(address) {
  try {
    // Fetch closed/resolved positions
    const closedRes = await fetch(`${POLYMARKET_API}/positions?user=${address}&status=closed`);
    const openRes = await fetch(`${POLYMARKET_API}/positions?user=${address}`);
    const activityRes = await fetch(`${POLYMARKET_API}/activity?user=${address}&limit=500&type=REDEEM`);
    
    let closedPositions = [];
    let openPositions = [];
    let redeems = [];
    
    if (closedRes.ok) {
      closedPositions = await closedRes.json() || [];
    }
    if (openRes.ok) {
      openPositions = await openRes.json() || [];
    }
    if (activityRes.ok) {
      redeems = await activityRes.json() || [];
    }
    
    // Calculate realized PnL from redeems (winning bets that were cashed out)
    let realizedPnL = 0;
    let wins = 0;
    let losses = 0;
    
    const resolvedBets = [];
    
    // Process redeems as wins
    redeems.forEach(r => {
      const payout = parseFloat(r.usdcSize) || 0;
      if (payout > 0) {
        realizedPnL += payout;
        wins++;
        resolvedBets.push({
          market: r.title || r.slug || 'Unknown',
          marketSlug: r.slug,
          outcome: r.outcome,
          result: 'WIN',
          payout: Math.round(payout),
          time: r.timestamp < 1e12 ? new Date(r.timestamp * 1000).toISOString() : new Date(r.timestamp).toISOString(),
          icon: r.icon
        });
      }
    });
    
    // Calculate unrealized PnL from open positions
    let unrealizedPnL = 0;
    openPositions.forEach(p => {
      const initial = parseFloat(p.initialValue) || 0;
      const current = parseFloat(p.currentValue) || parseFloat(p.value) || 0;
      unrealizedPnL += (current - initial);
    });
    
    // Get total invested from activity
    const buyActivityRes = await fetch(`${POLYMARKET_API}/activity?user=${address}&limit=500&side=BUY`);
    let totalInvested = 0;
    if (buyActivityRes.ok) {
      const buys = await buyActivityRes.json() || [];
      totalInvested = buys.reduce((sum, b) => sum + (parseFloat(b.usdcSize) || 0), 0);
    }
    
    return {
      success: true,
      summary: {
        totalInvested: Math.round(totalInvested),
        realizedPnL: Math.round(realizedPnL),
        unrealizedPnL: Math.round(unrealizedPnL),
        totalPnL: Math.round(realizedPnL + unrealizedPnL),
        winRate: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0,
        wins,
        losses,
        openPositions: openPositions.length
      },
      resolvedBets: resolvedBets.slice(0, 50),
      openPositions: openPositions.slice(0, 20).map(p => ({
        market: p.title || p.market || 'Unknown',
        marketSlug: p.slug,
        outcome: p.outcome,
        avgPrice: Math.round((parseFloat(p.avgPrice) || 0) * 100),
        currentPrice: Math.round((parseFloat(p.curPrice) || parseFloat(p.currentPrice) || 0) * 100),
        size: parseFloat(p.size) || 0,
        initialValue: Math.round(parseFloat(p.initialValue) || 0),
        currentValue: Math.round(parseFloat(p.currentValue) || parseFloat(p.value) || 0),
        pnl: Math.round((parseFloat(p.currentValue) || 0) - (parseFloat(p.initialValue) || 0)),
        icon: p.icon
      }))
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Send SMS via Twilio
async function sendSMS(to, message, env) {
  const accountSid = env.TWILIO_SID;
  const authToken = env.TWILIO_AUTH;
  const fromPhone = env.TWILIO_PHONE;
  
  if (!accountSid || !authToken || !fromPhone) {
    return { success: false, error: "Twilio credentials not configured" };
  }
  
  // Ensure phone has + prefix
  const toPhone = to.startsWith('+') ? to : `+1${to.replace(/\D/g, '')}`;
  
  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${accountSid}:${authToken}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: toPhone,
          From: fromPhone,
          Body: message,
        }),
      }
    );
    
    const result = await response.json();
    
    if (response.ok) {
      return { success: true, messageId: result.sid };
    } else {
      return { success: false, error: result.message || 'Failed to send SMS' };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Send alert for a specific signal
async function sendSMSAlert(data, env) {
  const { phone, signal } = data;
  
  if (!phone || !signal) {
    return { success: false, error: "Phone and signal required" };
  }
  
  const message = `🚨 POLYMARKET ALERT

${signal.marketTitle}

💰 Volume: $${signal.suspiciousVolume.toLocaleString()}
🎯 Largest Bet: $${signal.largestBet.toLocaleString()}
📊 Score: ${signal.score}
${signal.direction}: ${signal.avgEntryPrice}%

🔗 polymarket.com/market/${signal.marketSlug}`;

  return await sendSMS(phone, message, env);
}

// Subscribe a user to alerts (stores in KV)
async function subscribeToAlerts(data, env) {
  const { phone, email, minScore = 100, minBet = 10000, categories = ['all'] } = data;
  
  if (!phone) {
    return { success: false, error: "Phone number required" };
  }
  
  // Get existing subscribers
  let subscribers = [];
  if (env.SIGNALS_CACHE) {
    try {
      const existing = await env.SIGNALS_CACHE.get("alert_subscribers", { type: "json" });
      if (existing && Array.isArray(existing)) {
        subscribers = existing;
      }
    } catch (e) {}
  }
  
  // Check if already subscribed
  const existingIndex = subscribers.findIndex(s => s.phone === phone);
  
  const subscriber = {
    phone,
    email: email || null,
    minScore,
    minBet,
    categories,
    subscribedAt: new Date().toISOString(),
    active: true
  };
  
  if (existingIndex >= 0) {
    subscribers[existingIndex] = { ...subscribers[existingIndex], ...subscriber };
  } else {
    subscribers.push(subscriber);
  }
  
  // Save back to KV
  if (env.SIGNALS_CACHE) {
    await env.SIGNALS_CACHE.put("alert_subscribers", JSON.stringify(subscribers));
  }
  
  return { success: true, message: "Subscribed to alerts", subscriber };
}

// Get all alert subscribers
async function getAlertSubscribers(env) {
  if (!env.SIGNALS_CACHE) {
    return { success: false, error: "Cache not available" };
  }
  
  try {
    const subscribers = await env.SIGNALS_CACHE.get("alert_subscribers", { type: "json" });
    return { success: true, subscribers: subscribers || [] };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Check and send alerts for new signals (called during cron)
async function checkAndSendAlerts(signals, env) {
  if (!env.SIGNALS_CACHE) return;
  
  // Get subscribers
  let subscribers = [];
  try {
    const existing = await env.SIGNALS_CACHE.get("alert_subscribers", { type: "json" });
    if (existing && Array.isArray(existing)) {
      subscribers = existing.filter(s => s.active);
    }
  } catch (e) {
    return;
  }
  
  if (subscribers.length === 0) return;
  
  // Get already-alerted signal IDs
  let alertedSignals = [];
  try {
    const alerted = await env.SIGNALS_CACHE.get("alerted_signals", { type: "json" });
    if (alerted && Array.isArray(alerted)) {
      alertedSignals = alerted;
    }
  } catch (e) {}
  
  const newAlerted = [...alertedSignals];
  
  for (const signal of signals) {
    // Skip if already alerted
    if (alertedSignals.includes(signal.id)) continue;
    
    // Determine signal category
    const title = (signal.marketTitle || '').toLowerCase();
    let category = 'other';
    if (SPORTS_KEYWORDS.some(k => title.includes(k)) || title.includes(' vs ')) {
      category = 'sports';
    } else if (POLITICAL_KEYWORDS.some(k => title.includes(k))) {
      category = 'politics';
    } else if (CRYPTO_KEYWORDS.some(k => title.includes(k))) {
      category = 'crypto';
    }
    
    // Check each subscriber
    for (const sub of subscribers) {
      // Check thresholds
      if (signal.score < sub.minScore) continue;
      if (signal.largestBet < sub.minBet) continue;
      
      // Check category
      if (!sub.categories.includes('all') && !sub.categories.includes(category)) continue;
      
      // Send alert
      await sendSMSAlert({ phone: sub.phone, signal }, env);
      
      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 100));
    }
    
    // Mark as alerted
    newAlerted.push(signal.id);
  }
  
  // Save alerted signals (keep last 1000 to prevent unbounded growth)
  const trimmedAlerted = newAlerted.slice(-1000);
  await env.SIGNALS_CACHE.put("alerted_signals", JSON.stringify(trimmedAlerted));
}

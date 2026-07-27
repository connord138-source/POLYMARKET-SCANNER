// src/index.js

// ============================================================
// THE ODDS API INTEGRATION
// For accurate sports settlement and Vegas odds comparison
// ============================================================

var ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// Sport key mapping: Polymarket slug patterns -> The Odds API sport keys
var SPORT_KEY_MAP = {
  'nfl': 'americanfootball_nfl',
  'nba': 'basketball_nba',
  'mlb': 'baseball_mlb',
  'nhl': 'icehockey_nhl',
  'ncaaf': 'americanfootball_ncaaf',
  'ncaab': 'basketball_ncaab',
  'mma': 'mma_mixed_martial_arts',
  'ufc': 'mma_mixed_martial_arts',
  'epl': 'soccer_epl',
  'ucl': 'soccer_uefa_champions_league',
  'mls': 'soccer_usa_mls',
  'wta': 'tennis_wta_australian_open',
  'atp': 'tennis_atp_australian_open',
  'lol': null, // LoL esports not supported
  'csgo': null, // CS:GO not supported
};

// Team name normalization for matching
var TEAM_ALIASES = {
  // NFL
  'patriots': 'New England Patriots', 'ne': 'New England Patriots',
  'broncos': 'Denver Broncos', 'den': 'Denver Broncos',
  'chiefs': 'Kansas City Chiefs', 'kc': 'Kansas City Chiefs',
  'bills': 'Buffalo Bills', 'buf': 'Buffalo Bills',
  'dolphins': 'Miami Dolphins', 'mia': 'Miami Dolphins',
  'jets': 'New York Jets', 'nyj': 'New York Jets',
  'ravens': 'Baltimore Ravens', 'bal': 'Baltimore Ravens',
  'steelers': 'Pittsburgh Steelers', 'pit': 'Pittsburgh Steelers',
  'bengals': 'Cincinnati Bengals', 'cin': 'Cincinnati Bengals',
  'browns': 'Cleveland Browns', 'cle': 'Cleveland Browns',
  'texans': 'Houston Texans', 'hou': 'Houston Texans',
  'colts': 'Indianapolis Colts', 'ind': 'Indianapolis Colts',
  'jaguars': 'Jacksonville Jaguars', 'jax': 'Jacksonville Jaguars',
  'titans': 'Tennessee Titans', 'ten': 'Tennessee Titans',
  'cowboys': 'Dallas Cowboys', 'dal': 'Dallas Cowboys',
  'eagles': 'Philadelphia Eagles', 'phi': 'Philadelphia Eagles',
  'giants': 'New York Giants', 'nyg': 'New York Giants',
  'commanders': 'Washington Commanders', 'was': 'Washington Commanders',
  'bears': 'Chicago Bears', 'chi': 'Chicago Bears',
  'lions': 'Detroit Lions', 'det': 'Detroit Lions',
  'packers': 'Green Bay Packers', 'gb': 'Green Bay Packers',
  'vikings': 'Minnesota Vikings', 'min': 'Minnesota Vikings',
  'falcons': 'Atlanta Falcons', 'atl': 'Atlanta Falcons',
  'panthers': 'Carolina Panthers', 'car': 'Carolina Panthers',
  'saints': 'New Orleans Saints', 'no': 'New Orleans Saints',
  'buccaneers': 'Tampa Bay Buccaneers', 'tb': 'Tampa Bay Buccaneers',
  'cardinals': 'Arizona Cardinals', 'ari': 'Arizona Cardinals',
  '49ers': 'San Francisco 49ers', 'sf': 'San Francisco 49ers',
  'seahawks': 'Seattle Seahawks', 'sea': 'Seattle Seahawks',
  'rams': 'Los Angeles Rams', 'lar': 'Los Angeles Rams', 'la': 'Los Angeles Rams',
  'chargers': 'Los Angeles Chargers', 'lac': 'Los Angeles Chargers',
  'raiders': 'Las Vegas Raiders', 'lv': 'Las Vegas Raiders',
  // NBA
  'lakers': 'Los Angeles Lakers', 'lal': 'Los Angeles Lakers',
  'celtics': 'Boston Celtics', 'bos': 'Boston Celtics',
  'warriors': 'Golden State Warriors', 'gsw': 'Golden State Warriors',
  'bucks': 'Milwaukee Bucks', 'mil': 'Milwaukee Bucks',
  'heat': 'Miami Heat',
  'nuggets': 'Denver Nuggets',
  'suns': 'Phoenix Suns', 'phx': 'Phoenix Suns',
  'mavericks': 'Dallas Mavericks',
  'clippers': 'Los Angeles Clippers', 'lac': 'Los Angeles Clippers',
  'sixers': 'Philadelphia 76ers',
  '76ers': 'Philadelphia 76ers',
  'nets': 'Brooklyn Nets', 'bkn': 'Brooklyn Nets',
  'knicks': 'New York Knicks', 'nyk': 'New York Knicks',
  'raptors': 'Toronto Raptors', 'tor': 'Toronto Raptors',
  'bulls': 'Chicago Bulls',
  'cavaliers': 'Cleveland Cavaliers', 'cavs': 'Cleveland Cavaliers',
  'pistons': 'Detroit Pistons',
  'pacers': 'Indiana Pacers',
  'hawks': 'Atlanta Hawks',
  'hornets': 'Charlotte Hornets', 'cha': 'Charlotte Hornets',
  'magic': 'Orlando Magic', 'orl': 'Orlando Magic',
  'wizards': 'Washington Wizards',
  'timberwolves': 'Minnesota Timberwolves', 'wolves': 'Minnesota Timberwolves',
  'thunder': 'Oklahoma City Thunder', 'okc': 'Oklahoma City Thunder',
  'blazers': 'Portland Trail Blazers', 'por': 'Portland Trail Blazers',
  'jazz': 'Utah Jazz', 'uta': 'Utah Jazz',
  'grizzlies': 'Memphis Grizzlies', 'mem': 'Memphis Grizzlies',
  'pelicans': 'New Orleans Pelicans', 'nop': 'New Orleans Pelicans',
  'spurs': 'San Antonio Spurs', 'sas': 'San Antonio Spurs',
  'rockets': 'Houston Rockets',
  'kings': 'Sacramento Kings', 'sac': 'Sacramento Kings',
};

// Detect sport from Polymarket slug
function detectSportFromSlug(slug) {
  if (!slug) return null;
  var slugLower = slug.toLowerCase();
  
  if (slugLower.startsWith('nfl-') || slugLower.includes('-nfl-')) return 'nfl';
  if (slugLower.startsWith('nba-') || slugLower.includes('-nba-')) return 'nba';
  if (slugLower.startsWith('mlb-') || slugLower.includes('-mlb-')) return 'mlb';
  if (slugLower.startsWith('nhl-') || slugLower.includes('-nhl-')) return 'nhl';
  if (slugLower.startsWith('ncaaf-') || slugLower.includes('college-football')) return 'ncaaf';
  if (slugLower.startsWith('ncaab-') || slugLower.includes('college-basketball')) return 'ncaab';
  if (slugLower.startsWith('ufc-') || slugLower.startsWith('mma-')) return 'mma';
  if (slugLower.startsWith('epl-') || slugLower.includes('premier-league')) return 'epl';
  if (slugLower.startsWith('wta-')) return 'wta';
  if (slugLower.startsWith('atp-')) return 'atp';
  if (slugLower.startsWith('lol-')) return 'lol';
  
  return null;
}

// Extract team codes from Polymarket slug
function extractTeamsFromSlug(slug) {
  if (!slug) return null;
  
  // Pattern: nfl-ne-den-2026-01-25, nba-lal-bos-2026-01-25
  var match = slug.match(/^(?:nfl|nba|mlb|nhl|ncaaf|ncaab)-([a-z0-9]+)-([a-z0-9]+)-\d{4}-\d{2}-\d{2}/i);
  if (match) {
    return { away: match[1].toLowerCase(), home: match[2].toLowerCase() };
  }
  return null;
}

// Get full team name from code
function getTeamFullName(code) {
  if (!code) return code;
  return TEAM_ALIASES[code.toLowerCase()] || code;
}

// Get scores/results from The Odds API
async function getGameScores(env, sportKey, daysFrom) {
  if (!env.ODDS_API_KEY) {
    console.log("No ODDS_API_KEY configured");
    return null;
  }
  
  try {
    var url = ODDS_API_BASE + "/sports/" + sportKey + "/scores/?apiKey=" + env.ODDS_API_KEY + "&daysFrom=" + (daysFrom || 3);
    var response = await fetch(url);
    
    if (!response.ok) {
      console.error("Odds API scores error: " + response.status);
      return null;
    }
    
    return await response.json();
  } catch (e) {
    console.error("Error fetching scores:", e.message);
    return null;
  }
}

// Get current odds from The Odds API
async function getGameOdds(env, sportKey, markets) {
  if (!env.ODDS_API_KEY) {
    console.log("No ODDS_API_KEY configured");
    return null;
  }
  
  try {
    var url = ODDS_API_BASE + "/sports/" + sportKey + "/odds/?apiKey=" + env.ODDS_API_KEY + "&regions=us&markets=" + (markets || 'h2h,spreads') + "&oddsFormat=american";
    var response = await fetch(url);
    
    if (!response.ok) {
      console.error("Odds API odds error: " + response.status);
      return null;
    }
    
    return await response.json();
  } catch (e) {
    console.error("Error fetching odds:", e.message);
    return null;
  }
}

// Find matching game in Odds API results
function findMatchingGame(games, homeTeamCode, awayTeamCode) {
  if (!games || !Array.isArray(games)) return null;
  
  var homeFullName = getTeamFullName(homeTeamCode);
  var awayFullName = getTeamFullName(awayTeamCode);
  
  for (var i = 0; i < games.length; i++) {
    var game = games[i];
    var gameHome = (game.home_team || '').toLowerCase();
    var gameAway = (game.away_team || '').toLowerCase();
    var homeMatch = homeFullName.toLowerCase();
    var awayMatch = awayFullName.toLowerCase();
    
    // Check for match
    if ((gameHome.includes(homeMatch) || homeMatch.includes(gameHome)) &&
        (gameAway.includes(awayMatch) || awayMatch.includes(gameAway))) {
      return game;
    }
    // Try reversed (home/away might be swapped)
    if ((gameHome.includes(awayMatch) || awayMatch.includes(gameHome)) &&
        (gameAway.includes(homeMatch) || homeMatch.includes(gameAway))) {
      return game;
    }
  }
  
  return null;
}

// Convert American odds to implied probability
function americanToProb(odds) {
  if (odds > 0) {
    return 100 / (odds + 100);
  } else {
    return Math.abs(odds) / (Math.abs(odds) + 100);
  }
}

// Convert probability to American odds
function probToAmerican(prob) {
  if (prob >= 0.5) {
    return Math.round(-100 * prob / (1 - prob));
  } else {
    return Math.round(100 * (1 - prob) / prob);
  }
}

// Calculate edge: Polymarket price vs Vegas odds
function calculateEdge(polymarketPrice, vegasOdds) {
  var polyProb = polymarketPrice / 100;
  var vegasProb = americanToProb(vegasOdds);
  var edge = vegasProb - polyProb;
  
  return {
    polymarketProb: Math.round(polyProb * 100),
    vegasProb: Math.round(vegasProb * 100),
    edge: Math.round(edge * 100),
    vegasOdds: vegasOdds,
    isValue: edge > 0.03
  };
}

// Settle sports bet using actual game results from The Odds API
async function settleWithOddsAPI(env, marketSlug, direction) {
  var sport = detectSportFromSlug(marketSlug);
  if (!sport) return null;
  
  var sportKey = SPORT_KEY_MAP[sport];
  if (!sportKey) return null;
  
  var teams = extractTeamsFromSlug(marketSlug);
  if (!teams) return null;
  
  var scores = await getGameScores(env, sportKey, 3);
  if (!scores) return null;
  
  var game = findMatchingGame(scores, teams.home, teams.away);
  if (!game) {
    console.log("No matching game found for " + marketSlug);
    return null;
  }
  
  if (!game.completed) {
    return { status: 'pending', game: game };
  }
  
  if (!game.scores || game.scores.length < 2) {
    return { status: 'no_scores', game: game };
  }
  
  var homeScore = parseInt(game.scores.find(function(s) { return s.name === game.home_team; })?.score || 0);
  var awayScore = parseInt(game.scores.find(function(s) { return s.name === game.away_team; })?.score || 0);
  
  // Determine winner
  var winner;
  if (homeScore > awayScore) {
    winner = game.home_team;
  } else if (awayScore > homeScore) {
    winner = game.away_team;
  } else {
    winner = 'tie';
  }
  
  // Check if this is a spread bet
  var isSpread = marketSlug.includes('spread');
  if (isSpread) {
    var spreadMatch = marketSlug.match(/spread-(home|away)-(\d+)pt?(\d)?/i);
    if (spreadMatch) {
      var spreadSide = spreadMatch[1].toLowerCase();
      var spreadPoints = parseFloat(spreadMatch[2] + '.' + (spreadMatch[3] || '5'));
      
      var margin = homeScore - awayScore;
      var spreadWinner;
      
      if (spreadSide === 'away') {
        // Away team getting points (e.g., Broncos +3.5)
        spreadWinner = (awayScore + spreadPoints) > homeScore ? game.away_team : game.home_team;
      } else {
        // Home team giving points
        spreadWinner = margin > spreadPoints ? game.home_team : game.away_team;
      }
      
      // Check if direction won
      var dirTeam = getTeamFullName(direction);
      var didWin = spreadWinner.toLowerCase().includes(dirTeam.toLowerCase()) ||
                   dirTeam.toLowerCase().includes(spreadWinner.toLowerCase());
      
      return {
        status: 'settled',
        outcome: didWin ? 'WIN' : 'LOSS',
        game: game,
        homeScore: homeScore,
        awayScore: awayScore,
        spread: spreadPoints,
        spreadWinner: spreadWinner,
        source: 'odds-api'
      };
    }
  }
  
  // Regular moneyline bet
  var dirTeam = getTeamFullName(direction);
  var didWin = winner.toLowerCase().includes(dirTeam.toLowerCase()) ||
               dirTeam.toLowerCase().includes(winner.toLowerCase());
  
  return {
    status: 'settled',
    outcome: didWin ? 'WIN' : 'LOSS',
    game: game,
    homeScore: homeScore,
    awayScore: awayScore,
    winner: winner,
    source: 'odds-api'
  };
}

// ============================================================
// END ODDS API INTEGRATION
// ============================================================

var POLYMARKET_API = "https://data-api.polymarket.com";
// SCORING SYSTEM v8 - Adaptive Learning System
// Base scores that get multiplied by learned factor weights
var SCORES = {
  // WHALE BET SIZE (single bet)
  WHALE_BET_MASSIVE: 80,    // $50k+ single bet - definite whale
  WHALE_BET_LARGE: 60,      // $25k+ single bet - large whale
  WHALE_BET_NOTABLE: 45,    // $15k+ single bet - notable bet
  WHALE_BET_MEDIUM: 30,     // $8k+ single bet - solid bet
  WHALE_BET_SMALL: 15,      // $3k+ single bet - worth noting
  
  // CONCENTRATION (few wallets controlling the action)
  CONCENTRATION_SINGLE_WHALE: 25,  // 1 wallet has >80% AND bet $10k+
  CONCENTRATION_WHALE_DUO: 15,     // 2 wallets have >80% AND both bet $5k+
  CONCENTRATION_HIGH: 10,          // Top wallet has >60% of volume AND $5k+
  
  // FRESH WALLET + MONEY (hiding identity - insider signal)
  // Does NOT stack with whale bet - it's one or the other
  FRESH_WHALE_HUGE: 80,     // Fresh wallet betting $50k+
  FRESH_WHALE_LARGE: 60,    // Fresh wallet betting $25k+
  FRESH_WHALE_NOTABLE: 45,  // Fresh wallet betting $10k+
  FRESH_WHALE_MEDIUM: 30,   // Fresh wallet betting $5k+
  FRESH_WALLET_SMALL: 15,   // Fresh wallet betting $2k+
  
  // COORDINATED (multiple wallets acting together)
  COORDINATED_WHALES: 30,   // 3+ wallets ALL betting $5k+ within 2hrs
  COORDINATED_LARGE: 15,    // 3+ wallets ALL betting $2k+ within 2hrs
  
  // VOLUME
  VOLUME_MASSIVE: 20,       // >$100k total
  VOLUME_LARGE: 15,         // >$50k total
  VOLUME_NOTABLE: 10,       // >$25k total
  VOLUME_MEDIUM: 5,         // >$10k total
  
  // MARKET TYPE (minor factor)
  POLITICAL: 5,             // Elections can have insider info
  SPORTS: 3,                // Injury news, etc
  CRYPTO: 3,                // Less insider advantage
  
  // TIMING/ODDS
  EXTREME_ODDS: 15,         // Betting heavy on long shots (>85% or <15%)
  MODERATE_ODDS: 5,         // Betting on favorites/underdogs (>75% or <25%)
  RAPID_ACCUMULATION: 10,   // Large position built quickly
  
  // LAST-MINUTE WHALE (urgent insider info)
  LAST_MINUTE_WHALE_2H: 25, // $10k+ bet within 2 hours of event
  LAST_MINUTE_WHALE_6H: 15, // $10k+ bet within 6 hours of event
  LAST_MINUTE_WHALE_12H: 10, // $10k+ bet within 12 hours of event
  
  // PROVEN WINNER WALLET (track record - THE HOLY GRAIL)
  PROVEN_WINNER_ELITE: 80,  // 70%+ win rate
  PROVEN_WINNER_STRONG: 50, // 65-70% win rate
  PROVEN_WINNER_GOOD: 30,   // 60-65% win rate
  PROVEN_WINNER_EDGE: 15,   // 55-60% win rate
  
  // WHALE + PROVEN WINNER COMBO
  WHALE_PROVEN_WINNER: 30,  // $25k+ bet from a proven winner wallet
  
  // ============================================
  // PHASE 2: NEW SCORING FACTORS
  // ============================================
  
  // LINE MOVEMENT CONFIRMATION
  LINE_MOVE_STRONG: 25,     // Price moved 10%+ in our direction after whale bet
  LINE_MOVE_MODERATE: 15,   // Price moved 5-10% in our direction
  LINE_MOVE_SLIGHT: 8,      // Price moved 2-5% in our direction
  
  // SHARP VS PUBLIC DIVERGENCE
  SHARP_VS_PUBLIC: 35,      // Whales betting opposite of small bettors
  SMART_MONEY_FADE: 20,     // Multiple small bets one way, one whale the other
  
  // WALLET TIER MULTIPLIERS (applied to final score)
  TIER_ELITE_MULTIPLIER: 1.5,    // 70%+ win rate wallet
  TIER_STRONG_MULTIPLIER: 1.25,  // 62%+ win rate wallet
  TIER_FADE_MULTIPLIER: 0.5,     // <45% win rate wallet (fade these!)
  
  // SAME WALLET MULTI-MARKET (high confidence)
  MULTI_MARKET_SAME_WALLET: 25,  // Same wallet betting related markets
  
  // STREAK BONUS
  HOT_STREAK_BONUS: 20,     // Wallet on 5+ win streak
  COLD_STREAK_PENALTY: -15  // Wallet on 5+ loss streak
};

// Minimum requirements for wallet track record
var WALLET_TRACK_RECORD = {
  MIN_BETS: 10,             // Minimum resolved bets to count
  LOOKBACK_DAYS: 30,        // Only count bets from last 30 days
  MIN_BET_FOR_CHECK: 50000, // Only check win rate for wallets betting $50k+
  CACHE_HOURS: 6            // How long to cache wallet stats
};

// ============================================================
// PHASE 1: LEARNING SYSTEM
// Auto-track wallets, store signals, learn from outcomes
// ============================================================

// Wallet tier thresholds
var WALLET_TIERS = {
  INSIDER: { minWinRate: 75, minBets: 15, minVolume: 100000, scoreBoost: 2.0, label: "🎯 INSIDER", color: "#ff00ff" },
  ELITE: { minWinRate: 68, minBets: 10, minVolume: 50000, scoreBoost: 1.5, label: "🏆 ELITE", color: "#fbbf24" },
  STRONG: { minWinRate: 60, minBets: 8, minVolume: 20000, scoreBoost: 1.25, label: "💪 STRONG", color: "#3b82f6" },
  AVERAGE: { minWinRate: 50, minBets: 5, minVolume: 0, scoreBoost: 1.0, label: "📊 AVERAGE", color: "#6b7280" },
  FADE: { maxWinRate: 42, minBets: 8, minVolume: 0, scoreBoost: 0.5, label: "🚫 FADE", color: "#ef4444" }
};

// Factor tracking keys
var TRACKABLE_FACTORS = [
  "freshWallet", "whaleSize50k", "whaleSize25k", "whaleSize15k",
  "lastMinute2h", "lastMinute6h", "concentrated", "coordinated",
  "extremeOdds", "politicalMarket", "sportsMarket", "cryptoMarket",
  "insiderWallet", "eliteWallet", "strongWallet", "fadeWallet"
];

// KV Keys
var KV_KEYS = {
  WALLETS_PREFIX: "wallet:",           // wallet:{address} -> wallet stats
  SIGNALS_PREFIX: "signal:",           // signal:{id} -> signal details for learning
  PENDING_SIGNALS: "pending_signals",  // Array of signal IDs awaiting settlement
  FACTOR_STATS: "factor_stats",        // Factor performance tracking
  LEARNING_META: "learning_meta"       // Metadata about learning system
};

// ============================================================
// WALLET TRACKING FUNCTIONS
// ============================================================

// Get wallet tier based on stats - considers volume + win rate + consistency
function getWalletTier(stats) {
  if (!stats || stats.totalBets < 5) return null;
  
  const winRate = stats.winRate || 0;
  const totalBets = stats.totalBets || 0;
  const totalVolume = stats.totalVolume || 0;
  const edgeMetrics = stats.edgeMetrics || {};
  
  // INSIDER: Exceptional performance across all metrics
  // High win rate + high volume + good consistency + profitable big bets
  if (winRate >= WALLET_TIERS.INSIDER.minWinRate && 
      totalBets >= WALLET_TIERS.INSIDER.minBets &&
      totalVolume >= WALLET_TIERS.INSIDER.minVolume) {
    // Additional check: big bet win rate should be good too
    const bigBetWR = edgeMetrics.bigBetWinRate || winRate;
    if (bigBetWR >= 65) {
      return { ...WALLET_TIERS.INSIDER, tier: "INSIDER" };
    }
  }
  
  // ELITE: Very strong performance
  if (winRate >= WALLET_TIERS.ELITE.minWinRate && 
      totalBets >= WALLET_TIERS.ELITE.minBets &&
      totalVolume >= WALLET_TIERS.ELITE.minVolume) {
    return { ...WALLET_TIERS.ELITE, tier: "ELITE" };
  }
  
  // STRONG: Good performance
  if (winRate >= WALLET_TIERS.STRONG.minWinRate && 
      totalBets >= WALLET_TIERS.STRONG.minBets &&
      totalVolume >= WALLET_TIERS.STRONG.minVolume) {
    return { ...WALLET_TIERS.STRONG, tier: "STRONG" };
  }
  
  // FADE: Consistently loses - bet against them!
  if (winRate <= WALLET_TIERS.FADE.maxWinRate && totalBets >= WALLET_TIERS.FADE.minBets) {
    return { ...WALLET_TIERS.FADE, tier: "FADE" };
  }
  
  // AVERAGE: Has enough data but not exceptional
  if (totalBets >= WALLET_TIERS.AVERAGE.minBets) {
    return { ...WALLET_TIERS.AVERAGE, tier: "AVERAGE" };
  }
  
  return null;
}

// Save/update wallet stats in KV
async function updateWalletStats(env, walletAddress, betData) {
  if (!env.SIGNALS_CACHE || !walletAddress) return null;
  
  const key = KV_KEYS.WALLETS_PREFIX + walletAddress.toLowerCase();
  
  try {
    // Get existing stats
    let stats = await env.SIGNALS_CACHE.get(key, { type: "json" });
    
    const isNewWallet = !stats;
    
    if (!stats) {
      stats = {
        address: walletAddress.toLowerCase(),
        totalBets: 0,
        wins: 0,
        losses: 0,
        pending: 0,
        winRate: 0,
        totalVolume: 0,
        avgBetSize: 0,
        profitLoss: 0,
        lastSeen: null,
        firstSeen: new Date().toISOString(),
        tier: null,
        currentStreak: 0,
        bestStreak: 0,
        worstStreak: 0,
        markets: {},        // Track performance by market type
        recentBets: [],     // Last 20 bets for reference
        // EDGE METRICS - what makes a wallet "smart money"
        edgeMetrics: {
          avgOdds: 0,           // Average odds they bet at (lower = more confident)
          avgBetTiming: 0,      // How close to event start they bet (minutes)
          consistencyScore: 0,  // How consistent their win rate is
          bigBetWinRate: 0,     // Win rate on bets >$10k
          sportWinRate: 0,      // Win rate on sports
          politicalWinRate: 0,  // Win rate on political
          cryptoWinRate: 0,     // Win rate on crypto
          totalBigBets: 0,      // Number of $10k+ bets
          roi: 0                // Return on investment %
        }
      };
    }
    
    // Update with new bet data
    if (betData) {
      stats.totalVolume += betData.amount || 0;
      stats.lastSeen = new Date().toISOString();
      stats.pending += 1;
      
      // Track bet for later resolution
      if (stats.recentBets.length >= 20) {
        stats.recentBets.shift(); // Remove oldest
      }
      stats.recentBets.push({
        signalId: betData.signalId,
        market: betData.market,
        marketSlug: betData.marketSlug,
        direction: betData.direction,
        amount: betData.amount,
        price: betData.price,
        time: new Date().toISOString(),
        outcome: null // Will be filled on settlement
      });
      
      // Update average bet size
      const totalBetsIncludingPending = stats.totalBets + stats.pending;
      if (totalBetsIncludingPending > 0) {
        stats.avgBetSize = Math.round(stats.totalVolume / totalBetsIncludingPending);
      }
      
      // Track big bets
      if (betData.amount >= 10000) {
        stats.edgeMetrics.totalBigBets = (stats.edgeMetrics.totalBigBets || 0) + 1;
      }
      
      // Track average odds
      if (betData.price > 0) {
        const currentTotal = (stats.edgeMetrics.avgOdds || 0) * (totalBetsIncludingPending - 1);
        stats.edgeMetrics.avgOdds = Math.round((currentTotal + betData.price) / totalBetsIncludingPending);
      }
    }
    
    // Save to KV (expire after 90 days of no activity)
    await env.SIGNALS_CACHE.put(key, JSON.stringify(stats), {
      expirationTtl: 90 * 24 * 60 * 60
    });
    
    // Add to wallet index if new
    if (isNewWallet) {
      try {
        let index = await env.SIGNALS_CACHE.get("tracked_wallet_index", { type: "json" }) || [];
        if (!index.includes(walletAddress.toLowerCase())) {
          index.push(walletAddress.toLowerCase());
          // Keep only last 500 wallets
          if (index.length > 500) {
            index = index.slice(-500);
          }
          await env.SIGNALS_CACHE.put("tracked_wallet_index", JSON.stringify(index), {
            expirationTtl: 90 * 24 * 60 * 60
          });
        }
      } catch (e) {
        console.log("Error updating wallet index:", e.message);
      }
    }
    
    return stats;
  } catch (e) {
    console.error("Error updating wallet stats:", e.message);
    return null;
  }
}

// Get wallet stats from KV
async function getWalletStats(env, walletAddress) {
  if (!env.SIGNALS_CACHE || !walletAddress) return null;
  
  const key = KV_KEYS.WALLETS_PREFIX + walletAddress.toLowerCase();
  
  try {
    const stats = await env.SIGNALS_CACHE.get(key, { type: "json" });
    if (stats) {
      stats.tierInfo = getWalletTier(stats);
    }
    return stats;
  } catch (e) {
    console.error("Error getting wallet stats:", e.message);
    return null;
  }
}

// Record bet outcome for a wallet
async function recordWalletOutcome(env, walletAddress, outcome, profitLoss, marketType, betAmount = 0, signalId = null) {
  if (!env.SIGNALS_CACHE || !walletAddress) return null;
  
  const key = KV_KEYS.WALLETS_PREFIX + walletAddress.toLowerCase();
  
  try {
    let stats = await env.SIGNALS_CACHE.get(key, { type: "json" });
    if (!stats) return null;
    
    // Initialize edge metrics if missing
    if (!stats.edgeMetrics) {
      stats.edgeMetrics = {
        avgOdds: 0,
        consistencyScore: 0,
        bigBetWinRate: 0,
        totalBigBets: 0,
        bigBetWins: 0,
        roi: 0
      };
    }
    
    // Update the specific bet in recentBets if signalId provided
    if (signalId && stats.recentBets && stats.recentBets.length > 0) {
      for (let i = 0; i < stats.recentBets.length; i++) {
        if (stats.recentBets[i].signalId === signalId && stats.recentBets[i].outcome === null) {
          stats.recentBets[i].outcome = outcome;
          stats.recentBets[i].settledAt = new Date().toISOString();
          break; // Only update one bet per signal settlement
        }
      }
    }
    
    // Update stats
    stats.totalBets += 1;
    stats.pending = Math.max(0, stats.pending - 1);
    
    if (outcome === "WIN") {
      stats.wins += 1;
      stats.currentStreak = Math.max(0, stats.currentStreak) + 1;
      stats.bestStreak = Math.max(stats.bestStreak || 0, stats.currentStreak);
      
      // Track big bet wins
      if (betAmount >= 10000) {
        stats.edgeMetrics.bigBetWins = (stats.edgeMetrics.bigBetWins || 0) + 1;
      }
    } else if (outcome === "LOSS") {
      stats.losses += 1;
      stats.currentStreak = Math.min(0, stats.currentStreak) - 1;
      stats.worstStreak = Math.min(stats.worstStreak || 0, stats.currentStreak);
    }
    // UNKNOWN outcomes don't affect win/loss
    
    stats.profitLoss += profitLoss || 0;
    stats.winRate = stats.totalBets > 0 ? Math.round((stats.wins / stats.totalBets) * 100) : 0;
    stats.tier = getWalletTier(stats)?.tier || null;
    
    // Calculate edge metrics
    // Big bet win rate (bets >= $10k)
    if (stats.edgeMetrics.totalBigBets > 0) {
      stats.edgeMetrics.bigBetWinRate = Math.round(
        ((stats.edgeMetrics.bigBetWins || 0) / stats.edgeMetrics.totalBigBets) * 100
      );
    }
    
    // ROI calculation
    if (stats.totalVolume > 0) {
      stats.edgeMetrics.roi = Math.round((stats.profitLoss / stats.totalVolume) * 100);
    }
    
    // Consistency score: penalize high variance
    // A wallet with 70% WR over 20 bets is more reliable than 70% over 5 bets
    const sampleSize = stats.totalBets;
    const baseScore = stats.winRate;
    const sampleBonus = Math.min(sampleSize / 20, 1) * 10; // Max +10 for 20+ bets
    stats.edgeMetrics.consistencyScore = Math.round(baseScore + sampleBonus);
    
    // Track by market type
    if (marketType) {
      if (!stats.markets[marketType]) {
        stats.markets[marketType] = { wins: 0, losses: 0, winRate: 0 };
      }
      if (outcome === "WIN") {
        stats.markets[marketType].wins += 1;
      } else if (outcome === "LOSS") {
        stats.markets[marketType].losses += 1;
      }
      const mt = stats.markets[marketType];
      const mtTotal = mt.wins + mt.losses;
      mt.winRate = mtTotal > 0 ? Math.round((mt.wins / mtTotal) * 100) : 0;
      
      // Update market-specific win rates in edge metrics
      if (marketType === 'sports') stats.edgeMetrics.sportWinRate = mt.winRate;
      if (marketType === 'political') stats.edgeMetrics.politicalWinRate = mt.winRate;
      if (marketType === 'crypto') stats.edgeMetrics.cryptoWinRate = mt.winRate;
    }
    
    await env.SIGNALS_CACHE.put(key, JSON.stringify(stats), {
      expirationTtl: 90 * 24 * 60 * 60
    });
    
    return stats;
  } catch (e) {
    console.error("Error recording wallet outcome:", e.message);
    return null;
  }
}

// ============================================================
// SIGNAL STORAGE FOR LEARNING
// ============================================================

// Store signal for later learning
async function storeSignalForLearning(env, signal, factors, wallets) {
  if (!env.SIGNALS_CACHE) return;
  
  const signalData = {
    id: signal.id,
    marketSlug: signal.marketSlug,
    marketTitle: signal.marketTitle,
    direction: signal.direction,
    directionRaw: signal.directionRaw,   // exact Polymarket outcome; stable key for investigation/Brier
    score: signal.score,
    factors: factors,           // Array of factor keys that contributed
    wallets: wallets,           // Array of wallet addresses involved
    largestBet: signal.largestBet,
    totalVolume: signal.suspiciousVolume,
    priceAtSignal: signal.avgEntryPrice,
    priceAfter30min: null,      // Will be filled by line movement tracker
    priceAfter1hr: null,
    eventDate: signal.eventDate,
    detectedAt: signal.detectedAt,
    outcome: null,              // WIN/LOSS - filled on settlement
    settledAt: null,
    profitLoss: null
  };
  
  try {
    // Store individual signal
    const signalKey = KV_KEYS.SIGNALS_PREFIX + signal.id;
    await env.SIGNALS_CACHE.put(signalKey, JSON.stringify(signalData), {
      expirationTtl: 30 * 24 * 60 * 60 // Keep for 30 days
    });
    
    // Add to pending signals list
    let pendingSignals = await env.SIGNALS_CACHE.get(KV_KEYS.PENDING_SIGNALS, { type: "json" }) || [];
    
    // Avoid duplicates
    if (!pendingSignals.includes(signal.id)) {
      pendingSignals.push(signal.id);
      
      // Keep only last 500 pending signals
      if (pendingSignals.length > 500) {
        pendingSignals = pendingSignals.slice(-500);
      }
      
      await env.SIGNALS_CACHE.put(KV_KEYS.PENDING_SIGNALS, JSON.stringify(pendingSignals));
    }
    
    console.log(`Stored signal for learning: ${signal.id}`);
  } catch (e) {
    console.error("Error storing signal for learning:", e.message);
  }
}

// ============================================================
// FACTOR PERFORMANCE TRACKING
// ============================================================

// Update factor stats after outcome
async function updateFactorStats(env, factors, outcome) {
  if (!env.SIGNALS_CACHE || !factors || factors.length === 0) return;
  
  try {
    let factorStats = await env.SIGNALS_CACHE.get(KV_KEYS.FACTOR_STATS, { type: "json" }) || {};
    
    for (const factor of factors) {
      if (!factorStats[factor]) {
        factorStats[factor] = {
          wins: 0,
          losses: 0,
          winRate: 50,
          weight: 1.0,
          lastUpdated: null
        };
      }
      
      if (outcome === "WIN") {
        factorStats[factor].wins += 1;
      } else {
        factorStats[factor].losses += 1;
      }
      
      const total = factorStats[factor].wins + factorStats[factor].losses;
      factorStats[factor].winRate = Math.round((factorStats[factor].wins / total) * 100);
      
      // Adjust weight based on performance (0.5 to 2.0 range)
      // Factors with >60% win rate get boosted, <40% get reduced
      factorStats[factor].weight = Math.max(0.5, Math.min(2.0, 
        0.5 + (factorStats[factor].winRate / 100) * 1.5
      ));
      
      factorStats[factor].lastUpdated = new Date().toISOString();
    }
    
    await env.SIGNALS_CACHE.put(KV_KEYS.FACTOR_STATS, JSON.stringify(factorStats));
    console.log(`Updated factor stats for ${factors.length} factors`);
  } catch (e) {
    console.error("Error updating factor stats:", e.message);
  }
}

// Get current factor weights for scoring
async function getFactorWeights(env) {
  if (!env.SIGNALS_CACHE) return {};
  
  try {
    const factorStats = await env.SIGNALS_CACHE.get(KV_KEYS.FACTOR_STATS, { type: "json" }) || {};
    const weights = {};
    
    for (const [factor, stats] of Object.entries(factorStats)) {
      weights[factor] = stats.weight || 1.0;
    }
    
    return weights;
  } catch (e) {
    console.error("Error getting factor weights:", e.message);
    return {};
  }
}

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

// ============================================================
// PAPER-TRADING ROI LEDGER
// Every settled signal is booked as a hypothetical $100 buy at the
// signal's entry price. This measures actual ROI - not just win
// rate, which is meaningless without entry price - broken down by
// score band, market type, factor, entry band and settlement source.
// ============================================================

var PAPER_STAKE = 100;
var LEDGER_KEY = "paper_ledger";
var LEDGER_TRADES_KEY = "paper_ledger_trades";

function emptyLedgerBucket() {
  return { n: 0, wins: 0, losses: 0, unknown: 0, staked: 0, pnl: 0 };
}

function bumpLedgerBucket(bucket, outcome, pnl) {
  bucket.n += 1;
  if (outcome === "WIN") bucket.wins += 1;
  else if (outcome === "LOSS") bucket.losses += 1;
  else bucket.unknown += 1;
  if (outcome === "WIN" || outcome === "LOSS") {
    bucket.staked += PAPER_STAKE;
    bucket.pnl = Math.round((bucket.pnl + pnl) * 100) / 100;
  }
}

function ledgerScoreBand(score) {
  if (score >= 150) return "150+";
  if (score >= 100) return "100-149";
  if (score >= 75) return "75-99";
  return "50-74"; // signals only enter the learning store at score >= 50
}

function ledgerEntryBand(entryPct) {
  if (entryPct < 25) return "1-24";
  if (entryPct < 50) return "25-49";
  if (entryPct < 75) return "50-74";
  return "75-99";
}

async function recordPaperTrade(env, signalData, outcome) {
  if (!env.SIGNALS_CACHE) return;

  var entry = signalData.priceAtSignal;
  var gradeable = (outcome === "WIN" || outcome === "LOSS") && entry >= 1 && entry <= 99;
  var effectiveOutcome = gradeable ? outcome : "UNKNOWN";
  var pnl = 0;
  if (gradeable) {
    // $100 buys (100/entry) shares paying $1 each on a win
    pnl = outcome === "WIN"
      ? Math.round(PAPER_STAKE * (100 - entry) / entry * 100) / 100
      : -PAPER_STAKE;
  }

  try {
    var ledger = await env.SIGNALS_CACHE.get(LEDGER_KEY, { type: "json" });
    if (!ledger) {
      ledger = {
        version: 1,
        stakePerTrade: PAPER_STAKE,
        createdAt: new Date().toISOString(),
        overall: emptyLedgerBucket(),
        byScoreBand: {},
        byMarketType: {},
        byEntryBand: {},
        bySource: {},
        byFactor: {}
      };
    }

    var bumpGroup = function (group, key) {
      if (!key) return;
      if (!group[key]) group[key] = emptyLedgerBucket();
      bumpLedgerBucket(group[key], effectiveOutcome, pnl);
    };

    bumpLedgerBucket(ledger.overall, effectiveOutcome, pnl);
    bumpGroup(ledger.byScoreBand, ledgerScoreBand(signalData.score || 0));
    bumpGroup(ledger.byMarketType, detectMarketType(signalData.marketTitle));
    bumpGroup(ledger.byEntryBand, (entry >= 1 && entry <= 99) ? ledgerEntryBand(entry) : "invalid-entry");
    bumpGroup(ledger.bySource, signalData.settledBy || "unknown");
    for (var f = 0; f < (signalData.factors || []).length; f++) {
      bumpGroup(ledger.byFactor, signalData.factors[f]);
    }

    ledger.updatedAt = new Date().toISOString();
    await env.SIGNALS_CACHE.put(LEDGER_KEY, JSON.stringify(ledger));

    var trades = await env.SIGNALS_CACHE.get(LEDGER_TRADES_KEY, { type: "json" }) || [];
    trades.unshift({
      signalId: signalData.id,
      market: signalData.marketTitle,
      direction: signalData.directionRaw || signalData.direction,
      entryPrice: entry,
      score: signalData.score,
      outcome: effectiveOutcome,
      pnl: pnl,
      settledBy: signalData.settledBy || null,
      winningOutcome: signalData.winningOutcome || null,
      detectedAt: signalData.detectedAt,
      settledAt: signalData.settledAt
    });
    if (trades.length > 300) trades = trades.slice(0, 300);
    await env.SIGNALS_CACHE.put(LEDGER_TRADES_KEY, JSON.stringify(trades));
  } catch (e) {
    console.error("Error recording paper trade:", e.message);
  }
}

function ledgerBucketView(bucket) {
  var graded = bucket.wins + bucket.losses;
  return {
    ...bucket,
    winRate: graded > 0 ? Math.round((bucket.wins / graded) * 100) : null,
    roiPct: bucket.staked > 0 ? Math.round((bucket.pnl / bucket.staked) * 1000) / 10 : null
  };
}

function buildLedgerView(ledger) {
  if (!ledger) return null;
  var mapGroup = function (group) {
    var out = {};
    for (var key of Object.keys(group || {})) {
      out[key] = ledgerBucketView(group[key]);
    }
    return out;
  };
  return {
    stakePerTrade: ledger.stakePerTrade,
    createdAt: ledger.createdAt,
    updatedAt: ledger.updatedAt,
    overall: ledgerBucketView(ledger.overall),
    byScoreBand: mapGroup(ledger.byScoreBand),
    byMarketType: mapGroup(ledger.byMarketType),
    byEntryBand: mapGroup(ledger.byEntryBand),
    bySource: mapGroup(ledger.bySource),
    byFactor: mapGroup(ledger.byFactor)
  };
}

// Shared settlement bookkeeping: updates the signal record, factor stats,
// wallet outcomes and the paper ledger - identical regardless of which
// source (gamma / odds-api / trades-heuristic) determined the outcome.
async function recordSignalOutcome(env, signalKey, signalData, outcome, meta) {
  meta = meta || {};
  var entryPct = signalData.priceAtSignal || 0;
  var profitPct = null;
  if (outcome === "WIN" && entryPct >= 1) {
    profitPct = Math.round(((1 - entryPct / 100) / (entryPct / 100)) * 100);
  } else if (outcome === "LOSS") {
    profitPct = -100;
  }

  signalData.outcome = outcome;
  signalData.settledAt = new Date().toISOString();
  signalData.profitLoss = profitPct;
  signalData.settledBy = meta.settledBy || null;
  if (meta.winningOutcome) signalData.winningOutcome = meta.winningOutcome;
  if (meta.note) signalData.note = meta.note;
  if (meta.gameScore) signalData.gameScore = meta.gameScore;

  await env.SIGNALS_CACHE.put(signalKey, JSON.stringify(signalData), {
    expirationTtl: (outcome === "UNKNOWN" ? 7 : 30) * 24 * 60 * 60
  });

  if (outcome === "WIN" || outcome === "LOSS") {
    if (signalData.factors && signalData.factors.length > 0) {
      await updateFactorStats(env, signalData.factors, outcome);
    }
    var marketType = detectMarketType(signalData.marketTitle);
    for (var w = 0; w < (signalData.wallets || []).length; w++) {
      await recordWalletOutcome(env, signalData.wallets[w], outcome, profitPct, marketType, signalData.largestBet || 0, signalData.id);
    }
  }

  await recordPaperTrade(env, signalData, outcome);

  // Score the agent's investigation against ground truth (Gamma-only).
  await recordBrierOutcome(env, signalData, outcome, meta);
}

// ============================================================
// AGENT INVESTIGATION
// Calls the Claude Messages API with the web_search server tool to
// independently estimate the probability a market resolves YES for the
// signal's direction. This is the "is the market actually mispriced?"
// layer - it produces a probability the scanner can compare against the
// crowd price, and whose calibration is tracked via Brier score once the
// market settles (see recordSignalOutcome / brier_stats).
// ============================================================

var ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
var DEFAULT_INVESTIGATION_MODEL = "claude-opus-4-8";

// Final-answer schema. Structured outputs can't express numeric bounds, so
// probability is clamped in code after parsing.
var INVESTIGATION_SCHEMA = {
  type: "object",
  properties: {
    probability: {
      type: "number",
      description: "Independent probability from 0 to 1 that the market resolves YES for the stated direction, based on your research."
    },
    confidence: {
      type: "string",
      enum: ["LOW", "MEDIUM", "HIGH"],
      description: "How confident you are in the estimate given the evidence you found."
    },
    reasoning: {
      type: "string",
      description: "2-4 sentence justification for the probability, grounded in what you found."
    },
    keyFindings: {
      type: "array",
      items: { type: "string" },
      description: "Short bullet facts (with source names) that drove the estimate."
    }
  },
  required: ["probability", "confidence", "reasoning", "keyFindings"],
  additionalProperties: false
};

// The dynamic-filtering web_search variant requires Opus 4.6+/Sonnet 4.6+.
// Haiku and older models must use the basic variant.
function webSearchToolType(model) {
  return /haiku/i.test(model || "") ? "web_search_20250305" : "web_search_20260209";
}

function clamp01(x) {
  if (typeof x !== "number" || isNaN(x)) return null;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// Best-effort JSON extraction: with output_config.format the final text block
// is pure JSON, but guard against a truncated/decorated response.
function extractInvestigationJson(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return null;
  var texts = contentBlocks
    .filter(function (b) { return b && b.type === "text" && typeof b.text === "string"; })
    .map(function (b) { return b.text; });
  for (var i = texts.length - 1; i >= 0; i--) {
    var t = texts[i].trim();
    try {
      return JSON.parse(t);
    } catch (e) {
      var start = t.indexOf("{");
      var end = t.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { return JSON.parse(t.slice(start, end + 1)); } catch (e2) {}
      }
    }
  }
  return null;
}

// Call Claude to investigate one market. Pure API mechanics - no dependency on
// how the signal was sourced. Returns:
//   { ok:true, agentProb, confidence, reasoning, keyFindings, model, webSearches }
//   { ok:false, error }
async function callClaudeInvestigator(env, params) {
  if (!env.ANTHROPIC_API_KEY) {
    return { ok: false, error: "ANTHROPIC_API_KEY not configured" };
  }

  var model = env.INVESTIGATION_MODEL || DEFAULT_INVESTIGATION_MODEL;
  var effort = env.INVESTIGATION_EFFORT || "medium";
  var maxSearches = parseInt(env.INVESTIGATION_MAX_SEARCHES || "5", 10);

  var criteria = params.resolutionCriteria
    ? params.resolutionCriteria
    : "(No official resolution text was available. Infer the resolution condition from the market question.)";

  var marketPricePct = typeof params.marketPricePct === "number"
    ? params.marketPricePct
    : null;

  var system =
    "You are a forecasting analyst for prediction markets. You research a market's " +
    "actual resolution criteria and current real-world facts, then output an INDEPENDENT " +
    "probability that the market resolves YES for a specific direction/outcome.\n\n" +
    "Rules:\n" +
    "- Use web_search to find current, load-bearing facts (official sources, reputable news, primary data).\n" +
    "- Anchor to the EXACT resolution criteria, including dates, thresholds, and edge cases. A market can feel " +
    "'obviously true' while the criteria make it false (wrong date window, wrong measure, technicality).\n" +
    "- Estimate the probability from evidence, NOT from the market's own price. Do not anchor to the crowd.\n" +
    "- If you cannot find decisive evidence, say so and return a probability near your genuine uncertainty with LOW confidence.\n" +
    "- Today's date is provided; treat anything after it as not yet known.";

  var userText =
    "Today's date: " + new Date().toISOString().slice(0, 10) + "\n\n" +
    "MARKET: " + (params.marketTitle || "(untitled)") + "\n" +
    "DIRECTION/OUTCOME TO PRICE: " + (params.direction || "YES") + "\n" +
    (params.eventDate ? "STATED EVENT DATE: " + params.eventDate + "\n" : "") +
    (marketPricePct !== null ? "CROWD PRICE (for reference only, do not anchor): " + marketPricePct + "%\n" : "") +
    "\nRESOLUTION CRITERIA:\n" + criteria + "\n\n" +
    "Research the current facts, then estimate the probability that this market resolves YES " +
    "for the direction above. Return the structured result.";

  var body = {
    model: model,
    max_tokens: 6000,
    // Opus 4.8/4.7 run thinking-off unless adaptive is set explicitly (Opus 5
    // thinks by default). Adaptive is valid on all of them, so set it always.
    thinking: { type: "adaptive" },
    output_config: {
      effort: effort,
      format: { type: "json_schema", schema: INVESTIGATION_SCHEMA }
    },
    tools: [
      { type: webSearchToolType(model), name: "web_search", max_uses: maxSearches }
    ],
    system: system,
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }]
  };

  var headers = {
    "content-type": "application/json",
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01"
  };

  var webSearches = 0;
  // Bound the server-tool resume loop so a Worker invocation can't run away
  // against the subrequest cap.
  var MAX_TURNS = 8;

  try {
    var perFetchTimeoutMs = parseInt(env.INVESTIGATION_FETCH_TIMEOUT_MS || "100000", 10);
    for (var turn = 0; turn < MAX_TURNS; turn++) {
      // Bound each call so a hung request can't eat the cron's 15-min wall budget.
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, perFetchTimeoutMs);
      var res;
      try {
        res = await fetch(ANTHROPIC_API, {
          method: "POST",
          headers: headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        var errText = await res.text();
        return { ok: false, error: "Anthropic API " + res.status + ": " + errText.slice(0, 300) };
      }

      var data = await res.json();

      // Count web searches for cost visibility
      for (var b = 0; b < (data.content || []).length; b++) {
        if (data.content[b] && data.content[b].type === "server_tool_use" &&
            data.content[b].name === "web_search") {
          webSearches++;
        }
      }

      if (data.stop_reason === "refusal") {
        return { ok: false, error: "refusal", stopDetails: data.stop_details || null };
      }

      // Server-tool loop hit its internal cap - resume by echoing the turn back.
      if (data.stop_reason === "pause_turn") {
        body.messages.push({ role: "assistant", content: data.content });
        continue;
      }

      // Terminal (end_turn / max_tokens) - parse the final structured answer.
      var parsed = extractInvestigationJson(data.content);
      if (!parsed) {
        return {
          ok: false,
          error: "Could not parse investigation JSON (stop_reason=" + data.stop_reason + ")"
        };
      }

      var prob = clamp01(parsed.probability);
      if (prob === null) {
        return { ok: false, error: "Investigation returned no usable probability" };
      }

      return {
        ok: true,
        agentProb: prob,
        confidence: (parsed.confidence || "LOW").toUpperCase(),
        reasoning: parsed.reasoning || "",
        keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings.slice(0, 8) : [],
        model: data.model || model,
        webSearches: webSearches,
        stopReason: data.stop_reason
      };
    }

    return { ok: false, error: "Investigation exceeded " + MAX_TURNS + " turns without finishing" };
  } catch (e) {
    return { ok: false, error: "Investigation exception: " + (e && e.message) };
  }
}

// Stable investigation identity. signal.id embeds the earliest trade time,
// which churns as the scan window slides - keying on that would re-investigate
// the same market every scan and pollute Brier with fake-independent samples.
// marketSlug + directionRaw is stable across scans.
function investigationKeyFor(marketSlug, directionRaw) {
  return "investigation:" + (marketSlug || "") + "::" + (directionRaw || "");
}

// The market's current implied probability that THIS bet wins, from Gamma's
// live outcome prices at investigation time. This is the honest baseline for
// Brier - NOT the whale's impact-inflated entry fill (avgEntryPrice), which is
// kept only for the ROI ledger.
function gammaBaselineForDirection(found, directionRaw) {
  if (!found || !found.market) return { marketProb: null, winIndex: -1 };
  var names = parseGammaArray(found.market.outcomes);
  var prices = parseGammaArray(found.market.outcomePrices);
  if (!names || !prices || names.length !== prices.length) {
    return { marketProb: null, winIndex: -1 };
  }
  // When the sub-market was matched by its option title (a team/candidate),
  // betting that option = betting the sub-market resolves YES.
  var winIndex = found.via === "event-group-item"
    ? matchOutcomeIndex(names, "Yes")
    : matchOutcomeIndex(names, directionRaw);
  if (winIndex < 0) return { marketProb: null, winIndex: -1 };
  var p = parseFloat(prices[winIndex]);
  return { marketProb: (isNaN(p) ? null : p), winIndex: winIndex };
}

// Daily spend counter (append-safe-ish; settlement/investigation frequency is
// low). Bounds cost: "N per run" caps count, not tokens/searches.
async function bumpDailyInvestigationCost(env, webSearches) {
  if (!env.SIGNALS_CACHE) return;
  var day = new Date().toISOString().slice(0, 10);
  var key = "invest_cost:" + day;
  try {
    var c = await env.SIGNALS_CACHE.get(key, { type: "json" }) || { investigations: 0, webSearches: 0 };
    c.investigations += 1;
    c.webSearches += (webSearches || 0);
    await env.SIGNALS_CACHE.put(key, JSON.stringify(c), { expirationTtl: 7 * 24 * 60 * 60 });
  } catch (e) {
    console.log("Cost counter error:", e.message);
  }
}

async function investigationCountToday(env) {
  if (!env.SIGNALS_CACHE) return 0;
  var day = new Date().toISOString().slice(0, 10);
  try {
    var c = await env.SIGNALS_CACHE.get("invest_cost:" + day, { type: "json" });
    return c ? (c.investigations || 0) : 0;
  } catch (e) {
    return 0;
  }
}

// Investigate one signal: fetch the market's real resolution criteria + live
// price from Gamma, get an independent agent probability, store the verdict.
// Idempotent by stable key; failure-typed so it isn't retried forever.
// opts.force re-runs even a completed investigation.
async function investigateSignal(env, sig, opts) {
  opts = opts || {};
  if (!env.SIGNALS_CACHE) return { ok: false, error: "No cache configured" };
  if (!env.ANTHROPIC_API_KEY) return { ok: false, error: "ANTHROPIC_API_KEY not configured" };

  var marketSlug = sig.marketSlug;
  var directionRaw = sig.directionRaw || sig.direction;
  if (!marketSlug || !directionRaw) return { ok: false, error: "Signal missing slug/direction" };

  var invKey = investigationKeyFor(marketSlug, directionRaw);
  var maxAttempts = parseInt(env.INVESTIGATION_MAX_ATTEMPTS || "3", 10);

  var existing = await env.SIGNALS_CACHE.get(invKey, { type: "json" });
  if (existing && !opts.force) {
    if (existing.status === "done") return { ok: true, skipped: "already_done", investigation: existing };
    if (existing.status === "error_permanent") return { ok: false, skipped: "permanent_error", investigation: existing };
    if (existing.status === "error_transient" && (existing.attempts || 0) >= maxAttempts) {
      return { ok: false, skipped: "attempts_exhausted", investigation: existing };
    }
  }

  var attempts = (existing && existing.attempts) || 0;

  var writeInv = async function (rec) {
    rec.invKey = invKey;
    rec.marketSlug = marketSlug;
    rec.directionRaw = directionRaw;
    rec.updatedAt = new Date().toISOString();
    await env.SIGNALS_CACHE.put(invKey, JSON.stringify(rec), { expirationTtl: 45 * 24 * 60 * 60 });
    // Maintain a lightweight index for the /learning/brier aggregation.
    try {
      var idx = await env.SIGNALS_CACHE.get("investigation_index", { type: "json" }) || [];
      if (idx.indexOf(invKey) === -1) {
        idx.push(invKey);
        if (idx.length > 1000) idx = idx.slice(-1000);
        await env.SIGNALS_CACHE.put("investigation_index", JSON.stringify(idx));
      }
    } catch (e) {}
    return rec;
  };

  // Resolve the market on Gamma (criteria + live price).
  var found = await findGammaMarket(marketSlug, directionRaw);
  if (!found || !found.market) {
    // Could be a transient Gamma miss or an unresolvable slug. Bounded retry.
    attempts += 1;
    var rec = await writeInv({
      status: attempts >= maxAttempts ? "error_permanent" : "error_transient",
      attempts: attempts,
      lastError: "Gamma market not found",
      marketTitle: sig.marketTitle || null,
      detectedAt: sig.detectedAt || null
    });
    return { ok: false, error: "Gamma market not found", investigation: rec };
  }

  var description = (found.market.description || "").trim();
  var baseline = gammaBaselineForDirection(found, directionRaw);

  if (!description) {
    // Nothing to reason over - don't burn tokens or retry forever.
    var recNoDesc = await writeInv({
      status: "error_permanent",
      attempts: attempts,
      lastError: "Market has no resolution description",
      marketTitle: sig.marketTitle || found.market.question || null,
      marketProbAtInvestigation: baseline.marketProb,
      detectedAt: sig.detectedAt || null
    });
    return { ok: false, error: "No resolution description", investigation: recNoDesc };
  }

  var result = await callClaudeInvestigator(env, {
    marketTitle: sig.marketTitle || found.market.question,
    direction: directionRaw,
    resolutionCriteria: description,
    marketPricePct: baseline.marketProb !== null ? Math.round(baseline.marketProb * 100) : null,
    eventDate: sig.eventDate || found.market.endDate || null
  });

  await bumpDailyInvestigationCost(env, result.webSearches || 0);

  if (!result.ok) {
    attempts += 1;
    var permanent = result.error === "refusal" || attempts >= maxAttempts;
    var recErr = await writeInv({
      status: permanent ? "error_permanent" : "error_transient",
      attempts: attempts,
      lastError: result.error,
      marketTitle: sig.marketTitle || found.market.question || null,
      marketProbAtInvestigation: baseline.marketProb,
      detectedAt: sig.detectedAt || null
    });
    return { ok: false, error: result.error, investigation: recErr };
  }

  var edge = (baseline.marketProb !== null)
    ? Math.round((result.agentProb - baseline.marketProb) * 1000) / 10  // percentage points
    : null;

  var rec = await writeInv({
    status: "done",
    attempts: attempts,
    marketTitle: sig.marketTitle || found.market.question || null,
    agentProb: result.agentProb,
    confidence: result.confidence,
    reasoning: result.reasoning,
    keyFindings: result.keyFindings,
    model: result.model,
    webSearches: result.webSearches,
    marketProbAtInvestigation: baseline.marketProb,  // honest Brier baseline (live Gamma mid)
    entryPricePct: sig.avgEntryPrice || null,         // whale fill, ROI reference only
    edgePts: edge,                                    // agentProb - marketProb, in percentage points
    eventDate: sig.eventDate || found.market.endDate || null,
    detectedAt: sig.detectedAt || null,
    investigatedAt: new Date().toISOString(),
    // Brier fields, filled at settlement:
    outcome: null,
    y: null,
    agentBrier: null,
    marketBrier: null,
    settledBy: null,
    settledAt: null
  });

  return { ok: true, investigation: rec };
}

// Called from recordSignalOutcome. Only ground-truth (Gamma) WIN/LOSS
// settlements count - the trades heuristic and Odds API can mislabel, which
// would corrupt both the agent and the market baseline. UNKNOWN/void excluded.
async function recordBrierOutcome(env, signalData, outcome, meta) {
  if (!env.SIGNALS_CACHE) return;
  if (!meta || meta.settledBy !== "gamma") return;   // ground truth only
  if (outcome !== "WIN" && outcome !== "LOSS") return; // y must be 0 or 1

  var invKey = investigationKeyFor(signalData.marketSlug, signalData.directionRaw || signalData.direction);
  try {
    var inv = await env.SIGNALS_CACHE.get(invKey, { type: "json" });
    if (!inv || inv.status !== "done" || typeof inv.agentProb !== "number") return;
    if (inv.agentBrier !== null && inv.agentBrier !== undefined) return; // already scored

    var y = outcome === "WIN" ? 1 : 0;
    inv.outcome = outcome;
    inv.y = y;
    inv.agentBrier = Math.round(Math.pow(inv.agentProb - y, 2) * 10000) / 10000;
    inv.marketBrier = (typeof inv.marketProbAtInvestigation === "number")
      ? Math.round(Math.pow(inv.marketProbAtInvestigation - y, 2) * 10000) / 10000
      : null;
    inv.settledBy = "gamma";
    inv.settledAt = new Date().toISOString();
    inv.updatedAt = inv.settledAt;

    await env.SIGNALS_CACHE.put(invKey, JSON.stringify(inv), { expirationTtl: 45 * 24 * 60 * 60 });
    console.log("Brier scored " + invKey + ": agent=" + inv.agentBrier + " market=" + inv.marketBrier);
  } catch (e) {
    console.error("Error recording Brier outcome:", e.message);
  }
}

// Aggregate the calibration report from the immutable per-investigation records
// (aggregation on read avoids the KV read-modify-write race under concurrent
// cron invocations).
async function buildBrierReport(env) {
  if (!env.SIGNALS_CACHE) return null;
  var idx = await env.SIGNALS_CACHE.get("investigation_index", { type: "json" }) || [];

  var scored = [];
  var counts = { total: idx.length, done: 0, pending: 0, error: 0, scored: 0 };

  for (var i = 0; i < idx.length; i++) {
    var inv = await env.SIGNALS_CACHE.get(idx[i], { type: "json" });
    if (!inv) continue;
    if (inv.status === "done") counts.done++;
    else if (inv.status && inv.status.indexOf("error") === 0) counts.error++;
    else counts.pending++;
    if (typeof inv.agentBrier === "number" && typeof inv.marketBrier === "number") {
      scored.push(inv);
    }
  }
  counts.scored = scored.length;

  if (scored.length === 0) {
    return {
      note: "No ground-truth-settled investigations yet. The agent must call markets that later resolve via Gamma before calibration can be measured.",
      counts: counts,
      overall: null,
      byConfidence: null
    };
  }

  var sumAgent = 0, sumMarket = 0, agentBeats = 0, edgeDirCorrect = 0, edgeDirTotal = 0;
  var byConf = {};
  for (var s = 0; s < scored.length; s++) {
    var r = scored[s];
    sumAgent += r.agentBrier;
    sumMarket += r.marketBrier;
    if (r.agentBrier < r.marketBrier) agentBeats++;
    // Did the sign of the edge predict the outcome? (directional hit-rate)
    if (typeof r.edgePts === "number" && r.edgePts !== 0) {
      edgeDirTotal++;
      if ((r.edgePts > 0 && r.y === 1) || (r.edgePts < 0 && r.y === 0)) edgeDirCorrect++;
    }
    var c = r.confidence || "UNKNOWN";
    if (!byConf[c]) byConf[c] = { n: 0, agent: 0, market: 0 };
    byConf[c].n++; byConf[c].agent += r.agentBrier; byConf[c].market += r.marketBrier;
  }

  var n = scored.length;
  var round4 = function (x) { return Math.round(x * 10000) / 10000; };
  var confView = {};
  for (var key of Object.keys(byConf)) {
    confView[key] = {
      n: byConf[key].n,
      meanAgentBrier: round4(byConf[key].agent / byConf[key].n),
      meanMarketBrier: round4(byConf[key].market / byConf[key].n)
    };
  }

  return {
    note: "Brier score (lower is better). agentBeatsMarket / edgeDirection are honest but small-sample: this is a survivorship-biased set of markets that happened to resolve, self-reported confidence is uncalibrated (shown for description, not weighting), and N is small. Treat as directional until N is large.",
    counts: counts,
    overall: {
      n: n,
      meanAgentBrier: round4(sumAgent / n),
      meanMarketBrier: round4(sumMarket / n),
      meanPairedDiff: round4((sumMarket - sumAgent) / n),   // >0 means agent beats market on average
      agentBeatsMarketRate: Math.round((agentBeats / n) * 100),
      edgeDirectionHitRate: edgeDirTotal > 0 ? Math.round((edgeDirCorrect / edgeDirTotal) * 100) : null,
      edgeDirectionN: edgeDirTotal
    },
    byConfidence: confView
  };
}

// ============================================================
// SETTLEMENT CHECKER
// ============================================================

// Check if a market has settled and determine outcome
async function checkMarketSettlement(marketSlug, signalDetectedAt = null) {
  try {
    // Since Polymarket doesn't have direct market lookup, we check recent trades
    // If a market's last trade price is at 0.95+ or 0.05-, it's effectively settled
    
    // Fetch recent trades and look for ones matching our slug
    const tradesRes = await fetch(`${POLYMARKET_API}/trades?limit=2000`);
    if (!tradesRes.ok) {
      console.log(`Trades API error: ${tradesRes.status}`);
      return null;
    }
    
    const trades = await tradesRes.json();
    
    // Find trades for this market - EXACT match only on slug or eventSlug
    let marketTrades = trades.filter(t => 
      t.slug === marketSlug || 
      t.eventSlug === marketSlug
    );
    
    // If no exact match and this is a spread/total market, try matching base event slug
    if (marketTrades.length === 0 && (marketSlug.includes('-spread') || marketSlug.includes('-total') || marketSlug.includes('-over') || marketSlug.includes('-under'))) {
      // Extract base slug without the spread/total suffix
      const baseSlug = marketSlug.replace(/-spread.*$/, '').replace(/-total.*$/, '').replace(/-over.*$/, '').replace(/-under.*$/, '');
      
      // Only match if the trade slug EXACTLY equals our base slug
      marketTrades = trades.filter(t => 
        t.slug === baseSlug ||
        t.eventSlug === baseSlug
      );
    }
    
    // Check event date for time-based settlement
    const slugDateMatch = (marketSlug || '').match(/(\d{4})-(\d{2})-(\d{2})/);
    let hoursSinceEvent = 0;
    
    if (slugDateMatch) {
      const eventDate = new Date(
        parseInt(slugDateMatch[1]),
        parseInt(slugDateMatch[2]) - 1,
        parseInt(slugDateMatch[3]),
        23, 59, 59
      );
      
      const now = new Date();
      hoursSinceEvent = (now.getTime() - eventDate.getTime()) / (1000 * 60 * 60);
    } else if (signalDetectedAt) {
      // For events without dates in slug, use time since signal was detected
      // If signal was detected 48+ hours ago and no trades, likely settled
      const detectedTime = new Date(signalDetectedAt).getTime();
      const hoursSinceDetected = (Date.now() - detectedTime) / (1000 * 60 * 60);
      hoursSinceEvent = hoursSinceDetected;
    }
    
    if (marketTrades.length === 0) {
      // No trades found for this market
      
      // Sports events typically end within a few hours of their scheduled date
      // If it's been 12+ hours since end of event day (23:59 UTC) and no trades,
      // the market is definitely settled but we can't determine winner
      if (hoursSinceEvent > 12) {
        console.log(`Market ${marketSlug} is ${Math.round(hoursSinceEvent)}h past event with no recent trades - marking UNKNOWN`);
        return { 
          settled: true, 
          winningOutcome: "UNKNOWN", 
          resolutionPrice: 0,
          note: `Event ${Math.round(hoursSinceEvent)}h ago, no recent trades to determine outcome`
        };
      }
      
      // Return debug info about why not settling
      console.log(`No trades found for ${marketSlug} (event ${Math.round(hoursSinceEvent)}h ago, need >12h)`);
      return { 
        settled: false, 
        debug: {
          tradesFound: 0,
          hoursSinceEvent: Math.round(hoursSinceEvent),
          needsHours: 12,
          slugDateMatch: slugDateMatch ? slugDateMatch[0] : null
        }
      };
    }
    
    // Sort by timestamp to get most recent
    marketTrades.sort((a, b) => b.timestamp - a.timestamp);
    const latestTrade = marketTrades[0];
    const latestPrice = parseFloat(latestTrade.price);
    
    console.log(`Market ${marketSlug}: found ${marketTrades.length} trades, latest price=${latestPrice}, outcome=${latestTrade.outcome}, event ${Math.round(hoursSinceEvent)}h ago`);
    
    // STRICT settlement thresholds: 95%/5%
    // We don't want to falsely settle markets where someone is betting at 80-90%
    // Those bets could still lose!
    if (latestPrice >= 0.95) {
      return {
        settled: true,
        winningOutcome: latestTrade.outcome || "Yes",
        resolutionPrice: latestPrice
      };
    }
    
    if (latestPrice <= 0.05) {
      let winningOutcome = "No";
      if (latestTrade.outcome === "No") {
        winningOutcome = "Yes";
      } else if (latestTrade.outcome === "Yes") {
        winningOutcome = "No";
      }
      return {
        settled: true,
        winningOutcome: winningOutcome,
        resolutionPrice: 1 - latestPrice,
        losingOutcome: latestTrade.outcome
      };
    }
    
    // If event was long ago with ambiguous price, mark as unknown
    // 24h should be plenty of time for price to reach settlement levels
    if (hoursSinceEvent > 24) {
      console.log(`Market ${marketSlug} is ${Math.round(hoursSinceEvent)}h past event with ambiguous price ${latestPrice} - marking UNKNOWN`);
      return { 
        settled: true, 
        winningOutcome: "UNKNOWN", 
        resolutionPrice: latestPrice,
        note: `Event ${Math.round(hoursSinceEvent)}h ago, price=${latestPrice} ambiguous`
      };
    }
    
    // Not settled yet
    return { settled: false, currentPrice: latestPrice };
    
  } catch (e) {
    console.error(`Error checking settlement for ${marketSlug}:`, e.message);
    return null;
  }
}

// Process settled signals and update learning data
async function processSettledSignals(env) {
  if (!env.SIGNALS_CACHE) return { processed: 0, wins: 0, losses: 0 };
  
  const results = { processed: 0, wins: 0, losses: 0, errors: 0 };
  
  try {
    // Get pending signals
    let pendingSignals = await env.SIGNALS_CACHE.get(KV_KEYS.PENDING_SIGNALS, { type: "json" }) || [];
    const stillPending = [];
    
    console.log(`Checking ${pendingSignals.length} pending signals for settlement...`);
    
    for (const signalId of pendingSignals) {
      try {
        // Get signal data
        const signalKey = KV_KEYS.SIGNALS_PREFIX + signalId;
        const signalData = await env.SIGNALS_CACHE.get(signalKey, { type: "json" });
        
        if (!signalData) {
          continue; // Signal expired or deleted
        }
        
        // Skip if already settled
        if (signalData.outcome) {
          continue;
        }
        
        // The signal's directionRaw is the exact Polymarket outcome name;
        // fall back to the display direction for older stored signals.
        const settleDirection = signalData.directionRaw || signalData.direction;

        // ---- PRIMARY: Gamma API ground truth --------------------------
        // Gamma reports authoritative Polymarket resolution, which is what
        // actually determines whether the bet paid. Try it first for every
        // market type.
        const gamma = await settleWithGamma(signalData.marketSlug, settleDirection);

        if (gamma.status === "settled") {
          await recordSignalOutcome(env, signalKey, signalData, gamma.outcome, {
            settledBy: "gamma",
            winningOutcome: gamma.winningOutcome,
            note: gamma.note
          });
          results.processed += 1;
          if (gamma.outcome === "WIN") results.wins += 1;
          else if (gamma.outcome === "LOSS") results.losses += 1;
          console.log(`Signal ${signalId} settled via Gamma: ${gamma.outcome}${gamma.winningOutcome ? " (winner: " + gamma.winningOutcome + ")" : ""}`);
          continue;
        }

        if (gamma.status === "open") {
          // Gamma confirms the market is still trading - authoritative, no
          // need to consult fallbacks.
          stillPending.push(signalId);
          continue;
        }
        // gamma.status is "not_found" or "closed_unresolved" - fall through
        // to the fallbacks below.

        // ---- FALLBACK 1: The Odds API (sports only) -------------------
        const sport = detectSportFromSlug(signalData.marketSlug);

        if (sport && SPORT_KEY_MAP[sport] && env.ODDS_API_KEY) {
          const oddsApiResult = await settleWithOddsAPI(env, signalData.marketSlug, settleDirection);

          if (oddsApiResult && oddsApiResult.status === 'settled') {
            await recordSignalOutcome(env, signalKey, signalData, oddsApiResult.outcome, {
              settledBy: "odds-api",
              winningOutcome: oddsApiResult.winner || oddsApiResult.spreadWinner,
              gameScore: `${oddsApiResult.homeScore}-${oddsApiResult.awayScore}`
            });
            results.processed += 1;
            if (oddsApiResult.outcome === "WIN") results.wins += 1;
            else results.losses += 1;
            console.log(`Signal ${signalId} settled via Odds API: ${oddsApiResult.outcome} (${oddsApiResult.homeScore}-${oddsApiResult.awayScore})`);
            continue;
          } else if (oddsApiResult && oddsApiResult.status === 'pending') {
            stillPending.push(signalId);
            continue;
          }
          // If Odds API failed or no match, fall back to trades method
        }

        // ---- FALLBACK 2: Polymarket trades heuristic -----------------
        const settlement = await checkMarketSettlement(signalData.marketSlug, signalData.detectedAt);

        if (!settlement || !settlement.settled) {
          stillPending.push(signalId);
          continue;
        }

        // Handle UNKNOWN outcomes (API data unavailable but event passed)
        if (settlement.winningOutcome === "UNKNOWN") {
          console.log(`Signal ${signalId} has unknown outcome - removing from pending`);
          await recordSignalOutcome(env, signalKey, signalData, "UNKNOWN", {
            settledBy: "trades-heuristic",
            note: settlement.note
          });
          results.processed += 1;
          continue;
        }

        // Determine if our signal won or lost
        const signalDirection = (settleDirection || "").toLowerCase();
        const winningOutcome = (settlement.winningOutcome || "").toLowerCase();

        // Normalize direction names for comparison
        // Handle cases like "Hornets" vs "yes", "Cortes-Acosta" vs "Yes"
        let outcome = "LOSS";

        // Direct match
        if (signalDirection === winningOutcome) {
          outcome = "WIN";
        }
        // Yes/No normalization
        else if ((signalDirection === "yes" || signalDirection === "true") &&
                 (winningOutcome === "yes" || winningOutcome === "true")) {
          outcome = "WIN";
        }
        else if ((signalDirection === "no" || signalDirection === "false") &&
                 (winningOutcome === "no" || winningOutcome === "false")) {
          outcome = "WIN";
        }
        // If direction contains team name and outcome is "yes", check if it was the favored team
        // This is tricky - for now, if price went to 0.95+ and we bet on that side, we won
        else if (settlement.resolutionPrice >= 0.90) {
          // High price = YES won
          if (signalDirection === "yes" ||
              signalDirection.includes("over") ||
              signalDirection.includes("cover")) {
            outcome = "WIN";
          }
        }
        else if (settlement.resolutionPrice <= 0.10) {
          // Low price = NO won
          if (signalDirection === "no" ||
              signalDirection.includes("under") ||
              signalDirection.includes("fail")) {
            outcome = "WIN";
          }
        }

        await recordSignalOutcome(env, signalKey, signalData, outcome, {
          settledBy: "trades-heuristic",
          winningOutcome: settlement.winningOutcome
        });

        results.processed += 1;
        if (outcome === "WIN") {
          results.wins += 1;
        } else {
          results.losses += 1;
        }

        console.log(`Signal ${signalId} settled via trades heuristic: ${outcome}`);

      } catch (e) {
        console.error(`Error processing signal ${signalId}:`, e.message);
        results.errors += 1;
        stillPending.push(signalId); // Keep for retry
      }
    }
    
    // Update pending list
    await env.SIGNALS_CACHE.put(KV_KEYS.PENDING_SIGNALS, JSON.stringify(stillPending));
    
    console.log(`Settlement check complete: ${results.processed} processed, ${results.wins} wins, ${results.losses} losses`);
    
  } catch (e) {
    console.error("Error in settlement checker:", e.message);
  }
  
  return results;
}

// Helper to detect market type from title
function detectMarketType(title) {
  const titleLower = (title || "").toLowerCase();
  
  if (POLITICAL_KEYWORDS.some(k => titleLower.includes(k))) return "political";
  if (SPORTS_KEYWORDS.some(k => titleLower.includes(k))) return "sports";
  if (CRYPTO_KEYWORDS.some(k => titleLower.includes(k))) return "crypto";
  return "other";
}

// ============================================================
// PHASE 2: ADVANCED LEARNING FEATURES
// ============================================================

// LINE MOVEMENT TRACKING
// Track price changes after whale bets to see if market confirms
var KV_LINE_MOVEMENT_PREFIX = "line:";

async function trackLineMovement(env, marketSlug, direction, entryPrice, signalId) {
  if (!env.SIGNALS_CACHE) return;
  
  const key = KV_LINE_MOVEMENT_PREFIX + signalId;
  const data = {
    marketSlug,
    direction,
    entryPrice,
    signalId,
    trackedAt: Date.now(),
    priceAfter5min: null,
    priceAfter30min: null,
    priceAfter1hr: null,
    priceAfter2hr: null,
    movementPct: null,
    confirmed: null  // true if line moved in our direction
  };
  
  try {
    await env.SIGNALS_CACHE.put(key, JSON.stringify(data), {
      expirationTtl: 24 * 60 * 60  // Keep for 24 hours
    });
  } catch (e) {
    console.error("Error tracking line movement:", e.message);
  }
}

async function checkLineMovement(env, marketSlug) {
  try {
    // Fetch recent trades and find ones for this market
    const tradesRes = await fetch(`${POLYMARKET_API}/trades?limit=500`);
    if (!tradesRes.ok) return null;
    
    const trades = await tradesRes.json();
    
    // Find trades for this market
    const marketTrades = trades.filter(t => 
      t.slug === marketSlug || 
      t.eventSlug === marketSlug ||
      (t.slug && t.slug.includes(marketSlug)) ||
      (marketSlug && marketSlug.includes(t.slug))
    );
    
    if (marketTrades.length === 0) return null;
    
    // Get most recent trade price
    marketTrades.sort((a, b) => b.timestamp - a.timestamp);
    const latestTrade = marketTrades[0];
    const currentPrice = parseFloat(latestTrade.price);
    
    return { currentPrice, market: latestTrade };
  } catch (e) {
    console.error("Error checking line movement:", e.message);
    return null;
  }
}

async function updateLineMovements(env) {
  if (!env.SIGNALS_CACHE) return { updated: 0, confirmed: 0 };
  
  const results = { updated: 0, confirmed: 0, total: 0 };
  
  try {
    // Get pending signals to check line movement
    const pendingSignals = await env.SIGNALS_CACHE.get(KV_KEYS.PENDING_SIGNALS, { type: "json" }) || [];
    
    for (const signalId of pendingSignals.slice(0, 20)) {  // Check first 20
      const lineKey = KV_LINE_MOVEMENT_PREFIX + signalId;
      const lineData = await env.SIGNALS_CACHE.get(lineKey, { type: "json" });
      
      if (!lineData) continue;
      
      results.total++;
      const elapsed = Date.now() - lineData.trackedAt;
      const minutes = elapsed / (1000 * 60);
      
      // Check current price
      const priceCheck = await checkLineMovement(env, lineData.marketSlug);
      
      let currentPrice = lineData.entryPrice;  // Default to entry if no update
      if (priceCheck && priceCheck.currentPrice) {
        currentPrice = priceCheck.currentPrice * 100;  // Convert to percentage
      }
      
      const entryPrice = lineData.entryPrice;
      
      // ALWAYS store current price for UI display
      lineData.currentPrice = Math.round(currentPrice);
      
      // Update price snapshots based on elapsed time
      let updated = false;
      if (minutes >= 5 && !lineData.priceAfter5min) {
        lineData.priceAfter5min = currentPrice;
        updated = true;
      }
      if (minutes >= 30 && !lineData.priceAfter30min) {
        lineData.priceAfter30min = currentPrice;
        updated = true;
      }
      if (minutes >= 60 && !lineData.priceAfter1hr) {
        lineData.priceAfter1hr = currentPrice;
        updated = true;
      }
      if (minutes >= 120 && !lineData.priceAfter2hr) {
        lineData.priceAfter2hr = currentPrice;
        updated = true;
      }
      
      // Calculate movement percentage
      const latestPrice = lineData.priceAfter2hr || lineData.priceAfter1hr || 
                          lineData.priceAfter30min || lineData.priceAfter5min || currentPrice;
      
      // For YES bets, positive movement = price went up
      // For NO bets, positive movement = price went down
      const direction = lineData.direction?.toLowerCase();
      let movement;
      if (direction === "yes" || direction === "over") {
        movement = latestPrice - entryPrice;
      } else {
        movement = entryPrice - latestPrice;
      }
      
      lineData.movementPct = Math.round(movement * 10) / 10;
      lineData.confirmed = movement > 2;  // Line moved 2%+ in our direction
      
      if (updated) {
        await env.SIGNALS_CACHE.put(lineKey, JSON.stringify(lineData), {
          expirationTtl: 24 * 60 * 60
        });
        results.updated++;
        if (lineData.confirmed) results.confirmed++;
      }
    }
  } catch (e) {
    console.error("Error updating line movements:", e.message);
  }
  
  return results;
}

// Get line movement score bonus for a signal
async function getLineMovementBonus(env, signalId) {
  if (!env.SIGNALS_CACHE) return { bonus: 0, movement: null };
  
  try {
    const lineKey = KV_LINE_MOVEMENT_PREFIX + signalId;
    const lineData = await env.SIGNALS_CACHE.get(lineKey, { type: "json" });
    
    if (!lineData || lineData.movementPct === null) {
      return { bonus: 0, movement: null };
    }
    
    const movement = lineData.movementPct;
    
    if (movement >= 10) {
      return { bonus: SCORES.LINE_MOVE_STRONG, movement, label: "📈 Line moved +10%!" };
    } else if (movement >= 5) {
      return { bonus: SCORES.LINE_MOVE_MODERATE, movement, label: "📈 Line moved +5%" };
    } else if (movement >= 2) {
      return { bonus: SCORES.LINE_MOVE_SLIGHT, movement, label: "📈 Line confirming" };
    } else if (movement <= -5) {
      return { bonus: -10, movement, label: "📉 Line moving against" };
    }
    
    return { bonus: 0, movement };
  } catch (e) {
    return { bonus: 0, movement: null };
  }
}

// SHARP VS PUBLIC DETECTION
// Analyze if whales are betting opposite of small bettors
function analyzeSharpVsPublic(trades) {
  if (!trades || trades.length < 5) return null;
  
  const WHALE_THRESHOLD = 5000;
  const SMALL_THRESHOLD = 500;
  
  let whaleVolumeYes = 0;
  let whaleVolumeNo = 0;
  let publicVolumeYes = 0;
  let publicVolumeNo = 0;
  let whaleCount = 0;
  let publicCount = 0;
  
  for (const trade of trades) {
    const amount = trade._usdValue || parseFloat(trade.usd_value) || 0;
    const outcome = (trade.outcome || "").toLowerCase();
    const isYes = outcome === "yes" || outcome.includes("over");
    
    if (amount >= WHALE_THRESHOLD) {
      whaleCount++;
      if (isYes) {
        whaleVolumeYes += amount;
      } else {
        whaleVolumeNo += amount;
      }
    } else if (amount <= SMALL_THRESHOLD && amount > 0) {
      publicCount++;
      if (isYes) {
        publicVolumeYes += amount;
      } else {
        publicVolumeNo += amount;
      }
    }
  }
  
  if (whaleCount < 1 || publicCount < 3) return null;
  
  const whaleTotalVolume = whaleVolumeYes + whaleVolumeNo;
  const publicTotalVolume = publicVolumeYes + publicVolumeNo;
  
  if (whaleTotalVolume < WHALE_THRESHOLD || publicTotalVolume < 1000) return null;
  
  // Calculate direction preferences
  const whaleYesPct = whaleTotalVolume > 0 ? (whaleVolumeYes / whaleTotalVolume) * 100 : 50;
  const publicYesPct = publicTotalVolume > 0 ? (publicVolumeYes / publicTotalVolume) * 100 : 50;
  
  // Check for divergence: whales heavily one way, public heavily the other
  const divergence = Math.abs(whaleYesPct - publicYesPct);
  
  if (divergence >= 40) {
    // Strong divergence - whales vs public
    const whaleDirection = whaleYesPct > 50 ? "YES" : "NO";
    const publicDirection = publicYesPct > 50 ? "YES" : "NO";
    
    return {
      detected: true,
      divergence: Math.round(divergence),
      whaleDirection,
      whaleVolume: Math.round(whaleTotalVolume),
      whaleYesPct: Math.round(whaleYesPct),
      publicDirection,
      publicVolume: Math.round(publicTotalVolume),
      publicYesPct: Math.round(publicYesPct),
      whaleCount,
      publicCount,
      bonus: divergence >= 60 ? SCORES.SHARP_VS_PUBLIC : SCORES.SMART_MONEY_FADE,
      label: `🎯 Sharp vs Public: Whales ${whaleDirection} (${Math.round(whaleYesPct)}%), Public ${publicDirection} (${Math.round(publicYesPct)}%)`
    };
  }
  
  return null;
}

// APPLY LEARNED FACTOR WEIGHTS TO SCORING
async function applyLearnedWeights(env, baseScore, factors) {
  if (!env.SIGNALS_CACHE || !factors || factors.length === 0) {
    return baseScore;
  }
  
  try {
    const factorStats = await env.SIGNALS_CACHE.get(KV_KEYS.FACTOR_STATS, { type: "json" }) || {};
    
    // Calculate weighted adjustment
    let totalWeight = 0;
    let weightedSum = 0;
    
    for (const factor of factors) {
      const stats = factorStats[factor];
      if (stats && stats.wins + stats.losses >= 10) {  // Need minimum sample size
        const weight = stats.weight || 1.0;
        totalWeight += 1;
        weightedSum += weight;
      }
    }
    
    if (totalWeight === 0) return baseScore;
    
    // Calculate average weight multiplier
    const avgWeight = weightedSum / totalWeight;
    
    // Apply multiplier (capped between 0.7 and 1.5)
    const cappedMultiplier = Math.max(0.7, Math.min(1.5, avgWeight));
    
    return Math.round(baseScore * cappedMultiplier);
  } catch (e) {
    console.error("Error applying learned weights:", e.message);
    return baseScore;
  }
}

// GET WALLET TIER BONUS/PENALTY FOR SCORING
async function getWalletTierMultiplier(env, walletAddresses) {
  if (!env.SIGNALS_CACHE || !walletAddresses || walletAddresses.length === 0) {
    return { multiplier: 1.0, bestTier: null, bestWallet: null };
  }
  
  let bestMultiplier = 1.0;
  let bestTier = null;
  let bestWallet = null;
  let worstMultiplier = 1.0;
  let fadeWallet = null;
  
  try {
    for (const wallet of walletAddresses) {
      const stats = await getWalletStats(env, wallet);
      if (!stats || !stats.tierInfo) continue;
      
      const tier = stats.tierInfo.tier;
      const multiplier = stats.tierInfo.scoreBoost;
      
      // Track best performer
      if (tier === "ELITE" || tier === "STRONG") {
        if (multiplier > bestMultiplier) {
          bestMultiplier = multiplier;
          bestTier = tier;
          bestWallet = wallet;
        }
      }
      
      // Track worst performer (FADE)
      if (tier === "FADE" && multiplier < worstMultiplier) {
        worstMultiplier = multiplier;
        fadeWallet = wallet;
      }
    }
    
    // If we have a FADE wallet, that takes precedence (we want to fade bad bettors)
    if (fadeWallet && worstMultiplier < 1.0) {
      return { 
        multiplier: worstMultiplier, 
        bestTier: "FADE", 
        bestWallet: fadeWallet,
        label: `🚫 FADE ALERT: Known losing wallet`
      };
    }
    
    if (bestTier) {
      const emoji = bestTier === "ELITE" ? "🏆" : "💪";
      return {
        multiplier: bestMultiplier,
        bestTier,
        bestWallet,
        label: `${emoji} ${bestTier} wallet involved`
      };
    }
    
    return { multiplier: 1.0, bestTier: null, bestWallet: null };
  } catch (e) {
    console.error("Error getting wallet tier:", e.message);
    return { multiplier: 1.0, bestTier: null, bestWallet: null };
  }
}

// GET STREAK BONUS FOR HOT/COLD WALLETS
async function getStreakBonus(env, walletAddresses) {
  if (!env.SIGNALS_CACHE || !walletAddresses || walletAddresses.length === 0) {
    return { bonus: 0, streak: null, wallet: null };
  }
  
  let bestStreak = 0;
  let streakWallet = null;
  
  try {
    for (const wallet of walletAddresses) {
      const stats = await getWalletStats(env, wallet);
      if (!stats) continue;
      
      const streak = stats.currentStreak || 0;
      
      if (Math.abs(streak) > Math.abs(bestStreak)) {
        bestStreak = streak;
        streakWallet = wallet;
      }
    }
    
    if (bestStreak >= 5) {
      return {
        bonus: SCORES.HOT_STREAK_BONUS,
        streak: bestStreak,
        wallet: streakWallet,
        label: `🔥 ${bestStreak} win streak!`
      };
    } else if (bestStreak <= -5) {
      return {
        bonus: SCORES.COLD_STREAK_PENALTY,
        streak: bestStreak,
        wallet: streakWallet,
        label: `❄️ ${Math.abs(bestStreak)} loss streak - fade?`
      };
    }
    
    return { bonus: 0, streak: bestStreak, wallet: streakWallet };
  } catch (e) {
    return { bonus: 0, streak: null, wallet: null };
  }
}

// ============================================================
// PHASE 3: INTELLIGENCE & AUTO-OPTIMIZATION
// ============================================================

// CONFIDENCE SCORE CALCULATION
// Based on historical accuracy of factors + wallet track record
async function calculateConfidence(env, factors, walletAddresses, score) {
  if (!env.SIGNALS_CACHE) {
    return { confidence: 50, level: "MEDIUM", factors: [] };
  }
  
  try {
    const factorStats = await env.SIGNALS_CACHE.get(KV_KEYS.FACTOR_STATS, { type: "json" }) || {};
    
    let totalSamples = 0;
    let weightedWinRate = 0;
    const factorConfidence = [];
    
    // Calculate confidence from factors
    for (const factor of factors) {
      const stats = factorStats[factor];
      if (stats && (stats.wins + stats.losses) >= 5) {
        const samples = stats.wins + stats.losses;
        const winRate = stats.winRate;
        totalSamples += samples;
        weightedWinRate += winRate * samples;
        
        factorConfidence.push({
          factor,
          winRate,
          samples,
          weight: stats.weight
        });
      }
    }
    
    // Get wallet confidence
    let walletConfidence = 50;
    let bestWalletWinRate = null;
    for (const wallet of walletAddresses.slice(0, 5)) {
      const stats = await getWalletStats(env, wallet);
      if (stats && stats.totalBets >= 5) {
        if (!bestWalletWinRate || stats.winRate > bestWalletWinRate) {
          bestWalletWinRate = stats.winRate;
          walletConfidence = stats.winRate;
        }
      }
    }
    
    // Calculate overall confidence
    let confidence;
    if (totalSamples > 0) {
      const factorAvgWinRate = weightedWinRate / totalSamples;
      // Blend factor confidence with wallet confidence (60/40 split)
      confidence = Math.round(factorAvgWinRate * 0.6 + walletConfidence * 0.4);
    } else {
      // No factor data yet, use wallet confidence or base on score
      confidence = bestWalletWinRate || Math.min(70, 40 + score / 5);
    }
    
    // Determine confidence level
    let level;
    let emoji;
    if (confidence >= 75) {
      level = "VERY HIGH";
      emoji = "🔥";
    } else if (confidence >= 65) {
      level = "HIGH";
      emoji = "✅";
    } else if (confidence >= 55) {
      level = "MEDIUM";
      emoji = "📊";
    } else if (confidence >= 45) {
      level = "LOW";
      emoji = "⚠️";
    } else {
      level = "VERY LOW";
      emoji = "❌";
    }
    
    return {
      confidence,
      level,
      emoji,
      label: `${emoji} ${confidence}% confidence (${level})`,
      factorBreakdown: factorConfidence,
      walletWinRate: bestWalletWinRate,
      totalHistoricalSamples: totalSamples
    };
  } catch (e) {
    console.error("Error calculating confidence:", e.message);
    return { confidence: 50, level: "MEDIUM", factors: [] };
  }
}

// WALLET SPECIALIZATION ANALYSIS
// Find what markets a wallet is best/worst at
async function getWalletSpecialization(env, walletAddress) {
  if (!env.SIGNALS_CACHE || !walletAddress) return null;
  
  try {
    const stats = await getWalletStats(env, walletAddress);
    if (!stats || !stats.markets) return null;
    
    const specializations = [];
    
    for (const [marketType, data] of Object.entries(stats.markets)) {
      const totalBets = data.wins + data.losses;
      if (totalBets >= 3) {  // Need minimum sample
        specializations.push({
          marketType,
          wins: data.wins,
          losses: data.losses,
          winRate: data.winRate,
          totalBets,
          edge: data.winRate - 50  // How much better than 50%
        });
      }
    }
    
    // Sort by edge (best to worst)
    specializations.sort((a, b) => b.edge - a.edge);
    
    const bestAt = specializations.filter(s => s.edge > 10);
    const worstAt = specializations.filter(s => s.edge < -10);
    
    return {
      address: walletAddress,
      overallWinRate: stats.winRate,
      totalBets: stats.totalBets,
      specializations,
      bestAt: bestAt.length > 0 ? bestAt[0] : null,
      worstAt: worstAt.length > 0 ? worstAt[worstAt.length - 1] : null,
      recommendation: bestAt.length > 0 
        ? `Strong at ${bestAt.map(s => s.marketType).join(", ")}`
        : "No clear specialization yet"
    };
  } catch (e) {
    console.error("Error getting wallet specialization:", e.message);
    return null;
  }
}

// CHECK IF THIS IS A FADE OPPORTUNITY
// When a known losing wallet bets big, we might want to bet the opposite
async function checkFadeOpportunity(env, walletAddresses, direction, betAmount) {
  if (!env.SIGNALS_CACHE || betAmount < 10000) return null;
  
  try {
    for (const wallet of walletAddresses) {
      const stats = await getWalletStats(env, wallet);
      if (!stats) continue;
      
      // Check if this is a known losing wallet with enough history
      if (stats.totalBets >= 10 && stats.winRate <= 40) {
        const oppositeDirection = direction.toLowerCase() === "yes" ? "NO" : "YES";
        
        return {
          isFade: true,
          fadeWallet: wallet,
          walletWinRate: stats.winRate,
          walletRecord: `${stats.wins}W-${stats.losses}L`,
          currentStreak: stats.currentStreak,
          originalDirection: direction,
          fadeDirection: oppositeDirection,
          betAmount,
          confidence: Math.round(100 - stats.winRate),  // Inverse of their win rate
          label: `🚨 FADE ALERT: Losing wallet (${stats.winRate}%) bet ${direction}. Consider ${oppositeDirection}!`,
          reasoning: `This wallet has a ${stats.winRate}% win rate over ${stats.totalBets} bets. ` +
                    `They're betting ${direction}. Historical data suggests betting ${oppositeDirection} may be profitable.`
        };
      }
    }
    
    return null;
  } catch (e) {
    console.error("Error checking fade opportunity:", e.message);
    return null;
  }
}

// AUTO-OPTIMIZE SCORING WEIGHTS
// Periodically recalculate optimal weights based on outcomes
async function optimizeFactorWeights(env) {
  if (!env.SIGNALS_CACHE) return { optimized: false };
  
  try {
    const factorStats = await env.SIGNALS_CACHE.get(KV_KEYS.FACTOR_STATS, { type: "json" }) || {};
    
    const optimizations = [];
    let totalOptimized = 0;
    
    for (const [factor, stats] of Object.entries(factorStats)) {
      const totalBets = stats.wins + stats.losses;
      if (totalBets < 15) continue;  // Need enough data
      
      const winRate = stats.winRate;
      const oldWeight = stats.weight;
      
      // Calculate new weight based on performance
      // Base weight is 1.0, adjusted by win rate performance
      // 50% win rate = 1.0 weight
      // 70% win rate = 1.4 weight
      // 30% win rate = 0.6 weight
      let newWeight = 0.4 + (winRate / 100) * 1.2;
      
      // Apply smoothing (don't change too drastically)
      newWeight = oldWeight * 0.7 + newWeight * 0.3;
      
      // Clamp to reasonable range
      newWeight = Math.max(0.3, Math.min(2.5, newWeight));
      newWeight = Math.round(newWeight * 100) / 100;
      
      if (Math.abs(newWeight - oldWeight) > 0.05) {
        stats.weight = newWeight;
        stats.previousWeight = oldWeight;
        stats.optimizedAt = new Date().toISOString();
        totalOptimized++;
        
        optimizations.push({
          factor,
          winRate,
          samples: totalBets,
          oldWeight,
          newWeight,
          change: Math.round((newWeight - oldWeight) * 100) / 100
        });
      }
    }
    
    if (totalOptimized > 0) {
      await env.SIGNALS_CACHE.put(KV_KEYS.FACTOR_STATS, JSON.stringify(factorStats));
    }
    
    return {
      optimized: true,
      totalFactors: Object.keys(factorStats).length,
      totalOptimized,
      optimizations
    };
  } catch (e) {
    console.error("Error optimizing weights:", e.message);
    return { optimized: false, error: e.message };
  }
}

// GET LEARNING SYSTEM INSIGHTS
// Summary of what the system has learned
async function getLearningInsights(env) {
  if (!env.SIGNALS_CACHE) return null;
  
  try {
    const factorStats = await env.SIGNALS_CACHE.get(KV_KEYS.FACTOR_STATS, { type: "json" }) || {};
    const pendingSignals = await env.SIGNALS_CACHE.get(KV_KEYS.PENDING_SIGNALS, { type: "json" }) || [];
    
    // Analyze factors
    const factorAnalysis = [];
    let totalWins = 0;
    let totalLosses = 0;
    
    for (const [factor, stats] of Object.entries(factorStats)) {
      totalWins += stats.wins || 0;
      totalLosses += stats.losses || 0;
      
      if ((stats.wins + stats.losses) >= 5) {
        factorAnalysis.push({
          factor,
          winRate: stats.winRate,
          wins: stats.wins,
          losses: stats.losses,
          weight: stats.weight,
          performance: stats.winRate >= 60 ? "STRONG" : stats.winRate >= 50 ? "AVERAGE" : "WEAK"
        });
      }
    }
    
    // Sort by win rate
    factorAnalysis.sort((a, b) => b.winRate - a.winRate);
    
    // Identify best and worst factors
    const bestFactors = factorAnalysis.filter(f => f.winRate >= 60).slice(0, 5);
    const worstFactors = factorAnalysis.filter(f => f.winRate < 45).slice(-5).reverse();
    
    // Overall system performance
    const overallWinRate = totalWins + totalLosses > 0 
      ? Math.round((totalWins / (totalWins + totalLosses)) * 100) 
      : 0;
    
    return {
      systemPerformance: {
        totalSignalsProcessed: totalWins + totalLosses,
        wins: totalWins,
        losses: totalLosses,
        winRate: overallWinRate,
        pendingSignals: pendingSignals.length
      },
      insights: {
        bestFactors,
        worstFactors,
        recommendation: bestFactors.length > 0 
          ? `Focus on signals with: ${bestFactors.map(f => f.factor).join(", ")}`
          : "Need more data to generate recommendations"
      },
      allFactors: factorAnalysis
    };
  } catch (e) {
    console.error("Error getting learning insights:", e.message);
    return null;
  }
}

// GENERATE SMART ALERT MESSAGE
// Create intelligent alert with confidence and context
async function generateSmartAlert(env, signal) {
  const factors = [];
  
  // Extract factors from breakdown
  for (const key of Object.keys(signal.scoreBreakdown || {})) {
    if (key.includes("whale") || key.includes("Whale")) factors.push("whaleSize");
    if (key.includes("Fresh") || key.includes("fresh")) factors.push("freshWallet");
    if (key.includes("Last-minute") || key.includes("last-minute")) factors.push("lastMinute");
    if (key.includes("Concentrated")) factors.push("concentrated");
    if (key.includes("ELITE") || key.includes("STRONG")) factors.push("eliteWallet");
    if (key.includes("Sharp")) factors.push("sharpVsPublic");
    if (key.includes("streak")) factors.push("streak");
  }
  
  // Get confidence
  const wallets = signal.topTrades?.map(t => t.wallet).filter(Boolean) || [];
  const confidence = await calculateConfidence(env, factors, wallets, signal.score);
  
  // Check for fade opportunity
  const fadeCheck = await checkFadeOpportunity(env, wallets, signal.direction, signal.largestBet);
  
  // Build smart message
  let message = `🚨 SIGNAL: ${signal.marketTitle}\n`;
  message += `${signal.direction} @ ${signal.avgEntryPrice}%\n`;
  message += `Score: ${signal.score} | ${confidence.label}\n`;
  message += `Bet: $${signal.largestBet.toLocaleString()}\n`;
  
  if (fadeCheck && fadeCheck.isFade) {
    message += `\n⚠️ FADE CONSIDERATION:\n${fadeCheck.reasoning}\n`;
  }
  
  if (confidence.walletWinRate && confidence.walletWinRate >= 65) {
    message += `\n🏆 Top wallet: ${confidence.walletWinRate}% win rate`;
  }
  
  return {
    message,
    confidence,
    fadeOpportunity: fadeCheck,
    factors
  };
}

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
    // Assume event is at 7pm EST = midnight UTC (next day technically, but close enough)
    // 7pm EST = 00:00 UTC next day, so we use 23:59 UTC same day as a safe approximation
    // This means we assume games end by midnight UTC
    return new Date(Date.UTC(eventYear, eventMonth, eventDay, 23, 59, 0));
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
    
    // Assume event ends by midnight UTC
    return new Date(Date.UTC(year, month, day, 23, 59, 0));
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
  
  // Use the more accurate PnL calculation for win rate
  try {
    const pnlResult = await getWalletPnL(walletAddress);
    
    if (!pnlResult || !pnlResult.success) {
      return null;
    }
    
    const { summary } = pnlResult;
    
    const stats = {
      walletAddress,
      wins: summary.winCount,
      losses: summary.lossCount,
      totalResolved: summary.winCount + summary.lossCount,
      winRate: summary.winRate,
      totalWinnings: summary.totalWins,
      totalLost: summary.totalLosses,
      profitLoss: summary.realizedPnL,
      meetsMinimum: (summary.winCount + summary.lossCount) >= WALLET_TRACK_RECORD.MIN_BETS,
      cachedAt: Date.now(),
      recentBets: pnlResult.resolvedBets?.slice(0, 10) || []
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
function hasEventStarted(title, slug, avgPrice) {
  const now = Date.now();
  
  // Calculate EST time (UTC - 5 hours)
  const EST_OFFSET = -5 * 60 * 60 * 1000;
  const estNow = new Date(now + EST_OFFSET);
  const currentHourEST = estNow.getUTCHours();
  
  // Get today's date in EST as YYYY-MM-DD string
  const todayYear = estNow.getUTCFullYear();
  const todayMonth = estNow.getUTCMonth() + 1;
  const todayDay = estNow.getUTCDate();
  const todayStr = `${todayYear}-${String(todayMonth).padStart(2, '0')}-${String(todayDay).padStart(2, '0')}`;
  
  // If odds are extreme (>95% or <5%), event is likely decided/in-progress
  // Lowered threshold from 97/3 to catch more resolved games
  if (avgPrice > 0.95 || avgPrice < 0.05) {
    return true;
  }
  
  // Try to extract date from slug (format: 2026-01-22)
  const slugDateMatch = (slug || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (slugDateMatch) {
    const eventYear = parseInt(slugDateMatch[1]);
    const eventMonth = parseInt(slugDateMatch[2]);
    const eventDay = parseInt(slugDateMatch[3]);
    
    // Compare just the date portions as strings (YYYY-MM-DD)
    const eventDateStr = `${eventYear}-${String(eventMonth).padStart(2, '0')}-${String(eventDay).padStart(2, '0')}`;
    
    // If event date is before today, it has definitely ended
    if (eventDateStr < todayStr) {
      return true;
    }
    
    // For same-day events, use time-based heuristics
    if (eventDateStr === todayStr) {
      // Sports events typically:
      // - NCAA/NBA games: Usually 2-3 hours long, start in afternoon/evening
      // - NFL games: 3-4 hours
      // 
      // If it's after 6pm EST and odds are somewhat directional (>75% or <25%), 
      // the game is likely in progress or finished
      if (currentHourEST >= 18 && (avgPrice > 0.75 || avgPrice < 0.25)) {
        return true;
      }
      
      // After 10pm EST with any directional odds = likely over
      if (currentHourEST >= 22 && (avgPrice > 0.65 || avgPrice < 0.35)) {
        return true;
      }
      
      // After 11pm EST = most US sports are done
      if (currentHourEST >= 23) {
        return true;
      }
    }
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
      
      // ============================================
      // LEARNING SYSTEM ENDPOINTS
      // ============================================
      
      // Get learning stats overview
      if (path === "/learning/stats") {
        if (!env.SIGNALS_CACHE) {
          return new Response(JSON.stringify({ error: "No cache configured" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        try {
          const factorStats = await env.SIGNALS_CACHE.get(KV_KEYS.FACTOR_STATS, { type: "json" }) || {};
          const pendingSignals = await env.SIGNALS_CACHE.get(KV_KEYS.PENDING_SIGNALS, { type: "json" }) || [];
          const walletIndex = await env.SIGNALS_CACHE.get("tracked_wallet_index", { type: "json" }) || [];
          
          // Calculate overall stats from factors
          let totalWins = 0;
          let totalLosses = 0;
          for (const stats of Object.values(factorStats)) {
            totalWins += stats.wins || 0;
            totalLosses += stats.losses || 0;
          }
          
          // Get wallet tier counts
          let insiderCount = 0;
          let eliteCount = 0;
          let strongCount = 0;
          let fadeCount = 0;
          const topWallets = [];
          
          // Fetch wallet stats in parallel
          for (let i = 0; i < Math.min(walletIndex.length, 50); i += 10) {
            const batch = walletIndex.slice(i, i + 10);
            const results = await Promise.all(
              batch.map(addr => getWalletStats(env, addr))
            );
            results.forEach(stats => {
              if (stats) {
                if (stats.tier === 'INSIDER') insiderCount++;
                else if (stats.tier === 'ELITE') eliteCount++;
                else if (stats.tier === 'STRONG') strongCount++;
                else if (stats.tier === 'FADE') fadeCount++;
                
                // Track top performers for display
                if (stats.totalBets >= 5 && stats.winRate >= 60) {
                  topWallets.push({
                    address: stats.address,
                    tier: stats.tier,
                    winRate: stats.winRate,
                    record: `${stats.wins}W-${stats.losses}L`,
                    totalVolume: stats.totalVolume,
                    edgeMetrics: stats.edgeMetrics
                  });
                }
              }
            });
          }
          
          // Sort top wallets by edge (win rate * consistency)
          topWallets.sort((a, b) => {
            const aEdge = (a.winRate || 0) * (a.edgeMetrics?.consistencyScore || 1);
            const bEdge = (b.winRate || 0) * (b.edgeMetrics?.consistencyScore || 1);
            return bEdge - aEdge;
          });
          
          return new Response(JSON.stringify({
            success: true,
            overview: {
              totalFactorsTracked: Object.keys(factorStats).length,
              totalSignalsProcessed: totalWins + totalLosses,
              overallWinRate: totalWins + totalLosses > 0 
                ? Math.round((totalWins / (totalWins + totalLosses)) * 100) 
                : 0,
              pendingSignals: pendingSignals.length
            },
            walletEdge: {
              totalTracked: walletIndex.length,
              insiderCount,
              eliteCount,
              strongCount,
              fadeCount,
              topPerformers: topWallets.slice(0, 10)
            },
            factors: factorStats,
            tiers: WALLET_TIERS
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }
      
      // Get tracked wallet stats
      if (path.startsWith("/learning/wallet/")) {
        const address = path.split("/")[3];
        if (!address) {
          return new Response(JSON.stringify({ error: "Wallet address required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        const stats = await getWalletStats(env, address);
        if (!stats) {
          return new Response(JSON.stringify({ 
            success: false, 
            message: "Wallet not tracked yet. Stats will appear after placing significant bets." 
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        return new Response(JSON.stringify({ success: true, wallet: stats }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Get all elite/strong wallets (leaderboard)
      if (path === "/learning/leaderboard") {
        if (!env.SIGNALS_CACHE) {
          return new Response(JSON.stringify({ error: "No cache configured" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        try {
          // First try to get wallets from the dedicated index (fast path)
          let walletAddresses = await env.SIGNALS_CACHE.get("tracked_wallet_index", { type: "json" }) || [];
          
          // If index is empty, try building from pending signals (slower fallback)
          if (walletAddresses.length === 0) {
            const pendingIds = await env.SIGNALS_CACHE.get(KV_KEYS.PENDING_SIGNALS, { type: "json" }) || [];
            const walletSet = new Set();
            
            // Fetch signals in parallel batches of 10
            for (let i = 0; i < Math.min(pendingIds.length, 30); i += 10) {
              const batch = pendingIds.slice(i, i + 10);
              const results = await Promise.all(
                batch.map(id => env.SIGNALS_CACHE.get(KV_KEYS.SIGNALS_PREFIX + id, { type: "json" }))
              );
              results.forEach(signalData => {
                if (signalData?.wallets) {
                  signalData.wallets.forEach(w => walletSet.add(w.toLowerCase()));
                }
              });
            }
            walletAddresses = Array.from(walletSet);
          }
          
          // Fetch wallet stats in parallel batches
          const walletStats = [];
          for (let i = 0; i < walletAddresses.length; i += 10) {
            const batch = walletAddresses.slice(i, i + 10);
            const results = await Promise.all(
              batch.map(addr => getWalletStats(env, addr))
            );
            results.forEach(stats => {
              // Include wallets with settled bets OR pending bets (being tracked)
              if (stats && (stats.totalBets > 0 || stats.pending > 0)) {
                walletStats.push(stats);
              }
            });
          }
          
          // Sort: wallets with settled bets first, then by win rate, then by pending count
          walletStats.sort((a, b) => {
            // Settled bets first
            if (a.totalBets > 0 && b.totalBets === 0) return -1;
            if (b.totalBets > 0 && a.totalBets === 0) return 1;
            
            // Among settled, sort by qualified status then win rate
            const aQualified = a.totalBets >= 3;
            const bQualified = b.totalBets >= 3;
            if (aQualified && !bQualified) return -1;
            if (!aQualified && bQualified) return 1;
            if (a.winRate !== b.winRate) return b.winRate - a.winRate;
            
            // Among unsettled, sort by volume
            return b.totalVolume - a.totalVolume;
          });
          
          // Calculate summary stats
          const eliteCount = walletStats.filter(w => w.tier === 'ELITE').length;
          const strongCount = walletStats.filter(w => w.tier === 'STRONG').length;
          const totalWins = walletStats.reduce((sum, w) => sum + (w.wins || 0), 0);
          const totalLosses = walletStats.reduce((sum, w) => sum + (w.losses || 0), 0);
          const avgWinRate = totalWins + totalLosses > 0 
            ? Math.round((totalWins / (totalWins + totalLosses)) * 100) 
            : 0;
          
          return new Response(JSON.stringify({
            success: true,
            // Top-level for backwards compatibility
            eliteCount,
            strongCount,
            totalTracked: walletStats.length,
            avgWinRate,
            // Also in summary object
            summary: {
              eliteCount,
              strongCount,
              totalTracked: walletStats.length,
              avgWinRate
            },
            tiers: WALLET_TIERS,
            leaderboard: walletStats.slice(0, 50).map(w => {
              // Determine display tier
              let displayTier = w.tier;
              if (!displayTier) {
                if (w.totalBets > 0) {
                  // Has settled bets but not enough for tier classification
                  displayTier = 'NEW';
                } else if (w.pending > 0) {
                  // Only pending bets
                  displayTier = 'PENDING';
                }
              }
              
              return {
                address: w.address,
                tier: displayTier,
                winRate: w.winRate,
                record: `${w.wins}W-${w.losses}L`,
                totalBets: w.totalBets,
                pending: w.pending,
                totalVolume: w.totalVolume,
                avgBetSize: w.avgBetSize,
                currentStreak: w.currentStreak,
                bestStreak: w.bestStreak,
                lastSeen: w.lastSeen,
                markets: w.markets
              };
            })
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }
      
      // Get ALL tracked wallets (for frontend Whale Watchers)
      if (path === "/learning/tracked-wallets") {
        if (!env.SIGNALS_CACHE) {
          return new Response(JSON.stringify({ error: "No cache configured" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        try {
          // Try to get wallets from a dedicated index first
          let trackedWallets = await env.SIGNALS_CACHE.get("tracked_wallet_index", { type: "json" }) || [];
          
          // Fetch wallet stats in parallel batches
          const walletData = [];
          for (let i = 0; i < Math.min(trackedWallets.length, 100); i += 10) {
            const batch = trackedWallets.slice(i, i + 10);
            const results = await Promise.all(
              batch.map(addr => getWalletStats(env, addr))
            );
            results.forEach(stats => {
              if (stats) {
                walletData.push({
                  address: stats.address,
                  tier: stats.tier,
                  winRate: stats.winRate,
                  wins: stats.wins,
                  losses: stats.losses,
                  pending: stats.pending,
                  totalVolume: stats.totalVolume,
                  avgBetSize: stats.avgBetSize,
                  currentStreak: stats.currentStreak,
                  bestStreak: stats.bestStreak,
                  lastSeen: stats.lastSeen,
                  firstSeen: stats.firstSeen,
                  markets: stats.markets,
                  recentBets: stats.recentBets?.slice(0, 5) || []
                });
              }
            });
          }
          
          // Sort: ELITE first, then STRONG, then by win rate
          walletData.sort((a, b) => {
            const tierOrder = { ELITE: 0, STRONG: 1, AVERAGE: 2, FADE: 3, null: 4 };
            const tierDiff = (tierOrder[a.tier] || 4) - (tierOrder[b.tier] || 4);
            if (tierDiff !== 0) return tierDiff;
            return b.winRate - a.winRate;
          });
          
          return new Response(JSON.stringify({
            success: true,
            count: walletData.length,
            wallets: walletData
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }
      
      // Manually trigger settlement check
      if (path === "/learning/settle") {
        const results = await processSettledSignals(env);
        return new Response(JSON.stringify({
          success: true,
          results
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Debug: Check wallet index status
      if (path === "/learning/debug-wallets") {
        const walletIndex = await env.SIGNALS_CACHE.get("tracked_wallet_index", { type: "json" }) || [];
        const pendingSignals = await env.SIGNALS_CACHE.get(KV_KEYS.PENDING_SIGNALS, { type: "json" }) || [];
        
        // Get a sample of wallet stats
        const sampleStats = [];
        for (const addr of walletIndex.slice(0, 5)) {
          const stats = await getWalletStats(env, addr);
          if (stats) sampleStats.push(stats);
        }
        
        return new Response(JSON.stringify({
          success: true,
          walletIndexCount: walletIndex.length,
          walletIndexSample: walletIndex.slice(0, 10),
          pendingSignalsCount: pendingSignals.length,
          sampleWalletStats: sampleStats
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // View cron job status - when it last ran and what it did
      if (path === "/cron-status") {
        const cronStatus = await env.SIGNALS_CACHE.get("cron_last_run", { type: "json" });
        return new Response(JSON.stringify({
          success: true,
          lastRun: cronStatus || { message: "No cron runs recorded yet" },
          cronSchedule: "Every 5 minutes",
          note: "Settlement runs automatically. Sports events settle ~12h after game ends."
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Admin: Reprocess all wallets to fix missing outcomes
      // This will go through all signals and update wallet stats
      if (path === "/admin/reprocess-wallets") {
        const results = { processed: 0, walletsUpdated: 0, errors: 0 };
        
        try {
          // Get all wallets from index
          const walletIndex = await env.SIGNALS_CACHE.get("tracked_wallet_index", { type: "json" }) || [];
          
          for (const walletAddress of walletIndex) {
            try {
              const walletKey = KV_KEYS.WALLETS_PREFIX + walletAddress.toLowerCase();
              let walletStats = await env.SIGNALS_CACHE.get(walletKey, { type: "json" });
              
              if (!walletStats || !walletStats.recentBets) continue;
              
              let updated = false;
              let wins = 0;
              let losses = 0;
              let settled = 0;
              let pending = 0;
              
              // Check each bet and try to determine outcome from signal
              for (let i = 0; i < walletStats.recentBets.length; i++) {
                const bet = walletStats.recentBets[i];
                
                if (bet.outcome === null) {
                  // Try to get outcome from stored signal
                  if (bet.signalId) {
                    const signalKey = KV_KEYS.SIGNALS_PREFIX + bet.signalId;
                    const signalData = await env.SIGNALS_CACHE.get(signalKey, { type: "json" });
                    
                    if (signalData && signalData.outcome) {
                      walletStats.recentBets[i].outcome = signalData.outcome;
                      walletStats.recentBets[i].settledAt = signalData.settledAt;
                      updated = true;
                      
                      if (signalData.outcome === "WIN") wins++;
                      else if (signalData.outcome === "LOSS") losses++;
                      settled++;
                    } else {
                      pending++;
                    }
                  } else {
                    pending++;
                  }
                } else {
                  if (bet.outcome === "WIN") wins++;
                  else if (bet.outcome === "LOSS") losses++;
                  settled++;
                }
              }
              
              if (updated) {
                // Recalculate wallet stats
                walletStats.wins = wins;
                walletStats.losses = losses;
                walletStats.totalBets = settled;
                walletStats.pending = pending;
                walletStats.winRate = settled > 0 ? Math.round((wins / settled) * 100) : 0;
                walletStats.tier = getWalletTier(walletStats)?.tier || null;
                
                await env.SIGNALS_CACHE.put(walletKey, JSON.stringify(walletStats), {
                  expirationTtl: 90 * 24 * 60 * 60
                });
                
                results.walletsUpdated++;
              }
              
              results.processed++;
            } catch (e) {
              results.errors++;
            }
          }
          
          return new Response(JSON.stringify({
            success: true,
            results
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
          
        } catch (e) {
          return new Response(JSON.stringify({
            success: false,
            error: e.message
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }
      
      // Debug endpoint to see Polymarket sports trades
      // Usage: /debug/poly-sports?sport=nba
      if (path === "/debug/poly-sports") {
        const sport = url.searchParams.get("sport") || "nba";
        
        try {
          const tradesRes = await fetch(`${POLYMARKET_API}/trades?limit=2000`);
          const allTrades = tradesRes.ok ? await tradesRes.json() : [];
          
          // Get unique slugs that might be sports
          const sportsKeywords = ['nba', 'nfl', 'mlb', 'nhl', 'spread', 'moneyline', 'over', 'under', 'winner'];
          const potentialSportsTrades = allTrades.filter(t => {
            const slug = (t.eventSlug || t.slug || '').toLowerCase();
            return sportsKeywords.some(kw => slug.includes(kw));
          });
          
          // Get unique event slugs
          const uniqueSlugs = [...new Set(potentialSportsTrades.map(t => t.eventSlug || t.slug))];
          
          // Sample trades for the requested sport
          const sportPrefix = sport.toLowerCase();
          const sportTrades = allTrades.filter(t => {
            const slug = (t.eventSlug || t.slug || '').toLowerCase();
            return slug.includes(sportPrefix);
          }).slice(0, 20);
          
          return new Response(JSON.stringify({
            success: true,
            totalTrades: allTrades.length,
            potentialSportsCount: potentialSportsTrades.length,
            uniqueSportsSlugs: uniqueSlugs.slice(0, 50),
            sampleTradesForSport: sportTrades.map(t => ({
              eventSlug: t.eventSlug,
              slug: t.slug,
              outcome: t.outcome,
              price: t.price,
              timestamp: t.timestamp
            }))
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
          
        } catch (e) {
          return new Response(JSON.stringify({
            success: false,
            error: e.message
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }
      
      // Get Vegas odds WITH Polymarket prices for comparison
      // Usage: /odds/compare-all?sport=nba
      // Returns both Vegas odds and current Polymarket prices for each game
      if (path === "/odds/compare-all") {
        const sport = url.searchParams.get("sport") || "nba";
        const sportKey = SPORT_KEY_MAP[sport];
        
        if (!sportKey) {
          return new Response(JSON.stringify({
            success: false,
            error: "Sport not supported. Try: nba, nfl, mlb, nhl"
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        if (!env.ODDS_API_KEY) {
          return new Response(JSON.stringify({
            success: false,
            error: "Odds API not configured. Add ODDS_API_KEY to secrets."
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        try {
          // 1. Fetch Vegas odds
          const oddsData = await getGameOdds(env, sportKey, 'h2h,spreads');
          
          // 2. Fetch recent Polymarket trades to find sports markets
          const tradesRes = await fetch(`${POLYMARKET_API}/trades?limit=2000`);
          const allTrades = tradesRes.ok ? await tradesRes.json() : [];
          
          // Filter to sports trades for this sport
          const sportPrefix = sport.toLowerCase() + '-';
          const sportsTrades = allTrades.filter(t => 
            (t.eventSlug && t.eventSlug.toLowerCase().startsWith(sportPrefix)) ||
            (t.slug && t.slug.toLowerCase().startsWith(sportPrefix))
          );
          
          // Build map of current Polymarket prices by game
          // Key: "awaycode-homecode-date" -> { mlPrice, spreadPrices }
          const polyPrices = {};
          
          for (const trade of sportsTrades) {
            const slug = trade.eventSlug || trade.slug || '';
            // Parse slug: nba-por-was-2026-01-28 or nba-por-was-2026-01-28-spread-away-7pt5
            const match = slug.match(/^(nba|nfl|mlb|nhl)-([a-z]+)-([a-z]+)-(\d{4}-\d{2}-\d{2})/i);
            if (!match) continue;
            
            const gameKey = `${match[2]}-${match[3]}-${match[4]}`.toLowerCase();
            const isSpread = slug.includes('-spread');
            const price = parseFloat(trade.price) * 100; // Convert to percentage
            const outcome = trade.outcome || '';
            
            if (!polyPrices[gameKey]) {
              polyPrices[gameKey] = {
                awayCode: match[2].toLowerCase(),
                homeCode: match[3].toLowerCase(),
                date: match[4],
                moneyline: {},
                spread: {},
                lastUpdate: trade.timestamp
              };
            }
            
            // Update if this trade is more recent
            if (trade.timestamp > polyPrices[gameKey].lastUpdate) {
              polyPrices[gameKey].lastUpdate = trade.timestamp;
            }
            
            // Get full team names for matching
            const awayTeamFull = getTeamFullName(match[2]).toLowerCase();
            const homeTeamFull = getTeamFullName(match[3]).toLowerCase();
            const outcomeLower = outcome.toLowerCase();
            
            // Determine which team this price is for based on outcome
            let isAwayTeam = false;
            let isHomeTeam = false;
            
            // Check if outcome matches away team
            if (outcomeLower.includes(awayTeamFull) || awayTeamFull.includes(outcomeLower) ||
                outcomeLower === match[2].toLowerCase()) {
              isAwayTeam = true;
            }
            // Check if outcome matches home team  
            else if (outcomeLower.includes(homeTeamFull) || homeTeamFull.includes(outcomeLower) ||
                     outcomeLower === match[3].toLowerCase()) {
              isHomeTeam = true;
            }
            // Try partial match on team name (e.g., "Thunder" matches "Oklahoma City Thunder")
            else {
              const awayWords = awayTeamFull.split(' ');
              const homeWords = homeTeamFull.split(' ');
              if (awayWords.some(w => w.length > 3 && outcomeLower.includes(w))) {
                isAwayTeam = true;
              } else if (homeWords.some(w => w.length > 3 && outcomeLower.includes(w))) {
                isHomeTeam = true;
              }
            }
            
            if (isSpread) {
              // Spread bet
              if (isAwayTeam) {
                polyPrices[gameKey].spread.away = {
                  price: Math.round(price),
                  slug: slug
                };
              } else if (isHomeTeam) {
                polyPrices[gameKey].spread.home = {
                  price: Math.round(price),
                  slug: slug
                };
              }
            } else {
              // Moneyline bet
              if (isAwayTeam) {
                polyPrices[gameKey].moneyline.away = { 
                  price: Math.round(price), 
                  slug: slug,
                  team: outcome
                };
              } else if (isHomeTeam) {
                polyPrices[gameKey].moneyline.home = { 
                  price: Math.round(price), 
                  slug: slug,
                  team: outcome
                };
              }
            }
          }
          
          // Debug: log what we found
          console.log(`Found ${Object.keys(polyPrices).length} Polymarket games for ${sport}`);
          
          // 3. Match Vegas games to Polymarket prices
          const games = (oddsData || []).map(game => {
            // Get consensus Vegas odds
            const preferredBooks = ['fanduel', 'draftkings', 'betmgm'];
            let h2hOdds = null;
            let spreadOdds = null;
            
            for (const bookKey of preferredBooks) {
              const book = game.bookmakers?.find(b => b.key === bookKey);
              if (book) {
                if (!h2hOdds) {
                  const h2hMarket = book.markets?.find(m => m.key === 'h2h');
                  if (h2hMarket) h2hOdds = h2hMarket.outcomes;
                }
                if (!spreadOdds) {
                  const spreadMarket = book.markets?.find(m => m.key === 'spreads');
                  if (spreadMarket) spreadOdds = spreadMarket.outcomes;
                }
              }
              if (h2hOdds && spreadOdds) break;
            }
            
            // Find matching Polymarket data
            // Try to match by team names to codes
            const gameDate = game.commence_time ? game.commence_time.split('T')[0] : '';
            let polyData = null;
            
            // Search for matching Polymarket game
            for (const [key, data] of Object.entries(polyPrices)) {
              const awayName = getTeamFullName(data.awayCode).toLowerCase();
              const homeName = getTeamFullName(data.homeCode).toLowerCase();
              
              const vegasAway = game.away_team.toLowerCase();
              const vegasHome = game.home_team.toLowerCase();
              
              // Check if teams match (either direction)
              const awayMatch = vegasAway.includes(awayName) || awayName.includes(vegasAway);
              const homeMatch = vegasHome.includes(homeName) || homeName.includes(vegasHome);
              
              // Also check date matches
              const dateMatch = key.includes(gameDate);
              
              if (awayMatch && homeMatch && dateMatch) {
                polyData = data;
                break;
              }
            }
            
            // Calculate Vegas implied probabilities
            const vegasHomeProb = h2hOdds?.find(o => o.name === game.home_team)?.price ? 
              Math.round(americanToProb(h2hOdds.find(o => o.name === game.home_team).price) * 100) : null;
            const vegasAwayProb = h2hOdds?.find(o => o.name === game.away_team)?.price ?
              Math.round(americanToProb(h2hOdds.find(o => o.name === game.away_team).price) * 100) : null;
            
            // Calculate edge (positive = Polymarket is better value)
            let homeEdge = null;
            let awayEdge = null;
            
            if (polyData?.moneyline?.home?.price && vegasHomeProb) {
              homeEdge = vegasHomeProb - polyData.moneyline.home.price;
            }
            if (polyData?.moneyline?.away?.price && vegasAwayProb) {
              awayEdge = vegasAwayProb - polyData.moneyline.away.price;
            }
            
            // Determine best bet
            let bestBet = null;
            if (homeEdge !== null && homeEdge >= 5) {
              bestBet = { team: game.home_team, edge: homeEdge, type: 'moneyline' };
            } else if (awayEdge !== null && awayEdge >= 5) {
              bestBet = { team: game.away_team, edge: awayEdge, type: 'moneyline' };
            }
            
            return {
              id: game.id,
              homeTeam: game.home_team,
              awayTeam: game.away_team,
              commenceTime: game.commence_time,
              vegas: {
                moneyline: h2hOdds ? {
                  home: { 
                    odds: h2hOdds.find(o => o.name === game.home_team)?.price,
                    prob: vegasHomeProb
                  },
                  away: { 
                    odds: h2hOdds.find(o => o.name === game.away_team)?.price,
                    prob: vegasAwayProb
                  }
                } : null,
                spread: spreadOdds ? {
                  home: {
                    line: spreadOdds.find(o => o.name === game.home_team)?.point,
                    odds: spreadOdds.find(o => o.name === game.home_team)?.price
                  },
                  away: {
                    line: spreadOdds.find(o => o.name === game.away_team)?.point,
                    odds: spreadOdds.find(o => o.name === game.away_team)?.price
                  }
                } : null
              },
              polymarket: polyData ? {
                moneyline: {
                  home: polyData.moneyline.home || null,
                  away: polyData.moneyline.away || null
                },
                spread: {
                  home: polyData.spread.home || null,
                  away: polyData.spread.away || null
                },
                lastUpdate: polyData.lastUpdate
              } : null,
              edge: {
                home: homeEdge,
                away: awayEdge,
                bestBet: bestBet
              },
              hasPolymarket: !!polyData
            };
          });
          
          // Sort: games with value bets first
          games.sort((a, b) => {
            const aMaxEdge = Math.max(a.edge.home || -100, a.edge.away || -100);
            const bMaxEdge = Math.max(b.edge.home || -100, b.edge.away || -100);
            return bMaxEdge - aMaxEdge;
          });
          
          // Separate value bets
          const valueBets = games.filter(g => g.edge.bestBet !== null);
          
          return new Response(JSON.stringify({
            success: true,
            sport: sport,
            sportKey: sportKey,
            timestamp: new Date().toISOString(),
            gamesCount: games.length,
            valueBetsCount: valueBets.length,
            polymarketGamesFound: Object.keys(polyPrices).length,
            polymarketGameKeys: Object.keys(polyPrices),
            valueBets: valueBets.map(g => ({
              game: `${g.awayTeam} @ ${g.homeTeam}`,
              team: g.edge.bestBet.team,
              edge: g.edge.bestBet.edge,
              type: g.edge.bestBet.type,
              vegasProb: g.edge.bestBet.team === g.homeTeam ? g.vegas.moneyline?.home?.prob : g.vegas.moneyline?.away?.prob,
              polyPrice: g.edge.bestBet.team === g.homeTeam ? g.polymarket?.moneyline?.home?.price : g.polymarket?.moneyline?.away?.price
            })),
            games: games
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
          
        } catch (e) {
          return new Response(JSON.stringify({
            success: false,
            error: e.message,
            stack: e.stack
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }
      
      // Get Vegas odds for comparison with Polymarket
      // Usage: /odds/compare?sport=nba or /odds/compare?sport=nfl
      if (path === "/odds/compare") {
        const sport = url.searchParams.get("sport") || "nba";
        const sportKey = SPORT_KEY_MAP[sport];
        
        if (!sportKey) {
          return new Response(JSON.stringify({
            success: false,
            error: "Sport not supported. Try: nba, nfl, mlb, nhl"
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        if (!env.ODDS_API_KEY) {
          return new Response(JSON.stringify({
            success: false,
            error: "Odds API not configured. Add ODDS_API_KEY to secrets."
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        try {
          const oddsData = await getGameOdds(env, sportKey, 'h2h,spreads');
          
          if (!oddsData || oddsData.length === 0) {
            return new Response(JSON.stringify({
              success: true,
              sport: sport,
              games: [],
              message: "No upcoming games found"
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
          }
          
          // Format games with consensus odds
          const games = oddsData.map(game => {
            // Get consensus odds from FanDuel or DraftKings (most liquid books)
            const preferredBooks = ['fanduel', 'draftkings', 'betmgm'];
            let h2hOdds = null;
            let spreadOdds = null;
            
            for (const bookKey of preferredBooks) {
              const book = game.bookmakers?.find(b => b.key === bookKey);
              if (book) {
                if (!h2hOdds) {
                  const h2hMarket = book.markets?.find(m => m.key === 'h2h');
                  if (h2hMarket) h2hOdds = h2hMarket.outcomes;
                }
                if (!spreadOdds) {
                  const spreadMarket = book.markets?.find(m => m.key === 'spreads');
                  if (spreadMarket) spreadOdds = spreadMarket.outcomes;
                }
              }
              if (h2hOdds && spreadOdds) break;
            }
            
            return {
              id: game.id,
              homeTeam: game.home_team,
              awayTeam: game.away_team,
              commenceTime: game.commence_time,
              moneyline: h2hOdds ? {
                home: h2hOdds.find(o => o.name === game.home_team)?.price,
                away: h2hOdds.find(o => o.name === game.away_team)?.price,
                homeProb: h2hOdds.find(o => o.name === game.home_team)?.price ? 
                  Math.round(americanToProb(h2hOdds.find(o => o.name === game.home_team).price) * 100) : null,
                awayProb: h2hOdds.find(o => o.name === game.away_team)?.price ?
                  Math.round(americanToProb(h2hOdds.find(o => o.name === game.away_team).price) * 100) : null
              } : null,
              spread: spreadOdds ? {
                home: {
                  line: spreadOdds.find(o => o.name === game.home_team)?.point,
                  odds: spreadOdds.find(o => o.name === game.home_team)?.price
                },
                away: {
                  line: spreadOdds.find(o => o.name === game.away_team)?.point,
                  odds: spreadOdds.find(o => o.name === game.away_team)?.price
                }
              } : null
            };
          });
          
          return new Response(JSON.stringify({
            success: true,
            sport: sport,
            sportKey: sportKey,
            gamesCount: games.length,
            games: games
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
          
        } catch (e) {
          return new Response(JSON.stringify({
            success: false,
            error: e.message
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }
      
      // Get game scores for settlement verification
      // Usage: /odds/scores?sport=nba&days=3
      if (path === "/odds/scores") {
        const sport = url.searchParams.get("sport") || "nba";
        const days = parseInt(url.searchParams.get("days") || "3");
        const sportKey = SPORT_KEY_MAP[sport];
        
        if (!sportKey) {
          return new Response(JSON.stringify({
            success: false,
            error: "Sport not supported"
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        if (!env.ODDS_API_KEY) {
          return new Response(JSON.stringify({
            success: false,
            error: "Odds API not configured"
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        try {
          const scores = await getGameScores(env, sportKey, days);
          
          return new Response(JSON.stringify({
            success: true,
            sport: sport,
            daysBack: days,
            games: scores || []
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
          
        } catch (e) {
          return new Response(JSON.stringify({
            success: false,
            error: e.message
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }
      
      // Debug: List ALL pending signals with their market slugs
      if (path === "/learning/pending-all") {
        const pendingSignals = await env.SIGNALS_CACHE.get(KV_KEYS.PENDING_SIGNALS, { type: "json" }) || [];
        const signalDetails = [];
        
        for (const signalId of pendingSignals) {
          const signalData = await env.SIGNALS_CACHE.get(KV_KEYS.SIGNALS_PREFIX + signalId, { type: "json" });
          if (signalData) {
            // Check if slug has date
            const slugDateMatch = (signalData.marketSlug || '').match(/(\d{4})-(\d{2})-(\d{2})/);
            let hoursSinceEvent = 0;
            if (slugDateMatch) {
              const eventDate = new Date(
                parseInt(slugDateMatch[1]),
                parseInt(slugDateMatch[2]) - 1,
                parseInt(slugDateMatch[3]),
                23, 59, 59
              );
              hoursSinceEvent = (Date.now() - eventDate.getTime()) / (1000 * 60 * 60);
            }
            
            signalDetails.push({
              signalId: signalData.id,
              marketSlug: signalData.marketSlug,
              direction: signalData.direction,
              detectedAt: signalData.detectedAt,
              hasDateInSlug: !!slugDateMatch,
              slugDate: slugDateMatch ? slugDateMatch[0] : null,
              hoursSinceEvent: Math.round(hoursSinceEvent),
              shouldSettle: hoursSinceEvent > 12
            });
          }
        }
        
        // Sort by hoursSinceEvent descending (oldest first)
        signalDetails.sort((a, b) => b.hoursSinceEvent - a.hoursSinceEvent);
        
        return new Response(JSON.stringify({
          success: true,
          totalPending: pendingSignals.length,
          signals: signalDetails
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Debug: Check why signals aren't settling
      if (path === "/learning/debug-pending") {
        const pendingIds = await env.SIGNALS_CACHE.get(KV_KEYS.PENDING_SIGNALS, { type: "json" }) || [];
        const debugResults = [];
        const now = new Date();
        
        for (const signalId of pendingIds.slice(0, 10)) {
          const signalData = await env.SIGNALS_CACHE.get(KV_KEYS.SIGNALS_PREFIX + signalId, { type: "json" });
          
          if (!signalData) {
            debugResults.push({ signalId, error: "Signal data not found" });
            continue;
          }
          
          // Extract date from slug
          const slugDateMatch = (signalData.marketSlug || '').match(/(\d{4})-(\d{2})-(\d{2})/);
          let hoursSinceEvent = 0;
          let eventDateStr = null;
          
          if (slugDateMatch) {
            const eventDate = new Date(
              parseInt(slugDateMatch[1]),
              parseInt(slugDateMatch[2]) - 1,
              parseInt(slugDateMatch[3]),
              23, 59, 59
            );
            eventDateStr = eventDate.toISOString();
            hoursSinceEvent = (now.getTime() - eventDate.getTime()) / (1000 * 60 * 60);
          }
          
          debugResults.push({
            signalId,
            marketSlug: signalData.marketSlug,
            direction: signalData.direction,
            outcome: signalData.outcome || "PENDING",
            extractedDate: slugDateMatch ? slugDateMatch[0] : null,
            eventDateISO: eventDateStr,
            nowISO: now.toISOString(),
            hoursSinceEvent: Math.round(hoursSinceEvent * 10) / 10,
            shouldSettle: hoursSinceEvent > 12
          });
        }
        
        return new Response(JSON.stringify({
          success: true,
          serverTime: now.toISOString(),
          pendingCount: pendingIds.length,
          debugResults
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Debug: Check settlement status for a specific signal
      if (path === "/learning/debug-settle") {
        const signalId = url.searchParams.get("id");
        
        if (!signalId) {
          // If no ID provided, check first pending signal
          const pendingIds = await env.SIGNALS_CACHE.get(KV_KEYS.PENDING_SIGNALS, { type: "json" }) || [];
          if (pendingIds.length === 0) {
            return new Response(JSON.stringify({ error: "No pending signals" }), {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
          }
          
          // Also fetch trades to debug matching
          let tradeSlugs = [];
          try {
            const tradesRes = await fetch(`${POLYMARKET_API}/trades?limit=100`);
            if (tradesRes.ok) {
              const trades = await tradesRes.json();
              // Get unique slugs from trades
              const slugSet = new Set();
              trades.forEach(t => {
                if (t.slug) slugSet.add(t.slug);
                if (t.eventSlug) slugSet.add(t.eventSlug);
              });
              tradeSlugs = Array.from(slugSet).slice(0, 30);
            }
          } catch (e) {
            tradeSlugs = ["Error fetching: " + e.message];
          }
          
          // Check first 3 signals for debugging
          const debugResults = [];
          for (const id of pendingIds.slice(0, 3)) {
            const signalData = await env.SIGNALS_CACHE.get(KV_KEYS.SIGNALS_PREFIX + id, { type: "json" });
            if (signalData) {
              const settlement = await checkMarketSettlement(signalData.marketSlug);
              debugResults.push({
                signalId: id,
                marketSlug: signalData.marketSlug,
                marketTitle: signalData.marketTitle,
                direction: signalData.direction,
                eventDate: signalData.eventDate,
                settlement
              });
            }
          }
          
          return new Response(JSON.stringify({
            success: true,
            pendingCount: pendingIds.length,
            recentTradeSlugs: tradeSlugs,
            debugResults
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        const signalData = await env.SIGNALS_CACHE.get(KV_KEYS.SIGNALS_PREFIX + signalId, { type: "json" });
        if (!signalData) {
          return new Response(JSON.stringify({ error: "Signal not found" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        const settlement = await checkMarketSettlement(signalData.marketSlug);
        
        return new Response(JSON.stringify({
          success: true,
          signal: signalData,
          settlement
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Debug: Test raw API responses for a slug
      if (path === "/learning/debug-api") {
        const slug = url.searchParams.get("slug") || "nba-was-cha-2026-01-24";
        const apiResults = {};
        
        // Try events endpoint
        try {
          const eventRes = await fetch(`${POLYMARKET_API}/events/${slug}`);
          apiResults.eventsEndpoint = {
            status: eventRes.status,
            ok: eventRes.ok,
            data: eventRes.ok ? await eventRes.json() : null
          };
        } catch (e) {
          apiResults.eventsEndpoint = { error: e.message };
        }
        
        // Try markets endpoint
        try {
          const marketRes = await fetch(`${POLYMARKET_API}/markets/${slug}`);
          apiResults.marketsEndpoint = {
            status: marketRes.status,
            ok: marketRes.ok,
            data: marketRes.ok ? await marketRes.json() : null
          };
        } catch (e) {
          apiResults.marketsEndpoint = { error: e.message };
        }
        
        // Try markets query
        try {
          const queryRes = await fetch(`${POLYMARKET_API}/markets?slug=${slug}`);
          apiResults.marketsQuery = {
            status: queryRes.status,
            ok: queryRes.ok,
            data: queryRes.ok ? await queryRes.json() : null
          };
        } catch (e) {
          apiResults.marketsQuery = { error: e.message };
        }
        
        // Try events query
        try {
          const eventsQueryRes = await fetch(`${POLYMARKET_API}/events?slug=${slug}`);
          apiResults.eventsQuery = {
            status: eventsQueryRes.status,
            ok: eventsQueryRes.ok,
            data: eventsQueryRes.ok ? await eventsQueryRes.json() : null
          };
        } catch (e) {
          apiResults.eventsQuery = { error: e.message };
        }
        
        // Also get a sample trade to see data structure
        try {
          const tradeRes = await fetch(`${POLYMARKET_API}/trades?limit=1`);
          if (tradeRes.ok) {
            const trades = await tradeRes.json();
            apiResults.sampleTrade = trades[0] || null;
            
            // If we got a trade, try to look up by conditionId
            if (trades[0]?.conditionId) {
              const conditionId = trades[0].conditionId;
              
              // Try market by conditionId
              try {
                const condRes = await fetch(`${POLYMARKET_API}/markets?conditionId=${conditionId}`);
                apiResults.marketByConditionId = {
                  status: condRes.status,
                  ok: condRes.ok,
                  data: condRes.ok ? await condRes.json() : null
                };
              } catch (e) {
                apiResults.marketByConditionId = { error: e.message };
              }
              
              // Try condition endpoint directly
              try {
                const condRes2 = await fetch(`${POLYMARKET_API}/conditions/${conditionId}`);
                apiResults.conditionEndpoint = {
                  status: condRes2.status,
                  ok: condRes2.ok,
                  data: condRes2.ok ? await condRes2.json() : null
                };
              } catch (e) {
                apiResults.conditionEndpoint = { error: e.message };
              }
              
              // Try prices endpoint
              try {
                const priceRes = await fetch(`${POLYMARKET_API}/prices?conditionId=${conditionId}`);
                apiResults.pricesByConditionId = {
                  status: priceRes.status,
                  ok: priceRes.ok,
                  data: priceRes.ok ? await priceRes.json() : null
                };
              } catch (e) {
                apiResults.pricesByConditionId = { error: e.message };
              }
            }
          }
        } catch (e) {
          apiResults.sampleTrade = { error: e.message };
        }
        
        return new Response(JSON.stringify({
          success: true,
          testedSlug: slug,
          apiResults
        }, null, 2), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Get pending signals awaiting settlement
      if (path === "/learning/pending") {
        if (!env.SIGNALS_CACHE) {
          return new Response(JSON.stringify({ error: "No cache configured" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        try {
          const pendingIds = await env.SIGNALS_CACHE.get(KV_KEYS.PENDING_SIGNALS, { type: "json" }) || [];
          const pendingDetails = [];
          
          // Get details for first 20 pending signals
          for (const id of pendingIds.slice(0, 20)) {
            const signalData = await env.SIGNALS_CACHE.get(KV_KEYS.SIGNALS_PREFIX + id, { type: "json" });
            if (signalData) {
              pendingDetails.push({
                id: signalData.id,
                market: signalData.marketTitle,
                direction: signalData.direction,
                score: signalData.score,
                eventDate: signalData.eventDate,
                detectedAt: signalData.detectedAt
              });
            }
          }
          
          return new Response(JSON.stringify({
            success: true,
            totalPending: pendingIds.length,
            signals: pendingDetails
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }
      
      // PHASE 2: Get line movement data for signals
      if (path === "/learning/lines") {
        if (!env.SIGNALS_CACHE) {
          return new Response(JSON.stringify({ error: "No cache configured" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        try {
          const pendingIds = await env.SIGNALS_CACHE.get(KV_KEYS.PENDING_SIGNALS, { type: "json" }) || [];
          const lineData = [];
          
          for (const id of pendingIds.slice(0, 30)) {
            const lineKey = KV_LINE_MOVEMENT_PREFIX + id;
            const data = await env.SIGNALS_CACHE.get(lineKey, { type: "json" });
            if (data) {
              lineData.push({
                signalId: data.signalId,
                marketSlug: data.marketSlug,
                direction: data.direction,
                entryPrice: data.entryPrice,
                currentPrice: data.currentPrice || data.priceAfter1hr || data.priceAfter30min || data.priceAfter5min || data.entryPrice,
                priceAfter5min: data.priceAfter5min,
                priceAfter30min: data.priceAfter30min,
                priceAfter1hr: data.priceAfter1hr,
                priceAfter2hr: data.priceAfter2hr,
                movementPct: data.movementPct,
                confirmed: data.confirmed,
                trackedAt: new Date(data.trackedAt).toISOString()
              });
            }
          }
          
          // Sort by movement (confirmed first, then by movement %)
          lineData.sort((a, b) => {
            if (a.confirmed && !b.confirmed) return -1;
            if (!a.confirmed && b.confirmed) return 1;
            return (b.movementPct || 0) - (a.movementPct || 0);
          });
          
          return new Response(JSON.stringify({
            success: true,
            totalTracked: lineData.length,
            confirmedMoves: lineData.filter(l => l.confirmed).length,
            lines: lineData
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }
      
      // PHASE 2: Manually trigger line movement update
      if (path === "/learning/lines/update") {
        const results = await updateLineMovements(env);
        return new Response(JSON.stringify({
          success: true,
          results
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // ============================================
      // PHASE 3: INTELLIGENCE ENDPOINTS
      // ============================================
      
      // Get learning insights and recommendations
      if (path === "/learning/insights") {
        const insights = await getLearningInsights(env);
        if (!insights) {
          return new Response(JSON.stringify({ error: "Could not generate insights" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({
          success: true,
          ...insights
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Paper-trading ROI ledger: real profitability of signals, broken
      // down by score band, market type, entry band, factor and source.
      // Add ?trades=1 to include the recent per-signal trade log.
      if (path === "/learning/ledger") {
        if (!env.SIGNALS_CACHE) {
          return new Response(JSON.stringify({ error: "No cache configured" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        const ledger = await env.SIGNALS_CACHE.get(LEDGER_KEY, { type: "json" });
        const view = buildLedgerView(ledger);
        let recentTrades = null;
        if (url.searchParams.get("trades")) {
          recentTrades = await env.SIGNALS_CACHE.get(LEDGER_TRADES_KEY, { type: "json" }) || [];
        }
        return new Response(JSON.stringify({
          success: true,
          note: view ? "Each entry = a hypothetical $" + PAPER_STAKE + " buy at signal entry price. roiPct is on graded (WIN/LOSS) trades only." : "No settled signals recorded yet.",
          ledger: view,
          recentTrades: recentTrades
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Agent calibration: how the agent's independent probabilities score
      // against ground-truth (Gamma) settlements, vs the market baseline.
      // ?records=1 includes the per-investigation records.
      if (path === "/learning/brier") {
        if (!env.SIGNALS_CACHE) {
          return new Response(JSON.stringify({ error: "No cache configured" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        const report = await buildBrierReport(env);
        let records = null;
        if (url.searchParams.get("records")) {
          const idx = await env.SIGNALS_CACHE.get("investigation_index", { type: "json" }) || [];
          records = [];
          for (const k of idx.slice(-100)) {
            const inv = await env.SIGNALS_CACHE.get(k, { type: "json" });
            if (inv) records.push(inv);
          }
        }
        return new Response(JSON.stringify({ success: true, report: report, records: records }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Manually trigger / inspect an investigation.
      // /investigate?slug=<marketSlug>&direction=<outcome>[&title=..&force=1]
      if (path === "/investigate") {
        if (!env.ANTHROPIC_API_KEY) {
          return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        const slug = url.searchParams.get("slug");
        const direction = url.searchParams.get("direction") || "Yes";
        if (!slug) {
          return new Response(JSON.stringify({ error: "slug required: /investigate?slug=<marketSlug>&direction=<outcome>" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        const sig = {
          marketSlug: slug,
          directionRaw: direction,
          marketTitle: url.searchParams.get("title") || null,
          avgEntryPrice: url.searchParams.get("price") ? parseInt(url.searchParams.get("price"), 10) : null,
          eventDate: url.searchParams.get("eventDate") || null,
          detectedAt: new Date().toISOString()
        };
        try {
          const r = await investigateSignal(env, sig, { force: !!url.searchParams.get("force") });
          return new Response(JSON.stringify(r), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }

      // Get wallet specialization
      if (path.startsWith("/learning/specialization/")) {
        const address = path.split("/")[3];
        if (!address) {
          return new Response(JSON.stringify({ error: "Wallet address required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        const specialization = await getWalletSpecialization(env, address);
        if (!specialization) {
          return new Response(JSON.stringify({ 
            success: false, 
            message: "Wallet not tracked or not enough data yet" 
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        return new Response(JSON.stringify({ success: true, ...specialization }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Manually trigger weight optimization
      if (path === "/learning/optimize") {
        const results = await optimizeFactorWeights(env);
        return new Response(JSON.stringify({
          success: true,
          ...results
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      
      // Get fade alerts (signals where known losers are betting)
      if (path === "/learning/fades") {
        if (!env.SIGNALS_CACHE) {
          return new Response(JSON.stringify({ error: "No cache configured" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        try {
          // Get recent signals and check for fade opportunities
          const cached = await env.SIGNALS_CACHE.get("signals", { type: "json" }) || [];
          const fadeSignals = cached.filter(s => s.fadeAlert && s.fadeAlert.isFade);
          
          return new Response(JSON.stringify({
            success: true,
            totalFades: fadeSignals.length,
            fades: fadeSignals.slice(0, 20).map(s => ({
              market: s.marketTitle,
              originalDirection: s.direction,
              fadeDirection: s.fadeAlert.fadeDirection,
              losingWalletWinRate: s.fadeAlert.walletWinRate,
              losingWalletRecord: s.fadeAlert.walletRecord,
              confidence: s.fadeAlert.confidence,
              betAmount: s.largestBet,
              reasoning: s.fadeAlert.reasoning
            }))
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
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
          version: "19.0.0 - Agent investigation (web-search) + Brier calibration vs market",
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
    const cronStatus = {
      startedAt: new Date().toISOString(),
      scan: null,
      settlement: null,
      investigations: null,
      lines: null,
      optimization: null,
      error: null
    };
    
    try {
      // Run scan with 48h window and low minScore to capture everything
      const result = await runScan(48, 30, env);
      console.log("Cron scan completed successfully");
      cronStatus.scan = {
        signals: result.signals?.length || 0,
        success: result.success
      };
      
      // Check for new high-value signals and send alerts
      let alertableSignals = [];
      if (result.success && result.signals && result.signals.length > 0) {
        // Only check signals that meet alert thresholds (score >= 100, bet >= $20k)
        alertableSignals = result.signals.filter(s => s.score >= 100 && s.largestBet >= 20000);
        if (alertableSignals.length > 0) {
          // Alerts fire FIRST, unblocked - never coupled to LLM latency.
          await checkAndSendAlerts(alertableSignals, env);
          console.log(`Checked ${alertableSignals.length} signals for alerts`);
        }
      }

      // AGENT INVESTIGATION: independently price the top alert-tier signals.
      // Runs after alerts (decoupled), bounded per run and per day for cost.
      if (env.ANTHROPIC_API_KEY && alertableSignals.length > 0) {
        try {
          const perRun = parseInt(env.INVESTIGATION_PER_RUN || "2", 10);
          const dailyCap = parseInt(env.INVESTIGATION_DAILY_CAP || "50", 10);
          const spentToday = await investigationCountToday(env);
          const budget = Math.max(0, Math.min(perRun, dailyCap - spentToday));
          const candidates = alertableSignals
            .slice()
            .sort((a, b) => b.score - a.score)
            .slice(0, budget);
          let investigated = 0;
          for (const sig of candidates) {
            const r = await investigateSignal(env, sig);
            if (r.ok && !r.skipped) investigated++;
          }
          cronStatus.investigations = {
            attempted: candidates.length,
            completed: investigated,
            spentToday: spentToday + investigated,
            dailyCap: dailyCap
          };
          console.log(`Investigations: ${investigated}/${candidates.length} (${spentToday + investigated}/${dailyCap} today)`);
        } catch (e) {
          console.error("Investigation phase error:", e.message);
          cronStatus.investigations = { error: e.message };
        }
      }

      // Run settlement checker to learn from outcomes
      console.log("Running settlement checker...");
      const settlementResults = await processSettledSignals(env);
      console.log(`Settlement: ${settlementResults.processed} processed, ${settlementResults.wins}W-${settlementResults.losses}L`);
      cronStatus.settlement = settlementResults;
      
      // PHASE 2: Update line movements for active signals
      console.log("Checking line movements...");
      const lineResults = await updateLineMovements(env);
      console.log(`Line movements: ${lineResults.updated} updated, ${lineResults.confirmed} confirmed`);
      cronStatus.lines = lineResults;
      
      // PHASE 3: Optimize factor weights periodically (every ~hour based on 5min cron)
      // Only run if we've processed some signals
      if (settlementResults.processed > 0) {
        console.log("Optimizing factor weights...");
        const optimizeResults = await optimizeFactorWeights(env);
        console.log(`Optimization: ${optimizeResults.totalOptimized} factors updated`);
        cronStatus.optimization = optimizeResults;
      }
      
      cronStatus.completedAt = new Date().toISOString();
      
    } catch (error) {
      console.error("Cron scan failed:", error.message);
      cronStatus.error = error.message;
    }
    
    // Save cron status to KV for visibility
    if (env.SIGNALS_CACHE) {
      await env.SIGNALS_CACHE.put("cron_last_run", JSON.stringify(cronStatus), {
        expirationTtl: 24 * 60 * 60  // Keep for 24 hours
      });
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
    sureBet: 0,    // NEW: Track "sure bet" trades (odds too extreme to be meaningful)
    tooSmall: 0,
    gamblingMarket: 0,
    passed: 0
  };
  
  const gamblingMarketSamples = []; // Track some examples
  const tradeSamples = []; // Track a few full trades for debugging
  
  const validTrades = allTrades.filter((t) => {
    const marketTitle = t.title || t.market || '';
    
    // Track first 5 trades to see data structure
    if (tradeSamples.length < 5) {
      tradeSamples.push({
        title: t.title,
        market: t.market,
        slug: t.slug,
        outcome: t.outcome,
        side: t.side,
        usd_value: t.usd_value,
        size: t.size,
        price: t.price
      });
    }
    
    if (isShortTermGamblingMarket(marketTitle)) {
      debugCounts.gamblingMarket++;
      if (gamblingMarketSamples.length < 10) {
        gamblingMarketSamples.push(marketTitle);
      }
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
    
    // Filter out settlement-level prices (basically resolved)
    if (price >= 0.99 || price <= 0.01) {
      debugCounts.settlement++;
      return false;
    }
    
    // NEW: Filter out "sure bet" trades - odds too extreme to be meaningful signals
    // These inflate win rates because betting at 85%+ is almost guaranteed to win
    // They're not real "alpha" - just risk-free money grabs
    if (price >= 0.85 || price <= 0.15) {
      debugCounts.sureBet++;
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
  
  // Format direction for clearer display
// Polymarket outcomes can be confusing like "Under 76" or "Hawks Fails"
function formatDirectionForDisplay(direction, marketTitle, marketSlug) {
  if (!direction) return "Unknown";
  
  const dir = direction.toString();
  const title = (marketTitle || "").toLowerCase();
  const slug = (marketSlug || "").toLowerCase();
  
  // Check if this is an Over/Under market
  if (title.includes('o/u') || title.includes('over/under') || slug.includes('-total-') || slug.includes('-over-') || slug.includes('-under-')) {
    // Extract the total number from the title if possible
    const totalMatch = title.match(/o\/u\s*([\d.]+)/i) || title.match(/total[:\s]*([\d.]+)/i) || slug.match(/total-([\d]+pt[\d]+)/);
    
    if (dir.toLowerCase().includes('over')) {
      return totalMatch ? `Over ${totalMatch[1].replace('pt', '.')}` : 'Over';
    }
    if (dir.toLowerCase().includes('under')) {
      return totalMatch ? `Under ${totalMatch[1].replace('pt', '.')}` : 'Under';
    }
    // If direction doesn't say over/under but market is O/U, check the direction
    // Sometimes Polymarket uses weird outcomes like "Under 76" which should be "Under"
    if (dir.match(/^under\s*\d/i)) {
      return totalMatch ? `Under ${totalMatch[1].replace('pt', '.')}` : 'Under';
    }
    if (dir.match(/^over\s*\d/i)) {
      return totalMatch ? `Over ${totalMatch[1].replace('pt', '.')}` : 'Over';
    }
  }
  
  // Check if this is a Spread market
  if (title.includes('spread') || slug.includes('-spread-')) {
    // "Hawks Fails" should become "Against Hawks" or "Fade Hawks"
    if (dir.toLowerCase().includes('fails') || dir.toLowerCase().includes('fail')) {
      const teamMatch = dir.match(/^(\w+)\s*fails?/i);
      if (teamMatch) {
        return `Fade ${teamMatch[1]}`;
      }
    }
    // "Hawks Covers" should stay as is or become "Hawks -5.5"
    if (dir.toLowerCase().includes('covers') || dir.toLowerCase().includes('cover')) {
      const teamMatch = dir.match(/^(\w+)\s*covers?/i);
      if (teamMatch) {
        return `${teamMatch[1]} Cover`;
      }
    }
    // If it's just a team name in a spread market, add context
    const spreadMatch = title.match(/spread[:\s]*(\w+)\s*\(([-+]?[\d.]+)\)/i);
    if (spreadMatch && dir.toLowerCase() === spreadMatch[1].toLowerCase()) {
      return `${dir} ${spreadMatch[2]}`;
    }
  }
  
  // For Yes/No markets, keep as is
  if (dir.toLowerCase() === 'yes' || dir.toLowerCase() === 'no') {
    return dir;
  }
  
  // Default: return the direction as-is but clean up weird suffixes
  return dir.replace(/\s*(fails?|covers?)\s*$/i, '').trim() || dir;
}

// Group trades by market+direction
  const groups = {};
  validTrades.forEach((t) => {
    const marketKey = t.slug || t.eventSlug || t.conditionId;
    // Use actual outcome from trade data, fallback to inferring from side
    const direction = t.outcome || (t.side === "BUY" ? "Yes" : "No");
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
  const debugGroups = []; // Track why groups don't become signals
  
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
      score += SCORES.FRESH_WHALE_HUGE;
      breakdown[`🚨 Fresh wallet WHALE ($${Math.round(largestFreshWalletBet / 1000)}k)`] = SCORES.FRESH_WHALE_HUGE;
    } else if (isLargestBetFresh && largestFreshWalletBet >= 25000) {
      score += SCORES.FRESH_WHALE_LARGE;
      breakdown[`🚨 Fresh wallet large ($${Math.round(largestFreshWalletBet / 1000)}k)`] = SCORES.FRESH_WHALE_LARGE;
    } else if (isLargestBetFresh && largestFreshWalletBet >= 10000) {
      score += SCORES.FRESH_WHALE_NOTABLE;
      breakdown[`⚠️ Fresh wallet ($${Math.round(largestFreshWalletBet / 1000)}k)`] = SCORES.FRESH_WHALE_NOTABLE;
    } else if (isLargestBetFresh && largestFreshWalletBet >= 5000) {
      score += SCORES.FRESH_WHALE_MEDIUM;
      breakdown[`Fresh wallet ($${Math.round(largestFreshWalletBet / 1000)}k)`] = SCORES.FRESH_WHALE_MEDIUM;
    } else if (isLargestBetFresh && largestFreshWalletBet >= 2000) {
      score += SCORES.FRESH_WALLET_SMALL;
      breakdown[`Fresh wallet ($${Math.round(largestFreshWalletBet / 1000)}k)`] = SCORES.FRESH_WALLET_SMALL;
    } else if (g.largestBet >= 50000) {
      // Not fresh - use regular whale scoring
      score += SCORES.WHALE_BET_MASSIVE;
      breakdown[`🐋 Massive whale ($${Math.round(g.largestBet / 1000)}k)`] = SCORES.WHALE_BET_MASSIVE;
    } else if (g.largestBet >= 25000) {
      score += SCORES.WHALE_BET_LARGE;
      breakdown[`🐋 Large whale ($${Math.round(g.largestBet / 1000)}k)`] = SCORES.WHALE_BET_LARGE;
    } else if (g.largestBet >= 15000) {
      score += SCORES.WHALE_BET_NOTABLE;
      breakdown[`🐋 Notable bet ($${Math.round(g.largestBet / 1000)}k)`] = SCORES.WHALE_BET_NOTABLE;
    } else if (g.largestBet >= 8000) {
      score += SCORES.WHALE_BET_MEDIUM;
      breakdown[`Solid bet ($${Math.round(g.largestBet / 1000)}k)`] = SCORES.WHALE_BET_MEDIUM;
    } else if (g.largestBet >= 3000) {
      score += SCORES.WHALE_BET_SMALL;
      breakdown[`Notable bet ($${Math.round(g.largestBet / 1000)}k)`] = SCORES.WHALE_BET_SMALL;
    }
    
    // ============================================
    // CONCENTRATION (few wallets controlling action)
    // ============================================
    const topWalletPct = topWalletVolume / g.totalVolume;
    const top2Pct = top2WalletsVolume / g.totalVolume;
    
    // Single whale concentration: 1 wallet has >80% AND bet $10k+
    if (numWallets <= 2 && topWalletPct >= 0.80 && topWalletVolume >= 10000) {
      score += SCORES.CONCENTRATION_SINGLE_WHALE;
      breakdown[`🎯 Concentrated (${Math.round(topWalletPct * 100)}% from 1 wallet)`] = SCORES.CONCENTRATION_SINGLE_WHALE;
    } 
    // Whale duo: 2 wallets have >80% AND both bet $5k+
    else if (numWallets === 2 && top2Pct >= 0.80 && topWalletVolume >= 5000 && secondWalletVolume >= 5000) {
      score += SCORES.CONCENTRATION_WHALE_DUO;
      breakdown[`🎯 Whale duo (both $5k+)`] = SCORES.CONCENTRATION_WHALE_DUO;
    }
    // High concentration with decent bet
    else if (topWalletPct >= 0.60 && topWalletVolume >= 5000) {
      score += SCORES.CONCENTRATION_HIGH;
      breakdown[`🎯 Concentrated (${Math.round(topWalletPct * 100)}%)`] = SCORES.CONCENTRATION_HIGH;
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
    // COORDINATED (multiple wallets betting together)
    // ============================================
    if (numWallets >= 3 && g.timestamps.length >= 3) {
      const sortedTimes = [...g.timestamps].sort((a, b) => a - b);
      const timeSpan = sortedTimes[sortedTimes.length - 1] - sortedTimes[0];
      const twoHours = 2 * 60 * 60 * 1000;
      
      if (timeSpan <= twoHours) {
        // Check if ALL wallets are betting decent amounts
        const minBetInGroup = Math.min(...sortedWalletVolumes.slice(0, numWallets));
        
        if (minBetInGroup >= 5000) {
          score += SCORES.COORDINATED_WHALES;
          breakdown[`🔗 Coordinated (${numWallets} wallets, ALL $5k+)`] = SCORES.COORDINATED_WHALES;
        } else if (minBetInGroup >= 2000) {
          score += SCORES.COORDINATED_LARGE;
          breakdown[`Coordinated (${numWallets} wallets, ALL $2k+)`] = SCORES.COORDINATED_LARGE;
        }
      }
    }
    
    // ============================================
    // VOLUME
    // ============================================
    if (g.totalVolume >= 100000) {
      score += SCORES.VOLUME_MASSIVE;
      breakdown[`Volume >$100k`] = SCORES.VOLUME_MASSIVE;
    } else if (g.totalVolume >= 50000) {
      score += SCORES.VOLUME_LARGE;
      breakdown[`Volume >$50k`] = SCORES.VOLUME_LARGE;
    } else if (g.totalVolume >= 25000) {
      score += SCORES.VOLUME_NOTABLE;
      breakdown[`Volume >$25k`] = SCORES.VOLUME_NOTABLE;
    } else if (g.totalVolume >= 10000) {
      score += SCORES.VOLUME_MEDIUM;
      breakdown[`Volume >$10k`] = SCORES.VOLUME_MEDIUM;
    }
    
    // ============================================
    // RAPID ACCUMULATION
    // ============================================
    const sortedTimes = [...g.timestamps].sort((a, b) => a - b);
    const timeSpan = sortedTimes[sortedTimes.length - 1] - sortedTimes[0];
    const thirtyMinutes = 30 * 60 * 1000;
    
    if (timeSpan <= thirtyMinutes && g.totalVolume >= 10000) {
      score += SCORES.RAPID_ACCUMULATION;
      breakdown[`Rapid ($${Math.round(g.totalVolume / 1000)}k in ${Math.round(timeSpan / 60000)}min)`] = SCORES.RAPID_ACCUMULATION;
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
    // EXTREME ODDS (betting on long shots or heavy favorites)
    // ============================================
    const avgPrice = g.trades.reduce((sum, t) => sum + parseFloat(t.price || 0), 0) / g.trades.length;
    if ((avgPrice < 0.15 || avgPrice > 0.85) && g.largestBet >= 2000) {
      score += SCORES.EXTREME_ODDS;
      breakdown[`Extreme odds (${Math.round(avgPrice * 100)}%)`] = SCORES.EXTREME_ODDS;
    } else if ((avgPrice < 0.25 || avgPrice > 0.75) && g.largestBet >= 3000) {
      score += SCORES.MODERATE_ODDS;
      breakdown[`Strong odds (${Math.round(avgPrice * 100)}%)`] = SCORES.MODERATE_ODDS;
    }
    
    // ============================================
    // LAST-MINUTE BETTING (close to event)
    // ============================================
    const eventDate = getEventDate(g.marketTitle, g.marketSlug);
    if (eventDate && g.largestBet >= 10000) {
      const lastTradeTimestamp = Math.max(...g.timestamps);
      const hoursUntilEvent = (eventDate.getTime() - lastTradeTimestamp) / (1000 * 60 * 60);
      
      // Only apply if event is in the future
      if (hoursUntilEvent > 0 && hoursUntilEvent <= 12) {
        if (hoursUntilEvent <= 2) {
          score += SCORES.LAST_MINUTE_WHALE_2H;
          breakdown[`⏰ Last-minute (${hoursUntilEvent.toFixed(1)}h before)`] = SCORES.LAST_MINUTE_WHALE_2H;
        } else if (hoursUntilEvent <= 6) {
          score += SCORES.LAST_MINUTE_WHALE_6H;
          breakdown[`⏰ Pre-event (${hoursUntilEvent.toFixed(1)}h before)`] = SCORES.LAST_MINUTE_WHALE_6H;
        } else if (hoursUntilEvent <= 12) {
          score += SCORES.LAST_MINUTE_WHALE_12H;
          breakdown[`⏰ Same-day (${hoursUntilEvent.toFixed(1)}h before)`] = SCORES.LAST_MINUTE_WHALE_12H;
        }
      }
    }
    
    // ============================================
    // PHASE 2: SHARP VS PUBLIC DIVERGENCE
    // ============================================
    const sharpVsPublic = analyzeSharpVsPublic(g.trades);
    if (sharpVsPublic && sharpVsPublic.detected) {
      score += sharpVsPublic.bonus;
      breakdown[sharpVsPublic.label] = sharpVsPublic.bonus;
    }
    
    // ============================================
    // PHASE 2: WALLET TIER SCORING
    // ============================================
    const walletAddresses = Array.from(g.wallets);
    const tierInfo = await getWalletTierMultiplier(env, walletAddresses);
    
    // Store original score before multiplier
    const baseScore = score;
    
    if (tierInfo.multiplier !== 1.0 && tierInfo.bestTier) {
      // Apply tier multiplier
      score = Math.round(score * tierInfo.multiplier);
      if (tierInfo.multiplier > 1.0) {
        breakdown[tierInfo.label] = `x${tierInfo.multiplier} multiplier`;
      } else {
        breakdown[tierInfo.label] = `x${tierInfo.multiplier} (caution!)`;
      }
    }
    
    // ============================================
    // PHASE 2: HOT/COLD STREAK BONUS
    // ============================================
    const streakInfo = await getStreakBonus(env, walletAddresses);
    if (streakInfo.bonus !== 0) {
      score += streakInfo.bonus;
      breakdown[streakInfo.label] = streakInfo.bonus;
    }
    
    // Skip events that have already started
    if (hasEventStarted(g.marketTitle, g.marketSlug, avgPrice)) {
      debugGroups.push({
        market: g.marketTitle,
        reason: 'hasEventStarted',
        largestBet: Math.round(g.largestBet),
        volume: Math.round(g.totalVolume),
        score
      });
      continue;
    }
    
    // Track groups that don't meet score threshold
    if (score < 15) {
      debugGroups.push({
        market: g.marketTitle,
        reason: `score ${score} < 15`,
        largestBet: Math.round(g.largestBet),
        volume: Math.round(g.totalVolume),
        score,
        breakdown
      });
    }
    
    // Store signals with score >= 15
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
        direction: formatDirectionForDisplay(g.direction, g.marketTitle, g.marketSlug),
        directionRaw: g.direction, // Keep raw for settlement matching
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
      
      // ============================================
      // PHASE 3: CONFIDENCE & FADE DETECTION
      // ============================================
      
      // Extract factors for learning
      const factors = [];
      if (freshWalletCount > 0 && g.largestBet >= 2000) factors.push("freshWallet");
      if (g.largestBet >= 50000) factors.push("whaleSize50k");
      else if (g.largestBet >= 25000) factors.push("whaleSize25k");
      else if (g.largestBet >= 15000) factors.push("whaleSize15k");
      if (hoursUntilEvent && hoursUntilEvent <= 2) factors.push("lastMinute2h");
      else if (hoursUntilEvent && hoursUntilEvent <= 6) factors.push("lastMinute6h");
      if (breakdown["🎯 Concentrated (100% from 1 wallet)"] || breakdown["🎯 Concentrated (90%)"]) factors.push("concentrated");
      if (breakdown["🔗 Coordinated (3+ wallets, ALL $5k+)"] || breakdown["Coordinated (3+ wallets, ALL $2k+)"]) factors.push("coordinated");
      if (avgEntry >= 85 || avgEntry <= 15) factors.push("extremeOdds");
      if (sharpVsPublic && sharpVsPublic.detected) factors.push("sharpVsPublic");
      if (tierInfo.bestTier === "ELITE") factors.push("eliteWallet");
      if (tierInfo.bestTier === "STRONG") factors.push("strongWallet");
      
      const marketType = detectMarketType(g.marketTitle);
      if (marketType === "political") factors.push("politicalMarket");
      if (marketType === "sports") factors.push("sportsMarket");
      if (marketType === "crypto") factors.push("cryptoMarket");
      
      // Get wallet addresses involved
      const involvedWallets = Array.from(g.wallets).slice(0, 10);
      
      // Calculate confidence (Phase 3)
      const confidence = await calculateConfidence(env, factors, involvedWallets, score);
      signal.confidence = confidence.confidence;
      signal.confidenceLevel = confidence.level;
      signal.confidenceLabel = confidence.label;
      
      // Check for fade opportunity (Phase 3)
      const fadeCheck = await checkFadeOpportunity(env, involvedWallets, g.direction, g.largestBet);
      if (fadeCheck && fadeCheck.isFade) {
        signal.fadeAlert = {
          isFade: true,
          fadeDirection: fadeCheck.fadeDirection,
          losingWallet: fadeCheck.fadeWallet,
          walletWinRate: fadeCheck.walletWinRate,
          walletRecord: fadeCheck.walletRecord,
          confidence: fadeCheck.confidence,
          reasoning: fadeCheck.reasoning
        };
        // Add to breakdown
        breakdown[fadeCheck.label] = "⚠️ FADE";
      }
      
      // Store signal for learning (async, don't await)
      if (env.SIGNALS_CACHE && score >= 50) {
        storeSignalForLearning(env, signal, factors, involvedWallets).catch(e => 
          console.error("Error storing signal for learning:", e.message)
        );
        
        // PHASE 2: Track line movement for this signal
        trackLineMovement(env, g.marketSlug, g.direction, avgEntry, signal.id).catch(e =>
          console.error("Error tracking line movement:", e.message)
        );
        
        // Track wallets that placed significant bets ($1k+ for tracking purposes)
        for (const trade of g.trades) {
          if (trade._usdValue >= 1000) {
            const wallet = trade.proxyWallet || trade.user || trade.maker;
            if (wallet) {
              updateWalletStats(env, wallet, {
                signalId: signal.id,
                market: g.marketTitle,
                marketSlug: g.marketSlug,
                direction: formatDirectionForDisplay(g.direction, g.marketTitle, g.marketSlug),
                directionRaw: g.direction,
                amount: trade._usdValue,
                price: Math.round(parseFloat(trade.price || 0) * 100)
              }).catch(e => console.error("Error updating wallet:", e.message));
            }
          }
        }
      }
      
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
  // This is a quick heuristic filter based on date/time
  const activeSignals = filteredSignals.filter(s => {
    return !hasEventStarted(s.marketTitle, s.marketSlug, s.avgEntryPrice / 100);
  });
  
  // Additional filter: Check if market appears resolved based on current price
  // If we have the current market price and it's at 99%+ or 1%-, market is resolved
  const trulyActiveSignals = activeSignals.filter(s => {
    // If currentPrice is at resolution levels, filter it out
    const price = s.currentPrice || s.avgEntryPrice;
    if (price >= 99 || price <= 1) {
      console.log(`Filtering resolved market: ${s.marketTitle} (price: ${price}%)`);
      return false;
    }
    
    // Check if event date has passed (more thorough check)
    const eventDate = getEventDate(s.marketTitle, s.marketSlug);
    if (eventDate) {
      const now = new Date();
      // If event date + 6 hours has passed, filter it out
      // This gives buffer for games to finish
      const eventEndTime = new Date(eventDate.getTime() + 6 * 60 * 60 * 1000);
      if (now > eventEndTime) {
        console.log(`Filtering past event: ${s.marketTitle} (event: ${eventDate.toISOString()})`);
        return false;
      }
    }
    
    return true;
  });
  
  // Filter by min score and sort
  const finalSignals = trulyActiveSignals
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score);
  
  // In debug mode, include all signals before score filtering
  const debugAllSignals = debugMode ? trulyActiveSignals.sort((a, b) => b.score - a.score).map(s => ({
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
    '100+': trulyActiveSignals.filter(s => s.score >= 100).length,
    '80-99': trulyActiveSignals.filter(s => s.score >= 80 && s.score < 100).length,
    '60-79': trulyActiveSignals.filter(s => s.score >= 60 && s.score < 80).length,
    '40-59': trulyActiveSignals.filter(s => s.score >= 40 && s.score < 60).length,
    '20-39': trulyActiveSignals.filter(s => s.score >= 20 && s.score < 40).length,
    '1-19': trulyActiveSignals.filter(s => s.score >= 1 && s.score < 20).length,
    '0': trulyActiveSignals.filter(s => s.score === 0).length
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
        minScoreUsed: minScore,
        groupsFiltered: debugGroups.slice(0, 30),
        gamblingMarketSamples,
        tradeSamples
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
      // Aggregate trades by market
      recentActivity: (() => {
        const marketAgg = {};
        
        trades.forEach(t => {
          const market = t.title || t.slug || 'Unknown Market';
          const amount = parseFloat(t.usdcSize) || 0;
          const side = t.side;
          const key = `${market}-${side}-${t.outcome || 'YES'}`;
          
          if (!marketAgg[key]) {
            marketAgg[key] = {
              market: market,
              marketSlug: t.slug,
              eventSlug: t.eventSlug,
              marketUrl: t.slug ? `https://polymarket.com/market/${t.slug}` : null,
              side: side,
              outcome: t.outcome,
              totalAmount: 0,
              tradeCount: 0,
              avgPrice: 0,
              priceSum: 0,
              lastTime: 0,
              firstTime: Infinity,
              icon: t.icon
            };
          }
          
          marketAgg[key].totalAmount += amount;
          marketAgg[key].tradeCount += 1;
          marketAgg[key].priceSum += (parseFloat(t.price) || 0);
          
          const timestamp = t.timestamp < 1e12 ? t.timestamp * 1000 : t.timestamp;
          if (timestamp > marketAgg[key].lastTime) {
            marketAgg[key].lastTime = timestamp;
          }
          if (timestamp < marketAgg[key].firstTime) {
            marketAgg[key].firstTime = timestamp;
          }
        });
        
        // Convert to array and calculate averages
        return Object.values(marketAgg)
          .map(m => ({
            market: m.market,
            marketSlug: m.marketSlug,
            eventSlug: m.eventSlug,
            marketUrl: m.marketUrl,
            side: m.side,
            outcome: m.outcome,
            amount: Math.round(m.totalAmount),
            tradeCount: m.tradeCount,
            price: Math.round((m.priceSum / m.tradeCount) * 100),
            time: formatTimestamp(m.lastTime),
            icon: m.icon
          }))
          .filter(m => m.amount >= 10) // Filter out tiny aggregates
          .sort((a, b) => new Date(b.time) - new Date(a.time))
          .slice(0, 30);
      })()
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
    // Fetch all activity to analyze bets
    const [activityRes, positionsRes] = await Promise.all([
      fetch(`${POLYMARKET_API}/activity?user=${address}&limit=500`),
      fetch(`${POLYMARKET_API}/positions?user=${address}`)
    ]);
    
    let activity = [];
    let positions = [];
    
    if (activityRes.ok) {
      activity = await activityRes.json() || [];
    }
    if (positionsRes.ok) {
      positions = await positionsRes.json() || [];
    }
    
    // Group activity by market to track full bet lifecycle
    const marketBets = {};
    
    activity.forEach(a => {
      const market = a.slug || a.conditionId;
      if (!market) return;
      
      if (!marketBets[market]) {
        marketBets[market] = {
          title: a.title || market,
          slug: a.slug,
          icon: a.icon,
          buys: [],
          sells: [],
          redeems: [],
          outcome: a.outcome
        };
      }
      
      // Update outcome if we get one (some activities might have it, some might not)
      if (a.outcome && !marketBets[market].outcome) {
        marketBets[market].outcome = a.outcome;
      }
      
      const usdValue = parseFloat(a.usdcSize) || parseFloat(a.usd_value) || 0;
      const timestamp = a.timestamp < 1e12 ? a.timestamp * 1000 : a.timestamp;
      
      if (a.type === 'BUY' || a.side === 'BUY') {
        marketBets[market].buys.push({ amount: usdValue, time: timestamp, price: parseFloat(a.price) || 0, outcome: a.outcome });
      } else if (a.type === 'SELL' || a.side === 'SELL') {
        marketBets[market].sells.push({ amount: usdValue, time: timestamp, price: parseFloat(a.price) || 0 });
      } else if (a.type === 'REDEEM') {
        marketBets[market].redeems.push({ amount: usdValue, time: timestamp });
      }
    });
    
    // Analyze each market bet
    const resolvedBets = [];
    const openBets = [];
    let totalWins = 0;
    let totalLosses = 0;
    let winCount = 0;
    let lossCount = 0;
    
    // Helper function to check if market is likely settled based on title/date
    const isMarketLikelySettled = (title, slug, position) => {
      const titleLower = (title || '').toLowerCase();
      const slugLower = (slug || '').toLowerCase();
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;
      
      // Check for past years in title (2024, 2023, etc. when we're in 2026)
      const yearMatch = titleLower.match(/\b(20\d{2})\b/);
      if (yearMatch) {
        const year = parseInt(yearMatch[1]);
        if (year < currentYear) {
          return true; // Past year = settled
        }
      }
      
      // Check for specific past dates in slug (format: 2025-10-29)
      const dateMatch = slugLower.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (dateMatch) {
        const eventDate = new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]));
        if (eventDate < now) {
          return true; // Past date = settled
        }
      }
      
      // Check for month+year patterns like "October 2025"
      const monthYearPatterns = [
        /january\s+(\d{4})/i, /february\s+(\d{4})/i, /march\s+(\d{4})/i,
        /april\s+(\d{4})/i, /may\s+(\d{4})/i, /june\s+(\d{4})/i,
        /july\s+(\d{4})/i, /august\s+(\d{4})/i, /september\s+(\d{4})/i,
        /october\s+(\d{4})/i, /november\s+(\d{4})/i, /december\s+(\d{4})/i
      ];
      
      for (let i = 0; i < monthYearPatterns.length; i++) {
        const match = titleLower.match(monthYearPatterns[i]);
        if (match) {
          const year = parseInt(match[1]);
          const month = i + 1;
          // If month/year is in the past
          if (year < currentYear || (year === currentYear && month < currentMonth)) {
            return true;
          }
        }
      }
      
      // Check if current price is essentially resolved (99.5%+ or 0.5%-)
      // This is tighter than before to avoid catching in-progress games
      const curPrice = parseFloat(position?.curPrice || position?.currentPrice || 0);
      if (curPrice >= 0.995 || curPrice <= 0.005) {
        return true;
      }
      
      return false;
    };
    
    for (const [market, data] of Object.entries(marketBets)) {
      const totalBought = data.buys.reduce((sum, b) => sum + b.amount, 0);
      const totalSold = data.sells.reduce((sum, s) => sum + s.amount, 0);
      const totalRedeemed = data.redeems.reduce((sum, r) => sum + r.amount, 0);
      const avgBuyPrice = data.buys.length > 0 
        ? data.buys.reduce((sum, b) => sum + b.price, 0) / data.buys.length 
        : 0;
      
      // Check if market is resolved (has redeems or position is closed)
      const position = positions.find(p => p.slug === market || p.conditionId === market);
      const hasPosition = position && parseFloat(position.size || 0) > 0;
      
      // Check if market appears to be settled even if position shows as "open"
      const likelySettled = isMarketLikelySettled(data.title, data.slug, position);
      const isOpen = hasPosition && !likelySettled;
      
      if (totalRedeemed > 0) {
        // Won - got payout
        const profit = totalRedeemed - totalBought + totalSold;
        totalWins += Math.max(0, profit);
        winCount++;
        resolvedBets.push({
          market: data.title,
          marketSlug: data.slug,
          outcome: data.outcome,
          result: 'WIN',
          invested: Math.round(totalBought),
          returned: Math.round(totalRedeemed + totalSold),
          profit: Math.round(profit),
          profitPct: totalBought > 0 ? Math.round((profit / totalBought) * 100) : 0,
          avgPrice: Math.round(avgBuyPrice * 100),
          time: data.redeems[0]?.time ? new Date(data.redeems[0].time).toISOString() : null,
          icon: data.icon
        });
      } else if (!isOpen && totalBought > 0 && totalRedeemed === 0) {
        // Market is settled (no position or likelySettled) with no redeem
        // Check if this might be an unredeemed WIN based on current value
        const currentValue = parseFloat(position?.currentValue || position?.value || 0);
        const currentPrice = parseFloat(position?.curPrice || position?.currentPrice || 0);
        
        // If current value is significantly positive or price is near 100%, it's likely a win they haven't redeemed
        if (currentValue > totalBought * 0.5 || currentPrice >= 0.95) {
          // Likely an unredeemed WIN
          const profit = currentValue - totalBought + totalSold;
          if (profit > 0) {
            totalWins += profit;
            winCount++;
          }
          resolvedBets.push({
            market: data.title,
            marketSlug: data.slug,
            outcome: data.outcome,
            result: 'WIN',
            invested: Math.round(totalBought),
            returned: Math.round(currentValue + totalSold),
            profit: Math.round(profit),
            profitPct: totalBought > 0 ? Math.round((profit / totalBought) * 100) : 0,
            avgPrice: Math.round(avgBuyPrice * 100),
            time: data.buys[data.buys.length - 1]?.time ? new Date(data.buys[data.buys.length - 1].time).toISOString() : null,
            icon: data.icon,
            note: 'Unredeemed'
          });
        } else {
          // Lost - bought but no redeem and low/no value
          const loss = totalBought - totalSold - currentValue;
          if (loss > 0) {
            totalLosses += loss;
            lossCount++;
            resolvedBets.push({
              market: data.title,
              marketSlug: data.slug,
              outcome: data.outcome,
              result: 'LOSS',
              invested: Math.round(totalBought),
              returned: Math.round(totalSold + currentValue),
              profit: Math.round(-loss),
              profitPct: totalBought > 0 ? Math.round((-loss / totalBought) * 100) : 0,
              avgPrice: Math.round(avgBuyPrice * 100),
              time: data.buys[data.buys.length - 1]?.time ? new Date(data.buys[data.buys.length - 1].time).toISOString() : null,
              icon: data.icon
            });
          }
        }
      } else if (isOpen) {
        // Check if this is actually a resolved loss (current value is $0 or near $0)
        const currentValue = parseFloat(position.currentValue || position.value || 0);
        const currentPrice = parseFloat(position.curPrice || position.currentPrice || 0);
        
        // If current value is $0 (or very small) and they invested significant money, it's a loss
        // Also check if current price is near 0 (market resolved against this position)
        if ((currentValue < 1 || currentPrice < 0.02) && totalBought > 100) {
          // This is a resolved loss, not an open position
          const loss = totalBought - totalSold;
          totalLosses += loss;
          lossCount++;
          resolvedBets.push({
            market: data.title,
            marketSlug: data.slug,
            outcome: data.outcome,
            result: 'LOSS',
            invested: Math.round(totalBought),
            returned: Math.round(totalSold),
            profit: Math.round(-loss),
            profitPct: totalBought > 0 ? Math.round((-loss / totalBought) * 100) : 0,
            avgPrice: Math.round(avgBuyPrice * 100),
            time: data.buys[data.buys.length - 1]?.time ? new Date(data.buys[data.buys.length - 1].time).toISOString() : null,
            icon: data.icon
          });
        } else {
          // Actually still open - use position outcome as fallback
          const outcomeToUse = data.outcome || position.outcome || 
            (data.buys.length > 0 ? data.buys[0].outcome : null);
          const unrealizedPnL = currentValue - totalBought + totalSold;
          openBets.push({
            market: data.title,
            marketSlug: data.slug,
            outcome: outcomeToUse,
            invested: Math.round(totalBought),
            currentValue: Math.round(currentValue),
            unrealizedPnL: Math.round(unrealizedPnL),
            unrealizedPct: totalBought > 0 ? Math.round((unrealizedPnL / totalBought) * 100) : 0,
            avgPrice: Math.round(avgBuyPrice * 100),
            currentPrice: Math.round((parseFloat(position.curPrice) || 0) * 100),
            icon: data.icon
          });
        }
      }
    }
    
    // Sort resolved bets by time (most recent first)
    resolvedBets.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
    
    const totalInvested = Object.values(marketBets).reduce((sum, m) => 
      sum + m.buys.reduce((s, b) => s + b.amount, 0), 0);
    
    const realizedPnL = totalWins - totalLosses;
    const unrealizedPnL = openBets.reduce((sum, b) => sum + b.unrealizedPnL, 0);
    
    return {
      success: true,
      summary: {
        totalInvested: Math.round(totalInvested),
        realizedPnL: Math.round(realizedPnL),
        unrealizedPnL: Math.round(unrealizedPnL),
        totalPnL: Math.round(realizedPnL + unrealizedPnL),
        totalWins: Math.round(totalWins),
        totalLosses: Math.round(totalLosses),
        winCount,
        lossCount,
        winRate: winCount + lossCount > 0 ? Math.round((winCount / (winCount + lossCount)) * 100) : 0,
        openPositions: openBets.length
      },
      resolvedBets: resolvedBets.slice(0, 50),
      openBets: openBets.slice(0, 20)
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

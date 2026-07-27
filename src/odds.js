// The Odds API integration - sports settlement + Vegas-odds comparison.
// Extracted from index.js (behaviourally identical).

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


export {
  ODDS_API_BASE, SPORT_KEY_MAP, TEAM_ALIASES,
  detectSportFromSlug, extractTeamsFromSlug, getTeamFullName,
  getGameScores, getGameOdds, findMatchingGame,
  americanToProb, probToAmerican, calculateEdge, settleWithOddsAPI
};

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
  'wnba': 'basketball_wnba',
  'mlb': 'baseball_mlb',
  'nhl': 'icehockey_nhl',
  'ncaaf': 'americanfootball_ncaaf',
  'cfb': 'americanfootball_ncaaf',   // Polymarket's actual college football slug prefix
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
  if (slugLower.startsWith('cfb-')) return 'cfb';   // Polymarket slugs CFB games cfb-<away>-<home>-<date>
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
  
  // Pattern: nfl-ne-den-2026-01-25, nba-lal-bos-2026-01-25, cfb-mphs-unlv-2026-08-30
  var match = slug.match(/^(?:nfl|nba|mlb|nhl|ncaaf|ncaab|cfb|wnba)-([a-z0-9]+)-([a-z0-9]+)-\d{4}-\d{2}-\d{2}/i);
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

// KV-cached fetch wrapper for The Odds API. Every uncached call costs credits
// (1 per market per region), so we serve a recent cached copy when possible.
// The free tier is only ~500 credits/month; caching keeps sustained use viable.
async function cachedOddsFetch(env, cacheKey, url, ttlSeconds) {
  if (env.SIGNALS_CACHE) {
    try {
      var hit = await env.SIGNALS_CACHE.get(cacheKey, { type: "json" });
      if (hit) return hit;
    } catch (e) { /* fall through to live fetch */ }
  }
  var response = await fetch(url);
  if (!response.ok) {
    console.error("Odds API error " + response.status + " for " + cacheKey);
    return null;
  }
  var data = await response.json();
  if (env.SIGNALS_CACHE && data) {
    try { await env.SIGNALS_CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: ttlSeconds }); } catch (e) { /* best-effort */ }
  }
  return data;
}

// Get scores/results from The Odds API (cached 30 min - final scores are stable).
async function getGameScores(env, sportKey, daysFrom) {
  if (!env.ODDS_API_KEY) {
    console.log("No ODDS_API_KEY configured");
    return null;
  }
  try {
    var df = daysFrom || 3;
    var url = ODDS_API_BASE + "/sports/" + sportKey + "/scores/?apiKey=" + env.ODDS_API_KEY + "&daysFrom=" + df;
    return await cachedOddsFetch(env, "odds_scores:" + sportKey + ":" + df, url, 1800);
  } catch (e) {
    console.error("Error fetching scores:", e.message);
    return null;
  }
}

// Get current odds from The Odds API (cached 15 min to conserve credits).
async function getGameOdds(env, sportKey, markets) {
  if (!env.ODDS_API_KEY) {
    console.log("No ODDS_API_KEY configured");
    return null;
  }
  try {
    var mk = markets || 'h2h,spreads';
    var url = ODDS_API_BASE + "/sports/" + sportKey + "/odds/?apiKey=" + env.ODDS_API_KEY + "&regions=us&markets=" + mk + "&oddsFormat=american";
    return await cachedOddsFetch(env, "odds_lines:" + sportKey + ":" + mk, url, 900);
  } catch (e) {
    console.error("Error fetching odds:", e.message);
    return null;
  }
}

// Loose team-name equivalence. Handles the college problem: TEAM_ALIASES
// only covers pro teams, but Polymarket titles/outcomes carry full school
// names ("Jacksonville State") that the Odds API decorates with mascots
// ("Jacksonville State Gamecocks"). Substring either way, or at least two
// significant shared words (one suffices for single-word names like
// "Memphis"). "state"/"the" are too common to count.
function teamNamesOverlap(a, b) {
  a = String(a || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  b = String(b || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!a || !b) return false;
  if (a === b || b.includes(a) || a.includes(b)) return true;
  var words = a.split(' ').filter(function (w) {
    return w.length >= 3 && w !== 'the' && w !== 'state' && w !== 'university';
  });
  if (words.length === 0) return false;
  var hits = 0;
  for (var i = 0; i < words.length; i++) {
    if (b.includes(words[i])) hits++;
  }
  return hits >= Math.min(2, words.length);
}

// Split a "Away vs. Home" / "Away @ Home" market title into its two team
// strings. Returns null when the title isn't a matchup.
function teamsFromTitle(title) {
  var m = String(title || '').split(/\s+(?:vs\.?|@)\s+/i);
  if (m.length !== 2 || !m[0].trim() || !m[1].trim()) return null;
  return { away: m[0].trim(), home: m[1].trim() };
}

// Find matching game in Odds API results. Slug codes resolve via
// TEAM_ALIASES for pro leagues; for college (and any unmapped code) the
// optional market title's team names are the fallback matcher.
function findMatchingGame(games, homeTeamCode, awayTeamCode, marketTitle) {
  if (!games || !Array.isArray(games)) return null;

  var homeFullName = getTeamFullName(homeTeamCode);
  var awayFullName = getTeamFullName(awayTeamCode);
  var titleTeams = teamsFromTitle(marketTitle);

  for (var i = 0; i < games.length; i++) {
    var game = games[i];
    var gameHome = game.home_team || '';
    var gameAway = game.away_team || '';

    if ((teamNamesOverlap(homeFullName, gameHome) && teamNamesOverlap(awayFullName, gameAway)) ||
        (teamNamesOverlap(homeFullName, gameAway) && teamNamesOverlap(awayFullName, gameHome))) {
      return game;
    }
    if (titleTeams) {
      if ((teamNamesOverlap(titleTeams.home, gameHome) && teamNamesOverlap(titleTeams.away, gameAway)) ||
          (teamNamesOverlap(titleTeams.home, gameAway) && teamNamesOverlap(titleTeams.away, gameHome))) {
        return game;
      }
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

// Settle sports bet using actual game results from The Odds API.
// marketTitle (optional) enables title-based game matching for leagues
// whose slug codes aren't in TEAM_ALIASES (college football et al).
async function settleWithOddsAPI(env, marketSlug, direction, marketTitle) {
  var sport = detectSportFromSlug(marketSlug);
  if (!sport) return null;

  var sportKey = SPORT_KEY_MAP[sport];
  if (!sportKey) return null;

  var teams = extractTeamsFromSlug(marketSlug);
  if (!teams) return null;

  var scores = await getGameScores(env, sportKey, 3);
  if (!scores) return null;

  var game = findMatchingGame(scores, teams.home, teams.away, marketTitle);
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
      
      // Check if direction won (overlap matcher covers college names)
      var dirTeam = getTeamFullName(direction);
      var didWin = teamNamesOverlap(dirTeam, spreadWinner);
      
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
  
  // Regular moneyline bet (overlap matcher covers college names)
  var dirTeamML = getTeamFullName(direction);
  var didWin = winner !== 'tie' && teamNamesOverlap(dirTeamML, winner);
  
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
  teamNamesOverlap, teamsFromTitle,
  getGameScores, getGameOdds, findMatchingGame,
  americanToProb, probToAmerican, calculateEdge, settleWithOddsAPI
};

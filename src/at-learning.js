// ============================================================
// AT-LEARNING.JS - learning-system helpers the autotrader engine reads
// Extracted from the v18 modular branch (learning.js) so the autotrader
// module runs against this Worker's KV without pulling in the whole v18
// learning system. Keys that this deployment doesn't populate yet simply
// return empty defaults, which the callers treat as "no adjustment".
// ============================================================

const LEARNING_KEYS = {
  FACTOR_STATS: "factor_stats",
  DISCOVERED_PATTERNS: "discovered_patterns",
  PATTERN_CANDIDATES: "pattern_candidates",
  MARKET_TYPE_STATS: "market_type_stats",
  TIME_PATTERNS: "time_patterns",
  VOLUME_BRACKETS: "volume_brackets"
};

const COMBO_KEY = 'factor_combos_v1';

export async function calculateConfidence(env, factors, signal = {}) {
  if (!env.SIGNALS_CACHE) return null;
  
  try {
    const factorStats = await env.SIGNALS_CACHE.get(LEARNING_KEYS.FACTOR_STATS, { type: "json" }) || {};
    const marketTypeStats = await env.SIGNALS_CACHE.get(LEARNING_KEYS.MARKET_TYPE_STATS, { type: "json" }) || {};
    const volumeBrackets = await env.SIGNALS_CACHE.get(LEARNING_KEYS.VOLUME_BRACKETS, { type: "json" }) || {};
    const timePatterns = await env.SIGNALS_CACHE.get(LEARNING_KEYS.TIME_PATTERNS, { type: "json" }) || {};
    
    let components = [];
    
    // 1. Factor-based confidence (primary)
    if (factors && factors.length > 0) {
      let totalWeight = 0;
      let weightedWinRate = 0;
      
      for (const factor of factors) {
        // Handle both { factor: 'name' } and { name: 'name' } formats, or plain string
        const factorName = typeof factor === 'object' ? (factor.factor || factor.name) : factor;
        if (!factorName) continue;
        
        const stats = factorStats[factorName];
        if (stats && stats.sampleSize >= 3) {
          const weight = stats.weight || 1.0;
          totalWeight += weight;
          weightedWinRate += stats.winRate * weight;
        }
      }
      
      if (totalWeight > 0) {
        components.push({
          source: 'factors',
          confidence: Math.round(weightedWinRate / totalWeight),
          weight: 3  // Factors are most important
        });
      }
    }
    
    // 2. Market type confidence
    if (signal.marketType && marketTypeStats[signal.marketType]) {
      const stats = marketTypeStats[signal.marketType];
      if ((stats.wins + stats.losses) >= 5) {
        components.push({
          source: 'market_type',
          confidence: stats.winRate,
          weight: 1
        });
      }
    }
    
    // 3. Volume bracket confidence
    if (signal.totalVolume) {
      let bracket;
      if (signal.totalVolume >= 100000) bracket = "vol_100k_plus";
      else if (signal.totalVolume >= 50000) bracket = "vol_50k_100k";
      else if (signal.totalVolume >= 25000) bracket = "vol_25k_50k";
      else if (signal.totalVolume >= 10000) bracket = "vol_10k_25k";
      else bracket = "vol_under_10k";
      
      if (volumeBrackets[bracket]) {
        const stats = volumeBrackets[bracket];
        if ((stats.wins + stats.losses) >= 5) {
          components.push({
            source: 'volume',
            confidence: stats.winRate,
            weight: 1
          });
        }
      }
    }
    
    // 4. Time pattern confidence
    if (signal.detectedAt) {
      const hour = new Date(signal.detectedAt).getUTCHours();
      let timeBlock;
      if (hour >= 5 && hour < 12) timeBlock = "morning_5_12";
      else if (hour >= 12 && hour < 17) timeBlock = "afternoon_12_17";
      else if (hour >= 17 && hour < 22) timeBlock = "evening_17_22";
      else timeBlock = "night_22_5";
      
      if (timePatterns[timeBlock]) {
        const stats = timePatterns[timeBlock];
        if ((stats.wins + stats.losses) >= 5) {
          components.push({
            source: 'time',
            confidence: stats.winRate,
            weight: 0.5
          });
        }
      }
    }
    
    // 5. Event timing confidence (NEW - how close to event)
    const candidates = await env.SIGNALS_CACHE.get(LEARNING_KEYS.PATTERN_CANDIDATES, { type: "json" }) || {};
    if (factors) {
      const factorNames = factors.map(f => typeof f === 'object' ? (f.factor || f.name) : f).filter(Boolean);
      const timingFactors = ['betDuringEvent', 'betLast2Hours', 'betSameDay', 'betDayBefore', 'betEarlyDays', 'betVeryEarly'];
      
      for (const tf of timingFactors) {
        if (factorNames.includes(tf) && candidates[tf]) {
          const stats = candidates[tf];
          const total = (stats.wins || 0) + (stats.losses || 0);
          if (total >= 5) {
            components.push({
              source: 'event_timing',
              confidence: stats.winRate,
              weight: 1.5  // Event timing is highly predictive
            });
            break; // Only one timing factor per signal
          }
        }
      }
    }
    
    // Calculate weighted average confidence
    if (components.length === 0) {
      return null;  // Not enough data
    }
    
    let totalWeight = 0;
    let weightedConfidence = 0;
    
    for (const comp of components) {
      totalWeight += comp.weight;
      weightedConfidence += comp.confidence * comp.weight;
    }
    
    const finalConfidence = Math.round(weightedConfidence / totalWeight);
    
    return {
      confidence: Math.max(0, Math.min(100, finalConfidence)),
      components,
      dataPoints: components.length
    };
  } catch (e) {
    console.error("Error calculating confidence:", e.message);
    return null;
  }
}

export async function getFactorStats(env) {
  if (!env.SIGNALS_CACHE) return {};
  
  try {
    return await env.SIGNALS_CACHE.get(LEARNING_KEYS.FACTOR_STATS, { type: "json" }) || {};
  } catch (e) {
    console.error("Error getting factor stats:", e.message);
    return {};
  }
}

export async function hasStrongCombo(env, factors) {
  if (!env.SIGNALS_CACHE || !factors || factors.length < 2) return null;
  
  try {
    const combos = await env.SIGNALS_CACHE.get(COMBO_KEY, { type: 'json' }) || {};
    const factorNames = factors.map(f => typeof f === 'object' ? (f.factor || f.name) : f).filter(Boolean);
    
    let bestCombo = null;
    let bestWinRate = 0;
    
    // Check all 2-factor combinations in this signal
    for (let i = 0; i < factorNames.length; i++) {
      for (let j = i + 1; j < factorNames.length; j++) {
        const combo = [factorNames[i], factorNames[j]].sort().join(' + ');
        const stats = combos[combo];
        
        if (stats && (stats.wins + stats.losses) >= 5 && stats.winRate > bestWinRate) {
          bestWinRate = stats.winRate;
          bestCombo = {
            combo,
            winRate: stats.winRate,
            record: `${stats.wins}W-${stats.losses}L`
          };
        }
      }
    }
    
    return bestCombo;
  } catch (e) {
    return null;
  }
}

export async function getAIRecommendation(env) {
  if (!env.SIGNALS_CACHE) return null;
  
  try {
    const factorStats = await env.SIGNALS_CACHE.get(LEARNING_KEYS.FACTOR_STATS, { type: "json" }) || {};
    const discoveredPatterns = await getDiscoveredPatterns(env);
    const factors = Object.entries(factorStats);
    
    if (factors.length < 3) {
      return {
        hasRecommendation: false,
        message: "Need more data to generate recommendations",
        patternsTracking: discoveredPatterns.allTracking
      };
    }
    
    // Separate core factors from discovered
    const coreFactors = factors.filter(([name, stats]) => !stats.isDiscovered);
    const discoveredFactors = factors.filter(([name, stats]) => stats.isDiscovered);
    
    // Find best and worst performing factors (with sufficient data)
    const sorted = factors
      .filter(([name, stats]) => (stats.wins + stats.losses) >= 3)
      .sort((a, b) => b[1].winRate - a[1].winRate);
    
    if (sorted.length < 2) {
      return {
        hasRecommendation: false,
        message: "Need more settled bets to generate recommendations",
        patternsTracking: discoveredPatterns.allTracking
      };
    }
    
    const bestFactors = sorted.slice(0, 3).map(([name, stats]) => ({
      name,
      winRate: stats.winRate,
      record: `${stats.wins}W-${stats.losses}L`,
      isDiscovered: stats.isDiscovered || false
    }));
    
    const worstFactors = sorted.slice(-3).reverse().map(([name, stats]) => ({
      name,
      winRate: stats.winRate,
      record: `${stats.wins}W-${stats.losses}L`,
      isDiscovered: stats.isDiscovered || false
    }));
    
    // Calculate overall confidence
    const avgWinRate = sorted.reduce((sum, [_, s]) => sum + s.winRate, 0) / sorted.length;
    
    // Generate dynamic recommendation
    let recommendation;
    if (avgWinRate >= 60) {
      recommendation = "🔥 System is running hot! High confidence in signals with top factors.";
    } else if (avgWinRate >= 55) {
      recommendation = "📈 System performing above average. Follow signals with strong factor combinations.";
    } else if (avgWinRate >= 45) {
      recommendation = "📊 System at baseline. Be selective - prioritize signals with proven factors.";
    } else if (avgWinRate >= 35) {
      recommendation = "⚠️ System underperforming. Consider waiting or fading weak signals.";
    } else {
      recommendation = "🚨 System in drawdown. Recommend pausing until patterns stabilize.";
    }
    
    return {
      hasRecommendation: true,
      overallConfidence: Math.round(avgWinRate),
      bestFactors,
      worstFactors,
      recommendation,
      totalFactorsTracked: factors.length,
      factorsWithData: sorted.length,
      discoveredCount: discoveredFactors.length,
      coreFactorsCount: coreFactors.length,
      patternsNearPromotion: discoveredPatterns.nearPromotion.slice(0, 3),
      patternsTracking: discoveredPatterns.allTracking
    };
  } catch (e) {
    console.error("Error getting AI recommendation:", e.message);
    return null;
  }
}

export async function getFactorCombos(env) {
  if (!env.SIGNALS_CACHE) return { combos: [], bestCombos: [], worstCombos: [] };
  
  try {
    const combos = await env.SIGNALS_CACHE.get(COMBO_KEY, { type: 'json' }) || {};
    
    // Convert to array and filter for sufficient data
    const comboArray = Object.entries(combos)
      .map(([name, stats]) => ({ name, ...stats }))
      .filter(c => (c.wins + c.losses) >= 3)  // At least 3 samples
      .sort((a, b) => b.winRate - a.winRate);
    
    return {
      combos: comboArray,
      bestCombos: comboArray.filter(c => c.winRate >= 60).slice(0, 10),
      worstCombos: comboArray.filter(c => c.winRate <= 40).slice(-10).reverse(),
      totalTracked: Object.keys(combos).length
    };
  } catch (e) {
    console.error("Error getting factor combos:", e.message);
    return { combos: [], bestCombos: [], worstCombos: [] };
  }
}

export async function getDiscoveredPatterns(env) {
  if (!env.SIGNALS_CACHE) return { patterns: [], candidates: {} };
  
  try {
    const discovered = await env.SIGNALS_CACHE.get(LEARNING_KEYS.DISCOVERED_PATTERNS, { type: "json" }) || [];
    const candidates = await env.SIGNALS_CACHE.get(LEARNING_KEYS.PATTERN_CANDIDATES, { type: "json" }) || {};
    const timePatterns = await env.SIGNALS_CACHE.get(LEARNING_KEYS.TIME_PATTERNS, { type: "json" }) || {};
    const volumeBrackets = await env.SIGNALS_CACHE.get(LEARNING_KEYS.VOLUME_BRACKETS, { type: "json" }) || {};
    const marketTypes = await env.SIGNALS_CACHE.get(LEARNING_KEYS.MARKET_TYPE_STATS, { type: "json" }) || {};
    
    // Find patterns close to promotion threshold
    const allCandidates = { ...candidates, ...timePatterns, ...volumeBrackets, ...marketTypes };
    const nearPromotion = [];
    
    for (const [name, stats] of Object.entries(allCandidates)) {
      const total = (stats.wins || 0) + (stats.losses || 0);
      if (total >= 5 && total < 10) {
        nearPromotion.push({
          name,
          ...stats,
          samplesNeeded: 10 - total
        });
      }
    }
    
    return {
      promotedPatterns: discovered,
      nearPromotion: nearPromotion.sort((a, b) => b.winRate - a.winRate),
      allTracking: {
        candidates: Object.keys(candidates).length,
        timePatterns: Object.keys(timePatterns).length,
        volumeBrackets: Object.keys(volumeBrackets).length,
        marketTypes: Object.keys(marketTypes).length
      }
    };
  } catch (e) {
    console.error("Error getting discovered patterns:", e.message);
    return { patterns: [], candidates: {} };
  }
}

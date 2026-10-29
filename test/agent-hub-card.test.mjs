import test from 'node:test';
import assert from 'node:assert/strict';
import { positionCard } from '../src/agent-hub.js';

test('positionCard: every field the globe shows, optional ones null when absent', () => {
  const full = positionCard({
    id: 'at_1', marketTitle: 'Lakers vs. Celtics', directionRaw: 'Lakers', direction: 'Yes', entryPrice: 42, size: 5, shares: 11.9, openedAt: '2026-10-28T01:00:00Z',
    strategySource: null, isExploration: false, isHighConviction: true, council: { verdict: 'TRIM', m: 0.12, v: [['GREED', 'YES', 0.6], ['DOUBT', 'NO', 0.5]] },
    marketSlug: 'nba-lal-bos', marketCategory: 'sports_binary', marketType: 'sports', signalSubType: 'moneyline', score: 84, aiConfidence: 63, hoursUntilEvent: 3.5,
    walletTier: 'ELITE', walletWinRate: 72, walletBets: 41, whaleAction: 'BUY', peakPctGain: 8.1, trailingStopLevel: 44, forgeRule: null, holdToResolution: false,
  });
  assert.equal(full.lane, 'whale'); assert.equal(full.side, 'Lakers'); assert.equal(full.council, 'TRIM'); assert.equal(full.councilMargin, 0.12);
  assert.deepEqual(full.councilVotes, [{ agent: 'GREED', vote: 'YES', conviction: 0.6 }, { agent: 'DOUBT', vote: 'NO', conviction: 0.5 }]);
  assert.equal(full.confidence, 63); assert.equal(full.walletTier, 'ELITE'); assert.equal(full.highConviction, true); assert.equal(full.slug, 'nba-lal-bos');
  const bare = positionCard({ id: 'at_2', marketTitle: 'X', direction: 'Yes', entryPrice: 30, size: 5, openedAt: 't', isExploration: true, strategySource: 'forge' });
  assert.equal(bare.lane, 'forge'); assert.equal(bare.council, null); assert.equal(bare.councilVotes, null); assert.equal(bare.score, null);
  assert.equal(bare.category, 'other'); assert.equal(bare.exploration, true); assert.equal(bare.walletTier, null);
});

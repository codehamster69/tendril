import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MARKET_EPOCH } from '@tendril/sim/src/index.ts';
import { bestItem, buildCard, formatCountdown, gaugePos, multiplierTable, permilleToMult, popupText, secondsToUtcMidnight } from './farm-market-format.ts';

const market = { prices: [0, 300, 250, 100, 800, 500, 400, 1600], multipliers: [0, 1500, 1000, 500, 2000, 1000, 800, 1000], shares: [0, 194, 129, 388, 65, 97, 78, 49] };

describe('gauge', () => {
  it('maps 50..200 percent on a log scale with 100 in the middle', () => {
    assert.equal(gaugePos(0.5), 0);
    assert.equal(gaugePos(2), 100);
    assert.ok(Math.abs(gaugePos(1) - 50) < 1e-9);
    assert.equal(gaugePos(9), 100);
  });
  it('clamps permille to 0.5..2 and treats missing as base', () => {
    assert.equal(permilleToMult(250), 0.5);
    assert.equal(permilleToMult(5000), 2);
    assert.equal(permilleToMult(undefined), 1);
    assert.deepEqual(multiplierTable(null), null);
    assert.deepEqual(multiplierTable(market)!.slice(0, 4), [1, 1.5, 1, 0.5]);
  });
});

describe('card', () => {
  it('shows base prices without a market', () => {
    const c = buildCard(null);
    assert.equal(c.kind, 'base'); assert.equal(c.title, 'Base prices'); assert.equal(c.rows.length, 0);
  });
  it('shows the sim wording before the market opens', () => {
    assert.equal(buildCard(market, 3).note, 'Market opens in 3 days');
    assert.equal(buildCard(null, 1).note, 'Market opens tomorrow');
    assert.equal(buildCard(market, 3).kind, 'soon');
  });
  it('builds rows from the sim view with price, change, share and trend', () => {
    const c = buildCard(market);
    assert.equal(c.kind, 'open'); assert.equal(c.rows.length, 7);
    const carrot = c.rows[0]!;
    assert.deepEqual([carrot.name, carrot.price, carrot.change, carrot.trend, carrot.share, carrot.mult], ['carrot', '3.00', '+50%', 'up', '19%', '×1.50']);
    assert.equal(c.rows[2]!.trend, 'down');
    assert.equal(c.best!.name, 'pumpkin');
  });
  it('drops shares when the sim has none', () => {
    assert.equal(buildCard({ ...market, shares: null }).rows[0]!.share, null);
    assert.ok(MARKET_EPOCH);
  });
});

describe('helpers', () => {
  it('picks the best item, lowest id on a tie', () => {
    assert.equal(bestItem([1, 1.5, 1.5, 0.5]), 1);
    assert.equal(bestItem([1]), 0);
  });
  it('counts down to the next UTC midnight', () => {
    assert.equal(secondsToUtcMidnight(Date.UTC(2026, 11, 8, 23, 59, 0)), 60);
    assert.equal(secondsToUtcMidnight(Date.UTC(2026, 11, 8, 0, 0, 0)), 86400);
    assert.equal(formatCountdown(3725), '01:02:05');
  });
  it('formats popups', () => {
    assert.equal(popupText(12, 1.25), '+12¢ ×1.25');
    assert.equal(popupText(12.5, 0.5), '+12.50¢ ×0.50');
  });
});

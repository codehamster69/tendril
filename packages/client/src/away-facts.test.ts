import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OP } from '@tendril/sim/src/index.ts';
import { AwayFacts, awayLines, duration, longestIdle, soldText } from './away-facts.ts';

describe('away facts', () => {
  it('counts sold units and the last action of each bot', () => {
    const f = new AwayFacts();
    f.record([[10, 0, OP.sell, 1, 5], [20, 1, OP.sell, 1, 7], [30, 0, OP.wait, 3]]);
    assert.equal(f.sold.get(1), 12);
    assert.equal(f.lastAct.get(0), 30);
    assert.equal(f.lastAct.get(1), 20);
  });
  it('formats durations and sales', () => {
    assert.equal(duration(3 * 36_000 + 12 * 600), '3 h 12 m');
    assert.equal(duration(45 * 600), '45 m');
    assert.equal(soldText(new Map([[1, 212]])), '212 carrots sold');
    assert.equal(soldText(new Map([[1, 212], [2, 40]])), '212 carrots sold, and 40 more items');
    assert.equal(soldText(new Map()), '');
  });
  it('finds the idlest bot, only past five minutes', () => {
    const f = new AwayFacts();
    f.record([[9_000, 0, OP.wait, 1], [1_000, 1, OP.wait, 1]]);
    assert.deepEqual(longestIdle(f, 3, 10_000, 0), { bot: 2, ticks: 10_000 });
    assert.equal(longestIdle(f, 1, 10_000, 0), null);
  });
  it('writes the card lines', () => {
    const l = awayLines({ awayTicks: 3 * 36_000 + 7_200, coinsGained: 1840, sold: new Map([[1, 212]]), restedTicks: 72_000, error: { bot: 2, line: 14, tick: 8412, message: 'not enough coins' }, idle: null });
    assert.equal(l.title, 'While you were away (3 h 12 m)');
    assert.equal(l.summary, '+1,840 coins, 212 carrots sold.');
    assert.equal(l.problem, 'Bot 2 stopped at line 14 at tick 8,412: not enough coins');
    assert.equal(l.line, 14);
    assert.equal(l.cap, 'Your farm stopped growing 2 h ago: it rests after 6 h away.');
  });
});

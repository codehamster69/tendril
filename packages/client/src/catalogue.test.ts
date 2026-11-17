import test from 'node:test';
import assert from 'node:assert/strict';
import { UNLOCKS } from '@tendril/sim/src/index.ts';
import { CARDS, matches, newlyOwned, stateOf, unseenAffordable, visible, withBuyLine } from './catalogue.ts';

const by = (n: string) => CARDS.find((c) => c.name === n)!;
test('one card per unlock, same bit, name and price as the sim', () => {
  assert.equal(CARDS.length, UNLOCKS.length);
  CARDS.forEach((c, i) => { assert.equal(c.bit, i); assert.equal(c.name, UNLOCKS[i]!.name); assert.equal(c.price, UNLOCKS[i]!.price); });
});
test('state: owned beats affordable beats locked, price boundary is inclusive', () => {
  assert.equal(stateOf(by('carrot'), 1, 0), 'owned');
  assert.equal(stateOf(by('wheat'), 1, 39), 'locked');
  assert.equal(stateOf(by('wheat'), 1, 40), 'affordable');
  assert.equal(stateOf(by('wheat'), 3, 0), 'owned');
});
test('search matches names and functions', () => {
  assert.ok(matches(by('hive'), 'HIV'));
  assert.ok(matches(by('composter'), 'fertilize'));
  assert.ok(matches(by('satchel'), 'capacity'));
  assert.ok(!matches(by('wheat'), 'build'));
  assert.deepEqual(visible(CARDS, { query: 'build', affordableOnly: false }, 1, 0).map((c) => c.name), ['hive', 'composter']);
});
test('affordable filter', () => {
  assert.deepEqual(visible(CARDS, { query: '', affordableOnly: true }, 1, 100).map((c) => c.name), ['wheat', 'clover']);
});
test('badge: unseen affordable only', () => {
  assert.deepEqual(unseenAffordable(1, 100, new Set()).map((c) => c.name), ['wheat', 'clover']);
  assert.deepEqual(unseenAffordable(1, 100, new Set(['wheat'])).map((c) => c.name), ['clover']);
  assert.deepEqual(unseenAffordable(1, 0, new Set()), []);
});
test('newlyOwned reports only fresh bits', () => {
  assert.deepEqual(newlyOwned(1, 3).map((c) => c.name), ['wheat']);
  assert.deepEqual(newlyOwned(3, 3), []);
});
test('buy line is added once', () => {
  assert.equal(withBuyLine('', by('wheat')), 'unlock wheat\n');
  assert.equal(withBuyLine('say 1', by('wheat')), 'say 1\nunlock wheat\n');
  assert.equal(withBuyLine('say 1\nunlock wheat\n', by('wheat')), null);
});

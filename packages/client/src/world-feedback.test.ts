import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_PALETTE, botColour, botColourHex } from './bot-colours.ts';
import { bubbleFor, floatCurve, itemGains, pickBubbles, planFloats, type FeedbackEvent, type FloatContext } from './feedback-core.ts';
import { popCurve } from './farm-fx.ts';

const ctx: FloatContext = {
  gained: (bot) => (bot >= 0 ? [{ item: 2, n: 3 }] : []),
  itemName: (i) => ['', 'carrot', 'wheat'][i] ?? 'item',
  saleValue: (item, units) => item * units,
  orderReward: (id) => (id === 9 ? 40 : null),
};
const harvest = (bot: number): FeedbackEvent => [1, 10, bot, 0, 0];
const sale = (bot: number, item: number, units: number): FeedbackEvent => [2, 10, bot, item, units];

describe('bot colours', () => {
  it('are eight distinct, stable colours that repeat', () => {
    assert.equal(new Set(BOT_PALETTE).size, 8);
    assert.equal(botColour(0), BOT_PALETTE[0]);
    assert.equal(botColour(8), botColour(0));
    assert.equal(botColour(-1), BOT_PALETTE[7]);
    assert.equal(botColour(Number.NaN), BOT_PALETTE[0]);
    assert.equal(botColourHex(1), parseInt(BOT_PALETTE[1].slice(1), 16));
  });
});

describe('floating numbers', () => {
  it('names a harvest by what the bot gained', () => {
    assert.deepEqual(planFloats([harvest(0)], ctx).map((f) => f.text), ['+3 wheat']);
  });
  it('falls back when nothing was gained', () => {
    assert.equal(planFloats([harvest(-1)], ctx)[0]!.text, '+harvest');
  });
  it('shows sales and orders as coins and ignores unknown orders', () => {
    assert.deepEqual(planFloats([sale(0, 2, 6), [3, 10, 0, 9, 0], [3, 10, 0, 1, 0]], ctx).map((f) => f.text), ['+12 coins', '+40 coins']);
  });
  it('keeps one number per event up to four, then merges per item', () => {
    assert.equal(planFloats([0, 1, 2, 3].map(harvest), ctx).length, 4);
    const five = planFloats([0, 1, 2, 3, 4].map(harvest), ctx);
    assert.deepEqual(five.map((f) => f.text), ['+15 wheat']);
  });
  it('merges per kind above sixteen', () => {
    const many = Array.from({ length: 17 }, (_, i) => sale(i, 1 + (i % 2), 1));
    const out = planFloats(many, ctx);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.text, `+${many.reduce((n, e) => n + e[3] * e[4], 0)} coins`);
  });
  it('reads a bot gain once per step', () => {
    assert.equal(planFloats([harvest(0), harvest(0)], ctx).length, 1);
  });
  it('computes item gains and animation curves', () => {
    assert.deepEqual(itemGains([0, 1, 0], [0, 1, 4]), [{ item: 2, n: 4 }]);
    assert.deepEqual(itemGains(undefined, [5, 2]), [{ item: 1, n: 2 }]);
    assert.equal(floatCurve(1, true).rise, 0);
    assert.ok(floatCurve(0.5, false).rise > 20);
    assert.equal(floatCurve(1, false).opacity, 0);
    assert.ok(popCurve(0).scale < popCurve(1).scale && popCurve(1).fade === 0);
  });
});

describe('bubbles', () => {
  it('picks the right kind', () => {
    assert.equal(bubbleFor({ status: 'error', line: 3, op: 7 }), 'error');
    assert.equal(bubbleFor({ status: 'paused', line: 3, op: null }), 'blocked');
    assert.equal(bubbleFor({ status: 'busy', line: 3, op: 7 }), 'waiting');
    assert.equal(bubbleFor({ status: 'busy', line: 3, op: 4 }), null);
  });
  it('shows the most urgent first and caps the count', () => {
    const picked = pickBubbles([{ bot: 0, kind: 'waiting' }, { bot: 1, kind: 'error' }, { bot: 2, kind: 'blocked' }], 2);
    assert.deepEqual(picked.map((p) => p.bot), [1, 2]);
  });
});

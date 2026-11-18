import test from 'node:test';
import assert from 'node:assert/strict';
import { finalView, goalLine, parText, quotaRows, scoreText } from './goal-view.ts';
import type { Goal } from '@tendril/sim/src/index.ts';

const festival: Goal = { kind: 'festival', budget: 3000, quotas: [0, 0, 480, 120, 0, 0, 0, 0] };

test('scores read in their own unit', () => {
  assert.equal(scoreText('wealth', 1240), '1,240 coins net worth');
  assert.equal(scoreText('orders', 90), '90 coins from orders');
  assert.equal(scoreText('inherited', 75), '75 coins gained over the start');
  assert.equal(scoreText('festival', 625), '62.5% of the quotas filled');
  assert.equal(scoreText('festival', 1000), '100.0% of the quotas filled');
});

test('par and goal lines', () => {
  assert.equal(parText(festival, null), null);
  assert.equal(parText(festival, 800), '80.0% of the quotas filled');
  assert.match(goalLine(festival), /quotas/);
  assert.match(goalLine({ kind: 'specialist', budget: 3000, favoured: 4, shunned: 1 }), /pumpkin.*carrot/);
  assert.match(goalLine({ kind: 'wealth', budget: 6000 }), /6,000 ticks/);
});

test('quota rows list only items with a quota and cap the bar', () => {
  const rows = quotaRows(festival, [0, 0, 600, 30, 0, 0, 0, 0]);
  assert.deepEqual(rows.map((r) => [r.name, r.have, r.quota, r.done, r.fraction]), [['wheat', 600, 480, true, 1], ['clover', 30, 120, false, 0.25]]);
  assert.equal(quotaRows(festival, undefined)[0]!.have, 0);
});

test('hidden farms: provisional while open, a breakdown once final, nothing without hidden farms', () => {
  const base = { kind: 'orders' as const, hiddenFarms: 2, closesAt: 2000, now: 1000, visible: 300, entry: null };
  assert.equal(finalView({ ...base, hiddenFarms: 0 }).state, 'none');
  const open = finalView(base);
  assert.equal(open.state, 'provisional');
  assert.match(open.lines.join(' '), /2 hidden farms/);
  assert.match(finalView({ ...base, now: 3000 }).lines.join(' '), /has closed/);
  const waiting = finalView({ ...base, now: 3000, entry: { score: 300, finalScore: null, provisional: true } });
  assert.equal(waiting.state, 'provisional');
  const done = finalView({ ...base, now: 3000, entry: { score: 300, finalScore: 900, finalParTick: 4100, provisional: false } });
  assert.equal(done.state, 'final');
  assert.deepEqual(done.lines.slice(0, 2), ['Final score 900 coins from orders', 'Visible farm 300 coins from orders · 2 hidden farms 600 coins from orders']);
  assert.match(done.lines[2]!, /4,100/);
  assert.equal(finalView({ ...base, hiddenFarms: 1 }).lines[1]!.includes('one hidden farm'), true);
});

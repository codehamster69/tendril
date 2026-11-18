import test from 'node:test';
import assert from 'node:assert/strict';
import { challengeSetup, createWorld, netWorth, SETUP_BRIEF } from '@tendril/sim/src/index.ts';
import { goalProgress } from './goal-progress.ts';

const find = (kind: string): number => {
  for (let seed = 1; seed < 400; seed++) if (challengeSetup('daily', seed, SETUP_BRIEF).brief?.goal.kind === kind) return seed;
  throw new Error(`no ${kind} seed`);
};
const make = (kind: string) => { const seed = find(kind); return createWorld({ id: 'd-test', seed }, challengeSetup('daily', seed, SETUP_BRIEF).setup); };

test('no goal, no progress (classic and Endless worlds)', () => {
  assert.equal(goalProgress(createWorld({ id: 'x', seed: 1 }), 0), null);
});

test('wealth and specialist read net worth; inherited reads the gain over the start', () => {
  const w = make('wealth');
  assert.deepEqual(goalProgress(w, 0), { score: netWorth(w) });
  const inh = make('inherited');
  const start = netWorth(inh);
  assert.equal(goalProgress(inh, start)!.score, 0);
  inh.coins += 50;
  assert.equal(goalProgress(inh, start)!.score, 50);
});

test('festival reads deposited units, orders reads delivered coins', () => {
  const f = make('festival');
  const g = goalProgress(f, 0)!;
  assert.equal(g.score, 0);
  assert.equal(g.deposited!.length, 8);
  f.brief!.deposited![2] = 5;
  assert.deepEqual(goalProgress(f, 0)!.deposited!.slice(0, 3), [0, 0, 5]);
  const o = make('orders');
  assert.equal(goalProgress(o, 0)!.score, 0);
  o.brief!.orderCoins = 42;
  assert.equal(goalProgress(o, 0)!.score, 42);
});

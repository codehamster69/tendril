import test from 'node:test';
import assert from 'node:assert/strict';
import { belowPar, bestLine, hintFor, medals } from './result-model.ts';

const server = { tokens: 120, total: 50, ranks: { wealth: 4, speed: 9, brevity: 7 } };
const base = { par: 400, netWorth: 512, parTick: 1140, ticks: 3000, signedIn: true, server, program: 'verified' as const, submitting: false };

test('a good run earns all three medals with ranks', () => {
  const m = medals(base);
  assert.deepEqual(m.map((x) => x.state), ['earned', 'earned', 'earned']);
  assert.equal(m[0]!.line, '112 coins over par');
  assert.equal(m[0]!.rank, '4th of 50');
  assert.equal(m[1]!.line, 'Par at tick 1,140 · 1,860 ticks to spare');
  assert.equal(m[2]!.line, '120 tokens');
});

test('a run below par misses wealth and speed and says by how much', () => {
  const m = medals({ ...base, netWorth: 300, parTick: null, server: null, program: null });
  assert.deepEqual(m.map((x) => x.state), ['missed', 'missed', 'missed']);
  assert.equal(m[0]!.line, '100 coins short of par');
  assert.equal(m[1]!.line, 'Par not reached');
  assert.equal(m[2]!.line, 'Needs par first');
});

test('brevity waits for the server and is locked when signed out', () => {
  assert.equal(medals({ ...base, server: null, program: null, submitting: true })[2]!.state, 'pending');
  assert.equal(medals({ ...base, signedIn: false, server: null, program: null })[2]!.state, 'locked');
  assert.equal(medals({ ...base, program: 'mismatch' })[2]!.line, 'Program did not match the run');
});

test('belowPar only applies when the day has a par', () => {
  assert.equal(belowPar({ par: 400 }, null), true);
  assert.equal(belowPar({ par: 400 }, 900), false);
  assert.equal(belowPar({ par: null }, null), false);
});

test('hint names a crashed bot first, then the last sale', () => {
  const trail = { lastSale: 1240, lastGrow: 1300, error: null };
  assert.match(hintFor({ ...trail, error: { bot: 2, line: 7, message: 'bad move' } }, 3000, 300, 400), /Bot 2 stopped on line 7: bad move/);
  const h = hintFor(trail, 3000, 300, 400);
  assert.match(h, /tick 1,240, 1,760 ticks before sunset/);
  assert.match(h, /100 coins short of par/);
  assert.match(hintFor({ lastSale: null, lastGrow: null, error: null }, 3000, 0, 400), /never grew/);
});

test('best line compares with the last best and the score to beat', () => {
  assert.equal(bestLine(null, 500, null), 'First run on this seed');
  assert.match(bestLine(400, 500, 600), /New personal best, 100 above your last best \(400\) · 100 below the score to beat/);
  assert.match(bestLine(500, 500, 400), /Matches your best \(500\) · at or above/);
  assert.match(bestLine(600, 500, null), /^100 below your best \(600\)$/);
});

test('brief goals name the first medal and use their own unit', () => {
  const m = medals({ ...base, kind: 'festival', par: 800, netWorth: 700, parTick: null, server: null, program: null });
  assert.equal(m[0]!.name, 'Festival');
  assert.equal(m[0]!.line, '10.0% short of par');
  assert.equal(medals({ ...base, kind: 'orders', par: 300, netWorth: 450 })[0]!.line, '150 coins over par');
  assert.equal(bestLine(500, 700, 900, 'festival'), 'New personal best, 20.0% above your last best (50.0%) · 20.0% below the score to beat');
  assert.match(hintFor({ lastSale: null, lastGrow: 400, error: null }, 3000, 700, 800, 'festival'), /Your score stopped growing at tick 400.*10\.0% short of par/);
});

test('a practice farm is never rated', () => {
  const m = medals({ ...base, practice: true, signedIn: true });
  assert.equal(m[2]!.state, 'locked');
  assert.equal(m[2]!.line, 'Practice farms are not rated');
});

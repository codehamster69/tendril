import assert from 'node:assert/strict';
import { test } from 'node:test';
import { targetTick } from './clock.ts';

const meta = { seed: 1, startedAtMs: 1_000_000, mode: 'live' as const };

test('target tick follows the wall clock', () => {
  assert.equal(targetTick(meta, 1_000_000 + 5_000), 50);
});

test('rested time pauses the clock and never goes below zero', () => {
  assert.equal(targetTick({ ...meta, restedMs: 2_000 }, 1_000_000 + 5_000), 30);
  assert.equal(targetTick({ ...meta, restedMs: 9_000_000 }, 1_000_000 + 5_000), 0);
});

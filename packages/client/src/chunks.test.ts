import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimLocalLog, type LogChunk } from './chunks.ts';

const chunk = (from: number, n: number): LogChunk => ({ fromTick: from, toTick: from + 1, actions: Array.from({ length: n }, () => [from, 0, 1] as LogChunk['actions'][number]) });

test('a short log is returned untouched', () => {
  const log = [chunk(0, 5), chunk(1, 5)];
  assert.equal(trimLocalLog(log, 100), log);
});

test('the oldest chunks go first and the retained ones stay contiguous', () => {
  const log = [chunk(0, 40), chunk(1, 40), chunk(2, 40), chunk(3, 40)];
  const out = trimLocalLog(log, 100);
  assert.deepEqual(out.map((c) => c.fromTick), [2, 3]);
});

test('the newest chunk stays even when it alone exceeds the limit', () => {
  const out = trimLocalLog([chunk(0, 10), chunk(1, 500)], 100);
  assert.deepEqual(out.map((c) => c.fromTick), [1]);
});

test('an empty log stays empty', () => assert.deepEqual(trimLocalLog([], 10), []));

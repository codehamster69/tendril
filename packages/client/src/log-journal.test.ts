import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journalDelta, validateJournal } from './log-journal.ts';
import type { LogChunk } from './chunks.ts';
const chunk = (fromTick: number, toTick: number): LogChunk => ({ fromTick, toTick, actions: [] });
test('append does not copy any of 205 retained chunks', () => {
  const old = Array.from({ length: 205 }, (_, i) => chunk(i, i + 1));
  const next = chunk(205, 206);
  const delta = journalDelta('farm.', old, [...old, next]);
  assert.deepEqual(Object.keys(delta.entries), ['farm.log.206']);
  assert.equal(delta.entries['farm.log.206'], next);
  assert.deepEqual(delta.remove, []);
});
test('acknowledgement writes only the split head and removes fully accepted chunks', () => {
  const old = [chunk(0, 20), chunk(20, 40), chunk(40, 60)];
  const suffix = { ...old[1]!, fromTick: 30 };
  const delta = journalDelta('farm.', old, [suffix, old[2]!]);
  assert.deepEqual(Object.keys(delta.entries), ['farm.log.40']);
  assert.deepEqual(delta.remove, ['farm.log.20']);
  assert.deepEqual(journalDelta('farm.', old, []).remove, ['farm.log.20', 'farm.log.40', 'farm.log.60']);
});
test('invalid metadata and nonadvancing chunks fail before writing', () => {
  for (const value of [null, { version: 1, revision: 0, ends: [] }, { version: 1, revision: 1, ends: [2, 1] }]) assert.throws(() => validateJournal(value));
  assert.throws(() => journalDelta('', [], [chunk(0, 1), chunk(0, 1)]));
});

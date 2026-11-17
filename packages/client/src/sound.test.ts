import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EVENT_SOUNDS_PER_SECOND, RECIPES, SoundBudget, parseSettings, pickEventSounds, type SoundName } from './sound.ts';

test('parseSettings falls back to defaults on bad storage and clamps volume', () => {
  assert.deepEqual(parseSettings(null), { volume: 0.6, ambient: true, muted: false });
  assert.deepEqual(parseSettings('not json'), { volume: 0.6, ambient: true, muted: false });
  assert.deepEqual(parseSettings('null'), { volume: 0.6, ambient: true, muted: false });
  assert.deepEqual(parseSettings('{"volume":3,"ambient":false,"muted":true}'), { volume: 1, ambient: false, muted: true });
  assert.deepEqual(parseSettings('{"volume":-1,"ambient":"yes"}'), { volume: 0, ambient: true, muted: false });
});

test('every sound has a short, quiet recipe', () => {
  const names = Object.keys(RECIPES) as SoundName[];
  assert.equal(names.length, 9);
  for (const name of names) {
    const voices = RECIPES[name];
    assert.ok(voices.length > 0, name);
    for (const v of voices) {
      assert.ok(v.peak > 0 && v.peak <= 0.2, `${name} peak ${v.peak}`);
      assert.ok(v.at + v.dur <= 1.2, `${name} lasts too long`);
    }
  }
});

test('a batch of many harvests merges into one harvest sound', () => {
  const batch = Array.from({ length: 40 }, (_, i) => [1, i, 0, 0, 0] as [number, number, number, number, number]);
  assert.deepEqual(pickEventSounds(batch, new SoundBudget(), 0), ['harvest']);
});

test('one sound per kind, most important first', () => {
  const batch: [number, number, number, number, number][] = [[1, 0, 0, 0, 0], [4, 0, 0, 0, 0], [2, 0, 0, 0, 0], [3, 0, 0, 0, 0]];
  assert.deepEqual(pickEventSounds(batch, new SoundBudget(), 0), ['error', 'order', 'sale', 'harvest']);
});

test('the budget caps event sounds per second and recovers after a second', () => {
  const budget = new SoundBudget();
  let taken = 0;
  for (let i = 0; i < 100; i++) if (budget.take(i)) taken++;
  assert.equal(taken, MAX_EVENT_SOUNDS_PER_SECOND);
  assert.equal(budget.take(1000), true);
});

test('sixteen-times speed: 200 batches in one second stay under the cap', () => {
  const budget = new SoundBudget();
  const batch: [number, number, number, number, number][] = [[1, 0, 0, 0, 0], [2, 0, 0, 0, 0]];
  let played = 0;
  for (let ms = 0; ms < 1000; ms += 5) played += pickEventSounds(batch, budget, ms).length;
  assert.ok(played <= MAX_EVENT_SOUNDS_PER_SECOND, `played ${played}`);
});

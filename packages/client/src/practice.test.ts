import test from 'node:test';
import assert from 'node:assert/strict';
import { newPracticeSeed, practiceParam, practiceSearch } from './practice.ts';

test('practice seed from the query: whole numbers 1..2^32-1 only', () => {
  const q = (s: string) => practiceParam(new URLSearchParams(s));
  assert.equal(q('practice=12345'), 12345);
  assert.equal(q('practice=4294967295'), 4294967295);
  for (const bad of ['practice=0', 'practice=4294967296', 'practice=-3', 'practice=1.5', 'practice=abc', 'practice=', '']) assert.equal(q(bad), null, bad);
});

test('a new practice seed is valid and differs from the old one', () => {
  assert.equal(newPracticeSeed(null, () => 0), 1);
  assert.equal(newPracticeSeed(null, () => 0.9999999999), 4294967295);
  assert.equal(newPracticeSeed(1, () => 0), 2); // every draw lands on the old seed: fall back to its neighbour
  let calls = 0;
  const n = newPracticeSeed(5, () => (calls++ < 2 ? 4 / 4294967295 : 0.5));
  assert.notEqual(n, 5);
});

test('the practice link keeps the rest of the query', () => {
  assert.equal(practiceSearch('?mode=challenge&id=d-2027-01-04', 77), '?mode=challenge&id=d-2027-01-04&practice=77');
  assert.equal(practiceSearch('?mode=daily&practice=5', 77), '?mode=daily&practice=77');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedLines, isMeaningfulChange, significantLines } from './live-code.ts';

const base = 'while true:\n    plant carrot\n    water   # keep wet\n';

test('live code: comments, blank lines and spare spaces are not changes', () => {
  assert.equal(isMeaningfulChange(base, base), false);
  assert.equal(isMeaningfulChange(base, '# my farm\nwhile true:\n\n    plant   carrot  \n    water\n'), false);
  assert.equal(isMeaningfulChange(base, base.replace('keep wet', 'keep it very wet')), false);
});

test('live code: indentation, words and strings are changes', () => {
  assert.equal(isMeaningfulChange(base, base.replace('carrot', 'wheat')), true);
  assert.equal(isMeaningfulChange(base, base.replace('    water', '        water')), true);
  assert.equal(isMeaningfulChange('say "a  b"\n', 'say "a b"\n'), true);
  assert.equal(isMeaningfulChange('say "a # b"\n', 'say "a # b"  # note\n'), false);
});

test('live code: only changed lines are reported, lines that moved down are not', () => {
  assert.deepEqual(changedLines(base, base.replace('carrot', 'wheat')), [2]);
  assert.deepEqual(changedLines(base, 'harvest\n' + base), [1]);
  assert.deepEqual(changedLines(base, base), []);
  assert.deepEqual(changedLines(base, base.replace('water', 'water\n    harvest')), [4]);
});

test('live code: significantLines drops comments and blanks', () => {
  assert.deepEqual(significantLines('# a\n\nx = 1  # b\n'), ['x = 1']);
});

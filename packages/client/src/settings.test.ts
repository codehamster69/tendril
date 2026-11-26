import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, FONT_MAX, FONT_MIN, normalizeSettings } from './settings.ts';

test('settings: empty or broken input gives the defaults', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULTS);
  assert.deepEqual(normalizeSettings('x'), DEFAULTS);
  assert.deepEqual(normalizeSettings({ quality: 'ultra', motion: 3, volume: NaN, fontSize: 'big' }), DEFAULTS);
});

test('settings: valid values are kept and numbers are clamped', () => {
  const s = normalizeSettings({ muted: true, quality: 'low', motion: 'reduced', volume: 7, fontSize: 99 });
  assert.deepEqual(s, { muted: true, quality: 'low', motion: 'reduced', volume: 1, fontSize: FONT_MAX, liveCode: true });
  assert.equal(normalizeSettings({ liveCode: false }).liveCode, false);
  assert.equal(normalizeSettings({ liveCode: 'no' }).liveCode, true);
  assert.equal(normalizeSettings({ fontSize: 1 }).fontSize, FONT_MIN);
  assert.equal(normalizeSettings({ fontSize: 13.6 }).fontSize, 14);
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dayProgress, skyStep, markAt, ENDLESS_DAY_TICKS, SKY_STEP } from './day-clock.ts';

describe('dayProgress', () => {
  it('runs 0 to 1 over a run with an end and stays at 1 after it', () => {
    assert.equal(dayProgress(0, 3000).progress, 0);
    assert.equal(dayProgress(1500, 3000).progress, 0.5);
    assert.equal(dayProgress(3000, 3000).progress, 1);
    assert.equal(dayProgress(4000, 3000).progress, 1);
    assert.equal(dayProgress(1500, 3000).looping, false);
  });
  it('loops once per day in Endless and counts days from 1', () => {
    const a = dayProgress(0, null), b = dayProgress(ENDLESS_DAY_TICKS - 1, undefined), c = dayProgress(ENDLESS_DAY_TICKS, null);
    assert.equal(a.day, 1); assert.equal(b.day, 1); assert.equal(c.day, 2);
    assert.ok(b.progress > 0.99 && c.progress === 0);
    assert.equal(c.start, ENDLESS_DAY_TICKS);
    assert.ok(a.looping);
  });
  it('survives junk ticks', () => {
    assert.equal(dayProgress(-5, 100).progress, 0);
    assert.equal(dayProgress(Number.NaN, null).progress, 0);
  });
});

describe('skyStep', () => {
  it('only changes every SKY_STEP and never overshoots', () => {
    assert.equal(skyStep(0.0099), 0);
    assert.ok(Math.abs(skyStep(0.0101) - SKY_STEP) < 1e-9);
    assert.equal(skyStep(1), 1);
    const values = new Set<number>();
    for (let i = 0; i <= 3600; i++) values.add(skyStep(dayProgress(i, 3600).progress));
    assert.ok(values.size <= 102);
  });
});

describe('markAt', () => {
  it('places ticks in the window and drops the rest', () => {
    const d = dayProgress(4000, null);
    assert.equal(markAt(d.start, d), 0);
    assert.equal(markAt(d.start + 1800, d), 0.5);
    assert.equal(markAt(d.start - 1, d), null);
    assert.equal(markAt(d.start + d.length + 1, d), null);
  });
});

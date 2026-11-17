import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicScale, RenderGate, ShadowClock, parseQuality, qualityPlan, readQuality, QUALITY_KEY } from './render-budget.ts';

describe('quality', () => {
  it('reads the stored value and defaults to auto', () => {
    assert.equal(parseQuality('low'), 'low'); assert.equal(parseQuality('high'), 'high');
    assert.equal(parseQuality('ultra'), 'auto'); assert.equal(parseQuality(null), 'auto');
    assert.equal(readQuality({ getItem: (k) => (k === QUALITY_KEY ? 'high' : null) }), 'high');
    assert.equal(readQuality({ getItem: () => { throw new Error('blocked'); } }), 'auto');
    assert.equal(readQuality(null), 'auto');
  });
  it('plans the pixel ratio, shadows and antialiasing', () => {
    assert.deepEqual(qualityPlan('low', 2), { maxRatio: 1, shadows: false, antialias: false });
    assert.deepEqual(qualityPlan('high', 3), { maxRatio: 2, shadows: true, antialias: true });
    assert.deepEqual(qualityPlan('auto', 2), { maxRatio: 1.5, shadows: true, antialias: false });
    assert.deepEqual(qualityPlan('auto', 1), { maxRatio: 1, shadows: true, antialias: true });
    assert.equal(qualityPlan('auto', NaN).maxRatio, 1);
  });
});

describe('DynamicScale', () => {
  const feed = (s: DynamicScale, ms: number, seconds: number): (number | null)[] => {
    const out: (number | null)[] = [];
    for (let t = 0; t < seconds * 1000; t += ms) out.push(s.add(ms));
    return out.filter((x) => x !== null);
  };
  it('steps down by 0.25 per slow second and stops at the floor', () => {
    const s = new DynamicScale(1.5);
    assert.deepEqual(feed(s, 25, 4), [1.25, 1, 0.75]);
    assert.equal(s.atFloor, true);
  });
  it('steps up when frames are fast, never above the cap', () => {
    const s = new DynamicScale(1.5); feed(s, 25, 2);
    assert.equal(s.ratio, 1);
    assert.deepEqual(feed(s, 8, 4), [1.25, 1.5]);
  });
  it('holds in the middle band and ignores gaps', () => {
    const s = new DynamicScale(1.5);
    assert.deepEqual(feed(s, 16.7, 5), []);
    s.add(900); s.gap(); assert.equal(s.add(5), null);
  });
  it('counts slow seconds spent at the floor, and restarts from a new cap', () => {
    const s = new DynamicScale(1); feed(s, 30, 2);
    assert.equal(s.ratio, 0.75);
    feed(s, 30, 3); assert.ok(s.floorStrikes >= 2);
    s.setMax(2); s.clearStrikes(); assert.equal(s.floorStrikes, 0); assert.ok(s.ratio <= 2 && s.ratio >= 0.75);
  });
});

describe('RenderGate', () => {
  it('stops after the quiet frames and wakes on request', () => {
    const g = new RenderGate();
    assert.equal(g.next(0, false), true, 'first frame is owed');
    const rest = [1, 2, 3, 4].map((t) => g.next(t, false));
    assert.deepEqual(rest, [true, true, true, false]);
    g.stopped();
    g.request(); assert.equal(g.next(5, false), true);
  });
  it('keeps going while something changed, was held, or is in the ambient tail', () => {
    const g = new RenderGate(); g.next(0, false);
    for (let t = 1; t < 20; t++) assert.equal(g.next(t, true), true);
    const release = g.hold(); assert.equal(g.animating, 1);
    for (let t = 20; t < 30; t++) assert.equal(g.next(t, false), true);
    release(); release(); assert.equal(g.animating, 0, 'release is idempotent');
    g.touch(100);
    assert.equal(g.next(101, false), true); assert.equal(g.ambient(2099), true); assert.equal(g.ambient(2101), false);
    assert.equal(g.next(2200, false), true);
    const tail = [1, 2, 3, 4, 5].map((i) => g.next(2200 + i, false));
    assert.equal(tail.includes(false), true);
  });
});

describe('ShadowClock', () => {
  it('redraws at once on change, at most every 100 ms for moving casters, and once more when they stop', () => {
    const c = new ShadowClock(100);
    assert.equal(c.due(0, true, false), true);
    assert.equal(c.due(10, false, false), false, 'idle: nothing');
    assert.equal(c.due(20, false, true), false, 'just refreshed at 0');
    assert.equal(c.due(60, false, true), false);
    assert.equal(c.due(130, false, true), true);
    assert.equal(c.due(140, false, true), false);
    assert.equal(c.due(150, false, false), true, 'final refresh when they stop');
    assert.equal(c.due(160, false, false), false);
  });
});

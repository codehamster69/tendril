import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beamOp, droneColor, droneViewScale, easeFactor, fillRibbon, pushTrail, trimTrail, trailLength, trailFade, sparkColor, wrapAngle, DRONE_COLORS, TRAIL_POINTS } from './farm-drones.ts';
import { fireflyOpacity, pointScale, wrapAround } from './farm-fx.ts';

describe('drone helpers', () => {
  it('cycles six colours', () => {
    assert.equal(droneColor(0), DRONE_COLORS[0]);
    assert.equal(droneColor(6), droneColor(0));
    assert.equal(droneColor(-1), DRONE_COLORS[5]);
  });
  it('maps ops to sparks and beams', () => {
    assert.equal(sparkColor(0), null);
    assert.equal(sparkColor(null), null);
    assert.notEqual(sparkColor(4), null);
    assert.ok(beamOp(3) && !beamOp(0) && !beamOp(null));
  });
  it('eases without overshoot and handles dt 0', () => {
    assert.equal(easeFactor(0, 12), 0);
    const f = easeFactor(1 / 60, 12);
    assert.ok(f > 0 && f < 1);
    assert.ok(easeFactor(10, 12) > 0.999);
  });
  it('wraps angles', () => {
    assert.ok(Math.abs(wrapAngle(Math.PI * 2 + 0.1) - 0.1) < 1e-9);
    assert.ok(Math.abs(wrapAngle(-Math.PI * 3 + 0.2) - (-Math.PI + 0.2)) < 1e-9);
  });
  it('keeps drones about 12 px at far zoom and 1x up close', () => {
    assert.equal(droneViewScale(60), 1);
    const s = droneViewScale(2);
    assert.ok(Math.abs(s * 2 * 0.4 - 12) < 1e-9);
    assert.equal(droneViewScale(0), 1);
    assert.ok(droneViewScale(0.001) <= 40);
  });
  it('trail history skips tiny moves and drops the oldest at capacity', () => {
    const h = new Float32Array(8); // 4 points
    let n = pushTrail(h, 0, 0, 0);
    n = pushTrail(h, n, 0.05, 0, 0.12);
    assert.equal(n, 1);
    for (let i = 1; i <= 5; i++) n = pushTrail(h, n, i, 0);
    assert.equal(n, 4);
    assert.deepEqual([h[0], h[2], h[4], h[6]], [2, 3, 4, 5]);
  });
  it('ribbon is finite, bright at the head and flat at the ground', () => {
    const cap = TRAIL_POINTS;
    const pos = new Float32Array(cap * 6), col = new Float32Array(cap * 6);
    const h = new Float32Array(cap * 2);
    let n = 0;
    for (let i = 0; i < 10; i++) n = pushTrail(h, n, i * 0.5, 0);
    fillRibbon(pos, col, h, n, cap, 0.05, [1, 0.5, 0.2], 1, 4.5, 0);
    assert.ok(pos.every(Number.isFinite) && col.every(Number.isFinite));
    assert.ok(col[(cap - 1) * 6]! > col[0]!);
    assert.ok(Math.abs(pos[1]! - 0.07) < 1e-6);
    fillRibbon(pos, col, h, 0, cap, 0.05, [1, 1, 1], 1, 3, 3);
    assert.ok(pos.every(Number.isFinite));
  });
});

describe('fx helpers', () => {
  it('wraps fireflies around the focus on any coordinate', () => {
    assert.equal(wrapAround(30, 0, 24), -18);
    assert.equal(wrapAround(-30, 0, 24), 18);
    const v = wrapAround(5, 100000, 24);
    assert.ok(v >= 100000 - 24 && v < 100000 + 24);
  });
  it('scales point sprites and opacity sanely', () => {
    assert.equal(pointScale(1), 1);
    assert.equal(pointScale(10), 5);
    assert.ok(fireflyOpacity(0.2) < fireflyOpacity(1.5));
    assert.ok(fireflyOpacity(1.5) <= 0.85);
  });
  it('trail is limited by distance, shrinks and fades with pace', () => {
    const h = new Float32Array(TRAIL_POINTS * 2);
    let n = 0;
    for (let i = 0; i < 40; i++) n = pushTrail(h, n, i * 0.2, 0);
    n = trimTrail(h, n, 2);
    assert.ok(n >= 10 && n <= 12, `kept ${n}`);
    assert.ok(Math.abs(h[(n - 1) * 2]! - 7.8) < 1e-4);
    assert.ok(trailLength(16) < trailLength(1) / 2);
    assert.equal(trailFade(1), 1);
    assert.ok(trailFade(16) < 0.6 && trailFade(16) > 0);
    assert.equal(trailFade(40), 0);
  });
});

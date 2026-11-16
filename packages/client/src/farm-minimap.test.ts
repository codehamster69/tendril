import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { frameMap, worldToMap, mapToWorld, tileDraw, tileColor, lodLabel, MIN_MARKER, MINIMAP_SIZE } from './farm-minimap.ts';

const quad = [{ x: -5, z: -5 }, { x: 12, z: -5 }, { x: 12, z: 9 }, { x: -5, z: 9 }];

describe('frameMap', () => {
  it('keeps land, viewport and home inside the square', () => {
    const v = frameMap({ x0: 0, x1: 20, z0: 0, z1: 10 }, quad, { x: 0, z: 0 });
    for (const p of [...quad, { x: -0.5, z: -0.5 }, { x: 20.5, z: 10.5 }]) {
      const [x, y] = worldToMap(v, p.x, p.z);
      assert.ok(x >= 0 && x <= MINIMAP_SIZE && y >= 0 && y <= MINIMAP_SIZE, `${p.x},${p.z} -> ${x},${y}`);
    }
  });
  it('round trips between world and map', () => {
    const v = frameMap(null, quad, { x: 0, z: 0 });
    const [x, y] = worldToMap(v, 3.25, -1.5);
    const w = mapToWorld(v, x, y);
    assert.ok(Math.abs(w.x - 3.25) < 1e-9 && Math.abs(w.z + 1.5) < 1e-9);
  });
  it('works for a 100000-tile farm with a tiny built area and ignores non-finite quad points', () => {
    const v = frameMap({ x0: 0, x1: 3, z0: 0, z1: 3 }, [{ x: Infinity, z: 0 }, { x: 50000, z: 50000 }], { x: 0, z: 0 });
    assert.ok(Number.isFinite(v.scale) && v.scale > 0);
  });
});

describe('tileDraw', () => {
  it('never draws below the minimum marker and samples sparser as scale shrinks', () => {
    assert.deepEqual(tileDraw(10), { px: 10, step: 1 });
    const a = tileDraw(0.01);
    assert.equal(a.px, MIN_MARKER);
    assert.ok(a.step * 0.01 >= MIN_MARKER);
  });
});

describe('labels and colours', () => {
  it('formats the LOD badge', () => {
    assert.equal(lodLabel(0, 41.6), 'Close · 42 px per tile');
    assert.equal(lodLabel(2, 0.3, 8), 'Map · <1 px per tile · 8x8 tiles per cell');
  });
  it('colours ripe crops differently from young ones', () => {
    const t = { x: 0, y: 0, crop: 1, tilled: true, building: 0 };
    assert.notEqual(tileColor({ ...t, stage: 0 }), tileColor({ ...t, stage: 3 }));
    assert.equal(tileColor({ ...t, crop: 0, stage: 0 }), '#6b4636');
  });
});

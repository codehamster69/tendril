import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dropDistances, dropUnit } from './drop-distance.ts';

const grid = (w: number, h: number, silo: [number, number][] = []) => {
  const cells = [];
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) cells.push({ x, y, building: silo.some(([a, b]) => a === x && b === y) ? 3 : 0 });
  return cells;
};

describe('dropDistances', () => {
  it('measures walking steps from the barn', () => {
    const d = dropDistances(grid(3, 3));
    assert.equal(d.byTile.get('0,0'), 0);
    assert.equal(d.byTile.get('2,2'), 4);
    assert.equal(d.max, 4);
  });

  it('uses the nearest silo as a second drop', () => {
    const d = dropDistances(grid(5, 1, [[4, 0]]));
    assert.equal(d.byTile.get('3,0'), 1);
    assert.equal(d.byTile.get('4,0'), 0);
  });

  it('does not walk through unowned tiles', () => {
    const d = dropDistances([{ x: 0, y: 0, building: 0 }, { x: 2, y: 0, building: 0 }]);
    assert.equal(d.byTile.has('2,0'), false);
    assert.equal(dropUnit(d, 2, 0), 1);
  });

  it('shades a tile by its share of the farthest distance', () => {
    const d = dropDistances(grid(3, 1));
    assert.equal(dropUnit(d, 0, 0), 0);
    assert.ok(Math.abs(dropUnit(d, 1, 0) - 0.5) < 1e-9);
    assert.equal(dropUnit(d, 2, 0), 1);
    assert.equal(dropUnit(null, 2, 0), 0);
  });
});

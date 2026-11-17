import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DROP_WINDOW, SiloDrops, saleSite } from './silo-drops.ts';
import type { Snapshot } from './sim-types.ts';

const snap = (bots: { x: number; y: number }[], tiles: { x: number; y: number; building: number }[]) =>
  ({ bots, tiles } as unknown as Snapshot);

describe('SiloDrops', () => {
  it('counts drops inside the last 500 ticks only', () => {
    const d = new SiloDrops();
    d.record(3, 3, 100);
    d.record(3, 3, 400);
    assert.equal(d.count(3, 3, 400), 2);
    assert.equal(d.count(3, 3, 100 + DROP_WINDOW + 1), 1);
    assert.equal(d.count(4, 3, 400), 0);
  });
});

describe('saleSite', () => {
  it('keeps the barn first, as before', () => {
    assert.deepEqual(saleSite(snap([{ x: 1, y: 0 }], [{ x: 2, y: 2, building: 3 }])), { x: 0, y: 0, silo: false });
  });

  it('finds a silo a bot stands on', () => {
    assert.deepEqual(saleSite(snap([{ x: 5, y: 5 }], [{ x: 5, y: 5, building: 3 }])), { x: 5, y: 5, silo: true });
  });

  it('ignores a bot next to a silo, since only its own tile stores', () => {
    assert.equal(saleSite(snap([{ x: 5, y: 6 }], [{ x: 5, y: 5, building: 3 }])), null);
  });
});

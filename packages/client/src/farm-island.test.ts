import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBody, buildField, buildMoss, buildRoots, cloudPuffs, keelDepth, outAt, rectOwnership, rimBlades, rimProps, sdfAt, wallStones, RIM, type Bounds, type Ownership } from './farm-island.ts';

import { Wear, WEAR_DIRT, WEAR_THIN } from './farm-wear.ts';

const rect = (x0: number, z0: number, w: number, d: number): { b: Bounds; own: Ownership } => {
  const b = { x0: x0 - 0.5, x1: x0 + w - 0.5, z0: z0 - 0.5, z1: z0 + d - 0.5 };
  return { b, own: rectOwnership(b) };
};

describe('island field', () => {
  it('puts owned tiles inside the land and the far corner outside', () => {
    const { b, own } = rect(0, 0, 12, 8), f = buildField(b, own);
    assert.ok(sdfAt(f, 0, 0) < -1.2 && sdfAt(f, 11, 7) < -1.2 && sdfAt(f, 6, 4) < -1.2);
    assert.ok(sdfAt(f, -RIM - 1.8, 0) > 0);
    assert.equal(outAt(f, 3, 3), 0);
  });
  it('is the same every time and never has more than about 110 cells a side', () => {
    const { b, own } = rect(0, 0, 900, 900), f = buildField(b, own), g = buildField(b, own);
    assert.ok(f.nx <= 125 && f.nz <= 125);
    assert.deepEqual(f.sdf, g.sdf);
  });
  it('follows the shape of the owned land, not its bounding box', () => {
    // An L: the empty corner of the box is wild land only 1.5 tiles deep.
    const tiles: [number, number][] = [];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (x < 5 || y < 5) tiles.push([x, y]);
    const set = new Set(tiles.map(([x, y]) => `${x},${y}`));
    const own: Ownership = { count: tiles.length, each: (cb) => tiles.forEach(([x, y]) => cb(x, y)), has: (x, y) => set.has(`${x},${y}`) };
    const f = buildField({ x0: -0.5, x1: 15.5, z0: -0.5, z1: 15.5 }, own);
    assert.ok(sdfAt(f, 13, 13) > 2);
    assert.ok(sdfAt(f, 2, 13) < 0 && sdfAt(f, 13, 2) < 0);
  });
});

describe('island body', () => {
  it('is a finite closed-looking mesh whose top is flat on the owned land', () => {
    const { b, own } = rect(0, 0, 10, 10), f = buildField(b, own), H = keelDepth(b), g = buildBody(f, H);
    const pos = g.attributes.position!.array as Float32Array;
    assert.ok(pos.every(Number.isFinite));
    g.computeBoundingBox();
    assert.ok(g.boundingBox!.max.y < 0.2 && g.boundingBox!.max.y > -0.05);
    assert.ok(g.boundingBox!.min.y < -H * 0.5 && g.boundingBox!.min.y > -H - 3);
    assert.ok(g.index!.count / 3 < 40000);
  });
  it('grows with the farm: more land, more depth, still bounded', () => {
    const small = keelDepth({ x0: 0, x1: 4, z0: 0, z1: 4 }), big = keelDepth({ x0: 0, x1: 60, z0: 0, z1: 60 }), huge = keelDepth({ x0: 0, x1: 9000, z0: 0, z1: 9000 });
    assert.ok(small < big && big <= huge && huge <= 48);
  });
});

describe('roots, moss, rim', () => {
  const { b, own } = rect(0, 0, 14, 12), f = buildField(b, own), H = keelDepth(b);
  it('builds bark roots and moss, never over the cap', () => {
    const roots = buildRoots(f, H), moss = buildMoss(f);
    assert.ok(roots && roots.attributes.color && roots.index!.count > 0);
    assert.ok(moss && moss.index!.count > 0 && moss.index!.count / 6 <= 700 * 3);
    assert.ok(buildRoots(buildField(...(() => { const r = rect(0, 0, 800, 800); return [r.b, r.own] as const; })()), 48, 36)!.index!.count < 36 * 30 * 3 * 40);
  });
  it('keeps props and blades on the wild rim, off the owned land, same result every time', () => {
    const props = rimProps(f);
    assert.ok(props.length > 8);
    for (const p of props) assert.ok(outAt(f, p.x, p.z) >= 0.8 && sdfAt(f, p.x, p.z) < 0, `${p.name} at ${p.x},${p.z}`);
    assert.deepEqual(props, rimProps(f));
    assert.deepEqual(new Set(props.map((p) => p.name)).has('prop_tree'), true);
    const blades = rimBlades(f);
    assert.ok(blades.length > 40 && blades.every((s) => outAt(f, s.x, s.z) >= 0.55));
  });
  it('props that stay in range keep their place when the farm grows', () => {
    const before = rimProps(f), grown = rect(0, 0, 14, 14), f2 = buildField(grown.b, grown.own), after = rimProps(f2);
    const kept = before.filter((p) => after.some((q) => q.x === p.x && q.z === p.z && q.name === p.name));
    assert.ok(kept.length > before.length * 0.4, `${kept.length}/${before.length}`);
  });
  it('puts the cloud sea clear of the land', () => {
    const puffs = cloudPuffs(f, b, H);
    assert.ok(puffs.length > 15 && puffs.length <= 65);
    assert.ok(puffs.every((p) => p.y < -2));
  });
});

describe('dry-stone wall', () => {
  it('runs along the owned edge only, with some gaps, and a plot added inside removes its share', () => {
    const { own } = rect(0, 0, 6, 6), stones = wallStones(own);
    // 24 edges, 5 stones each, a gap for roughly one in ten.
    assert.ok(stones.length > 20 * 5 * 0.7 && stones.length <= 24 * 5);
    assert.ok(stones.every((s) => s.x < -0.5 || s.x > 5.5 || s.z < -0.5 || s.z > 5.5 || false));
    const wide = wallStones(rect(0, 0, 12, 6).own);
    assert.ok(wide.length < stones.length * 2);
  });
  it('is skipped on a farm too big for it to matter', () => {
    assert.equal(wallStones(rect(0, 0, 3000, 3000).own).length, 0);
  });
});

describe('worn paths', () => {
  it('thins the grass after 2 steps and shows dirt from 6, per tile', () => {
    const w = new Wear();
    const step = (x: number): boolean => w.stepBots([{ x, y: 0 }], true);
    let changed = 0;
    for (let i = 0; i < WEAR_DIRT + 1; i++) { step(3); if (step(4)) changed++; }
    assert.equal(w.level(4, 0), 2);
    assert.equal(w.level(3, 0), 2);
    assert.equal(w.level(9, 9), 0);
    assert.ok(changed >= 1);
    assert.equal(WEAR_THIN < WEAR_DIRT, true);
  });
  it('ignores jumps and scrubs, and resets', () => {
    const w = new Wear();
    w.stepBots([{ x: 0, y: 0 }], true); w.stepBots([{ x: 50, y: 50 }], true);
    assert.equal(w.size, 0);
    w.stepBots([{ x: 0, y: 0 }], true); w.stepBots([{ x: 1, y: 0 }], false);
    assert.equal(w.size, 0);
    w.stepBots([{ x: 0, y: 0 }], true); w.stepBots([{ x: 1, y: 0 }], true);
    assert.equal(w.count(1, 0), 1);
    w.reset(); assert.equal(w.size, 0);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FarmWorld, fitWindow, lensColor, lodFor, viewWindow, CELL_BUDGET, MAX_INSTANCES, type SnapshotTile } from './farm-world.ts';
import { fallbackModel } from './fallback-models.ts';

const tile = (x: number, y: number, o: Partial<SnapshotTile> = {}): SnapshotTile =>
  ({ x, y, tilled: 0, crop: 0, stage: 0, moisture: 40, nitrogen: 50, fatigue: 10, building: 0, honey: 0, ...o });
const snap = (tiles: SnapshotTile[]) => ({ tick: 0, coins: 0, netWorth: 0, weather: 'clear', unlocks: 0, capacity: 0, plots: [], tiles, bots: [], stock: [], orders: [], plotCost: 0, botCost: 0 }) as never;
const quad = (x0: number, z0: number, x1: number, z1: number): THREE.Vector3[] =>
  [new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x1, 0, z0), new THREE.Vector3(x1, 0, z1), new THREE.Vector3(x0, 0, z1)];
const models = new Map<string, ReturnType<typeof fallbackModel>>();
const model = (name: string) => { let m = models.get(name); if (!m) { m = fallbackModel(name); models.set(name, m); } return m; };
const view = (q: THREE.Vector3[], tilePx: number, time = 0) => ({ camera: new THREE.PerspectiveCamera(), quad: q, distance: 20, tilePx, time });
const none = { overlay: 'none' as const, priceMultipliers: null };

function instances(scene: THREE.Scene): { total: number; max: number } {
  let total = 0, max = 0;
  scene.traverse((o) => { if (o instanceof THREE.InstancedMesh && o.name !== '') { total += o.count; max = Math.max(max, o.count); } });
  return { total, max };
}

describe('lodFor', () => {
  it('picks Close/Field/Map by pixels per tile with a 10 percent band', () => {
    assert.equal(lodFor(40, null), 0); assert.equal(lodFor(15, null), 1); assert.equal(lodFor(4, null), 2);
    assert.equal(lodFor(27, 0), 0, 'stays Close just under 28');
    assert.equal(lodFor(25, 0), 1);
    assert.equal(lodFor(29, 1), 1, 'needs 30.8 to return to Close');
    assert.equal(lodFor(31, 1), 0);
    assert.equal(lodFor(9.5, 1), 1); assert.equal(lodFor(8.9, 1), 2);
    assert.equal(lodFor(10.5, 2), 2); assert.equal(lodFor(11.1, 2), 1);
  });
});

describe('fitWindow', () => {
  it('keeps stride 1 for small windows and doubles it until cells fit the budget', () => {
    assert.equal(fitWindow(0, 99, 0, 99).stride, 1);
    const w = fitWindow(0, 999, 0, 999);
    assert.equal(w.stride, 16); assert.ok(w.cols * w.rows <= CELL_BUDGET);
    const huge = fitWindow(0, 99999, 0, 99999);
    assert.ok(huge.cols * huge.rows <= CELL_BUDGET && (huge.stride & (huge.stride - 1)) === 0);
  });
  it('aligns the origin to the stride', () => {
    const w = fitWindow(37, 5000, 5, 5000);
    assert.equal(w.i0 % w.stride, 0); assert.equal(w.j0 % w.stride, 0);
  });
});

describe('viewWindow', () => {
  const bounds = { x0: -0.5, x1: 10.5, z0: -0.5, z1: 10.5 };
  it('cuts the window down to existing land and culls everything else', () => {
    const w = viewWindow(quad(-1000, -1000, 1000, 1000), bounds)!;
    assert.deepEqual([w.i0, w.i1, w.j0, w.j1, w.stride], [0, 10, 0, 10, 1]);
    assert.equal(viewWindow(quad(500, 500, 600, 600), bounds), null);
    assert.equal(viewWindow(quad(0, 0, 1, 1), null), null);
  });
});

describe('lensColor', () => {
  it('runs blue to orange across 0.5..2', () => {
    const lo = lensColor(0.5, new THREE.Color()), hi = lensColor(2, new THREE.Color());
    assert.ok(lo.b > lo.r); assert.ok(hi.r > hi.b);
  });
});

describe('FarmWorld store', () => {
  it('stores tiles sparsely by chunk and replaces only changed tiles', () => {
    const w = new FarmWorld(new THREE.Scene(), model);
    const a = tile(0, 0), b = tile(40, -3);
    w.setSnapshot(snap([a, b]));
    assert.equal(w.tileAt(40, -3), b); assert.equal(w.tileAt(1, 1), undefined);
    let chunks = 0; w.forEachChunk(() => chunks++);
    assert.equal(chunks, 2);
    const a2 = tile(0, 0), c = tile(1, 0, { crop: 1 });
    w.setSnapshot(snap([a2, tile(40, -3, { crop: 2 }), c]));
    assert.equal(w.tileAt(0, 0), a, 'unchanged tile keeps identity');
    assert.equal(w.tileAt(40, -3)!.crop, 2);
    assert.deepEqual(w.bounds, { x0: -0.5, x1: 40.5, z0: -3.5, z1: 0.5 });
    w.setSnapshot(snap([a]));
    assert.equal(w.tileAt(40, -3), undefined); assert.equal(w.tileCount, 1);
    w.dispose();
  });
});

describe('FarmWorld refresh', () => {
  it('draws only tiles inside the view window', () => {
    const scene = new THREE.Scene();
    const w = new FarmWorld(scene, model);
    w.setSnapshot(snap([tile(0, 0), tile(1, 0, { tilled: 1 }), tile(500, 500, { tilled: 1, crop: 1, stage: 3 })]));
    let r = w.refresh(view(quad(-6, -6, 6, 6), 40), none);
    assert.equal(r.cells, 2); assert.equal(r.stride, 1); assert.equal(r.lod, 0); assert.equal(r.ripeInView, 0);
    r = w.refresh(view(quad(494, 494, 506, 506), 40), none);
    assert.equal(r.cells, 1); assert.equal(r.ripeInView, 1);
    w.dispose();
  });

  it('skips work when nothing changed and rebuilds when data does', () => {
    const w = new FarmWorld(new THREE.Scene(), model);
    w.setSnapshot(snap([tile(0, 0), tile(1, 0)]));
    const a = w.refresh(view(quad(-5, -5, 5, 5), 40), none);
    assert.equal(w.refresh(view(quad(-5, -5, 5, 5), 40, 0.01), none), a);
    w.setSnapshot(snap([tile(0, 0), tile(1, 0), tile(2, 0)]));
    assert.equal(w.refresh(view(quad(-5, -5, 5, 5), 40), none).cells, 3);
    w.dispose();
  });

  it('draws crops, price lens pads and Map cells', () => {
    const scene = new THREE.Scene();
    const w = new FarmWorld(scene, model);
    w.setSnapshot(snap([tile(0, 0), tile(1, 0, { tilled: 1, crop: 1, stage: 3 }), tile(2, 0, { tilled: 1, crop: 2, stage: 1 })]));
    w.refresh(view(quad(-5, -5, 5, 5), 40), none);
    assert.ok(w.debug.modelInstances['crop_carrot_s3'] === 1 && w.debug.modelInstances['crop_wheat_s1'] === 1);
    w.refresh(view(quad(-5, -5, 5, 5), 40), { overlay: 'none', priceMultipliers: [1, 2, 0.5, 1, 1, 1, 1] });
    assert.equal(w.debug.modelInstances['~pad'], 1, 'one pad per ripe crop');
    const map = w.refresh(view(quad(-5, -5, 5, 5), 4), none);
    assert.equal(map.lod, 2); assert.equal(map.cells, 3);
    assert.equal(w.debug.modelInstances['~cell'], 3); assert.equal(w.debug.modelInstances['crop_carrot_s3'], undefined);
    w.dispose();
  });

  it('draws a 100,000 x 100,000 sparse farm of 1,000 tiles with at most 20,000 instances', () => {
    const scene = new THREE.Scene();
    const w = new FarmWorld(scene, model);
    const tiles: SnapshotTile[] = [];
    const seen = new Set<string>();
    let s = 12345;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    while (tiles.length < 1000) {
      const x = Math.floor(rnd() * 100000), y = Math.floor(rnd() * 100000);
      if (seen.has(`${x},${y}`)) continue;
      seen.add(`${x},${y}`);
      tiles.push(tile(x, y, { tilled: 1, crop: 1 + (tiles.length % 6), stage: tiles.length % 4 }));
    }
    w.setSnapshot(snap(tiles));
    const r = w.refresh(view(quad(-10, -10, 100010, 100010), 0.001), none);
    const n = instances(scene);
    assert.equal(r.lod, 2); assert.ok(r.stride > 1); assert.ok(r.cells > 0 && r.cells <= CELL_BUDGET);
    assert.ok(n.total <= MAX_INSTANCES && n.max <= MAX_INSTANCES, `instances ${n.total}`);
    // A closer look at one corner of the same farm stays bounded too.
    const t0 = tiles[0];
    const close = w.refresh(view(quad(t0.x - 30, t0.y - 30, t0.x + 30, t0.y + 30), 30), none);
    assert.ok(close.cells >= 1 && instances(scene).total <= MAX_INSTANCES);
    w.dispose();
  });

  it('keeps a fully owned 400 x 400 farm under budget at Map zoom', () => {
    const scene = new THREE.Scene();
    const w = new FarmWorld(scene, model);
    const tiles: SnapshotTile[] = [];
    for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) tiles.push(tile(x, y, { tilled: 1, crop: 1 + ((x + y) % 6), stage: 3 }));
    w.setSnapshot(snap(tiles));
    const r = w.refresh(view(quad(0, 0, 400, 400), 3), none);
    assert.ok(r.stride >= 4 && r.cells <= CELL_BUDGET && instances(scene).total <= CELL_BUDGET);
    w.dispose();
  });
});

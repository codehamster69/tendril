import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Snapshot } from './sim-types';
import { motionQuery } from './settings.ts';

export type Placement = { x: number; z: number; rotation?: number; scale?: number; depth?: number };
export type Bounds = { x0: number; x1: number; z0: number; z1: number };

export function tileBounds(tiles: Snapshot['tiles']): Bounds | null {
  if (!tiles.length) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const tile of tiles) { x0 = Math.min(x0, tile.x - 0.5); x1 = Math.max(x1, tile.x + 0.5); z0 = Math.min(z0, tile.y - 0.5); z1 = Math.max(z1, tile.y + 0.5); }
  return { x0, x1, z0, z1 };
}

/** Legacy placements (terrace walls, trees, rocks). The island (`FarmIsland`) replaces the walls and the meadow plane: the integration should ignore the `tile_terrace_wall` list. Terrace walls around the owned land, plus sparse trees and rocks wholly outside its bounding rectangle. */
export function sceneryPlacements(tiles: Snapshot['tiles'], { x0, x1, z0, z1 }: Bounds, owned: (x: number, y: number) => boolean): Map<string, Placement[]> {
  const walls: Placement[] = [];
  for (const tile of tiles) {
    for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      if (!owned(tile.x + dx, tile.y + dz)) {
        // AT's riser is a full 1x1 tile, so narrow its depth and place it
        // wholly outside the playable edge, below the unchanged ground plane.
        walls.push({ x: tile.x + dx * 0.54, z: tile.y + dz * 0.54, rotation: dx ? Math.PI / 2 : 0, depth: 0.08 });
      }
    }
  }
  const trees: Placement[] = [], rocks: Placement[] = [];
  for (const fraction of [0.18, 0.76]) {
    trees.push({ x: x0 - 3, z: z0 + (z1 - z0) * fraction, scale: 0.9 }, { x: x1 + 3.2, z: z0 + (z1 - z0) * fraction, scale: 1.1 },
      { x: x0 + (x1 - x0) * fraction, z: z0 - 3, scale: 0.8 });
    rocks.push({ x: x0 - 2, z: z1 + fraction, rotation: fraction * 4 }, { x: x1 + 2, z: z1 - fraction, scale: 0.8 });
  }
  return new Map([['tile_terrace_wall', walls], ['prop_tree', trees], ['prop_rocks', rocks]]);
}

/* ------------------------------------------------------------------ the living island */

const COLORS = { grass: 0x4e9a63, soil: 0x4a2f25, strata1: 0x7a5a45, strata2: 0xa07f5e, keel: 0x6a7e85, keel2: 0x586a70, bed: 0x33231f, tendril: 0x4fd1b0, tendrilGlow: 0x1d6b58 };
/** Beds (dark gaps under owned tiles) are only built when scanning the rectangle is cheap. */
const BED_SCAN_LIMIT = 16384;
const KEEL_MAX = 48;
const TENDRIL_MAX = 40;
const TENDRIL_REACH = 28;

/** Small deterministic PRNG so tendrils keep their look between rebuilds. */
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Floating slab under the farm: grass cap, soil lip, two strata, a faceted stone keel and glowing tendrils; a pulsing frontier marks where land can grow. Cost follows the number of owned tiles only up to a scan limit, never the size of the farm. */
export class FarmIsland {
  private group = new THREE.Group();
  private frontier = new THREE.Group();
  private frontierMat = new THREE.MeshBasicMaterial({ color: COLORS.tendril, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
  private frontierBars: THREE.Mesh[] = [];
  private unitBox = new THREE.BoxGeometry(1, 1, 1);
  private keelGeo = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4).rotateX(Math.PI);
  private mats: Record<'grass' | 'soil' | 'strata1' | 'strata2' | 'keel' | 'keel2' | 'bed' | 'tendril', THREE.MeshStandardMaterial>;
  private slab: THREE.Mesh[] = [];
  private keel: THREE.Mesh[] = [];
  private tendrils: THREE.Mesh | null = null;
  private bed: THREE.InstancedMesh | null = null;
  private bedKey = '';
  private boundsKey = '';
  private bounds: Bounds | null = null;
  private distance = 20;
  private reduced = motionQuery;
  private disposed = false;

  constructor(private scene: THREE.Scene) {
    const m = (color: number, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true, ...extra });
    this.mats = {
      grass: m(COLORS.grass), soil: m(COLORS.soil), strata1: m(COLORS.strata1), strata2: m(COLORS.strata2), keel: m(COLORS.keel, { emissive: 0x0a1a1c }), keel2: m(COLORS.keel2, { emissive: 0x0a1a1c }), bed: m(COLORS.bed),
      tendril: m(COLORS.tendril, { emissive: COLORS.tendrilGlow, roughness: 0.7, flatShading: false }),
    };
    const box = (mat: THREE.Material, shadow = true): THREE.Mesh => { const mesh = new THREE.Mesh(this.unitBox, mat); mesh.receiveShadow = shadow; mesh.frustumCulled = false; this.group.add(mesh); return mesh; };
    this.slab = [box(this.mats.grass), box(this.mats.soil), box(this.mats.strata1), box(this.mats.strata2)];
    for (const mat of [this.mats.keel, this.mats.keel2]) {
      const mesh = new THREE.Mesh(this.keelGeo, mat);
      mesh.receiveShadow = true; mesh.frustumCulled = false;
      this.group.add(mesh); this.keel.push(mesh);
    }
    for (let i = 0; i < 4; i++) {
      const bar = new THREE.Mesh(this.unitBox, this.frontierMat);
      bar.frustumCulled = false; bar.renderOrder = 2;
      this.frontier.add(bar); this.frontierBars.push(bar);
    }
    this.group.visible = false;
    this.frontier.visible = false;
    scene.add(this.group, this.frontier);
  }

  /** Call when the snapshot changes (not per frame). Rebuilds only when the bounds or the owned set (small farms) change. */
  update(bounds: Bounds | null, owned: (x: number, y: number) => boolean): void {
    if (this.disposed) return;
    this.bounds = bounds;
    this.group.visible = this.frontier.visible = !!bounds;
    if (!bounds) { this.clearBed(); this.boundsKey = ''; return; }
    const key = `${bounds.x0},${bounds.x1},${bounds.z0},${bounds.z1}`;
    if (key !== this.boundsKey) { this.boundsKey = key; this.layoutSlab(bounds); this.layoutFrontier(); }
    this.buildBed(bounds, owned);
  }

  setDistance(d: number): void {
    this.distance = Math.max(1, d);
    if (this.bounds) this.layoutFrontier();
  }

  pulse(time: number): void {
    if (this.disposed) return;
    this.frontierMat.opacity = this.reduced?.matches ? 0.4 : 0.32 + 0.16 * Math.sin(time * 2);
    this.mats.tendril.emissiveIntensity = this.reduced?.matches ? 1 : 0.85 + 0.25 * Math.sin(time * 1.3);
  }

  private layoutSlab(b: Bounds): void {
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, w = b.x1 - b.x0 + 0.1, d = b.z1 - b.z0 + 0.1;
    // [width pad, height, centre y]: cap top sits just below the tile tops, strata stack under it.
    const layers: [number, number, number][] = [[0, 0.1, -0.09], [0, 0.22, -0.25], [0.06, 0.32, -0.52], [0.02, 0.3, -0.83]];
    this.slab.forEach((mesh, i) => { const [pad, h, y] = layers[i]!; mesh.scale.set(w + pad, h, d + pad); mesh.position.set(cx, y, cz); });
    const size = (w + d) / 2;
    const h = Math.min(KEEL_MAX, Math.max(2.6, size * 0.35));
    const [k1, k2] = this.keel as [THREE.Mesh, THREE.Mesh];
    k1.scale.set(w, h, d); k1.position.set(cx, -0.98 - h / 2, cz);
    // A smaller, turned facet cluster breaks up the perfect pyramid.
    k2.scale.set(w * 0.72, h * 0.72, d * 0.72); k2.rotation.y = 0.5; k2.position.set(cx + w * 0.04, -0.98 - h * 0.36, cz - d * 0.03);
    this.buildTendrils(cx, cz, w, d);
  }

  private buildTendrils(cx: number, cz: number, w: number, d: number): void {
    if (this.tendrils) { this.group.remove(this.tendrils); this.tendrils.geometry.dispose(); this.tendrils = null; }
    const rnd = rng(7), size = (w + d) / 2;
    const n = Math.min(TENDRIL_MAX, Math.round(8 + (w + d) * 0.35));
    const reach = Math.min(TENDRIL_REACH, Math.max(1.5, size * 0.14));
    const geos: THREE.BufferGeometry[] = [];
    for (let k = 0; k < n; k++) {
      const side = (k * 7) % 4;
      const along = rnd() - 0.5, ex = w / 2 + 0.02, ez = d / 2 + 0.02;
      let x0: number, z0: number, dx: number, dz: number;
      if (side === 0) { x0 = along * w; z0 = -ez; dx = 0; dz = -1; }
      else if (side === 1) { x0 = along * w; z0 = ez; dx = 0; dz = 1; }
      else if (side === 2) { x0 = -ex; z0 = along * d; dx = -1; dz = 0; }
      else { x0 = ex; z0 = along * d; dx = 1; dz = 0; }
      const len = 1.2 + rnd() * reach, ph = rnd() * 6, pts: THREE.Vector3[] = [];
      for (let s = 0; s <= 10; s++) {
        const u = s / 10, curl = Math.max(0, u - 0.65) / 0.35;
        pts.push(new THREE.Vector3(
          cx + x0 + dx * (0.12 + 0.25 * Math.sin(u * 3 + ph) + curl * 0.28 * Math.cos(curl * 7)),
          -0.7 - u * len,
          cz + z0 + dz * (0.12 + 0.25 * Math.cos(u * 2.6 + ph) + curl * 0.28 * Math.sin(curl * 7))));
      }
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.05, 5);
      geos.push(tube);
    }
    const merged = geos.length ? mergeGeometries(geos, false) : null;
    for (const g of geos) g.dispose();
    if (!merged) return;
    this.tendrils = new THREE.Mesh(merged, this.mats.tendril);
    this.tendrils.frustumCulled = false;
    this.group.add(this.tendrils);
  }

  private layoutFrontier(): void {
    const b = this.bounds;
    if (!b) return;
    const t = Math.max(0.09, this.distance * 0.003), w = b.x1 - b.x0, d = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    const [n, s, wst, e] = this.frontierBars as [THREE.Mesh, THREE.Mesh, THREE.Mesh, THREE.Mesh];
    n.position.set(cx, 0.06, b.z0); n.scale.set(w + t, 0.02, t);
    s.position.set(cx, 0.06, b.z1); s.scale.set(w + t, 0.02, t);
    wst.position.set(b.x0, 0.06, cz); wst.scale.set(t, 0.02, d + t);
    e.position.set(b.x1, 0.06, cz); e.scale.set(t, 0.02, d + t);
  }

  /** Dark soil plates under owned tiles so gaps between tiles read as a grid; the rest of the top stays meadow. */
  private buildBed(b: Bounds, owned: (x: number, y: number) => boolean): void {
    const w = Math.round(b.x1 - b.x0), d = Math.round(b.z1 - b.z0);
    if (w * d > BED_SCAN_LIMIT || w < 1 || d < 1) { this.clearBed(); return; }
    const xs: number[] = [], zs: number[] = [];
    let hash = 0;
    const x0 = Math.round(b.x0 + 0.5), z0 = Math.round(b.z0 + 0.5);
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
      if (!owned(x0 + x, z0 + z)) continue;
      xs.push(x0 + x); zs.push(z0 + z);
      hash = (hash * 31 + (x + 1) * 7919 + (z + 1) * 104729) | 0;
    }
    const key = `${this.boundsKey}|${xs.length}|${hash}`;
    if (key === this.bedKey) return;
    this.bedKey = key;
    this.clearBed(false);
    if (!xs.length) return;
    const geo = new THREE.BoxGeometry(1, 0.02, 1).translate(0, -0.03, 0);
    const mesh = new THREE.InstancedMesh(geo, this.mats.bed, xs.length);
    const m = new THREE.Matrix4();
    for (let i = 0; i < xs.length; i++) mesh.setMatrixAt(i, m.makeTranslation(xs[i]!, 0, zs[i]!));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.receiveShadow = true; mesh.frustumCulled = false;
    this.bed = mesh;
    this.group.add(mesh);
  }

  private clearBed(resetKey = true): void {
    if (this.bed) { this.group.remove(this.bed); this.bed.geometry.dispose(); this.bed.dispose(); this.bed = null; }
    if (resetKey) this.bedKey = '';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearBed();
    if (this.tendrils) this.tendrils.geometry.dispose();
    this.scene.remove(this.group, this.frontier);
    this.unitBox.dispose();
    this.keelGeo.dispose();
    this.frontierMat.dispose();
    for (const mat of Object.values(this.mats)) mat.dispose();
  }
}

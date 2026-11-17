import * as THREE from 'three';
import type { SnapshotBot } from '@tendril/sim';
import type { AssetModel } from './asset-loader';
import { FarmFx } from './farm-fx.ts';
import { BOT_PALETTE, botColourHex } from './bot-colours.ts';
import { motionQuery } from './settings.ts';

/**
 * Lantern drones for the farm view: cream hull, amber core with additive halo, three spinning leaf blades,
 * a contact blob shadow and a fading additive vine trail. One Group per drone (a farm has a handful), all
 * geometry and textures shared, nothing allocated per frame. The GLB `bot_tender` is used when it has loaded.
 */

export const DRONE_COLORS: readonly number[] = BOT_PALETTE.map((c) => parseInt(c.slice(1), 16));
const MAX_RINGS = 256;
export const TRAIL_POINTS = 44;
/** Height of the hull centre above the tile surface. Carried-item markers stack above this. */
export const DRONE_HOVER = 0.75;
const TRAIL_STEP = 0.12;
const TRAIL_Y = 0.07;
const SNAP_DISTANCE = 12;

/** Spark colours per op id (matches `OP` in the sim rules). Absent ops make no burst. */
const OP_SPARK: Record<number, number> = {
  1: 0x9a6a4f, // till
  2: 0x7ce0a0, // plant
  3: 0x6ab8ff, // water
  4: 0xffc65a, // harvest
  5: 0xffe08a, // deposit
  6: 0xffe08a, // deliver
  11: 0xd1b98a, // build
  12: 0xaab0a0, // clear
  13: 0x8a6b3a, // compost
  14: 0x8fbf6a, // fertilize
};
/** Ops during which the work beam shows under the drone. */
const OP_BEAM = new Set([1, 2, 3, 4, 11, 12, 13, 14]);

// ---- pure helpers (unit tested) ----

export const droneColor = (id: number): number => botColourHex(id);

/** Spark colour for an op, or null when the op makes no burst (move, wait, farm ops). */
export const sparkColor = (op: number | null): number | null => (op === null ? null : OP_SPARK[op] ?? null);
export const beamOp = (op: number | null): boolean => op !== null && OP_BEAM.has(op);

/** Frame-rate independent easing factor in 0..1. */
export const easeFactor = (dt: number, rate: number): number => 1 - Math.exp(-Math.max(0, dt) * rate);

/** Shortest signed angle difference, in -PI..PI. */
export function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  return ((((a + Math.PI) % t) + t) % t) - Math.PI;
}

/** Drone scale so it stays about `targetPx` on screen once the world is zoomed out: 1 while tiles are big enough. */
export function droneViewScale(tilePx: number, targetPx = 12, baseTiles = 0.4): number {
  if (!(tilePx > 0)) return 1;
  return Math.min(40, Math.max(1, targetPx / (tilePx * baseTiles)));
}

/** Append (x,z) to an interleaved history if it moved far enough from the last point. Returns the new count. Drops the oldest at capacity. */
export function pushTrail(hist: Float32Array, count: number, x: number, z: number, step = TRAIL_STEP): number {
  const cap = hist.length / 2;
  if (count > 0 && Math.hypot(x - hist[(count - 1) * 2]!, z - hist[(count - 1) * 2 + 1]!) <= step) return count;
  if (count >= cap) { hist.copyWithin(0, 2); count = cap - 1; }
  hist[count * 2] = x; hist[count * 2 + 1] = z;
  return count + 1;
}

/** Trail length in tiles for a playback pace (`tickDelta` = ticks per snapshot, 1 at 1x): shorter as the drone moves faster. */
export const trailLength = (pace: number): number => Math.max(0.5, Math.min(3.5, 3.5 / (1 + Math.max(0, pace - 1) * 0.35)));
/** Trail strength 0..1 for a pace: fades out completely when the drone is too fast for a readable line. */
export const trailFade = (pace: number): number => (pace >= 28 ? 0 : Math.max(0, Math.min(1, 1 - (pace - 4) / 24)));

/** Drop the oldest points until the polyline is at most `maxLen` long (in distance, not point count). Returns the new count. */
export function trimTrail(hist: Float32Array, count: number, maxLen: number): number {
  let len = 0, keep = count;
  for (let i = count - 1; i > 0; i--) {
    len += Math.hypot(hist[i * 2]! - hist[(i - 1) * 2]!, hist[i * 2 + 1]! - hist[(i - 1) * 2 + 1]!);
    if (len > maxLen) { keep = count - i; break; }
  }
  if (keep >= count) return count;
  hist.copyWithin(0, (count - keep) * 2, count * 2);
  return keep;
}

/**
 * Write a two-vertex-per-point ribbon (tail narrow and dark, head wide and bright). `pos` and `col` hold
 * `cap * 6` floats. Unfilled leading slots repeat the oldest point so the geometry never degenerates oddly.
 */
export function fillRibbon(pos: Float32Array, col: Float32Array, hist: Float32Array, n: number, cap: number, width: number, rgb: readonly [number, number, number], intensity: number, headX: number, headZ: number): void {
  const at = (k: number): number => Math.min(n - 1, Math.max(0, k - (cap - n)));
  for (let k = 0; k < cap; k++) {
    const i = n ? at(k) : -1;
    const sx = n ? hist[i * 2]! : headX, sz = n ? hist[i * 2 + 1]! : headZ;
    let tx = n ? hist[at(k + 1) * 2]! - hist[at(k - 1) * 2]! : 0;
    let tz = n ? hist[at(k + 1) * 2 + 1]! - hist[at(k - 1) * 2 + 1]! : 0;
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    const f = k / (cap - 1);
    const ww = width * (0.25 + f * 0.75);
    pos[k * 6] = sx - tz * ww; pos[k * 6 + 1] = TRAIL_Y; pos[k * 6 + 2] = sz + tx * ww;
    pos[k * 6 + 3] = sx + tz * ww; pos[k * 6 + 4] = TRAIL_Y; pos[k * 6 + 5] = sz - tx * ww;
    const a = f * f * intensity;
    for (let q = 0; q < 2; q++) { col[k * 6 + q * 3] = rgb[0] * a; col[k * 6 + q * 3 + 1] = rgb[1] * a; col[k * 6 + q * 3 + 2] = rgb[2] * a; }
  }
}

// ---- shared resources ----

function radialTexture(stops: [number, string][]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (const [o, color] of stops) g.addColorStop(o, color);
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Drone {
  id: number;
  group: THREE.Group;
  body: THREE.Group;
  rot: THREE.Group | null;
  beam: THREE.Mesh;
  halo: THREE.Sprite;
  blob: THREE.Mesh;
  trail: THREE.Mesh;
  tPos: Float32Array;
  tCol: Float32Array;
  hist: Float32Array;
  histN: number;
  rgb: [number, number, number];
  x: number; z: number; tx: number; tz: number;
  vx: number; vz: number; yaw: number;
  op: number | null;
  beamLevel: number;
  catchUp: number;
  own: THREE.Material[];
  coreMat: THREE.Material | null;
}

export class FarmDrones {
  trails = true;
  private drones: Drone[] = [];
  private fx: FarmFx;
  private ownsFx: boolean;
  private focus: { x: number; z: number } | null = null;
  private root = new THREE.Group();
  private ring = new THREE.Mesh(new THREE.TorusGeometry(0.37, 0.025, 4, 24).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd66a }));
  private selected: number | null = null;
  /** One flat coloured ring on the ground under every drone: a single instanced draw call whatever the crew size. */
  private marks = new THREE.InstancedMesh(new THREE.RingGeometry(0.3, 0.37, 28).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false }), MAX_RINGS);
  private markDummy = new THREE.Object3D();
  private blobTex = radialTexture([[0, 'rgba(0,0,0,.55)'], [1, 'rgba(0,0,0,0)']]);
  private glowTex = radialTexture([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,.35)'], [1, 'rgba(255,255,255,0)']]);
  private hullGeo = new THREE.SphereGeometry(0.17, 14, 10);
  private coreGeo = new THREE.SphereGeometry(0.075, 10, 8);
  private bladeGeo = new THREE.SphereGeometry(1, 8, 4).scale(0.24, 0.012, 0.07);
  private beamGeo = new THREE.ConeGeometry(0.16, 0.9, 12, 1, true).translate(0, -0.45, 0);
  private blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private hullMat = new THREE.MeshStandardMaterial({ color: 0xf2ecdc, roughness: 0.45 });
  private bladeMat = new THREE.MeshStandardMaterial({ color: 0x6fcf86, roughness: 0.6 });
  private blobMat = new THREE.MeshBasicMaterial({ map: this.blobTex, transparent: true, depthWrite: false, opacity: 0.7 });
  private glbModel: AssetModel | null = null;
  private reduced = motionQuery;
  private viewScale = 1;
  private disposed = false;
  private tmpRgb = new THREE.Color();
  private tickDelta = 1;

  /**
   * Pass the host's shared `FarmFx` to reuse it (the host then updates and disposes it). Without one the
   * drones make their own and drive it from `update`.
   */
  private scene: THREE.Scene;
  private model: () => AssetModel | null;

  constructor(scene: THREE.Scene, model: () => AssetModel | null, fx?: FarmFx) {
    this.scene = scene;
    this.model = model;
    this.ownsFx = !fx;
    this.fx = fx ?? new FarmFx(scene);
    this.ring.visible = false;
    this.root.name = 'farm-drones';
    this.marks.count = 0;
    this.marks.frustumCulled = false;
    this.marks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.root, this.ring, this.marks);
  }

  /** The effects instance in use (for harvest bursts from the host). */
  get effects(): FarmFx { return this.fx; }

  /** Camera focus for the fireflies; defaults to the middle of the drones. Only used when the drones own the fx. */
  setFocus(x: number, z: number): void { this.focus = { x, z }; }

  setBots(bots: SnapshotBot[], tickDelta = 1): void {
    if (this.disposed) return;
    this.tickDelta = Math.max(1, tickDelta);
    while (this.drones.length < bots.length) {
      const b = bots[this.drones.length]!;
      const d = this.make(this.drones.length);
      if (d.id < MAX_RINGS) this.marks.setColorAt(d.id, this.tmpRgb.set(droneColor(d.id)));
      if (this.marks.instanceColor) this.marks.instanceColor.needsUpdate = true;
      d.x = d.tx = b.x; d.z = d.tz = b.y; d.op = b.op;
      this.drones.push(d);
    }
    while (this.drones.length > bots.length) this.remove(this.drones.pop()!);
    if (this.selected !== null && this.selected >= this.drones.length) this.selected = null;
    bots.forEach((b, i) => {
      const d = this.drones[i]!;
      d.tx = b.x; d.tz = b.y;
      d.catchUp = this.tickDelta;
      if (Math.hypot(d.tx - d.x, d.tz - d.z) > SNAP_DISTANCE) { d.x = d.tx; d.z = d.tz; d.histN = 0; }
      if (b.op !== d.op) {
        const spark = sparkColor(b.op);
        if (spark !== null) this.fx.burst(d.tx, 0.2, d.tz, spark, b.op === 4 ? 12 : 8);
        if (b.op === 2 || b.op === 4) this.fx.pop(d.tx, d.tz, spark ?? 0xffffff);
        d.op = b.op;
      }
    });
  }

  update(dt: number, time: number, glow: number, viewScale: number): void {
    if (this.disposed) return;
    const reduced = this.reduced.matches;
    this.viewScale = Math.min(40, Math.max(1, viewScale || 1));
    this.syncModel();
    const blend = easeFactor(dt, 12 * Math.sqrt(this.tickDelta));
    const sc = this.viewScale;
    for (const d of this.drones) {
      const px = d.x, pz = d.z;
      if (reduced) { d.x = d.tx; d.z = d.tz; } else { d.x += (d.tx - d.x) * blend; d.z += (d.tz - d.z) * blend; }
      if (dt > 0) {
        const k = easeFactor(dt, 8);
        d.vx += ((d.x - px) / dt - d.vx) * k;
        d.vz += ((d.z - pz) / dt - d.vz) * k;
      }
      const speed = Math.hypot(d.vx, d.vz);
      if (speed > 0.3) d.yaw += wrapAngle(Math.atan2(d.vx, d.vz) - d.yaw) * easeFactor(dt, 9);
      const hover = DRONE_HOVER + (reduced ? 0 : Math.sin(time * 2.2 + d.id) * 0.04);
      d.group.position.set(d.x, hover * (1 + (sc - 1) * 0.5), d.z);
      d.group.rotation.y = d.yaw;
      d.group.scale.setScalar(sc);
      if (!reduced) {
        const lat = d.vx * Math.cos(d.yaw) - d.vz * Math.sin(d.yaw);
        const lean = Math.min(0.35, speed * 0.04);
        const roll = Math.max(-0.3, Math.min(0.3, lat * 0.05));
        const k = easeFactor(dt, 8);
        d.body.rotation.x += (lean - d.body.rotation.x) * k;
        d.body.rotation.z += (roll - d.body.rotation.z) * k;
        if (d.rot) d.rot.rotation.y += dt * (d.beamLevel > 0.3 ? 32 : 20);
      } else { d.body.rotation.x = d.body.rotation.z = 0; }
      d.blob.position.set(d.x, 0.02, d.z);
      d.blob.scale.setScalar(0.7 * sc);
      const target = beamOp(d.op) ? 1 : 0;
      d.beamLevel += (target - d.beamLevel) * easeFactor(dt, 10);
      (d.beam.material as THREE.MeshBasicMaterial).opacity = 0.28 * d.beamLevel * Math.min(1.2, 0.6 + glow * 0.4);
      d.beam.visible = d.beamLevel > 0.02;
      d.halo.material.opacity = 0.55 * Math.min(1.4, glow) + 0.2;
      d.halo.scale.setScalar((0.8 + 0.15 * glow) * 1);

      // Long in distance (not in points), shorter, thinner and dimmer as playback speeds up; none at extreme pace.
      const fade = trailFade(this.tickDelta);
      const show = this.trails && !reduced && fade > 0;
      if (show) {
        d.histN = pushTrail(d.hist, d.histN, d.x, d.z);
        d.histN = trimTrail(d.hist, d.histN, trailLength(this.tickDelta) * Math.max(1, sc * 0.7));
      } else d.histN = 0;
      d.trail.visible = show && d.histN > 2;
      if (d.trail.visible) {
        fillRibbon(d.tPos, d.tCol, d.hist, d.histN, TRAIL_POINTS, 0.045 * Math.max(1, sc * 0.7) * (0.4 + 0.6 * fade), d.rgb, (0.9 + 0.4 * glow) * fade, d.x, d.z);
        (d.trail.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        (d.trail.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
      }
    }
    const rings = Math.min(this.drones.length, MAX_RINGS);
    for (let i = 0; i < rings; i++) {
      const d = this.drones[i]!;
      this.markDummy.position.set(d.x, 0.035, d.z);
      this.markDummy.scale.setScalar(sc);
      this.markDummy.updateMatrix();
      this.marks.setMatrixAt(i, this.markDummy.matrix);
    }
    this.marks.count = rings;
    this.marks.instanceMatrix.needsUpdate = true;
    this.ring.visible = this.selected !== null && !!this.drones[this.selected];
    if (this.ring.visible) {
      const d = this.drones[this.selected!]!;
      this.ring.position.set(d.x, 0.04, d.z);
      this.ring.scale.setScalar(sc);
    }
    if (this.ownsFx) this.fx.update(dt, time, this.focus ?? this.focusPoint(), glow, sc);
  }

  /** True while any drone is still travelling, turning or changing its beam; false once the whole fleet is at rest. */
  get moving(): boolean {
    for (const d of this.drones) {
      if (Math.abs(d.tx - d.x) + Math.abs(d.tz - d.z) > 0.002 || Math.abs(d.vx) + Math.abs(d.vz) > 0.02) return true;
      if (Math.abs((beamOp(d.op) ? 1 : 0) - d.beamLevel) > 0.01) return true;
    }
    return false;
  }

  position(id: number): { x: number; z: number } | null {
    const d = this.drones[id];
    return d ? { x: d.x, z: d.z } : null;
  }

  setSelected(id: number | null): void {
    this.selected = id !== null && this.drones[id] ? id : null;
    this.ring.visible = this.selected !== null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.drones) this.remove(d);
    this.drones = [];
    this.scene.remove(this.root, this.ring, this.marks);
    this.marks.geometry.dispose(); (this.marks.material as THREE.Material).dispose(); this.marks.dispose();
    this.ring.geometry.dispose(); (this.ring.material as THREE.Material).dispose();
    for (const g of [this.hullGeo, this.coreGeo, this.bladeGeo, this.beamGeo, this.blobGeo]) g.dispose();
    for (const m of [this.hullMat, this.bladeMat, this.blobMat]) m.dispose();
    this.blobTex.dispose(); this.glowTex.dispose();
    if (this.ownsFx) this.fx.dispose();
  }

  // ---- internals ----

  /** Fireflies follow the middle of the drone group (or the origin with none): the host can also pass its own focus via `effects`. */
  private focusPoint(): { x: number; z: number } {
    if (!this.drones.length) return { x: 0, z: 0 };
    let x = 0, z = 0;
    for (const d of this.drones) { x += d.x; z += d.z; }
    return { x: x / this.drones.length, z: z / this.drones.length };
  }

  private make(id: number): Drone {
    const color = droneColor(id);
    const c = this.tmpRgb.set(color);
    const rgb: [number, number, number] = [c.r, c.g, c.b];
    const group = new THREE.Group();
    const body = new THREE.Group();
    const haloMat = new THREE.SpriteMaterial({ map: this.glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    const halo = new THREE.Sprite(haloMat);
    halo.position.y = -0.09;
    halo.scale.setScalar(0.8);
    const beamMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const beam = new THREE.Mesh(this.beamGeo, beamMat);
    beam.position.y = -0.05;
    beam.visible = false;
    const own: THREE.Material[] = [haloMat, beamMat];
    body.add(halo, beam);
    group.add(body);

    const blob = new THREE.Mesh(this.blobGeo, this.blobMat);
    blob.position.y = 0.02;

    const tPos = new Float32Array(TRAIL_POINTS * 6);
    const tCol = new Float32Array(TRAIL_POINTS * 6);
    const idx: number[] = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
    tg.setAttribute('color', new THREE.BufferAttribute(tCol, 3));
    tg.setIndex(idx);
    const tMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    own.push(tMat);
    const trail = new THREE.Mesh(tg, tMat);
    trail.frustumCulled = false;
    trail.visible = false;

    this.root.add(group, blob, trail);
    const d: Drone = {
      id, group, body, rot: null, beam, halo, blob, trail, tPos, tCol, rgb, own,
      hist: new Float32Array(TRAIL_POINTS * 2), histN: 0,
      x: 0, z: 0, tx: 0, tz: 0, vx: 0, vz: 0, yaw: 0, op: null, beamLevel: 0, catchUp: 1, coreMat: null,
    };
    this.buildBody(d, color);
    return d;
  }

  /** (Re)build the drone's solid parts: GLB when loaded, procedural lantern drone otherwise. */
  private buildBody(d: Drone, color: number): void {
    for (const child of [...d.body.children]) if (child !== d.halo && child !== d.beam) d.body.remove(child);
    d.rot = null;
    if (d.coreMat) { d.own.splice(d.own.indexOf(d.coreMat), 1); d.coreMat.dispose(); d.coreMat = null; }
    const glb = this.glbModel;
    if (glb && glb.parts.length) {
      const holder = new THREE.Group();
      for (const part of glb.parts) {
        const m = new THREE.Mesh(part.geometry, part.material);
        m.castShadow = true;
        holder.add(m);
      }
      // Centre the model on its hull so hover height and the halo line up whatever its authored origin was.
      const box = new THREE.Box3().setFromObject(holder);
      holder.position.y = -((box.min.y + box.max.y) / 2);
      d.body.add(holder);
      return;
    }
    const hull = new THREE.Mesh(this.hullGeo, this.hullMat);
    hull.scale.y = 0.85;
    hull.castShadow = true;
    const coreMat = new THREE.MeshBasicMaterial({ color });
    d.own.push(coreMat);
    d.coreMat = coreMat;
    const core = new THREE.Mesh(this.coreGeo, coreMat);
    core.position.y = -0.09;
    const rot = new THREE.Group();
    rot.position.y = 0.17;
    for (let k = 0; k < 3; k++) {
      const b = new THREE.Mesh(this.bladeGeo, this.bladeMat);
      const a = (k * Math.PI * 2) / 3;
      b.position.set(Math.cos(a) * 0.2, 0, Math.sin(a) * 0.2);
      b.rotation.y = -a;
      b.castShadow = true;
      rot.add(b);
    }
    d.body.add(hull, core, rot);
    d.rot = rot;
  }

  /** Swap every drone to the GLB the first time (or whenever) the loader hands one over. */
  private syncModel(): void {
    const m = this.model();
    if (m === this.glbModel) return;
    this.glbModel = m;
    for (const d of this.drones) this.buildBody(d, droneColor(d.id));
  }

  private remove(d: Drone): void {
    this.root.remove(d.group, d.blob, d.trail);
    d.trail.geometry.dispose();
    for (const m of d.own) m.dispose();
  }
}

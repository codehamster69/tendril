import * as THREE from 'three';
import type { AssetModel, AssetPart } from './asset-loader.ts';
import type { Snapshot } from './sim-types.ts';
import { BUILDING_MODELS, CROPS, CROP_COLORS } from './fallback-models.ts';
import { OverlayLayer, overlayColor, unit, type FarmOverlay } from './farm-overlay.ts';
import type { Bounds } from './farm-scenery.ts';

/**
 * The view-window renderer. Tiles live in a sparse store of 32x32 chunks (nothing exists for land nobody owns).
 * `refresh` draws only what the screen can see, coarser as you zoom out, so the cost follows the screen and the
 * touched land and never the size of the farm. Everything is instanced: one mesh per model part, never one object
 * per tile, and no mesh ever holds more than MAX_INSTANCES.
 */
export type SnapshotTile = Snapshot['tiles'][number];
export type Lod = 0 | 1 | 2;

export const CHUNK = 32;
export const MAX_INSTANCES = 20000;
/** Cells (tiles, or merged blocks of tiles) drawn at most per refresh. */
export const CELL_BUDGET = 14000;
export const LOD_CLOSE_PX = 28;
export const LOD_FIELD_PX = 10;
const HYSTERESIS = 0.1;
/** Above this many stored tiles under a merged window, cells are sampled instead of every tile being read. */
const SAMPLE_LIMIT = 4 * CELL_BUDGET;

export interface WorldView { camera: THREE.Camera; quad: THREE.Vector3[]; distance: number; tilePx: number; time: number }
export interface RefreshOptions { overlay: FarmOverlay; priceMultipliers: number[] | null }
export interface RefreshResult { lod: Lod; stride: number; ripeInView: number; cells: number }

/** Level of detail from pixels per tile: Close >= 28, Field >= 10, Map below. A 10 percent band stops flicker. */
export function lodFor(tilePx: number, previous: Lod | null): Lod {
  if (previous === null) return tilePx >= LOD_CLOSE_PX ? 0 : tilePx >= LOD_FIELD_PX ? 1 : 2;
  let lod: Lod = previous;
  if (lod === 0 && tilePx < LOD_CLOSE_PX * (1 - HYSTERESIS)) lod = 1;
  if (lod === 1 && tilePx < LOD_FIELD_PX * (1 - HYSTERESIS)) lod = 2;
  if (lod === 2 && tilePx >= LOD_FIELD_PX * (1 + HYSTERESIS)) lod = 1;
  if (lod === 1 && tilePx >= LOD_CLOSE_PX * (1 + HYSTERESIS)) lod = 0;
  return lod;
}

export interface TileWindow { i0: number; j0: number; i1: number; j1: number; stride: number; cols: number; rows: number }

/** Smallest power-of-two stride whose aligned window holds at most `budget` cells. */
export function fitWindow(i0: number, i1: number, j0: number, j1: number, budget = CELL_BUDGET): TileWindow {
  let stride = 1;
  for (;;) {
    const a0 = Math.floor(i0 / stride) * stride, b0 = Math.floor(j0 / stride) * stride;
    const cols = Math.ceil((i1 - a0 + 1) / stride), rows = Math.ceil((j1 - b0 + 1) / stride);
    if (cols * rows <= budget || stride >= 2 ** 40) return { i0: a0, j0: b0, i1, j1, stride, cols, rows };
    stride *= 2;
  }
}

/** The window of tile coordinates under the screen quad, cut down to the land that exists. Null: nothing to draw. */
export function viewWindow(quad: readonly THREE.Vector3[], bounds: Bounds | null, margin = 2, budget = CELL_BUDGET): TileWindow | null {
  if (!bounds) return null;
  const bx0 = Math.round(bounds.x0 + 0.5), bx1 = Math.round(bounds.x1 - 0.5), bz0 = Math.round(bounds.z0 + 0.5), bz1 = Math.round(bounds.z1 - 0.5);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of quad) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
  }
  if (x0 > x1) { x0 = bx0; x1 = bx1; z0 = bz0; z1 = bz1; }
  const i0 = Math.max(Math.floor(x0) - margin, bx0), i1 = Math.min(Math.ceil(x1) + margin, bx1);
  const j0 = Math.max(Math.floor(z0) - margin, bz0), j1 = Math.min(Math.ceil(z1) + margin, bz1);
  if (i1 < i0 || j1 < j0) return null;
  return fitWindow(i0, i1, j0, j1, budget);
}

/** Price lens colour: blue (0.5) through pale green (1) to orange (2), on a log scale. */
const LENS_LO = new THREE.Color(0x3b6fa8), LENS_MID = new THREE.Color(0xcfe0c8), LENS_HI = new THREE.Color(0xff8a2e);
export function lensColor(multiplier: number, out: THREE.Color): THREE.Color {
  const m = Number.isFinite(multiplier) ? multiplier : 1;
  const t = THREE.MathUtils.clamp((Math.log(Math.max(1e-6, m)) - Math.log(0.5)) / Math.log(4), 0, 1);
  return t < 0.5 ? out.copy(LENS_LO).lerp(LENS_MID, t * 2) : out.copy(LENS_MID).lerp(LENS_HI, (t - 0.5) * 2);
}

const GRASS = new THREE.Color(0x4e9a63), SOIL = new THREE.Color(0x6b4636), WET = new THREE.Color(0x45302a);
const PATH = new THREE.Color(0xd1b98a), YOUNG = new THREE.Color(0x5fae5a);
const CROP_NAMES: string[][] = CROPS.map((name) => [0, 1, 2, 3].map((stage) => `crop_${name}_s${stage}`));

function hash(i: number, j: number, k: number): number {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) + Math.imul(k, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const sameTile = (a: SnapshotTile, b: SnapshotTile): boolean =>
  a.tilled === b.tilled && a.crop === b.crop && a.stage === b.stage && a.moisture === b.moisture && a.nitrogen === b.nitrogen &&
  a.fatigue === b.fatigue && a.building === b.building && a.honey === b.honey;
const ripe = (t: SnapshotTile): boolean => t.crop >= 1 && t.crop < CROPS.length && Math.trunc(t.stage) >= 3;
const isPath = (t: SnapshotTile): boolean => t.x === 0 && t.y === 0;

interface Chunk { cx: number; cy: number; tiles: Map<string, SnapshotTile> }
interface Batch { model: AssetModel; name: string | null; meshes: THREE.InstancedMesh[]; capacity: number; count: number; owned: THREE.Material[] }
interface BatchOptions { name: string | null; cast: boolean; receive: boolean; sway?: boolean }

/** Merge small primitives (with a colour each) into one flat-shaded geometry. */
function merge(parts: { g: THREE.BufferGeometry; c: number; m: THREE.Matrix4 }[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  const c = new THREE.Color();
  for (const p of parts) {
    const g = p.g.index ? p.g.toNonIndexed() : p.g.clone();
    g.applyMatrix4(p.m); g.computeVertexNormals(); c.set(p.c);
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    for (let i = 0; i < P.length; i++) { pos.push(P[i]); nor.push(N[i]); }
    for (let i = 0; i < P.length / 3; i++) col.push(c.r, c.g, c.b);
    g.dispose(); p.g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

const pow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

export class FarmWorld {
  private scene: THREE.Scene;
  private models: (name: string) => AssetModel;
  private root = new THREE.Group();
  private overlayLayer: OverlayLayer;
  private chunks = new Map<string, Chunk>();
  private count = 0;
  private lastTiles: Snapshot['tiles'] | null = null;
  private version = 0;
  private _bounds: Bounds | null = null;
  private batches = new Map<string, Batch>();
  private lodState: Lod | null = null;
  private signature = '';
  private last: RefreshResult = { lod: 0, stride: 1, ripeInView: 0, cells: 0 };
  private swayOn: boolean;
  private motion: boolean;
  private time = { value: 0 };
  private sway = { value: 1 };
  // Scratch, reused so a refresh allocates nothing per tile.
  private vis: SnapshotTile[] = [];
  private near: Chunk[] = [];
  private cellRep: (SnapshotTile | null)[] = [];
  private cellRank = new Uint8Array(0);
  private need = new Map<string, number>();
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private color2 = new THREE.Color();
  private white = new THREE.Color(1, 1, 1);
  // Own models for the helpers that are not GLBs.
  private cellModel: AssetModel; private furrowModel: AssetModel; private tuftModel: AssetModel; private padModel: AssetModel;
  /** Diagnostics for the renderer tests and data attributes. */
  debug = { tileColors: [] as { x: number; y: number; color: string }[], overlayColors: [] as { x: number; y: number; color: string }[], modelInstances: {} as Record<string, number> };

  constructor(scene: THREE.Scene, models: (name: string) => AssetModel) {
    this.scene = scene;
    this.models = models;
    this.motion = !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.swayOn = this.motion;
    this.sway.value = this.swayOn ? 1 : 0;
    this.scene.add(this.root);
    this.overlayLayer = new OverlayLayer(scene);
    const std = (o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true, ...o });
    const M = (x = 0, y = 0, z = 0, rx = 0, rz = 0): THREE.Matrix4 => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, rz)), new THREE.Vector3(1, 1, 1));
    this.cellModel = { parts: [{ geometry: new THREE.BoxGeometry(0.94, 0.3, 0.94).translate(0, -0.15, 0), material: std({}) }] };
    this.furrowModel = { parts: [{ geometry: merge([-1, 0, 1].map((r) => ({ g: new THREE.BoxGeometry(0.84, 0.05, 0.1), c: 0xffffff, m: M(0, 0.025, r * 0.28) }))), material: std({ color: 0x8a5c45, roughness: 0.95 }) }] };
    this.tuftModel = { parts: [{ geometry: merge([0, 1, 2].map((k) => ({ g: new THREE.ConeGeometry(0.04, 0.2, 3), c: 0x7ccd86, m: M(Math.cos(k * 2.1) * 0.05, 0.1, Math.sin(k * 2.1) * 0.05, Math.sin(k * 2.1) * 0.3, -Math.cos(k * 2.1) * 0.3) }))), material: std({ vertexColors: true, roughness: 0.9 }) }] };
    this.padModel = { parts: [{ geometry: new THREE.BoxGeometry(0.88, 0.014, 0.88).translate(0, 0.008, 0), material: new THREE.MeshBasicMaterial({}) }] };
  }

  /** The soil-lens colour mesh, read by the renderer tests. */
  get overlayMesh(): THREE.InstancedMesh | null { return this.overlayLayer.mesh; }
  get bounds(): Bounds | null { return this._bounds; }
  get tileCount(): number { return this.count; }
  /** Live instance batches by model name (renderer tests and diagnostics only). */
  get debugBatches(): ReadonlyMap<string, { meshes: THREE.InstancedMesh[]; model: AssetModel; count: number }> { return this.batches; }

  setSway(on: boolean): void { this.swayOn = on; this.sway.value = on ? 1 : 0; }

  /** Force the next refresh to rebuild (e.g. when a model was replaced). */
  invalidate(): void { this.version++; }

  private chunkAt(x: number, y: number): Chunk | undefined { return this.chunks.get(`${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`); }

  tileAt(x: number, y: number): SnapshotTile | undefined { return this.chunkAt(x, y)?.tiles.get(`${x},${y}`); }

  forEachChunk(fn: (cx: number, cy: number, tiles: ReadonlyMap<string, SnapshotTile>) => void): void {
    for (const chunk of this.chunks.values()) fn(chunk.cx, chunk.cy, chunk.tiles);
  }

  /** Merge a snapshot into the sparse store. Unchanged tiles keep their identity and cost one comparison. */
  setSnapshot(snapshot: Snapshot): void {
    const tiles = snapshot.tiles;
    if (tiles === this.lastTiles) return;
    this.lastTiles = tiles;
    let changed = false, structural = false;
    for (const tile of tiles) {
      const cx = Math.floor(tile.x / CHUNK), cy = Math.floor(tile.y / CHUNK);
      const ck = `${cx},${cy}`;
      let chunk = this.chunks.get(ck);
      if (!chunk) { chunk = { cx, cy, tiles: new Map() }; this.chunks.set(ck, chunk); }
      const k = `${tile.x},${tile.y}`;
      const old = chunk.tiles.get(k);
      if (!old) { chunk.tiles.set(k, tile); this.count++; changed = structural = true; }
      else if (!sameTile(old, tile)) { chunk.tiles.set(k, tile); changed = true; }
    }
    if (this.count !== tiles.length) {
      // Tiles disappeared (new game, shrunken farm): sweep what the snapshot no longer has.
      const keep = new Set<string>();
      for (const tile of tiles) keep.add(`${tile.x},${tile.y}`);
      for (const [ck, chunk] of this.chunks) {
        for (const k of chunk.tiles.keys()) if (!keep.has(k)) { chunk.tiles.delete(k); this.count--; }
        if (!chunk.tiles.size) this.chunks.delete(ck);
      }
      changed = structural = true;
    }
    if (structural) this._bounds = this.computeBounds();
    if (changed) this.version++;
  }

  private computeBounds(): Bounds | null {
    if (!this.count) return null;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const chunk of this.chunks.values()) for (const t of chunk.tiles.values()) {
      if (t.x < x0) x0 = t.x; if (t.x > x1) x1 = t.x; if (t.y < z0) z0 = t.y; if (t.y > z1) z1 = t.y;
    }
    return { x0: x0 - 0.5, x1: x1 + 0.5, z0: z0 - 0.5, z1: z1 + 0.5 };
  }

  // ---------------------------------------------------------------- batches

  private dropBatch(key: string, batch: Batch): void {
    for (const mesh of batch.meshes) { this.root.remove(mesh); mesh.dispose(); }
    for (const material of batch.owned) material.dispose();
    this.batches.delete(key);
  }

  private swayMaterial(source: THREE.Material): THREE.Material {
    const material = source.clone();
    const prior = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      prior.call(material, shader, renderer);
      shader.uniforms.uTime = this.time; shader.uniforms.uSway = this.sway;
      shader.vertexShader = `uniform float uTime;\nuniform float uSway;\n${shader.vertexShader}`.replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
float swayPhase = instanceMatrix[3].x * 0.9 + instanceMatrix[3].z * 0.6;
transformed.x += sin(uTime * 1.7 + swayPhase) * 0.07 * position.y * uSway;
transformed.z += cos(uTime * 1.3 + swayPhase) * 0.04 * position.y * uSway;
#endif`);
    };
    material.customProgramCacheKey = () => 'farm-sway';
    return material;
  }

  /** A batch with room for `need` instances, rebuilt when the model changed or it is too small. Null when need is 0. */
  private batchFor(key: string, model: AssetModel, need: number, o: BatchOptions): Batch | null {
    let batch = this.batches.get(key);
    if (batch && (batch.model !== model || batch.capacity < need)) { this.dropBatch(key, batch); batch = undefined; }
    if (!batch) {
      if (need <= 0) return null;
      const capacity = Math.min(MAX_INSTANCES, Math.max(64, pow2(need)));
      const owned: THREE.Material[] = [];
      const meshes = model.parts.map((source: AssetPart) => {
        let material = source.material;
        if (o.sway) {
          material = Array.isArray(material) ? material.map((m) => this.swayMaterial(m)) : this.swayMaterial(material);
          owned.push(...(Array.isArray(material) ? material : [material]));
        }
        const mesh = new THREE.InstancedMesh(source.geometry, material, capacity);
        mesh.name = key;
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = o.cast; mesh.receiveShadow = o.receive;
        this.root.add(mesh);
        return mesh;
      });
      batch = { model, name: o.name, meshes, capacity, count: 0, owned };
      this.batches.set(key, batch);
    }
    return batch;
  }

  private put(batch: Batch, color?: THREE.Color): void {
    if (batch.count >= batch.capacity) return;
    const matrix = this.dummy.matrix;
    for (const mesh of batch.meshes) {
      mesh.setMatrixAt(batch.count, matrix);
      if (color) mesh.setColorAt(batch.count, color);
    }
    batch.count++;
  }

  private place(batch: Batch | null, x: number, y: number, z: number, yaw: number, scale: number, scaleX = scale, scaleZ = scale, color?: THREE.Color): void {
    if (!batch) return;
    const d = this.dummy;
    d.position.set(x, y, z); d.rotation.set(0, yaw, 0); d.scale.set(scaleX, scale, scaleZ); d.updateMatrix();
    this.put(batch, color);
  }

  private flush(): void {
    for (const batch of this.batches.values()) for (const mesh of batch.meshes) {
      mesh.count = batch.count;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, batch.count * 16);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- gathering

  /** Stored chunks that touch the window: walk the window's chunk grid or the store, whichever is smaller. */
  private chunksIn(w: TileWindow): number {
    this.near.length = 0;
    const cx0 = Math.floor(w.i0 / CHUNK), cx1 = Math.floor(w.i1 / CHUNK), cy0 = Math.floor(w.j0 / CHUNK), cy1 = Math.floor(w.j1 / CHUNK);
    let tiles = 0;
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) <= this.chunks.size) {
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const chunk = this.chunks.get(`${cx},${cy}`);
        if (chunk) { this.near.push(chunk); tiles += chunk.tiles.size; }
      }
    } else {
      for (const chunk of this.chunks.values()) {
        if (chunk.cx >= cx0 && chunk.cx <= cx1 && chunk.cy >= cy0 && chunk.cy <= cy1) { this.near.push(chunk); tiles += chunk.tiles.size; }
      }
    }
    return tiles;
  }

  // ---------------------------------------------------------------- refresh

  refresh(view: WorldView, o: RefreshOptions): RefreshResult {
    this.time.value = view.time;
    const lod = this.lodState = lodFor(view.tilePx, this.lodState);
    const mult = o.priceMultipliers;
    const win = viewWindow(view.quad, this._bounds);
    const stride = win?.stride ?? 1;
    const cellMode = lod === 2 || stride > 1;
    const pulse = this.motion && (cellMode || mult) ? Math.floor(view.time * 8) : 0;
    const signature = `${this.version}|${win ? `${win.i0},${win.j0},${win.i1},${win.j1},${stride}` : '-'}|${lod}|${o.overlay}|${mult ? mult.join(',') : ''}|${pulse}`;
    if (signature === this.signature && !this.modelsChanged()) return this.last;
    this.signature = signature;
    for (const batch of this.batches.values()) batch.count = 0;
    this.debug.tileColors = [];
    if (!win) {
      this.vis.length = 0;
      this.debug.overlayColors = this.overlayLayer.update(this.vis, 'none', false);
      this.flush();
      return this.last = { lod, stride: 1, ripeInView: 0, cells: 0 };
    }
    const result = cellMode ? this.drawCells(win, lod, o, view.time) : this.drawDetail(win, lod, o, view.time);
    this.flush();
    this.debug.modelInstances = Object.fromEntries([...this.batches].filter(([, b]) => b.count > 0).map(([k, b]) => [k, b.count]));
    return this.last = result;
  }

  /** True when a model the world is drawing has since been replaced (GLB arrived). */
  private modelsChanged(): boolean {
    for (const batch of this.batches.values()) if (batch.name && this.models(batch.name) !== batch.model) return true;
    return false;
  }

  private modelBatch(name: string, need: number, cast: boolean, sway = false): Batch | null {
    return this.batchFor(name, this.models(name), need, { name, cast, receive: true, sway });
  }

  private ownBatch(key: string, model: AssetModel, need: number, cast: boolean): Batch | null {
    return this.batchFor(key, model, need, { name: null, cast, receive: true });
  }

  /** Close and Field zoom at stride 1: real tile and prop models, furrows and tufts (Close), crops. */
  private drawDetail(win: TileWindow, lod: Lod, o: RefreshOptions, time: number): RefreshResult {
    const vis = this.vis; vis.length = 0;
    this.chunksIn(win);
    let ripeInView = 0;
    for (const chunk of this.near) for (const t of chunk.tiles.values()) {
      if (t.x < win.i0 || t.x > win.i1 || t.y < win.j0 || t.y > win.j1) continue;
      if (vis.length < MAX_INSTANCES) vis.push(t);
      if (ripe(t)) ripeInView++;
    }
    const mult = o.priceMultipliers, close = lod === 0;
    const need = this.need; need.clear();
    const add = (name: string): void => { need.set(name, (need.get(name) ?? 0) + 1); };
    for (const t of vis) {
      add(isPath(t) ? 'tile_path' : t.tilled ? 'tile_soil' : 'tile_grass');
      if (t.crop >= 1 && t.crop < CROPS.length) add(CROP_NAMES[t.crop][THREE.MathUtils.clamp(Math.trunc(t.stage), 0, 3)]);
      const building = BUILDING_MODELS[t.building];
      if (building) add(building);
      if (t.building === 1 && t.honey > 0) add('item_honey');
      if (close && !isPath(t)) add(t.tilled ? '~furrow' : '~tuft');
      if (mult && ripe(t)) add('~pad');
    }
    const barn = this.tileAt(0, 0) && vis.some(isPath) ? 1 : 0;
    if (barn) add('prop_barn');
    const batches = new Map<string, Batch | null>();
    const batch = (name: string): Batch | null => {
      let b = batches.get(name);
      if (b === undefined) {
        const n = need.get(name) ?? 0;
        b = name === '~furrow' ? this.ownBatch(name, this.furrowModel, n, false)
          : name === '~tuft' ? this.ownBatch(name, this.tuftModel, n, false)
          : name === '~pad' ? this.ownBatch(name, this.padModel, n, false)
          : this.modelBatch(name, n, !name.startsWith('tile_'), name.startsWith('crop_'));
        batches.set(name, b);
      }
      return b;
    };
    const c = this.color, dim = this.color2;
    for (const t of vis) {
      const ripeNow = ripe(t);
      const dimmed = mult ? (ripeNow ? 1 : 0.55) : 1;
      const terrain = isPath(t) ? 'tile_path' : t.tilled ? 'tile_soil' : 'tile_grass';
      // Moisture is an integer percentage (0..100).
      c.setScalar((1 - 0.32 * unit(t.moisture)) * dimmed);
      if (this.debug.tileColors.length < 16) this.debug.tileColors.push({ x: t.x, y: t.y, color: c.getHexString() });
      this.place(batch(terrain), t.x, 0, t.y, 0, 1, 1, 1, c);
      dim.setScalar(dimmed);
      if (t.crop >= 1 && t.crop < CROPS.length) {
        const stage = THREE.MathUtils.clamp(Math.trunc(t.stage), 0, 3);
        const s = 0.94 + hash(t.x, t.y, 5) * 0.12;
        this.place(batch(CROP_NAMES[t.crop][stage]), t.x + (hash(t.x, t.y, 7) - 0.5) * 0.08, 0, t.y + (hash(t.x, t.y, 8) - 0.5) * 0.08, hash(t.x, t.y, 6) * Math.PI * 2, s, s, s, dim);
        if (mult && ripeNow) {
          lensColor(mult[t.crop] ?? 1, c).multiplyScalar(1 + (this.motion ? 0.15 * Math.sin(time * 4 + t.x + t.y) : 0));
          this.place(batch('~pad'), t.x, 0, t.y, 0, 1, 1, 1, c);
        }
      }
      const building = BUILDING_MODELS[t.building];
      if (building) this.place(batch(building), t.x, 0, t.y, ((t.x * 7 + t.y * 3) % 4 + 4) % 4 * (Math.PI / 2), 1, 1, 1, dim);
      if (t.building === 1 && t.honey > 0) this.place(batch('item_honey'), t.x + 0.18, 0.46, t.y + 0.18, 0, 1, 1, 1, dim);
      if (close && !isPath(t)) {
        if (t.tilled) this.place(batch('~furrow'), t.x, 0, t.y, 0, 1, 1, 1, dim);
        else this.place(batch('~tuft'), t.x + (hash(t.x, t.y, 9) - 0.5) * 0.5, 0, t.y + (hash(t.x, t.y, 10) - 0.5) * 0.5, hash(t.x, t.y, 11) * 6, 0.8 + hash(t.x, t.y, 12) * 0.6, 0.8 + hash(t.x, t.y, 12) * 0.6, 0.8 + hash(t.x, t.y, 12) * 0.6, dim);
      }
    }
    if (barn) this.place(batch('prop_barn'), 0, 0, 0, 0, 1);
    this.debug.overlayColors = this.overlayLayer.update(vis, o.overlay, true);
    return { lod, stride: 1, ripeInView, cells: vis.length };
  }

  /** Map zoom or a merged window: one coloured cell per block of `stride` x `stride` tiles. */
  private drawCells(win: TileWindow, lod: Lod, o: RefreshOptions, time: number): RefreshResult {
    const { stride, cols, rows } = win;
    const total = cols * rows;
    const rep = this.cellRep, rank = this.cellRank.length >= total ? this.cellRank : (this.cellRank = new Uint8Array(pow2(total)));
    if (rep.length < total) rep.length = total;
    rank.fill(0, 0, total);
    for (let i = 0; i < total; i++) rep[i] = null;
    let ripeInView = 0;
    const tilesUnder = this.chunksIn(win);
    const rankOf = (t: SnapshotTile): number => t.crop >= 1 && t.crop < CROPS.length ? (ripe(t) ? 6 : 4) : t.tilled ? 2 : 1;
    const take = (t: SnapshotTile): void => {
      if (t.x < win.i0 || t.x > win.i1 || t.y < win.j0 || t.y > win.j1) return;
      const k = Math.floor((t.y - win.j0) / stride) * cols + Math.floor((t.x - win.i0) / stride);
      const r = rankOf(t);
      if (r > rank[k]) { rank[k] = r; rep[k] = t; }
      if (ripe(t)) ripeInView++;
    };
    if (stride === 1 || tilesUnder <= SAMPLE_LIMIT) {
      for (const chunk of this.near) for (const t of chunk.tiles.values()) take(t);
    } else {
      // A huge dense farm under a merged window: one sample per cell (the cell centre), like a mip level.
      const half = stride >> 1;
      for (let cj = 0; cj < rows; cj++) for (let ci = 0; ci < cols; ci++) {
        const t = this.tileAt(Math.min(win.i1, win.i0 + ci * stride + half), Math.min(win.j1, win.j0 + cj * stride + half));
        if (t) take(t);
      }
    }
    const cells = this.ownBatch('~cell', this.cellModel, Math.min(MAX_INSTANCES, total), false);
    const mult = o.priceMultipliers, c = this.color, c2 = this.color2;
    const pulse = this.motion ? 1 : 0;
    const scaleXZ = stride > 1 ? stride * 1.03 / 0.94 : 1;
    let drawn = 0;
    for (let k = 0; k < total && drawn < MAX_INSTANCES; k++) {
      const t = rep[k];
      if (!t) continue;
      const ci = k % cols, cj = (k - ci) / cols;
      const i = win.i0 + ci * stride, j = win.j0 + cj * stride;
      if (stride === 1 && isPath(t)) c.copy(PATH);
      else if (t.tilled) c.copy(SOIL).lerp(WET, unit(t.moisture) * 0.7);
      else c.copy(GRASS);
      c.multiplyScalar(0.93 + hash(i, j, 4) * 0.12);
      if (o.overlay !== 'none') overlayColor(o.overlay, t, c);
      const hasCrop = t.crop >= 1 && t.crop < CROPS.length;
      if (hasCrop) {
        const s = THREE.MathUtils.clamp(Math.trunc(t.stage), 0, 3), isRipe = s >= 3;
        if (mult) {
          if (isRipe) lensColor(mult[t.crop] ?? 1, c).multiplyScalar(1 + 0.15 * pulse * Math.sin(time * 4 + i + j));
          else c.multiplyScalar(0.55);
        } else if (o.overlay === 'none') {
          c.copy(YOUNG).multiplyScalar(0.7).lerp(c2.setHex(CROP_COLORS[t.crop] ?? 0xe6c34a), (s / 3) ** 2);
          if (isRipe) c.multiplyScalar(1.12 + 0.2 * pulse * Math.sin(time * 4 + i + j));
        }
      } else if (mult) c.multiplyScalar(0.55);
      if (this.debug.tileColors.length < 16) this.debug.tileColors.push({ x: t.x, y: t.y, color: c.getHexString() });
      this.place(cells, i + (stride - 1) / 2, 0, j + (stride - 1) / 2, 0, 1, scaleXZ, scaleXZ, c);
      drawn++;
    }
    this.vis.length = 0;
    this.debug.overlayColors = this.overlayLayer.update(this.vis, 'none', false);
    return { lod, stride, ripeInView, cells: drawn };
  }

  dispose(): void {
    for (const [key, batch] of [...this.batches]) this.dropBatch(key, batch);
    for (const model of [this.cellModel, this.furrowModel, this.tuftModel, this.padModel]) {
      for (const part of model.parts) {
        part.geometry.dispose();
        for (const m of Array.isArray(part.material) ? part.material : [part.material]) m.dispose();
      }
    }
    this.overlayLayer.dispose();
    this.scene.remove(this.root);
    this.chunks.clear(); this.count = 0; this._bounds = null;
  }
}

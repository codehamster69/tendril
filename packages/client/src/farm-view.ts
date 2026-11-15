import * as THREE from 'three';
import { AssetLoader, disposeModels, type AssetModel, type AssetPart, type AssetStatus } from './asset-loader';
import type { Snapshot } from './sim-types';
import { BUILDING_MODELS, CROPS, CROP_COLORS, fallbackModel, ITEM_NAMES, matte } from './fallback-models';
import { OverlayLayer, unit, type FarmOverlay } from './farm-overlay';
import { createIsland, tileBounds, type Bounds, type Island, type Placement } from './farm-scenery';
import { CameraRig, type RigPose } from './farm-camera';
import { FarmFx } from './farm-fx';
import { FarmMinimap } from './farm-minimap';
import { MarketCard, type MarketTableInput } from './farm-market';
export type { FarmOverlay };
type Tile = Snapshot['tiles'][number];
type Batch = { model: AssetModel; meshes: THREE.InstancedMesh[]; capacity: number; count: number };
const SKY = { clear: 0xb9d5de, rain: 0x80969e, frost: 0xdce8ec };
const key = (x: number, y: number): string => `${x},${y}`;
/** Vine-trail and minimap colour per drone, cycling. */
const TRAIL = [0x8fe3b0, 0xffd68a, 0x9ec7ff, 0xffa8c2];

type PresetName = 'gold' | 'noon' | 'dawn' | 'night';
interface Preset {
  sun: number; sunI: number; sunDir: [number, number, number];
  hemiSky: number; hemiGround: number; hemiI: number;
  top: string; mid: string; bottom: string; fog: number; exposure: number; glow: number;
}
const PRESETS: Record<PresetName, Preset> = {
  gold: { sun: 0xffc87a, sunI: 2.6, sunDir: [-16, 10, 8], hemiSky: 0xffe7c2, hemiGround: 0x4a5a3c, hemiI: 0.9, top: '#243c5e', mid: '#d98f4e', bottom: '#f4d7a4', fog: 0xc98f5a, exposure: 1, glow: 1.15 },
  noon: { sun: 0xfff4e0, sunI: 2.3, sunDir: [-12, 24, 10], hemiSky: 0xdcefff, hemiGround: 0x65754c, hemiI: 1.3, top: '#4d84c4', mid: '#9cc4e4', bottom: '#d7e8ef', fog: 0xb4d2e2, exposure: 0.95, glow: 0.7 },
  dawn: { sun: 0xff9e7a, sunI: 1.7, sunDir: [-20, 6, 4], hemiSky: 0xb8c8e8, hemiGround: 0x3f4a3c, hemiI: 0.7, top: '#1d2a4a', mid: '#8a5a72', bottom: '#e8a07a', fog: 0x86687c, exposure: 0.9, glow: 1 },
  night: { sun: 0x8ab4ff, sunI: 0.55, sunDir: [-10, 18, -6], hemiSky: 0x223355, hemiGround: 0x111a22, hemiI: 0.35, top: '#05080f', mid: '#0d1830', bottom: '#1a2740', fog: 0x0d1526, exposure: 0.85, glow: 1.5 },
};
const skyTexture = (preset: Preset): THREE.CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = 8; canvas.height = 256;
  const context = canvas.getContext('2d')!;
  const gradient = context.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, preset.top);
  gradient.addColorStop(0.55, preset.mid);
  gradient.addColorStop(1, preset.bottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 8, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

export class FarmView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
  private rig: CameraRig;
  private sun = new THREE.DirectionalLight(0xffc87a, 2.6);
  private hemi = new THREE.HemisphereLight(0xffe7c2, 0x4a5a3c, 0.9);
  private sunDir = new THREE.Vector3(...PRESETS.gold.sunDir);
  private shadowAnchor = { x: NaN, z: NaN, half: 0 };
  private preset: PresetName = 'gold';
  private sky: THREE.CanvasTexture | null = null;
  private loader: AssetLoader;
  private fallbacks = new Map<string, AssetModel>();
  private batches = new Map<string, Batch>();
  private island: Island;
  private fx: FarmFx;
  private minimap!: FarmMinimap | null;
  private market!: MarketCard;
  private followButton: HTMLButtonElement | null = null;
  private followIndex = -1;
  private cleanups: (() => void)[] = [];
  private latest: Snapshot | null = null;
  private tileLookup = new Map<string, Tile>();
  private terrainSignature = '';
  private carriedNames: string[] = [];
  private botPositions: THREE.Vector3[] = [];
  private botTargets: THREE.Vector3[] = [];
  private botAngles: number[] = [];
  private lastOps: (number | null)[] = [];
  private lod = 0;
  private botScale = 1;
  private furrows: THREE.InstancedMesh;
  private tufts: THREE.InstancedMesh;
  private overlay: FarmOverlay = 'none';
  private overlayLayer: OverlayLayer;
  /** Read by the renderer tests. */
  get overlayMesh(): THREE.InstancedMesh | null { return this.overlayLayer.mesh; }
  private selectedTile: { x: number; y: number } | null = null;
  private selectedBot: number | null = null;
  private tileRing = new THREE.Mesh(new THREE.RingGeometry(0.47 * Math.SQRT2, 0.51 * Math.SQRT2, 4).rotateZ(Math.PI / 4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffedb4, depthWrite: false }));
  private botRing = new THREE.Mesh(new THREE.TorusGeometry(0.37, 0.025, 4, 24).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd66a }));
  private weatherTint = new THREE.Color(SKY.clear);
  private framed = false;
  /** Plot count at the last update, to notice when land is bought. */
  private plotCount = 0;
  /** Rig pose right after the last automatic framing; any difference later means the user moved the camera. */
  private autoPose: RigPose | null = null;
  private reframe: { from: RigPose; to: RigPose; start: number } | null = null;
  private published = { tx: NaN, tz: NaN, px: NaN, py: NaN, pz: NaN };
  private nextMinimap = 0;
  private disposed = false;
  private raf = 0;
  private previousTime = 0;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private cropTint = new THREE.Color();
  private ro: ResizeObserver;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = PRESETS.gold.exposure;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.fog = new THREE.Fog(PRESETS.gold.fog, 55, 150);
    this.scene.add(this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.bias = -0.0002;
    this.scene.add(this.sun, this.sun.target);
    this.island = createIsland(this.scene);
    this.fx = new FarmFx(this.scene);
    this.fx.setGlow(PRESETS.gold.glow);
    this.scene.add(this.tileRing, this.botRing);
    this.tileRing.visible = this.botRing.visible = false;
    this.furrows = new THREE.InstancedMesh(new THREE.BoxGeometry(0.86, 0.04, 0.07).translate(0, 0.02, 0), matte(0x46301f), 6144);
    this.tufts = new THREE.InstancedMesh(new THREE.ConeGeometry(0.05, 0.18, 4).translate(0, 0.09, 0), matte(0x7d9c58), 4096);
    for (const detail of [this.furrows, this.tufts]) {
      detail.count = 0;
      detail.visible = false;
      detail.frustumCulled = false;
      detail.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      detail.receiveShadow = true;
      this.scene.add(detail);
    }
    this.sky = skyTexture(PRESETS.gold);
    this.scene.background = this.sky;
    this.rig = new CameraRig(this.camera, canvas, {
      reduced: () => this.reducedMotion.matches,
      onClick: this.clickAt,
      onCycleFollow: this.cycleFollow,
      onFit: this.focusFarm,
      onUserInput: this.userMoved,
      onPose: this.cameraStatus,
    });
    this.rig.attach();
    this.wireStage();
    this.overlayLayer = new OverlayLayer(this.scene);
    this.loader = new AssetLoader(this.assetsChanged);
    this.ro = new ResizeObserver(this.resize);
    this.ro.observe(canvas.parentElement ?? canvas);
    window.addEventListener('resize', this.resize);
    canvas.tabIndex = 0;
    canvas.addEventListener('keydown', this.keyDown);
    canvas.dataset.overlay = 'none';
    canvas.dataset.modelsLoaded = '0';
    canvas.dataset.sceneReady = 'false';
    canvas.dataset.followBot = '-1';
    this.resize();
    void this.loader.load();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Stage-bar buttons, light select, minimap and market pill live in #farm-stage; other hosts (replay panes, duels) simply have none. */
  private wireStage(): void {
    const stage = this.canvas.closest('#farm-stage');
    this.market = new MarketCard((stage?.querySelector('#market-card') as HTMLElement | null) ?? null);
    const minimap = stage?.querySelector<HTMLCanvasElement>('#farm-minimap') ?? null;
    this.minimap = minimap ? new FarmMinimap(minimap, this.navigateTo) : null;
    const light = stage?.querySelector<HTMLSelectElement>('#light-preset') ?? null;
    if (light) {
      light.value = this.preset;
      this.listen(light, 'change', () => this.setPreset(light.value));
    }
    const fit = stage?.querySelector('#btn-fit') ?? null;
    if (fit) this.listen(fit, 'click', this.focusFarm);
    this.followButton = (stage?.querySelector('#btn-follow') as HTMLButtonElement | null) ?? null;
    if (this.followButton) this.listen(this.followButton, 'click', this.cycleFollow);
    const rotL = stage?.querySelector('#btn-rot-l') ?? null;
    const rotR = stage?.querySelector('#btn-rot-r') ?? null;
    if (rotL) this.listen(rotL, 'click', () => { this.userMoved(); this.rig.rotate(Math.PI / 2); });
    if (rotR) this.listen(rotR, 'click', () => { this.userMoved(); this.rig.rotate(-Math.PI / 2); });
  }

  private listen(target: EventTarget, type: string, handler: EventListenerOrEventListenerObject): void {
    target.addEventListener(type, handler);
    this.cleanups.push(() => target.removeEventListener(type, handler));
  }

  /** Time-of-day light: sun, sky gradient, hemisphere, fog and exposure together. */
  setPreset(name: string): void {
    this.preset = name in PRESETS ? name as PresetName : 'gold';
    const preset = PRESETS[this.preset];
    this.sun.color.set(preset.sun);
    this.sun.intensity = preset.sunI;
    this.sunDir.set(...preset.sunDir);
    this.shadowAnchor = { x: NaN, z: NaN, half: 0 };
    this.hemi.color.set(preset.hemiSky);
    this.hemi.groundColor.set(preset.hemiGround);
    this.hemi.intensity = preset.hemiI;
    this.renderer.toneMappingExposure = preset.exposure;
    this.sky?.dispose();
    this.sky = skyTexture(preset);
    this.scene.background = this.sky;
    this.fx.setGlow(preset.glow);
    this.applyFog();
  }

  /** Rules v4 market table for the pill; before MARKET_EPOCH the countdown needs nothing. */
  setMarketTable(table: MarketTableInput | null): void { this.market.setTable(table); }

  /** Ground point under a client-space cursor, for tests and tooling. */
  groundAtClient(clientX: number, clientY: number): { x: number; z: number } | null {
    const hit = this.rig.groundAtClient(clientX, clientY, new THREE.Vector3());
    return hit ? { x: hit.x, z: hit.z } : null;
  }

  private applyFog(): void {
    const fog = this.scene.fog as THREE.Fog;
    fog.color.set(PRESETS[this.preset].fog).lerp(this.weatherTint, 0.35);
  }

  private assetsChanged = (status: AssetStatus): void => {
    if (this.disposed) return;
    this.canvas.dataset.modelsLoaded = String(status.loaded);
    this.canvas.dataset.modelsStatus = status.state;
    this.canvas.dataset.modelsErrors = status.errors.join('; ');
    this.canvas.dataset.modelsAssets = JSON.stringify([...this.loader.models.keys()].sort());
    if (this.latest) this.update(this.latest);
    this.canvas.dispatchEvent(new CustomEvent('tendril:models', { detail: status, bubbles: true }));
  };

  private fallback(name: string): AssetModel {
    let model = this.fallbacks.get(name);
    if (!model) { model = fallbackModel(name); this.fallbacks.set(name, model); }
    return model;
  }

  private batch(name: string, capacity: number, id = name): Batch {
    const model = this.loader.models.get(name) ?? this.fallback(name);
    let batch = this.batches.get(id);
    if (batch && (batch.model !== model || capacity > batch.capacity)) {
      for (const mesh of batch.meshes) { this.scene.remove(mesh); mesh.dispose(); }
      if (batch.model !== model && this.fallbacks.get(name) === batch.model) {
        disposeModels([batch.model]);
        this.fallbacks.delete(name);
      }
      this.batches.delete(id);
      batch = undefined;
    }
    if (!batch) {
      const cap = Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, capacity))));
      const meshes = model.parts.map((source) => {
        const mesh = new THREE.InstancedMesh(source.geometry, source.material, cap);
        mesh.name = name;
        mesh.count = 0;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = !name.startsWith('tile_');
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        return mesh;
      });
      batch = { model, meshes, capacity: cap, count: 0 };
      this.batches.set(id, batch);
    }
    return batch;
  }

  private place(batch: Batch, position: Placement, color?: THREE.Color, height = 0): void {
    this.dummy.position.set(position.x, height, position.z);
    this.dummy.rotation.set(0, position.rotation ?? 0, 0);
    this.dummy.scale.setScalar(position.scale ?? 1);
    if (position.depth !== undefined) this.dummy.scale.z *= position.depth;
    this.dummy.updateMatrix();
    for (const mesh of batch.meshes) {
      mesh.setMatrixAt(batch.count, this.dummy.matrix);
      if (color) mesh.setColorAt(batch.count, color);
    }
    batch.count++;
  }

  private finish(batch: Batch): void {
    for (const mesh of batch.meshes) {
      mesh.count = batch.count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** Level of detail by pixels per tile, with 10 percent hysteresis around each threshold so zooming never flickers. */
  private lodAt(px: number): number {
    const edge = (threshold: number, level: number): number => threshold * (this.lod > level ? 1.1 : this.lod < level ? 0.9 : 1);
    return px >= edge(28, 0) ? 0 : px >= edge(10, 1) ? 1 : 2;
  }

  update(snapshot: Snapshot): void {
    if (this.disposed) return;
    this.latest = snapshot;
    this.weatherTint.set(SKY[snapshot.weather]);
    this.applyFog();
    this.tileLookup = new Map(snapshot.tiles.map((tile) => [key(tile.x, tile.y), tile]));
    const signature = snapshot.tiles.map((tile) => key(tile.x, tile.y)).join(';');
    if (signature !== this.terrainSignature) { this.terrainSignature = signature; this.applyBounds(snapshot); }
    this.lod = this.lodAt(this.rig.tilePx());
    this.fx.setLod(this.lod);
    this.botScale = this.lod === 2 ? THREE.MathUtils.clamp(this.rig.cur.dist / 18, 1, 2.4) : 1;
    for (const batch of this.batches.values()) batch.count = 0;
    const required = new Map<string, number>();
    for (const tile of snapshot.tiles) {
      const terrain = tile.x === 0 && tile.y === 0 ? 'tile_path' : tile.tilled ? 'tile_soil' : 'tile_grass';
      required.set(terrain, (required.get(terrain) ?? 0) + 1);
      if (tile.crop >= 1 && tile.crop < CROPS.length) {
        const crop = `crop_${CROPS[tile.crop]}_s${THREE.MathUtils.clamp(Math.trunc(tile.stage), 0, 3)}`;
        required.set(crop, (required.get(crop) ?? 0) + 1);
      }
      const building = BUILDING_MODELS[tile.building];
      if (building) required.set(building, (required.get(building) ?? 0) + 1);
      if (tile.building === 1 && tile.honey > 0) required.set('item_honey', (required.get('item_honey') ?? 0) + 1);
    }
    const colors: { x: number; y: number; color: string }[] = [];
    for (const tile of snapshot.tiles) {
      const terrain = tile.x === 0 && tile.y === 0 ? 'tile_path' : tile.tilled ? 'tile_soil' : 'tile_grass';
      // Moisture is an integer percentage, NOT a 0..1 value. Modulate the source palette.
      this.color.setScalar(1 - 0.32 * unit(tile.moisture));
      // Map distance: crops hide and their colour melts into the tile instead.
      if (this.lod === 2 && tile.crop >= 1 && CROP_COLORS[tile.crop] !== undefined) this.color.copy(this.cropTint.setHex(CROP_COLORS[tile.crop]!)).multiplyScalar(tile.stage >= 3 ? 2.8 : 1.9);
      this.place(this.batch(terrain, required.get(terrain)!), { x: tile.x, z: tile.y }, this.color);
      if (colors.length < 16) colors.push({ x: tile.x, y: tile.y, color: this.color.getHexString() });
      if (tile.crop >= 1 && tile.crop < CROPS.length) {
        const stage = THREE.MathUtils.clamp(Math.trunc(tile.stage), 0, 3);
        const crop = `crop_${CROPS[tile.crop]}_s${stage}`;
        this.place(this.batch(crop, required.get(crop)!), { x: tile.x, z: tile.y });
      }
      const building = BUILDING_MODELS[tile.building];
      if (building) this.place(this.batch(building, required.get(building)!), { x: tile.x, z: tile.y, rotation: (tile.x * 7 + tile.y * 3) % 4 * (Math.PI / 2) });
      // Honey waiting in a hive sits on top of it.
      if (tile.building === 1 && tile.honey > 0) this.place(this.batch('item_honey', required.get('item_honey')!), { x: tile.x + 0.18, z: tile.y + 0.18 }, undefined, 0.46);
    }
    if (this.tileLookup.has('0,0')) this.place(this.batch('prop_barn', 1), { x: 0, z: 0 });
    for (const [name, batch] of this.batches) if (name.startsWith('crop_')) for (const mesh of batch.meshes) mesh.visible = this.lod < 2;
    const previous = this.botPositions.length;
    this.botPositions.length = this.botTargets.length = this.botAngles.length = snapshot.bots.length;
    snapshot.bots.forEach((bot, id) => {
      if (id >= previous) {
        this.botPositions[id] = new THREE.Vector3(bot.x, 0, bot.y);
        this.botTargets[id] = new THREE.Vector3(bot.x, 0, bot.y);
        this.botAngles[id] = 0;
      }
      const target = this.botTargets[id];
      if (target.x !== bot.x || target.z !== bot.y) this.botAngles[id] = Math.atan2(bot.x - this.botPositions[id].x, bot.y - this.botPositions[id].z);
      target.set(bot.x, 0, bot.y);
      if (bot.op !== null && this.lastOps[id] !== bot.op) this.fx.spark(bot.x, 0.35, bot.y, TRAIL[id % TRAIL.length]!, 6);
    });
    this.lastOps = snapshot.bots.map((bot) => bot.op);
    if (snapshot.bots.length) this.batch('bot_tender', snapshot.bots.length);
    this.prepareCarried(snapshot);
    this.updateBots(0, 0);
    this.updateDetails(snapshot);
    for (const batch of this.batches.values()) this.finish(batch);
    this.updateOverlay();
    this.updateSelection();
    this.canvas.dataset.renderedTiles = String(snapshot.tiles.length);
    this.canvas.dataset.tileColors = JSON.stringify(colors);
    this.canvas.dataset.modelInstances = JSON.stringify(Object.fromEntries([...this.batches].map(([name, batch]) => [name, batch.count])));
    if (!this.framed && snapshot.tiles.length) { this.focusFarm(); this.framed = true; }
    else if (snapshot.plots.length > this.plotCount && this.autoFramingArmed()) this.startReframe();
    this.plotCount = snapshot.plots.length;
  }

  /** Soil furrows on tilled tiles and grass tufts, only while the camera is close. */
  private updateDetails(snapshot: Snapshot): void {
    const close = this.lod === 0;
    this.furrows.visible = this.tufts.visible = close;
    if (!close) { this.furrows.count = this.tufts.count = 0; return; }
    let furrows = 0, tufts = 0;
    for (const tile of snapshot.tiles) {
      const isPath = tile.x === 0 && tile.y === 0;
      if (isPath) continue;
      if (tile.tilled) {
        if (furrows + 3 > this.furrows.instanceMatrix.count) continue;
        for (const dz of [-0.28, 0, 0.28]) {
          this.dummy.position.set(tile.x, 0, tile.y + dz);
          this.dummy.rotation.set(0, 0, 0);
          this.dummy.scale.setScalar(1);
          this.dummy.updateMatrix();
          this.furrows.setMatrixAt(furrows++, this.dummy.matrix);
        }
      } else if (tufts < this.tufts.instanceMatrix.count) {
        const jx = (((tile.x * 73 + tile.y * 151) % 17) - 8) / 34;
        const jz = (((tile.x * 31 + tile.y * 57) % 13) - 6) / 34;
        this.dummy.position.set(tile.x + jx, 0, tile.y + jz);
        this.dummy.rotation.set(0, ((tile.x * 7 + tile.y * 13) % 4) * (Math.PI / 2), 0);
        this.dummy.scale.setScalar(0.8 + ((tile.x * 3 + tile.y * 5) % 5) * 0.1);
        this.dummy.updateMatrix();
        this.tufts.setMatrixAt(tufts++, this.dummy.matrix);
      }
    }
    this.furrows.count = furrows;
    this.tufts.count = tufts;
    this.furrows.instanceMatrix.needsUpdate = true;
    this.tufts.instanceMatrix.needsUpdate = true;
  }

  /** True while the camera is where automatic framing last left it (or is still easing there). */
  private autoFramingArmed(): boolean {
    if (this.reframe) return true;
    const pose = this.autoPose;
    if (!pose || this.followIndex >= 0) return false;
    const cur = this.rig.cur;
    return Math.abs(cur.tx - pose.tx) < 0.05 && Math.abs(cur.tz - pose.tz) < 0.05 && Math.abs(cur.dist - pose.dist) < 0.05 && Math.abs(cur.pitch - pose.pitch) < 0.02;
  }

  private startReframe(): void {
    const bounds = this.latest ? this.bounds(this.latest) : null;
    if (!bounds) return;
    const cur = this.rig.cur;
    const to: RigPose = { tx: (bounds.x0 + bounds.x1) / 2, tz: (bounds.z0 + bounds.z1) / 2, yaw: cur.yaw, pitch: cur.pitch, dist: this.rig.fitDistance(bounds) };
    if (this.reducedMotion.matches) { this.rig.snap(to); this.autoPose = { ...this.rig.cur }; return; }
    this.reframe = { from: { ...cur }, to, start: performance.now() };
  }

  private stepReframe(time: number): void {
    const move = this.reframe;
    if (!move) return;
    const t = Math.min(1, (time - move.start) / 600);
    if (t >= 1) { this.reframe = null; this.rig.snap(move.to); this.autoPose = { ...this.rig.cur }; return; }
    const e = t * t * (3 - 2 * t);
    const mix = (a: number, b: number): number => a + (b - a) * e;
    this.rig.snap({ tx: mix(move.from.tx, move.to.tx), tz: mix(move.from.tz, move.to.tz), yaw: move.to.yaw, pitch: mix(move.from.pitch, move.to.pitch), dist: mix(move.from.dist, move.to.dist) });
  }

  private bounds(snapshot: Snapshot): Bounds | null { return tileBounds(snapshot.tiles); }

  private applyBounds(snapshot: Snapshot): void {
    const bounds = this.bounds(snapshot);
    if (!bounds) return;
    this.island.rebuild(bounds);
    this.rig.setBounds(bounds);
    this.minimap?.setBounds(bounds);
    const extent = Math.max(bounds.x1 - bounds.x0, bounds.z1 - bounds.z0);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = Math.max(55, extent * 3);
    fog.far = Math.max(150, extent * 6);
  }

  /** Shadow window follows the camera target, rounded so it does not shimmer every frame. */
  private stepShadow(): void {
    const x = Math.round(this.rig.cur.tx * 2) / 2, z = Math.round(this.rig.cur.tz * 2) / 2;
    const half = THREE.MathUtils.clamp(this.rig.cur.dist * 0.85, 9, 36);
    if (x === this.shadowAnchor.x && z === this.shadowAnchor.z && Math.abs(half - this.shadowAnchor.half) < 0.5) return;
    this.shadowAnchor = { x, z, half };
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x, 0, z).add(this.sunDir);
    const camera = this.sun.shadow.camera;
    camera.left = camera.bottom = -half;
    camera.right = camera.top = half;
    camera.near = 0.5;
    camera.far = this.sunDir.length() + half * 2.4;
    camera.updateProjectionMatrix();
  }

  setOverlay(overlay: FarmOverlay): void {
    if (this.disposed || !['none', 'moisture', 'nitrogen', 'fatigue'].includes(overlay)) return;
    this.overlay = overlay;
    this.canvas.dataset.overlay = overlay;
    this.updateOverlay();
  }

  private updateOverlay(): void {
    if (!this.latest) return;
    this.canvas.dataset.overlayColors = JSON.stringify(this.overlayLayer.update(this.latest.tiles, this.overlay));
  }

  /** Re-frame the whole farm at the default angle and re-arm automatic framing. */
  focusFarm = (): void => {
    if (this.disposed || !this.latest) return;
    this.reframe = null;
    const bounds = this.bounds(this.latest);
    if (!bounds) return;
    this.rig.frameBounds(bounds, new THREE.Vector3(0.35, 1.2, 1), true);
    this.autoPose = { ...this.rig.cur };
  };

  selectBot(id: number): void {
    if (this.disposed || !Number.isInteger(id) || !this.latest?.bots[id]) return;
    this.selectedBot = id; // Snapshot and Sprout bot IDs are zero-based.
    const bot = this.latest.bots[id];
    this.reframe = null;
    this.rig.snap({ tx: bot.x, tz: bot.y, yaw: Math.atan2(3, 8), pitch: Math.asin(7 / Math.hypot(3, 7, 8)), dist: Math.hypot(3, 7, 8) });
    this.canvas.dataset.selectedBot = String(id);
    this.updateSelection();
  }

  /** Any deliberate user input disarms automatic framing and drops the follow. */
  private userMoved = (): void => {
    this.reframe = null;
    this.autoPose = null;
    if (this.followIndex >= 0) { this.followIndex = -1; this.rig.setFollowProvider(null); this.syncFollow(); }
  };

  private followProvider = (): { x: number; z: number } | null => {
    const position = this.followIndex >= 0 ? this.botPositions[this.followIndex] : undefined;
    return position ? { x: position.x, z: position.z } : null;
  };

  private cycleFollow = (): void => {
    if (this.disposed) return;
    const bots = this.latest?.bots.length ?? 0;
    this.reframe = null;
    this.autoPose = null;
    this.followIndex = !bots || this.followIndex >= bots - 1 ? -1 : this.followIndex + 1;
    this.rig.setFollowProvider(this.followIndex >= 0 ? this.followProvider : null);
    this.syncFollow();
  };

  private syncFollow(): void {
    this.followButton?.setAttribute('aria-pressed', String(this.followIndex >= 0));
    this.canvas.dataset.followBot = String(this.followIndex);
  }

  private navigateTo = (x: number, z: number): void => {
    this.userMoved();
    this.rig.ease({ tx: x, tz: z });
  };

  private clickAt = (clientX: number, clientY: number): void => {
    const hit = this.rig.groundAtClient(clientX, clientY, new THREE.Vector3());
    if (!hit) return;
    this.selectTile(Math.floor(hit.x + 0.5), Math.floor(hit.z + 0.5));
  };

  private updateSelection(): void {
    const tile = this.selectedTile;
    this.tileRing.visible = !!tile && this.tileLookup.has(key(tile.x, tile.y));
    if (tile) this.tileRing.position.set(tile.x, 0.045, tile.y);
    const position = this.selectedBot === null ? undefined : this.botPositions[this.selectedBot];
    this.botRing.visible = !!position;
    if (position) this.botRing.position.set(position.x, 0.04, position.z);
  }

  /** Selects an owned tile and tells the inspector. Scenery and unowned holes are never selectable simulation cells. */
  private selectTile(x: number, y: number): boolean {
    const tile = this.tileLookup.get(key(x, y));
    if (!tile) return false;
    this.selectedTile = { x, y };
    this.updateSelection();
    this.canvas.dispatchEvent(new CustomEvent('tendril:tile', { detail: { x, y, scan: { ...tile } }, bubbles: true }));
    return true;
  }

  /** Keyboard access: arrows move the selection to the next owned tile (north is up, as on screen), Enter or Space selects the barn first. */
  private keyDown = (event: KeyboardEvent): void => {
    if (this.disposed || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = ({ ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as Record<string, [number, number]>)[event.key];
    if (!step) {
      if ((event.key === 'Enter' || event.key === ' ') && !this.selectedTile && this.selectTile(0, 0)) event.preventDefault();
      return;
    }
    event.preventDefault();
    const from = this.selectedTile;
    if (!from) { this.selectTile(0, 0); return; }
    for (let i = 1; i <= 24; i++) if (this.selectTile(from.x + step[0] * i, from.y + step[1] * i)) return; // skips short gaps between plots
  };

  private cameraStatus = (): void => {
    const { tx, tz } = this.rig.cur;
    const position = this.camera.position;
    if (tx === this.published.tx && tz === this.published.tz && position.x === this.published.px && position.y === this.published.py && position.z === this.published.pz) return;
    this.published = { tx, tz, px: position.x, py: position.y, pz: position.z };
    this.canvas.dataset.cameraTarget = JSON.stringify([tx, 0, tz]);
    this.canvas.dataset.cameraPosition = JSON.stringify(position.toArray());
  };
  private resize = (): void => {
    if (this.disposed) return;
    const width = this.canvas.clientWidth || 1, height = this.canvas.clientHeight || 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };
  private updateBots(delta: number, time: number): void {
    const batch = this.batches.get('bot_tender');
    if (!batch) return;
    batch.count = 0;
    const blend = 1 - Math.exp(-delta * 12);
    for (let id = 0; id < this.botPositions.length; id++) {
      const position = this.botPositions[id];
      position.lerp(this.botTargets[id], this.reducedMotion.matches ? 1 : blend);
      this.place(batch, { x: position.x, z: position.z, rotation: this.botAngles[id], scale: this.botScale }, undefined, this.reducedMotion.matches ? 0 : 0.015 + Math.sin(time / 350 + id) * 0.012);
    }
    this.finish(batch);
    this.placeCarried();
    this.updateSelection();
  }

  /** Make sure a batch exists for every kind of item any bot carries (placeholders until the GLB arrives). */
  private prepareCarried(snapshot: Snapshot): void {
    const counts = new Map<string, number>();
    for (const bot of snapshot.bots) bot.items.forEach((n, id) => { if (id > 0 && n > 0 && ITEM_NAMES[id]) counts.set(`item_${ITEM_NAMES[id]}`, (counts.get(`item_${ITEM_NAMES[id]}`) ?? 0) + 1); });
    for (const [name, n] of counts) this.batch(name, n, `carry:${name}`);
    this.carriedNames = [...counts.keys()].map((name) => `carry:${name}`);
  }

  /** One small marker per kind of item a bot carries, stacked above it and following its animation. */
  private placeCarried(): void {
    const snapshot = this.latest;
    if (!snapshot) return;
    for (const name of this.carriedNames) { const batch = this.batches.get(name); if (batch) batch.count = 0; }
    snapshot.bots.forEach((bot, id) => {
      const position = this.botPositions[id];
      if (!position) return;
      let level = 0;
      bot.items.forEach((n, item) => {
        const batch = n > 0 && item > 0 && ITEM_NAMES[item] ? this.batches.get(`carry:item_${ITEM_NAMES[item]}`) : undefined;
        if (!batch || batch.count >= batch.capacity) return;
        this.place(batch, { x: position.x, z: position.z, rotation: item, scale: this.botScale }, undefined, (0.78 + level++ * 0.17) * this.botScale);
      });
    });
    for (const name of this.carriedNames) { const batch = this.batches.get(name); if (batch) this.finish(batch); }
  }

  private minimapTick(time: number): void {
    const snapshot = this.latest;
    if (!this.minimap || !snapshot || time < this.nextMinimap) return;
    this.nextMinimap = time + 150;
    const viewport = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]).map(([nx, ny]) => {
      const hit = this.rig.groundAt(nx, ny, new THREE.Vector3());
      return hit ? [hit.x, hit.z] as [number, number] : null;
    });
    this.minimap.update(snapshot.tiles, this.botPositions.map((position, id) => ({ x: position.x, z: position.z, color: TRAIL[id % TRAIL.length]! })), viewport, this.selectedTile);
  }

  private loop = (time: number): void => {
    if (this.disposed) return;
    const delta = this.previousTime ? Math.min((time - this.previousTime) / 1000, 0.1) : 0;
    this.previousTime = time;
    this.updateBots(delta, time);
    this.stepReframe(time);
    this.rig.step(delta);
    if (this.latest && this.lodAt(this.rig.tilePx()) !== this.lod) this.update(this.latest);
    this.stepShadow();
    this.island.pulse(time / 1000);
    this.fx.update(delta, this.botPositions.map((position, id) => ({ x: position.x, z: position.z, color: TRAIL[id % TRAIL.length]! })), this.botScale, { x: this.rig.cur.tx, z: this.rig.cur.tz });
    this.minimapTick(time);
    this.renderer.render(this.scene, this.camera);
    this.canvas.dataset.sceneReady = String(!!this.latest?.tiles.length);
    this.raf = requestAnimationFrame(this.loop);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.ro.disconnect();
    this.canvas.removeEventListener('keydown', this.keyDown);
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    this.rig.dispose();
    this.fx.dispose();
    this.island.dispose();
    this.minimap?.dispose();
    this.minimap = null;
    this.market.dispose();
    for (const batch of this.batches.values()) for (const mesh of batch.meshes) { this.scene.remove(mesh); mesh.dispose(); }
    this.batches.clear();
    this.loader.dispose();
    disposeModels(this.fallbacks.values());
    this.fallbacks.clear();
    this.overlayLayer.dispose();
    this.furrows.dispose();
    this.tufts.dispose();
    const remaining: AssetPart[] = [];
    this.scene.traverse((object) => { if (object instanceof THREE.Mesh) remaining.push({ geometry: object.geometry, material: object.material }); });
    disposeModels([{ parts: remaining }]);
    this.sun.dispose();
    this.sky?.dispose();
    this.sky = null;
    this.scene.clear();
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.dataset.sceneReady = 'false';
    this.canvas.dataset.modelsStatus = 'disposed';
    this.canvas.dataset.modelsLoaded = '0';
    this.canvas.dataset.modelsAssets = '[]';
    this.canvas.dataset.modelInstances = '{}';
    this.latest = null;
    this.tileLookup.clear();
    this.lastOps = [];
    this.botPositions = []; this.botTargets = []; this.botAngles = [];
  }
}

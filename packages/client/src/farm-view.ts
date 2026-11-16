import { perfHook } from './perf-meter';
import * as THREE from 'three';
import { CROPS as SIM_CROPS } from '@tendril/sim/src/index.ts';
import { AssetLoader, disposeModels, type AssetModel, type AssetStatus } from './asset-loader';
import type { Snapshot } from './sim-types';
import { fallbackModel } from './fallback-models';
import type { FarmOverlay } from './farm-overlay';
import { FarmIsland, type Bounds } from './farm-scenery';
import { FarmCamera } from './farm-camera';
import { FarmLight, type LightPreset } from './farm-light';
import { FarmWorld } from './farm-world';
import { FarmDrones, DRONE_HOVER, droneColor, droneViewScale } from './farm-drones';
import { FarmFx } from './farm-fx';
import { FarmCarried } from './farm-carried';
import { FarmMarket, type MarketData } from './farm-market';
import type { FarmHud, Lens, ZoomMode } from './farm-hud';

export type { FarmOverlay };
export type { Lens, ZoomMode, LightPreset };

export interface FarmViewOptions {
  /**
   * Small embedded views (room and replay panes): no HUD, no market card, no trails, no fireflies, shadows off.
   * They still get the camera rig, the island, the world and the drones.
   */
  lite?: boolean;
}

const hexOf = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
const MINIMAP_MS = 120;

export class FarmView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
  private rig: FarmCamera;
  private light: FarmLight;
  private island: FarmIsland;
  private world: FarmWorld;
  private fx: FarmFx;
  private drones: FarmDrones;
  private carried: FarmCarried;
  private market: FarmMarket | null = null;
  private hud: FarmHud | null = null;
  private loader: AssetLoader;
  private fallbacks = new Map<string, AssetModel>();
  private latest: Snapshot | null = null;
  private lite: boolean;
  private overlay: FarmOverlay = 'none';
  private priceLens = false;
  private lod: 0 | 1 | 2 = 0;
  /** Tiles per cell side (1 = every tile drawn); the HUD badge shows it when merged. */
  private stride = 1;
  private tilePx = 40;
  /** Read by the renderer tests. */
  get overlayMesh(): THREE.InstancedMesh | null { return this.world.overlayMesh; }
  private selectedTile: { x: number; y: number } | null = null;
  private selectedBot: number | null = null;
  private followId: number | null = null;
  private tileRing = new THREE.Mesh(new THREE.RingGeometry(0.47 * Math.SQRT2, 0.51 * Math.SQRT2, 4).rotateZ(Math.PI / 4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffedb4, depthWrite: false }));
  private weather: Snapshot['weather'] | null = null;
  private islandKey = '';
  private lastTick = -1;
  private stallPlaced = false;
  /** Ripe crops that were next to a drone at the last snapshot: if one is gone next time, it was harvested. */
  private nearRipe = new Map<string, { x: number; y: number; crop: number }>();
  private lastCoins = 0;
  private disposed = false;
  private raf = 0;
  private previousTime = 0;
  private lastMinimap = 0;
  private shownColors: unknown = null;
  private shownOverlay: unknown = null;
  private shownInstances = '';
  private ro: ResizeObserver;

  constructor(private canvas: HTMLCanvasElement, opts: FarmViewOptions = {}) {
    this.lite = !!opts.lite;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.light = new FarmLight(this.scene, this.renderer, { shadows: !this.lite });
    this.island = new FarmIsland(this.scene);
    this.loader = new AssetLoader(this.assetsChanged);
    this.world = new FarmWorld(this.scene, (name) => this.loader.models.get(name) ?? this.fallback(name));
    this.fx = new FarmFx(this.scene);
    this.fx.fireflies = !this.lite;
    this.drones = new FarmDrones(this.scene, () => this.loader.models.get('bot_tender') ?? null, this.fx);
    this.drones.trails = !this.lite;
    this.carried = new FarmCarried(this.scene, (name) => this.loader.models.get(name) ?? this.fallback(name));
    this.scene.add(this.tileRing);
    this.tileRing.visible = false;
    this.camera.position.set(10, 14, 16);
    this.rig = new FarmCamera(this.camera, canvas, this.tap);
    this.rig.onChange = this.cameraStatus;
    this.cameraStatus();
    const stage = canvas.closest<HTMLElement>('#farm-stage');
    if (stage && !this.lite) this.market = new FarmMarket(stage, this.scene);
    this.ro = new ResizeObserver(this.resize);
    this.ro.observe(canvas.parentElement ?? canvas);
    window.addEventListener('resize', this.resize);
    canvas.tabIndex = 0;
    canvas.addEventListener('keydown', this.keyDown);
    canvas.dataset.overlay = 'none';
    canvas.dataset.modelsLoaded = '0';
    canvas.dataset.sceneReady = 'false';
    canvas.dataset.lod = '0';
    this.resize();
    void this.loader.load();
    this.raf = requestAnimationFrame(this.loop);
  }

  private assetsChanged = (status: AssetStatus): void => {
    if (this.disposed) return;
    this.canvas.dataset.modelsLoaded = String(status.loaded);
    this.canvas.dataset.modelsStatus = status.state;
    this.canvas.dataset.modelsErrors = status.errors.join('; ');
    this.canvas.dataset.modelsAssets = JSON.stringify([...this.loader.models.keys()].sort());
    this.world.invalidate();
    if (this.latest) this.renderWorld(performance.now() / 1000); // swap placeholders for the GLBs before anyone reads the batches
    this.canvas.dispatchEvent(new CustomEvent('tendril:models', { detail: status, bubbles: true }));
  };

  private fallback(name: string): AssetModel {
    let model = this.fallbacks.get(name);
    if (!model) { model = fallbackModel(name); this.fallbacks.set(name, model); }
    return model;
  }

  /** Instance batches of the world by model name (renderer tests). */
  get batches(): ReadonlyMap<string, { meshes: THREE.InstancedMesh[]; model: AssetModel; count: number }> { return this.world.debugBatches; }

  // ---------------------------------------------------------------- snapshot

  update(snapshot: Snapshot): void {
    if (this.disposed) return;
    const applyStart = perfHook.apply ? performance.now() : 0;
    const previous = this.latest;
    this.latest = snapshot;
    const tickDelta = this.lastTick >= 0 && snapshot.tick > this.lastTick ? snapshot.tick - this.lastTick : 1;
    this.lastTick = snapshot.tick;
    if (snapshot.weather !== this.weather) { this.weather = snapshot.weather; this.light.setWeather(snapshot.weather); }
    this.world.setSnapshot(snapshot);
    const bounds = this.world.bounds;
    this.rig.setBounds(bounds);
    const key = `${bounds ? `${bounds.x0},${bounds.x1},${bounds.z0},${bounds.z1}` : '-'}|${this.world.tileCount}`;
    if (key !== this.islandKey) { this.islandKey = key; this.island.update(bounds, (x, y) => !!this.world.tileAt(x, y)); }
    if (this.market && !this.stallPlaced && this.world.tileAt(0, 0)) { this.market.setStallAt(1, 0); this.stallPlaced = true; }
    this.drones.setBots(snapshot.bots, tickDelta);
    if (this.selectedBot !== null && this.selectedBot >= snapshot.bots.length) this.selectedBot = null;
    this.drones.setSelected(this.selectedBot);
    if (this.market) this.watchHarvests(previous, snapshot, tickDelta);
    this.updateSelection();
    this.canvas.dataset.renderedTiles = String(this.world.tileCount);
    this.renderWorld(performance.now() / 1000);
    if (applyStart) perfHook.apply?.(performance.now() - applyStart);
  }

  /** Renderer counters (draw calls, triangles) for the performance meter. */
  renderInfo(): THREE.WebGLInfo { return this.renderer.info; }

  /** Harvest popups: a ripe crop that was next to a drone is gone or reset, or coins arrived while a drone stood at the barn. */
  private watchHarvests(previous: Snapshot | null, s: Snapshot, tickDelta: number): void {
    const market = this.market!;
    const live = previous !== null && tickDelta <= 40;
    if (live) {
      for (const was of this.nearRipe.values()) {
        const now = this.world.tileAt(was.x, was.y);
        if (now && (now.crop === 0 || now.stage < 3)) {
          const crop = SIM_CROPS[was.crop];
          const mult = market.multipliers?.[was.crop] ?? 1;
          if (crop) market.popup(this.camera, was.x, was.y, Math.round(crop.price * crop.yield * mult * 100) / 100, mult);
        }
      }
      const gain = s.coins - this.lastCoins;
      if (gain > 0 && s.bots.some((b) => Math.abs(b.x) <= 1 && Math.abs(b.y) <= 1)) market.popup(this.camera, 0, 0, gain, 1);
    }
    this.lastCoins = s.coins;
    this.nearRipe.clear();
    for (const bot of s.bots) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const t = this.world.tileAt(bot.x + dx, bot.y + dy);
      if (t && t.crop >= 1 && t.stage >= 3) this.nearRipe.set(`${t.x},${t.y}`, { x: t.x, y: t.y, crop: t.crop });
    }
  }

  // ---------------------------------------------------------------- market, lens, light

  /** The shared market for this farm (null: base prices). `opensInDays` > 0 while the day is before the market epoch. */
  setMarket(market: MarketData | null, opts?: { opensInDays?: number }): void {
    if (this.disposed || !this.market) return;
    this.market.setMarket(market, opts);
    if (!this.market.multipliers && this.priceLens) this.setLens('none');
  }

  /** True when the price lens has a market to draw. */
  priceAvailable(): boolean { return !!this.market?.multipliers; }

  setOverlay(overlay: FarmOverlay): void {
    if (this.disposed || !['none', 'moisture', 'nitrogen', 'fatigue'].includes(overlay)) return;
    this.setLens(overlay);
  }

  /** Soil lens or price lens. `price` needs a market and quietly falls back to natural without one. */
  setLens(lens: Lens): void {
    if (this.disposed || !['none', 'moisture', 'nitrogen', 'fatigue', 'price'].includes(lens)) return;
    if (lens === 'price' && !this.priceAvailable()) lens = 'none';
    this.priceLens = lens === 'price';
    this.overlay = lens === 'price' ? 'none' : lens;
    this.canvas.dataset.overlay = lens;
    if (this.latest) this.renderWorld(performance.now() / 1000);
  }

  setLight(preset: LightPreset): void { if (!this.disposed) this.light.setPreset(preset); }
  setZoomMode(mode: ZoomMode): void { if (!this.disposed) this.rig.zoomMode = mode; }

  /** Attach the HUD built by `mountInspectors`; it is updated every frame from here on. */
  attachHud(hud: FarmHud | null): void { this.hud = this.lite ? null : hud; }

  // ---------------------------------------------------------------- camera

  /** Re-frame the whole farm and re-arm automatic framing. */
  focusFarm(): void {
    if (this.disposed) return;
    this.followId = null;
    this.rig.fit();
  }

  /** Cycle the camera through the drones, then back to free. */
  follow(): void {
    if (this.disposed || !this.latest) return;
    const count = this.latest.bots.length;
    const next = this.followId === null ? 0 : this.followId + 1;
    if (!count || next >= count) { this.followId = null; this.rig.follow(null); return; }
    this.followId = next;
    this.rig.follow(() => this.drones.position(next));
  }

  rotate(steps: number): void { if (!this.disposed) this.rig.rotate(steps); }

  /** Move the camera over a world position (minimap). */
  jumpTo(x: number, z: number): void {
    if (this.disposed) return;
    this.followId = null;
    this.rig.focus(x, z);
  }

  /** Ground point under a screen position given as normalised device coordinates (-1..1, y up). Test and tooling hook. */
  groundAt(ndcX: number, ndcY: number): { x: number; z: number } | null {
    const p = this.rig.groundAt(ndcX, ndcY);
    return p ? { x: p.x, z: p.z } : null;
  }

  selectBot(id: number): void {
    if (this.disposed || !Number.isInteger(id) || !this.latest?.bots[id]) return;
    this.selectedBot = id; // Snapshot and Sprout bot IDs are zero-based.
    const bot = this.latest.bots[id]!;
    this.followId = null;
    this.rig.focus(bot.x, bot.y, { dist: Math.min(this.rig.distance, 11) });
    this.canvas.dataset.selectedBot = String(id);
    this.drones.setSelected(id);
    this.updateSelection();
  }

  private updateSelection(): void {
    const tile = this.selectedTile;
    this.tileRing.visible = !!tile && !!this.world.tileAt(tile.x, tile.y);
    if (tile) this.tileRing.position.set(tile.x, 0.045, tile.y);
  }

  // ---------------------------------------------------------------- input

  private tap = (clientX: number, clientY: number): void => {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.rig.groundAt((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
    if (hit) this.selectTile(Math.floor(hit.x + 0.5), Math.floor(hit.z + 0.5));
  };

  /** Selects an owned tile and tells the inspector. Scenery and unowned holes are never selectable simulation cells. */
  private selectTile(x: number, y: number): boolean {
    const tile = this.world.tileAt(x, y);
    if (!tile) return false;
    this.selectedTile = { x, y };
    this.updateSelection();
    this.canvas.dispatchEvent(new CustomEvent('tendril:tile', { detail: { x, y, scan: { ...tile } }, bubbles: true }));
    return true;
  }

  /** Keyboard access: plain arrows move the selection to the next owned tile (north is up, as on screen), Enter or Space selects the barn first. Shift+arrows pan the camera. */
  private keyDown = (event: KeyboardEvent): void => {
    if (this.disposed || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
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
    this.canvas.dataset.cameraTarget = JSON.stringify(this.rig.target.toArray());
    this.canvas.dataset.cameraPosition = JSON.stringify(this.camera.position.toArray());
  };

  private resize = (): void => {
    if (this.disposed) return;
    const width = this.canvas.clientWidth || 1, height = this.canvas.clientHeight || 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  // ---------------------------------------------------------------- frame

  /** Pixels per tile at the camera target, from the vertical field of view. */
  private measure(): void {
    const dist = Math.max(0.5, this.camera.position.distanceTo(this.rig.target));
    this.tilePx = (this.canvas.clientHeight || 1) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * dist);
  }

  private renderWorld(time: number): void {
    if (!this.latest) return;
    this.measure();
    const r = this.world.refresh({ camera: this.camera, quad: this.rig.visibleQuad(), distance: this.rig.distance, tilePx: this.tilePx, time },
      { overlay: this.overlay, priceMultipliers: this.priceLens ? this.market?.multipliers ?? null : null });
    this.lod = r.lod;
    this.stride = r.stride;
    this.canvas.dataset.lod = String(r.lod);
    const debug = this.world.debug;
    if (debug.tileColors !== this.shownColors) { this.shownColors = debug.tileColors; this.canvas.dataset.tileColors = JSON.stringify(debug.tileColors); }
    if (debug.overlayColors !== this.shownOverlay) { this.shownOverlay = debug.overlayColors; this.canvas.dataset.overlayColors = JSON.stringify(debug.overlayColors); }
    this.publishInstances();
  }

  private publishInstances(): void {
    const counts: Record<string, number> = { ...this.world.debug.modelInstances, ...(this.latest?.bots.length ? { bot_tender: this.latest.bots.length } : {}) };
    if (this.latest) Object.assign(counts, this.carried.update(this.latest.bots, (id) => this.drones.position(id), DRONE_HOVER));
    const text = JSON.stringify(counts);
    if (text !== this.shownInstances) { this.shownInstances = text; this.canvas.dataset.modelInstances = text; }
  }

  private loop = (ms: number): void => {
    if (this.disposed) return;
    perfHook.frame?.(ms);
    const dt = this.previousTime ? Math.min((ms - this.previousTime) / 1000, 0.1) : 0;
    this.previousTime = ms;
    const time = ms / 1000;
    if (this.followId !== null && !this.rig.following) this.followId = null;
    this.rig.update(dt);
    const focus = this.rig.target;
    this.light.update(dt, focus, this.rig.distance);
    this.island.setDistance(this.rig.distance);
    this.island.pulse(time);
    this.renderWorld(time);
    this.drones.update(dt, time, this.light.glow, droneViewScale(this.tilePx));
    this.fx.update(dt, time, focus, this.light.glow, droneViewScale(this.tilePx));
    if (this.market) { this.market.setPopupsHidden(this.lod === 2); this.market.update(dt); }
    if (this.hud) {
      this.hud.update({ following: this.rig.following, lod: this.lod, tilePx: this.tilePx, cells: this.stride });
      if (ms - this.lastMinimap > MINIMAP_MS) { this.lastMinimap = ms; this.updateMinimap(); }
    }
    this.renderer.render(this.scene, this.camera);
    this.canvas.dataset.sceneReady = String(this.world.tileCount > 0);
    this.raf = requestAnimationFrame(this.loop);
  };

  private updateMinimap(): void {
    const s = this.latest;
    if (!s || !this.hud) return;
    const bots: { x: number; z: number; color: string }[] = [];
    s.bots.forEach((_, id) => { const p = this.drones.position(id); if (p) bots.push({ x: p.x, z: p.z, color: hexOf(droneColor(id)) }); });
    const bounds: Bounds | null = this.world.bounds;
    this.hud.minimap.update({
      chunks: (fn) => this.world.forEachChunk(fn),
      quad: this.rig.visibleQuad(),
      bots,
      selected: this.selectedTile ? { x: this.selectedTile.x, z: this.selectedTile.y } : null,
      home: { x: 0, z: 0 },
      bounds,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.ro.disconnect();
    this.canvas.removeEventListener('keydown', this.keyDown);
    this.rig.dispose();
    this.market?.dispose();
    this.carried.dispose();
    this.drones.dispose();
    this.fx.dispose();
    this.world.dispose();
    this.island.dispose();
    this.light.dispose();
    this.loader.dispose();
    disposeModels(this.fallbacks.values());
    this.fallbacks.clear();
    this.tileRing.geometry.dispose();
    (this.tileRing.material as THREE.Material).dispose();
    this.scene.clear();
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.hud = null;
    this.canvas.dataset.sceneReady = 'false';
    this.canvas.dataset.modelsStatus = 'disposed';
    this.canvas.dataset.modelsLoaded = '0';
    this.canvas.dataset.modelsAssets = '[]';
    this.canvas.dataset.modelInstances = '{}';
    this.latest = null;
    this.nearRipe.clear();
  }
}

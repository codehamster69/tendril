import { boot } from './boot';
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
import { SiloDrops, saleSite } from './silo-drops';
import { FarmDrones, DRONE_HOVER, droneColor, droneViewScale } from './farm-drones';
import { FarmFx } from './farm-fx';
import { FarmCarried } from './farm-carried';
import { FarmMarket, type MarketData } from './farm-market';
import type { FarmHud, Lens, ZoomMode } from './farm-hud';
import { dayProgress } from './day-clock';
import type { DayConfig } from './day-dial';
import { DynamicScale, RenderGate, ShadowClock, qualityPlan, type Quality, type QualityPlan } from './render-budget';
import { getSettings, onSettings } from './settings';

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
  private day: DayConfig = { runTicks: null };
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
  private silos = new SiloDrops();

  /** Sales a silo took in the last 500 ticks, as seen by this view (see silo-drops.ts). */
  siloDropsAt(x: number, y: number, tick: number): number { return this.silos.count(x, y, tick); }
  private disposed = false;
  private raf = 0;
  private previousTime = 0;
  // Drawing budget (task P4): frames are drawn only when something changed, see render-budget.ts.
  private gate = new RenderGate();
  private shadowClock = new ShadowClock(100);
  private quality: Quality = 'auto';
  private plan: QualityPlan;
  private scale: DynamicScale;
  private hidden = typeof document !== 'undefined' && document.hidden;
  private camMoved = false;
  private shadowWorld = -1;
  private autoShadowsOff = false;
  private lastMinimap = 0;
  private shownColors: unknown = null;
  private shownOverlay: unknown = null;
  private shownInstances = '';
  private ro: ResizeObserver;

  constructor(private canvas: HTMLCanvasElement, opts: FarmViewOptions = {}) {
    this.lite = !!opts.lite;
    this.quality = this.lite ? 'auto' : getSettings().quality;
    this.plan = qualityPlan(this.quality, window.devicePixelRatio);
    this.scale = new DynamicScale(this.plan.maxRatio);
    // Small embedded views keep their drawing buffer: the replay clip copies the canvas outside the render callback.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.plan.antialias, preserveDrawingBuffer: this.lite });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.light = new FarmLight(this.scene, this.renderer, { shadows: !this.lite });
    this.light.setShadows(this.plan.shadows);
    this.loader = new AssetLoader(this.assetsChanged);
    this.island = new FarmIsland(this.scene, (name) => this.loader.models.get(name) ?? this.fallback(name));
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
    if (!this.lite) window.addEventListener('tendril:slate-inset', this.onSlate);
    canvas.addEventListener('wheel', this.wake, { passive: true });
    canvas.addEventListener('pointerdown', this.wake, { passive: true });
    canvas.addEventListener('pointermove', this.pointerWake, { passive: true });
    canvas.addEventListener('pointerup', this.wake, { passive: true });
    window.addEventListener('keydown', this.keyWake, { passive: true });
    window.addEventListener('keyup', this.keyWake, { passive: true });
    this.offSettings = onSettings(this.settingsChanged);
    document.addEventListener('visibilitychange', this.visibility);
    // The market countdown is DOM text; it ticks on its own clock so it keeps counting while the farm is not drawing.
    if (this.market) this.marketTimer = window.setInterval(() => { if (!this.hidden) this.market?.update(1); }, 1000);
    canvas.tabIndex = 0;
    canvas.addEventListener('keydown', this.keyDown);
    canvas.dataset.overlay = 'none';
    canvas.dataset.modelsLoaded = '0';
    canvas.dataset.sceneReady = 'false';
    canvas.dataset.lod = '0';
    this.resize();
    void this.loader.load();
    this.wake();
  }

  private marketTimer = 0;

  // ---------------------------------------------------------------- drawing budget

  /** Ask for one more drawn frame (plus the few quiet frames that let easing finish). Cheap to call from anywhere. */
  requestRender(): void {
    if (this.disposed) return;
    this.gate.request();
    this.schedule();
  }

  /** Number of modules holding the view in continuous drawing, see `holdAnimation`. */
  get animating(): number { return this.gate.animating; }

  /**
   * Keep frames coming until the returned function is called (an effect, a transition, a dial). Call it exactly once.
   * While nothing holds the view and nothing moves, the farm draws no frames at all.
   */
  holdAnimation(): () => void {
    const release = this.gate.hold();
    this.schedule();
    return () => { release(); this.schedule(); };
  }

  /** Something happened that should look alive for a moment (an update, input): draw, with ambient motion for a short tail. */
  private wake = (): void => {
    if (this.disposed) return;
    this.gate.touch(performance.now());
    this.schedule();
  };

  private pointerWake = (e: PointerEvent): void => { if (e.buttons) this.wake(); };
  private keyWake = (e: KeyboardEvent): void => {
    // Typing anywhere in the code slate (a contenteditable or input) must not wake the farm.
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('input,textarea,select,[contenteditable]')) return;
    this.wake();
  };

  private schedule(): void {
    if (this.raf || this.disposed || this.hidden) return;
    this.raf = requestAnimationFrame(this.loop);
  }

  private visibility = (): void => {
    this.hidden = document.hidden;
    if (this.hidden) { cancelAnimationFrame(this.raf); this.raf = 0; this.previousTime = 0; this.scale.gap(); }
    else this.wake();
  };

  private offSettings: () => void;
  /** Settings changed: graphics quality applies now; reduced motion is read every frame, so just draw one. */
  private settingsChanged = (s: { quality: Quality }): void => { this.applyQuality(s.quality); this.light.markShadowDirty(); this.requestRender(); };

  /** Low: no shadows, ratio 1. Auto: ratio up to 1.5 and shadows. High: ratio up to 2 and shadows. Antialiasing applies on the next load. */
  private applyQuality(quality: Quality): void {
    if (this.disposed || this.lite || quality === this.quality) return;
    this.quality = quality;
    this.plan = qualityPlan(quality, window.devicePixelRatio);
    this.autoShadowsOff = false;
    this.scale.setMax(this.plan.maxRatio);
    this.scale.clearStrikes();
    this.light.setShadows(this.plan.shadows);
    this.resize();
  }

  /** The quality actually in use, for the e2e tests and the perf meter: setting, pixel ratio cap, ratio now, shadows. */
  private exposeQuality(): void {
    const d = this.canvas.dataset;
    d.quality = this.quality; d.maxRatio = String(this.plan.maxRatio); d.pixelRatio = String(this.renderer.getPixelRatio());
    d.shadows = String(this.light.shadowsOn);
  }

  private applyRatio(): void {
    this.renderer.setPixelRatio(this.scale.ratio);
    this.exposeQuality();
    this.renderer.setSize(this.canvas.clientWidth || 1, this.canvas.clientHeight || 1, false);
  }

  private assetsChanged = (status: AssetStatus): void => {
    if (this.disposed) return;
    this.canvas.dataset.modelsLoaded = String(status.loaded);
    this.canvas.dataset.modelsStatus = status.state;
    if (status.state !== 'loading') boot.done('models');
    this.canvas.dataset.modelsErrors = status.errors.join('; ');
    this.canvas.dataset.modelsAssets = JSON.stringify([...this.loader.models.keys()].sort());
    this.world.invalidate();
    this.island?.refreshModels();
    if (this.latest) this.renderWorld(performance.now() / 1000); // swap placeholders for the GLBs before anyone reads the batches
    this.light.markShadowDirty();
    this.requestRender();
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
    const scrub = this.lastTick < 0 || snapshot.tick < this.lastTick || tickDelta > 200;
    this.lastTick = snapshot.tick;
    this.syncDay(snapshot, scrub);
    if (snapshot.weather !== this.weather) { this.weather = snapshot.weather; this.light.setWeather(snapshot.weather); }
    this.world.setSnapshot(snapshot);
    if (scrub) this.world.wear.reset();
    if (this.world.wear.stepBots(snapshot.bots, !scrub && tickDelta <= 40)) this.world.invalidate();
    const bounds = this.world.bounds;
    this.rig.setBounds(bounds);
    const key = `${bounds ? `${bounds.x0},${bounds.x1},${bounds.z0},${bounds.z1}` : '-'}|${this.world.tileCount}`;
    if (key !== this.islandKey) { this.islandKey = key; this.island.update(bounds, this.world.ownership()); this.light.setFarm(bounds); this.light.markShadowDirty(); }
    if (this.market && !this.stallPlaced && this.world.tileAt(0, 0)) { this.market.setStallAt(1, 0); this.stallPlaced = true; }
    this.drones.setBots(snapshot.bots, tickDelta);
    if (this.selectedBot !== null && this.selectedBot >= snapshot.bots.length) this.selectedBot = null;
    this.drones.setSelected(this.selectedBot);
    if (this.market) this.watchHarvests(previous, snapshot, tickDelta);
    this.updateSelection();
    this.canvas.dataset.renderedTiles = String(this.world.tileCount);
    this.renderWorld(performance.now() / 1000);
    this.wake();
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
      const site = gain > 0 ? saleSite(s) : null;
      if (site) { if (site.silo) this.silos.record(site.x, site.y, s.tick); market.popup(this.camera, site.x, site.y, gain, 1); }
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
    this.requestRender();
    if (!this.market.multipliers && this.priceLens) this.setLens('none');
  }

  /** Today's price multipliers by crop (null without a market), for the stock chips. */
  marketMultipliers(): number[] | null { return this.market?.multipliers ?? null; }

  /** True when the price lens has a market to draw. */
  priceAvailable(): boolean { return !!this.market?.multipliers; }

  setOverlay(overlay: FarmOverlay): void {
    if (this.disposed || !['none', 'grid', 'moisture', 'nitrogen', 'fatigue', 'growth', 'drop'].includes(overlay)) return;
    this.setLens(overlay);
  }

  /** Soil lens or price lens. `price` needs a market and quietly falls back to natural without one. */
  setLens(lens: Lens): void {
    if (this.disposed || !['none', 'grid', 'moisture', 'nitrogen', 'fatigue', 'growth', 'price', 'drop'].includes(lens)) return;
    if (lens === 'price' && !this.priceAvailable()) lens = 'none';
    this.priceLens = lens === 'price';
    this.overlay = lens === 'price' ? 'none' : lens;
    this.canvas.dataset.overlay = lens;
    if (this.latest) this.renderWorld(performance.now() / 1000);
    this.requestRender();
  }

  get lightPreset(): LightPreset { return this.light.preset; }
  setLight(preset: LightPreset): void { if (!this.disposed) { this.light.setPreset(preset); this.wake(); } }
  setZoomMode(mode: ZoomMode): void { if (!this.disposed) { this.rig.zoomMode = mode; this.wake(); } }

  /** Attach the HUD built by `mountInspectors`; it is updated every frame from here on. */
  attachHud(hud: FarmHud | null): void { this.hud = this.lite ? null : hud; if (this.latest) this.syncDay(this.latest, true); this.requestRender(); }

  /** Run length (null = endless) and, for the dial's weather marks, where to find the weather seed. The sky and the dial both read the same tick. */
  setDay(cfg: DayConfig): void { this.day = cfg; if (this.latest) this.syncDay(this.latest, true); this.requestRender(); }

  private syncDay(snapshot: Snapshot, jump: boolean): void {
    const info = dayProgress(snapshot.tick, this.day.runTicks);
    this.light.setDay(info.progress, jump);
    this.hud?.dial.update(snapshot, info, this.day);
  }

  // ---------------------------------------------------------------- camera

  /** Re-frame the whole farm and re-arm automatic framing. */
  focusFarm(): void {
    if (this.disposed) return;
    this.followId = null;
    this.rig.fit();
    this.wake();
  }

  /** Cycle the camera through the drones, then back to free. */
  follow(): void {
    if (this.disposed || !this.latest) return;
    const count = this.latest.bots.length;
    const next = this.followId === null ? 0 : this.followId + 1;
    if (!count || next >= count) { this.followId = null; this.rig.follow(null); this.wake(); return; }
    this.followId = next;
    this.rig.follow(() => this.drones.position(next));
    this.wake();
  }

  rotate(steps: number): void { if (!this.disposed) { this.rig.rotate(steps); this.wake(); } }

  /** Turn the camera around the farm by an angle (the sunset result orbit). */
  orbitBy(radians: number): void { if (!this.disposed) { this.rig.spin(radians); this.wake(); } }

  /** True while the camera is still easing or the frame is still sliding beside the code slate (tests and tooling). */
  get cameraMoving(): boolean { return !this.disposed && this.rig.moving; }

  /** Move the camera over a world position (minimap). */
  jumpTo(x: number, z: number): void {
    if (this.disposed) return;
    this.followId = null;
    this.rig.focus(x, z);
    this.wake();
  }

  /** Glide over a ground point (splash, result screen, bot selection). */
  flyTo(target: { x: number; z: number }, o: { dist?: number } = {}): void {
    if (this.disposed) return;
    this.followId = null;
    this.rig.flyTo(target, o);
    this.wake();
  }

  /** Opening shot for the splash: high and far, easing down into the farm. */
  introGlide(): void {
    if (this.disposed) return;
    this.followId = null;
    this.rig.introGlide();
    this.wake();
  }

  /** The code slate's width (px, margin included) arrives from the stage; the frame moves into the free area. */
  private onSlate = (e: Event): void => {
    if (this.disposed) return;
    this.rig.setInset(Number((e as CustomEvent<number>).detail) || 0);
    this.wake();
  };

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
    this.wake();
    this.canvas.dispatchEvent(new CustomEvent('tendril:bot', { detail: { bot: id }, bubbles: true }));
  }

  /** Where a bot is drawn right now (world x, z), or null. */
  botPosition(id: number): { x: number; z: number } | null { return this.drones.position(id); }

  private projected = new THREE.Vector3();
  /** Canvas pixel under a world point at height `h`. `visible` is false behind the camera or well off screen. */
  project(x: number, z: number, h = 0): { x: number; y: number; visible: boolean } | null {
    if (this.disposed) return null;
    const v = this.projected.set(x, h, z).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * (this.canvas.clientWidth || 1), y: (-v.y * 0.5 + 0.5) * (this.canvas.clientHeight || 1), visible: v.z < 1 && Math.abs(v.x) <= 1.1 && Math.abs(v.y) <= 1.1 };
  }

  /** The bot drawn within reach of a ground point, nearest first. Reach grows when zoomed out so small drones stay clickable. */
  private botAt(x: number, z: number): number | null {
    const reach = Math.max(0.7, 16 / Math.max(1, this.tilePx));
    let best: number | null = null, bestD = reach;
    this.latest?.bots.forEach((_, id) => {
      const p = this.drones.position(id);
      const d = p ? Math.hypot(p.x - x, p.z - z) : Infinity;
      if (d < bestD) { bestD = d; best = id; }
    });
    return best;
  }

  private updateSelection(): void {
    const tile = this.selectedTile;
    this.tileRing.visible = !!tile && !!this.world.tileAt(tile.x, tile.y);
    if (tile) this.tileRing.position.set(tile.x, 0.045, tile.y);
    this.requestRender();
  }

  // ---------------------------------------------------------------- input

  private tap = (clientX: number, clientY: number): void => {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.rig.groundAt((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
    if (!hit) return;
    const bot = this.botAt(hit.x, hit.z);
    if (bot !== null) { this.selectBot(bot); return; }
    this.selectTile(Math.floor(hit.x + 0.5), Math.floor(hit.z + 0.5));
  };

  /** Selects an owned tile and tells the inspector. Scenery and unowned holes are never selectable simulation cells. */
  private selectTile(x: number, y: number): boolean {
    const tile = this.world.tileAt(x, y);
    if (!tile) return false;
    this.selectedTile = { x, y };
    if (this.selectedBot !== null) {
      this.selectedBot = null;
      this.drones.setSelected(null);
      delete this.canvas.dataset.selectedBot;
      this.canvas.dispatchEvent(new CustomEvent('tendril:bot', { detail: { bot: null }, bubbles: true }));
    }
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
    this.camMoved = true;
    this.canvas.dataset.cameraTarget = JSON.stringify(this.rig.target.toArray());
    this.canvas.dataset.cameraPosition = JSON.stringify(this.camera.position.toArray());
  };

  private resize = (): void => {
    if (this.disposed) return;
    const width = this.canvas.clientWidth || 1, height = this.canvas.clientHeight || 1;
    this.renderer.setPixelRatio(this.scale.ratio);
    this.renderer.setSize(width, height, false);
    this.exposeQuality(); // also the first time, so the canvas reports quality before anything changes
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.rig.resized(); // the slate offset is in pixels, so a new size needs it applied again
    this.requestRender();
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
    this.raf = 0;
    if (this.disposed || this.hidden) return;
    const gap = this.previousTime ? ms - this.previousTime : 0;
    const resumed = !this.previousTime || gap > 1000;
    const dt = resumed ? 0 : Math.min(gap / 1000, 0.1);
    this.previousTime = ms;
    // Dynamic resolution looks only at frames drawn back to back, never at the pause between bursts.
    if (resumed) this.scale.gap();
    else {
      if (this.scale.add(gap) !== null) this.applyRatio();
      // Auto gives up shadows when even the lowest resolution stays too slow for two seconds.
      if (this.quality === 'auto' && this.plan.shadows && !this.autoShadowsOff && this.scale.floorStrikes >= 2) { this.autoShadowsOff = true; this.light.setShadows(false); this.exposeQuality(); }
    }
    perfHook.frame?.(ms);
    const changed = this.draw(ms, dt);
    if (this.gate.next(ms, changed)) { this.schedule(); return; }
    // Quiet: the farm is at rest. Stop drawing until something wakes it.
    this.gate.stopped();
    this.previousTime = 0;
    if (this.hud) this.updateMinimap();
  };

  /** One frame. Returns true when something on screen was still moving (the loop keeps going until it settles). */
  private draw(ms: number, dt: number): boolean {
    const time = ms / 1000;
    if (this.followId !== null && !this.rig.following) this.followId = null;
    this.camMoved = false;
    this.rig.update(dt);
    const focus = this.rig.target;
    this.light.update(dt, focus, this.rig.distance);
    this.island.setDistance(this.rig.distance);
    this.renderWorld(time);
    this.drones.update(dt, time, this.light.glow, droneViewScale(this.tilePx));
    this.fx.update(dt, time, focus, this.light.glow, droneViewScale(this.tilePx));
    if (this.market) this.market.setPopupsHidden(this.lod === 2);
    if (this.hud) {
      this.hud.update({ following: this.rig.following, lod: this.lod, tilePx: this.tilePx, cells: this.stride });
      if (ms - this.lastMinimap > MINIMAP_MS) { this.lastMinimap = ms; this.updateMinimap(); }
    }
    // The shadow map is redrawn only when the sun, the shadow window or the farm changed, and at most ten times a
    // second while drones and carried crops move; once more when they stop.
    const sunChanged = this.light.takeShadowDirty();
    const farmChanged = this.world.rebuilds !== this.shadowWorld;
    this.shadowWorld = this.world.rebuilds;
    const dronesMoving = this.drones.moving;
    if (this.light.shadowsOn && this.shadowClock.due(ms, sunChanged || farmChanged, dronesMoving)) this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
    this.canvas.dataset.sceneReady = String(this.world.tileCount > 0);
    if (this.world.tileCount > 0) boot.done('frame');
    return this.camMoved || this.rig.moving || dronesMoving || this.fx.active || this.light.busy;
  }

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
    this.raf = 0;
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('tendril:slate-inset', this.onSlate);
    this.canvas.removeEventListener('wheel', this.wake);
    this.canvas.removeEventListener('pointerdown', this.wake);
    this.canvas.removeEventListener('pointermove', this.pointerWake);
    this.canvas.removeEventListener('pointerup', this.wake);
    window.removeEventListener('keydown', this.keyWake);
    window.removeEventListener('keyup', this.keyWake);
    this.offSettings();
    document.removeEventListener('visibilitychange', this.visibility);
    window.clearInterval(this.marketTimer);
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

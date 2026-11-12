import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { AssetLoader, disposeModels, type AssetModel, type AssetPart, type AssetStatus } from './asset-loader';
import type { Snapshot } from './sim-types';
import { BUILDING_MODELS, CROPS, fallbackModel, ITEM_NAMES, matte } from './fallback-models';

import { OverlayLayer, unit, type FarmOverlay } from './farm-overlay';
import { sceneryPlacements, tileBounds, type Bounds, type Placement } from './farm-scenery';
export type { FarmOverlay };
type Tile = Snapshot['tiles'][number];
type Batch = { model: AssetModel; meshes: THREE.InstancedMesh[]; capacity: number; count: number };
const SKY = { clear: 0xb9d5de, rain: 0x80969e, frost: 0xdce8ec };
const key = (x: number, y: number): string => `${x},${y}`;

export class FarmView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
  private controls: OrbitControls;
  private sun = new THREE.DirectionalLight(0xfff2d8, 2);
  private loader: AssetLoader;
  private fallbacks = new Map<string, AssetModel>();
  private batches = new Map<string, Batch>();
  private latest: Snapshot | null = null;
  private tileLookup = new Map<string, Tile>();
  private terrainSignature = '';
  private scenery = new Map<string, Placement[]>();
  private carriedNames: string[] = [];
  private botPositions: THREE.Vector3[] = [];
  private botTargets: THREE.Vector3[] = [];
  private botAngles: number[] = [];
  private overlay: FarmOverlay = 'none';
  private overlayLayer: OverlayLayer;
  /** Read by the renderer tests. */
  get overlayMesh(): THREE.InstancedMesh | null { return this.overlayLayer.mesh; }
  private selectedTile: { x: number; y: number } | null = null;
  private selectedBot: number | null = null;
  private tileRing = new THREE.Mesh(new THREE.RingGeometry(0.47 * Math.SQRT2, 0.51 * Math.SQRT2, 4).rotateZ(Math.PI / 4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffedb4, depthWrite: false }));
  private botRing = new THREE.Mesh(new THREE.TorusGeometry(0.37, 0.025, 4, 24).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd66a }));
  private meadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), matte(0x759464));
  private sky = new THREE.Color(SKY.clear);
  private framed = false;
  /** Plot count at the last update, to notice when land is bought. */
  private plotCount = 0;
  /** Camera pose right after the last automatic framing; any difference later means the user moved the camera. */
  private autoPose: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private reframe: { from: { position: THREE.Vector3; target: THREE.Vector3 }; to: { position: THREE.Vector3; target: THREE.Vector3 }; start: number } | null = null;
  private disposed = false;
  private raf = 0;
  private previousTime = 0;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private raycaster = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private pointerStart: { x: number; y: number; id: number } | null = null;
  private ro: ResizeObserver;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = this.sky;
    this.scene.fog = new THREE.Fog(this.sky, 55, 150);
    this.scene.add(new THREE.HemisphereLight(0xe6f2ff, 0x65754c, 1.25));
    this.sun.position.set(-12, 24, 10);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.bias = -0.0002;
    this.scene.add(this.sun, this.sun.target);
    this.meadow.position.y = -0.48;
    this.meadow.receiveShadow = true;
    this.meadow.scale.set(100, 1, 100);
    this.scene.add(this.meadow, this.tileRing, this.botRing);
    this.tileRing.visible = this.botRing.visible = false;
    this.camera.position.set(10, 14, 16);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.minDistance = 3;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.15;
    this.controls.target.set(3.5, 0, 3.5);
    this.controls.addEventListener('change', this.cameraStatus);
    this.controls.addEventListener('start', this.cancelReframe);
    this.ro = new ResizeObserver(this.resize);
    this.ro.observe(canvas.parentElement ?? canvas);
    window.addEventListener('resize', this.resize);
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointercancel', this.pointerCancel);
    canvas.dataset.overlay = 'none';
    canvas.dataset.modelsLoaded = '0';
    canvas.dataset.sceneReady = 'false';
    this.overlayLayer = new OverlayLayer(this.scene);
    this.loader = new AssetLoader(this.assetsChanged);
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

  update(snapshot: Snapshot): void {
    if (this.disposed) return;
    this.latest = snapshot;
    this.sky.set(SKY[snapshot.weather]);
    this.tileLookup = new Map(snapshot.tiles.map((tile) => [key(tile.x, tile.y), tile]));
    const signature = snapshot.tiles.map((tile) => key(tile.x, tile.y)).join(';');
    if (signature !== this.terrainSignature) { this.terrainSignature = signature; this.buildScenery(snapshot); }
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
    for (const [name, positions] of this.scenery) {
      const batch = this.batch(name, positions.length);
      for (const position of positions) this.place(batch, position, undefined, name === 'tile_terrace_wall' ? -0.2 : -0.46);
    }
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
    });
    if (snapshot.bots.length) this.batch('bot_tender', snapshot.bots.length);
    this.prepareCarried(snapshot);
    this.updateBots(0, 0);
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

  /** True while the camera is where automatic framing last left it (or is still easing there). */
  private autoFramingArmed(): boolean {
    if (this.reframe) return true;
    const pose = this.autoPose;
    return !!pose && this.camera.position.distanceTo(pose.position) < 0.05 && this.controls.target.distanceTo(pose.target) < 0.05;
  }

  /** Camera pose that shows every owned tile, looking along `direction` (from the target towards the camera). */
  private framingPose(direction: THREE.Vector3): { position: THREE.Vector3; target: THREE.Vector3 } | null {
    const bounds = this.latest ? this.bounds(this.latest) : null;
    if (!bounds) return null;
    const { x0, x1, z0, z1 } = bounds;
    const radius = Math.hypot(x1 - x0, z1 - z0) / 2 + 0.8;
    const fov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const angle = Math.min(fov, Math.atan(Math.tan(fov) * this.camera.aspect));
    const distance = radius / Math.sin(angle) * 1.08;
    const target = new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2);
    return { target, position: target.clone().add(direction.clone().normalize().multiplyScalar(distance)) };
  }

  private startReframe(): void {
    const to = this.framingPose(this.camera.position.clone().sub(this.controls.target));
    if (!to) return;
    if (this.reducedMotion.matches) { this.applyPose(to); return; }
    this.clearCameraDamping();
    this.reframe = { from: { position: this.camera.position.clone(), target: this.controls.target.clone() }, to, start: performance.now() };
  }

  private cancelReframe = (): void => { this.reframe = null; };

  private applyPose(pose: { position: THREE.Vector3; target: THREE.Vector3 }): void {
    this.clearCameraDamping();
    this.controls.target.copy(pose.target);
    this.camera.position.copy(pose.position);
    this.controls.update();
    this.autoPose = { position: this.camera.position.clone(), target: this.controls.target.clone() };
    this.cameraStatus();
  }

  private stepReframe(time: number): void {
    const move = this.reframe;
    if (!move) return;
    const t = Math.min(1, (time - move.start) / 600);
    const e = t * t * (3 - 2 * t);
    if (t >= 1) { this.reframe = null; this.applyPose(move.to); return; }
    this.controls.target.lerpVectors(move.from.target, move.to.target, e);
    this.camera.position.lerpVectors(move.from.position, move.to.position, e);
  }

  private bounds(snapshot: Snapshot): Bounds | null { return tileBounds(snapshot.tiles); }

  private buildScenery(snapshot: Snapshot): void {
    this.scenery.clear();
    const bounds = this.bounds(snapshot);
    if (!bounds) return;
    const { x0, x1, z0, z1 } = bounds;
    for (const [name, placements] of sceneryPlacements(snapshot.tiles, bounds, (x, y) => this.tileLookup.has(key(x, y)))) this.scenery.set(name, placements);
    const extent = Math.max(x1 - x0, z1 - z0);
    this.meadow.position.set((x0 + x1) / 2, -0.48, (z0 + z1) / 2);
    this.meadow.scale.set(extent + 150, 1, extent + 150);
    this.controls.maxDistance = Math.max(80, extent * 8);
    this.camera.far = Math.max(500, extent * 12);
    this.camera.updateProjectionMatrix();
    const shadowExtent = Math.min(40, extent * 0.65 + 4);
    const camera = this.sun.shadow.camera;
    camera.left = camera.bottom = -shadowExtent;
    camera.right = camera.top = shadowExtent;
    camera.near = 0.5; camera.far = 100;
    camera.updateProjectionMatrix();
    this.sun.target.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    this.sun.position.copy(this.sun.target.position).add(new THREE.Vector3(-12, 24, 10));
    const fog = this.scene.fog as THREE.Fog;
    fog.near = Math.max(55, extent * 3);
    fog.far = Math.max(150, extent * 6);
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
  focusFarm(): void {
    if (this.disposed || !this.latest) return;
    this.reframe = null;
    const pose = this.framingPose(new THREE.Vector3(0.35, 1.2, 1));
    if (pose) this.applyPose(pose);
  }

  selectBot(id: number): void {
    if (this.disposed || !Number.isInteger(id) || !this.latest?.bots[id]) return;
    this.selectedBot = id; // Snapshot and Sprout bot IDs are zero-based.
    const bot = this.latest.bots[id];
    this.clearCameraDamping();
    this.controls.target.set(bot.x, 0, bot.y);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(3, 7, 8));
    this.controls.update();
    this.canvas.dataset.selectedBot = String(id);
    this.updateSelection();
    this.cameraStatus();
  }

  private clearCameraDamping(): void {
    // OrbitControls clears residual pan/rotation on a non-damped update.
    // Do this BEFORE setting the explicit target, never on snapshot updates.
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
  }

  private updateSelection(): void {
    const tile = this.selectedTile;
    this.tileRing.visible = !!tile && this.tileLookup.has(key(tile.x, tile.y));
    if (tile) this.tileRing.position.set(tile.x, 0.045, tile.y);
    const position = this.selectedBot === null ? undefined : this.botPositions[this.selectedBot];
    this.botRing.visible = !!position;
    if (position) this.botRing.position.set(position.x, 0.04, position.z);
  }

  private pointerDown = (event: PointerEvent): void => {
    if (event.isPrimary && event.button === 0) this.pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
    else this.pointerStart = null;
  };
  private pointerCancel = (): void => { this.pointerStart = null; };
  private pointerUp = (event: PointerEvent): void => {
    const start = this.pointerStart; this.pointerStart = null;
    if (this.disposed || !start || start.id !== event.pointerId || Math.hypot(start.x - event.clientX, start.y - event.clientY) > 5) return;
    const rect = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.ground, new THREE.Vector3());
    if (!hit) return;
    const x = Math.floor(hit.x + 0.5), y = Math.floor(hit.z + 0.5);
    const tile = this.tileLookup.get(key(x, y));
    if (!tile) return; // Scenery and unowned holes are never selectable simulation cells.
    this.selectedTile = { x, y };
    this.updateSelection();
    this.canvas.dispatchEvent(new CustomEvent('tendril:tile', { detail: { x, y, scan: { ...tile } }, bubbles: true }));
  };

  private cameraStatus = (): void => {
    this.canvas.dataset.cameraTarget = JSON.stringify(this.controls.target.toArray());
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
  private updateBots(delta: number, time: number): void {
    const batch = this.batches.get('bot_tender');
    if (!batch) return;
    batch.count = 0;
    const blend = 1 - Math.exp(-delta * 12);
    for (let id = 0; id < this.botPositions.length; id++) {
      const position = this.botPositions[id];
      position.lerp(this.botTargets[id], this.reducedMotion.matches ? 1 : blend);
      this.place(batch, { x: position.x, z: position.z, rotation: this.botAngles[id] }, undefined, this.reducedMotion.matches ? 0 : 0.015 + Math.sin(time / 350 + id) * 0.012);
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
        this.place(batch, { x: position.x, z: position.z, rotation: item }, undefined, 0.78 + level++ * 0.17);
      });
    });
    for (const name of this.carriedNames) { const batch = this.batches.get(name); if (batch) this.finish(batch); }
  }
  private loop = (time: number): void => {
    if (this.disposed) return;
    const delta = this.previousTime ? Math.min((time - this.previousTime) / 1000, 0.1) : 0;
    this.previousTime = time;
    this.updateBots(delta, time);
    this.stepReframe(time);
    this.controls.update();
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
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    this.canvas.removeEventListener('pointerup', this.pointerUp);
    this.canvas.removeEventListener('pointercancel', this.pointerCancel);
    this.controls.removeEventListener('change', this.cameraStatus);
    this.controls.removeEventListener('start', this.cancelReframe);
    this.controls.dispose();
    for (const batch of this.batches.values()) for (const mesh of batch.meshes) { this.scene.remove(mesh); mesh.dispose(); }
    this.batches.clear();
    this.loader.dispose();
    disposeModels(this.fallbacks.values());
    this.fallbacks.clear();
    this.overlayLayer.dispose();
    const remaining: AssetPart[] = [];
    this.scene.traverse((object) => { if (object instanceof THREE.Mesh) remaining.push({ geometry: object.geometry, material: object.material }); });
    disposeModels([{ parts: remaining }]);
    this.sun.dispose();
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
    this.scenery.clear();
    this.botPositions = []; this.botTargets = []; this.botAngles = [];
  }
}

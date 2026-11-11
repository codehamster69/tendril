import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { AssetLoader, disposeModels, type AssetModel, type AssetPart, type AssetStatus } from './asset-loader';
import type { Snapshot } from './sim-types';

export type FarmOverlay = 'none' | 'moisture' | 'nitrogen' | 'fatigue';
type Tile = Snapshot['tiles'][number];
type Batch = { model: AssetModel; meshes: THREE.InstancedMesh[]; capacity: number; count: number };
type Placement = { x: number; z: number; rotation?: number; scale?: number; depth?: number };
const CROPS = ['', 'carrot', 'wheat', 'clover', 'pumpkin'];
const CROP_COLORS = [0, 0xf08a24, 0xe6c34a, 0x8fbf6a, 0xd2601a];
const SKY = { clear: 0xb9d5de, rain: 0x80969e, frost: 0xdce8ec };
const OVERLAYS = {
  moisture: [new THREE.Color('#e0bb79'), new THREE.Color('#287caf')],
  nitrogen: [new THREE.Color('#e0c898'), new THREE.Color('#468653')],
  fatigue: [new THREE.Color('#8fc3a4'), new THREE.Color('#bf6650')],
};
const key = (x: number, y: number): string => `${x},${y}`;
const unit = (value: number): number => THREE.MathUtils.clamp(value / 100, 0, 1);
const matte = (color: number): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
const part = (geometry: THREE.BufferGeometry, color: number): AssetPart => ({ geometry, material: matte(color) });

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
  private botPositions: THREE.Vector3[] = [];
  private botTargets: THREE.Vector3[] = [];
  private botAngles: number[] = [];
  private overlay: FarmOverlay = 'none';
  private overlayMesh: THREE.InstancedMesh | null = null;
  private tileGuides: THREE.InstancedMesh | null = null;
  private overlayCapacity = 0;
  private selectedTile: { x: number; y: number } | null = null;
  private selectedBot: number | null = null;
  private tileRing = new THREE.Mesh(new THREE.RingGeometry(0.47 * Math.SQRT2, 0.51 * Math.SQRT2, 4).rotateZ(Math.PI / 4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffedb4, depthWrite: false }));
  private botRing = new THREE.Mesh(new THREE.TorusGeometry(0.37, 0.025, 4, 24).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd66a }));
  private meadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), matte(0x759464));
  private sky = new THREE.Color(SKY.clear);
  private framed = false;
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
    this.ro = new ResizeObserver(this.resize);
    this.ro.observe(canvas.parentElement ?? canvas);
    window.addEventListener('resize', this.resize);
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointercancel', this.pointerCancel);
    canvas.dataset.overlay = 'none';
    canvas.dataset.modelsLoaded = '0';
    canvas.dataset.sceneReady = 'false';
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
    const existing = this.fallbacks.get(name);
    if (existing) return existing;
    let parts: AssetPart[];
    if (name.startsWith('tile_') && name !== 'tile_terrace_wall') {
      const color = name === 'tile_soil' ? 0x7a5230 : name === 'tile_wet' ? 0x59402d : name === 'tile_path' ? 0xc5ae82 : 0x5a9e4b;
      parts = [part(new THREE.BoxGeometry(0.98, 0.2, 0.98).translate(0, -0.1, 0), color)];
    } else if (name.startsWith('crop_')) {
      const crop = CROPS.findIndex((id) => id && name.startsWith(`crop_${id}_`));
      const stage = Number(name.slice(-1));
      const size = 0.22 + stage * 0.22;
      const geometry = crop === 4 ? new THREE.IcosahedronGeometry(0.36 * size, 1)
        : crop === 3 ? new THREE.IcosahedronGeometry(0.3 * size, 0)
        : new THREE.ConeGeometry(0.24 * size, 0.75 * size, 5);
      geometry.computeBoundingBox();
      geometry.translate(0, -geometry.boundingBox!.min.y, 0);
      parts = [part(geometry, CROP_COLORS[crop] ?? 0x8fbf6a)];
    } else if (name === 'bot_tender') {
      // A tiny enamel helper with a cream face and paired dark eyes while the GLB loads.
      parts = [
        part(new THREE.BoxGeometry(0.4, 0.3, 0.36).translate(0, 0.3, 0), 0x4a90d9),
        part(new THREE.IcosahedronGeometry(0.23, 1).translate(0, 0.58, 0), 0xdfe6ee),
        part(new THREE.BoxGeometry(0.05, 0.07, 0.025).translate(-0.08, 0.6, 0.21), 0x2e3848),
        part(new THREE.BoxGeometry(0.05, 0.07, 0.025).translate(0.08, 0.6, 0.21), 0x2e3848),
        part(new THREE.CylinderGeometry(0.025, 0.025, 0.12, 5).translate(0, 0.84, 0), 0xf8cb3c),
      ];
    } else if (name === 'prop_barn') {
      parts = [part(new THREE.BoxGeometry(0.84, 0.64, 0.84).translate(0, 0.32, 0), 0xb0302a),
        part(new THREE.CylinderGeometry(0.64, 0.64, 0.92, 3).rotateY(Math.PI / 2).rotateX(Math.PI / 2).translate(0, 0.8, 0), 0x6e1a16),
        part(new THREE.BoxGeometry(0.28, 0.42, 0.025).translate(0, 0.21, 0.43), 0x664428)];
    } else if (name === 'prop_tree') {
      parts = [part(new THREE.CylinderGeometry(0.1, 0.15, 0.8, 5).translate(0, 0.4, 0), 0x664428),
        part(new THREE.IcosahedronGeometry(0.7, 0).scale(1, 1.25, 1).translate(0, 1.25, 0), 0x3e7a33)];
    } else if (name === 'prop_rocks') {
      parts = [part(new THREE.IcosahedronGeometry(0.4, 0).scale(1.2, 0.6, 0.8).translate(0, 0.18, 0), 0x8f8d87)];
    } else {
      parts = [part(new THREE.BoxGeometry(0.98, 0.2, 1).translate(0, -0.1, 0), 0x77766c)];
    }
    const model = { parts };
    this.fallbacks.set(name, model);
    return model;
  }

  private batch(name: string, capacity: number): Batch {
    const model = this.loader.models.get(name) ?? this.fallback(name);
    let batch = this.batches.get(name);
    if (batch && (batch.model !== model || capacity > batch.capacity)) {
      for (const mesh of batch.meshes) { this.scene.remove(mesh); mesh.dispose(); }
      if (batch.model !== model && this.fallbacks.get(name) === batch.model) {
        disposeModels([batch.model]);
        this.fallbacks.delete(name);
      }
      this.batches.delete(name);
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
      this.batches.set(name, batch);
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
      if (tile.crop >= 1 && tile.crop <= 4) {
        const crop = `crop_${CROPS[tile.crop]}_s${THREE.MathUtils.clamp(Math.trunc(tile.stage), 0, 3)}`;
        required.set(crop, (required.get(crop) ?? 0) + 1);
      }
    }
    const colors: { x: number; y: number; color: string }[] = [];
    for (const tile of snapshot.tiles) {
      const terrain = tile.x === 0 && tile.y === 0 ? 'tile_path' : tile.tilled ? 'tile_soil' : 'tile_grass';
      // Moisture is an integer percentage, NOT a 0..1 value. Modulate the source palette.
      this.color.setScalar(1 - 0.32 * unit(tile.moisture));
      this.place(this.batch(terrain, required.get(terrain)!), { x: tile.x, z: tile.y }, this.color);
      if (colors.length < 16) colors.push({ x: tile.x, y: tile.y, color: this.color.getHexString() });
      if (tile.crop >= 1 && tile.crop <= 4) {
        const stage = THREE.MathUtils.clamp(Math.trunc(tile.stage), 0, 3);
        const crop = `crop_${CROPS[tile.crop]}_s${stage}`;
        this.place(this.batch(crop, required.get(crop)!), { x: tile.x, z: tile.y });
      }
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
    this.updateBots(0, 0);
    for (const batch of this.batches.values()) this.finish(batch);
    this.updateOverlay();
    this.updateSelection();
    this.canvas.dataset.renderedTiles = String(snapshot.tiles.length);
    this.canvas.dataset.tileColors = JSON.stringify(colors);
    this.canvas.dataset.modelInstances = JSON.stringify(Object.fromEntries([...this.batches].map(([name, batch]) => [name, batch.count])));
    if (!this.framed && snapshot.tiles.length) { this.focusFarm(); this.framed = true; }
  }

  private bounds(snapshot: Snapshot): { x0: number; x1: number; z0: number; z1: number } | null {
    if (!snapshot.tiles.length) return null;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const tile of snapshot.tiles) { x0 = Math.min(x0, tile.x - 0.5); x1 = Math.max(x1, tile.x + 0.5); z0 = Math.min(z0, tile.y - 0.5); z1 = Math.max(z1, tile.y + 0.5); }
    return { x0, x1, z0, z1 };
  }

  private buildScenery(snapshot: Snapshot): void {
    this.scenery.clear();
    const bounds = this.bounds(snapshot);
    if (!bounds) return;
    const { x0, x1, z0, z1 } = bounds;
    const walls: Placement[] = [];
    for (const tile of snapshot.tiles) {
      for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        if (!this.tileLookup.has(key(tile.x + dx, tile.y + dz))) {
          // AT's riser is a full 1x1 tile, so narrow its depth and place it
          // wholly outside the playable edge, below the unchanged ground plane.
          walls.push({ x: tile.x + dx * 0.54, z: tile.y + dz * 0.54, rotation: dx ? Math.PI / 2 : 0, depth: 0.08 });
        }
      }
    }
    this.scenery.set('tile_terrace_wall', walls);
    const trees: Placement[] = [], rocks: Placement[] = [];
    // Sparse deterministic clusters remain outside the entire owned bounding rectangle.
    for (const fraction of [0.18, 0.76]) {
      trees.push({ x: x0 - 3, z: z0 + (z1 - z0) * fraction, scale: 0.9 }, { x: x1 + 3.2, z: z0 + (z1 - z0) * fraction, scale: 1.1 },
        { x: x0 + (x1 - x0) * fraction, z: z0 - 3, scale: 0.8 });
      rocks.push({ x: x0 - 2, z: z1 + fraction, rotation: fraction * 4 }, { x: x1 + 2, z: z1 - fraction, scale: 0.8 });
    }
    this.scenery.set('prop_tree', trees);
    this.scenery.set('prop_rocks', rocks);
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
    if (this.latest.tiles.length > this.overlayCapacity) {
      if (this.overlayMesh) { this.scene.remove(this.overlayMesh); this.overlayMesh.geometry.dispose(); (this.overlayMesh.material as THREE.Material).dispose(); this.overlayMesh.dispose(); }
      if (this.tileGuides) { this.scene.remove(this.tileGuides); this.tileGuides.geometry.dispose(); (this.tileGuides.material as THREE.Material).dispose(); this.tileGuides.dispose(); }
      this.overlayCapacity = Math.max(64, this.latest.tiles.length * 2);
      this.tileGuides = new THREE.InstancedMesh(
        new THREE.RingGeometry(0.475 * Math.SQRT2, 0.495 * Math.SQRT2, 4).rotateZ(Math.PI / 4).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x36462f, transparent: true, opacity: 0.16, depthWrite: false }), this.overlayCapacity);
      this.scene.add(this.tileGuides);
      this.overlayMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.95, 0.012, 0.95), matte(0xffffff), this.overlayCapacity);
      this.overlayMesh.receiveShadow = true;
      this.scene.add(this.overlayMesh);
    }
    const mesh = this.overlayMesh;
    if (!mesh) return;
    const guides = this.tileGuides;
    if (guides) {
      guides.count = this.latest.tiles.length;
      this.latest.tiles.forEach((tile, index) => {
        this.dummy.position.set(tile.x, 0.003, tile.y);
        this.dummy.rotation.set(0, 0, 0); this.dummy.scale.setScalar(1); this.dummy.updateMatrix();
        guides.setMatrixAt(index, this.dummy.matrix);
      });
      guides.instanceMatrix.needsUpdate = true;
      guides.computeBoundingSphere();
    }
    mesh.visible = this.overlay !== 'none';
    const colors: { x: number; y: number; color: string }[] = [];
    if (this.overlay !== 'none') {
      const [low, high] = OVERLAYS[this.overlay];
      const overlay = this.overlay;
      this.latest.tiles.forEach((tile, index) => {
        this.dummy.position.set(tile.x, 0.01, tile.y);
        this.dummy.rotation.set(0, 0, 0); this.dummy.scale.setScalar(1); this.dummy.updateMatrix();
        mesh.setMatrixAt(index, this.dummy.matrix);
        this.color.copy(low).lerp(high, unit(tile[overlay]));
        mesh.setColorAt(index, this.color);
        if (index < 16) colors.push({ x: tile.x, y: tile.y, color: this.color.getHexString() });
      });
      mesh.count = this.latest.tiles.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    this.canvas.dataset.overlayColors = JSON.stringify(colors);
  }

  focusFarm(): void {
    if (this.disposed || !this.latest) return;
    const bounds = this.bounds(this.latest);
    if (!bounds) return;
    const { x0, x1, z0, z1 } = bounds;
    const radius = Math.hypot(x1 - x0, z1 - z0) / 2 + 0.8;
    const fov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const angle = Math.min(fov, Math.atan(Math.tan(fov) * this.camera.aspect));
    const distance = radius / Math.sin(angle) * 1.08;
    this.clearCameraDamping();
    this.controls.target.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(0.35, 1.2, 1).normalize().multiplyScalar(distance));
    this.controls.update();
    this.cameraStatus();
  }

  selectBot(id: number): void {
    if (this.disposed || !Number.isInteger(id) || !this.latest?.bots[id]) return;
    this.selectedBot = id; // Snapshot and Lua bot IDs are zero-based.
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
    this.updateSelection();
  }
  private loop = (time: number): void => {
    if (this.disposed) return;
    const delta = this.previousTime ? Math.min((time - this.previousTime) / 1000, 0.1) : 0;
    this.previousTime = time;
    this.updateBots(delta, time);
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
    this.controls.dispose();
    for (const batch of this.batches.values()) for (const mesh of batch.meshes) { this.scene.remove(mesh); mesh.dispose(); }
    this.batches.clear();
    this.loader.dispose();
    disposeModels(this.fallbacks.values());
    this.fallbacks.clear();
    if (this.overlayMesh) this.overlayMesh.dispose();
    if (this.tileGuides) this.tileGuides.dispose();
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
    this.overlayMesh = this.tileGuides = null;
    this.latest = null;
    this.tileLookup.clear();
    this.scenery.clear();
    this.botPositions = []; this.botTargets = []; this.botAngles = [];
  }
}

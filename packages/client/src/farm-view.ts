import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Snapshot } from './sim-types';

const CROP_COLORS = [0, 0xf08a24, 0xe6c34a, 0x8fbf6a, 0xd2601a]; // index = crop id
const SKY = { clear: 0x87b8e8, rain: 0x5d6670, frost: 0xdce8f2 };
const GRASS = new THREE.Color(0x5a9e4b);
const SOIL = new THREE.Color(0x7a5230);
const WET = new THREE.Color(0.55, 0.55, 0.6);

export class FarmView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  private controls: OrbitControls;
  private tiles: THREE.InstancedMesh | null = null;
  private tileCap = 0;
  private tileCount = -1;
  private crops: THREE.InstancedMesh[] = [];
  private botMeshes: THREE.Group[] = [];
  private botTargets: THREE.Vector3[] = [];
  private sky = new THREE.Color(SKY.clear);
  private framed = false;
  private raf = 0;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private ro: ResizeObserver;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = this.sky;
    this.scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x4a5a3a, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(30, 50, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -40; c.right = 40; c.top = 40; c.bottom = -40; c.near = 1; c.far = 150;
    this.scene.add(sun);

    this.addBarn();
    this.addCrops(64);

    this.camera.position.set(8, 14, 16);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.controls.target.set(8, 0, 4);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement ?? canvas);
    window.addEventListener('resize', this.resize);
    this.resize();
    this.raf = requestAnimationFrame(this.loop);
  }

  private addBarn(): void {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.9), new THREE.MeshStandardMaterial({ color: 0xb0302a }));
    body.position.y = 0.35;
    const roofGeo = new THREE.CylinderGeometry(0.62, 0.62, 0.9, 3);
    const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({ color: 0x6e1a16 }));
    roof.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    roof.rotation.order = 'ZXY';
    roof.position.y = 0.95;
    for (const m of [body, roof]) { m.castShadow = true; m.receiveShadow = true; }
    g.add(body, roof);
    g.position.set(0, 0, 0);
    this.scene.add(g);
  }

  private addCrops(cap: number): void {
    for (const m of this.crops) { this.scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.crops = [];
    for (let id = 1; id <= 4; id++) {
      const geo = id === 1 ? new THREE.ConeGeometry(0.3, 0.6, 8).rotateX(Math.PI)
        : id === 4 ? new THREE.SphereGeometry(0.4, 12, 8)
        : id === 3 ? new THREE.IcosahedronGeometry(0.35, 0)
        : new THREE.ConeGeometry(0.25, 0.8, 6);
      geo.computeBoundingBox();
      geo.translate(0, -geo.boundingBox!.min.y, 0); // sit on ground
      const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: CROP_COLORS[id] }), cap);
      mesh.castShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.crops.push(mesh);
    }
    this.cropCap = cap;
  }
  private cropCap = 0;

  private ensureBots(n: number): void {
    while (this.botMeshes.length < n) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.35, 0.45), new THREE.MeshStandardMaterial({ color: 0x4a90d9 }));
      body.position.y = 0.3;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), new THREE.MeshStandardMaterial({ color: 0xdfe6ee }));
      head.position.y = 0.65;
      body.castShadow = head.castShadow = true;
      g.add(body, head);
      this.scene.add(g);
      this.botMeshes.push(g);
      this.botTargets.push(new THREE.Vector3(NaN, 0, 0));
    }
    while (this.botMeshes.length > n) {
      this.scene.remove(this.botMeshes.pop()!);
      this.botTargets.pop();
    }
  }

  update(s: Snapshot): void {
    // sky
    this.sky.set(SKY[s.weather]);

    // tiles
    if (s.tiles.length > this.tileCap) {
      if (this.tiles) { this.scene.remove(this.tiles); this.tiles.geometry.dispose(); (this.tiles.material as THREE.Material).dispose(); this.tiles.dispose(); }
      this.tileCap = Math.max(s.tiles.length, Math.ceil(this.tileCap * 1.5));
      const geo = new THREE.BoxGeometry(1, 0.2, 1);
      geo.translate(0, -0.1, 0);
      this.tiles = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff }), this.tileCap);
      this.tiles.receiveShadow = true;
      this.tiles.frustumCulled = false;
      this.scene.add(this.tiles);
      this.tileCount = -1;
    }
    if (s.tiles.length > this.cropCap) this.addCrops(Math.max(s.tiles.length, this.cropCap * 2));

    const tiles = this.tiles;
    if (tiles) {
      const rebuild = tiles.count !== s.tiles.length || this.tileCount !== s.tiles.length;
      tiles.count = s.tiles.length;
      const counts = [0, 0, 0, 0, 0];
      for (let i = 0; i < s.tiles.length; i++) {
        const t = s.tiles[i];
        if (rebuild) {
          this.dummy.position.set(t.x, 0, t.y);
          this.dummy.scale.setScalar(1);
          this.dummy.updateMatrix();
          tiles.setMatrixAt(i, this.dummy.matrix);
        }
        this.color.copy(t.tilled ? SOIL : GRASS).multiplyScalar(1 - 0.45 * Math.min(1, t.moisture));
        if (t.moisture > 0.7) this.color.lerp(WET, 0.1);
        tiles.setColorAt(i, this.color);
        if (t.crop >= 1 && t.crop <= 4) {
          const m = this.crops[t.crop - 1];
          const k = counts[t.crop]++;
          const sc = 0.25 + 0.25 * Math.min(3, Math.max(0, t.stage));
          this.dummy.position.set(t.x, 0, t.y);
          this.dummy.scale.setScalar(sc);
          this.dummy.updateMatrix();
          m.setMatrixAt(k, this.dummy.matrix);
        }
      }
      this.tileCount = s.tiles.length;
      tiles.instanceMatrix.needsUpdate = true;
      if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;
      for (let id = 1; id <= 4; id++) {
        this.crops[id - 1].count = counts[id];
        this.crops[id - 1].instanceMatrix.needsUpdate = true;
      }
    }

    // bots
    this.ensureBots(s.bots.length);
    s.bots.forEach((b, i) => {
      const tg = this.botTargets[i];
      if (Number.isNaN(tg.x)) this.botMeshes[i].position.set(b.x, 0, b.y);
      tg.set(b.x, 0, b.y);
    });

    if (!this.framed && s.plots.length) { this.frame(s); this.framed = true; }
  }

  private frame(s: Snapshot): void {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of s.plots) { x0 = Math.min(x0, p.px * 8); x1 = Math.max(x1, p.px * 8 + 7); y0 = Math.min(y0, p.py * 8); y1 = Math.max(y1, p.py * 8 + 7); }
    const cx = (x0 + x1) / 2, cz = (y0 + y1) / 2;
    const size = Math.max(x1 - x0 + 1, y1 - y0 + 1);
    const dist = size * 1.1 / Math.tan((this.camera.fov * Math.PI) / 360) / 1.6 + 6;
    const pol = (40 * Math.PI) / 180; // 50 deg below horizontal => 40 deg from vertical
    this.controls.target.set(cx, 0, cz);
    this.camera.position.set(cx, Math.cos(pol) * dist, cz + Math.sin(pol) * dist);
    this.controls.update();
  }

  private resize = (): void => {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private loop = (t: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    const k = 0.2;
    this.botMeshes.forEach((m, i) => {
      const tg = this.botTargets[i];
      m.position.x += (tg.x - m.position.x) * k;
      m.position.z += (tg.z - m.position.z) * k;
      m.position.y = 0.03 + Math.sin(t / 250 + i) * 0.03;
    });
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.ro.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }
}

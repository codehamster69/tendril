import * as THREE from 'three';
import { motionQuery } from './settings.ts';

/** Pooled sparkle bursts plus fireflies that stay around the camera focus. Nothing is allocated per frame. */

const POOL = 500;
const FIREFLIES = 160;
const POPS = 48;
const POP_LIFE = 0.22; // seconds; the whole pop stays under 250 ms
const FIREFLY_HALF = 24; // fireflies live in a square of this half-width around the focus

/** Wrap `v` into [centre - half, centre + half). Used to keep fireflies near the camera focus on an unbounded farm. */
export function wrapAround(v: number, centre: number, half: number): number {
  const span = half * 2;
  return centre - half + ((((v - (centre - half)) % span) + span) % span);
}

/** Size multiplier for point sprites so they stay readable when the view is zoomed far out. */
export function pointScale(scale: number): number {
  return Math.max(1, scale * 0.5);
}

/** Firefly opacity from the light rig's glow (0.2..1.5). */
export function fireflyOpacity(glow: number): number {
  return Math.min(0.85, 0.12 + 0.45 * glow);
}

/** Pop animation at age `t` of 0..1: scale grows fast then settles, brightness fades out. */
export function popCurve(t: number): { scale: number; fade: number } {
  const u = Math.min(1, Math.max(0, t));
  return { scale: 0.45 + 0.85 * (1 - (1 - u) * (1 - u)), fade: 1 - u * u };
}

export class FarmFx {
  /** Fireflies around the camera focus. Small embedded views turn them off. */
  get fireflies(): boolean { return this.fly.visible; }
  set fireflies(on: boolean) { this.fly.visible = on; }
  private pos = new Float32Array(POOL * 3);
  private col = new Float32Array(POOL * 3);
  private base = new Float32Array(POOL * 3);
  private vel = new Float32Array(POOL * 3);
  private life = new Float32Array(POOL);
  private head = 0;
  private points: THREE.Points;
  private fly: THREE.Points;
  private flyPos = new Float32Array(FIREFLIES * 3);
  private flySeed = new Float32Array(FIREFLIES);
  private flyReady = false;
  private tmp = new THREE.Color();
  private reduced = motionQuery;
  /** True while any sparkle is still flying (the farm view keeps drawing until they are gone). */
  active = false;

  private popMesh = new THREE.InstancedMesh(new THREE.RingGeometry(0.2, 0.3, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), POPS);
  private popAge = new Float32Array(POPS).fill(-1);
  private popX = new Float32Array(POPS);
  private popZ = new Float32Array(POPS);
  private popRgb = new Float32Array(POPS * 3);
  private popHead = 0;
  private popDirty = false;
  private popObj = new THREE.Object3D();
  private popTint = new THREE.Color();

  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    // Hidden below the world until used.
    for (let i = 0; i < POOL; i++) this.pos[i * 3 + 1] = -1000;
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.14, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.points.frustumCulled = false;
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(this.flyPos, 3));
    this.fly = new THREE.Points(fg, new THREE.PointsMaterial({ size: 0.1, color: 0xffd68a, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.fly.frustumCulled = false;
    this.popMesh.count = 0;
    this.popMesh.frustumCulled = false;
    this.popMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.points, this.fly, this.popMesh);
  }

  /** A short ring pop at a tile when something is planted or harvested. Skipped under reduced motion. */
  pop(x: number, z: number, hex: number): void {
    if (this.reduced.matches) return;
    const i = this.popHead++ % POPS;
    this.popAge[i] = 0; this.popX[i] = x; this.popZ[i] = z;
    this.tmp.set(hex);
    this.popRgb[i * 3] = this.tmp.r; this.popRgb[i * 3 + 1] = this.tmp.g; this.popRgb[i * 3 + 2] = this.tmp.b;
    this.popDirty = true;
  }

  private updatePops(dt: number, scale: number): void {
    let live = false;
    for (let i = 0; i < POPS; i++) {
      const age = this.popAge[i]!;
      if (age < 0) continue;
      live = true;
      const next = age + dt;
      const { scale: s, fade } = popCurve(next / POP_LIFE);
      if (next >= POP_LIFE) { this.popAge[i] = -1; this.popObj.scale.setScalar(0); this.popTint.setRGB(0, 0, 0); } else {
        this.popAge[i] = next;
        this.popObj.scale.setScalar(s * Math.max(1, scale * 0.5));
        this.popTint.setRGB(this.popRgb[i * 3]! * fade, this.popRgb[i * 3 + 1]! * fade, this.popRgb[i * 3 + 2]! * fade);
      }
      this.popObj.position.set(this.popX[i]!, 0.06, this.popZ[i]!);
      this.popObj.updateMatrix();
      this.popMesh.setMatrixAt(i, this.popObj.matrix);
      this.popMesh.setColorAt(i, this.popTint);
    }
    if (live || this.popDirty) {
      this.popDirty = false;
      this.popMesh.count = live ? POPS : 0;
      this.popMesh.instanceMatrix.needsUpdate = true;
      if (this.popMesh.instanceColor) this.popMesh.instanceColor.needsUpdate = true;
    }
  }

  /** A sparkle burst of up to `n` particles (default 8). Skipped under reduced motion. */
  burst(x: number, y: number, z: number, hex: number, n = 8): void {
    if (this.reduced.matches) return;
    this.tmp.set(hex);
    this.active = true;
    for (let k = 0; k < n; k++) {
      const i = this.head++ % POOL;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = (Math.random() - 0.5) * 1.6;
      this.vel[i * 3 + 1] = Math.random() * 2 + 0.8;
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * 1.6;
      this.life[i] = 0.6 + Math.random() * 0.5;
      this.base[i * 3] = this.tmp.r; this.base[i * 3 + 1] = this.tmp.g; this.base[i * 3 + 2] = this.tmp.b;
    }
  }

  update(dt: number, time: number, focus: { x: number; z: number }, glow: number, scale: number): void {
    const reduced = this.reduced.matches;
    let live = false;
    for (let i = 0; i < POOL; i++) {
      if (this.life[i]! <= 0) continue;
      live = true;
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) { this.pos[i * 3 + 1] = -1000; continue; }
      const fade = Math.min(1, this.life[i]! / 0.35);
      this.col[i * 3] = this.base[i * 3]! * fade; this.col[i * 3 + 1] = this.base[i * 3 + 1]! * fade; this.col[i * 3 + 2] = this.base[i * 3 + 2]! * fade;
      this.vel[i * 3 + 1]! -= 5 * dt;
      this.pos[i * 3]! += this.vel[i * 3]! * dt;
      this.pos[i * 3 + 1]! += this.vel[i * 3 + 1]! * dt;
      this.pos[i * 3 + 2]! += this.vel[i * 3 + 2]! * dt;
    }
    this.active = live;
    if (live) {
      (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    }
    (this.points.material as THREE.PointsMaterial).size = 0.14 * pointScale(scale);
    this.updatePops(dt, scale);

    if (!this.flyReady) {
      for (let i = 0; i < FIREFLIES; i++) {
        this.flySeed[i] = Math.random() * 100;
        this.flyPos[i * 3] = focus.x + (Math.random() - 0.5) * FIREFLY_HALF * 2;
        this.flyPos[i * 3 + 1] = Math.random() * 5 - 0.5;
        this.flyPos[i * 3 + 2] = focus.z + (Math.random() - 0.5) * FIREFLY_HALF * 2;
      }
      this.flyReady = true;
    }
    const half = FIREFLY_HALF * Math.max(1, Math.sqrt(scale));
    for (let i = 0; i < FIREFLIES; i++) {
      if (!reduced) {
        this.flyPos[i * 3 + 1]! += dt * 0.18;
        this.flyPos[i * 3]! += Math.sin(time * 0.4 + this.flySeed[i]!) * dt * 0.12;
        if (this.flyPos[i * 3 + 1]! > 5) this.flyPos[i * 3 + 1] = -0.5;
      }
      this.flyPos[i * 3] = wrapAround(this.flyPos[i * 3]!, focus.x, half);
      this.flyPos[i * 3 + 2] = wrapAround(this.flyPos[i * 3 + 2]!, focus.z, half);
    }
    (this.fly.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    const fm = this.fly.material as THREE.PointsMaterial;
    fm.opacity = fireflyOpacity(glow);
    fm.size = 0.1 * pointScale(scale);
  }

  dispose(): void {
    this.scene.remove(this.points, this.fly, this.popMesh);
    this.popMesh.geometry.dispose(); (this.popMesh.material as THREE.Material).dispose(); this.popMesh.dispose();
    for (const o of [this.points, this.fly]) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
  }
}

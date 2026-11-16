import * as THREE from 'three';

/** Pooled sparkle bursts plus fireflies that stay around the camera focus. Nothing is allocated per frame. */

const POOL = 500;
const FIREFLIES = 160;
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
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  /** True while any sparkle is still flying (the farm view keeps drawing until they are gone). */
  active = false;

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
    scene.add(this.points, this.fly);
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
    this.scene.remove(this.points, this.fly);
    for (const o of [this.points, this.fly]) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
  }
}

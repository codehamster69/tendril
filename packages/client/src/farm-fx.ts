import * as THREE from 'three';

export interface FxBot { x: number; z: number; color: number }

const TRAIL_POINTS = 44;
const SPARKS = 400;
const MOTES = 120;

const glowTexture = (): THREE.CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
};

interface Trail { history: [number, number][]; mesh: THREE.Mesh; positions: Float32Array; colors: Float32Array; color: THREE.Color }

/** Vine trails behind drones, work sparks and drifting motes. All additive, all pooled. */
export class FarmFx {
  trailsOn = true;
  private glow = 1;
  private lod = 0;
  private trails: Trail[] = [];
  private sparkPositions = new Float32Array(SPARKS * 3);
  private sparkColors = new Float32Array(SPARKS * 3);
  private sparkVelocities = new Float32Array(SPARKS * 3);
  private sparkLife = new Float32Array(SPARKS);
  private sparkHead = 0;
  private sparkGeometry = new THREE.BufferGeometry();
  private sparks = new THREE.Points(this.sparkGeometry, new THREE.PointsMaterial({ size: 0.14, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  private motePositions = new Float32Array(MOTES * 3);
  private moteSeeds = new Float32Array(MOTES);
  private moteGeometry = new THREE.BufferGeometry();
  private motes = new THREE.Points(this.moteGeometry, new THREE.PointsMaterial({ size: 0.1, color: 0xffd68a, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
  private clock = 0;
  private texture = glowTexture();

  constructor(private scene: THREE.Scene) {
    this.sparkGeometry.setAttribute('position', new THREE.BufferAttribute(this.sparkPositions, 3));
    this.sparkGeometry.setAttribute('color', new THREE.BufferAttribute(this.sparkColors, 3));
    this.sparks.frustumCulled = false;
    this.moteGeometry.setAttribute('position', new THREE.BufferAttribute(this.motePositions, 3));
    this.motes.frustumCulled = false;
    for (let i = 0; i < MOTES; i++) {
      this.moteSeeds[i] = Math.random() * 100;
      this.motePositions[i * 3] = (Math.random() - 0.5) * 60;
      this.motePositions[i * 3 + 1] = Math.random() * 5 - 1;
      this.motePositions[i * 3 + 2] = (Math.random() - 0.5) * 60;
    }
    scene.add(this.sparks, this.motes);
  }

  setGlow(strength: number): void { this.glow = strength; }
  setLod(lod: number): void { this.lod = lod; }

  spark(x: number, y: number, z: number, color: number, count: number): void {
    const c = new THREE.Color(color);
    for (let k = 0; k < count; k++) {
      const i = this.sparkHead++ % SPARKS;
      this.sparkPositions.set([x, y, z], i * 3);
      this.sparkVelocities.set([(Math.random() - 0.5) * 1.6, Math.random() * 2 + 0.8, (Math.random() - 0.5) * 1.6], i * 3);
      this.sparkLife[i] = 0.6 + Math.random() * 0.5;
      this.sparkColors.set([c.r, c.g, c.b], i * 3);
    }
  }

  private trail(index: number, color: number): Trail {
    let trail = this.trails[index];
    if (trail && trail.color.getHex() === color) return trail;
    if (trail) { this.scene.remove(trail.mesh); trail.mesh.geometry.dispose(); (trail.mesh.material as THREE.Material).dispose(); }
    const positions = new Float32Array(TRAIL_POINTS * 2 * 3);
    const colors = new Float32Array(TRAIL_POINTS * 2 * 3);
    const indices: number[] = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) { const a = i * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    trail = { history: [], mesh, positions, colors, color: new THREE.Color(color) };
    this.trails[index] = trail;
    return trail;
  }

  update(dt: number, bots: FxBot[], botScale: number, center: { x: number; z: number }): void {
    this.clock += dt;
    for (let i = 0; i < this.trails.length; i++) {
      const trail = this.trails[i];
      if (!trail) continue;
      if (i >= bots.length) { this.scene.remove(trail.mesh); trail.mesh.geometry.dispose(); (trail.mesh.material as THREE.Material).dispose(); this.trails[i] = undefined as unknown as Trail; continue; }
      const bot = bots[i]!;
      const history = trail.history;
      const [lx, lz] = history.length ? history[history.length - 1]! : [Infinity, Infinity];
      if (Math.hypot(bot.x - lx, bot.z - lz) > 0.12) { history.push([bot.x, bot.z]); if (history.length > TRAIL_POINTS) history.shift(); }
      trail.mesh.visible = this.trailsOn && history.length > 2 && this.lod < 2;
      if (!trail.mesh.visible) continue;
      const width = 0.045 * Math.max(1, botScale * 0.7);
      const n = history.length;
      for (let k = 0; k < TRAIL_POINTS; k++) {
        const src = history[Math.min(n - 1, Math.max(0, k - (TRAIL_POINTS - n)))]!;
        const next = history[Math.min(n - 1, Math.max(0, k - (TRAIL_POINTS - n) + 1))]!;
        const prev = history[Math.min(n - 1, Math.max(0, k - (TRAIL_POINTS - n) - 1))]!;
        let tx = next[0] - prev[0], tz = next[1] - prev[1];
        const length = Math.hypot(tx, tz) || 1;
        tx /= length; tz /= length;
        const w = width * (0.25 + (k / (TRAIL_POINTS - 1)) * 0.75);
        trail.positions[k * 6] = src[0] - tz * w; trail.positions[k * 6 + 1] = 0.07; trail.positions[k * 6 + 2] = src[1] + tx * w;
        trail.positions[k * 6 + 3] = src[0] + tz * w; trail.positions[k * 6 + 4] = 0.07; trail.positions[k * 6 + 5] = src[1] - tx * w;
        const alpha = (k / (TRAIL_POINTS - 1)) ** 2 * (0.9 + 0.4 * this.glow);
        for (let q = 0; q < 2; q++) {
          trail.colors[k * 6 + q * 3] = trail.color.r * alpha;
          trail.colors[k * 6 + q * 3 + 1] = trail.color.g * alpha;
          trail.colors[k * 6 + q * 3 + 2] = trail.color.b * alpha;
        }
      }
      trail.mesh.geometry.attributes.position!.needsUpdate = true;
      trail.mesh.geometry.attributes.color!.needsUpdate = true;
    }
    for (let i = 0; i < SPARKS; i++) {
      if (this.sparkLife[i] > 0) {
        this.sparkLife[i] -= dt;
        this.sparkVelocities[i * 3 + 1] -= 4 * dt;
        this.sparkPositions[i * 3] += this.sparkVelocities[i * 3] * dt;
        this.sparkPositions[i * 3 + 1] = Math.max(0.02, this.sparkPositions[i * 3 + 1] + this.sparkVelocities[i * 3 + 1] * dt);
        this.sparkPositions[i * 3 + 2] += this.sparkVelocities[i * 3 + 2] * dt;
      } else this.sparkPositions[i * 3 + 1] = -50;
    }
    this.sparkGeometry.attributes.position!.needsUpdate = true;
    this.sparkGeometry.attributes.color!.needsUpdate = true;
    (this.sparks.material as THREE.PointsMaterial).size = 0.14 * Math.max(1, botScale * 0.6);
    for (let i = 0; i < MOTES; i++) {
      this.motePositions[i * 3 + 1] += dt * 0.18;
      this.motePositions[i * 3] += Math.sin(this.clock * 0.4 + this.moteSeeds[i]!) * dt * 0.12;
      if (this.motePositions[i * 3 + 1] > 5) this.motePositions[i * 3 + 1] = -1;
    }
    this.motes.position.set(Math.round(center.x / 20) * 20, 0, Math.round(center.z / 20) * 20);
    this.moteGeometry.attributes.position!.needsUpdate = true;
    const material = this.motes.material as THREE.PointsMaterial;
    material.opacity = 0.7 * this.glow;
    material.size = 0.1 * Math.max(1, botScale * 0.5);
  }

  dispose(): void {
    for (const trail of this.trails) {
      if (!trail) continue;
      this.scene.remove(trail.mesh);
      trail.mesh.geometry.dispose();
      (trail.mesh.material as THREE.Material).dispose();
    }
    this.trails = [];
    this.scene.remove(this.sparks, this.motes);
    this.sparkGeometry.dispose(); (this.sparks.material as THREE.Material).dispose();
    this.moteGeometry.dispose(); (this.motes.material as THREE.Material).dispose();
    this.texture.dispose();
  }
}

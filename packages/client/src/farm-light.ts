import * as THREE from 'three';
import { skyStep } from './day-clock';

/** 'day' follows the run: dawn at progress 0, noon, golden hour, dusk at 1 (see day-clock.ts). The others are fixed looks. */
export type LightPreset = 'day' | 'dawn' | 'noon' | 'golden' | 'night';
type FixedPreset = Exclude<LightPreset, 'day'>;
export type Weather = 'clear' | 'rain' | 'frost';

/**
 * One light rig for the whole farm: sun, hemisphere, fog, sky gradient and exposure.
 * Preset numbers follow the mockup (`farm-view-mockup.html`); three r187 lights are physical
 * (no legacy PI scaling), so SUN_K / HEMI_K retune them and the values were checked by screenshot.
 */
interface PresetDef {
  sun: number; sunI: number; dir: [number, number, number];
  sky: number; ground: number; hemiI: number; exposure: number;
  top: string; bottom: string; fog: number; glow: number;
}
const SUN_K = 2.6;
const HEMI_K = 2.4;
const PRESETS: Record<FixedPreset, PresetDef> = {
  dawn: { sun: 0xffb48a, sunI: 1.25, dir: [-0.9, 0.42, 0.55], sky: 0xbcc8ff, ground: 0x8a7078, hemiI: 0.62, exposure: 0.95, top: '#2b4a75', bottom: '#f0b08e', fog: 0xd9a68c, glow: 0.7 },
  noon: { sun: 0xfff3dc, sunI: 1.15, dir: [-0.35, 1, 0.45], sky: 0xcfe8ff, ground: 0x8aa070, hemiI: 0.62, exposure: 0.95, top: '#5ea9d0', bottom: '#dff0e8', fog: 0xcfe4e4, glow: 0.2 },
  golden: { sun: 0xffa65a, sunI: 1.4, dir: [-1, 0.55, 0.5], sky: 0xb7c4ee, ground: 0x8a7676, hemiI: 0.7, exposure: 1.0, top: '#1f3260', bottom: '#f2a068', fog: 0xd09270, glow: 0.65 },
  night: { sun: 0x8fb0ff, sunI: 0.9, dir: [-0.5, 0.9, 0.4], sky: 0x5a78b8, ground: 0x2a3d52, hemiI: 0.95, exposure: 1.2, top: '#050b1a', bottom: '#183550', fog: 0x0e2234, glow: 1.5 },
};

/** Weather tint applied on top of a preset: colour mix target + strength, light scales, fog tightening. */
const WEATHER: Record<Weather, { tint: number; mix: number; sun: number; hemi: number; fog: number; glow: number }> = {
  clear: { tint: 0xffffff, mix: 0, sun: 1, hemi: 1, fog: 1, glow: 0 },
  rain: { tint: 0x6f8590, mix: 0.45, sun: 0.5, hemi: 0.85, fog: 0.55, glow: 0.15 },
  frost: { tint: 0xdbeeff, mix: 0.3, sun: 0.9, hemi: 1.1, fog: 0.8, glow: 0.05 },
};

const mixC = (a: number | string, b: number | string, t: number): THREE.Color => new THREE.Color(a).lerp(new THREE.Color(b), t);
const mixDef = (a: PresetDef, b: PresetDef, t: number): PresetDef => {
  const n = (x: number, y: number): number => x + (y - x) * t;
  return {
    sun: mixC(a.sun, b.sun, t).getHex(), sunI: n(a.sunI, b.sunI), dir: [n(a.dir[0], b.dir[0]), n(a.dir[1], b.dir[1]), n(a.dir[2], b.dir[2])],
    sky: mixC(a.sky, b.sky, t).getHex(), ground: mixC(a.ground, b.ground, t).getHex(), hemiI: n(a.hemiI, b.hemiI), exposure: n(a.exposure, b.exposure),
    top: `#${mixC(a.top, b.top, t).getHexString()}`, bottom: `#${mixC(a.bottom, b.bottom, t).getHexString()}`, fog: mixC(a.fog, b.fog, t).getHex(), glow: n(a.glow, b.glow),
  };
};
/** Sunset is dusk, not full night: the end of a run should still be readable. */
const DUSK = mixDef(PRESETS.golden, PRESETS.night, 0.55);
const DAY_KEYS: readonly (readonly [number, PresetDef])[] = [[0, PRESETS.dawn], [0.12, PRESETS.dawn], [0.42, PRESETS.noon], [0.55, PRESETS.noon], [0.8, PRESETS.golden], [1, DUSK]];
/** The look at day progress `p` (0 sunrise .. 1 sunset), blended between the keyframes. */
export function dayLook(p: number): PresetDef {
  const x = Math.min(1, Math.max(0, p));
  for (let i = 1; i < DAY_KEYS.length; i++) {
    const [p1, d1] = DAY_KEYS[i]!;
    if (x <= p1) { const [p0, d0] = DAY_KEYS[i - 1]!; return mixDef(d0, d1, p1 === p0 ? 1 : (x - p0) / (p1 - p0)); }
  }
  return DUSK;
}

const SHADOW_OFF_DISTANCE = 140;
const SHADOW_ON_DISTANCE = 120;
const smooth = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

interface LightState {
  sun: THREE.Color; sky: THREE.Color; ground: THREE.Color; top: THREE.Color; bottom: THREE.Color; fog: THREE.Color;
  dir: THREE.Vector3; sunI: number; hemiI: number; exposure: number; glow: number; fogScale: number;
}
const makeState = (): LightState => ({
  sun: new THREE.Color(), sky: new THREE.Color(), ground: new THREE.Color(), top: new THREE.Color(), bottom: new THREE.Color(), fog: new THREE.Color(),
  dir: new THREE.Vector3(0, 1, 0), sunI: 1, hemiI: 1, exposure: 1, glow: 1, fogScale: 1,
});

export class FarmLight {
  private sun = new THREE.DirectionalLight(0xffffff, 1);
  private hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  private fogObj = new THREE.Fog(0x000000, 50, 200);
  private skyCanvas = document.createElement('canvas');
  private skyCtx: CanvasRenderingContext2D | null;
  private skyTex: THREE.CanvasTexture;
  private cur = makeState();
  private goal = makeState();
  private _preset: LightPreset = 'golden';
  private weather: Weather = 'clear';
  private dayQ = 0;
  private clock = 0;
  private _shadowsOn: boolean;
  private shadowsAllowed: boolean;
  /** Quality switch (task P4): false turns the sun's shadow off without touching the renderer state. */
  private shadowsWanted = true;
  private shadowExtent = 0;
  private shadowKey = '';
  private shadowDirty = true;
  private farm: { cx: number; cz: number; radius: number } | null = null;
  private skyDirty = true;
  private settled = false;
  private reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  private tmp = new THREE.Color();
  private disposed = false;

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer, opts: { shadows?: boolean } = {}) {
    this.shadowsAllowed = opts.shadows !== false;
    this._shadowsOn = this.shadowsAllowed;
    renderer.shadowMap.enabled = this.shadowsAllowed;
    // The shadow map is drawn only when asked: the sun moved, the farm changed or a drone moved (see `takeShadowDirty`).
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.sun.castShadow = this.shadowsAllowed;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 160;
    this.skyCanvas.width = 2;
    this.skyCanvas.height = 256;
    this.skyCtx = this.skyCanvas.getContext('2d');
    this.skyTex = new THREE.CanvasTexture(this.skyCanvas);
    this.skyTex.colorSpace = THREE.SRGBColorSpace;
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = this.fogObj;
    scene.background = this.skyTex;
    this.setPreset('day', true);
  }

  get preset(): LightPreset { return this._preset; }
  get glow(): number { return Math.min(1.5, Math.max(0.2, this.cur.glow)); }
  get shadowsOn(): boolean { return this._shadowsOn && this.shadowsWanted; }
  /** True while colours, intensities or the sky are still easing toward the preset (frames must keep coming). */
  get busy(): boolean { return !this.settled || this.skyDirty; }

  /** Quality setting: shadows on or off. */
  setShadows(on: boolean): void {
    if (!this.shadowsAllowed || on === this.shadowsWanted) return;
    this.shadowsWanted = on;
    this.sun.castShadow = on && this._shadowsOn;
    this.shadowDirty = true;
  }

  /** The shadow map must be redrawn because the sun, the farm or the shadow window changed. Reading clears it. */
  takeShadowDirty(): boolean {
    const dirty = this.shadowDirty && this.shadowsOn;
    this.shadowDirty = false;
    return dirty;
  }

  /** Tell the shadow camera how big the farm is, so a farm that fits one shadow window gets a fixed, sharp window. */
  setFarm(bounds: { x0: number; x1: number; z0: number; z1: number } | null): void {
    this.farm = bounds ? { cx: (bounds.x0 + bounds.x1) / 2, cz: (bounds.z0 + bounds.z1) / 2, radius: Math.hypot(bounds.x1 - bounds.x0, bounds.z1 - bounds.z0) / 2 } : null;
  }

  /** The farm's geometry changed (tiles grew, crops advanced, models arrived). */
  markShadowDirty(): void { this.shadowDirty = true; }

  setPreset(p: LightPreset, snap = false): void {
    this._preset = p;
    this.computeGoal();
    if (snap || this.reduced?.matches) this.step(1);
  }

  /**
   * Day progress 0..1 from dayProgress(). Only used while the preset is 'day'. The target is recomputed in SKY_STEP steps, and the
   * lights ease toward it; `jump` (a scrub, a first frame) skips the easing so the sky never lags the dial.
   */
  setDay(progress: number, jump = false): void {
    const q = skyStep(progress);
    if (q === this.dayQ && !jump) return;
    this.dayQ = q;
    if (this._preset !== 'day') return;
    this.computeGoal();
    if (jump || this.reduced?.matches) this.step(1);
  }

  get dayStep(): number { return this.dayQ; }

  setWeather(w: Weather): void {
    if (w === this.weather) return;
    this.weather = w;
    this.computeGoal();
    if (this.reduced?.matches) this.step(1);
  }

  private computeGoal(): void {
    const p = this._preset === 'day' ? dayLook(this.dayQ) : PRESETS[this._preset], w = WEATHER[this.weather], g = this.goal;
    const tint = (out: THREE.Color, hex: number | string, k = 1): void => { out.set(hex); if (w.mix) out.lerp(this.tmp.set(w.tint), w.mix * k); };
    tint(g.sun, p.sun, 0.8);
    tint(g.sky, p.sky);
    tint(g.ground, p.ground);
    tint(g.top, p.top);
    tint(g.bottom, p.bottom);
    tint(g.fog, p.fog);
    g.dir.set(...p.dir).normalize();
    g.sunI = p.sunI * w.sun;
    g.hemiI = p.hemiI * w.hemi;
    g.exposure = p.exposure;
    g.glow = Math.min(1.5, p.glow + w.glow);
    g.fogScale = w.fog;
    this.settled = false;
  }

  private step(a: number): void {
    const c = this.cur, g = this.goal;
    c.sun.lerp(g.sun, a); c.sky.lerp(g.sky, a); c.ground.lerp(g.ground, a);
    c.top.lerp(g.top, a); c.bottom.lerp(g.bottom, a); c.fog.lerp(g.fog, a);
    c.dir.lerp(g.dir, a).normalize();
    c.sunI += (g.sunI - c.sunI) * a; c.hemiI += (g.hemiI - c.hemiI) * a;
    c.exposure += (g.exposure - c.exposure) * a; c.glow += (g.glow - c.glow) * a;
    c.fogScale += (g.fogScale - c.fogScale) * a;
    this.sun.color.copy(c.sun);
    this.sun.intensity = c.sunI * SUN_K;
    this.hemi.color.copy(c.sky);
    this.hemi.groundColor.copy(c.ground);
    this.hemi.intensity = c.hemiI * HEMI_K;
    this.renderer.toneMappingExposure = c.exposure;
    this.fogObj.color.copy(c.fog);
    this.skyDirty = true;
    this.shadowDirty = true;
    const cd = (x: THREE.Color, y: THREE.Color): number => Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b);
    const err = cd(c.sun, g.sun) + cd(c.sky, g.sky) + cd(c.ground, g.ground) + cd(c.top, g.top) + cd(c.bottom, g.bottom) + cd(c.fog, g.fog)
      + Math.abs(c.sunI - g.sunI) + Math.abs(c.hemiI - g.hemiI) + Math.abs(c.exposure - g.exposure) + Math.abs(c.glow - g.glow) + Math.abs(c.fogScale - g.fogScale) + c.dir.distanceTo(g.dir);
    if (a >= 1 || err < 2e-3) this.settled = true;
  }

  private paintSky(): void {
    if (!this.skyCtx) return;
    const grad = this.skyCtx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, `#${this.cur.top.getHexString()}`);
    grad.addColorStop(0.62, `#${this.cur.fog.getHexString()}`);
    grad.addColorStop(1, `#${this.cur.bottom.getHexString()}`);
    this.skyCtx.fillStyle = grad;
    this.skyCtx.fillRect(0, 0, 2, 256);
    this.skyTex.needsUpdate = true;
    this.skyDirty = false;
  }

  update(dt: number, focus: { x: number; z: number }, distance: number): void {
    if (this.disposed) return;
    if (!this.settled) this.step(1 - Math.exp(-Math.max(0, dt) * 2.5));
    if (this.skyDirty) this.paintSky();
    // Cloud shadow: slow drifting dips in sun strength while it rains (intensity only, so shadow maps are not redone).
    this.clock += Math.max(0, dt);
    const cloud = this.weather === 'rain' && !this.reduced?.matches ? 0.5 + 0.5 * Math.sin(this.clock * 0.45) * Math.sin(this.clock * 0.17 + 1) : 0;
    this.sun.intensity = this.cur.sunI * SUN_K * (1 - 0.25 * cloud);

    // Shadows off when far away (hysteresis); castShadow flips recompile materials, so avoid chatter.
    if (this.shadowsAllowed) {
      const want = this._shadowsOn ? distance < SHADOW_OFF_DISTANCE : distance < SHADOW_ON_DISTANCE;
      if (want !== this._shadowsOn) { this._shadowsOn = want; this.sun.castShadow = want && this.shadowsWanted; this.shadowDirty = true; }
    }
    // A farm that fits one window is covered by a fixed window (the camera can move without redrawing the shadow
    // map). A bigger farm gets a window that follows the focus and scales with the view, quantised so it does not shimmer.
    const fits = !!this.farm && this.farm.radius + 2 <= 36;
    const extent = fits ? Math.max(9, this.farm!.radius + 2) : Math.min(36, Math.max(9, distance * 0.85));
    if (Math.abs(extent - this.shadowExtent) > 0.25) {
      const sc = this.sun.shadow.camera;
      sc.left = sc.bottom = -extent; sc.right = sc.top = extent;
      sc.updateProjectionMatrix();
      this.shadowExtent = extent;
      this.shadowDirty = true;
    }
    const sx = fits ? Math.round(this.farm!.cx * 2) / 2 : Math.round(focus.x * 2) / 2, sz = fits ? Math.round(this.farm!.cz * 2) / 2 : Math.round(focus.z * 2) / 2;
    const key = `${sx},${sz},${this.cur.dir.x.toFixed(4)},${this.cur.dir.y.toFixed(4)},${this.cur.dir.z.toFixed(4)}`;
    if (key !== this.shadowKey) {
      this.shadowKey = key;
      this.shadowDirty = true;
      this.sun.target.position.set(sx, 0, sz);
      this.sun.position.set(sx + this.cur.dir.x * 70, this.cur.dir.y * 70, sz + this.cur.dir.z * 70);
      this.sun.target.updateMatrixWorld();
    }

    // Fog scales with distance; it opens up further when the camera is high (Map zoom).
    const far = smooth(40, 90, distance), s = this.cur.fogScale;
    this.fogObj.near = distance * (1.5 + 1.7 * far) * s;
    this.fogObj.far = (distance * (8 + 6 * far) + 60) * (0.55 + 0.45 * s);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.sun, this.sun.target, this.hemi);
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.hemi.dispose();
    if (this.scene.fog === this.fogObj) this.scene.fog = null;
    if (this.scene.background === this.skyTex) this.scene.background = null;
    this.skyTex.dispose();
  }
}

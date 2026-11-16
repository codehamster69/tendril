import * as THREE from 'three';
import type { Bounds } from './farm-scenery';

/**
 * Farm camera rig (replaces OrbitControls).
 *
 * State is a pose (target on the ground, yaw, pitch, distance). `cur` is what is shown, `des` is the goal;
 * `cur` eases to `des` exponentially. Every change of distance, pitch or yaw can be "anchor locked": the
 * ground point under a screen position is found before and after the change and the target slides by the
 * difference, so that point stays under the pointer (zoom to cursor, pinch, rotate, auto-tilt).
 * The maths is in exported pure functions so it can be unit tested without a DOM.
 */

export interface CameraPose { tx: number; tz: number; yaw: number; pitch: number; dist: number }

export const MIN_DIST = 3;
/** How long the frame takes to slide when the slate opens, closes or is resized. */
export const INSET_MS = 250;
export const MIN_PITCH = 0.5;   // about 29 degrees
export const MAX_PITCH = 1.3;   // about 75 degrees
const DEFAULT_TARGET = { x: 3.5, z: 3.5 };
const DEFAULT_POSITION = { x: 10, y: 14, z: 16 };
const DEFAULT_MAX_DIST = 60;
const TAP_SLOP = 4;             // pointer travel in px below which a press is a tap
const TAP_TIME = 500;           // ms

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const wrapAngle = (a: number): number => {
  const t = Math.PI * 2;
  a = ((a + Math.PI) % t + t) % t - Math.PI;
  return a;
};

/** Pose looking from the legacy default position (10,14,16) at (3.5,0,3.5). */
export function defaultPose(): CameraPose {
  const dx = DEFAULT_POSITION.x - DEFAULT_TARGET.x, dy = DEFAULT_POSITION.y, dz = DEFAULT_POSITION.z - DEFAULT_TARGET.z;
  const dist = Math.hypot(dx, dy, dz);
  return { tx: DEFAULT_TARGET.x, tz: DEFAULT_TARGET.z, yaw: Math.atan2(dx, dz), pitch: Math.asin(dy / dist), dist };
}

/** Put a perspective camera on a pose (looking at the target on the ground). Also sets near/far from the distance. */
export function placeCamera(cam: THREE.PerspectiveCamera, s: CameraPose, extent = 0): void {
  const cp = Math.cos(s.pitch);
  cam.position.set(s.tx + s.dist * cp * Math.sin(s.yaw), s.dist * Math.sin(s.pitch), s.tz + s.dist * cp * Math.cos(s.yaw));
  cam.lookAt(s.tx, 0, s.tz);
  cam.near = Math.max(0.2, s.dist * 0.02);
  cam.far = s.dist * 12 + 400 + extent * 1.5;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
}

/** Ground (y = 0) point under a normalised device position, or null when the ray does not hit the ground. Camera matrices must be current. */
export function groundPoint(cam: THREE.Camera, ndcX: number, ndcY: number, out = new THREE.Vector3()): THREE.Vector3 | null {
  out.set(ndcX, ndcY, 0.5).unproject(cam);
  const o = cam.position;
  const dy = out.y - o.y;
  if (dy > -1e-6) return null;
  const k = -o.y / dy;
  return out.set(o.x + (out.x - o.x) * k, 0, o.z + (out.z - o.z) * k);
}

/**
 * Shift the projection so the frame is centred in the canvas left of an `insetPx` panel on the right (the code slate).
 * Shifting by half the inset leaves the rightmost half-inset empty; the panel covers it.
 * Ray casts, projections and pointer maps all use the projection, so they stay consistent.
 */
export function applyInset(cam: THREE.PerspectiveCamera, insetPx: number, w: number, h: number): void {
  if (insetPx > 0) cam.setViewOffset(w, h, insetPx / 2, 0, w, h);
  else if (cam.view?.enabled) cam.clearViewOffset();
}

/** Exponential easing factor, `1 - exp(-dt * rate)`. Reduced motion snaps. */
export const easeFactor = (dt: number, rate = 11, reduced = false): number => (reduced ? 1 : 1 - Math.exp(-Math.max(0, dt) * rate));

/** Distance at which a circle of `radius` tiles around the target fits the narrower field of view. */
export function fitDistance(radius: number, fovDeg: number, aspect: number): number {
  const vHalf = THREE.MathUtils.degToRad(fovDeg) / 2;
  const half = Math.min(vHalf, Math.atan(Math.tan(vHalf) * aspect));
  return radius / Math.sin(half) * 1.02;
}

/** Pitch that rises from about 34 degrees near to 64 degrees far (smoothstep over distance). */
export function autoPitch(dist: number, maxDist: number): number {
  const u = clamp((dist - 6) / Math.max(1, maxDist * 0.7 - 6), 0, 1);
  return 0.6 + (1.12 - 0.6) * u * u * (3 - 2 * u);
}

/**
 * Apply `patch` to `pose`, then slide the target so the ground point that was under (ndcX, ndcY) is under it again.
 * `scratch` is a camera with the real fov and aspect; it is moved around freely. Without an ndc, the patch is applied as is.
 */
export function applyLocked(pose: CameraPose, patch: Partial<CameraPose>, scratch: THREE.PerspectiveCamera, ndcX?: number, ndcY?: number): void {
  let p: THREE.Vector3 | null = null;
  if (ndcX !== undefined && ndcY !== undefined) { placeCamera(scratch, pose); p = groundPoint(scratch, ndcX, ndcY); }
  Object.assign(pose, patch);
  if (p && ndcX !== undefined && ndcY !== undefined) {
    placeCamera(scratch, pose);
    const q = groundPoint(scratch, ndcX, ndcY);
    if (q) { pose.tx += p.x - q.x; pose.tz += p.z - q.z; }
  }
}

type Source = () => { x: number; z: number } | null;

export class FarmCamera {
  zoomMode: 'cursor' | 'center' = 'cursor';
  autoTilt = true;
  onChange?: () => void;
  /** Called with onChange after every move that changes the view, so a draw-on-demand renderer can wake up. */
  requestRender?: () => void;
  readonly target = new THREE.Vector3(DEFAULT_TARGET.x, 0, DEFAULT_TARGET.z);
  /** Slate width in px (plus its margin) on the right. `insetNow` is shown; it tweens to `insetTo` over INSET_MS. */
  private insetNow = 0;
  private insetFrom = 0;
  private insetTo = 0;
  private insetT = 1;

  private cur: CameraPose = defaultPose();
  private des: CameraPose = defaultPose();
  private scratch = new THREE.PerspectiveCamera();
  private bounds: Bounds | null = null;
  private tiltOffset = 0;
  private panVel = { x: 0, z: 0 };
  private framed = true;           // true until the user (or focus/follow) takes the camera away from fit()
  private fittedAspect = 0;
  private source: Source | null = null;
  private dragging = false;
  private keys = new Set<string>();
  private ptrs = new Map<number, { x: number; y: number }>();
  private mode: 'pan' | 'orbit' | 'pinch' | null = null;
  private grab: THREE.Vector3 | null = null;
  private last = { x: 0, y: 0, t: 0 };
  private moved = 0;
  private down: { t: number } | null = null;
  private pinch: { d: number; mx: number; my: number } | null = null;
  private lastEmit = new Float64Array(7).fill(NaN);
  private motion: MediaQueryList | null = null;
  private win: Window | null;
  private savedTouchAction: string;
  private disposed = false;

  private camera: THREE.PerspectiveCamera;
  private dom: HTMLElement;
  private onTap?: (clientX: number, clientY: number) => void;

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, onTap?: (clientX: number, clientY: number) => void) {
    this.camera = camera; this.dom = dom; this.onTap = onTap;
    this.scratch.fov = camera.fov;
    this.win = dom.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
    this.savedTouchAction = dom.style?.touchAction ?? '';
    if (dom.style) dom.style.touchAction = 'none';
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', this.onContext);
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointercancel', this.onUp);
    dom.addEventListener('dblclick', this.onDbl);
    this.win?.addEventListener('keydown', this.onKeyDown);
    this.win?.addEventListener('keyup', this.onKeyUp);
    this.win?.addEventListener('blur', this.onBlur);
    this.place(true);
  }

  get distance(): number { return this.cur.dist; }
  get yaw(): number { return this.cur.yaw; }
  get pitch(): number { return this.cur.pitch; }
  get following(): boolean { return this.source !== null; }

  setBounds(b: Bounds | null): void {
    const same = b && this.bounds && b.x0 === this.bounds.x0 && b.x1 === this.bounds.x1 && b.z0 === this.bounds.z0 && b.z1 === this.bounds.z1;
    if (same || (!b && !this.bounds)) return;
    const prev = this.bounds;
    const first = prev === null;
    const grew = !!b && !!prev && (b.x0 < prev.x0 || b.x1 > prev.x1 || b.z0 < prev.z0 || b.z1 > prev.z1);
    this.bounds = b ? { ...b } : null;
    // Land grew (a plot was bought): re-frame, even if the player moved the camera, unless a drone is being followed.
    if (b && (this.framed || (grew && !this.source))) { this.fit(first); return; }
    this.clampTarget(this.des); this.clampTarget(this.cur);
    this.des.dist = clamp(this.des.dist, MIN_DIST, this.maxDist());
    this.cur.dist = clamp(this.cur.dist, MIN_DIST, this.maxDist());
    this.place(true);
  }

  autoFramed(): boolean { return this.framed; }

  /** Slate width in px (its margin included) that covers the right of the canvas; 0 when hidden. The frame moves into the rest. */
  setInset(px: number, snap = false): void {
    const to = Math.max(0, px);
    if (to === this.insetTo) return;
    this.insetFrom = this.insetNow; this.insetTo = to; this.insetT = 0;
    if (snap || this.reducedMotion()) { this.insetNow = to; this.insetT = 1; }
    if (this.framed) this.fit(false);   // re-frame the farm in the new free area
    else this.place(true);
  }

  /** Glide the target over a ground point and keep the distance (double-click, the splash, the result screen). */
  flyTo(target: { x: number; z: number }, o: { dist?: number } = {}): void {
    this.focus(target.x, target.z, o);
  }

  /** Opening shot: start high and far, then ease down into the framed farm. Reduced motion lands at once. */
  introGlide(): void {
    this.fit(false);
    if (!this.reducedMotion()) {
      this.cur.dist = Math.min(this.maxDist(), this.des.dist * 1.8);
      this.cur.pitch = clamp(this.des.pitch + 0.3, MIN_PITCH, MAX_PITCH);
      this.cur.yaw = this.des.yaw - 0.4;
    }
    else Object.assign(this.cur, this.des);
    this.place(true);
  }

  fit(snap = false): void {
    this.source = null;
    this.panVel.x = this.panVel.z = 0;
    const aspect = this.freeAspect();
    this.fittedAspect = aspect;
    this.tiltOffset = 0;
    if (!this.bounds) {
      Object.assign(this.des, defaultPose());
    } else {
      const d = Math.min(this.maxDist(), this.fitDist());
      this.des.tx = (this.bounds.x0 + this.bounds.x1) / 2;
      this.des.tz = (this.bounds.z0 + this.bounds.z1) / 2;
      this.des.dist = d;
      this.des.pitch = clamp(autoPitch(d, this.maxDist()), MIN_PITCH, MAX_PITCH);
    }
    this.framed = true;
    if (snap) { Object.assign(this.cur, this.des); this.place(true); }
  }

  focus(x: number, z: number, o: { dist?: number; snap?: boolean } = {}): void {
    this.source = null;
    this.framed = false;
    this.panVel.x = this.panVel.z = 0;
    if (o.dist !== undefined) this.des.dist = clamp(o.dist, MIN_DIST, this.maxDist());
    this.des.tx = x; this.des.tz = z;
    this.clampTarget(this.des);
    if (o.snap) { Object.assign(this.cur, this.des); this.place(true); }
  }

  follow(source: Source | null): void {
    this.source = source;
    if (source) { this.framed = false; this.panVel.x = this.panVel.z = 0; }
  }

  /** Turn the view by an angle around the target at once (no easing); the sunset orbit calls it every frame. */
  spin(radians: number): void { this.des.yaw += radians; this.cur.yaw += radians; }

  rotate(steps: number): void {
    this.framed = false;
    const patch = { yaw: this.des.yaw + steps * Math.PI / 2 };
    if (this.source) Object.assign(this.des, patch);
    else applyLocked(this.des, patch, this.scratchCam(), 0, 0);
    this.clampTarget(this.des);
  }

  zoomAt(factor: number, ndcX: number, ndcY: number): void {
    this.framed = false;
    const d = clamp(this.des.dist * factor, MIN_DIST, this.maxDist());
    const patch: Partial<CameraPose> = { dist: d };
    if (this.zoomMode === 'cursor' && this.autoTilt) patch.pitch = clamp(autoPitch(d, this.maxDist()) + this.tiltOffset, MIN_PITCH, MAX_PITCH);
    if (this.zoomMode === 'center' || this.source) { Object.assign(this.des, patch); return; }
    applyLocked(this.des, patch, this.scratchCam(), ndcX, ndcY);
    this.clampTarget(this.des);
  }

  groundAt(ndcX: number, ndcY: number, out?: THREE.Vector3): THREE.Vector3 | null {
    this.camera.updateMatrixWorld();
    return groundPoint(this.camera, ndcX, ndcY, out);
  }

  visibleQuad(maxReach?: number): THREE.Vector3[] {
    this.camera.updateMatrixWorld();
    const lim = maxReach ?? Math.max(this.cur.dist * 4, 60);
    const eye = this.camera.position;
    return ([[-1, 1], [1, 1], [1, -1], [-1, -1]] as const).map(([nx, ny]) => {
      const p = groundPoint(this.camera, nx, ny) ?? groundPoint(this.camera, nx, ny * 0.5 - 0.5) ?? new THREE.Vector3(this.cur.tx, 0, this.cur.tz);
      const dx = p.x - eye.x, dz = p.z - eye.z, d = Math.hypot(dx, dz);
      if (d > lim) { p.x = eye.x + dx / d * lim; p.z = eye.z + dz / d * lim; }
      p.y = 0;
      return p;
    });
  }

  update(dt: number): void {
    if (this.disposed) return;
    dt = clamp(dt, 0, 0.1);
    const reduced = this.reducedMotion();
    // viewport changed while the whole farm was framed: keep it framed
    const aspect = this.freeAspect();
    if (this.framed && !this.source && this.bounds && Math.abs(aspect - this.fittedAspect) > 1e-3) this.fit(false);
    if (this.insetT < 1) {
      this.insetT = Math.min(1, this.insetT + dt / (INSET_MS / 1000));
      const s = this.insetT * this.insetT * (3 - 2 * this.insetT);   // smoothstep over INSET_MS
      this.insetNow = this.insetFrom + (this.insetTo - this.insetFrom) * s;
      this.place(true);
    }
    if (this.source) {
      const p = this.source();
      if (p) {
        const a = easeFactor(dt, 5, reduced);
        this.des.tx += (p.x - this.des.tx) * a; this.des.tz += (p.z - this.des.tz) * a;
      }
    }
    if (!this.dragging && Math.abs(this.panVel.x) + Math.abs(this.panVel.z) > 0.01) {
      this.des.tx += this.panVel.x * dt; this.des.tz += this.panVel.z * dt;
      this.cur.tx += this.panVel.x * dt; this.cur.tz += this.panVel.z * dt;
      const f = Math.exp(-dt * 5);
      this.panVel.x *= f; this.panVel.z *= f;
    }
    this.keyPan(dt);
    this.clampTarget(this.des); this.clampTarget(this.cur);
    const a = easeFactor(dt, 11, reduced), c = this.cur, d = this.des;
    c.tx += (d.tx - c.tx) * a; c.tz += (d.tz - c.tz) * a;
    c.dist += (d.dist - c.dist) * a; c.pitch += (d.pitch - c.pitch) * a;
    c.yaw += wrapAngle(d.yaw - c.yaw) * a;
    this.place(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const dom = this.dom;
    dom.removeEventListener('wheel', this.onWheel);
    dom.removeEventListener('contextmenu', this.onContext);
    dom.removeEventListener('pointerdown', this.onDown);
    dom.removeEventListener('pointermove', this.onMove);
    dom.removeEventListener('pointerup', this.onUp);
    dom.removeEventListener('pointercancel', this.onUp);
    dom.removeEventListener('dblclick', this.onDbl);
    this.win?.removeEventListener('keydown', this.onKeyDown);
    this.win?.removeEventListener('keyup', this.onKeyUp);
    this.win?.removeEventListener('blur', this.onBlur);
    if (dom.style) dom.style.touchAction = this.savedTouchAction;
    this.ptrs.clear(); this.keys.clear();
    this.onChange = undefined;
  }

  // ---- internals

  private aspect(): number { return this.camera.aspect > 0 ? this.camera.aspect : 1; }
  private reducedMotion(): boolean {
    if (this.motion === null && this.win && typeof this.win.matchMedia === 'function') this.motion = this.win.matchMedia('(prefers-reduced-motion: reduce)');
    return this.motion?.matches ?? false;
  }
  private scratchCam(): THREE.PerspectiveCamera {
    this.scratch.fov = this.camera.fov; this.scratch.aspect = this.aspect();
    const { w, h } = this.canvasSize();
    applyInset(this.scratch, this.insetNow, w, h);
    return this.scratch;
  }
  private extent(): number { return this.bounds ? Math.max(this.bounds.x1 - this.bounds.x0, this.bounds.z1 - this.bounds.z0) : 0; }
  private fitDist(): number {
    const b = this.bounds;
    if (!b) return defaultPose().dist;
    const radius = Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2 + 1.2;
    return fitDistance(radius, this.camera.fov, this.freeAspect());
  }
  private canvasSize(): { w: number; h: number } {
    const r = this.dom.getBoundingClientRect();
    return { w: r.width || 1, h: r.height || 1 };
  }
  /** Width-to-height ratio of the part of the canvas the slate leaves free; the farm is framed there. */
  private freeAspect(): number {
    const { w, h } = this.canvasSize();
    return Math.max(0.2, (w - this.insetTo) / h);
  }
  private maxDist(): number { return this.bounds ? Math.max(30, this.fitDist() * 1.3) : DEFAULT_MAX_DIST; }
  private clampTarget(s: CameraPose): void {
    const b = this.bounds;
    if (!b) return;
    const m = Math.max(3, this.extent() * 0.15);
    s.tx = clamp(s.tx, b.x0 - m, b.x1 + m); s.tz = clamp(s.tz, b.z0 - m, b.z1 + m);
  }
  private ndc(x: number, y: number): [number, number] {
    const r = this.dom.getBoundingClientRect();
    return [(x - r.left) / (r.width || 1) * 2 - 1, -((y - r.top) / (r.height || 1) * 2 - 1)];
  }
  private place(force: boolean): void {
    const { w, h } = this.canvasSize();
    applyInset(this.camera, this.insetNow, w, h);
    placeCamera(this.camera, this.cur, this.extent());
    this.target.set(this.cur.tx, 0, this.cur.tz);
    const k = this.lastEmit, p = this.camera.position, c = this.cur;
    const changed = force || Math.abs(k[0] - p.x) > 1e-4 || Math.abs(k[1] - p.y) > 1e-4 || Math.abs(k[2] - p.z) > 1e-4
      || Math.abs(k[3] - c.tx) > 1e-4 || Math.abs(k[4] - c.tz) > 1e-4 || Math.abs(k[5] - c.yaw) > 1e-4 || Math.abs(k[6] - c.pitch) > 1e-4 || Number.isNaN(k[0]);
    if (!changed) return;
    k[0] = p.x; k[1] = p.y; k[2] = p.z; k[3] = c.tx; k[4] = c.tz; k[5] = c.yaw; k[6] = c.pitch;
    this.onChange?.();
    this.requestRender?.();
  }
  private takeover(): void { this.source = null; this.framed = false; }

  private keyPan(dt: number): void {
    if (!this.keys.size) return;
    const k = this.keys;
    let f = 0, r = 0;
    if (k.has('w') || k.has('arrowup')) f++;
    if (k.has('s') || k.has('arrowdown')) f--;
    if (k.has('d') || k.has('arrowright')) r++;
    if (k.has('a') || k.has('arrowleft')) r--;
    if (!f && !r) return;
    this.takeover();
    const sp = this.des.dist * 0.7 * dt, sy = Math.sin(this.des.yaw), cy = Math.cos(this.des.yaw);
    this.des.tx += (-sy * f + cy * r) * sp; this.des.tz += (-cy * f - sy * r) * sp;
  }

  private onContext = (e: Event): void => e.preventDefault();

  /** Double-click centres the view on the ground under the pointer (the tile is selected by the tap that comes with it). */
  private onDbl = (e: MouseEvent): void => {
    if (this.disposed) return;
    const [nx, ny] = this.ndc(e.clientX, e.clientY);
    const g = this.groundAt(nx, ny);
    if (g) this.flyTo({ x: g.x, z: g.z });
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const [nx, ny] = this.ndc(e.clientX, e.clientY);
    let dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    dy = clamp(dy, -240, 240);
    this.zoomAt(Math.exp(dy * (e.ctrlKey ? 0.012 : 0.0017)), nx, ny);
  };

  private onDown = (e: PointerEvent): void => {
    try { this.dom.setPointerCapture(e.pointerId); } catch { /* synthetic or released pointer */ }
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.panVel.x = this.panVel.z = 0;
    if (this.ptrs.size === 2) {
      const [a, b] = [...this.ptrs.values()] as [{ x: number; y: number }, { x: number; y: number }];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      this.mode = 'pinch';
      return;
    }
    this.moved = 0;
    this.down = { t: performance.now() };
    if (e.button === 2 || e.button === 1 || e.ctrlKey || e.altKey) { this.mode = 'orbit'; this.dom.classList?.add('orbit'); this.grab = null; }
    else {
      this.mode = 'pan';
      const [nx, ny] = this.ndc(e.clientX, e.clientY);
      this.grab = this.groundAt(nx, ny, new THREE.Vector3());
    }
    this.last = { x: e.clientX, y: e.clientY, t: performance.now() };
    this.dragging = true;
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    const px = p.x, py = p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this.mode === 'pinch' && this.ptrs.size === 2 && this.pinch) {
      const [a, b] = [...this.ptrs.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const [nx, ny] = this.ndc(mx, my);
      this.takeover();
      this.zoomAt(this.pinch.d / Math.max(8, d), nx, ny);
      // pan by the midpoint's movement, measured on the goal pose
      const [ox, oy] = this.ndc(this.pinch.mx, this.pinch.my);
      const cam = this.scratchCam();
      placeCamera(cam, this.des);
      const p0 = groundPoint(cam, ox, oy), q = groundPoint(cam, nx, ny);
      if (p0 && q) { this.des.tx += p0.x - q.x; this.des.tz += p0.z - q.z; this.clampTarget(this.des); }
      this.pinch = { d, mx, my };
      return;
    }
    if (this.mode === 'pan' && this.grab) {
      this.moved += Math.abs(e.clientX - px) + Math.abs(e.clientY - py);
      if (this.moved < TAP_SLOP) return;
      this.takeover();
      const [nx, ny] = this.ndc(e.clientX, e.clientY);
      const q = this.groundAt(nx, ny, new THREE.Vector3());
      if (!q) return;
      const dx = this.grab.x - q.x, dz = this.grab.z - q.z;
      this.des.tx += dx; this.des.tz += dz; this.cur.tx += dx; this.cur.tz += dz;
      this.clampTarget(this.des); this.clampTarget(this.cur);
      this.place(false);
      const now = performance.now(), dt = Math.max(0.008, (now - this.last.t) / 1000);
      this.panVel.x = this.panVel.x * 0.6 + dx / dt * 0.4; this.panVel.z = this.panVel.z * 0.6 + dz / dt * 0.4;
      this.last = { x: e.clientX, y: e.clientY, t: now };
    } else if (this.mode === 'orbit') {
      this.moved += 1;
      this.takeover();
      const dx = e.clientX - px, dy = e.clientY - py;
      this.des.yaw -= dx * 0.006; this.cur.yaw = this.des.yaw;
      this.des.pitch = clamp(this.des.pitch + dy * 0.005, MIN_PITCH, MAX_PITCH); this.cur.pitch = this.des.pitch;
      this.tiltOffset = this.des.pitch - autoPitch(this.des.dist, this.maxDist());
      this.place(false);
    }
  };

  private onUp = (e: PointerEvent): void => {
    this.ptrs.delete(e.pointerId);
    if (this.ptrs.size < 2 && this.mode === 'pinch') {
      this.mode = null; this.pinch = null; this.dragging = false; this.panVel.x = this.panVel.z = 0;
      return;
    }
    if (this.mode && this.ptrs.size === 0) {
      const now = performance.now();
      const tap = this.moved < TAP_SLOP && this.down !== null && now - this.down.t < TAP_TIME && e.type === 'pointerup';
      if (this.mode === 'pan' && now - this.last.t > 90) this.panVel.x = this.panVel.z = 0;   // held still before release: no fling
      this.mode = null; this.dragging = false; this.grab = null; this.down = null;
      this.dom.classList?.remove('orbit');
      if (tap) this.onTap?.(e.clientX, e.clientY);
    }
  };

  private typing(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (!t || !t.tagName) return false;
    return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed || e.ctrlKey || e.metaKey || e.altKey || this.typing(e)) return;
    const k = e.key.toLowerCase();
    // Plain arrows belong to tile navigation on the canvas; Shift+arrows pan.
    if (k === 'w' || k === 'a' || k === 's' || k === 'd' || (k.startsWith('arrow') && e.shiftKey)) { this.keys.add(k); e.preventDefault(); }
    else if (k === 'q') this.rotate(-1);
    else if (k === 'e') this.rotate(1);
    else if (k === '+' || k === '=') this.zoomAt(0.8, 0, 0);
    else if (k === '-' || k === '_') this.zoomAt(1.25, 0, 0);
  };
  private onKeyUp = (e: KeyboardEvent): void => { this.keys.delete(e.key.toLowerCase()); };
  private onBlur = (): void => { this.keys.clear(); };
}

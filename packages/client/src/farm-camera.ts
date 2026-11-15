import * as THREE from 'three';

export interface RigBounds { x0: number; x1: number; z0: number; z1: number }
export interface RigPose { tx: number; tz: number; yaw: number; pitch: number; dist: number }

export interface CameraRigOptions {
  reduced: () => boolean;
  /** Left-click that never moved past the drag threshold. */
  onClick?: (clientX: number, clientY: number) => void;
  /** F key / follow button: view cycles drones and returns the new index (-1 off). */
  onCycleFollow?: () => void;
  /** Home key / fit button. */
  onFit?: () => void;
  /** Any deliberate user input (cancels automatic framing in the view). */
  onUserInput?: () => void;
  /** Called whenever the shown pose changes, so the view can publish datasets. */
  onPose?: () => void;
}

const MIN_DIST = 3;
const PITCH_MIN = 0.5;
const PITCH_MAX = 1.3;
/** Snap epsilon: below this the shown pose copies the goal exactly, so published poses go quiet. */
const SNAP = 1e-7;

const wrapAngle = (a: number): number => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

/**
 * Anchor-lock camera rig: target/yaw/pitch/distance with a shown and a goal copy.
 * After any change of distance, pitch or yaw the target slides so the ground point
 * under the pointer stays under the pointer (wheel, pinch and auto-tilt alike).
 * Left-drag pans by grabbing the ground, right/middle/ctrl-drag orbits.
 */
export class CameraRig {
  cur: RigPose = { tx: 3.5, tz: 3.5, yaw: 0.336, pitch: 0.848, dist: 20 };
  des: RigPose = { ...this.cur };
  zoomToCursor = true;
  autoTilt = true;
  private tiltOffset = 0;
  private bounds: RigBounds | null = null;
  private follow: (() => { x: number; z: number } | null) | null = null;
  private panVel = { x: 0, z: 0 };
  private dragging = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private mode: 'pan' | 'orbit' | 'pinch' | null = null;
  private grab: THREE.Vector3 | null = null;
  private pinch: { d: number; mx: number; my: number } | null = null;
  private last = { x: 0, y: 0, t: 0 };
  private down: { x: number; y: number; t: number } | null = null;
  private moved = 0;
  private keys = new Set<string>();
  private ray = new THREE.Raycaster();
  private helper = new THREE.PerspectiveCamera();
  private v = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera, private canvas: HTMLCanvasElement, private options: CameraRigOptions) {
    this.helper.fov = camera.fov;
  }

  attach(): void {
    this.canvas.addEventListener('wheel', this.wheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.blockMenu);
    this.canvas.addEventListener('pointerdown', this.pointerDown);
    this.canvas.addEventListener('pointermove', this.pointerMove);
    this.canvas.addEventListener('pointerup', this.pointerUp);
    this.canvas.addEventListener('pointercancel', this.pointerUp);
    this.canvas.addEventListener('pointerleave', this.pointerLeave);
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
  }

  detach(): void {
    this.canvas.removeEventListener('wheel', this.wheel);
    this.canvas.removeEventListener('contextmenu', this.blockMenu);
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    this.canvas.removeEventListener('pointermove', this.pointerMove);
    this.canvas.removeEventListener('pointerup', this.pointerUp);
    this.canvas.removeEventListener('pointercancel', this.pointerUp);
    this.canvas.removeEventListener('pointerleave', this.pointerLeave);
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
  }

  setBounds(bounds: RigBounds | null): void { this.bounds = bounds; }
  setFollowProvider(provider: (() => { x: number; z: number } | null) | null): void { this.follow = provider; }
  get isDragging(): boolean { return this.dragging; }

  /** Pixels one tile covers on screen right now; drives level-of-detail choices. */
  tilePx(): number {
    const half = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    return window.innerHeight / (2 * this.cur.dist * Math.tan(half)) * Math.max(0.55, Math.sin(this.cur.pitch));
  }

  fitDistance(bounds: RigBounds): number {
    const radius = Math.hypot(bounds.x1 - bounds.x0, bounds.z1 - bounds.z0) / 2 + 0.8;
    const fov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const angle = Math.min(fov, Math.atan(Math.tan(fov) * this.camera.aspect));
    return radius / Math.sin(angle) * 1.08;
  }

  maxDistance(): number {
    const bounds = this.bounds;
    return Math.max(30, bounds ? this.fitDistance(bounds) * 1.3 : 80);
  }

  /** Pitch that reads as a map when far out and a diorama up close, plus any manual offset. */
  autoPitch(dist: number): number {
    const u = THREE.MathUtils.clamp((dist - 6) / (this.maxDistance() * 0.7 - 6), 0, 1);
    return 0.6 + (1.12 - 0.6) * u * u * (3 - 2 * u);
  }

  groundAt(nx: number, ny: number, out: THREE.Vector3, cam: THREE.Camera = this.camera): THREE.Vector3 | null {
    this.ray.setFromCamera(new THREE.Vector2(nx, ny), cam);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    if (d.y > -1e-4) return null;
    return out.copy(d).multiplyScalar(-o.y / d.y).add(o);
  }

  groundAtClient(clientX: number, clientY: number, out: THREE.Vector3): THREE.Vector3 | null {
    const [nx, ny] = this.ndc(clientX, clientY);
    return this.groundAt(nx, ny, out);
  }

  private ndc(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [(clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height * 2 - 1)];
  }

  private place(cam: THREE.PerspectiveCamera, s: RigPose): void {
    const cp = Math.cos(s.pitch);
    cam.position.set(s.tx + s.dist * cp * Math.sin(s.yaw), s.dist * Math.sin(s.pitch), s.tz + s.dist * cp * Math.cos(s.yaw));
    cam.lookAt(s.tx, 0, s.tz);
    cam.near = Math.max(0.1, s.dist * 0.02);
    cam.far = s.dist * 12 + 400;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  private clampTarget(s: RigPose): void {
    const b = this.bounds;
    if (!b) return;
    s.tx = THREE.MathUtils.clamp(s.tx, b.x0 - 2, b.x1 + 2);
    s.tz = THREE.MathUtils.clamp(s.tz, b.z0 - 2, b.z1 + 2);
  }

  /** Apply a pose patch, then slide the target so the ground under (nx, ny) stays put. */
  private applyLocked(s: RigPose, patch: Partial<RigPose>, nx?: number, ny?: number): void {
    let before: THREE.Vector3 | null = null;
    if (nx !== undefined && ny !== undefined) {
      this.helper.copy(this.camera);
      this.place(this.helper, s);
      before = this.groundAt(nx, ny, new THREE.Vector3(), this.helper);
    }
    Object.assign(s, patch);
    if (before) {
      this.helper.copy(this.camera);
      this.place(this.helper, s);
      const after = this.groundAt(nx!, ny!, this.v, this.helper);
      if (after) { s.tx += before.x - after.x; s.tz += before.z - after.z; }
    }
    this.clampTarget(s);
  }

  zoomBy(factor: number, nx?: number, ny?: number): void {
    const dist = THREE.MathUtils.clamp(this.des.dist * factor, MIN_DIST, this.maxDistance());
    const patch: Partial<RigPose> = { dist };
    if (this.zoomToCursor && this.autoTilt) patch.pitch = THREE.MathUtils.clamp(this.autoPitch(dist) + this.tiltOffset, PITCH_MIN, PITCH_MAX);
    if (!this.zoomToCursor || nx === undefined || this.follow) Object.assign(this.des, patch);
    else this.applyLocked(this.des, patch, nx, ny);
  }

  /** Immediate pose (selection, explicit framing): shown and goal agree at once. */
  snap(pose: Partial<RigPose>): void {
    Object.assign(this.des, pose);
    this.clampTarget(this.des);
    if (pose.dist !== undefined && this.autoTilt && pose.pitch === undefined) this.des.pitch = this.autoPitch(this.des.dist);
    this.cur = { ...this.des };
    this.panVel.x = this.panVel.z = 0;
    this.apply();
  }

  /** Same maths as snap but only moves the goal, so the view eases over about 600 ms. */
  ease(pose: Partial<RigPose>): void {
    Object.assign(this.des, pose);
    this.clampTarget(this.des);
    if (this.options.reduced()) this.snap(pose);
  }

  frameBounds(bounds: RigBounds, direction: THREE.Vector3, immediate: boolean): void {
    const dist = this.fitDistance(bounds);
    const dir = direction.clone().normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    const pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)), PITCH_MIN, PITCH_MAX);
    const pose = { tx: (bounds.x0 + bounds.x1) / 2, tz: (bounds.z0 + bounds.z1) / 2, dist, yaw, pitch };
    this.tiltOffset = 0;
    if (immediate) this.snap(pose); else this.ease(pose);
  }

  rotate(step: number): void { this.applyLocked(this.des, { yaw: this.des.yaw + step }); }

  step(dt: number): void {
    if (this.follow) {
      const point = this.follow();
      if (point) {
        const a = 1 - Math.exp(-dt * 5);
        this.des.tx += (point.x - this.des.tx) * a;
        this.des.tz += (point.z - this.des.tz) * a;
        this.clampTarget(this.des);
      }
    }
    this.keyPan(dt);
    if (!this.dragging && Math.abs(this.panVel.x) + Math.abs(this.panVel.z) > 0.01) {
      this.des.tx += this.panVel.x * dt; this.des.tz += this.panVel.z * dt;
      this.cur.tx += this.panVel.x * dt; this.cur.tz += this.panVel.z * dt;
      const f = Math.exp(-dt * 5);
      this.panVel.x *= f; this.panVel.z *= f;
      this.clampTarget(this.des); this.clampTarget(this.cur);
    }
    const a = this.options.reduced() ? 1 : 1 - Math.exp(-dt * 11);
    this.cur.tx += (this.des.tx - this.cur.tx) * a;
    this.cur.tz += (this.des.tz - this.cur.tz) * a;
    this.cur.dist += (this.des.dist - this.cur.dist) * a;
    this.cur.pitch += (this.des.pitch - this.cur.pitch) * a;
    this.cur.yaw += wrapAngle(this.des.yaw - this.cur.yaw) * a;
    if (Math.abs(this.des.tx - this.cur.tx) < SNAP && Math.abs(this.des.tz - this.cur.tz) < SNAP &&
      Math.abs(this.des.dist - this.cur.dist) < SNAP && Math.abs(this.des.pitch - this.cur.pitch) < SNAP &&
      Math.abs(wrapAngle(this.des.yaw - this.cur.yaw)) < SNAP) this.cur = { ...this.des };
    this.apply();
  }

  private apply(): void {
    this.place(this.camera, this.cur);
    this.options.onPose?.();
  }

  private keyPan(dt: number): void {
    if (!this.keys.size) return;
    let f = 0, r = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) f++;
    if (this.keys.has('s') || this.keys.has('arrowdown')) f--;
    if (this.keys.has('d') || this.keys.has('arrowright')) r++;
    if (this.keys.has('a') || this.keys.has('arrowleft')) r--;
    if (!f && !r) return;
    const sp = this.des.dist * 0.7 * dt, sy = Math.sin(this.des.yaw), cy = Math.cos(this.des.yaw);
    this.des.tx += (-sy * f + cy * r) * sp; this.des.tz += (-cy * f - sy * r) * sp;
    this.clampTarget(this.des);
  }

  private blockMenu = (event: Event): void => event.preventDefault();

  private wheel = (event: WheelEvent): void => {
    event.preventDefault();
    const [nx, ny] = this.ndc(event.clientX, event.clientY);
    let dy = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
    dy = THREE.MathUtils.clamp(dy, -240, 240);
    this.zoomBy(Math.exp(dy * (event.ctrlKey ? 0.012 : 0.0017)), nx, ny);
  };

  private pointerDown = (event: PointerEvent): void => {
    this.canvas.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.panVel.x = this.panVel.z = 0;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      this.mode = 'pinch';
      this.dragging = true;
      return;
    }
    this.moved = 0;
    this.down = { x: event.clientX, y: event.clientY, t: performance.now() };
    if (event.button === 2 || event.button === 1 || event.ctrlKey || event.altKey) this.mode = 'orbit';
    else {
      this.mode = 'pan';
      this.grab = this.groundAtClient(event.clientX, event.clientY, new THREE.Vector3());
    }
    this.last = { x: event.clientX, y: event.clientY, t: performance.now() };
    this.dragging = true;
  };

  private pointerMove = (event: PointerEvent): void => {
    const p = this.pointers.get(event.pointerId);
    if (!p) return;
    const px = p.x, py = p.y;
    p.x = event.clientX; p.y = event.clientY;
    if (this.mode === 'pinch' && this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const [nx, ny] = this.ndc(mx, my);
      this.zoomBy(this.pinch.d / Math.max(8, d), nx, ny);
      const [ox, oy] = this.ndc(this.pinch.mx, this.pinch.my);
      const before = this.groundAt(ox, oy, new THREE.Vector3());
      const after = this.groundAt(nx, ny, this.v);
      if (before && after) { this.des.tx += before.x - after.x; this.des.tz += before.z - after.z; this.clampTarget(this.des); }
      this.pinch = { d, mx, my };
      this.options.onUserInput?.();
      return;
    }
    if (this.mode === 'pan' && this.grab) {
      this.moved += Math.abs(event.clientX - px) + Math.abs(event.clientY - py);
      if (this.moved < 4) return;
      this.options.onUserInput?.();
      const after = this.groundAtClient(event.clientX, event.clientY, this.v);
      if (!after) return;
      const dx = this.grab.x - after.x, dz = this.grab.z - after.z;
      this.des.tx += dx; this.des.tz += dz; this.cur.tx += dx; this.cur.tz += dz;
      this.clampTarget(this.des); this.clampTarget(this.cur);
      this.apply();
      const now = performance.now(), dt = Math.max(0.008, (now - this.last.t) / 1000);
      this.panVel.x = this.panVel.x * 0.6 + dx / dt * 0.4;
      this.panVel.z = this.panVel.z * 0.6 + dz / dt * 0.4;
      this.last = { x: event.clientX, y: event.clientY, t: now };
    } else if (this.mode === 'orbit') {
      this.moved += 1;
      this.options.onUserInput?.();
      this.des.yaw -= (event.clientX - px) * 0.006;
      this.cur.yaw = this.des.yaw;
      this.des.pitch = THREE.MathUtils.clamp(this.des.pitch + (event.clientY - py) * 0.005, PITCH_MIN, PITCH_MAX);
      this.cur.pitch = this.des.pitch;
      this.tiltOffset = this.des.pitch - this.autoPitch(this.des.dist);
      this.apply();
    }
  };

  private pointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2 && this.mode === 'pinch') { this.mode = null; this.pinch = null; this.panVel.x = this.panVel.z = 0; this.dragging = this.pointers.size > 0; return; }
    if (this.mode && this.pointers.size === 0) {
      const click = this.moved < 4 && this.down !== null && performance.now() - this.down.t < 500 && event.type === 'pointerup' && event.button === 0;
      if (this.mode === 'pan' && performance.now() - this.last.t > 90) this.panVel.x = this.panVel.z = 0;
      this.mode = null;
      this.dragging = false;
      if (click) this.options.onClick?.(event.clientX, event.clientY);
    }
  };

  private pointerLeave = (): void => { this.pointers.clear(); };

  private keyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    // Shortcuts belong to the farm only; the code editor and every other control keep their own keys.
    const stage = this.canvas.closest('#farm-stage') ?? this.canvas;
    if (target && target !== document.body && target !== document.documentElement && !stage.contains(target)) return;
    if (target && target.matches('input,textarea,select,[contenteditable]')) return;
    const k = event.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      if (target === this.canvas) return; // the canvas a11y layer owns arrows for tile selection
      this.keys.add(k);
      this.follow = null;
      this.options.onUserInput?.();
      event.preventDefault();
    } else if (k === 'q' || k === 'e') {
      this.rotate((k === 'q' ? -1 : 1) * Math.PI / 2);
      this.options.onUserInput?.();
    } else if (k === 'f') {
      this.options.onCycleFollow?.();
    } else if (k === 'home') {
      this.options.onFit?.();
    } else if (k === '+' || k === '=') {
      this.zoomBy(0.8, 0, 0);
    } else if (k === '-') {
      this.zoomBy(1.25, 0, 0);
    }
  };

  private keyUp = (event: KeyboardEvent): void => { this.keys.delete(event.key.toLowerCase()); };

  dispose(): void { this.detach(); }
}

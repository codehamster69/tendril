// Drawing budget (task P4): the pure rules for when the farm view draws a frame and at what resolution.
// No DOM, no three.js, so it can be tested under node. farm-view.ts owns the wiring.

export type Quality = 'auto' | 'low' | 'high';
export const QUALITY_KEY = 'tendril.quality';
/** Dispatched on `window` by the settings screen after it stores a new value. */
export const QUALITY_EVENT = 'tendril:quality';

export const parseQuality = (value: unknown): Quality => (value === 'low' || value === 'high' ? value : 'auto');

/** The stored graphics quality (menu setting, task U5). Missing, blocked or unknown storage means Auto. */
export function readQuality(storage?: Pick<Storage, 'getItem'> | null): Quality {
  try {
    const s = storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : storage;
    return parseQuality(s?.getItem(QUALITY_KEY));
  } catch { return 'auto'; }
}

export const RATIO_FLOOR = 0.75;
export const RATIO_STEP = 0.25;
/** Average frame time (ms, over one second) above which the pixel ratio steps down, and below which it steps up. */
export const SLOW_MS = 20;
export const FAST_MS = 12;

export interface QualityPlan {
  /** Highest device pixel ratio this quality may use. */
  maxRatio: number;
  shadows: boolean;
  /** WebGL antialiasing is fixed when the context is created, so a change applies on the next load. */
  antialias: boolean;
}

/** Low: no shadows, ratio 1, no antialiasing. High: ratio up to 2, shadows, antialiasing. Auto: ratio up to 1.5, shadows, antialiasing only on screens below 2x. */
export function qualityPlan(quality: Quality, devicePixelRatio: number): QualityPlan {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (quality === 'low') return { maxRatio: Math.min(dpr, 1), shadows: false, antialias: false };
  if (quality === 'high') return { maxRatio: Math.min(dpr, 2), shadows: true, antialias: true };
  return { maxRatio: Math.min(dpr, 1.5), shadows: true, antialias: dpr < 2 };
}

/**
 * Dynamic resolution. Feed it the time between consecutive drawn frames; once a second of frames has been seen it
 * steps the pixel ratio down when they averaged over SLOW_MS and up when they averaged under FAST_MS.
 * `add` returns the new ratio when it changed, otherwise null. Gaps (idle, hidden tab) are not frames: call `gap()`.
 */
export class DynamicScale {
  ratio: number;
  private sum = 0;
  private n = 0;
  private span = 0;
  max: number;
  floor: number;
  constructor(max: number, floor = RATIO_FLOOR) { this.max = max; this.floor = floor; this.ratio = max; }

  /** The quality or the screen changed: restart from the new ceiling. */
  setMax(max: number): void {
    this.max = max;
    this.ratio = Math.max(Math.min(this.floor, max), Math.min(this.ratio, max));
    this.reset();
  }

  reset(): void { this.sum = 0; this.n = 0; this.span = 0; }
  /** Forget the slow-at-floor count (the quality changed). */
  clearStrikes(): void { this.floorStrikes = 0; }
  gap(): void { this.reset(); }

  add(frameMs: number): number | null {
    if (!(frameMs > 0)) return null;
    this.sum += frameMs; this.n++; this.span += frameMs;
    if (this.span < 1000) return null;
    const avg = this.sum / this.n;
    this.reset();
    const floor = Math.min(this.floor, this.max);
    let next = this.ratio;
    if (avg > SLOW_MS) next = Math.max(floor, this.ratio - RATIO_STEP);
    else if (avg < FAST_MS) next = Math.min(this.max, this.ratio + RATIO_STEP);
    // Seconds in a row that were still too slow with the resolution already at its floor.
    this.floorStrikes = avg > SLOW_MS && next === this.ratio && this.atFloor ? this.floorStrikes + 1 : 0;
    if (next === this.ratio) return null;
    this.ratio = next;
    return next;
  }
  floorStrikes = 0;
  /** True when the ratio is already at the floor, so a slow average cannot be fixed by resolution any more. */
  get atFloor(): boolean { return this.ratio <= Math.min(this.floor, this.max); }
}

/**
 * Decides whether the next animation frame draws. Something asked (`request`), something is animating (a held
 * `hold()` or the ambient tail after activity), or the last frames were not yet quiet.
 */
export class RenderGate {
  /** Frames in a row with no change that still get drawn, so easing finishes cleanly before the loop stops. */
  static readonly QUIET_FRAMES = 3;
  /** How long ambient motion (sway, rotors, fireflies, pulses) keeps going after the last update or input, in ms. */
  static readonly AMBIENT_MS = 2000;
  private dirty = true;
  private holds = 0;
  private quiet = 0;
  private ambientUntil = 0;

  /** Something changed: draw at least once more. */
  request(): void { this.dirty = true; this.quiet = 0; }
  /** Keep ambient motion running for the tail after `now`. */
  touch(now: number): void { this.ambientUntil = Math.max(this.ambientUntil, now + RenderGate.AMBIENT_MS); this.request(); }
  /** Number of modules that currently need continuous frames. */
  get animating(): number { return this.holds; }
  /** Start an animation; call the returned function exactly once when it ends. Extra calls are ignored. */
  hold(): () => void {
    let open = true;
    this.holds++; this.request();
    return () => { if (!open) return; open = false; this.holds--; this.request(); };
  }
  ambient(now: number): boolean { return now < this.ambientUntil; }
  /** True while frames should keep coming. `changed` is whether the frame just drawn moved something on screen. */
  next(now: number, changed: boolean): boolean {
    if (changed || this.dirty || this.holds > 0 || this.ambient(now)) { this.dirty = false; this.quiet = 0; return true; }
    return ++this.quiet <= RenderGate.QUIET_FRAMES ? true : false;
  }
  /** After the loop stopped, the next wake starts from a clean count. */
  stopped(): void { this.quiet = 0; this.dirty = false; }
}

/**
 * Shadow-map refresh policy: at once on a change; while only dynamic casters (drones, carried crops) move, at most every
 * `intervalMs`; and once more when they stop, so the final shadows are never left stale.
 */
export class ShadowClock {
  private last = -Infinity;
  private pending = false;
  intervalMs: number;
  constructor(intervalMs = 100) { this.intervalMs = intervalMs; }
  due(now: number, changed: boolean, dynamic: boolean): boolean {
    if (changed || (dynamic && now - this.last >= this.intervalMs) || (!dynamic && this.pending)) { this.last = now; this.pending = false; return true; }
    if (dynamic) this.pending = true;
    return false;
  }
}

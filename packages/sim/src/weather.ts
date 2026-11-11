// Infinite weather schedule generated on demand; range queries by segment overlap.
import type { Segment, World } from './types.ts';

/** xorshift32 on uint32; returns the new state. */
export function rand(x: number): number {
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  return x;
}

/** Make sure the schedule covers tick `upTo` (last segment ends after it). */
export function ensureWeather(w: World, upTo: number): void {
  const segs = w.weather;
  while ((segs.length ? segs[segs.length - 1]!.end : 0) <= upTo) {
    let t = segs.length ? segs[segs.length - 1]!.end : 0;
    w.wrng = rand(w.wrng); t += 300 + (w.wrng % 500);
    w.wrng = rand(w.wrng);
    let kind: Segment['kind']; let len: number;
    if (w.wrng % 4 === 0) { kind = 'frost'; w.wrng = rand(w.wrng); len = 60 + (w.wrng % 60); }
    else { kind = 'rain'; w.wrng = rand(w.wrng); len = 80 + (w.wrng % 120); }
    segs.push({ kind, start: t, end: t + len });
  }
}

/** Index of the first segment whose end is > a (schedule must already cover a). */
export function firstEndAfter(w: World, a: number): number {
  const s = w.weather; let lo = 0, hi = s.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (s[m]!.end > a) hi = m; else lo = m + 1; }
  return lo;
}

const ceil4 = (x: number): number => Math.floor((x + 3) / 4);

/** Ticks T in [a, b) that are rain and T % 4 == 0. */
export function rainTicks(w: World, a: number, b: number): number {
  if (b <= a) return 0;
  ensureWeather(w, b);
  let n = 0;
  for (let i = firstEndAfter(w, a); i < w.weather.length; i++) {
    const s = w.weather[i]!;
    if (s.start >= b) break;
    if (s.kind !== 'rain') continue;
    n += ceil4(Math.min(b, s.end)) - ceil4(Math.max(a, s.start));
  }
  return n;
}

/** Frost ticks in [a, b). */
export function frostTicks(w: World, a: number, b: number): number {
  if (b <= a) return 0;
  ensureWeather(w, b);
  let n = 0;
  for (let i = firstEndAfter(w, a); i < w.weather.length; i++) {
    const s = w.weather[i]!;
    if (s.start >= b) break;
    if (s.kind !== 'frost') continue;
    n += Math.min(b, s.end) - Math.max(a, s.start);
  }
  return n;
}

export function weatherAt(w: World, tick: number): 'clear' | 'rain' | 'frost' {
  ensureWeather(w, tick);
  const i = firstEndAfter(w, tick);
  const s = w.weather[i];
  return s && s.start <= tick ? s.kind : 'clear';
}

/** Segments overlapping [tick, tick + n). */
export function forecast(w: World, n: number): Segment[] {
  const a = w.tick, b = a + n;
  if (n <= 0) return [];
  ensureWeather(w, b);
  const out: Segment[] = [];
  for (let i = firstEndAfter(w, a); i < w.weather.length; i++) {
    const s = w.weather[i]!;
    if (s.start >= b) break;
    out.push({ kind: s.kind, start: s.start, end: s.end });
  }
  return out;
}

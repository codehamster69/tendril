// The one clock of the "a run is a day" idea. Pure maths, no DOM, so the sky (farm-light.ts) and the dial
// (day-dial.ts) cannot disagree: both call dayProgress() with the same tick.

/** Endless has no end, so its dial loops once per in-game day of this many ticks. */
export const ENDLESS_DAY_TICKS = 3600;
/** The sky recomputes its target at most once per this much progress (about 4 times a second at 16x on a 3,600 tick run). */
export const SKY_STEP = 0.01;

export interface DayInfo {
  /** 0 at sunrise, 1 at sunset. */
  progress: number;
  /** 1-based day number. Always 1 for a run with an end. */
  day: number;
  /** First tick of the window the dial shows, and its length in ticks. */
  start: number;
  length: number;
  /** True in Endless and sandbox, where the dial loops. */
  looping: boolean;
}

/** `runTicks` is the scenario's tick limit; null or 0 means the run has no end. */
export function dayProgress(tick: number, runTicks?: number | null, dayTicks: number = ENDLESS_DAY_TICKS): DayInfo {
  const t = Math.max(0, Math.floor(Number.isFinite(tick) ? tick : 0));
  if (runTicks && runTicks > 0) return { progress: Math.min(1, t / runTicks), day: 1, start: 0, length: runTicks, looping: false };
  const idx = Math.floor(t / dayTicks);
  return { progress: (t - idx * dayTicks) / dayTicks, day: idx + 1, start: idx * dayTicks, length: dayTicks, looping: true };
}

/** What the sky follows: progress rounded down to SKY_STEP, so light only changes a few times a second. */
export const skyStep = (progress: number): number => Math.min(1, Math.floor(progress / SKY_STEP + 1e-9) * SKY_STEP);

/** Position of tick `t` on the dial as 0..1, or null when it lies outside the shown window. */
export function markAt(t: number, info: DayInfo): number | null {
  const p = (t - info.start) / info.length;
  return p >= 0 && p <= 1 ? p : null;
}

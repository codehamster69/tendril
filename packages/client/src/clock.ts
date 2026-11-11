export type Mode = 'live' | 'sandbox' | 'campaign' | 'daily';
export interface Meta { seed: number; startedAtMs: number; mode: Mode; farmId?: string; rulesVersion?: number }

export const TICKS_PER_SECOND = 10;
export const MS_PER_TICK = 1000 / TICKS_PER_SECOND;

/** The tick a live farm should have reached at wall-clock time nowMs. */
export function targetTick(meta: Meta, nowMs: number): number {
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor((nowMs - meta.startedAtMs) / MS_PER_TICK)));
}

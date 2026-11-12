// Arena helpers (SIM_SPEC.md appendix "Arena helpers"). Pure; no rules change.
import { COMPOSTER, DAILY_TICKS, HIVE, PLOT_SIZE } from './rules.ts';
import { IllegalAction } from './types.ts';
import type { LogEntry, Setup, World } from './types.ts';
import { applyAction, netWorth, scanAt, tickWorld } from './world.ts';

/** Daily number 1 falls on this UTC date. */
export const DAILY_EPOCH = '2026-12-01';
/**
 * Net worth at tick 3000 that the bundled `daily.sprout` example reaches or beats on 96 of the 100 daily seeds
 * starting at DAILY_EPOCH (its 100-seed range is 286..352). Recalibrate only with a rules version bump.
 */
export const DAILY_PAR = 290;

const DAY_MS = 86_400_000;
function utcDay(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error('date must be YYYY-MM-DD');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw new Error('not a real date');
  return ms / DAY_MS;
}

/** 1 on DAILY_EPOCH, counting one per UTC day. Dates before the epoch give 0 or negative numbers. */
export function dailyNumber(date: string): number {
  return utcDay(date) - utcDay(DAILY_EPOCH) + 1;
}

/**
 * 64 characters for plot (0,0), row by row (y then x): B barn, h hive, c composter, 1..6 crop id,
 * t tilled and empty, 0 untilled. Reads settled state without changing the world.
 */
export function farmMosaic(world: World): string {
  let out = '';
  for (let y = 0; y < PLOT_SIZE; y++) {
    for (let x = 0; x < PLOT_SIZE; x++) {
      const s = scanAt(world, x, y)!;
      if (s.barn) out += 'B';
      else if (s.building === HIVE) out += 'h';
      else if (s.building === COMPOSTER) out += 'c';
      else if (s.crop >= 1 && s.crop <= 6) out += String(s.crop);
      else out += s.tilled ? 't' : '0';
    }
  }
  return out;
}

export interface ParReplay {
  /** Net worth at the end (tick `toTick`). */
  netWorth: number;
  /** First world tick at which net worth was at or above `par`, or null. Checked at tick 0, after every action and after every tick. */
  parTick: number | null;
  mosaic: string;
}

/**
 * Same validation and result as `replayChunk`, plus the mosaic and the first tick net worth reached `par`.
 * Mutates `world`; throws IllegalAction on any bad entry (discard the world).
 */
export function replayWithPar(world: World, actions: LogEntry[], toTick: number, par: number): ParReplay {
  if (!Number.isSafeInteger(toTick) || toTick < world.tick) throw new IllegalAction(`bad toTick ${toTick}`);
  if (!Number.isSafeInteger(par)) throw new IllegalAction(`bad par ${par}`);
  let parTick: number | null = null;
  const check = (): void => { if (parTick === null && netWorth(world) >= par) parTick = world.tick; };
  check();
  const advance = (to: number): void => { while (world.tick < to) { tickWorld(world); check(); } };
  for (const e of actions) {
    const t = Array.isArray(e) ? e[0] : undefined;
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < world.tick || t >= toTick) {
      throw new IllegalAction(`bad action tick ${String(t)}`);
    }
    advance(t);
    applyAction(world, e);
    check();
  }
  advance(toTick);
  return { netWorth: netWorth(world), parTick, mosaic: farmMosaic(world) };
}

export type ChallengeKind = 'daily' | 'season' | 'duel';
export interface ChallengeSetup { ticks: number; setup: Setup }

/**
 * Starting conditions for a challenge, a pure function of kind and seed. Defaults for now (the standard
 * farm, DAILY_TICKS); callers must create worlds through this so later modifiers do not touch the replay path.
 */
export function challengeSetup(kind: ChallengeKind, seed: number): ChallengeSetup {
  if (kind !== 'daily' && kind !== 'season' && kind !== 'duel') throw new Error(`bad challenge kind ${String(kind)}`);
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be a safe integer');
  return { ticks: DAILY_TICKS, setup: {} };
}


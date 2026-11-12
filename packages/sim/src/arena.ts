// Arena helpers (SIM_SPEC.md appendix "Arena helpers"). Pure; no rules change.
import { COMPOSTER, DAILY_TICKS, HIVE, PLOT_SIZE, SEASON_TICKS, UNLOCKS } from './rules.ts';
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

/** Challenges created before modifiers existed use version 0 (the plain farm); new rows use SETUP_VERSION. Stored per challenge row. */
export const SETUP_LEGACY = 0;
export const SETUP_VERSION = 1;

/** Bounds of the daily draw, documented in SIM_SPEC.md "Challenge modifiers". */
export const MODIFIER_BOUNDS = {
  coinsStep: 10, coinsSteps: 7,          // starting coins: 0, 10, ... 60
  research: [0, 0b010, 0b100],           // free starting research: none, wheat, clover
  weather: [-1, 0, 1],                   // weatherBias: frosty, standard, calm
  ticks: [2400, 3000, 3600],             // tick budget (daily and duel; seasons keep SEASON_TICKS)
} as const;
/** Par is this percentage of the reference program's net worth, rounded down, at least PAR_MIN. */
export const PAR_PERCENT = 90;
export const PAR_MIN = 60;

export interface ChallengeModifiers { coins: number; research: number; weatherBias: number; ticks: number }
export interface ChallengeSetup { ticks: number; setup: Setup; modifiers: ChallengeModifiers | null }

/** xorshift32 draws from the seed; `n` values below the bound, using the high bits. */
function drawer(seed: number): (n: number) => number {
  let s = ((seed ^ 0xC0DE5EED) >>> 0) || 1;
  return (n) => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return (s >>> 8) % n; };
}

/**
 * Starting conditions for a challenge, a pure function of kind, seed and setup version. Version 0 is the plain farm
 * (old challenges); version 1 draws the day's modifiers from the seed inside MODIFIER_BOUNDS. Callers must create
 * challenge worlds through this, passing the version stored with the challenge.
 */
export function challengeSetup(kind: ChallengeKind, seed: number, version: number = SETUP_VERSION): ChallengeSetup {
  if (kind !== 'daily' && kind !== 'season' && kind !== 'duel') throw new Error(`bad challenge kind ${String(kind)}`);
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be a safe integer');
  if (version !== SETUP_LEGACY && version !== SETUP_VERSION) throw new Error(`bad setup version ${String(version)}`);
  if (version === SETUP_LEGACY) return { ticks: kind === 'season' ? SEASON_TICKS : DAILY_TICKS, setup: {}, modifiers: null };
  const draw = drawer(seed);
  const b = MODIFIER_BOUNDS;
  const coins = draw(b.coinsSteps) * b.coinsStep;
  const research = b.research[draw(b.research.length)]!;
  const weatherBias = b.weather[draw(b.weather.length)]!;
  const dayTicks = b.ticks[draw(b.ticks.length)]!;
  const ticks = kind === 'season' ? SEASON_TICKS : dayTicks;
  const setup: Setup = {};
  if (coins) setup.coins = coins;
  if (research) setup.unlocks = 1 | research;
  if (weatherBias) setup.weatherBias = weatherBias;
  return { ticks, setup, modifiers: { coins, research, weatherBias, ticks } };
}

/** Par for a challenge from the reference program's end net worth. */
export function parFromReference(referenceNetWorth: number): number {
  if (!Number.isSafeInteger(referenceNetWorth)) throw new Error('bad net worth');
  return Math.max(PAR_MIN, Math.floor((referenceNetWorth * PAR_PERCENT) / 100));
}

/** Short labels for the day's modifiers, shared by the game header and the site. Empty for a plain farm. */
export function describeModifiers(m: ChallengeModifiers | null, kind: ChallengeKind = 'daily'): string[] {
  if (!m) return [];
  const out: string[] = [];
  if (m.coins) out.push(`${m.coins} starting coins`);
  if (m.research) for (let i = 1; i < UNLOCKS.length; i++) if (m.research & (1 << i)) out.push(`${UNLOCKS[i]!.name} researched`);
  if (m.weatherBias) out.push(m.weatherBias < 0 ? 'frosty weather' : 'calm weather');
  if (kind !== 'season') out.push(`${m.ticks.toLocaleString('en-US')} ticks`);
  return out;
}

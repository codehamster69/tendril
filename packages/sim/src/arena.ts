// Arena helpers (SIM_SPEC.md appendix "Arena helpers"). Pure; no rules change.
import { BASE_RULES_VERSION, COMPOSTER, DAILY_TICKS, HIVE, ITEMS, ITEM_COUNT, OP, PLOT_SIZE, RULES_VERSION, SEASON_TICKS, UNLOCKS } from './rules.ts';
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
  /** Units sold per item (length 8, index 1..7): `b` is counted when a sell action really removed `b` units from stock. Order deliveries do not count. */
  sold: number[];
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
  const sold = new Array<number>(ITEM_COUNT).fill(0);
  const check = (): void => { if (parTick === null && netWorth(world) >= par) parTick = world.tick; };
  check();
  const advance = (to: number): void => { while (world.tick < to) { tickWorld(world); check(); } };
  for (const e of actions) {
    const t = Array.isArray(e) ? e[0] : undefined;
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < world.tick || t >= toTick) {
      throw new IllegalAction(`bad action tick ${String(t)}`);
    }
    advance(t);
    const item = e[2] === OP.sell && Number.isInteger(e[3]) && e[3]! >= 1 && e[3]! < ITEM_COUNT ? e[3]! : 0;
    const before = item ? world.stock[item]! : 0;
    applyAction(world, e);
    if (item) sold[item] = sold[item]! + (before - world.stock[item]!);
    check();
  }
  advance(toTick);
  return { netWorth: netWorth(world), sold, parTick, mosaic: farmMosaic(world) };
}

/** Units sold per item over a log (length 8, index 1..7), exactly as `replayWithPar` counts them. Mutates `world`; throws IllegalAction on a bad log. */
export function replayStats(world: World, actions: LogEntry[], toTick: number): number[] {
  return replayWithPar(world, actions, toTick, Number.MAX_SAFE_INTEGER).sold;
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
export function challengeSetup(kind: ChallengeKind, seed: number, version: number = SETUP_VERSION, market?: { p: number[] } | null): ChallengeSetup {
  if (kind !== 'daily' && kind !== 'season' && kind !== 'duel') throw new Error(`bad challenge kind ${String(kind)}`);
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be a safe integer');
  if (version !== SETUP_LEGACY && version !== SETUP_VERSION) throw new Error(`bad setup version ${String(version)}`);
  if (market && kind === 'season') throw new Error('seasons have no market');
  if (version === SETUP_LEGACY) return { ticks: kind === 'season' ? SEASON_TICKS : DAILY_TICKS, setup: market ? { prices: market.p } : {}, modifiers: null };
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
  if (market) setup.prices = market.p;
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

// ---- Rules version 4: the shared daily market (SIM_SPEC.md section 4). Pure integer maths; no rules, only inputs. ----

/** Dailies dated before this stay rules v3 at base prices; from this date on they use the market. */
export const MARKET_EPOCH = '2026-12-08';
export const MARKET = {
  LO: 500, HI: 2000, STEP: 250, MIN_PLAYERS: 10, SMOOTH: [3, 2, 1],
  /** Permille of units sold per item (index 1..7): the equal-revenue split, proportional to 1 / base price. Fixed for version 4. */
  BASE_SHARE: [0, 194, 129, 388, 65, 97, 78, 49],
  WINDOW: 14, MIN_VALID: 7,
} as const;

/** Arrays are indexed by item id: length 8, index 0 unused (0). */
export interface MarketTable {
  /** Multipliers in permille of base price. */ m: number[];
  /** Centicoin prices the world uses. */ p: number[];
  /** Raw target multipliers of the day. */ t: number[];
  /** Yesterday's observed shares in permille, or null when fewer than MIN_PLAYERS counted. */ sh: number[] | null;
  /** Players counted. */ n: number;
  /** Challenge id of the previous day's table this was derived from, or null. */ from: string | null;
}
/** What the next table needs from an earlier day's stored table. */
export type MarketRow = Pick<MarketTable, 'm' | 't' | 'sh'> & { id?: string };

const NEUTRAL_MULT = 1000;
const neutral = (): number[] => [0, ...new Array<number>(ITEM_COUNT - 1).fill(NEUTRAL_MULT)];
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** True when the daily dated `date` uses the market. */
export function marketActive(date: string): boolean {
  utcDay(date);
  return date >= MARKET_EPOCH;
}
/** Rules version of the daily dated `date`: 4 from MARKET_EPOCH, else 3. */
export function dailyRulesVersion(date: string): number { return marketActive(date) ? RULES_VERSION : BASE_RULES_VERSION; }
/** Whole UTC days from today until the market opens (0 once open). */
export function daysUntilMarket(date: string): number { return Math.max(0, utcDay(MARKET_EPOCH) - utcDay(date)); }
/** One line of the market board: item, price in coins, change against base, and yesterday's share of units sold. */
export interface MarketRowView { item: number; name: string; price: string; change: string; share: string | null; trend: 'up' | 'down' | 'flat' }
export type MarketView =
  | { kind: 'soon'; days: number; text: string }
  | { kind: 'open'; text: string; rows: MarketRowView[] };
/**
 * What the game and the site show for the daily dated `date` (text only, no rules). Before MARKET_EPOCH: "Market opens in N days".
 * From the epoch: the day's prices and yesterday's shares. Null when `date` is on a market day but the table is missing.
 */
export function describeMarket(date: string, market: { prices: readonly number[]; multipliers: readonly number[]; shares: readonly number[] | null } | null | undefined): MarketView | null {
  if (!marketActive(date)) {
    const days = daysUntilMarket(date);
    return { kind: 'soon', days, text: days === 1 ? 'Market opens tomorrow' : `Market opens in ${days} days` };
  }
  if (!market) return null;
  const rows: MarketRowView[] = [];
  for (let c = 1; c < ITEM_COUNT; c++) {
    const m = market.multipliers[c] ?? NEUTRAL_MULT;
    const pct = Math.round((m - NEUTRAL_MULT) / 10);
    const cents = market.prices[c] ?? 0;
    const sh = market.shares?.[c];
    rows.push({
      item: c, name: ITEMS[c]!.name, price: (cents / 100).toFixed(2), change: pct === 0 ? 'base' : `${pct > 0 ? '+' : '\u2212'}${Math.abs(pct)}%`,
      share: sh == null ? null : `${Math.round(sh / 10)}%`, trend: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat',
    });
  }
  return { kind: 'open', text: market.shares ? "Today's prices, and what the crowd sold yesterday" : "Today's prices (too few sales yesterday to show shares)", rows };
}
/** The table for a market day with no earlier data: every price at base. */
export function baseMarket(): MarketTable {
  const m = neutral();
  return { m, p: marketPrices(m), t: neutral(), sh: null, n: 0, from: null };
}
/** Centicoin prices from multipliers: `floor(base * m / 10)`. */
export function marketPrices(m: readonly number[]): number[] {
  return m.map((x, c) => (c >= 1 && c < ITEM_COUNT ? Math.floor(ITEMS[c]!.price * x / 10) : 0));
}

/**
 * Observed shares of the players' sold vectors (each length 8, index 1..7), one vector per player (their best entry).
 * Players who sold nothing are not counted. Every player counts equally, whatever their volume.
 */
export function observedShares(sold: readonly (readonly number[])[]): { n: number; sh: number[] | null } {
  const rows = sold.filter((s) => { let u = 0; for (let c = 1; c < ITEM_COUNT; c++) u += s[c] ?? 0; return u > 0; });
  const n = rows.length;
  if (n < MARKET.MIN_PLAYERS) return { n, sh: null };
  const sh = new Array<number>(ITEM_COUNT).fill(0);
  for (const s of rows) {
    let u = 0;
    for (let c = 1; c < ITEM_COUNT; c++) u += s[c] ?? 0;
    for (let c = 1; c < ITEM_COUNT; c++) sh[c] = sh[c]! + Math.floor(1000 * (s[c] ?? 0) / u);
  }
  for (let c = 1; c < ITEM_COUNT; c++) sh[c] = Math.floor(sh[c]! / n);
  return { n, sh };
}

/** Blended target share from the `sh` of the last WINDOW rows (null or missing skipped). Fewer than MIN_VALID valid rows: BASE_SHARE. */
export function blendedTarget(history: readonly (readonly number[] | null | undefined)[]): number[] {
  const win = history.slice(0, MARKET.WINDOW).filter((h): h is readonly number[] => !!h);
  const tgt = new Array<number>(ITEM_COUNT).fill(0);
  for (let c = 1; c < ITEM_COUNT; c++) {
    if (win.length < MARKET.MIN_VALID) { tgt[c] = MARKET.BASE_SHARE[c]!; continue; }
    let sum = 0;
    for (const h of win) sum += h[c]!;
    const trail = Math.floor(sum / win.length);
    tgt[c] = Math.max(1, Math.floor((MARKET.BASE_SHARE[c]! + trail) / 2));
  }
  return tgt;
}

/** Raw target multipliers (permille): neutral without shares, else 2e6/(1000+rho) clamped to the band. */
export function rawTarget(sh: readonly number[] | null, tgt: readonly number[]): number[] {
  const t = neutral();
  if (!sh) return t;
  for (let c = 1; c < ITEM_COUNT; c++) {
    const rho = Math.floor(1000 * sh[c]! / tgt[c]!);
    t[c] = clamp(Math.floor(2_000_000 / (1000 + rho)), MARKET.LO, MARKET.HI);
  }
  return t;
}

/** One smoothed, capped step from yesterday's multipliers `prev`. `t1` and `t2` are the raw targets of the two days before (missing = neutral). */
export function nextMultipliers(prev: readonly number[], t0: readonly number[], t1?: readonly number[] | null, t2?: readonly number[] | null): number[] {
  const a = t1 ?? neutral(), b = t2 ?? neutral();
  const [w0, w1, w2] = MARKET.SMOOTH;
  const m = neutral();
  for (let c = 1; c < ITEM_COUNT; c++) {
    const avg = Math.floor((w0 * t0[c]! + w1 * a[c]! + w2 * b[c]!) / (w0 + w1 + w2));
    m[c] = prev[c]! + clamp(avg - prev[c]!, -MARKET.STEP, MARKET.STEP);
  }
  return m;
}

/**
 * The market table of a day from the sold vectors of the day before (one per player: their highest-net-worth entry) and
 * the stored rows of the days before, newest first (`earlier[0]` is D-1; null where a row is missing or has no market).
 * Without any earlier row the base prices are the starting point.
 */
export function nextMarket(sold: readonly (readonly number[])[], earlier: readonly (MarketRow | null)[]): MarketTable {
  const { n, sh } = observedShares(sold);
  const tgt = blendedTarget([sh, ...earlier.slice(0, MARKET.WINDOW - 1).map((r) => r?.sh)]);
  const t = rawTarget(sh, tgt);
  const yesterday = earlier[0] ?? null;
  const m = nextMultipliers(yesterday?.m ?? neutral(), t, yesterday?.t, earlier[1]?.t);
  return { m, p: marketPrices(m), t, sh, n, from: yesterday?.id ?? null };
}

/** Validates a table read from storage or a client: bounds, lengths and the price/multiplier relation. */
export function isMarketTable(x: unknown): x is MarketTable {
  if (typeof x !== 'object' || x === null) return false;
  const v = x as Record<string, unknown>;
  const vec = (a: unknown, lo: number, hi: number): a is number[] => Array.isArray(a) && a.length === ITEM_COUNT && a[0] === 0 && a.every((q, i) => i === 0 || (Number.isSafeInteger(q) && (q as number) >= lo && (q as number) <= hi));
  if (!vec(v.m, MARKET.LO, MARKET.HI) || !vec(v.t, MARKET.LO, MARKET.HI) || !vec(v.p, 1, 100_000)) return false;
  if (v.sh !== null && !vec(v.sh, 0, 1000)) return false;
  if (!Number.isSafeInteger(v.n) || (v.n as number) < 0) return false;
  if (v.from !== null && typeof v.from !== 'string') return false;
  const p = marketPrices(v.m as number[]);
  return p.every((q, i) => q === (v.p as number[])[i]);
}

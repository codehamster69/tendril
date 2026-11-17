// Arena helpers (SIM_SPEC.md appendix "Arena helpers"). Pure; no rules change.
import { BASE_RULES_VERSION, COMPOSTER, DAILY_TICKS, HIVE, ITEMS, ITEM_COUNT, MARKET_RULES_VERSION, OP, PLOT_SIZE, RULES_VERSION, SEASON_TICKS, UNLOCKS } from './rules.ts';
import { IllegalAction } from './types.ts';
import type { Goal, LogEntry, Setup, World } from './types.ts';
import { SETUP_BRIEF, briefActive, drawBrief } from './brief.ts';
import type { Brief } from './brief.ts';
import { applyAction, netWorth, scanAt, tickWorld } from './world.ts';
import { utcDay } from './date.ts';

/** Daily number 1 falls on this UTC date. */
export const DAILY_EPOCH = '2026-12-01';
/**
 * Net worth at tick 3000 that the bundled `daily.sprout` example reaches or beats on 96 of the 100 daily seeds
 * starting at DAILY_EPOCH (its 100-seed range is 286..352). Recalibrate only with a rules version bump.
 */
export const DAILY_PAR = 290;

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

export interface GoalReplay {
  /** The goal's score at the end (net worth when `goal` is null). */
  score: number;
  /** First world tick at which the score was at or above `par`, or null. Checked at tick 0, after every action and after every tick. */
  parTick: number | null;
  netWorth: number;
  /** Units sold per item (length 8, index 1..7), counted as in `ParReplay`. */
  sold: number[];
  /** Units deposited per item (length 8, index 1..7): the stock a deposit action really added (barn or silo). */
  deposited: number[];
  /** Coins paid by order deliveries. */
  orderCoins: number;
  mosaic: string;
}

/** Festival score: filled permille 0..1000, `floor(sum(min(deposited, quota)) * 1000 / sum(quota))`; 0 when no quota is set. */
export function festivalScore(quotas: readonly number[] | undefined, deposited: readonly number[]): number {
  let total = 0, filled = 0;
  for (let c = 1; c < ITEM_COUNT; c++) { const q = quotas?.[c] ?? 0; total += q; filled += Math.min(q, deposited[c] ?? 0); }
  return total > 0 ? Math.floor(filled * 1000 / total) : 0;
}

/**
 * Replays `actions` to `toTick` like `replayChunk` and scores the run by `goal` (SIM_SPEC 6.5): wealth and specialist = net worth, orders =
 * coins from deliveries, inherited = net worth minus the net worth when the replay started, festival = filled permille. `goal` null is
 * today's behaviour (score = net worth). Mutates `world`; throws IllegalAction on any bad entry (discard the world).
 */
export function replayWithGoal(world: World, actions: LogEntry[], toTick: number, goal: Goal | null, par: number): GoalReplay {
  if (!Number.isSafeInteger(toTick) || toTick < world.tick) throw new IllegalAction(`bad toTick ${toTick}`);
  if (!Number.isSafeInteger(par)) throw new IllegalAction(`bad par ${par}`);
  let parTick: number | null = null;
  const sold = new Array<number>(ITEM_COUNT).fill(0);
  const deposited = new Array<number>(ITEM_COUNT).fill(0);
  let orderCoins = 0;
  const start = netWorth(world);
  const kind = goal?.kind ?? 'wealth';
  const score = (): number => (kind === 'festival' ? festivalScore(goal!.quotas, deposited) : kind === 'orders' ? orderCoins : kind === 'inherited' ? netWorth(world) - start : netWorth(world));
  const check = (): void => { if (parTick === null && score() >= par) parTick = world.tick; };
  check();
  const advance = (to: number): void => { while (world.tick < to) { tickWorld(world); check(); } };
  for (const e of actions) {
    const t = Array.isArray(e) ? e[0] : undefined;
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < world.tick || t >= toTick) {
      throw new IllegalAction(`bad action tick ${String(t)}`);
    }
    advance(t);
    const op = e[2];
    const item = op === OP.sell && Number.isInteger(e[3]) && e[3]! >= 1 && e[3]! < ITEM_COUNT ? e[3]! : 0;
    const before = item ? world.stock[item]! : 0;
    const stockBefore = op === OP.deposit ? world.stock.slice() : null;
    const res = applyAction(world, e);
    if (item) sold[item] = sold[item]! + (before - world.stock[item]!);
    if (stockBefore) for (let c = 1; c < ITEM_COUNT; c++) deposited[c] = deposited[c]! + (world.stock[c]! - stockBefore[c]!);
    if (op === OP.deliver) orderCoins += res;
    check();
  }
  advance(toTick);
  return { score: score(), parTick, netWorth: netWorth(world), sold, deposited, orderCoins, mosaic: farmMosaic(world) };
}

/**
 * Same validation and result as `replayChunk`, plus the mosaic and the first tick net worth reached `par`.
 * Mutates `world`; throws IllegalAction on any bad entry (discard the world).
 */
export function replayWithPar(world: World, actions: LogEntry[], toTick: number, par: number): ParReplay {
  const r = replayWithGoal(world, actions, toTick, null, par);
  return { netWorth: r.netWorth, sold: r.sold, parTick: r.parTick, mosaic: r.mosaic };
}

/**
 * Final score of a brief challenge from the per-farm scores (visible farm first, then the hidden ones): the sum. `finalParTick` is the sum of
 * the per-farm par ticks (a farm that never reached par counts as `budget`) when the summed score is at least `par` per farm, else null.
 */
export function finalOf(scores: readonly number[], parTicks: readonly (number | null)[], budget: number, par: number): { finalScore: number; finalParTick: number | null } {
  if (scores.length === 0 || scores.length !== parTicks.length) throw new Error('one score and one par tick per farm');
  const finalScore = scores.reduce((a, b) => a + b, 0);
  const finalParTick = finalScore >= par * scores.length ? parTicks.reduce<number>((a, t) => a + (t ?? budget), 0) : null;
  return { finalScore, finalParTick };
}

/** Units sold per item over a log (length 8, index 1..7), exactly as `replayWithPar` counts them. Mutates `world`; throws IllegalAction on a bad log. */
export function replayStats(world: World, actions: LogEntry[], toTick: number): number[] {
  return replayWithPar(world, actions, toTick, Number.MAX_SAFE_INTEGER).sold;
}

export type ChallengeKind = 'daily' | 'season' | 'duel';

/** Setup version for a new challenge dated `date` (a season: the date it starts): `SETUP_BRIEF` from `BRIEF_EPOCH`, else `SETUP_VERSION`. */
export function setupVersionFor(date: string): number { return briefActive(date) ? SETUP_BRIEF : SETUP_VERSION; }

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
export interface ChallengeSetup { ticks: number; setup: Setup; modifiers: ChallengeModifiers | null; /** Setup version 2 only. */ brief?: Brief }

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
export function challengeSetup(kind: ChallengeKind, seed: number, version: number = SETUP_VERSION, market?: { p: number[] } | null, rulesVersion?: number, source?: 'daily' | 'season'): ChallengeSetup {
  const out = baseSetup(kind, seed, version, market, source);
  if (rulesVersion === RULES_VERSION) out.setup.siloTick = 0; // rules v5: silos from the first tick
  return out;
}

function baseSetup(kind: ChallengeKind, seed: number, version: number, market?: { p: number[] } | null, source?: 'daily' | 'season'): ChallengeSetup {
  if (kind !== 'daily' && kind !== 'season' && kind !== 'duel') throw new Error(`bad challenge kind ${String(kind)}`);
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be a safe integer');
  if (version !== SETUP_LEGACY && version !== SETUP_VERSION && version !== SETUP_BRIEF) throw new Error(`bad setup version ${String(version)}`);
  if (market && kind === 'season') throw new Error('seasons have no market');
  if (version === SETUP_LEGACY) return { ticks: kind === 'season' ? SEASON_TICKS : DAILY_TICKS, setup: market ? { prices: market.p } : {}, modifiers: null };
  if (version === SETUP_BRIEF) {
    const { brief, setup, priceMult } = drawBrief(kind, seed, source);
    if (priceMult) {
      // Specialist: the day's price (market table or base) times the multiplier, whole centicoins, at least 1.
      setup.prices = priceMult.map((m, c) => (c >= 1 && c < ITEM_COUNT ? Math.max(1, Math.floor((market ? market.p[c]! : ITEMS[c]!.price * 100) * m / 1000)) : 0));
    } else if (market) setup.prices = market.p;
    return { ticks: brief.ticks, setup, modifiers: null, brief };
  }
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
/** Rules version of the daily dated `date`: 5 from SILO_EPOCH, 4 from MARKET_EPOCH, else 3. */
export function dailyRulesVersion(date: string): number {
  return siloActive(date) ? RULES_VERSION : marketActive(date) ? MARKET_RULES_VERSION : BASE_RULES_VERSION;
}
/** True when a challenge of this kind and rules version may carry a market table: v4, and v5 except seasons. */
export function marketAllowed(rulesVersion: number, kind: ChallengeKind): boolean {
  return rulesVersion === MARKET_RULES_VERSION || (rulesVersion === RULES_VERSION && kind !== 'season');
}
/**
 * Whether a challenge's table (present or not) fits its rules: v4 always has one, v3 and seasons never, and v5 dailies and duels
 * may (a v5 daily has one from MARKET_EPOCH, since silos switched on before the market). Dispatch by data, as SIM_SPEC 4.1.
 */
export function marketFits(rulesVersion: number, kind: ChallengeKind, hasMarket: boolean): boolean {
  if (rulesVersion === MARKET_RULES_VERSION) return hasMarket;
  return hasMarket ? marketAllowed(rulesVersion, kind) : true;
}

// ---- Rules version 5: silos and sellPlot (SIM_SPEC.md section 5). ----

/** Silos and sellPlot switch on at 00:00 UTC on this date: dailies dated from it, seasons starting from it, Endless farms from that moment. */
export const SILO_EPOCH = '2026-11-17';
/** SILO_EPOCH as Unix milliseconds. */
export const SILO_EPOCH_MS = Date.UTC(2026, 10, 17);
/** Endless ticks run at one per 100 ms from the farm's start. */
const ENDLESS_MS_PER_TICK = 100;
/** True when a daily dated `date`, or a season starting that day, uses rules v5. */
export function siloActive(date: string): boolean {
  utcDay(date);
  return date >= SILO_EPOCH;
}
/** Rules version for a season starting on `date`: 5 from SILO_EPOCH, else 3 (seasons have no market). */
export function seasonRulesVersion(date: string): number { return siloActive(date) ? RULES_VERSION : BASE_RULES_VERSION; }
/** First Endless tick at or after SILO_EPOCH for a farm started at `startedAtMs` (0 for farms started after it). */
export function endlessSiloTick(startedAtMs: number): number {
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) throw new Error('bad start time');
  return Math.max(0, Math.ceil((SILO_EPOCH_MS - startedAtMs) / ENDLESS_MS_PER_TICK));
}
/** Give an Endless world its silo switch. Both the server and the client call this on every Endless world they load, since it is never stored. */
export function withEndlessSilos<W extends World>(w: W, startedAtMs: number): W {
  w.siloTick = endlessSiloTick(startedAtMs);
  return w;
}
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

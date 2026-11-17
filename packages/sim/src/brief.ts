// Daily briefs (SIM_SPEC section 6): the day's goal and twists, drawn from the brief seed. Pure; no I/O, no clock.
import { ITEM_COUNT, SEASON_TICKS, DAILY_TICKS, UNLOCKS } from './rules.ts';
import type { Goal, GoalKind, Setup } from './types.ts';
import { rand } from './weather.ts';
import { utcDay } from './date.ts';

/** Dailies dated on or after this, and seasons starting on or after it, use briefs. Live from 2026-11-18 (Rohan set the launch date). */
export const BRIEF_EPOCH = '2026-11-18';
/** Setup version stored on brief challenges (`setup_v = 2`). */
export const SETUP_BRIEF = 2;
/** Hidden sibling farms per challenge kind. */
export const HIDDEN_FARMS = { daily: 2, season: 4, duel: 0 } as const;
/** Own salt for the brief draw (the modifier draw of setup version 1 uses 0xC0DE5EED). */
export const BRIEF_SALT = 0x7B21E5D1;

export type TwistKey = 'land' | 'poor_soil' | 'dry_soil' | 'drought' | 'hard_frost' | 'bot_cap' | 'plot_cap'
  | 'research_given' | 'research_locked' | 'stock' | 'hive';
export interface Twist { key: TwistKey; value?: number; /** stock only: the item. */ item?: number }
export interface Brief { goal: Goal; twists: Twist[]; ticks: number; notice: string; labels: string[] }
export type BriefKind = 'daily' | 'season' | 'duel';

/** Catalogue order; also the order twist values are drawn in. */
export const TWIST_KEYS: readonly TwistKey[] = ['land', 'poor_soil', 'dry_soil', 'drought', 'hard_frost', 'bot_cap', 'plot_cap', 'research_given', 'research_locked', 'stock', 'hive'];
export const GOAL_KINDS: readonly GoalKind[] = ['wealth', 'festival', 'specialist', 'orders', 'inherited'];
export const GOAL_TITLES: Record<GoalKind, string> = { wealth: 'Wealth', festival: 'Harvest festival', specialist: 'Specialist prices', orders: 'Orders only', inherited: 'Inherited farm' };
/** Goal draw: out of 16, wealth 4 and the other four 3 each. */
export const GOAL_WEIGHTS: Record<GoalKind, number> = { wealth: 4, festival: 3, specialist: 3, orders: 3, inherited: 3 };
/** Dailies draw 0, 1, 1 or 2 twists; seasons always 2. */
export const DAILY_TWIST_COUNTS = [0, 1, 1, 2] as const;
export const SEASON_TWISTS = 2;
/** Specialist prices in permille of the day's price (the market table when there is one). */
export const FAVOURED_PERMILLE = 3000, SHUNNED_PERMILLE = 300;
/** Festival: units for the 1x quota per item (index = item id); a quota is this times 1, 1.5 or 2, and times 2 on a season. */
export const QUOTA_UNIT: readonly number[] = [0, 200, 240, 80, 100, 120, 144, 10];
export const SEASON_QUOTA_MULT = 2;
/** Research bits a twist may give / lock (wheat..composter + satchel; pumpkin..silo). */
export const GIVEN_BITS: readonly number[] = [1, 2, 3, 4, 6, 7, 8];
export const LOCKED_BITS: readonly number[] = [3, 4, 5, 6, 7, 8, 9];
/** Inherited farm start: carrot, wheat and clover researched, and this many coins. */
export const INHERITED_UNLOCKS = 0b111, INHERITED_COINS = 30;

/** True when a daily dated `date`, or a season starting that day, uses briefs. */
export function briefActive(date: string): boolean {
  utcDay(date);
  return date >= BRIEF_EPOCH;
}

const CLASHES: readonly (readonly [TwistKey, TwistKey])[] = [['drought', 'dry_soil'], ['drought', 'hard_frost']];
const clashes = (a: TwistKey, b: TwistKey): boolean => CLASHES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

const PLURAL: readonly string[] = ['', 'carrots', 'wheat', 'clover', 'pumpkins', 'berries', 'apples', 'honey'];
const DIRS: readonly (readonly [number, number])[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

export interface DrawnBrief {
  brief: Brief;
  /** Setup fields without prices or siloTick (the caller composes the market and the rules version). */
  setup: Setup;
  /** Specialist only: the multipliers to compose with the day's prices, in permille per item (1000 elsewhere). */
  priceMult: number[] | null;
}

/**
 * The brief of a challenge: a pure function of kind, seed and, for a duel, the kind of challenge it was copied from.
 * Draw order (xorshift32 from `seed ^ BRIEF_SALT`, each draw `(state >>> 8) % n`): goal (16), twist count (4), twist picks (11 each,
 * rejected picks still consume a draw), twist values in catalogue order, then the goal's own parameters.
 */
export function drawBrief(kind: BriefKind, seed: number, source: 'daily' | 'season' = 'daily'): DrawnBrief {
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be a safe integer');
  const season = kind === 'season' || (kind === 'duel' && source === 'season');
  const ticks = season ? SEASON_TICKS : DAILY_TICKS;
  let s = ((seed ^ BRIEF_SALT) >>> 0) || 1;
  for (let i = 0; i < 4; i++) s = rand(s);
  const draw = (n: number): number => { s = rand(s); return (s >>> 8) % n; };

  // 1. goal
  let g = draw(16), goalKind: GoalKind = 'wealth';
  for (const k of GOAL_KINDS) { if (g < GOAL_WEIGHTS[k]) { goalKind = k; break; } g -= GOAL_WEIGHTS[k]; }

  // 2. twists: how many, then which (no repeats, no clashes, `land` never on an inherited farm)
  const count = season ? SEASON_TWISTS : DAILY_TWIST_COUNTS[draw(DAILY_TWIST_COUNTS.length)]!;
  const keys: TwistKey[] = [];
  const fits = (k: TwistKey): boolean => !keys.includes(k) && !keys.some((x) => clashes(x, k)) && !(goalKind === 'inherited' && k === 'land');
  for (let tries = 0; keys.length < count && tries < 40; tries++) { const k = TWIST_KEYS[draw(TWIST_KEYS.length)]!; if (fits(k)) keys.push(k); }
  for (const k of TWIST_KEYS) if (keys.length < count && fits(k)) keys.push(k); // never reached in practice; keeps the count exact
  keys.sort((a, b) => TWIST_KEYS.indexOf(a) - TWIST_KEYS.indexOf(b));

  // 3. twist values and their setup fields
  const setup: Setup = {};
  const twists: Twist[] = [];
  let startPlots = 1 + (goalKind === 'inherited' ? 1 : 0), given = 0, locked = 0, hive = false, givenBit = -1;
  for (const key of keys) {
    switch (key) {
      case 'land': {
        const n = 1 + draw(3);
        let [dx, dy] = DIRS[draw(4)]!, x = dx, y = dy;
        const flat = [x, y];
        for (let i = 1; i < n; i++) { const turn = draw(3); const d = DIRS.findIndex(([ax, ay]) => ax === dx && ay === dy); [dx, dy] = DIRS[(d + (turn === 0 ? 0 : turn === 1 ? 1 : 3)) % 4]!; x += dx; y += dy; flat.push(x, y); }
        setup.plots = flat; startPlots += n; twists.push({ key, value: n }); break;
      }
      case 'poor_soil': { const v = 15 + 5 * draw(3); setup.poorSoil = v; twists.push({ key, value: v }); break; }
      case 'dry_soil': { const v = 20 + 10 * draw(3); setup.drySoil = v; twists.push({ key, value: v }); break; }
      case 'drought': setup.weatherBias = 2; twists.push({ key }); break;
      case 'hard_frost': setup.weatherBias = -2; twists.push({ key }); break;
      case 'bot_cap': { const v = 1 + draw(3); setup.maxBots = v; twists.push({ key, value: v }); break; }
      case 'plot_cap': { const v = Math.max(1 + draw(3), startPlots); setup.maxPlots = v; twists.push({ key, value: v }); break; }
      case 'research_given': { givenBit = GIVEN_BITS[draw(GIVEN_BITS.length)]!; given |= 1 << givenBit; twists.push({ key, value: givenBit }); break; }
      case 'research_locked': { const pool = LOCKED_BITS.filter((b) => b !== givenBit); const bit = pool[draw(pool.length)]!; locked |= 1 << bit; twists.push({ key, value: bit }); break; }
      case 'stock': { const item = 1 + draw(5), units = [20, 40, 60][draw(3)]!; const st = new Array<number>(ITEM_COUNT).fill(0); st[item] = units; setup.stock = st; twists.push({ key, value: units, item }); break; }
      case 'hive': { setup.hive = [1 + draw(7), 1 + draw(7)]; hive = true; twists.push({ key }); break; }
    }
  }
  if (given) setup.unlocks = 1 | given;
  if (locked) setup.lockedUnlocks = locked;
  const itemLocked = (c: number): boolean => c >= 1 && c <= 6 && (locked & (1 << (c - 1))) !== 0;
  const honeyOk = hive || (locked & (1 << 6)) === 0;

  // 4. the goal's own parameters
  const goal: Goal = { kind: goalKind, budget: ticks };
  let priceMult: number[] | null = null;
  if (goalKind === 'festival') {
    const pool: number[] = [];
    for (let c = 1; c <= (season ? 6 : 5); c++) if (!itemLocked(c)) pool.push(c);
    if (honeyOk && (season || hive)) pool.push(7);
    const n = Math.min(pool.length, (season ? 3 : 2) + draw(2));
    const quotas = new Array<number>(ITEM_COUNT).fill(0);
    for (let i = 0; i < n; i++) {
      const j = i + draw(pool.length - i);
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      quotas[pool[i]!] = Math.floor(QUOTA_UNIT[pool[i]!]! * (2 + draw(3)) * (season ? SEASON_QUOTA_MULT : 1) / 2);
    }
    goal.quotas = quotas;
  } else if (goalKind === 'specialist') {
    const pool: number[] = [];
    for (let c = 1; c <= (season ? 6 : 5); c++) if (!itemLocked(c)) pool.push(c);
    goal.favoured = pool[draw(pool.length)]!;
    const rest: number[] = [];
    for (let c = 1; c <= 6; c++) if (c !== goal.favoured) rest.push(c);
    goal.shunned = rest[draw(rest.length)]!;
    priceMult = new Array<number>(ITEM_COUNT).fill(1000);
    priceMult[goal.favoured] = FAVOURED_PERMILLE; priceMult[goal.shunned] = SHUNNED_PERMILLE;
  } else if (goalKind === 'orders') {
    setup.orderBoost = 1;
  } else if (goalKind === 'inherited') {
    setup.inherited = 1;
    setup.unlocks = (setup.unlocks ?? 1) | INHERITED_UNLOCKS;
    setup.coins = INHERITED_COINS;
  }
  setup.goal = goal;
  const brief: Brief = { goal, twists, ticks, notice: '', labels: [] };
  const d = describeBrief(brief, season ? 'season' : 'daily');
  brief.notice = d.notice; brief.labels = d.labels;
  return { brief, setup, priceMult };
}

const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
const list = (parts: string[]): string => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`);

/** The village notice and the short labels of a brief, shared by the game, the CLI and the site. */
export function describeBrief(b: Brief, kind: BriefKind): { notice: string; labels: string[] } {
  const when = kind === 'season' ? 'by the end of the week' : 'by sundown';
  const g = b.goal;
  let notice: string;
  switch (g.kind) {
    case 'festival': {
      const parts: string[] = [];
      for (let c = 1; c < ITEM_COUNT; c++) if ((g.quotas?.[c] ?? 0) > 0) parts.push(`${g.quotas![c]} ${PLURAL[c]!}`);
      notice = `The village fair wants ${list(parts)} ${when}.`;
      break;
    }
    case 'specialist':
      notice = `The market is mad for ${PLURAL[g.favoured ?? 1]!} today and will not pay for ${PLURAL[g.shunned ?? 1]!}.`;
      break;
    case 'orders':
      notice = `The merchants are posting big orders. Only the coins from deliveries count ${when}.`;
      break;
    case 'inherited':
      notice = `You have inherited a tired, half-planted farm. Leave it richer than you found it ${when}.`;
      break;
    default:
      notice = `The village wants every coin you can earn ${when}.`;
  }
  const labels: string[] = [];
  for (const t of b.twists) {
    const v = t.value ?? 0;
    switch (t.key) {
      case 'land': labels.push(v === 1 ? 'One extra plot to start' : `${v} extra plots to start`); break;
      case 'poor_soil': labels.push('Patches of poor soil'); break;
      case 'dry_soil': labels.push('Patches of dry soil'); break;
      case 'drought': labels.push('Drought: no rain'); break;
      case 'hard_frost': labels.push('Hard frost'); break;
      case 'bot_cap': labels.push(v === 1 ? 'One bot only' : `At most ${v} bots`); break;
      case 'plot_cap': labels.push(v === 1 ? 'One plot only' : `At most ${v} plots`); break;
      case 'research_given': labels.push(`${cap(UNLOCKS[v]!.name)} researched`); break;
      case 'research_locked': labels.push(`${cap(UNLOCKS[v]!.name)} research locked`); break;
      case 'stock': labels.push(`${v} ${PLURAL[t.item ?? 1]!} in the barn`); break;
      case 'hive': labels.push('A hive stands ready'); break;
    }
  }
  return { notice, labels };
}

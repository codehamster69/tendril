import {
  ALGO_VERSION, DAILY_CAP, ESTABLISHED_FIELD_MIN, ELO_SCALE, FULL_MULTIPLIER_PM, FULL_WEIGHT_FIELD, HALF_STEP_DIVISOR,
  MAX_RATING, MIN_FIELD, MIN_FIELD_WEIGHT_PM, MIN_RATING, PLACEMENT_EVENTS, PLACEMENT_MULTIPLIERS_PM, SEASON_CAP,
  SEASON_WEIGHT,
} from './constants.ts';
import { ELO_TABLE } from './elo-table.ts';

export interface Standing {
  id: string;
  /** Final place, 1 = best. Equal places are a tie (shared average place). Gaps after ties are fine (1,2,2,4). */
  place: number;
  /** Whole-number rating going into the contest. */
  rating: number;
  /** Rated events completed before this one. */
  events: number;
}

export interface RateInput {
  standings: readonly Standing[];
  /** 1 for a daily, 1.5 for a season. */
  weight: number;
  algoVersion: number;
}

export interface RatingChange {
  id: string;
  performance: number;
  delta: number;
  rating: number;
}

const MAX_DIFF = ELO_TABLE.length - 1;

/** Chance (out of ELO_SCALE) that a player rated `d` points above another finishes above them. */
function winChance(d: number): number {
  if (d >= 0) return d > MAX_DIFF ? ELO_SCALE : ELO_TABLE[d]!;
  return -d > MAX_DIFF ? 0 : ELO_SCALE - ELO_TABLE[-d]!;
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** Integer division truncating toward zero, exact for safe integers. */
function divTrunc(a: number, b: number): number {
  return (a - (a % b)) / b;
}

function fieldWeightPm(n: number): number {
  if (n >= FULL_WEIGHT_FIELD) return 1000;
  if (n <= MIN_FIELD) return MIN_FIELD_WEIGHT_PM;
  return MIN_FIELD_WEIGHT_PM + divTrunc((1000 - MIN_FIELD_WEIGHT_PM) * (n - MIN_FIELD), FULL_WEIGHT_FIELD - MIN_FIELD);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rates one closed contest. Pure and integer-only: same standings, any input order, any machine, same output.
 * Output is sorted by place then id. Returns [] when the field is smaller than MIN_FIELD (contest unrated).
 */
export function rateContest(input: RateInput): RatingChange[] {
  if (input.algoVersion !== ALGO_VERSION) throw new RangeError(`unsupported algoVersion ${input.algoVersion}`);
  const weightPm = Math.round(input.weight * 1000);
  if (!(weightPm > 0)) throw new RangeError('weight must be positive');
  const cap = weightPm >= SEASON_WEIGHT * 1000 ? SEASON_CAP : DAILY_CAP;

  const ps = [...input.standings].sort((a, b) => a.place - b.place || cmp(a.id, b.id));
  const seen = new Set<string>();
  for (const s of ps) {
    if (seen.has(s.id)) throw new RangeError(`duplicate id ${s.id}`);
    seen.add(s.id);
    if (!Number.isInteger(s.place) || s.place < 1) throw new RangeError(`bad place for ${s.id}`);
    if (!Number.isInteger(s.rating) || s.rating < MIN_RATING || s.rating > MAX_RATING) throw new RangeError(`bad rating for ${s.id}`);
    if (!Number.isInteger(s.events) || s.events < 0) throw new RangeError(`bad events for ${s.id}`);
  }

  const established = ps.filter((s) => s.events >= PLACEMENT_EVENTS);
  const field = established.length >= ESTABLISHED_FIELD_MIN ? established : ps;
  if (field.length < MIN_FIELD) return [];
  const inField = new Set(field.map((s) => s.id));

  // Chance that a field member beats a player rated p, summed over the field, for every p: F[p].
  // Uses counts per distinct rating value, never pairs.
  const counts = new Map<number, number>();
  for (const s of field) counts.set(s.rating, (counts.get(s.rating) ?? 0) + 1);
  const vals = [...counts.keys()].sort((a, b) => a - b);
  const cnts = vals.map((v) => counts.get(v)!);
  const F = new Array<number>(MAX_RATING + 1);
  for (let p = MIN_RATING; p <= MAX_RATING; p++) {
    let sum = 0;
    for (let k = 0; k < vals.length; k++) sum += cnts[k]! * winChance(vals[k]! - p);
    F[p] = sum;
  }

  // Field places: how many field members finish strictly better / tied at each place.
  const fieldPlaceCount = new Map<number, number>();
  for (const s of field) fieldPlaceCount.set(s.place, (fieldPlaceCount.get(s.place) ?? 0) + 1);
  const placeKeys = [...fieldPlaceCount.keys()].sort((a, b) => a - b);
  const better = new Map<number, number>();
  let run = 0;
  for (const k of placeKeys) {
    better.set(k, run);
    run += fieldPlaceCount.get(k)!;
  }
  const betterThan = (place: number): number => {
    let lo = 0, hi = placeKeys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (placeKeys[mid]! < place) lo = mid + 1; else hi = mid;
    }
    return lo < placeKeys.length ? better.get(placeKeys[lo]!)! : run;
  };

  const fieldPm = fieldWeightPm(field.length);
  const out: { s: Standing; performance: number; delta: number }[] = [];
  for (const s of ps) {
    const mine = inField.has(s.id);
    const selfTerm = (p: number): number => (mine ? winChance(s.rating - p) : 0);
    const expected = (p: number): number => ELO_SCALE + F[p]! - selfTerm(p);
    const strictlyBetter = betterThan(s.place);
    const tied = (fieldPlaceCount.get(s.place) ?? 0) - (mine ? 1 : 0);
    const actual2 = 2 + 2 * strictlyBetter + tied; // twice the average place
    const target = Number(isqrt(BigInt(expected(s.rating)) * BigInt(actual2) * BigInt(ELO_SCALE / 2)));

    // Smallest p whose expected place is at or below target, then the nearer of p and p - 1.
    let lo = MIN_RATING, hi = MAX_RATING;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (expected(mid) <= target) hi = mid; else lo = mid + 1;
    }
    let perf = lo;
    if (perf > MIN_RATING && expected(perf - 1) - target <= Math.abs(target - expected(perf))) perf -= 1;

    const mult = s.events < PLACEMENT_EVENTS ? PLACEMENT_MULTIPLIERS_PM[s.events]! : FULL_MULTIPLIER_PM;
    let delta = divTrunc((perf - s.rating) * mult * fieldPm * weightPm, HALF_STEP_DIVISOR * 1e9);
    delta = Math.max(-cap, Math.min(cap, delta));
    out.push({ s, performance: perf, delta });
  }

  // Zero-sum across established players; remainder points go one each in id order.
  const est = out.filter((o) => o.s.events >= PLACEMENT_EVENTS).sort((a, b) => cmp(a.s.id, b.s.id));
  if (est.length > 0) {
    const sum = est.reduce((t, o) => t + o.delta, 0);
    const base = divTrunc(sum, est.length);
    const rem = sum - base * est.length;
    est.forEach((o, i) => {
      o.delta -= base + (i < Math.abs(rem) ? Math.sign(rem) : 0);
    });
  }

  return out.map(({ s, performance, delta }) => {
    const rating = Math.max(MIN_RATING, Math.min(MAX_RATING, s.rating + delta));
    return { id: s.id, performance, delta: rating - s.rating, rating };
  });
}

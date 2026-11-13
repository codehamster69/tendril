/** Bump when any maths below changes; ratings are then recomputed from stored standings. */
export const ALGO_VERSION = 1;

export const START_RATING = 1200;
export const MIN_RATING = 0;
export const MAX_RATING = 4000;
export const PLACEMENT_EVENTS = 5;

/** Placement multipliers over events 1..5, in thousandths (2.0 .. 1.2). Established players: 1.0. */
export const PLACEMENT_MULTIPLIERS_PM: readonly number[] = [2000, 1800, 1600, 1400, 1200];
export const FULL_MULTIPLIER_PM = 1000;

export const MIN_FIELD = 8;
export const FULL_WEIGHT_FIELD = 30;
/** Field-size weight at MIN_FIELD players (thousandths); rises linearly to 1000 at FULL_WEIGHT_FIELD. Not set by the plan: chosen here. */
export const MIN_FIELD_WEIGHT_PM = 300;
/** Established-only field once this many established players are in the standings. */
export const ESTABLISHED_FIELD_MIN = 30;

export const DAILY_WEIGHT = 1;
export const SEASON_WEIGHT = 1.5;
export const DAILY_CAP = 150;
export const SEASON_CAP = 200;

/** Elo table scale: probabilities are whole numbers out of this. */
export const ELO_SCALE = 1_000_000;
/** The rating moves this share of the way to performance: 1 / HALF_STEP_DIVISOR. */
export const HALF_STEP_DIVISOR = 2;

export interface Tier {
  readonly key: string;
  readonly name: string;
  readonly floor: number;
}

export const TIERS: readonly Tier[] = [
  { key: 'seed', name: 'Seed', floor: MIN_RATING },
  { key: 'seedling', name: 'Seedling', floor: 1000 },
  { key: 'shoot', name: 'Shoot', floor: 1200 },
  { key: 'vine', name: 'Vine', floor: 1400 },
  { key: 'bloom', name: 'Bloom', floor: 1600 },
  { key: 'orchard', name: 'Orchard', floor: 1800 },
  { key: 'grove', name: 'Grove', floor: 2000 },
  { key: 'evergreen', name: 'Evergreen', floor: 2300 },
];

export interface TierInfo {
  key: string;
  name: string;
  floor: number;
  /** Floor of the next tier up, or null at the top. */
  next: number | null;
}

export function tierOf(rating: number): TierInfo {
  let i = 0;
  while (i + 1 < TIERS.length && rating >= TIERS[i + 1]!.floor) i++;
  const t = TIERS[i]!;
  return { key: t.key, name: t.name, floor: t.floor, next: TIERS[i + 1]?.floor ?? null };
}

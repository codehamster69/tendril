// The numbers the "How rating works" page prints. They are copied from the engine on purpose: the site does not
// depend on @tendril/rating, and packages/rating/test/docs.test.ts fails if any value here drifts from the engine
// (or from the server's eligibility constants). Change the engine first, then this file.

export const ALGO_VERSION = 1;
export const START_RATING = 1200;
export const MIN_RATING = 0;
export const MAX_RATING = 4000;
export const PLACEMENT_EVENTS = 5;
/** Over the first five events, as printed (2.0 .. 1.2). */
export const PLACEMENT_MULTIPLIERS: readonly number[] = [2.0, 1.8, 1.6, 1.4, 1.2];
export const SEASON_WEIGHT = 1.5;
export const DAILY_WEIGHT = 1;
export const MIN_FIELD = 8;
export const FULL_WEIGHT_FIELD = 30;
/** Field-size weight at the smallest field; rises evenly to 1 at FULL_WEIGHT_FIELD. */
export const MIN_FIELD_WEIGHT = 0.3;
export const ESTABLISHED_FIELD_MIN = 30;
export const DAILY_CAP = 150;
export const SEASON_CAP = 200;
/** Elo scale: 400 points of difference is 10 to 1 odds. */
export const ELO_DIVISOR = 400;
/** The rating moves 1 / HALF_STEP_DIVISOR of the way to the performance rating. */
export const HALF_STEP_DIVISOR = 2;
export const MIN_ACCOUNT_AGE_DAYS = 14;
export const ACTIVE_WINDOW_DAYS = 30;

export interface TierRow { key: string; name: string; floor: number; colour: string; share: string }
/** Lowest tier first, like the engine's TIERS. */
export const TIER_ROWS: readonly TierRow[] = [
  { key: 'seed', name: 'Seed', floor: 0, colour: 'Soil brown', share: 'Bottom tenth' },
  { key: 'seedling', name: 'Seedling', floor: 1000, colour: 'Wheat', share: 'Lower third' },
  { key: 'shoot', name: 'Shoot', floor: 1200, colour: 'Light green', share: 'Middle' },
  { key: 'vine', name: 'Vine', floor: 1400, colour: 'Leaf green', share: 'Top 35%' },
  { key: 'bloom', name: 'Bloom', floor: 1600, colour: 'Berry purple', share: 'Top 15%' },
  { key: 'orchard', name: 'Orchard', floor: 1800, colour: 'Apple red', share: 'Top 5%' },
  { key: 'grove', name: 'Grove', floor: 2000, colour: 'Gold', share: 'Top 1%' },
  { key: 'evergreen', name: 'Evergreen', floor: 2300, colour: 'Deep green with gold edge', share: 'Top handful' },
];

/** Printed band, e.g. "1200 to 1399", "2300 and up", "Below 1000". */
export function tierBand(i: number): string {
  const t = TIER_ROWS[i]!, up = TIER_ROWS[i + 1];
  if (!up) return `${t.floor} and up`;
  if (i === 0) return `Below ${up.floor}`;
  return `${t.floor} to ${up.floor - 1}`;
}

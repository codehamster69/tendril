// Read-only view of a daily/season brief for the Sprout queries goal(), quota(), budget(), twists(), bot_cap(), plot_cap().
// K1 (sim) adds the optional world fields below; until it merges they are typed here and stubbed in tests. Worlds without a
// brief (Endless, old challenges) have none of them, so every query returns its neutral value. Nothing here is hashed or logged.
import type { World } from '@tendril/sim/src/index.ts';

export interface BriefFields {
  goal?: { kind: string; budget: number; quotas?: number[] };
  botCap?: number; plotCap?: number;
  /** Twist names in brief order, e.g. ['drought', 'bot_cap']. */
  twistKeys?: string[];
  /** Units of each item deposited so far (index 1..7); used for quota(). */
  deposited?: number[];
}
const f = (w: World): BriefFields => w as World & BriefFields;

export const briefGoal = (w: World): string => f(w).goal?.kind ?? 'wealth';
export const briefBudget = (w: World): number => f(w).goal?.budget ?? 0;
export const briefTwists = (w: World): string[] => [...(f(w).twistKeys ?? [])];
export const briefBotCap = (w: World): number | null => f(w).botCap ?? null;
export const briefPlotCap = (w: World): number | null => f(w).plotCap ?? null;
/** Units of an item still to deposit for a festival quota; 0 when there is no quota. */
export const briefQuota = (w: World, item: number): number => Math.max(0, (f(w).goal?.quotas?.[item] ?? 0) - (f(w).deposited?.[item] ?? 0));

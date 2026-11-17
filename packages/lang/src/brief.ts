// Read-only view of a daily/season brief for the Sprout queries goal(), quota(), budget(), twists(), bot_cap(), plot_cap().
// Reads `World.brief` (K1, SIM_SPEC section 6). Worlds without a brief (Endless, old challenges) return neutral values.
// Nothing here is hashed or logged.
import type { BriefState, World } from '@tendril/sim/src/index.ts';

/** K1's BriefState plus `deposited`: units deposited per item (index 1..7), kept by applyAction for festival quotas (not hashed). */
type BriefView = BriefState & { deposited?: number[] };
const b = (w: World): BriefView | undefined => w.brief as BriefView | undefined;

export const briefGoal = (w: World): string => b(w)?.goal?.kind ?? 'wealth';
export const briefBudget = (w: World): number => b(w)?.goal?.budget ?? 0;
export const briefBotCap = (w: World): number | null => b(w)?.maxBots ?? null;
export const briefPlotCap = (w: World): number | null => b(w)?.maxPlots ?? null;
/** Units of an item still to deposit for a festival quota; 0 when there is no quota. */
export const briefQuota = (w: World, item: number): number => Math.max(0, (b(w)?.goal?.quotas?.[item] ?? 0) - (b(w)?.deposited?.[item] ?? 0));
/** Twists the world can show, in K1's order. Land, given research, stock and hive leave no trace on the world, so they are not listed. */
export function briefTwists(w: World): string[] {
  const s = b(w), out: string[] = [];
  if (!s) return out;
  if (s.poorSoil) out.push('poor_soil');
  if (s.drySoil) out.push('dry_soil');
  if (w.weatherBias === 2) out.push('drought');
  if (w.weatherBias === -2) out.push('hard_frost');
  if (s.maxBots !== undefined) out.push('bot_cap');
  if (s.maxPlots !== undefined) out.push('plot_cap');
  if (s.lockedUnlocks) out.push('research_locked');
  return out;
}

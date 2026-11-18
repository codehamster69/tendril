// Live progress of a brief's goal, read from the world in the sim worker (K6). Mirrors the score rules of `replayWithGoal` (SIM_SPEC 6.5).
import { festivalScore, netWorth } from '@tendril/sim/src/index.ts';
import type { World } from '@tendril/sim/src/index.ts';

export interface GoalProgress {
  /** The goal's score so far: net worth, coins from orders, net worth gained, or festival permille. */
  score: number;
  /** Festival: units deposited per item (length 8, index 1..7). */
  deposited?: number[];
}

/** Null for a world without a brief goal. `startWorth` is the net worth of the farm at tick 0 (inherited goals). */
export function goalProgress(w: World, startWorth: number): GoalProgress | null {
  const goal = w.brief?.goal;
  if (!goal) return null;
  switch (goal.kind) {
    case 'festival': { const deposited = (w.brief!.deposited ?? []).slice(); return { score: festivalScore(goal.quotas, deposited), deposited }; }
    case 'orders': return { score: w.brief!.orderCoins ?? 0 };
    case 'inherited': return { score: netWorth(w) - startWorth };
    default: return { score: netWorth(w) };
  }
}

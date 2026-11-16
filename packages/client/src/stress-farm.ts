// Deterministic load-test farm for the performance meter. Local only: it runs in its own sandbox
// keyspace, is never synced and never submitted to any board. Opened with ?stress=1 or ?stress=small.
import type { Scenario } from './sim-protocol';

export interface StressConfig {
  name: 'full' | 'small';
  plots: number;
  bots: number;
  seed: number;
  /** Ticks to run before handing the farm to the player's clock, so the meter starts on a built farm. */
  warmupTicks: number;
  scenario: Scenario;
  source: string;
}

const SIZES = { full: { plots: 100, bots: 32, width: 10, warmupTicks: 3000 }, small: { plots: 16, bots: 8, width: 4, warmupTicks: 800 } } as const;
/** Enough coins to buy every plot and bot at the quadratic prices, with change. */
const COINS = 100_000_000;

export function stressParam(query: URLSearchParams): StressConfig['name'] | null {
  const v = query.get('stress');
  return v === '1' || v === 'full' ? 'full' : v === 'small' ? 'small' : null;
}

export function stressConfig(name: StressConfig['name']): StressConfig {
  const { plots, bots, width, warmupTicks } = SIZES[name];
  // Bot 0 buys the crew and the plots row by row; every bot then runs the same plant and harvest loop on its own columns.
  const source = `# Tendril stress farm: ${plots} plots, ${bots} bots. Fixed program, fixed seed.
repeat forever:
    if my_id() == 0:
        while bots() < ${bots} and coins() >= bot_cost():
            buy_bot
        while len(plots()) < ${plots} and coins() >= plot_cost():
            n = len(plots())
            buy_plot n % ${width}, (n - n % ${width}) / ${width}
    for each tile in tiles():
        if tile.x % bots() == my_id():
            go_to tile
            if scan().ripe:
                harvest
            if scan().empty:
                till
                plant carrot
    go_to barn
    deposit
    sell carrot, all
    wait 5
`;
  return { name, plots, bots, seed: 20261116, warmupTicks, scenario: { kind: 'sandbox', setup: { coins: COINS } }, source };
}

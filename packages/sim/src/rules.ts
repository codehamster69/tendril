// Constants and cost formulas (SIM_SPEC.md). Integers only.
export const RULES_VERSION = 2;
export const PLOT_SIZE = 8;
export const CAPACITY = 20;
export const TILE_INTS = 8;

export interface Crop {
  name: string; stageLen: number; thirst: number; hunger: number; drink: number;
  nDelta: number; fatigue: number; yield: number; price: number; hardy: boolean;
}

/** Indexable by crop id 1..4. Index 0 is an unused placeholder. */
export const CROPS: readonly Crop[] = [
  { name: 'none', stageLen: 1, thirst: 0, hunger: 0, drink: 0, nDelta: 0, fatigue: 0, yield: 0, price: 0, hardy: true },
  { name: 'carrot', stageLen: 60, thirst: 20, hunger: 10, drink: 10, nDelta: -8, fatigue: 6, yield: 4, price: 2, hardy: false },
  { name: 'wheat', stageLen: 90, thirst: 15, hunger: 20, drink: 6, nDelta: -12, fatigue: 8, yield: 8, price: 3, hardy: true },
  { name: 'clover', stageLen: 50, thirst: 25, hunger: 0, drink: 10, nDelta: 20, fatigue: -10, yield: 1, price: 1, hardy: true },
  { name: 'pumpkin', stageLen: 150, thirst: 40, hunger: 30, drink: 25, nDelta: -20, fatigue: 15, yield: 20, price: 6, hardy: false },
];

export const OPS = ['move', 'till', 'plant', 'water', 'harvest', 'deposit', 'deliver', 'wait', 'sell', 'buyPlot', 'buyBot'] as const;
/** Ticks per op index. `wait` (7) uses its argument instead. */
export const COST: readonly number[] = [2, 3, 2, 2, 3, 1, 2, 0, 1, 0, 0];

export const OP = {
  move: 0, till: 1, plant: 2, water: 3, harvest: 4, deposit: 5, deliver: 6,
  wait: 7, sell: 8, buyPlot: 9, buyBot: 10,
} as const;

export const plotPrice = (plotsOwned: number): number => 150 * plotsOwned * plotsOwned;
export const botPrice = (botsOwned: number): number => 80 * botsOwned * botsOwned;

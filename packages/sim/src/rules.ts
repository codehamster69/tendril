// Constants and cost formulas (SIM_SPEC.md, rules version 3). Integers only.
/** Newest rules. Version 4 = version 3 plus the optional daily market table (`Setup.prices`); a world without prices plays exactly as version 3. */
export const RULES_VERSION = 4;
/** Rules of everything that has no market: endless farms, seasons, duels not copied from a market daily, dailies before MARKET_EPOCH. */
export const BASE_RULES_VERSION = 3;
export const SUPPORTED_RULES_VERSIONS: readonly number[] = [3, 4];
export const PLOT_SIZE = 8;
export const TILE_INTS = 10;
export const ITEM_COUNT = 8;
export const BASE_CAPACITY = 20;
export const SATCHEL_CAPACITY = 30;
export const DAILY_TICKS = 3000;
/** A weekly season is twice as long as a daily: room for a real strategy, still about 10 s to run to the end. */
export const SEASON_TICKS = 6000;
export const HONEY_INTERVAL = 400;
export const HONEY_MAX = 6;

export interface Crop {
  name: string; stageLen: number; thirst: number; hunger: number; drink: number;
  nDelta: number; fatigue: number; yield: number; price: number; hardy: boolean; perennial: boolean;
}

/** Indexable by crop id 1..6. Index 0 is an unused placeholder. */
export const CROPS: readonly Crop[] = [
  { name: 'none', stageLen: 1, thirst: 0, hunger: 0, drink: 0, nDelta: 0, fatigue: 0, yield: 0, price: 0, hardy: true, perennial: false },
  { name: 'carrot', stageLen: 60, thirst: 20, hunger: 10, drink: 10, nDelta: -8, fatigue: 6, yield: 4, price: 2, hardy: false, perennial: false },
  { name: 'wheat', stageLen: 90, thirst: 15, hunger: 20, drink: 6, nDelta: -12, fatigue: 8, yield: 8, price: 3, hardy: true, perennial: false },
  { name: 'clover', stageLen: 50, thirst: 25, hunger: 0, drink: 10, nDelta: 20, fatigue: -10, yield: 1, price: 1, hardy: true, perennial: false },
  { name: 'pumpkin', stageLen: 150, thirst: 40, hunger: 30, drink: 25, nDelta: -20, fatigue: 15, yield: 20, price: 6, hardy: false, perennial: false },
  { name: 'berry', stageLen: 80, thirst: 20, hunger: 15, drink: 8, nDelta: -6, fatigue: 4, yield: 6, price: 4, hardy: true, perennial: true },
  { name: 'apple', stageLen: 200, thirst: 30, hunger: 25, drink: 15, nDelta: -10, fatigue: 6, yield: 24, price: 5, hardy: true, perennial: true },
];
export const CROP_COUNT = 6;

/** Indexable by item id 1..8. Index 0 is an unused placeholder. */
export const ITEMS: readonly { name: string; price: number }[] = [
  { name: 'none', price: 0 },
  ...CROPS.slice(1).map((c) => ({ name: c.name, price: c.price })),
  { name: 'honey', price: 8 },
  { name: 'compost', price: 0 },
];
export const HONEY = 7, COMPOST = 8;

/** Indexable by building kind 1..2. */
export const BUILDINGS: readonly { name: string; price: number; unlock: number }[] = [
  { name: 'none', price: 0, unlock: 0 },
  { name: 'hive', price: 120, unlock: 6 },
  { name: 'composter', price: 80, unlock: 7 },
];
export const HIVE = 1, COMPOSTER = 2;

/** Research bits 0..8. */
export const UNLOCKS: readonly { name: string; price: number }[] = [
  { name: 'carrot', price: 0 },
  { name: 'wheat', price: 40 },
  { name: 'clover', price: 60 },
  { name: 'pumpkin', price: 250 },
  { name: 'berry', price: 400 },
  { name: 'apple', price: 900 },
  { name: 'hive', price: 300 },
  { name: 'composter', price: 200 },
  { name: 'satchel', price: 500 },
];
export const SATCHEL_BIT = 8;

export const OPS = [
  'move', 'till', 'plant', 'water', 'harvest', 'deposit', 'deliver', 'wait', 'sell', 'buyPlot', 'buyBot',
  'build', 'clear', 'compost', 'fertilize', 'unlock',
] as const;
/** Ticks per op index. `wait` (7) uses its argument instead. */
export const COST: readonly number[] = [2, 3, 2, 2, 3, 1, 2, 0, 1, 0, 0, 4, 3, 2, 2, 0];

export const OP = {
  move: 0, till: 1, plant: 2, water: 3, harvest: 4, deposit: 5, deliver: 6,
  wait: 7, sell: 8, buyPlot: 9, buyBot: 10, build: 11, clear: 12, compost: 13, fertilize: 14, unlock: 15,
} as const;

/** Ops performed by the farm itself (bot -1, zero ticks). */
export const FARM_OPS: readonly number[] = [OP.buyPlot, OP.buyBot, OP.unlock];

export const plotPrice = (plotsOwned: number): number => 150 * plotsOwned * plotsOwned;
export const botPrice = (botsOwned: number): number => 80 * botsOwned * botsOwned;

export class IllegalAction extends Error {
  constructor(message: string) { super(message); this.name = 'IllegalAction'; }
}
export interface Farm { id: string; seed: number }
/** Local campaign fixtures only; the server never passes it. */
/** `weatherBias`: -1 more frost, 0 standard, 1 less frost (more rain by share). Challenge modifiers only; omitted means 0. */
export interface Setup {
  coins?: number; unlocks?: number; weatherBias?: number;
  /** Rules v4 daily market: centicoin price per item (length 8, index 1..7; 0 and the rest unused). Absent: base prices. */
  prices?: number[];
  /** Rules v5: silos and sellPlot work from this tick on. Challenges on rules v5 pass 0; Endless passes endlessSiloTick(start). */
  siloTick?: number;
  /**
   * Daily briefs (SIM_SPEC section 6). Every field is optional and absent changes nothing. `weatherBias` also takes 2 (drought:
   * rain segments have length 0) and -2 (hard frost) here, which `createWorld` accepts.
   */
  /** Extra starting plots, flat `[px, py, ...]`, each next to an owned plot, added after the barn plot. */
  plots?: number[];
  /** Nitrogen taken off the tiles of 4x4 patches chosen from the world seed (1..50). */
  poorSoil?: number;
  /** Starting moisture taken off the tiles of 4x4 patches chosen from the world seed (1..50). */
  drySoil?: number;
  /** `buyBot` / `buyPlot` return 0 once this many bots / plots are owned. */
  maxBots?: number; maxPlots?: number;
  /** Research bits that `unlock` refuses (result 0). */
  lockedUnlocks?: number;
  /** Starting stock per item (length 8, index 1..7). */
  stock?: number[];
  /** A hive already standing on tile `[x, y]` of the barn plot. */
  hive?: [number, number];
  /** 1: a half-planted, tired farm generated from the world seed (SIM_SPEC 6.4). */
  inherited?: number;
  /** 1: orders come about twice as often and pay half as much again. */
  orderBoost?: number;
  /** The challenge goal; kept on the world for Sprout to read, never changes a rule by itself. */
  goal?: Goal;
}
export type GoalKind = 'wealth' | 'festival' | 'specialist' | 'orders' | 'inherited';
export interface Goal {
  kind: GoalKind;
  /** Tick budget of the challenge. */
  budget: number;
  /** festival: units per item (length 8, index 1..7) to deposit in the barn or silos. */
  quotas?: number[];
  /** specialist: item ids whose price is raised / cut. */
  favoured?: number; shunned?: number;
}
/** What a brief keeps on the world after creation (not hashed; only its effects are). Absent on every other world. */
export interface BriefState {
  goal?: Goal; maxBots?: number; maxPlots?: number; lockedUnlocks?: number; orderBoost?: number; poorSoil?: number; drySoil?: number;
}
export type LogEntry = [t: number, bot: number, op: number, a?: number, b?: number];
export type WeatherKind = 'rain' | 'frost';
export interface Segment { kind: WeatherKind; start: number; end: number }
export interface Order { id: number; crop: number; qty: number; reward: number; opensAt: number; deadline: number }
export interface Plot { px: number; py: number; tiles: Int32Array }
export interface Bot { x: number; y: number; busyUntil: number; load: Int32Array }
export interface World {
  id: string; seed: number; tick: number; coins: number; spent: number; unlocks: number;
  wrng: number; orng: number; nextOrderAt: number; nextOrderId: number;
  stock: number[]; weather: Segment[]; orders: Order[]; bots: Bot[];
  plots: Plot[]; plotIndex: Map<string, number>; lastOp: (number | null)[];
  /** Set only by a challenge setup (-1 or 1); absent means the standard schedule. */
  weatherBias?: number;
  /** Rules v4 market table in centicoins (length 8, index 1..7). Absent: base prices, exactly rules v3. */
  prices?: number[];
  /**
   * Rules v5: silo rules apply from this tick. Absent: none, exactly rules v3/v4. Not part of the state hash (its effects are: tiles,
   * coins, spent), so an Endless farm can carry it without changing the hash any older client computes.
   */
  siloTick?: number;
  /** Daily briefs: goal and limits. Absent: none of SIM_SPEC section 6 applies. */
  brief?: BriefState;
}
export interface ScanResult {
  tilled: number; crop: number; stage: number; moisture: number; nitrogen: number; fatigue: number; barn: boolean;
  building: number; honey: number;
}
export interface SnapshotTile {
  x: number; y: number; tilled: number; crop: number; stage: number; moisture: number; nitrogen: number;
  fatigue: number; building: number; honey: number;
}
export interface SnapshotBot { x: number; y: number; busyUntil: number; load: number; items: number[]; op: number | null }
export interface Snapshot {
  tick: number; coins: number; netWorth: number; weather: 'clear' | 'rain' | 'frost';
  unlocks: number; capacity: number;
  plots: { px: number; py: number }[];
  tiles: SnapshotTile[];
  bots: SnapshotBot[];
  stock: number[]; orders: Order[]; plotCost: number; botCost: number;
  /** Rules v5 worlds only: price of the next silo, and what sellPlot pays now. */
  siloCost?: number; plotRefund?: number;
}

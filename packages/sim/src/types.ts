export class IllegalAction extends Error {
  constructor(message: string) { super(message); this.name = 'IllegalAction'; }
}
export interface Farm { id: string; seed: number }
/** Local campaign fixtures only; the server never passes it. */
/** `weatherBias`: -1 more frost, 0 standard, 1 less frost (more rain by share). Challenge modifiers only; omitted means 0. */
export interface Setup { coins?: number; unlocks?: number; weatherBias?: number }
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
}

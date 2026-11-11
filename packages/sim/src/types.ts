export class IllegalAction extends Error {
  constructor(message: string) { super(message); this.name = 'IllegalAction'; }
}
export interface Farm { id: string; seed: number }
export type LogEntry = [t: number, bot: number, op: number, a?: number, b?: number];
export type WeatherKind = 'rain' | 'frost';
export interface Segment { kind: WeatherKind; start: number; end: number }
export interface Order { id: number; crop: number; qty: number; reward: number; opensAt: number; deadline: number }
export interface Plot { px: number; py: number; tiles: Int32Array }
export interface Bot { x: number; y: number; busyUntil: number; load: Int32Array }
export interface World {
  id: string; seed: number; tick: number; coins: number; spent: number;
  wrng: number; orng: number; nextOrderAt: number; nextOrderId: number;
  stock: number[]; weather: Segment[]; orders: Order[]; bots: Bot[];
  plots: Plot[]; plotIndex: Map<string, number>; lastOp: (number | null)[];
}
export interface ScanResult {
  tilled: number; crop: number; stage: number; moisture: number; nitrogen: number; fatigue: number; barn: boolean;
}
export interface Snapshot {
  tick: number; coins: number; netWorth: number; weather: 'clear' | 'rain' | 'frost';
  plots: { px: number; py: number }[];
  tiles: { x: number; y: number; tilled: number; crop: number; stage: number; moisture: number; nitrogen: number; fatigue: number }[];
  bots: { x: number; y: number; busyUntil: number; load: number; op: number | null }[];
  stock: number[]; orders: Order[]; plotCost: number; botCost: number;
}

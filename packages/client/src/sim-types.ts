export interface Order { id: number; crop: number; qty: number; reward: number; opensAt: number; deadline: number }
export interface Snapshot {
  tick: number; coins: number; netWorth: number; weather: 'clear'|'rain'|'frost';
  plots: { px: number; py: number }[];   // each plot is 8x8 tiles; plot (px,py) covers x in [8px, 8px+7], y in [8py, 8py+7]
  tiles: { x: number; y: number; tilled: number; crop: number; stage: number; moisture: number; nitrogen: number; fatigue: number }[];
  bots: { x: number; y: number; busyUntil: number; load: number; op: number | null }[];
  stock: number[]; orders: Order[]; plotCost: number; botCost: number;
}
export interface SimSource {
  load(source: string): Promise<void>;        // (re)start with this Lua source
  step(ticks: number): void;                  // advance the simulation
  snapshot(): Snapshot;
  drainOutput(): string[];                    // new console lines since last call
  drainErrors(): { bot: number; message: string }[];
  reset(): Promise<void>;
}

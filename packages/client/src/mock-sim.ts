import type { SimSource, Snapshot } from './sim-types';

interface MTile { tilled: number; crop: number; stage: number; plantedAt: number }

/** Deterministic fake simulation: ignores Lua, two bots snake over two plots. */
export class MockSim implements SimSource {
  private tick = 0;
  private coins = 0;
  private tiles = new Map<number, MTile>();
  private out: string[] = [];
  private readonly plots = [{ px: 0, py: 0 }, { px: 1, py: 0 }];

  async load(_source: string): Promise<void> { await this.reset(); }
  async reset(): Promise<void> {
    this.tick = 0; this.coins = 0; this.tiles.clear(); this.out = [];
  }

  private key(x: number, y: number) { return y * 4096 + x; }

  private weather(): Snapshot['weather'] {
    return this.tick % 500 < 400 ? 'clear' : 'rain';
  }

  /** Snake path position of bot i at the given tick (bot i walks plot i). */
  private botPos(i: number, tick: number): { x: number; y: number } {
    const step = tick % 64;
    const row = Math.floor(step / 8);
    const col = step % 8;
    return { x: i * 8 + (row % 2 === 0 ? col : 7 - col), y: row };
  }

  step(ticks: number): void {
    for (let n = 0; n < ticks; n++) {
      this.tick++;
      for (let i = 0; i < 2; i++) {
        const { x, y } = this.botPos(i, this.tick);
        const k = this.key(x, y);
        const t = this.tiles.get(k);
        if (!t) {
          this.tiles.set(k, { tilled: 1, crop: 1 + ((x + y) % 4), stage: 0, plantedAt: this.tick });
        } else if (t.crop !== 0 && t.stage >= 3) {
          t.crop = 0; t.stage = 0; this.coins += 5;
        } else if (t.crop === 0) {
          t.crop = 1 + ((x + y) % 4); t.stage = 0; t.plantedAt = this.tick;
        }
      }
      for (const t of this.tiles.values()) {
        if (t.crop !== 0 && t.stage < 3 && (this.tick - t.plantedAt) % 40 === 0 && this.tick > t.plantedAt) t.stage++;
      }
      if (this.tick % 200 === 0) this.out.push(`[tick ${this.tick}] coins=${this.coins}`);
    }
  }

  snapshot(): Snapshot {
    const w = this.weather();
    const tiles: Snapshot['tiles'] = [];
    for (const p of this.plots) {
      for (let dy = 0; dy < 8; dy++) {
        for (let dx = 0; dx < 8; dx++) {
          const x = p.px * 8 + dx, y = p.py * 8 + dy;
          const t = this.tiles.get(this.key(x, y));
          tiles.push({
            x, y, tilled: t ? 1 : 0, crop: t?.crop ?? 0, stage: t?.stage ?? 0,
            moisture: w === 'rain' ? 0.8 : t ? 0.4 : 0.2, nitrogen: 0.5, fatigue: 0,
          });
        }
      }
    }
    const bots = [0, 1].map((i) => ({ ...this.botPos(i, this.tick), busyUntil: 0, load: 0, op: null }));
    return {
      tick: this.tick, coins: this.coins, netWorth: this.coins + this.tiles.size, weather: w,
      plots: this.plots.map((p) => ({ ...p })), tiles, bots,
      stock: [0, 0, 0, 0, 0], orders: [], plotCost: 100, botCost: 200,
    };
  }

  drainOutput(): string[] { const o = this.out; this.out = []; return o; }
  drainErrors(): { bot: number; message: string }[] { return []; }
}

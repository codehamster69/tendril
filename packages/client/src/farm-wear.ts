/**
 * Worn paths (client only, never part of the sim or a replay): every time a bot steps onto an untilled tile it adds a
 * little wear. The world draws thin grass at 2 steps and bare dirt from 6. Wear is a view of what happened on this
 * screen, so it starts again from nothing when the clock is scrubbed.
 */
export const WEAR_THIN = 2;
export const WEAR_DIRT = 6;
const MAX_TILES = 20000;

export class Wear {
  private counts = new Map<number, number>();
  private last: ({ x: number; y: number } | null)[] = [];
  private key = (x: number, y: number): number => (x + 1048576) * 2097152 + (y + 1048576);

  /** Steps a bot took since the last call. Returns true when some tile crossed the thin or dirt line (the view must redraw). */
  stepBots(bots: readonly { x: number; y: number }[], live: boolean): boolean {
    let changed = false;
    bots.forEach((b, i) => {
      const prev = this.last[i];
      if (live && prev && (prev.x !== b.x || prev.y !== b.y) && Math.abs(prev.x - b.x) + Math.abs(prev.y - b.y) <= 2) {
        const k = this.key(b.x, b.y), n = (this.counts.get(k) ?? 0) + 1;
        if (n >= WEAR_THIN || this.counts.size < MAX_TILES) {
          this.counts.set(k, n);
          if (n === WEAR_THIN || n === WEAR_DIRT) changed = true;
        }
      }
      this.last[i] = { x: b.x, y: b.y };
    });
    this.last.length = bots.length;
    return changed;
  }

  count(x: number, y: number): number { return this.counts.get(this.key(x, y)) ?? 0; }
  /** 0 grass, 1 thin, 2 dirt. */
  level(x: number, y: number): 0 | 1 | 2 { const n = this.count(x, y); return n >= WEAR_DIRT ? 2 : n >= WEAR_THIN ? 1 : 0; }
  get size(): number { return this.counts.size; }
  reset(): void { this.counts.clear(); this.last = []; }
}

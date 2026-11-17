import type { Snapshot } from './sim-types';

/** The tooltip counts drops over this many ticks. */
export const DROP_WINDOW = 500;

/**
 * Drops a silo has taken, counted from the sales the client sees. The sim does not report per-tile drops, so this tally
 * lives in the view: it starts at zero on each page load and only counts sales seen while the farm was on screen.
 */
export class SiloDrops {
  private byTile = new Map<string, number[]>();

  record(x: number, y: number, tick: number): void {
    const key = `${x},${y}`;
    const list = (this.byTile.get(key) ?? []).filter((t) => t > tick - DROP_WINDOW);
    list.push(tick);
    this.byTile.set(key, list);
  }

  count(x: number, y: number, tick: number): number {
    return (this.byTile.get(`${x},${y}`) ?? []).filter((t) => t > tick - DROP_WINDOW).length;
  }

  clear(): void { this.byTile.clear(); }
}

/**
 * Where a sale just happened: the barn if a bot stands within one tile of it (as before), else the silo a bot stands on.
 * Bots deposit and sell at a silo only from its own tile.
 */
export function saleSite(s: Snapshot): { x: number; y: number; silo: boolean } | null {
  if (s.bots.some((b) => Math.abs(b.x) <= 1 && Math.abs(b.y) <= 1)) return { x: 0, y: 0, silo: false };
  for (const t of s.tiles) {
    if (t.building === 3 && s.bots.some((b) => b.x === t.x && b.y === t.y)) return { x: t.x, y: t.y, silo: true };
  }
  return null;
}

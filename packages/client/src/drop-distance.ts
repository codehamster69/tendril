/** Walking distance from each owned tile to its nearest drop (the barn or a silo). Pure, so node tests can run it. */
export interface DropDistances { byTile: Map<string, number>; max: number }
export interface DropCell { x: number; y: number; building: number }

/** Multi-source breadth-first search over owned tiles, four-way steps. Barn at (0,0) is always a drop. */
export function dropDistances(cells: Iterable<DropCell>): DropDistances {
  const owned = new Map<string, DropCell>();
  for (const c of cells) owned.set(`${c.x},${c.y}`, c);
  const byTile = new Map<string, number>();
  const queue: [number, number][] = [];
  const seed = (x: number, y: number): void => {
    const k = `${x},${y}`;
    if (owned.has(k) && !byTile.has(k)) { byTile.set(k, 0); queue.push([x, y]); }
  };
  seed(0, 0);
  for (const c of owned.values()) if (c.building === 3) seed(c.x, c.y);
  let max = 0;
  for (let head = 0; head < queue.length; head++) {
    const [x, y] = queue[head]!;
    const d = byTile.get(`${x},${y}`)!;
    max = Math.max(max, d);
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      const k = `${nx},${ny}`;
      if (!owned.has(k) || byTile.has(k)) continue;
      byTile.set(k, d + 1);
      queue.push([nx, ny]);
    }
  }
  return { byTile, max: Math.max(1, max) };
}

/** 0 at a drop, 1 at the farthest reachable tile. Tiles no drop can reach count as farthest. */
export function dropUnit(dist: DropDistances | null, x: number, y: number): number {
  if (!dist) return 0;
  const d = dist.byTile.get(`${x},${y}`);
  return d === undefined ? 1 : Math.min(1, d / dist.max);
}

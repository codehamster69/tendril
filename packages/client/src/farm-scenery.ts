import type { Snapshot } from './sim-types';

export type Placement = { x: number; z: number; rotation?: number; scale?: number; depth?: number };
export type Bounds = { x0: number; x1: number; z0: number; z1: number };

export function tileBounds(tiles: Snapshot['tiles']): Bounds | null {
  if (!tiles.length) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const tile of tiles) { x0 = Math.min(x0, tile.x - 0.5); x1 = Math.max(x1, tile.x + 0.5); z0 = Math.min(z0, tile.y - 0.5); z1 = Math.max(z1, tile.y + 0.5); }
  return { x0, x1, z0, z1 };
}

/** Terrace walls around the owned land, plus sparse trees and rocks wholly outside its bounding rectangle. */
export function sceneryPlacements(tiles: Snapshot['tiles'], { x0, x1, z0, z1 }: Bounds, owned: (x: number, y: number) => boolean): Map<string, Placement[]> {
  const walls: Placement[] = [];
  for (const tile of tiles) {
    for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      if (!owned(tile.x + dx, tile.y + dz)) {
        // AT's riser is a full 1x1 tile, so narrow its depth and place it
        // wholly outside the playable edge, below the unchanged ground plane.
        walls.push({ x: tile.x + dx * 0.54, z: tile.y + dz * 0.54, rotation: dx ? Math.PI / 2 : 0, depth: 0.08 });
      }
    }
  }
  const trees: Placement[] = [], rocks: Placement[] = [];
  for (const fraction of [0.18, 0.76]) {
    trees.push({ x: x0 - 3, z: z0 + (z1 - z0) * fraction, scale: 0.9 }, { x: x1 + 3.2, z: z0 + (z1 - z0) * fraction, scale: 1.1 },
      { x: x0 + (x1 - x0) * fraction, z: z0 - 3, scale: 0.8 });
    rocks.push({ x: x0 - 2, z: z1 + fraction, rotation: fraction * 4 }, { x: x1 + 2, z: z1 - fraction, scale: 0.8 });
  }
  return new Map([['tile_terrace_wall', walls], ['prop_tree', trees], ['prop_rocks', rocks]]);
}

import { IllegalAction } from './types.ts';
import type { LogEntry, World } from './types.ts';
import { applyAction, tickWorld } from './world.ts';

/** Mutates `world`. Throws IllegalAction on any bad entry (caller must discard the world). */
export function replayChunk(world: World, actions: LogEntry[], toTick: number): void {
  if (!Number.isSafeInteger(toTick) || toTick < world.tick) throw new IllegalAction(`bad toTick ${toTick}`);
  for (const e of actions) {
    const t = Array.isArray(e) ? e[0] : undefined;
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < world.tick || t >= toTick) {
      throw new IllegalAction(`bad action tick ${String(t)}`);
    }
    while (world.tick < t) tickWorld(world);
    applyAction(world, e);
  }
  while (world.tick < toTick) tickWorld(world);
}

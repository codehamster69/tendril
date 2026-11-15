import { deserialize, hashWorld, replayChunk } from '@tendril/sim/src/index.ts';
import type { FarmResponse } from './api-client';
import type { Accepted, LogChunk } from './chunks';
import type { Meta } from './clock';

/** Metadata/accepted farm identity is checked by RealSim before this expensive replay. */
export interface RestoreValidation {
  world: string;
  meta: Meta;
  hash?: unknown;
  accepted: Accepted | null;
  logs: LogChunk[];
  authoritative?: FarmResponse;
}

/** Replays copies only; no invalid history is published to the simulation worker. */
export async function validateRestore(
  input: RestoreValidation,
  progress: (done: number, total: number) => void = () => {},
  yieldTask: () => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  const restored = deserialize(input.world);
  if (restored.seed !== input.meta.seed || (input.authoritative && restored.id !== input.authoritative.id)) throw new Error('Saved world does not match farm metadata.');
  const restoredHash = hashWorld(restored);
  if (input.hash && restoredHash !== input.hash) throw new Error('Saved checkpoint hash mismatch.');
  if (!input.accepted) return;
  const replay = deserialize(input.accepted.farm.checkpoint);
  const start = replay.tick;
  const total = Math.max(0, restored.tick - start);
  progress(0, total);
  for (const chunk of input.logs) {
    if (chunk.fromTick !== replay.tick || chunk.fromHash !== hashWorld(replay)) throw new Error('Saved pending log chain is inconsistent. Logs retained.');
    if (!Number.isSafeInteger(chunk.toTick) || chunk.toTick < replay.tick) {
      replayChunk(replay, chunk.actions, chunk.toTick); // Preserve replay validation/error semantics.
    }
    let index = 0;
    do {
      const end = Math.min(chunk.toTick, replay.tick + 20_000);
      const first = index;
      while (index < chunk.actions.length && chunk.actions[index]![0] < end) index++;
      // At the original boundary include any invalid trailing action, so slicing
      // cannot silently drop an entry the original replay would reject.
      const actions = end === chunk.toTick ? chunk.actions.slice(first) : chunk.actions.slice(first, index);
      replayChunk(replay, actions, end);
      progress(Math.max(0, replay.tick - start), total);
      await yieldTask();
    } while (replay.tick < chunk.toTick);
    if (chunk.hash !== hashWorld(replay)) throw new Error('Saved pending log hash mismatch. Logs retained.');
  }
  if (hashWorld(replay) !== restoredHash) throw new Error('Saved pending logs do not reach the durable checkpoint.');
}

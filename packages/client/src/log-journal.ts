import type { LogChunk } from './chunks';

export interface JournalIndex { version: 1; revision: number; ends: number[] }
export const journalKey = (prefix: string, end: number): string => `${prefix}log.${end}`;
export function validateJournal(value: unknown): JournalIndex {
  const index = value as JournalIndex;
  if (!index || index.version !== 1 || !Number.isSafeInteger(index.revision) || index.revision < 1 || !Array.isArray(index.ends)
    || index.ends.some((n, i) => !Number.isSafeInteger(n) || n < 0 || (i > 0 && n <= index.ends[i - 1]!))) throw new Error('Saved log journal is invalid. Logs retained.');
  return index;
}
/** Produce only changed chunk writes. References are retained by RealSim until
 * replacement, so unchanged history never needs cloning or serializing again. */
export function journalDelta(prefix: string, previous: LogChunk[], logs: LogChunk[]): { entries: Record<string, unknown>; remove: string[]; ends: number[] } {
  const old = new Map(previous.map(c => [c.toTick, c]));
  const entries: Record<string, unknown> = {};
  let end = -1;
  for (const chunk of logs) {
    if (!Number.isSafeInteger(chunk.toTick) || chunk.toTick <= end) throw new Error('Log journal chunks must advance in order.');
    end = chunk.toTick;
    if (old.get(chunk.toTick) !== chunk) entries[journalKey(prefix, chunk.toTick)] = chunk;
    old.delete(chunk.toTick);
  }
  return { entries, remove: [...old.keys()].map(n => journalKey(prefix, n)), ends: logs.map(c => c.toTick) };
}

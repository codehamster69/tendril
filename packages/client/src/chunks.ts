// Pure log-chunk planning for server submission; no worker, no storage.
import { deserialize, hashWorld, netWorth, replayChunk, RULES_VERSION, serialize } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import type { FarmResponse } from './api-client';

export interface LogChunk {
  fromTick: number; toTick: number; actions: LogEntry[];
  fromHash?: string; hash?: string; // Optional on imported legacy logs.
}
export interface Accepted { farm: FarmResponse; receivedAtMs: number | null }
export interface Submission {
  request: { fromTick: number; toTick: number; actions: LogEntry[]; rulesVersion: number; checkpointHash: string };
  checkpoint: string; hash: string; netWorth: number;
}
const MAX_ACTIONS = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;

/** Build one advancing prefix, preserving complete same-tick action groups. */
export function planSubmission(farm: FarmResponse, logs: LogChunk[], endTick: number): Submission | null {
  validateFarm(farm);
  if (endTick <= farm.tick) return null;
  let toTick = Math.min(endTick, farm.tick + 20_000);
  const actions: LogEntry[] = [];
  const request = { fromTick: farm.tick, toTick, actions, rulesVersion: farm.rulesVersion, checkpointHash: farm.checkpointHash };
  let bytes = new TextEncoder().encode(JSON.stringify(request)).length;
  let group: LogEntry[] = [];
  let groupTick = -1;
  let stopped = false;
  const appendGroup = (): void => {
    if (!group.length || stopped) return;
    const added = group.reduce((n, e) => n + new TextEncoder().encode(JSON.stringify(e)).length + 1, 0);
    if (actions.length + group.length > MAX_ACTIONS || bytes + added > MAX_BYTES) {
      if (groupTick <= farm.tick) throw new Error('A same-tick action group exceeds verifier limits. Logs retained; this group cannot be split.');
      toTick = groupTick;
      stopped = true;
    } else { actions.push(...group); bytes += added; }
    group = [];
  };
  outer: for (const chunk of logs) {
    for (const entry of chunk.actions) {
      if (entry[0] < farm.tick) throw new Error('Pending log precedes the accepted checkpoint. Recovery is required.');
      if (entry[0] >= toTick) break outer;
      if (entry[0] !== groupTick) { appendGroup(); if (stopped) break outer; groupTick = entry[0]; }
      group.push(entry);
    }
  }
  appendGroup();
  request.toTick = toTick;
  if (new TextEncoder().encode(JSON.stringify(request)).length > MAX_BYTES) throw new Error('Verifier request exceeds 2 MiB. Logs retained.');
  const world = deserialize(farm.checkpoint);
  replayChunk(world, actions, toTick);
  return { request, checkpoint: serialize(world), hash: hashWorld(world), netWorth: netWorth(world) };
}

export function validateFarm(farm: FarmResponse): void {
  if (farm.rulesVersion !== RULES_VERSION || !Number.isSafeInteger(farm.startedAtMs) || farm.startedAtMs < 0 || !Number.isSafeInteger(farm.seed)) throw new Error('Server farm rules or clock are incompatible. Nothing was replaced.');
  const world = deserialize(farm.checkpoint);
  if (world.id !== farm.id || world.seed !== farm.seed || world.tick !== farm.tick || hashWorld(world) !== farm.checkpointHash || netWorth(world) !== farm.netWorth || world.coins !== farm.coins) throw new Error('Server checkpoint does not match its identity, tick, hash or score.');
}


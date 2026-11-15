import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, serialize, hashWorld, replayChunk, netWorth } from '@tendril/sim/src/index.ts';
import type { FarmResponse } from './api-client.ts';
import type { LogChunk } from './chunks.ts';
import { validateRestore } from './restore-validator.ts';

function fixture() {
  const world = createWorld({ id: 'restore-test', seed: 3 });
  const farm = { id: world.id, seed: world.seed, tick: 0, coins: world.coins, startedAtMs: 0, rulesVersion: 3, netWorth: netWorth(world), checkpointHash: hashWorld(world), checkpoint: serialize(world) } as FarmResponse;
  const chunks: LogChunk[] = [];
  for (const toTick of [45_001, 45_010]) {
    const fromTick = world.tick, fromHash = hashWorld(world);
    replayChunk(world, [], toTick);
    chunks.push({ fromTick, toTick, fromHash, hash: hashWorld(world), actions: [] });
  }
  return { world: serialize(world), meta: { seed: 3, startedAtMs: 0, mode: 'live' as const }, hash: hashWorld(world), accepted: { farm, receivedAtMs: null }, logs: chunks, authoritative: farm };
}

test('validates a long chain in bounded slices without changing saved inputs', async () => {
  const input = fixture(), before = structuredClone(input), progress: number[] = [];
  let yields = 0;
  await validateRestore(input, done => progress.push(done), async () => { yields++; });
  assert.deepEqual(input, before);
  assert(yields >= 3);
  assert(progress.length >= 4);
  assert.equal(progress.at(-1), 45_010);
});

test('rejects wrong metadata, checkpoint hash, chain, chunk hash and final checkpoint', async () => {
  const input = fixture();
  await assert.rejects(validateRestore({ ...input, meta: { ...input.meta, seed: 4 } }), /metadata/);
  await assert.rejects(validateRestore({ ...input, hash: 'bad' }), /checkpoint hash/);
  const broken = structuredClone(input); broken.logs[0]!.fromTick = 1;
  await assert.rejects(validateRestore(broken), /chain is inconsistent/);
  const badHash = structuredClone(input); badHash.logs[0]!.hash = 'bad';
  await assert.rejects(validateRestore(badHash), /pending log hash/);
  await assert.rejects(validateRestore({ ...input, logs: input.logs.slice(0, 1) }), /do not reach/);
});

test('does not discard out-of-range actions while slicing a large chunk', async () => {
  const input = fixture(); input.logs[0]!.actions.push([45_001, 0, 7, 1]);
  await assert.rejects(validateRestore(input), /bad action tick/);
});


test('slice boundaries keep each action at its exact tick and verify the original chunk hash', async () => {
  const input = fixture();
  const world = createWorld({ id: 'restore-test', seed: 3 });
  const actions: [number, number, number, number][] = [[0, 0, 7, 1], [19_999, 0, 7, 1], [20_000, 0, 7, 1], [40_000, 0, 7, 1]];
  const fromHash = hashWorld(world);
  replayChunk(world, actions, 45_001);
  const hash = hashWorld(world);
  input.logs = [{ fromTick: 0, toTick: 45_001, fromHash, hash, actions }];
  input.world = serialize(world); input.hash = hash;
  await validateRestore(input);
});

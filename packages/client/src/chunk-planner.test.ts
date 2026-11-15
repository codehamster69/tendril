import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkPlanner } from './chunk-planner.ts';
import type { PlanningRequest, PlanningReply } from './chunk-planner.ts';
import type { FarmResponse } from './api-client.ts';
import type { Submission } from './chunks.ts';
import { planSubmission, submissionPrefix } from './chunks.ts';
import { createWorld, hashWorld, netWorth, serialize } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';

class FakeWorker {
  onmessage: ((event: MessageEvent<PlanningReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: PlanningRequest[] = [];
  stopped = false;
  postMessage(request: PlanningRequest): void { this.requests.push(structuredClone(request)); }
  terminate(): void { this.stopped = true; }
  reply(reply: PlanningReply): void { this.onmessage?.({ data: reply } as MessageEvent<PlanningReply>); }
}
const farm = { tick: 10 } as FarmResponse;
const plan = { hash: 'test' } as Submission;
const setup = (timeout = 1000) => {
  const workers: FakeWorker[] = [];
  const planner = new ChunkPlanner(() => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker; }, timeout);
  return { workers, planner };
};

test('bounded prefix produces the same replay plan and rejects oversized tick groups', () => {
  const world = createWorld({ id: 'planner-test', seed: 3 });
  const checkpoint = {
    id: world.id, seed: world.seed, tick: 0, coins: world.coins,
    startedAtMs: 0, rulesVersion: 3, netWorth: netWorth(world),
    checkpointHash: hashWorld(world), checkpoint: serialize(world),
  } as FarmResponse;
  const waits: LogEntry[] = Array.from({ length: 20_001 }, (_, tick) => [tick, 0, 7, 1]);
  const valid = [{ fromTick: 0, toTick: 20_001, actions: waits }];
  assert.deepEqual(planSubmission(checkpoint, submissionPrefix(0, valid, 20_001), 20_001), planSubmission(checkpoint, valid, 20_001));
  const hugeGroup: LogEntry[] = Array.from({ length: 25_000 }, () => [1, 0, 7, 1]);
  const overflow = [{ fromTick: 0, toTick: 2, actions: [[0, 0, 7, 1] as LogEntry, ...hugeGroup] }];
  const prefix = submissionPrefix(0, overflow, 2);
  assert.equal(prefix[0]!.actions.length, 20_001);
  assert.deepEqual(planSubmission(checkpoint, prefix, 2), planSubmission(checkpoint, overflow, 2));
  const firstGroup = [{ fromTick: 0, toTick: 1, actions: hugeGroup.map((entry) => [0, ...entry.slice(1)] as LogEntry) }];
  assert.throws(() => planSubmission(checkpoint, submissionPrefix(0, firstGroup, 1), 1), /same-tick action group exceeds/);
  assert.throws(() => planSubmission(checkpoint, firstGroup, 1), /same-tick action group exceeds/);
  assert.equal(overflow[0]!.actions.length, 25_001);
});

test('clones only the submission prefix and does not detach retained actions', async () => {
  const { planner, workers } = setup();
  const logs = [
    { fromTick: 10, toTick: 30_010, actions: [[10, 0, 1], [20_010, 0, 1]] as [number, number, number][] },
    { fromTick: 30_010, toTick: 50_010, actions: [[30_010, 0, 1]] as [number, number, number][] },
  ];
  const result = planner.plan(farm, logs, 50_010);
  assert.equal(workers.length, 1);
  const request = workers[0]!.requests[0]!;
  assert.equal(request.logs.length, 1);
  assert.deepEqual(request.logs[0]!.actions, [[10, 0, 1]]);
  assert.equal(logs[0]!.actions.length, 2);
  workers[0]!.reply({ id: request.id, plan });
  assert.deepEqual(await result, plan);
  planner.dispose();
});

test('ignores stale responses and propagates planner validation errors without changing logs', async () => {
  const { planner, workers } = setup();
  const result = planner.plan(farm, [], 20);
  const request = workers[0]!.requests[0]!;
  workers[0]!.reply({ id: request.id + 1, plan });
  workers[0]!.reply({ id: request.id, error: 'Invalid checkpoint' });
  await assert.rejects(result, /Invalid checkpoint/);
  const next = planner.plan(farm, [], 20);
  workers[0]!.reply({ id: workers[0]!.requests[1]!.id, plan: null });
  assert.equal(await next, null);
  planner.dispose();
});

test('worker failure rejects the request and the next request gets a fresh worker', async () => {
  const { planner, workers } = setup();
  const result = planner.plan(farm, [], 20);
  workers[0]!.onerror?.({ message: 'Worker failed' } as ErrorEvent);
  await assert.rejects(result, /Worker failed/);
  assert.equal(workers[0]!.stopped, true);
  const next = planner.plan(farm, [], 20);
  assert.equal(workers.length, 2);
  workers[1]!.reply({ id: workers[1]!.requests[0]!.id, plan: null });
  assert.equal(await next, null);
  planner.dispose();
});

test('timeout and disposal reject in-flight work; disposed planner cannot restart', async () => {
  const first = setup(5);
  await assert.rejects(first.planner.plan(farm, [], 20), /time limit/);
  assert.equal(first.workers[0]!.stopped, true);
  first.planner.dispose();
  const second = setup();
  const result = second.planner.plan(farm, [], 20);
  second.planner.dispose();
  await assert.rejects(result, /disposed/);
  await assert.rejects(second.planner.plan(farm, [], 20), /disposed/);
  assert.equal(second.workers[0]!.stopped, true);
});

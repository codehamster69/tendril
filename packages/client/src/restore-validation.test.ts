import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RestoreValidator } from './restore-validation.ts';
import type { RestoreRequest, RestoreReply, RestoreValidation } from './restore-validation.ts';

class FakeWorker {
  onmessage: ((event: MessageEvent<RestoreReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: RestoreRequest[] = [];
  stopped = false;
  postMessage(request: RestoreRequest): void { this.requests.push(structuredClone(request)); }
  terminate(): void { this.stopped = true; }
  reply(reply: RestoreReply): void { this.onmessage?.({ data: reply } as MessageEvent<RestoreReply>); }
}
const input = { world: 'checkpoint', logs: [] } as unknown as RestoreValidation;
const setup = (timeout = 1000) => {
  const workers: FakeWorker[] = [];
  const validator = new RestoreValidator(() => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; }, timeout);
  return { workers, validator };
};

test('progress is forwarded, stale replies ignored, worker terminated after success', async () => {
  const { workers, validator } = setup(), progress: number[] = [];
  const pending = validator.validate(input, done => progress.push(done));
  const worker = workers[0]!, id = worker.requests[0]!.id;
  worker.reply({ id: id + 1, type: 'ready' });
  worker.reply({ id, type: 'progress', done: 20_000, total: 40_000 });
  assert.deepEqual(progress, [20_000]);
  assert.equal(worker.stopped, false);
  worker.reply({ id, type: 'ready' }); await pending;
  assert.equal(worker.stopped, true);
  validator.dispose();
});

test('validation errors preserve input and next request uses a new worker', async () => {
  const { workers, validator } = setup(), before = structuredClone(input);
  const pending = validator.validate(input), worker = workers[0]!;
  worker.reply({ id: worker.requests[0]!.id, type: 'error', error: 'Saved pending log hash mismatch. Logs retained.' });
  await assert.rejects(pending, /hash mismatch/);
  assert.equal(worker.stopped, true); assert.deepEqual(input, before);
  const next = validator.validate(input);
  workers[1]!.reply({ id: workers[1]!.requests[0]!.id, type: 'ready' }); await next;
});

test('worker failure, timeout, disposal and posting failures reject without hanging', async () => {
  const { workers, validator } = setup();
  const pending = validator.validate(input);
  workers[0]!.onerror?.({ message: 'worker failed' } as ErrorEvent);
  await assert.rejects(pending, /worker failed/);
  const next = validator.validate(input); validator.dispose();
  await assert.rejects(next, /disposed/); await assert.rejects(validator.validate(input), /disposed/);
  const short = setup(5); await assert.rejects(short.validator.validate(input), /time limit/);
  assert.equal(short.workers[0]!.stopped, true);
  const failed = new RestoreValidator(() => { throw new Error('construction failed'); });
  await assert.rejects(failed.validate(input), /construction failed/);
});

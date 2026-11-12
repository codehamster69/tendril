import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BACKOFF_MS, createPendingRuns, MAX_AGE_MS, MAX_KEPT } from './pending-run.ts';
import type { PendingRun } from './pending-run.ts';

function harness(results: Array<'ok' | number>) {
  let stored: Record<string, PendingRun> = {};
  const timers: Array<{ fn: () => Promise<void>; ms: number; live: boolean }> = [];
  const submitted: string[] = [];
  let clock = 1_000_000;
  const queue = [...results];
  const runs = createPendingRuns({
    load: () => JSON.parse(JSON.stringify(stored)),
    save: (all) => { stored = JSON.parse(JSON.stringify(all)); },
    submit: async (run) => {
      const next = queue.shift() ?? 'ok';
      if (next === 'ok') return { entryId: run.challengeId };
      throw Object.assign(new Error('x'), { status: next });
    },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
    now: () => clock,
    onSubmitted: (run) => { submitted.push(run.challengeId); },
  });
  return { runs, timers, submitted, stored: () => stored, tick: (ms: number) => { clock += ms; } };
}
const run = (id = 'd-2026-12-01') => ({ challengeId: id, rulesVersion: 3, actions: [[0, 0, 0, 1]] as PendingRun['actions'] });

describe('pending runs', () => {
  it('a successful submit keeps nothing', async () => {
    const h = harness(['ok']);
    await h.runs.submit(run());
    assert.deepEqual(h.stored(), {});
    assert.equal(h.timers.length, 0);
  });

  it('keeps a run through unreachable, rate-limited and read-only answers, then submits it when the server returns', async () => {
    const h = harness([0, 429, 503, 'ok']);
    await assert.rejects(h.runs.submit(run()), { status: 0 });
    assert.equal(h.runs.pending().length, 1);
    assert.equal(h.timers[0]!.ms, BACKOFF_MS[0]);
    await h.timers[0]!.fn(); // the timer fires: 429 keeps it
    assert.equal(h.runs.pending().length, 1);
    await h.runs.flush(); // 503 keeps it
    assert.equal(h.runs.pending().length, 1);
    await h.runs.flush(); // ok
    assert.deepEqual(h.submitted, ['d-2026-12-01']);
    assert.deepEqual(h.stored(), {});
  });

  it('backs off and then holds at the last step', async () => {
    const h = harness([0, 0, 0, 0, 0, 0, 0, 0]);
    await assert.rejects(h.runs.submit(run()));
    for (let i = 0; i < 6; i++) await h.timers.at(-1)!.fn();
    assert.deepEqual(h.timers.slice(0, 6).map((t) => t.ms), [...BACKOFF_MS, BACKOFF_MS.at(-1)]);
  });

  it('drops runs the server will never accept, and runs older than their challenge', async () => {
    const h = harness([0, 409]);
    await assert.rejects(h.runs.submit(run()));
    await h.runs.flush();
    assert.deepEqual(h.stored(), {});
    const g = harness([0]);
    await assert.rejects(g.runs.submit(run()));
    g.tick(MAX_AGE_MS + 1);
    await g.runs.flush();
    assert.deepEqual(g.stored(), {});
    assert.deepEqual(g.submitted, []);
  });

  it('does not store a run the server rejects outright, keeps the newest per challenge and bounds the total', async () => {
    const h = harness([422]);
    await assert.rejects(h.runs.submit(run()));
    assert.deepEqual(h.stored(), {});
    const g = harness(Array(MAX_KEPT + 3).fill(0));
    for (let i = 0; i < MAX_KEPT + 3; i++) { g.tick(1); await assert.rejects(g.runs.submit(run(`d-${i}`))); }
    assert.equal(g.runs.pending().length, MAX_KEPT);
    assert.ok(!('d-0' in g.stored()));
  });

  it('a 401 is kept for after the player signs in', async () => {
    const h = harness([401, 'ok']);
    await assert.rejects(h.runs.submit(run()), { status: 401 });
    assert.equal(h.runs.pending().length, 1);
    await h.runs.flush();
    assert.deepEqual(h.submitted, ['d-2026-12-01']);
  });
});

// Dry run worker: its own thread and its own copy of the farm, so the real farm keeps running untouched.
import { dryRun } from './dry-run-core';
import type { DryRunRequest, DryRunResult } from './dry-run-core';

export type DryToWorker = DryRunRequest & { id: number };
export type DryFromWorker =
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'done'; id: number; result: DryRunResult }
  | { type: 'error'; id: number; message: string };

const post = (m: DryFromWorker): void => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<DryToWorker>) => {
  const { id, ...req } = e.data;
  try {
    const it = dryRun(req);
    let last = 0;
    for (;;) {
      const r = it.next();
      if (r.done) { post({ type: 'done', id, result: r.value }); return; }
      const now = performance.now();
      if (now - last > 50) {
        last = now;
        post({ type: 'progress', id, done: r.value[0], total: r.value[1] });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};

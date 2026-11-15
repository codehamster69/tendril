import type { FarmResponse } from './api-client';
import { submissionPrefix, type LogChunk, type Submission } from './chunks.ts';

export interface PlanningRequest { id: number; farm: FarmResponse; logs: LogChunk[]; endTick: number }
export type PlanningReply = { id: number; plan: Submission | null } | { id: number; error: string };

/** Replays submission prefixes outside the renderer; retained history stays owned by RealSim. */
export class ChunkPlanner {
  private worker: Worker | null = null;
  private nextId = 0;
  private disposed = false;
  private pending: { id: number; resolve: (plan: Submission | null) => void; reject: (error: Error) => void } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private makeWorker = () => new Worker(new URL('./chunk-planner-worker.ts', import.meta.url), { type: 'module' }),
    private timeoutMs = 30_000,
  ) {}

  plan(farm: FarmResponse, logs: LogChunk[], endTick: number): Promise<Submission | null> {
    if (this.disposed) return Promise.reject(new Error('Chunk planner was disposed.'));
    if (this.pending) return Promise.reject(new Error('Chunk planning is already in progress.'));
    return new Promise((resolve, reject) => {
      try {
        if (!this.worker) {
          const worker = this.worker = this.makeWorker();
          worker.onmessage = (event: MessageEvent<PlanningReply>) => {
            if (worker !== this.worker || event.data.id !== this.pending?.id) return;
            const pending = this.takePending()!;
            if ('error' in event.data) pending.reject(new Error(event.data.error));
            else pending.resolve(event.data.plan);
          };
          worker.onerror = (event) => this.fail(worker, event.message || 'Chunk planning worker failed.');
          worker.onmessageerror = () => this.fail(worker, 'Chunk planning reply could not be read.');
        }
        const worker = this.worker;
        const id = ++this.nextId;
        this.pending = { id, resolve, reject };
        this.timer = setTimeout(() => this.fail(worker, 'Chunk planning exceeded its time limit. Local logs are kept.'), this.timeoutMs);
        // Copy only the next bounded prefix. Cloning the entire offline backlog
        // here would itself block the renderer before the worker starts.
        const prefix = submissionPrefix(farm.tick, logs, endTick);
        worker.postMessage({ id, farm, logs: prefix, endTick } satisfies PlanningRequest);
      } catch (error) {
        if (this.worker) this.fail(this.worker, error instanceof Error ? error.message : String(error));
        else reject(error);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.takePending()?.reject(new Error('Chunk planner was disposed.'));
  }

  private takePending(): typeof this.pending {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    this.pending = null;
    return pending;
  }

  private fail(worker: Worker, message: string): void {
    if (worker !== this.worker) return;
    worker.terminate();
    this.worker = null;
    this.takePending()?.reject(new Error(message));
  }
}

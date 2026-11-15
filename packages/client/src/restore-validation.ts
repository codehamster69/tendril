import type { RestoreValidation } from './restore-validator';
export type { RestoreValidation } from './restore-validator';
export interface RestoreRequest { id: number; input: RestoreValidation }
export type RestoreReply = { id: number; type: 'progress'; done: number; total: number }
  | { id: number; type: 'ready' } | { id: number; type: 'error'; error: string };

/** A separate, short-lived worker keeps long saved-history validation off the UI. */
export class RestoreValidator {
  private worker: Worker | null = null;
  private disposed = false;
  private nextId = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { id: number; resolve: () => void; reject: (error: Error) => void; progress: (done: number, total: number) => void } | null = null;
  constructor(
    private makeWorker = () => new Worker(new URL('./restore-validator-worker.ts', import.meta.url), { type: 'module' }),
    private timeoutMs = 30_000,
  ) {}
  validate(input: RestoreValidation, progress: (done: number, total: number) => void = () => {}): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Restore validator was disposed.'));
    if (this.pending) return Promise.reject(new Error('Saved farm validation is already in progress.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending = { id, resolve, reject, progress };
      try {
        const worker = this.worker = this.makeWorker();
        worker.onmessage = (event: MessageEvent<RestoreReply>) => {
          const message = event.data;
          if (worker !== this.worker || message.id !== this.pending?.id) return;
          if (message.type === 'progress') {
            this.arm(worker);
            this.pending.progress(message.done, message.total);
          } else {
            const pending = this.finish();
            if (message.type === 'error') pending?.reject(new Error(message.error));
            else pending?.resolve();
          }
        };
        worker.onerror = event => this.fail(worker, event.message || 'Saved farm validation worker failed. Logs are kept.');
        worker.onmessageerror = () => this.fail(worker, 'Saved farm validation reply could not be read. Logs are kept.');
        this.arm(worker);
        worker.postMessage({ id, input } satisfies RestoreRequest);
      } catch (error) {
        this.finish()?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  dispose(): void {
    this.disposed = true;
    this.finish()?.reject(new Error('Restore validator was disposed.'));
  }
  private arm(worker: Worker): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(worker, 'Saved farm validation exceeded its time limit. Logs are kept.'), this.timeoutMs);
  }
  private finish(): typeof this.pending {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.worker?.terminate();
    this.worker = null;
    const pending = this.pending;
    this.pending = null;
    return pending;
  }
  private fail(worker: Worker, message: string): void {
    if (worker !== this.worker) return;
    this.finish()?.reject(new Error(message));
  }
}

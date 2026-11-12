// Keeps a finished run that could not be submitted (offline, rate limit, server read-only for the free-tier budget guard)
// and retries it with backoff until the server takes it. No imports at runtime so it can be unit-tested with node.
import type { LogEntry } from '@tendril/sim/src/index.ts';

export interface PendingRun { challengeId: string; rulesVersion: number; actions: LogEntry[]; savedAt: number }
export interface Deps {
  load(): Record<string, PendingRun>;
  save(all: Record<string, PendingRun>): void;
  /** Resolves with the entry, or throws an object with a numeric `status` (0 = unreachable). */
  submit(run: PendingRun): Promise<unknown>;
  setTimer(fn: () => Promise<void>, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
  onSubmitted(run: PendingRun, entry: unknown): void;
}

/** 0 unreachable, 429 rate limited, 5xx (503 is the read-only guard), 401 until the player signs in again. */
export const isRetryable = (status: number | undefined): boolean => status === 0 || status === 401 || status === 429 || (status !== undefined && status >= 500);
const statusOf = (error: unknown): number | undefined => (typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status: unknown }).status) : undefined);

export const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
/** A saved run older than this is dropped: its challenge has closed. */
export const MAX_AGE_MS = 3 * 24 * 3600_000;
/** Bound on kept runs, so a broken server cannot fill storage. */
export const MAX_KEPT = 5;

export function createPendingRuns(deps: Deps) {
  let timer: unknown;
  let attempt = 0;
  let busy = false;

  const arm = (): void => {
    if (timer !== undefined || Object.keys(deps.load()).length === 0) return;
    const ms = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    attempt++;
    timer = deps.setTimer(() => { timer = undefined; return flush(); }, ms);
  };

  /** Tries every saved run once. Failures that can be retried stay saved and re-arm the timer. */
  async function flush(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const all = deps.load();
      for (const [key, run] of Object.entries(all)) {
        if (deps.now() - run.savedAt > MAX_AGE_MS) { delete all[key]; continue; }
        try {
          const entry = await deps.submit(run);
          delete all[key];
          attempt = 0;
          deps.onSubmitted(run, entry);
        } catch (error) {
          if (!isRetryable(statusOf(error))) delete all[key]; // 409 and friends will never succeed on retry
        }
      }
      deps.save(all);
    } finally { busy = false; }
    arm();
  }

  return {
    /** Submit now; on a retryable failure keep the run for later and rethrow so the caller can say so. */
    async submit(run: Omit<PendingRun, 'savedAt'>): Promise<unknown> {
      const full: PendingRun = { ...run, savedAt: deps.now() };
      try {
        return await deps.submit(full);
      } catch (error) {
        if (isRetryable(statusOf(error))) {
          const all = deps.load();
          all[run.challengeId] = full; // one saved run per challenge: the newest
          const keys = Object.keys(all).sort((a, b) => all[a]!.savedAt - all[b]!.savedAt);
          while (keys.length > MAX_KEPT) delete all[keys.shift()!];
          deps.save(all);
          arm();
        }
        throw error;
      }
    },
    flush,
    pending: (): PendingRun[] => Object.values(deps.load()),
  };
}

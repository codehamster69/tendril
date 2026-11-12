// Background sync of the ranked farm: plans a chunk inside the sim queue, sends it, acknowledges it.
import { ApiError, type ChunkResponse, type FarmApi } from './api-client';
import type { RealSim } from './real-sim';
import { toast } from './palette';

/** Normal spacing. The server allows 10 chunk attempts per rolling hour, so this leaves room for "Sync now". */
export const SYNC_INTERVAL_MS = 10 * 60_000;
/** A chunk covers at most 20,000 ticks, so a farm well behind syncs again soon after each success. */
export const BACKLOG_INTERVAL_MS = 45_000;
/** After a rate limit, a clock skew or a network blip. */
export const RETRY_INTERVAL_MS = 15 * 60_000;
const MIN_GAP_MS = 60_000;

let inFlight: Promise<ChunkResponse | null> | null = null;

/** Sends one chunk if there are unverified ticks. Resolves null when already synced. Never pauses the program. */
export function syncOnce(api: FarmApi, sim: RealSim): Promise<ChunkResponse | null> {
  inFlight ??= (async () => {
    const plan = await sim.planChunk();
    if (!plan) return null;
    const response = await api.submit(sim.accepted!.farm.id, plan.request);
    await sim.acknowledge(plan, response);
    return response;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** What to do after a failed sync: try again later, or stop until the player acts. */
export function retryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  // 0: offline. 429: hourly limit. 422 "ahead of server clock": this device's clock runs fast. 5xx: server trouble.
  return error.status === 0 || error.status === 429 || error.status >= 500
    || (error.status === 422 && error.message.includes('ahead of server clock'));
}

export function mountAutoSync(api: FarmApi, sim: RealSim): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let lastAttempt = 0;
  let announced = false;
  const schedule = (ms: number): void => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void run(), ms);
  };
  const run = async (): Promise<void> => {
    if (stopped) return;
    if (Date.now() - lastAttempt < MIN_GAP_MS) { schedule(MIN_GAP_MS); return; }
    lastAttempt = Date.now();
    try {
      const response = await syncOnce(api, sim);
      if (response && !announced) { announced = true; toast('Farm verified', `On the leaderboard at rank ${response.rank}.`); }
      // More unverified ticks than one chunk carries: keep going.
      const behind = response !== null && (sim.latest()?.tick ?? 0) - response.tick > 6_000;
      schedule(behind ? BACKLOG_INTERVAL_MS : SYNC_INTERVAL_MS);
    } catch (e) {
      if (retryable(e)) { schedule(RETRY_INTERVAL_MS); return; }
      stopped = true;
      toast('Auto-sync stopped', `${e instanceof Error ? e.message : 'Unknown error'} Your local logs are kept. Reload to try again.`);
    }
  };
  // Give the farm a moment to load and catch up before the first attempt.
  schedule(BACKLOG_INTERVAL_MS);
  // Leaving the tab: a last sync while the page is still alive.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && Date.now() - lastAttempt >= MIN_GAP_MS) void run(); });
}

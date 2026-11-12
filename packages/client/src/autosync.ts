// Background sync of the ranked farm: plans a chunk inside the sim queue, sends it, acknowledges it.
// Small chunks every few seconds keep the leaderboard close to live; a backlog is sent back to back.
import { ApiError, type ChunkResponse, type FarmApi } from './api-client';
import type { RealSim } from './real-sim';
import { toast } from './palette';

/** Default spacing, used until the server says otherwise. The server allows 360 chunk attempts per hour; this uses about 240. */
export const SYNC_INTERVAL_MS = 15_000;
/** The server's `nextSyncMs` hint is followed within this range: 15 s for the top of the board, minutes for the long tail. */
const HINT_MIN_MS = 15_000;
const HINT_MAX_MS = 10 * 60_000;
/** A chunk carries at most 20,000 ticks; only while further behind than that does the next chunk go straight away. */
const BACKLOG_TICKS = 20_000;
const BACKLOG_INTERVAL_MS = 1_000;
/** Retry after offline, 5xx or a fast device clock: doubles from 15 s up to 5 minutes. */
const RETRY_MIN_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;
/** After a 429 the hourly budget needs time to refill. */
const RATE_LIMITED_MS = 2 * 60_000;
/** Focus, visibility and online events never send more often than this. */
const MIN_GAP_MS = 3_000;

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

/** Errors worth retrying on their own; anything else stops auto-sync until a reload. */
export function retryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  // 0: offline. 429: hourly limit. 422 "ahead of server clock": this device's clock runs fast. 5xx: server trouble.
  return error.status === 0 || error.status === 429 || error.status >= 500
    || (error.status === 422 && error.message.includes('ahead of server clock'));
}

const fmt = new Intl.NumberFormat();

export function mountAutoSync(api: FarmApi, sim: RealSim, status: HTMLElement | null): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let lastAttempt = 0;
  let retryMs = RETRY_MIN_MS;
  let announced = false;
  const show = (text: string): void => { if (status) status.textContent = text; };
  const schedule = (ms: number): void => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void run(), ms);
  };
  const run = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) { schedule(BACKLOG_INTERVAL_MS); return; }
    lastAttempt = Date.now();
    try {
      const response = await syncOnce(api, sim);
      retryMs = RETRY_MIN_MS;
      if (response) {
        const place = response.rank === null ? 'outside the top 500' : `rank ${fmt.format(response.rank)}`;
        show(`On the leaderboard · ${place} · verified to tick ${fmt.format(response.tick)}`);
        if (!announced) { announced = true; toast('Farm verified', `On the leaderboard, ${place}.`); }
      }
      const behind = response !== null && (sim.latest()?.tick ?? 0) - response.tick > BACKLOG_TICKS;
      const hint = response?.nextSyncMs ?? SYNC_INTERVAL_MS;
      schedule(behind ? BACKLOG_INTERVAL_MS : Math.min(HINT_MAX_MS, Math.max(HINT_MIN_MS, hint)));
    } catch (e) {
      if (retryable(e)) {
        const rateLimited = e instanceof ApiError && e.status === 429;
        show(rateLimited ? 'Leaderboard sync is waiting for the hourly limit · your farm keeps running' : 'Leaderboard sync paused · retrying · your farm keeps running');
        schedule(rateLimited ? RATE_LIMITED_MS : retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        return;
      }
      stopped = true;
      show('Leaderboard sync stopped · reload to try again');
      toast('Auto-sync stopped', `${e instanceof Error ? e.message : 'Unknown error'} Your local logs are kept. Reload to try again.`);
    }
  };
  const soon = (): void => { if (Date.now() - lastAttempt >= MIN_GAP_MS) void run(); };
  // First attempt once the farm has loaded.
  schedule(2_000);
  // Phones pause background tabs and their timers: sync as the tab leaves and again the moment it returns.
  document.addEventListener('visibilitychange', soon);
  window.addEventListener('focus', soon);
  window.addEventListener('online', () => { retryMs = RETRY_MIN_MS; soon(); });
}

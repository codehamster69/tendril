import type { LogEntry } from '@tendril/sim/src/index.ts';

export interface FarmResponse {
  id: string; seed: number; startedAtMs: number; tick: number;
  checkpoint: string; checkpointHash: string; rulesVersion: number;
  coins: number; netWorth: number;
}
export interface LeaderEntry {
  rank: number; userId: string; displayName: string; farmId: string;
  netWorth: number; growth24h: number; tick: number; verifiedAtMs: number;
}
export interface DailyEntry { rank: number; userId: string; displayName: string; netWorth: number; submittedAtMs: number }
export interface Profile { id: string; login: string; displayName: string; avatarUrl: string | null }
/** rank is null beyond the top 500; nextSyncMs is how long the server would like the client to wait before the next sync. */
export interface ChunkResponse { tick: number; checkpointHash: string; netWorth: number; rank: number | null; nextSyncMs?: number }
export interface ReplayResponse {
  seed: number; rulesVersion: number;
  chunks: { fromTick: number; toTick: number; actions: LogEntry[] }[];
  nextFromTick: number | null;
}
export interface ChallengeInfo {
  id: string; kind: 'daily' | 'season' | 'duel'; number: number | null; seed: number; ticks: number; par: number | null;
  opensAt: number | null; closesAt: number | null; rulesVersion: number; players: number; best: number | null;
}
export interface EntryResult {
  entryId: string; netWorth: number; parTick: number | null; tokens: number | null; mosaic: string;
  ranks: { wealth: number | null; speed: number | null; brevity: number | null }; percentile: number | null; improved: boolean; total: number;
}
export interface DuelPage {
  id: string; seed: number; ticks: number; par: number | null; rulesVersion: number; createdAt: number;
  challenger: { login: string; displayName: string; avatarUrl: string | null } | null;
  entry: { entryId: string; netWorth: number; parTick: number | null; mosaic: string | null } | null;
  accepted: number; viewer: { isChallenger: boolean; accepted: boolean; entryId: string | null } | null;
}
export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ApiError'; }
}

const TOKEN_KEY = 'tendril.token';
const DESKTOP = typeof location !== 'undefined' && location.protocol === 'app:';
// Must equal DEFAULT_API_ORIGIN in electron/config.cjs (checked by navigation.test.cjs).
const DEFAULT_DESKTOP_API_ORIGIN = 'https://tendril.hokora.xyz';
export const API_ORIGIN: string = (import.meta.env.VITE_API_ORIGIN as string | undefined) ?? (DESKTOP ? DEFAULT_DESKTOP_API_ORIGIN : '');

export class FarmApi {
  constructor(readonly token: string | null = readToken(), readonly base = `${API_ORIGIN}/api`) {}

  private async request<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'X-Tendril-Client': '1' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(this.base + route, {
        method, headers, credentials: API_ORIGIN ? 'omit' : 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ApiError(0, 'The Tendril server is unreachable. Your farm keeps running locally.');
    }
    if (response.status === 204) return undefined as T;
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new ApiError(response.status, 'The server returned an unexpected response.');
    }
    const data = await response.json();
    if (!response.ok) throw new ApiError(response.status, typeof data?.error === 'string' ? data.error : 'The server rejected the request.');
    return data as T;
  }

  me(): Promise<{ profile: Profile }> { return this.request('/me'); }
  logout(): Promise<void> { return this.request('/auth/logout', 'POST', {}); }
  pollDesktop(nonce: string): Promise<{ token: string; profile: Profile }> { return this.request('/auth/desktop/poll', 'POST', { nonce }); }
  login(displayName: string): Promise<{ token: string; profile: { id: string; displayName: string } }> {
    return this.request('/dev/login', 'POST', { displayName });
  }
  farm(): Promise<FarmResponse> { return this.request('/farms/me'); }
  createFarm(): Promise<FarmResponse> { return this.request('/farms', 'POST', {}); }
  submit(id: string, chunk: { fromTick: number; toTick: number; actions: LogEntry[]; rulesVersion: number; checkpointHash: string }): Promise<ChunkResponse> {
    return this.request(`/farms/${encodeURIComponent(id)}/chunks`, 'POST', chunk);
  }
  leaderboard(board: 'networth' | 'growth'): Promise<{ board: 'networth' | 'growth'; entries: LeaderEntry[] }> {
    return this.request(`/leaderboard?board=${board}&limit=20`);
  }
  replay(id: string, fromTick = 0): Promise<ReplayResponse> { return this.request(`/farms/${encodeURIComponent(id)}/replay?fromTick=${fromTick}&limit=1`); }
  challenge(id: string): Promise<ChallengeInfo> { return this.request(`/challenges/${encodeURIComponent(id)}`); }
  createDuel(body: { seed: number; ticks: number }): Promise<{ challengeId: string }> { return this.request('/duels', 'POST', body); }
  duel(id: string): Promise<DuelPage> { return this.request(`/duels/${encodeURIComponent(id)}`); }
  acceptDuel(id: string): Promise<{ accepted: true; changed: boolean; challenger: { login: string; displayName: string } }> {
    return this.request(`/duels/${encodeURIComponent(id)}/accept`, 'POST', {});
  }
  submitEntry(id: string, body: { rulesVersion: number; actions: LogEntry[] }): Promise<EntryResult> {
    return this.request(`/challenges/${encodeURIComponent(id)}/entries`, 'POST', body);
  }
  daily(): Promise<{ date: string; seed: number; ticks: number; rulesVersion: number }> { return this.request('/daily'); }
  submitDaily(body: { date: string; rulesVersion: number; actions: LogEntry[] }): Promise<{ netWorth: number; rank: number; best: number }> {
    return this.request('/daily/submit', 'POST', body);
  }
  dailyLeaderboard(date: string): Promise<{ date: string; entries: DailyEntry[] }> {
    return this.request(`/daily/leaderboard?date=${encodeURIComponent(date)}&limit=20`);
  }
}

const HINT_KEY = 'tendril.signedin';
/** A sign-in marker, so a visitor who never signed in does not trigger a /api/me request (and a console 401) on every load. */
export function signedInHint(): boolean { try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; } }
export function setSignedInHint(on: boolean): void { try { if (on) localStorage.setItem(HINT_KEY, '1'); else localStorage.removeItem(HINT_KEY); } catch { /* private mode */ } }

export function readToken(): string | null { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
export function writeToken(token: string | null): void {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 2000;
export const isDesktop = DESKTOP;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/**
 * Web: full-page redirect through GitHub, resolves null. Desktop: the system browser plus a one-time
 * nonce poll that gives up after five minutes. Resolves null when `signal` aborts (the player cancelled).
 */
export async function signIn(signal: AbortSignal = new AbortController().signal): Promise<Profile | null> {
  if (!DESKTOP) {
    setSignedInHint(true);
    location.href = `/api/auth/github?return=${encodeURIComponent(location.pathname + location.search)}`;
    return null;
  }
  const bridge = (window as unknown as { tendrilDesktop?: { openExternal(u: string): void } }).tendrilDesktop;
  if (!bridge) throw new Error('This desktop build cannot open the system browser.');
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
  bridge.openExternal(`${API_ORIGIN}/api/auth/github?desktop=${nonce}`);
  const api = new FarmApi(null);
  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await abortableSleep(POLL_INTERVAL_MS, signal);
    if (signal.aborted) return null;
    try {
      const res = await api.pollDesktop(nonce);
      if (res?.token) { writeToken(res.token); setSignedInHint(true); return res.profile; }
    } catch (e) {
      // 404/202: not approved yet. 0: offline blip. Anything else ends the attempt.
      if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 202 && e.status !== 0)) throw e;
    }
  }
  throw new Error('Sign-in timed out.');
}

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
export interface ChunkResponse { tick: number; checkpointHash: string; netWorth: number; rank: number }
export interface ReplayResponse {
  seed: number; rulesVersion: number;
  chunks: { fromTick: number; toTick: number; actions: LogEntry[] }[];
  nextFromTick: number | null;
}
export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ApiError'; }
}

const TOKEN_KEY = 'tendril.token';
const DESKTOP = typeof location !== 'undefined' && location.protocol === 'app:';
export const API_ORIGIN: string = (import.meta.env.VITE_API_ORIGIN as string | undefined) ?? (DESKTOP ? 'https://tendril-farm.vercel.app' : '');

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
  daily(): Promise<{ date: string; seed: number; ticks: number; rulesVersion: number }> { return this.request('/daily'); }
  submitDaily(body: { date: string; rulesVersion: number; actions: LogEntry[] }): Promise<{ netWorth: number; rank: number; best: number }> {
    return this.request('/daily/submit', 'POST', body);
  }
  dailyLeaderboard(date: string): Promise<{ date: string; entries: DailyEntry[] }> {
    return this.request(`/daily/leaderboard?date=${encodeURIComponent(date)}&limit=20`);
  }
}

export function readToken(): string | null { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
export function writeToken(token: string | null): void {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

/** Web: full-page redirect through GitHub. Desktop: system browser plus a one-time nonce poll. */
export async function signIn(): Promise<Profile | null> {
  if (!DESKTOP) {
    location.href = `/api/auth/github?return=${encodeURIComponent(location.pathname + location.search)}`;
    return null;
  }
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
  const url = `${API_ORIGIN}/api/auth/github?desktop=${nonce}`;
  const bridge = (window as unknown as { tendrilDesktop?: { openExternal(u: string): void } }).tendrilDesktop;
  if (bridge) bridge.openExternal(url); else window.open(url, '_blank', 'noopener');
  const api = new FarmApi(null);
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await api.pollDesktop(nonce);
      if (res?.token) { writeToken(res.token); return res.profile; }
    } catch (e) {
      if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 0)) throw e;
    }
  }
  throw new Error('Sign-in timed out. Try again.');
}

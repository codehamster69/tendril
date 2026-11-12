import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, dailySeed, DAILY_TICKS, deserialize, hashWorld, netWorth, replayChunk, RULES_VERSION, serialize } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createApp, createDb, migrate } from '../src/index.ts';
import type { Db, FarmResponse, FetchFn, LeaderEntry, Profile } from '../src/index.ts';
import { DAY_MS, HOUR_MS } from '../src/game.ts';
import { MAX_BODY_BYTES } from '../src/validation.ts';

type Login = { token: string; profile: Profile };
type Accepted = { tick: number; checkpointHash: string; netWorth: number; rank: number };
type ReplayPage = { seed: number; rulesVersion: number; chunks: { fromTick: number; toTick: number; actions: LogEntry[] }[]; nextFromTick: number | null };
type Env = Record<string, string | undefined>;
type Opts = { method?: string; token?: string; body?: unknown; raw?: string; headers?: Record<string, string>; cookie?: string; csrf?: boolean };

const BASE = Date.UTC(2026, 10, 12, 12, 0, 0);
const ORIGIN = 'https://tendril.example';
const baseEnv = (): Env => ({ TENDRIL_DEV_AUTH: '1', GITHUB_CLIENT_ID: 'client-id', GITHUB_CLIENT_SECRET: 'client-secret-value', PUBLIC_ORIGIN: ORIGIN });
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

let db: Db;
let app: (request: Request) => Promise<Response>;
let time: number;
let env: Env;
let github: ReturnType<typeof githubStub>;
let user: Login;
let farm: FarmResponse;

function githubStub(profile: Record<string, unknown> = { id: 4242, login: 'octo-cat', name: 'Octo Cat', avatar_url: 'https://avatars.githubusercontent.com/u/4242' }) {
  const calls: { url: string; body: string; authorization: string | null }[] = [];
  const fetchStub: FetchFn = async (url, init) => {
    calls.push({ url, body: String(init?.body ?? ''), authorization: new Headers(init?.headers).get('authorization') });
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'gho_stub_token' });
    if (url === 'https://api.github.com/user') return Response.json(profile);
    throw new Error(`unexpected network call: ${url}`);
  };
  return { calls, fetch: fetchStub };
}

// Small chunk budget for the rate-limit tests; the production default is tested in attack.test.ts.
function makeApp(): void { app = createApp({ db, env, fetch: github.fetch, now: () => time, chunkAttemptsPerHour: 10 }); }

async function request(path: string, options: Opts = {}) {
  const headers = new Headers(options.headers);
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.csrf) headers.set('X-Tendril-Client', '1');
  const hasBody = options.body !== undefined || options.raw !== undefined;
  if (hasBody) headers.set('Content-Type', 'application/json');
  return app(new Request(`http://localhost:8787/api${path}`, {
    method: options.method ?? (hasBody ? 'POST' : 'GET'), headers,
    body: options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
  }));
}
async function login(name = 'Farmer') {
  const response = await request('/dev/login', { body: { displayName: name } });
  expect(response.status).toBe(201);
  return await response.json() as Login;
}
function chunkBody(actions: unknown = [], toTick = 100, source = farm) {
  return { fromTick: source.tick, toTick, actions, rulesVersion: source.rulesVersion, checkpointHash: source.checkpointHash };
}
async function submit(body: unknown, token = user.token, id = farm.id) {
  return request(`/farms/${id}/chunks`, { token, body });
}
async function myFarm(token = user.token) { return await (await request('/farms/me', { token })).json() as FarmResponse; }
async function state() {
  return {
    farm: await (await request('/farms/me', { token: user.token })).json(),
    farms: await db.query('SELECT * FROM farms ORDER BY id'),
    chunks: await db.query('SELECT * FROM chunks ORDER BY farm_id, from_tick'),
    history: await db.query('SELECT * FROM worth_history ORDER BY id'),
  };
}
async function rejected(body: unknown, status = 422) {
  const before = await state();
  const response = await submit(body);
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: expect.any(String) });
  expect(await state()).toEqual(before);
}
const harvest: LogEntry[] = [
  [0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [95, 0, 4],
  [98, 0, 0, 3], [100, 0, 5], [101, 0, 8, 1, 4],
];

beforeEach(async () => {
  db = createDb({ url: ':memory:' });
  time = BASE;
  env = baseEnv();
  github = githubStub();
  makeApp();
  user = await login();
  const response = await request('/farms', { token: user.token, body: {} });
  expect(response.status).toBe(201);
  farm = await response.json() as FarmResponse;
  time += 2000000;
});
afterEach(() => { db.close(); });

describe('migrations', () => {
  it('are idempotent, recorded in schema_version, and applied lazily on the first request', async () => {
    expect(await db.query('SELECT version FROM schema_version')).toEqual([{ version: 1 }]);
    expect(await migrate(db)).toEqual([]);
    const fresh = createDb({ url: ':memory:' });
    try {
      const lazy = createApp({ db: fresh, env, fetch: github.fetch, now: () => time });
      expect((await lazy(new Request('http://localhost:8787/api/stats'))).status).toBe(200);
      expect(await fresh.query('SELECT version FROM schema_version')).toEqual([{ version: 1 }]);
    } finally { fresh.close(); }
  });
  it('persist in a file database across reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tendril-db-'));
    try {
      const first = createDb({ url: `file:${join(dir, 't.db')}` });
      const one = createApp({ db: first, env, fetch: github.fetch, now: () => time });
      const created = await one(new Request('http://localhost:8787/api/dev/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'Persisted' }) }));
      const { token } = await created.json() as Login;
      first.close();
      const second = createDb({ url: `file:${join(dir, 't.db')}` });
      const two = createApp({ db: second, env, fetch: github.fetch, now: () => time });
      const me = await two(new Request('http://localhost:8787/api/me', { headers: { Authorization: `Bearer ${token}` } }));
      expect(me.status).toBe(200);
      second.close();
    } finally { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows keeps SQLite files locked briefly; temp dir cleanup is best effort */ } }
  });
});

describe('dev login and farms', () => {
  it('stores only token hashes and always creates new identities', async () => {
    expect(user.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const second = await login();
    expect(second.profile.id).not.toBe(user.profile.id);
    expect(second.token).not.toBe(user.token);
    const hashes = await db.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(hashes).toContainEqual({ token_hash: sha(user.token) });
    expect(JSON.stringify(hashes)).not.toContain(user.token);
  });
  it.each(['a', 'a'.repeat(33), 'ab\n', 'ab\t', 'ab\u0000', 'ab‮', '  '])('rejects invalid display name %j', async (displayName) => {
    expect((await request('/dev/login', { body: { displayName } })).status).toBe(400);
    expect(await db.query('SELECT * FROM users')).toHaveLength(1);
  });
  it('stores SQL-shaped display names as plain text', async () => {
    const name = "Robert'); DROP TABLE users;--";
    const evil = await login(name);
    expect(evil.profile.displayName).toBe(name);
    const me = await (await request('/me', { token: evil.token })).json() as { profile: Profile };
    expect(me.profile.displayName).toBe(name);
    time += 2000;
    const evilFarm = await (await request('/farms', { token: evil.token, body: {} })).json() as FarmResponse;
    time += 2000;
    expect((await request(`/farms/${evilFarm.id}/chunks`, { token: evil.token, body: chunkBody([], 10, evilFarm) })).status).toBe(200);
    const board = await (await request('/leaderboard')).json() as { entries: LeaderEntry[] };
    expect(board.entries.map((e) => e.displayName)).toEqual([name]);
    expect(await db.query('SELECT COUNT(*) AS n FROM users')).toEqual([{ n: 2 }]);
    expect(await db.query("SELECT * FROM users WHERE display_name = ?", [name])).toHaveLength(1);
  });
  it('is refused in production or when not enabled', async () => {
    env.VERCEL_ENV = 'production';
    expect((await request('/dev/login', { body: { displayName: 'Nope' } })).status).toBe(404);
    env.VERCEL_ENV = 'preview';
    expect((await request('/dev/login', { body: { displayName: 'Okay' } })).status).toBe(201);
    delete env.TENDRIL_DEV_AUTH;
    expect((await request('/dev/login', { body: { displayName: 'Nope' } })).status).toBe(404);
    env.TENDRIL_DEV_AUTH = '1';
    env.VERCEL_ENV = 'production';
    expect((await request('/dev/login', { body: { displayName: 'Nope' } })).status).toBe(404);
    expect(await db.query('SELECT * FROM users')).toHaveLength(2);
  });
  it('generates a pinned checkpoint and returns the existing active farm', async () => {
    expect(farm).toEqual({
      id: expect.any(String), seed: expect.any(Number), startedAtMs: BASE, tick: 0,
      checkpoint: expect.any(String), checkpointHash: expect.stringMatching(/^[0-9a-f]{8}$/),
      rulesVersion: RULES_VERSION, coins: 0, netWorth: 0,
    });
    expect(RULES_VERSION).toBe(3);
    expect(farm.seed).toBeGreaterThan(0);
    expect(hashWorld(deserialize(farm.checkpoint))).toBe(farm.checkpointHash);
    const created = await request('/farms', { token: user.token, body: {} });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual(farm);
    expect(await myFarm()).toEqual(farm);
    const other = await login('Other');
    expect((await request('/farms/me', { token: other.token })).status).toBe(404);
  });
  it('serializes concurrent farm creation', async () => {
    const other = await login('Concurrent');
    const responses = await Promise.all([request('/farms', { token: other.token, body: {} }), request('/farms', { token: other.token, body: {} })]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
    expect(await db.query('SELECT * FROM farms WHERE user_id = ?', [other.profile.id])).toHaveLength(1);
  });
  it('requires valid bearer auth, ignores query tokens, and rejects claimed farm fields', async () => {
    expect((await request('/farms', { body: {} })).status).toBe(401);
    expect((await request('/farms/me', { token: 'fake' })).status).toBe(401);
    expect((await request(`/farms/me?token=${user.token}`)).status).toBe(401);
    expect((await request('/farms', { token: user.token, body: { seed: 1 } })).status).toBe(400);
    expect((await request('/me')).status).toBe(401);
  });
});

describe('GitHub OAuth', () => {
  async function begin(query = 'return=/play/') {
    const response = await request(`/auth/github?${query}`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    const setCookie = response.headers.get('set-cookie')!;
    return { response, location, state: location.searchParams.get('state')!, setCookie, cookie: setCookie.split(';')[0]! };
  }
  const cb = (state: string, cookie?: string, code = 'the-code') => request(`/auth/github/callback?code=${code}&state=${state}`, { cookie });
  const sessionFrom = (setCookie: string[]) => setCookie.find((c) => c.startsWith('tendril_session='))!;

  it('accepts extra parameters GitHub may add to the callback (iss, error_uri) instead of failing with Invalid query', async () => {
    const start = await begin();
    const done = await request(`/auth/github/callback?code=the-code&state=${start.state}&iss=${encodeURIComponent('https://github.com/login/oauth')}`, { cookie: start.cookie });
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/play/');
    const denied = await begin();
    const refused = await request(`/auth/github/callback?error=access_denied&error_description=x&error_uri=${encodeURIComponent('https://docs.github.com/x')}&state=${denied.state}`, { cookie: denied.cookie });
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain('Invalid query');
  });

  it('completes the happy path: state cookie, code exchange, session cookie, same-origin redirect', async () => {
    const start = await begin('return=/play/?lesson=1');
    expect(start.location.origin + start.location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(start.location.searchParams.get('client_id')).toBe('client-id');
    expect(start.location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/github/callback`);
    expect(start.setCookie).toMatch(/^tendril_oauth_state=[A-Za-z0-9_-]{43}; Max-Age=600; /);
    expect(start.setCookie).toContain('HttpOnly');
    expect(start.setCookie).toContain('Secure');
    expect(start.setCookie).toContain('SameSite=Lax');
    const done = await cb(start.state, start.cookie);
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/play/?lesson=1');
    const cookies = done.headers.getSetCookie();
    const session = sessionFrom(cookies);
    expect(session).toMatch(/^tendril_session=[A-Za-z0-9_-]{43}; Max-Age=\d+; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(github.calls.map((c) => c.url)).toEqual(['https://github.com/login/oauth/access_token', 'https://api.github.com/user']);
    expect(JSON.parse(github.calls[0]!.body)).toMatchObject({ client_id: 'client-id', client_secret: 'client-secret-value', code: 'the-code' });
    expect(github.calls[1]!.authorization).toBe('Bearer gho_stub_token');
    const sessionCookie = session.split(';')[0]!;
    const token = sessionCookie.split('=')[1]!;
    const me = await (await request('/me', { cookie: sessionCookie })).json() as { profile: Profile };
    expect(me.profile).toEqual({ id: expect.any(String), login: 'octo-cat', displayName: 'Octo Cat', avatarUrl: 'https://avatars.githubusercontent.com/u/4242' });
    expect(JSON.stringify(await db.query('SELECT * FROM sessions'))).not.toContain(token);
    expect(JSON.stringify(await db.query('SELECT * FROM users'))).not.toContain('gho_stub_token');
    // Signing in again reuses the same user.
    const again = await begin();
    await cb(again.state, again.cookie);
    expect(await db.query('SELECT * FROM users WHERE github_id = 4242')).toHaveLength(1);
    // Logout needs the CSRF header for cookie auth, then ends the session.
    expect((await request('/auth/logout', { method: 'POST', cookie: sessionCookie })).status).toBe(403);
    const out = await request('/auth/logout', { method: 'POST', cookie: sessionCookie, csrf: true });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('tendril_session=; Max-Age=0');
    expect((await request('/me', { cookie: sessionCookie })).status).toBe(401);
  });
  it('requires X-Tendril-Client for cookie-authenticated mutations but not for bearer tokens or reads', async () => {
    const cookie = `tendril_session=${user.token}`;
    expect((await request('/farms/me', { cookie })).status).toBe(200);
    expect((await request('/farms', { cookie, body: {} })).status).toBe(403);
    expect((await request('/farms', { cookie, csrf: true, body: {} })).status).toBe(200);
    expect((await request('/farms', { token: user.token, body: {} })).status).toBe(200);
    const blocked = await request(`/farms/${farm.id}/chunks`, { cookie, body: chunkBody([], 10) });
    expect(blocked.status).toBe(403);
    expect((await request('/daily/submit', { cookie, body: { date: '2026-11-12', rulesVersion: RULES_VERSION, actions: [] } })).status).toBe(403);
    expect((await myFarm()).tick).toBe(0);
  });
  it.each([
    'return=//evil.example', 'return=https://evil.example/', 'return=/\\evil.example', 'return=/%5Cevil.example', 'return=javascript:alert(1)',
    'return=evil.example', 'return=/%0d%0aSet-Cookie:x=1', 'return=/%09/evil.example', 'return=http://localhost:8787/play/',
  ])('rejects open-redirect attempt %s', async (query) => {
    expect((await request(`/auth/github?${query}`)).status).toBe(400);
    expect(await db.query('SELECT * FROM oauth_states')).toHaveLength(0);
  });
  it('defaults the return path and rejects a bad desktop nonce', async () => {
    expect((await begin('')).response.headers.get('set-cookie')).toBeTruthy();
    expect((await request('/auth/github?desktop=short')).status).toBe(400);
    expect((await request('/auth/github?x=1')).status).toBe(400);
  });
  it('rejects missing, mismatched, replayed, and expired state without calling GitHub', async () => {
    const start = await begin();
    expect((await cb(start.state)).status).toBe(400);
    expect((await cb(start.state, 'tendril_oauth_state=' + 'A'.repeat(43))).status).toBe(400);
    expect((await cb('B'.repeat(43), start.cookie)).status).toBe(400);
    expect((await cb('not-a-state', start.cookie)).status).toBe(400);
    expect(github.calls).toHaveLength(0);
    expect((await cb(start.state, start.cookie)).status).toBe(302);
    expect((await cb(start.state, start.cookie)).status).toBe(400); // single use
    const late = await begin();
    time += 10 * 60 * 1000 + 1;
    expect((await cb(late.state, late.cookie)).status).toBe(400);
    expect(github.calls).toHaveLength(2);
  });
  it('reports GitHub failures as 502 without leaking details or creating users', async () => {
    github = githubStub({ id: 'x', login: '../bad' });
    makeApp();
    const start = await begin();
    const failed = await cb(start.state, start.cookie);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'GitHub sign-in failed' });
    expect(await db.query('SELECT * FROM users WHERE github_id IS NOT NULL')).toHaveLength(0);
    const denied = await begin();
    expect((await request(`/auth/github/callback?error=access_denied&state=${denied.state}`, { cookie: denied.cookie })).status).toBe(400);
  });
  it('answers 503 when OAuth is not configured', async () => {
    delete env.GITHUB_CLIENT_SECRET;
    expect((await request('/auth/github')).status).toBe(503);
  });
  it('hands a desktop session to the polling app exactly once', async () => {
    const nonce = 'n'.repeat(40);
    expect((await request('/auth/desktop/poll', { body: { nonce } })).status).toBe(404);
    const start = await begin(`desktop=${nonce}`);
    const pending = await request('/auth/desktop/poll', { body: { nonce } });
    expect(pending.status).toBe(202);
    expect((await request('/auth/github?desktop=' + nonce)).status).toBe(400); // nonce cannot be reused
    const done = await cb(start.state, start.cookie);
    expect(done.status).toBe(200);
    expect(done.headers.get('content-type')).toContain('text/html');
    expect(done.headers.getSetCookie().some((c) => c.startsWith('tendril_session='))).toBe(false);
    expect(await db.query('SELECT * FROM sessions')).toHaveLength(1); // only the dev login
    expect(JSON.stringify(await db.query('SELECT * FROM desktop_logins'))).not.toContain(nonce);
    const [one, two] = await Promise.all([request('/auth/desktop/poll', { body: { nonce } }), request('/auth/desktop/poll', { body: { nonce } })]);
    expect([one.status, two.status].sort()).toEqual([200, 404]);
    const granted = await (one.status === 200 ? one : two).json() as { token: string; profile: Profile };
    expect(granted.profile.login).toBe('octo-cat');
    expect((await request('/me', { token: granted.token })).status).toBe(200);
    expect((await request('/auth/desktop/poll', { body: { nonce } })).status).toBe(404);
    expect((await request('/auth/desktop/poll', { body: { nonce: 'short' } })).status).toBe(400);
  });
  it('expires unclaimed desktop logins after 10 minutes', async () => {
    const nonce = 'e'.repeat(40);
    const start = await begin(`desktop=${nonce}`);
    time += 10 * 60 * 1000 + 1;
    expect((await request('/auth/desktop/poll', { body: { nonce } })).status).toBe(404);
    expect((await cb(start.state, start.cookie)).status).toBe(400);
  });
  it('allows Bearer-only CORS from the desktop origin and refuses other origins', async () => {
    const desktop = await app(new Request('http://localhost:8787/api/me', { headers: { Origin: 'app://tendril', Authorization: `Bearer ${user.token}` } }));
    expect(desktop.status).toBe(200);
    expect(desktop.headers.get('access-control-allow-origin')).toBe('app://tendril');
    expect(desktop.headers.get('access-control-allow-credentials')).toBeNull();
    const cookieOnly = await app(new Request('http://localhost:8787/api/me', { headers: { Origin: 'app://tendril', Cookie: `tendril_session=${user.token}` } }));
    expect(cookieOnly.status).toBe(401);
    const preflight = await app(new Request('http://localhost:8787/api/farms', { method: 'OPTIONS', headers: { Origin: 'app://tendril', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } }));
    expect(preflight.status).toBe(204);
    delete env.TENDRIL_DEV_AUTH; // loopback origins are only trusted in dev mode
    for (const origin of ['https://evil.example', 'null', 'http://localhost:5173']) {
      const response = await app(new Request('http://localhost:8787/api/leaderboard', { headers: { Origin: origin } }));
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect((await app(new Request('http://localhost:8787/api/leaderboard', { headers: { Origin: ORIGIN } }))).status).toBe(200);
  });
});

describe('transactional verification', () => {
  it('replays farming, computes actual worth, ranks, and publishes reproducible chunks', async () => {
    expect((await request(`/farms/${farm.id}/replay`)).status).toBe(404);
    expect(await (await request('/leaderboard')).json()).toEqual({ board: 'networth', entries: [] });
    const result = await submit(chunkBody(harvest, 102));
    expect(result.status).toBe(200);
    const accepted = await result.json() as Accepted;
    const local = createWorld({ id: farm.id, seed: farm.seed });
    replayChunk(local, harvest, 102);
    expect(accepted).toEqual({ tick: 102, checkpointHash: hashWorld(local), netWorth: 8, rank: 1 });
    expect(netWorth(local)).toBe(8);
    const current = await myFarm();
    expect(current.coins).toBe(8);
    expect(current.checkpoint).toBe(serialize(local));
    const next = await submit(chunkBody([], 200, current));
    expect(next.status).toBe(200);
    const replay = await (await request(`/farms/${farm.id}/replay`)).json() as ReplayPage;
    expect(replay).toEqual({ seed: farm.seed, rulesVersion: RULES_VERSION, chunks: [{ fromTick: 0, toTick: 102, actions: harvest }], nextFromTick: 102 });
    const tail = await (await request(`/farms/${farm.id}/replay?fromTick=${replay.nextFromTick}&limit=1`)).json() as ReplayPage;
    expect(tail).toEqual({ seed: farm.seed, rulesVersion: RULES_VERSION, chunks: [{ fromTick: 102, toTick: 200, actions: [] }], nextFromTick: null });
    const replayed = createWorld({ id: farm.id, seed: replay.seed });
    for (const chunk of [...replay.chunks, ...tail.chunks]) replayChunk(replayed, chunk.actions, chunk.toTick);
    expect(hashWorld(replayed)).toBe((await next.json() as Accepted).checkpointHash);
    const board = await (await request('/leaderboard?board=networth&limit=1')).json();
    expect(board).toEqual({ board: 'networth', entries: [{ rank: 1, userId: user.profile.id, displayName: 'Farmer', farmId: farm.id, netWorth: 8, growth24h: 8, tick: 200, verifiedAtMs: time }] });
  });
  it('accepts legal failed moves, not busy actions, and allows idle advancement', async () => {
    const result = await submit(chunkBody([[0, 0, 0, 0]], 2));
    expect(result.status).toBe(200);
    const current = await myFarm();
    expect(deserialize(current.checkpoint).bots[0]?.y).toBe(0);
    expect((await submit(chunkBody([], 100, current))).status).toBe(200);
  });
  it.each([
    [[0, 0, 0, 1], [0, 0, 1]],
    [[2, 0, 3], [1, 0, 3]],
    [[0, 999, 3]], [[0, -1, 3]], [[0, 0, 10]], [[0, 0, 11]],
    [[0, 0, 0, 4]], [[0, 0, 2, 0]], [[0, 0, 7, 1001]], [[0, 0, 6, 0]],
    [[0, 0, 8, 1, 0]], [[0, -1, 9, 1000000001, 0]],
    [[0, 0, 3, 42]], [[0, 0, 0]], [[0, 0, 0, 1, 9]],
    [[0, 0, 7, null]], [[0.5, 0, 3]], [[0, 0, 7, '2']], [[100, 0, 3]],
  ])('rejects invalid logs without any game-state mutation: %j', async (...actions) => {
    await rejected(chunkBody(actions));
  });
  it('returns the illegal-action message and leaves the checkpoint untouched', async () => {
    const before = await myFarm();
    const response = await submit(chunkBody([[0, 0, 0, 1], [2, 0, 1], [3, 0, 2, 1]]));
    expect(response.status).toBe(422);
    const body = await response.json() as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
    expect(body.error).not.toMatch(/\bat .*\.ts/);
    expect(await myFarm()).toEqual(before);
    expect(await db.query('SELECT * FROM chunks')).toHaveLength(0);
  });
  it('rejects non-array and unsafe action values', async () => {
    await rejected(chunkBody({ 0: [0, 0, 3] }));
    await rejected(chunkBody([[0, 0, 7, Number.MAX_SAFE_INTEGER + 1]]));
  });
  it('rejects all claimed scores and extra fields', async () => {
    await rejected({ ...chunkBody(), netWorth: 999999 });
    await rejected({ ...chunkBody(), coins: 999999 });
    await rejected({ ...chunkBody(), checkpoint: farm.checkpoint });
  });
  it('rejects rules mismatches, stale ticks, and wrong precondition hashes', async () => {
    await rejected({ ...chunkBody(), rulesVersion: RULES_VERSION + 1 }, 409);
    await rejected({ ...chunkBody(), fromTick: 1 }, 409);
    await rejected({ ...chunkBody(), checkpointHash: 'ffffffff' }, 409);
  });
  it('accepts exactly the wall-clock boundary and rejects chunks ahead of the clock', async () => {
    time = farm.startedAtMs + 1099;
    await rejected(chunkBody([], 11));
    expect((await submit(chunkBody([], 10))).status).toBe(200);
  });
  it('lets exactly one of two concurrent submissions win and the other get 409', async () => {
    const responses = await Promise.all([submit(chunkBody(harvest, 102)), submit(chunkBody(harvest, 102))]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.query('SELECT * FROM chunks')).toHaveLength(1);
    expect(await db.query('SELECT * FROM worth_history')).toHaveLength(2);
    await rejected(chunkBody(harvest, 102), 409);
  });
  it('rejects zero-span chunks without stranding subsequent advancement', async () => {
    await rejected(chunkBody([], 0));
    expect((await submit(chunkBody([], 100))).status).toBe(200);
    const current = await myFarm();
    expect(current.tick).toBe(100);
    await rejected(chunkBody([], 100, current));
    expect((await submit(chunkBody([], 200, current))).status).toBe(200);
  });
  it('lets a user append only to their own farm and never exposes unverified replays', async () => {
    const other = await login('Intruder');
    const before = await state();
    expect((await submit(chunkBody(), other.token)).status).toBe(403);
    expect((await request(`/farms/${farm.id}/replay`)).status).toBe(404);
    expect((await request(`/farms/${farm.id}`, { token: other.token })).status).toBe(404);
    expect((await submit(chunkBody(), user.token, '00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await submit(chunkBody(), '')).status).toBe(401);
    expect(await state()).toEqual(before);
    expect((await request('/farms/me', { token: other.token })).status).toBe(404);
  });
  it('rate limits to 10 attempts per user per rolling hour, counting malformed bodies, and resets', async () => {
    for (let i = 0; i < 10; i++) await rejected({ ...chunkBody(), netWorth: 42 });
    makeApp();
    await rejected(chunkBody(), 429);
    const other = await login('Unaffected');
    expect((await request('/farms', { token: other.token, body: {} })).status).toBe(201);
    time += HOUR_MS;
    expect((await submit(chunkBody())).status).toBe(200);
  });
  it('reserves attempts atomically under concurrent abuse', async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => submit({ ...chunkBody(), score: 1 })));
    expect(responses.filter((r) => r.status === 422)).toHaveLength(10);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(2);
    expect(await db.query('SELECT * FROM chunks')).toHaveLength(0);
  });
  it('rolls back every game write if a later database write fails', async () => {
    const before = await state();
    await db.script("CREATE TRIGGER fail_history BEFORE INSERT ON worth_history BEGIN SELECT RAISE(ABORT, 'private SQL path'); END;");
    try {
      const response = await submit(chunkBody());
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(await state()).toEqual(before);
    } finally { await db.script('DROP TRIGGER fail_history;'); }
  });
});

describe('bounded public replay', () => {
  it.each([1, 2])('reconstructs five chunks across limit=%i pages without gaps or duplicates', async (limit) => {
    let current = farm;
    for (const toTick of [102, 200, 300, 400, 500]) {
      expect((await submit(chunkBody(toTick === 102 ? harvest : [], toTick, current))).status).toBe(200);
      current = await myFarm();
    }
    const replayed = createWorld({ id: farm.id, seed: farm.seed });
    let cursor: number | null = 0;
    const starts: number[] = [];
    const cursors: (number | null)[] = [];
    do {
      const response = await request(`/farms/${farm.id}/replay?fromTick=${cursor}&limit=${limit}`);
      expect(response.status).toBe(200);
      const page = await response.json() as ReplayPage;
      expect(page.seed).toBe(farm.seed);
      expect(page.chunks.length).toBeGreaterThan(0);
      expect(page.chunks.length).toBeLessThanOrEqual(limit);
      for (const chunk of page.chunks) {
        expect(chunk.fromTick).toBe(replayed.tick);
        starts.push(chunk.fromTick);
        replayChunk(replayed, chunk.actions, chunk.toTick);
      }
      cursor = page.nextFromTick;
      cursors.push(cursor);
      expect(cursors.length).toBeLessThanOrEqual(5);
    } while (cursor !== null);
    expect(starts).toEqual([0, 102, 200, 300, 400]);
    expect(cursors).toEqual(limit === 1 ? [102, 200, 300, 400, null] : [200, 400, null]);
    // The hash is the contract; serialize() text can differ when weather segments were generated lazily.
    expect(hashWorld(replayed)).toBe(current.checkpointHash);
    const between = await (await request(`/farms/${farm.id}/replay?fromTick=1`)).json() as ReplayPage;
    expect(between.chunks.map((c) => c.fromTick)).toEqual([102]);
    expect(between.nextFromTick).toBe(200);
    for (const fromTick of [500, Number.MAX_SAFE_INTEGER]) {
      expect(await (await request(`/farms/${farm.id}/replay?fromTick=${fromTick}&limit=2`)).json()).toEqual({ seed: farm.seed, rulesVersion: RULES_VERSION, chunks: [], nextFromTick: null });
    }
  });
  it.each([
    'fromTick=-1', 'fromTick=1.5', 'fromTick=NaN', 'fromTick=Infinity', 'fromTick=1e2',
    'fromTick=', 'fromTick=00', 'fromTick=01', 'fromTick=%2B1', 'fromTick=%201',
    'fromTick=9007199254740992', 'fromTick=0&fromTick=0',
    'limit=0', 'limit=3', 'limit=-1', 'limit=1.5', 'limit=NaN', 'limit=1e0',
    'limit=', 'limit=01', 'limit=1&limit=2', 'unknown=1',
  ])('rejects malformed replay query %s before looking up a farm', async (query) => {
    expect((await request(`/farms/${farm.id}/replay?${query}`)).status).toBe(400);
  });
});

describe('HTTP boundary', () => {
  it('rejects malformed JSON, content types, and duplicate or unknown query fields', async () => {
    expect((await request('/dev/login', { raw: '{' })).status).toBe(400);
    const response = await app(new Request('http://localhost:8787/api/dev/login', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(400);
    for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=NaN', 'limit=1e2', 'limit=', 'limit=01', 'limit=20&limit=20', 'board=x', 'board=', 'other=1']) {
      expect((await request(`/leaderboard?${query}`)).status).toBe(400);
    }
    expect((await request('/farms/me?userId=someone', { token: user.token })).status).toBe(400);
    expect((await request('/farms/not-uuid/replay')).status).toBe(400);
    expect((await request('/nope')).status).toBe(404);
  });
  it('bounds raw bytes (413), declared size, action count and tick span', async () => {
    const oversized = await request('/dev/login', { raw: ' '.repeat(MAX_BODY_BYTES + 1) });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: 'Request too large' });
    expect((await request('/dev/login', { raw: '{}', headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } })).status).toBe(413);
    expect((await request('/dev/login', { raw: '{}', headers: { 'Content-Length': 'wrong' } })).status).toBe(400);
    await rejected(chunkBody(Array.from({ length: 20001 }, () => [0, -1, 10])), 413);
    await rejected(chunkBody([], 20001), 413);
    await rejected({ ...chunkBody(), toTick: Number.MAX_SAFE_INTEGER + 1 });
    await rejected({ ...chunkBody(), fromTick: -1 });
    await rejected({ ...chunkBody(), toTick: -1 });
  });
  it('supports exactly the action/tick upper limits', async () => {
    time = farm.startedAtMs + 3000000;
    const response = await submit(chunkBody(Array.from({ length: 20000 }, () => [0, -1, 10]), 20000));
    expect(response.status).toBe(200);
  });
  it('counts invalid JSON and size errors toward the per-user rate cap', async () => {
    for (let i = 0; i < 10; i++) {
      const response = await request(`/farms/${farm.id}/chunks`, { token: user.token, raw: i % 2 ? '{' : ' '.repeat(MAX_BODY_BYTES + 1) });
      expect(response.status).toBe(i % 2 ? 400 : 413);
    }
    expect((await submit(chunkBody())).status).toBe(429);
  });
  it('sets safe headers and secure preflights for same-origin callers', async () => {
    const response = await request('/leaderboard');
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const preflight = await app(new Request('http://localhost:8787/api/farms', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-tendril-client' } }));
    expect(preflight.status).toBe(204);
    expect((await request('/farms', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'DELETE' } })).status).toBe(400);
  });
  it('never returns stack traces or SQL in errors', async () => {
    await db.script('DROP TABLE chunks;');
    const response = await submit(chunkBody());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('ranking and 24-hour history', () => {
  it('breaks equal-score ties by earlier verification time on both boards', async () => {
    const first = await submit(chunkBody(harvest, 102));
    expect((await first.json() as Accepted).rank).toBe(1);
    const other = await login('Second');
    const otherFarm = await (await request('/farms', { token: other.token, body: {} })).json() as FarmResponse;
    time += 20000;
    const second = await submit(chunkBody(harvest, 102, otherFarm), other.token, otherFarm.id);
    expect(second.status).toBe(200);
    expect((await second.json() as Accepted).rank).toBe(2);
    for (const board of ['networth', 'growth']) {
      const result = await (await request(`/leaderboard?board=${board}`)).json() as { entries: LeaderEntry[] };
      expect(result.entries.map((e) => [e.rank, e.userId])).toEqual([[1, user.profile.id], [2, other.profile.id]]);
    }
  });
  it('uses the 24h cutoff baseline, not lifetime growth, and orders each board by its own metric', async () => {
    const other = await login('Fast grower');
    const otherFarm = await (await request('/farms', { token: other.token, body: {} })).json() as FarmResponse;
    const now = time + 3 * DAY_MS;
    const cutoff = now - DAY_MS;
    await db.transaction(async (tx) => {
      await tx.execute('UPDATE farms SET net_worth = ?, tick = 100, verified_at = ? WHERE id = ?', [100, now, farm.id]);
      await tx.execute('UPDATE farms SET net_worth = ?, tick = 100, verified_at = ? WHERE id = ?', [50, now, otherFarm.id]);
      for (const [id, worth, at] of [[farm.id, 70, cutoff - 1000], [farm.id, 80, cutoff], [farm.id, 90, cutoff + 1000], [otherFarm.id, 5, cutoff]] as const) {
        await tx.execute('INSERT INTO worth_history (farm_id, net_worth, at_ms) VALUES (?, ?, ?)', [id, worth, at]);
      }
    });
    time = now;
    const growth = await (await request('/leaderboard?board=growth')).json() as { board: string; entries: LeaderEntry[] };
    expect(growth.board).toBe('growth');
    expect(growth.entries.map((e) => [e.userId, e.growth24h, e.rank])).toEqual([[other.profile.id, 45, 1], [user.profile.id, 20, 2]]);
    const worth = await (await request('/leaderboard?board=networth')).json() as { entries: LeaderEntry[] };
    expect(worth.entries.map((e) => [e.userId, e.rank])).toEqual([[user.profile.id, 1], [other.profile.id, 2]]);
    const limited = await (await request('/leaderboard?board=growth&limit=1')).json() as { entries: LeaderEntry[] };
    expect(limited.entries).toHaveLength(1);
  });
  it('excludes farms without an accepted chunk and reports public stats', async () => {
    expect(await (await request('/stats')).json()).toEqual({ players: 1, farms: 1, dailyEntries: 0 });
    expect((await (await request('/leaderboard')).json() as { entries: unknown[] }).entries).toHaveLength(0);
  });
});

describe('daily challenge', () => {
  const day = () => new Date(time).toISOString().slice(0, 10);
  const dailyBody = (actions: unknown = [], date = day()) => ({ date, rulesVersion: RULES_VERSION, actions });
  const post = (body: unknown, token = user.token) => request('/daily/submit', { token, body });

  it('serves a deterministic seed derived from the UTC date', async () => {
    const info = await (await request('/daily')).json();
    expect(info).toEqual({ date: '2026-11-12', seed: dailySeed('2026-11-12'), ticks: DAILY_TICKS, rulesVersion: RULES_VERSION });
    expect(DAILY_TICKS).toBe(3000);
    time += DAY_MS;
    expect(((await (await request('/daily')).json()) as { seed: number }).seed).not.toBe(dailySeed('2026-11-12'));
  });
  it('replays from createWorld, keeps the best score and ranks players', async () => {
    const low = await post(dailyBody());
    expect(low.status).toBe(200);
    expect(await low.json()).toEqual({ netWorth: 0, rank: 1, best: 0 });
    const reference = createWorld({ id: 'ref', seed: dailySeed(day()) });
    replayChunk(reference, harvest, DAILY_TICKS);
    const high = await (await post(dailyBody(harvest))).json() as { netWorth: number; rank: number; best: number };
    expect(high).toEqual({ netWorth: netWorth(reference), rank: 1, best: netWorth(reference) });
    expect(high.netWorth).toBeGreaterThan(0);
    const worse = await (await post(dailyBody())).json();
    expect(worse).toEqual({ netWorth: 0, rank: 1, best: high.best });
    const other = await login('Rival');
    expect(await (await post(dailyBody(), other.token)).json()).toEqual({ netWorth: 0, rank: 2, best: 0 });
    const board = await (await request(`/daily/leaderboard?date=${day()}`)).json() as { date: string; entries: { userId: string; netWorth: number; rank: number; displayName: string }[] };
    expect(board.date).toBe(day());
    expect(board.entries.map((e) => [e.rank, e.userId, e.netWorth])).toEqual([[1, user.profile.id, high.best], [2, other.profile.id, 0]]);
    expect(await (await request('/stats')).json()).toEqual({ players: 2, farms: 1, dailyEntries: 2 });
    expect((await (await request('/daily/leaderboard?limit=1')).json() as { entries: unknown[] }).entries).toHaveLength(1);
  });
  it('accepts yesterday but rejects older, future, and malformed dates', async () => {
    expect((await post(dailyBody([], new Date(time - DAY_MS).toISOString().slice(0, 10)))).status).toBe(200);
    for (const date of [new Date(time - 2 * DAY_MS).toISOString().slice(0, 10), new Date(time + DAY_MS).toISOString().slice(0, 10), '2026-13-45', '2026-02-30', 'today', 20261112]) {
      expect((await post(dailyBody([], date as string))).status).toBe(422);
    }
    expect((await post({ ...dailyBody(), rulesVersion: 2 })).status).toBe(409);
    expect((await post({ ...dailyBody(), extra: 1 })).status).toBe(422);
    expect((await request('/daily/leaderboard?date=nope')).status).toBe(400);
  });
  it('rejects illegal and out-of-range actions without recording an entry', async () => {
    expect((await post(dailyBody([[0, 0, 0, 1], [2, 0, 1], [3, 0, 2, 1]]))).status).toBe(422);
    expect((await post(dailyBody([[DAILY_TICKS, 0, 3]]))).status).toBe(422);
    expect((await post(dailyBody([]), 'bad')).status).toBe(401);
    expect(await db.query('SELECT * FROM daily_entries')).toHaveLength(0);
  });
  it('enforces 20 submissions per user per UTC day', async () => {
    for (let i = 0; i < 20; i++) expect((await post(dailyBody())).status).toBe(200);
    expect((await post(dailyBody())).status).toBe(429);
    const other = await login('Other');
    expect((await post(dailyBody(), other.token)).status).toBe(200);
    time += DAY_MS;
    expect((await post(dailyBody())).status).toBe(200);
  });
});

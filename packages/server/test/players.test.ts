import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RULES_VERSION } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createApp, createDb } from '../src/index.ts';
import type { Db, Profile } from '../src/index.ts';
import { computeStreaks } from '../src/players.ts';
import { DAY_MS } from '../src/game.ts';

type Login = { token: string; profile: Profile };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BASE = Date.UTC(2026, 10, 12, 12, 0, 0);
const SMALL: LogEntry[] = [[0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [7, 0, 3], [9, 0, 3], [300, 0, 4], [303, 0, 0, 3], [305, 0, 5], [306, 0, 8, 1, 4]];

let db: Db;
let app: (request: Request) => Promise<Response>;
let time: number;

async function call(path: string, o: { method?: string; token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await app(new Request(`http://localhost:8787/api${path}`, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }));
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, text, json: (ct.includes('json') && text ? JSON.parse(text) : null) as Json };
}
async function login(name: string): Promise<Login> {
  const r = await call('/dev/login', { body: { displayName: name } });
  expect(r.status).toBe(201);
  return r.json as Login;
}
const enter = (id: string, token: string, actions: LogEntry[] = SMALL) =>
  call(`/challenges/${id}/entries`, { token, body: { rulesVersion: RULES_VERSION, actions } });
const dailyOf = (ms: number): string => `d-${new Date(ms).toISOString().slice(0, 10)}`;

let a: Login, b: Login;
beforeEach(async () => {
  time = BASE;
  db = createDb({ url: ':memory:' });
  app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1' }, now: () => time });
  a = await login('Alice');
  b = await login('Bob');
});
afterEach(() => db.close());

describe('computeStreaks', () => {
  it('counts consecutive UTC days and resets after a missed day', () => {
    const s = computeStreaks(['2026-11-08', '2026-11-09', '2026-11-11', '2026-11-12'], '2026-11-12');
    expect(s).toEqual({ current: 2, best: 2, lastDay: '2026-11-12' });
    expect(computeStreaks(['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-09'], '2026-11-09').best).toBe(3);
  });
  it('keeps the streak alive until the end of the next day, then drops it', () => {
    const d = ['2026-11-10', '2026-11-11'];
    expect(computeStreaks(d, '2026-11-11').current).toBe(2);
    expect(computeStreaks(d, '2026-11-12').current).toBe(2); // yesterday played, today still open
    expect(computeStreaks(d, '2026-11-13')).toMatchObject({ current: 0, best: 2 });
    expect(computeStreaks([], '2026-11-13')).toEqual({ current: 0, best: 0, lastDay: null });
  });
  it('ignores duplicates and works across month and year ends', () => {
    expect(computeStreaks(['2026-12-31', '2027-01-01', '2027-01-01', '2027-01-02'], '2027-01-02')).toMatchObject({ current: 3, best: 3 });
  });
});

describe('GET /players/:login', () => {
  it('reports streaks over real entries, across a missed day and across midnight UTC', async () => {
    const day = (n: number) => Date.UTC(2026, 10, n, 23, 59, 0);
    time = day(8); expect((await enter(dailyOf(time), a.token)).status).toBe(200);
    time = day(9); expect((await enter(dailyOf(time), a.token)).status).toBe(200);
    // One minute later, just past midnight UTC: the 10th's challenge, still consecutive.
    time = Date.UTC(2026, 10, 10, 0, 1);
    expect((await enter(dailyOf(time), a.token, SMALL.slice(0, 7))).status).toBe(200);
    // The 11th is missed; the 12th is played.
    time = BASE; expect((await enter(dailyOf(time), a.token)).status).toBe(200);
    let r = await call(`/players/${a.profile.login}`);
    expect(r.status).toBe(200);
    expect(r.json.streak).toMatchObject({ current: 1, best: 3, lastDay: '2026-11-12' });
    expect(r.json.recent.length).toBeGreaterThan(0);
    expect(r.json.viewer).toBeNull();
    // Next day nothing played yet: still 1; two days on: 0.
    time = BASE + DAY_MS;
    expect((await call(`/players/${a.profile.login}`)).json.streak.current).toBe(1);
    time = BASE + 2 * DAY_MS;
    r = await call(`/players/${a.profile.login}`);
    expect(r.json.streak).toMatchObject({ current: 0, best: 3 });
  });
  it('is case-insensitive, 404 for unknown and 400 for malformed logins', async () => {
    expect((await call(`/players/${a.profile.login.toUpperCase()}`)).status).toBe(200);
    expect((await call('/players/nobody-here')).status).toBe(404);
    expect((await call('/players/bad%20name')).status).toBe(400);
  });
  it('counts a medal only for first place on a closed board', async () => {
    const id = dailyOf(BASE);
    await enter(id, a.token);
    time += 1000; // equal net worth: the earlier entry wins
    await enter(id, b.token, SMALL.slice(0, 8));
    expect((await call(`/players/${a.profile.login}`)).json.medals).toEqual({ wealth: 0, speed: 0, brevity: 0 });
    time = BASE + 3 * DAY_MS;
    expect((await call(`/players/${a.profile.login}`)).json.medals.wealth).toBe(1);
    expect((await call(`/players/${b.profile.login}`)).json.medals.wealth).toBe(0);
  });
  it('gives a medal to every player who submitted the winning log', async () => {
    const id = dailyOf(BASE);
    await enter(id, a.token);
    time += 1000;
    await enter(id, b.token); // identical log: shares rank 1 with Alice
    time = BASE + 3 * DAY_MS;
    expect((await call(`/players/${a.profile.login}`)).json.medals.wealth).toBe(1);
    expect((await call(`/players/${b.profile.login}`)).json.medals.wealth).toBe(1);
  });
  it('shows whether the viewer follows the player', async () => {
    await call(`/players/${a.profile.login}/follow`, { token: b.token, body: {} });
    const r = await call(`/players/${a.profile.login}`, { token: b.token });
    expect(r.json.viewer).toEqual({ isSelf: false, following: true });
    expect(r.json.followers).toBe(1);
    expect((await call(`/players/${a.profile.login}`, { token: a.token })).json.viewer).toEqual({ isSelf: true, following: false });
  });
});

describe('follow rules', () => {
  const f = (login: string, token?: string, verb = 'follow') => call(`/players/${login}/${verb}`, { token, body: {} });
  it('needs a session, a real player, and not yourself', async () => {
    expect((await f(b.profile.login)).status).toBe(401);
    expect((await f('nobody-here', a.token)).status).toBe(404);
    expect((await f(a.profile.login, a.token)).status).toBe(422);
  });
  it('is idempotent both ways and lists who you follow', async () => {
    expect((await f(b.profile.login, a.token)).json).toEqual({ following: true, changed: true });
    expect((await f(b.profile.login, a.token)).json).toEqual({ following: true, changed: false });
    expect((await call('/me/following', { token: a.token })).json.players.map((p: Json) => p.login)).toEqual([b.profile.login]);
    expect((await f(b.profile.login, a.token, 'unfollow')).json).toEqual({ following: false, changed: true });
    expect((await f(b.profile.login, a.token, 'unfollow')).json).toEqual({ following: false, changed: false });
    expect((await call('/me/following', { token: a.token })).json.players).toEqual([]);
  });
  it('caps how many players one account follows', async () => {
    const now = BASE;
    for (let i = 0; i < 500; i++) {
      await db.execute('INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at) VALUES (?, NULL, ?, ?, NULL, ?)', [`u${i}`, `bulk-${i}`, `Bulk ${i}`, now]);
      await db.execute('INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)', [a.profile.id, `u${i}`, now]);
    }
    expect((await f(b.profile.login, a.token)).status).toBe(409);
  });
});

describe('friends board filter', () => {
  it('shows only followed players and yourself, and needs a session', async () => {
    const c = await login('Cara');
    const id = dailyOf(BASE);
    for (const [u, n] of [[a, 9], [b, 8], [c, 7]] as const) await enter(id, u.token, SMALL.slice(0, n));
    await call(`/players/${b.profile.login}/follow`, { token: a.token, body: {} });
    const r = await call(`/challenges/${id}/board?scope=friends`, { token: a.token });
    expect(r.status).toBe(200);
    expect(r.json.entries.map((e: Json) => e.userId).sort()).toEqual([a.profile.id, b.profile.id].sort());
    expect((await call(`/challenges/${id}/board?scope=friends`)).status).toBe(401);
  });
});

describe('GET /badge/:login.svg', () => {
  it('renders streak and percentile with an hour of caching', async () => {
    await enter(dailyOf(BASE), a.token);
    const r = await call(`/badge/${a.profile.login}.svg`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('image/svg+xml');
    expect(r.headers.get('cache-control')).toContain('max-age=3600');
    expect(r.text).toContain('1 day streak');
    expect(r.text).toContain('top 100%');
  });
  it('gives unknown and malformed logins a valid grey badge, and new players a neutral one', async () => {
    for (const name of ['nobody-here', 'bad%20name']) {
      const r = await call(`/badge/${name}.svg`);
      expect(r.status).toBe(200);
      expect(r.text).toContain('unknown player');
      expect(r.text.startsWith('<svg')).toBe(true);
    }
    expect((await call(`/badge/${b.profile.login}.svg`)).text).toContain('no runs yet');
  });
});

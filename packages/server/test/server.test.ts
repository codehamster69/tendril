import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createWorld, deserialize, hashWorld, netWorth, replayChunk, RULES_VERSION, serialize } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createApp, initializeDb } from '../src/index.ts';
import type { FarmResponse, LeaderEntry } from '../src/index.ts';
import { asService } from '../src/db.ts';
import { DAY_MS, HOUR_MS } from '../src/game.ts';
import { MAX_BODY_BYTES } from '../src/validation.ts';

type Login = { token: string; profile: { id: string; displayName: string } };
type Accepted = { tick: number; checkpointHash: string; netWorth: number; rank: number };
type ReplayPage = { seed: number; rulesVersion: number; chunks: { fromTick: number; toTick: number; actions: LogEntry[] }[]; nextFromTick: number | null };
let db: PGlite;
let app: ReturnType<typeof createApp>;
let time: number;
let user: Login;
let farm: FarmResponse;

async function request(path: string, options: { method?: string; token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers(options.headers);
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.body !== undefined || options.raw !== undefined) headers.set('Content-Type', 'application/json');
  return app.handle(new Request(`http://localhost:8787/api${path}`, {
    method: options.method ?? (options.body !== undefined || options.raw !== undefined ? 'POST' : 'GET'), headers,
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
async function state() {
  return {
    farm: await (await request('/farms/me', { token: user.token })).json(),
    chunks: (await db.query('SELECT * FROM chunks ORDER BY farm_id, from_tick')).rows,
    scores: (await db.query('SELECT * FROM scores ORDER BY farm_id')).rows,
    history: (await db.query('SELECT * FROM worth_history ORDER BY id')).rows,
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

beforeAll(async () => {
  db = new PGlite();
  await initializeDb(db);
}, 30000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('TRUNCATE profiles CASCADE');
  time = 200000000;
  app = createApp({ db, now: () => time });
  user = await login();
  const response = await request('/farms', { token: user.token, body: {} });
  expect(response.status).toBe(201);
  farm = await response.json() as FarmResponse;
  time += 2000000;
});

describe('local identity and farms', () => {
  it('stores only cryptographic token hashes and always creates new identities', async () => {
    expect(user.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(user.profile.id).toMatch(/^[0-9a-f-]{36}$/);
    const second = await login();
    expect(second.profile.id).not.toBe(user.profile.id);
    expect(second.token).not.toBe(user.token);
    const hashes = (await db.query<{ token_hash: string }>('SELECT token_hash FROM sessions')).rows;
    expect(hashes).toContainEqual({ token_hash: createHash('sha256').update(user.token).digest('hex') });
    expect(JSON.stringify(hashes)).not.toContain(user.token);
  });
  it.each(['a', 'a'.repeat(33), 'ab\n', 'ab\t', 'ab\u0000', 'ab\u202e', '  '])('rejects invalid display name %j', async (displayName) => {
    const response = await request('/dev/login', { body: { displayName } });
    expect(response.status).toBe(400);
    expect((await db.query('SELECT * FROM profiles')).rows).toHaveLength(1);
  });
  it('accepts printable unicode without treating SQL-shaped names as SQL', async () => {
    const other = await login("農家 O'Reilly");
    expect(other.profile.displayName).toBe("農家 O'Reilly");
  });
  it('generates a pinned checkpoint and returns the existing active farm', async () => {
    expect(farm).toEqual({
      id: expect.any(String), seed: expect.any(Number), startedAtMs: 200000000, tick: 0,
      checkpoint: expect.any(String), checkpointHash: expect.stringMatching(/^[0-9a-f]{8}$/),
      rulesVersion: RULES_VERSION, coins: 0, netWorth: 0,
    });
    expect(farm.seed).toBeGreaterThan(0);
    expect(hashWorld(deserialize(farm.checkpoint))).toBe(farm.checkpointHash);
    const created = await request('/farms', { token: user.token, body: {} });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual(farm);
    expect(await (await request('/farms/me', { token: user.token })).json()).toEqual(farm);
    const other = await login('Other');
    expect((await request('/farms/me', { token: other.token })).status).toBe(404);
  });
  it('serializes concurrent farm creation', async () => {
    const other = await login('Concurrent');
    const responses = await Promise.all([request('/farms', { token: other.token, body: {} }), request('/farms', { token: other.token, body: {} })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
  });
  it('requires valid bearer auth, ignores query tokens, and rejects claimed farm fields', async () => {
    expect((await request('/farms', { body: {} })).status).toBe(401);
    expect((await request('/farms/me', { token: 'fake' })).status).toBe(401);
    expect((await request(`/farms/me?token=${user.token}`)).status).toBe(401);
    expect((await request('/farms', { token: user.token, body: { seed: 1 } })).status).toBe(400);
  });
  it('supports an injected auth adapter without exposing dev login', async () => {
    app = createApp({ db, now: () => time, auth: async () => ({ userId: user.profile.id }) });
    expect((await request('/dev/login', { body: { displayName: 'No' } })).status).toBe(404);
    expect((await request('/farms/me')).status).toBe(200);
    app = createApp({ db, now: () => time, devLogin: false });
    expect((await request('/dev/login', { body: { displayName: 'No' } })).status).toBe(404);
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
    const current = await (await request('/farms/me', { token: user.token })).json() as FarmResponse;
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
    const current = await (await request('/farms/me', { token: user.token })).json() as FarmResponse;
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
  it('rejects non-array and unsafe action values', async () => {
    await rejected(chunkBody({ 0: [0, 0, 3] }));
    await rejected(chunkBody([[0, 0, 7, Number.MAX_SAFE_INTEGER + 1]]));
  });
  it('discards a mutated replay clone when a later action is illegal', async () => {
    await rejected(chunkBody([[0, 0, 0, 1], [2, 0, 1], [3, 0, 2, 1]]));
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
  it('accepts exactly the wall-clock boundary and rejects future ticks', async () => {
    time = farm.startedAtMs + 1099;
    await rejected(chunkBody([], 11));
    expect((await submit(chunkBody([], 10))).status).toBe(200);
  });
  it('rejects concurrent and repeated checkpoint submissions', async () => {
    const responses = await Promise.all([submit(chunkBody()), submit(chunkBody())]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await db.query('SELECT * FROM chunks')).rows).toHaveLength(1);
    await rejected(chunkBody(), 409);
  });
  it('rejects zero-span chunks without stranding subsequent idle advancement', async () => {
    await rejected(chunkBody([], 0));
    const advanced = await submit(chunkBody([], 100));
    expect(advanced.status).toBe(200);
    const current = await (await request('/farms/me', { token: user.token })).json() as FarmResponse;
    expect(current.tick).toBe(100);
    await rejected(chunkBody([], 100, current));
    expect((await submit(chunkBody([], 200, current))).status).toBe(200);
  });
  it('checks owner authorization and never exposes unverified public replays', async () => {
    const other = await login('Intruder');
    const before = await state();
    expect((await submit(chunkBody(), other.token)).status).toBe(403);
    expect((await request(`/farms/${farm.id}/replay`)).status).toBe(404);
    expect((await request(`/farms/${farm.id}` , { token: other.token })).status).toBe(404);
    expect((await submit(chunkBody(), user.token, '00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect(await state()).toEqual(before);
  });
  it('uses persistent rolling attempts including malformed logs and resets at one hour', async () => {
    for (let i = 0; i < 10; i++) await rejected({ ...chunkBody(), netWorth: 42 });
    app = createApp({ db, now: () => time });
    await rejected(chunkBody(), 429);
    time += HOUR_MS;
    expect((await submit(chunkBody())).status).toBe(200);
  });
  it('reserves attempts atomically under concurrent abuse', async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => submit({ ...chunkBody(), score: 1 })));
    expect(responses.filter((response) => response.status === 422)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(2);
    expect((await db.query('SELECT * FROM chunks')).rows).toHaveLength(0);
  });
  it('rolls back every game write if a later database write fails', async () => {
    const before = await state();
    await db.exec("CREATE FUNCTION fail_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private SQL path'; END $$; CREATE TRIGGER fail_history BEFORE INSERT ON worth_history FOR EACH ROW EXECUTE FUNCTION fail_history()");
    try {
      const response = await submit(chunkBody());
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(await state()).toEqual(before);
    } finally { await db.exec('DROP TRIGGER fail_history ON worth_history; DROP FUNCTION fail_history()'); }
  });
});

describe('bounded public replay', () => {
  it.each([1, 2])('reconstructs five chunks across limit=%i pages without gaps or duplicates', async (limit) => {
    let current = farm;
    for (const toTick of [102, 200, 300, 400, 500]) {
      expect((await submit(chunkBody(toTick === 102 ? harvest : [], toTick, current))).status).toBe(200);
      current = await (await request('/farms/me', { token: user.token })).json() as FarmResponse;
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
      expect(page.rulesVersion).toBe(RULES_VERSION);
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
    expect(serialize(replayed)).toBe(current.checkpoint);
    expect(hashWorld(replayed)).toBe(current.checkpointHash);
    const between = await (await request(`/farms/${farm.id}/replay?fromTick=1`)).json() as ReplayPage;
    expect(between.chunks.map((chunk) => chunk.fromTick)).toEqual([102]);
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
    const response = await app.handle(new Request('http://localhost:8787/api/dev/login', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(400);
    for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=NaN', 'limit=1e2', 'limit=', 'limit=01', 'limit=20&limit=20', 'board=x', 'board=', 'other=1']) {
      expect((await request(`/leaderboard?${query}`)).status).toBe(400);
    }
    expect((await request('/farms/me?userId=someone', { token: user.token })).status).toBe(400);
    expect((await request('/farms/not-uuid/replay')).status).toBe(400);
  });
  it('bounds raw bytes, declared size, action count and tick span', async () => {
    expect((await request('/dev/login', { raw: ' '.repeat(MAX_BODY_BYTES + 1) })).status).toBe(413);
    expect((await request('/dev/login', { raw: '{}', headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } })).status).toBe(413);
    expect((await request('/dev/login', { raw: '{}', headers: { 'Content-Length': 'wrong' } })).status).toBe(400);
    await rejected(chunkBody(Array.from({ length: 20001 }, () => [0, -1, 10])), 413);
    await rejected(chunkBody([], 20001), 413);
    await rejected({ ...chunkBody(), toTick: Number.MAX_SAFE_INTEGER + 1 });
    await rejected({ ...chunkBody(), fromTick: -1 });
    await rejected({ ...chunkBody(), toTick: -1 });
  });
  it('supports exactly the action/tick upper limits', async () => {
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
  it('restricts CORS to explicit loopback origins with secure preflights', async () => {
    const allowed = await request('/leaderboard', { headers: { Origin: 'http://localhost:5173' } });
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(allowed.headers.get('Content-Type')).toBe('application/json');
    expect(allowed.headers.get('X-Content-Type-Options')).toBe('nosniff');
    for (const origin of ['https://evil.example', 'http://localhost.evil.example:5173', 'http://127.1:5173', 'http://localhost:1234', 'null']) {
      const response = await request('/leaderboard', { headers: { Origin: origin } });
      expect(response.status).toBe(403);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    const response = await request('/farms', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
    expect((await request('/farms', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'DELETE' } })).status).toBe(400);
  });
});

describe('ranking and 24-hour history', () => {
  it('breaks equal-score ties by earlier verification time', async () => {
    const first = await submit(chunkBody(harvest, 102));
    expect((await first.json() as Accepted).rank).toBe(1);
    const other = await login('Second');
    const otherFarm = await (await request('/farms', { token: other.token, body: {} })).json() as FarmResponse;
    time += 20000;
    const second = await submit(chunkBody(harvest, 102, otherFarm), other.token, otherFarm.id);
    expect(second.status).toBe(200);
    expect((await second.json() as Accepted).rank).toBe(2);
    const board = await (await request('/leaderboard?board=growth')).json() as { entries: LeaderEntry[] };
    expect(board.entries.map((entry) => entry.userId)).toEqual([user.profile.id, other.profile.id]);
  });
  it('uses the 24h cutoff baseline, not lifetime growth, and ranks by growth', async () => {
    const other = await login('Fast grower');
    const otherFarm = await (await request('/farms', { token: other.token, body: {} })).json() as FarmResponse;
    const now = time + 3 * DAY_MS;
    const cutoff = now - DAY_MS;
    await asService(db, async (tx) => {
      await tx.query('INSERT INTO scores (farm_id, user_id, net_worth, tick, verified_at_ms) VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)', [farm.id, user.profile.id, 100, 100, now, otherFarm.id, other.profile.id, 50, 100, now]);
      for (const [id, worth, at] of [[farm.id, 70, cutoff - 1000], [farm.id, 80, cutoff], [farm.id, 90, cutoff + 1000], [otherFarm.id, 5, cutoff]] as const) {
        await tx.query('INSERT INTO worth_history (farm_id, net_worth, verified_at_ms) VALUES ($1, $2, $3)', [id, worth, at]);
      }
    });
    time = now;
    const growth = await (await request('/leaderboard?board=growth')).json() as { entries: LeaderEntry[] };
    expect(growth.entries.map((entry) => [entry.userId, entry.growth24h])).toEqual([[other.profile.id, 45], [user.profile.id, 20]]);
    const worth = await (await request('/leaderboard?board=networth')).json() as { entries: LeaderEntry[] };
    expect(worth.entries.map((entry) => entry.userId)).toEqual([user.profile.id, other.profile.id]);
  });
});

describe('real PostgreSQL roles and policies', () => {
  async function withRole<T>(role: 'anon' | 'authenticated' | 'service_role', subject: string | null, work: (tx: Parameters<Parameters<PGlite['transaction']>[0]>[0]) => Promise<T>, jsonClaims = false) {
    return db.transaction(async (tx) => {
      await tx.exec(role === 'anon' ? 'SET LOCAL ROLE anon' : role === 'authenticated' ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE service_role');
      if (subject) await tx.query('SELECT set_config($1, $2, true)', [jsonClaims ? 'request.jwt.claims' : 'request.jwt.claim.sub', jsonClaims ? JSON.stringify({ sub: subject }) : subject]);
      return work(tx);
    });
  }
  it('makes profiles public, farms owner-only, and claims compatible with Supabase', async () => {
    const other = await login('Other');
    expect(await withRole('anon', null, async (tx) => (await tx.query('SELECT * FROM profiles')).rows)).toHaveLength(2);
    await expect(withRole('anon', null, (tx) => tx.query('SELECT checkpoint FROM farms'))).rejects.toThrow(/permission denied/);
    expect(await withRole('authenticated', other.profile.id, async (tx) => (await tx.query('SELECT * FROM farms')).rows)).toHaveLength(0);
    expect(await withRole('authenticated', user.profile.id, async (tx) => (await tx.query('SELECT * FROM farms')).rows)).toHaveLength(1);
    expect(await withRole('authenticated', user.profile.id, async (tx) => (await tx.query<{ uid: string }>('SELECT auth.uid() AS uid')).rows[0]?.uid, true)).toBe(user.profile.id);
    expect(await withRole('authenticated', null, async (tx) => (await tx.query('SELECT * FROM farms')).rows)).toHaveLength(0);
  });
  it.each(['anon', 'authenticated'] as const)('denies %s direct score/checkpoint writes and private session access', async (role) => {
    const cases: [string, unknown[]][] = [
      ['SELECT * FROM sessions', []], ['SELECT * FROM chunk_attempts', []],
      ['UPDATE farms SET checkpoint = checkpoint WHERE id = $1', [farm.id]],
      ['INSERT INTO farms SELECT * FROM farms WHERE id = $1', [farm.id]],
      ['UPDATE scores SET net_worth = $1 WHERE farm_id = $2', [999999, farm.id]],
      ['INSERT INTO scores (farm_id, user_id, net_worth, tick, verified_at_ms) VALUES ($1, $2, $3, $4, $5)', [farm.id, user.profile.id, 0, 0, time]],
      ['INSERT INTO chunks (farm_id, from_tick, to_tick, checkpoint_hash, actions, verified_at_ms) VALUES ($1, $2, $3, $4, $5, $6)', [farm.id, 0, 0, farm.checkpointHash, '[]', time]],
      ['INSERT INTO worth_history (farm_id, net_worth, verified_at_ms) VALUES ($1, $2, $3)', [farm.id, 0, time]],
    ];
    for (const [sql, params] of cases) {
      await expect(withRole(role, user.profile.id, (tx) => tx.query(sql, params))).rejects.toThrow(/permission denied/);
    }
  });
  it('exposes chunks only to owner before verification and to public after verification', async () => {
    await asService(db, (tx) => tx.query('INSERT INTO chunks (farm_id, from_tick, to_tick, checkpoint_hash, actions, verified_at_ms) VALUES ($1, $2, $3, $4, $5, $6)', [farm.id, 0, 1, farm.checkpointHash, '[]', time]));
    expect(await withRole('anon', null, async (tx) => (await tx.query('SELECT * FROM chunks')).rows)).toHaveLength(0);
    expect(await withRole('authenticated', user.profile.id, async (tx) => (await tx.query('SELECT * FROM chunks')).rows)).toHaveLength(1);
    await asService(db, (tx) => tx.query('DELETE FROM chunks WHERE farm_id = $1', [farm.id]));
    expect((await submit(chunkBody())).status).toBe(200);
    expect(await withRole('anon', null, async (tx) => (await tx.query('SELECT * FROM chunks')).rows)).toHaveLength(1);
    expect(await withRole('anon', null, async (tx) => (await tx.query('SELECT * FROM scores')).rows)).toHaveLength(1);
    expect(await withRole('service_role', null, async (tx) => (await tx.query('SELECT * FROM sessions')).rows)).toHaveLength(1);
  });
  it('enforces RLS even when a SQL SELECT privilege is temporarily granted', async () => {
    await db.exec('GRANT SELECT ON sessions, farms TO anon');
    try {
      expect(await withRole('anon', null, async (tx) => (await tx.query('SELECT * FROM sessions')).rows)).toHaveLength(0);
      expect(await withRole('anon', null, async (tx) => (await tx.query('SELECT * FROM farms')).rows)).toHaveLength(0);
    } finally { await db.exec('REVOKE SELECT ON sessions, farms FROM anon'); }
  });
  it('enforces RLS on writes even if DML privileges are accidentally granted', async () => {
    await submit(chunkBody());
    await db.exec('GRANT INSERT, UPDATE ON scores, farms TO authenticated');
    try {
      expect(await withRole('authenticated', user.profile.id, async (tx) => (await tx.query('UPDATE scores SET net_worth = $1 WHERE farm_id = $2 RETURNING *', [999, farm.id])).rows)).toHaveLength(0);
      expect(await withRole('authenticated', user.profile.id, async (tx) => (await tx.query('UPDATE farms SET checkpoint = $1 WHERE id = $2 RETURNING *', ['forged', farm.id])).rows)).toHaveLength(0);
      await expect(withRole('authenticated', user.profile.id, (tx) => tx.query('INSERT INTO scores (farm_id, user_id, net_worth, tick, verified_at_ms) VALUES ($1, $2, $3, $4, $5)', [farm.id, user.profile.id, 999, 0, time]))).rejects.toThrow(/row-level security/);
    } finally { await db.exec('REVOKE INSERT, UPDATE ON scores, farms FROM authenticated'); }
  });
  it('applies migrations idempotently and supports down/up on an isolated database', async () => {
    await initializeDb(db);
    expect((await request('/farms/me', { token: user.token })).status).toBe(200);
    const isolated = new PGlite();
    try {
      await isolated.exec("CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$");
      await initializeDb(isolated);
      expect((await isolated.query<{ uid: string }>('SELECT auth.uid() AS uid')).rows[0]?.uid).toBe('00000000-0000-0000-0000-000000000001');
      const down = await readFile(new URL('../migrations/001_game.down.sql', import.meta.url), 'utf8');
      await isolated.transaction(async (tx) => { await tx.exec(down); await tx.query('DELETE FROM schema_migrations WHERE version = $1', [1]); });
      expect((await isolated.query<{ name: string | null }>("SELECT to_regclass('public.farms') AS name")).rows[0]?.name).toBeNull();
      await initializeDb(isolated);
      expect((await isolated.query<{ name: string }>("SELECT to_regclass('public.farms') AS name")).rows[0]?.name).toBe('farms');
    } finally { await isolated.close(); }
  }, 30000);
});

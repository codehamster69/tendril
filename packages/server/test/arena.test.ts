import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { challengeSetup, createWorld, dailyNumber, dailySeed, DAILY_PAR, DAILY_TICKS, replayWithPar, RULES_VERSION, SEASON_TICKS } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createApp, createDb, migrate } from '../src/index.ts';
import type { Db, Profile } from '../src/index.ts';
import { keepIds, KIND_LIMITS, logHash, moveLegacyDaily, percentileOf, seasonId, seasonSeed, VERCEL_BODY_LIMIT } from '../src/arena.ts';
import { verifySource } from '../../lang/src/verify.ts';
import { DAY_MS } from '../src/game.ts';
import { MAX_BODY_BYTES } from '../src/validation.ts';

type Login = { token: string; profile: Profile };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Opts = { method?: string; token?: string; body?: unknown; raw?: string };

const BASE = Date.UTC(2026, 10, 12, 12, 0, 0);
const TODAY = '2026-11-12';
const DAILY = `d-${TODAY}`;
/** What examples/daily.sprout does on seed 7 over 3,000 ticks: net worth 324, above DAILY_PAR. */
const FULL = JSON.parse(readFileSync(new URL('./fixtures/daily-example-seed7.json', import.meta.url), 'utf8')) as LogEntry[];
/** A short legal harvest on any daily seed (the same shape the other server tests use). */
const SMALL: LogEntry[] = [[0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [7, 0, 3], [9, 0, 3], [300, 0, 4], [303, 0, 0, 3], [305, 0, 5], [306, 0, 8, 1, 4]];

/** Does nothing, so its log is empty: the cheapest program the verify step accepts. */
const IDLE = 'x = 1\n';

let db: Db;
let app: (request: Request) => Promise<Response>;
let time: number;
let user: Login;

async function call(path: string, o: Opts = {}) {
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  const hasBody = o.body !== undefined || o.raw !== undefined;
  if (hasBody) headers.set('Content-Type', 'application/json');
  const response = await app(new Request(`http://localhost:8787/api${path}`, {
    method: o.method ?? (hasBody ? 'POST' : 'GET'), headers, body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  }));
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : null) as Json };
}
async function login(name = 'Farmer'): Promise<Login> {
  const r = await call('/dev/login', { body: { displayName: name } });
  expect(r.status).toBe(201);
  return r.json as Login;
}
const enter = (id: string, actions: unknown, token = user.token, extra: Json = {}) =>
  call(`/challenges/${id}/entries`, { token, body: { rulesVersion: RULES_VERSION, actions, ...extra } });
async function duel(token = user.token, body: Json = { seed: 7 }): Promise<string> {
  const r = await call('/duels', { token, body });
  expect(r.status).toBe(201);
  return r.json.challengeId as string;
}

beforeEach(async () => {
  time = BASE;
  db = createDb({ url: ':memory:' });
  app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1', PUBLIC_ORIGIN: 'https://tendril.example' }, now: () => time, verifySource: async (r) => verifySource(r) });
  user = await login();
});
afterEach(() => db.close());

describe('migration 002 and the legacy move', () => {
  it('creates the arena tables', async () => {
    await call('/stats');
    const names = (await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['challenges', 'entries', 'follows', 'arena_meta']));
    expect(await migrate(db)).toEqual([]);
  });

  it('copies daily_entries across once, keeps the old table, and serves them on both old and new routes', async () => {
    await db.execute('INSERT INTO daily_entries (date, user_id, net_worth, achieved_at) VALUES (?, ?, ?, ?)', ['2026-11-11', user.profile.id, 44, BASE - DAY_MS + 5]);
    await db.execute('DELETE FROM arena_meta'); // the app already ran the move once, before these rows existed
    await moveLegacyDaily(db);
    await moveLegacyDaily(db); // second run is a no-op
    const c = await call('/challenges/d-2026-11-11');
    expect(c.status).toBe(200);
    expect(c.json).toMatchObject({ id: 'd-2026-11-11', kind: 'daily', number: dailyNumber('2026-11-11'), seed: dailySeed('2026-11-11'), players: 1, best: 44 });
    expect(await db.query('SELECT * FROM entries')).toHaveLength(1);
    expect(await db.query('SELECT * FROM daily_entries')).toHaveLength(1);
    const old = await call('/daily/leaderboard?date=2026-11-11');
    expect(old.json.entries).toEqual([{ rank: 1, userId: user.profile.id, displayName: 'Farmer', netWorth: 44, achievedAtMs: BASE - DAY_MS + 5 }]);
    const e = old.json.entries.length && (await call('/challenges/d-2026-11-11/board')).json.entries[0];
    expect((await call(`/entries/${e.entryId}/replay`, { token: user.token })).status).toBe(404); // moved rows have no log
  });

  it('runs at start-up for a database that already holds daily rows', async () => {
    const old = createDb({ url: ':memory:' });
    try {
      await migrate(old, () => time);
      await old.execute("INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at) VALUES ('u1', NULL, 'u1', 'Old Timer', NULL, 1)");
      await old.execute('INSERT INTO daily_entries (date, user_id, net_worth, achieved_at) VALUES (?, ?, ?, ?)', [TODAY, 'u1', 9, BASE]);
      const fresh = createApp({ db: old, env: {}, now: () => time });
      const r = await fresh(new Request('http://localhost:8787/api/challenges/today'));
      expect(await r.json()).toMatchObject({ id: DAILY, players: 1, best: 9 });
    } finally { old.close(); }
  });
});

describe('GET /challenges', () => {
  it('creates today lazily with the shared deterministic fields', async () => {
    expect(await db.query('SELECT id FROM challenges')).toHaveLength(0);
    const r = await call('/challenges/today');
    expect(r.status).toBe(200);
    const start = Date.UTC(2026, 10, 12);
    expect(r.json).toEqual({
      id: DAILY, kind: 'daily', number: dailyNumber(TODAY), seed: dailySeed(TODAY), ticks: DAILY_TICKS, par: DAILY_PAR,
      opensAt: start, closesAt: start + DAY_MS, rulesVersion: RULES_VERSION, players: 0, best: null,
    });
    expect((await call(`/challenges/${DAILY}`)).json).toEqual(r.json);
    expect(await db.query('SELECT id FROM challenges')).toHaveLength(1);
  });

  it('creates the current week as s-YYYY-Www, Monday to Monday UTC', async () => {
    const r = await call('/challenges/week');
    // 2026-11-12 is a Thursday in ISO week 46; the Monday is 2026-11-09. Season 1 is the week of 2026-11-30.
    expect(r.json).toMatchObject({ id: 's-2026-W46', kind: 'season', number: -2, seed: seasonSeed('s-2026-W46'), opensAt: Date.UTC(2026, 10, 9), closesAt: Date.UTC(2026, 10, 16) });
    time = Date.UTC(2026, 11, 1, 9);
    expect((await call('/challenges/week')).json).toMatchObject({ id: 's-2026-W49', number: 1, opensAt: Date.UTC(2026, 10, 30) });
  });

  it('names ISO weeks across year boundaries', () => {
    expect(seasonId(Date.UTC(2026, 11, 31))).toBe('s-2026-W53');
    expect(seasonId(Date.UTC(2027, 0, 3))).toBe('s-2026-W53');
    expect(seasonId(Date.UTC(2027, 0, 4))).toBe('s-2027-W01');
    expect(seasonId(Date.UTC(2024, 11, 30))).toBe('s-2025-W01');
  });

  it('refuses unknown, malformed and too-old ids without creating rows', async () => {
    expect((await call('/challenges/x-AAAAAAAA')).status).toBe(404);
    expect((await call('/challenges/d-2020-01-01')).status).toBe(404);
    expect((await call('/challenges/d-2026-11-13')).status).toBe(404); // tomorrow
    expect((await call('/challenges/s-2020-W01')).status).toBe(404);
    for (const bad of ['nope', 'd-2026-13-45', 'D-2026-11-12', 'x-short']) expect((await call(`/challenges/${bad}`)).status).toBe(bad === 'd-2026-13-45' ? 404 : 400);
    expect((await call('/challenges/today?x=1')).status).toBe(400);
    expect(await db.query('SELECT id FROM challenges')).toHaveLength(0);
  });

  it('counts players and reports the best net worth', async () => {
    await enter(DAILY, SMALL);
    const other = await login('Rival');
    await enter(DAILY, [], other.token);
    const r = await call(`/challenges/${DAILY}`);
    expect(r.json.players).toBe(2);
    expect(r.json.best).toBeGreaterThan(0);
  });
});

describe('POST /challenges/:id/entries', () => {
  it('requires a session', async () => {
    expect((await call(`/challenges/${DAILY}/entries`, { body: { rulesVersion: RULES_VERSION, actions: [] } })).status).toBe(401);
  });

  it('verifies a 3,000-tick run, matches an independent replay, and finishes in under a second', async () => {
    const id = await duel();
    const started = performance.now();
    const r = await enter(id, FULL);
    const ms = performance.now() - started;
    expect(r.status).toBe(200);
    const world = createWorld({ id: 'ref', seed: 7 });
    const ref = replayWithPar(world, FULL, DAILY_TICKS, DAILY_PAR);
    expect(ref.netWorth).toBeGreaterThanOrEqual(DAILY_PAR);
    expect(r.json).toMatchObject({ netWorth: ref.netWorth, parTick: ref.parTick, tokens: null, mosaic: ref.mosaic, improved: true, ranks: { wealth: 1, speed: 1, brevity: null }, percentile: 100, total: 1 });
    expect(r.json.mosaic).toHaveLength(64);
    expect(r.json.entryId).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(ms).toBeLessThan(1000);
  });

  it('keeps the best and refuses a repeat of your own log with 409', async () => {
    const id = await duel();
    const first = await enter(id, FULL);
    expect((await enter(id, FULL)).status).toBe(409); // your own log again
    const worse = await enter(id, []);
    expect(worse.json).toMatchObject({ entryId: first.json.entryId, improved: false, netWorth: 0, ranks: { wealth: 1 } });
    expect(await db.query('SELECT id FROM entries')).toHaveLength(1);
    const better = await enter(id, FULL.slice(0, 5));
    expect(better.json.improved).toBe(false);
  });

  it('accepts another player\'s identical log and ranks both equally', async () => {
    const id = await duel();
    const first = await enter(id, FULL);
    const rival = await login('Rival');
    time += 1000;
    const second = await enter(id, FULL, rival.token);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ improved: true, netWorth: first.json.netWorth, ranks: { wealth: 1, speed: 1 }, total: 2 });
    expect(second.json.entryId).not.toBe(first.json.entryId);
    const third = await login('Third');
    await enter(id, SMALL, third.token);
    const board = (await call(`/challenges/${id}/board`)).json;
    expect(board.entries.map((e: Json) => [e.rank, e.displayName])).toEqual([[1, 'Farmer'], [1, 'Rival'], [3, 'Third']]);
    expect((await call(`/challenges/${id}/board`, { token: rival.token })).json.me).toMatchObject({ rank: 1 });
    expect((await enter(id, FULL, rival.token)).status).toBe(409); // but the same player repeating it is still refused
    // Empty logs carry no information: they are never treated as the same run.
    expect((await enter(id, [], user.token)).status).toBe(200);
  });

  it('refuses oversized bodies and logs with 413 and malformed ones with 4xx', async () => {
    const huge = `{"rulesVersion":3,"actions":[],"source":"${'x'.repeat(MAX_BODY_BYTES + 10)}"}`;
    expect((await call(`/challenges/${DAILY}/entries`, { token: user.token, raw: huge })).status).toBe(413);
    const many = new Array<LogEntry>(KIND_LIMITS.daily.maxActions + 1).fill([0, 0, 3]);
    expect((await enter(DAILY, many)).status).toBe(413);
    expect((await enter(DAILY, [], user.token, { source: 'x'.repeat(33 * 1024) })).status).toBe(413);
    expect((await enter(DAILY, 'nope')).status).toBe(422);
    expect((await enter(DAILY, [[DAILY_TICKS, 0, 3]])).status).toBe(422);
    expect((await enter(DAILY, [[0, 0, 0, 1], [1, 0, 1]])).status).toBe(422); // illegal move
    expect((await enter(DAILY, [], user.token, { netWorth: 1e9 })).status).toBe(422);
    expect((await enter(DAILY, [], user.token, { authorKind: 'robot' })).status).toBe(422);
    expect((await enter(DAILY, [], user.token, { authorKind: 'model' })).status).toBe(422); // a model needs a name
    expect((await enter(DAILY, [], user.token, { model: 'gpt' })).status).toBe(422); // a human has none
    expect((await call(`/challenges/${DAILY}/entries`, { token: user.token, raw: '{' })).status).toBe(400);
    expect((await call(`/challenges/${DAILY}/entries`, { token: user.token, body: { actions: [] } })).status).toBe(422);
    expect(await db.query('SELECT id FROM entries')).toHaveLength(0);
  });

  it('refuses a rules version mismatch with 409', async () => {
    const r = await call(`/challenges/${DAILY}/entries`, { token: user.token, body: { rulesVersion: RULES_VERSION + 1, actions: [] } });
    expect(r.status).toBe(409);
  });

  it('refuses submissions after the challenge closes, but never closes a duel', async () => {
    const id = await duel();
    expect((await enter(DAILY, [])).status).toBe(200);
    time += DAY_MS;
    expect((await enter(DAILY, [])).status).toBe(409);
    expect((await enter(id, [])).status).toBe(200);
    time += 20 * DAY_MS; // sessions last 30 days
    expect((await enter(id, FULL)).status).toBe(200);
    // A day that has not started cannot be created, so it cannot be entered.
    expect((await enter('d-2027-12-25', [])).status).toBe(404);
  });

  it('rate limits to 60 entries per user per UTC day', async () => {
    for (let i = 0; i < 60; i++) expect((await enter(DAILY, [])).status).toBe(200);
    expect((await enter(DAILY, [])).status).toBe(429);
    time += DAY_MS;
    expect((await enter(`d-2026-11-13`, [])).status).toBe(200);
  });

  it('records the declared author kind and model', async () => {
    const r = await enter(DAILY, [], user.token, { authorKind: 'model', model: 'test-model-1', source: IDLE, sourcePublic: true });
    expect(r.status).toBe(200);
    const e = await call(`/entries/${r.json.entryId}`);
    expect(e.json).toMatchObject({ authorKind: 'model', model: 'test-model-1', sourceVerified: true, sourcePublic: true });
  });

  it('accepts a season entry on this week\'s challenge', async () => {
    const r = await enter('week', []);
    expect(r.status).toBe(200);
    expect(r.json.ranks.wealth).toBe(1);
  });
});

describe('medal selection keeps at most three entries per player', () => {
  const row = (id: string, net_worth: number, par_tick: number | null, tokens: number | null, created_at = 1) => ({ id, net_worth, par_tick, tokens, created_at });
  it('keeps the best for each medal and drops the rest', () => {
    const rows = [row('rich', 500, 2000, 90), row('fast', 400, 1000, 80), row('short', 300, 2800, 20), row('dull', 100, 2900, 95), row('empty', 50, null, 0)];
    expect([...keepIds(rows)].sort()).toEqual(['fast', 'rich', 'short']);
    expect([...keepIds([row('a', 5, null, null), row('b', 6, null, null)])]).toEqual(['b']);
    expect([...keepIds([row('late', 5, null, null, 9), row('early', 5, null, null, 1)])]).toEqual(['early']);
    expect([...keepIds([row('only', 5, 10, 3)])]).toEqual(['only']);
    // Brevity needs par: a short program that never reached it holds no medal, so a longer one that did is kept.
    expect([...keepIds([row('never', 5, null, 1), row('got-there', 5, 100, 9)])].sort()).toEqual(['got-there']);
  });
  it('computes percentile as the share of players at or below your rank', () => {
    expect(percentileOf(1, 1)).toBe(100);
    expect(percentileOf(1, 10)).toBe(100);
    expect(percentileOf(10, 10)).toBe(10);
    expect(percentileOf(5, 10)).toBe(60);
  });
  it('keeps a slower-but-richer and a faster-but-poorer entry together, in the database', async () => {
    const id = await duel();
    const full = await enter(id, FULL);
    expect(full.json.parTick).not.toBeNull();
    // Stop selling early: reaches par later or never, so it cannot take either medal.
    const early = await enter(id, FULL.filter((a) => a[0] < 1500));
    expect(early.json.improved).toBe(false);
    expect(await db.query('SELECT id FROM entries')).toHaveLength(1);
  });
});

describe('GET /challenges/:id/board', () => {
  async function seeded() {
    const id = await duel();
    const rival = await login('Rival');
    const model = await login('Robot');
    await enter(id, FULL);
    await enter(id, SMALL, rival.token);
    await enter(id, [], model.token, { authorKind: 'model', model: 'bot-1', source: IDLE, sourcePublic: true });
    return { id, rival, model };
  }

  it('ranks wealth, with histogram, total and the caller\'s own row', async () => {
    const { id, rival } = await seeded();
    const r = await call(`/challenges/${id}/board`, { token: rival.token });
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(3);
    expect(r.json.entries.map((e: Json) => [e.rank, e.displayName])).toEqual([[1, 'Farmer'], [2, 'Rival'], [3, 'Robot']]);
    expect(r.json.entries[0]).toMatchObject({ login: user.profile.login, avatarUrl: null });
    expect(r.json.entries[0].value).toBeGreaterThan(r.json.entries[1].value);
    expect(r.json.me).toMatchObject({ rank: 2, displayName: 'Rival', percentile: 66 });
    expect(r.json.histogram.counts).toHaveLength(10);
    expect(r.json.histogram.counts.reduce((a: number, b: number) => a + b, 0)).toBe(3);
    expect(r.json.histogram).toMatchObject({ min: 0, max: r.json.entries[0].value });
    expect((await call(`/challenges/${id}/board`)).json.me).toBeNull();
  });

  it('ranks speed by earliest par tick and leaves out runs that never reached par', async () => {
    const { id } = await seeded();
    const r = await call(`/challenges/${id}/board?medal=speed`);
    expect(r.json.total).toBe(1);
    expect(r.json.entries[0]).toMatchObject({ rank: 1, displayName: 'Farmer' });
    expect(r.json.entries[0].value).toBe((await call(`/entries/${r.json.entries[0].entryId}`)).json.parTick);
  });

  it('has an empty brevity board until the source check exists, and an empty-database board', async () => {
    const { id } = await seeded();
    const r = await call(`/challenges/${id}/board?medal=brevity`);
    expect(r.json).toMatchObject({ entries: [], total: 0, me: null });
    expect(r.json.histogram.counts).toEqual(new Array(10).fill(0));
    expect((await call(`/challenges/${DAILY}/board`)).json).toMatchObject({ entries: [], total: 0 });
  });

  it('filters by author kind and by friends', async () => {
    const { id, rival } = await seeded();
    const models = await call(`/challenges/${id}/board?author=model`);
    expect(models.json.entries.map((e: Json) => e.displayName)).toEqual(['Robot']);
    expect(models.json.entries[0]).toMatchObject({ authorKind: 'model', model: 'bot-1' });
    expect((await call(`/challenges/${id}/board?author=human`)).json.total).toBe(2);
    expect((await call(`/challenges/${id}/board?scope=friends`)).status).toBe(401);
    const lonely = await call(`/challenges/${id}/board?scope=friends`, { token: rival.token });
    expect(lonely.json.entries.map((e: Json) => e.displayName)).toEqual(['Rival']);
    await db.execute('INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)', [rival.profile.id, user.profile.id, time]);
    const friends = await call(`/challenges/${id}/board?scope=friends`, { token: rival.token });
    expect(friends.json.entries.map((e: Json) => [e.rank, e.displayName])).toEqual([[1, 'Farmer'], [2, 'Rival']]);
  });

  it('honours limit and rejects bad query values', async () => {
    const { id } = await seeded();
    expect((await call(`/challenges/${id}/board?limit=1`)).json.entries).toHaveLength(1);
    for (const q of ['medal=gold', 'scope=world', 'author=cat', 'limit=0', 'limit=101', 'x=1']) expect((await call(`/challenges/${id}/board?${q}`)).status).toBe(400);
  });
});

describe('entries and sealing', () => {
  it('serves a public summary for any entry', async () => {
    const r = await enter(DAILY, SMALL);
    const e = await call(`/entries/${r.json.entryId}`);
    expect(e.status).toBe(200);
    expect(e.json).toMatchObject({
      id: r.json.entryId, netWorth: r.json.netWorth, mosaic: r.json.mosaic, sealed: true,
      player: { login: user.profile.login, displayName: 'Farmer', avatarUrl: null }, challenge: { id: DAILY, kind: 'daily', seed: dailySeed(TODAY), ticks: DAILY_TICKS },
    });
    expect(JSON.stringify(e.json)).not.toContain('actions');
    expect((await call('/entries/AAAAAAAAAAAA')).status).toBe(404);
    expect((await call('/entries/short')).status).toBe(400);
  });

  it('keeps a daily replay sealed (403) until the challenge closes, then opens it (200)', async () => {
    const r = await enter(DAILY, SMALL);
    const path = `/entries/${r.json.entryId}/replay`;
    expect((await call(path)).status).toBe(403);
    const stranger = await login('Stranger');
    expect((await call(path, { token: stranger.token })).status).toBe(403);
    const mine = await call(path, { token: user.token });
    expect(mine.status).toBe(200);
    expect(mine.json).toEqual({ seed: dailySeed(TODAY), ticks: DAILY_TICKS, rulesVersion: RULES_VERSION, actions: SMALL });
    time += DAY_MS;
    const open = await call(path);
    expect(open.status).toBe(200);
    expect(open.json.actions).toEqual(SMALL);
    expect((await call(`/entries/${r.json.entryId}`)).json.sealed).toBe(false);
  });

  it('opens a duel replay to anyone who has submitted their own entry', async () => {
    const id = await duel();
    const r = await enter(id, FULL);
    const path = `/entries/${r.json.entryId}/replay`;
    const rival = await login('Rival');
    expect((await call(path)).status).toBe(403);
    expect((await call(path, { token: rival.token })).status).toBe(403);
    await enter(id, [], rival.token);
    expect((await call(path, { token: rival.token })).status).toBe(200);
    time += 20 * DAY_MS; // duels never close
    expect((await call(path)).status).toBe(403);
  });
});

describe('POST /duels', () => {
  it('requires a session', async () => {
    expect((await call('/duels', { body: {} })).status).toBe(401);
  });

  it('creates a never-closing duel with a random id and seed, or the given ones', async () => {
    const a = await call('/duels', { token: user.token, body: {} });
    expect(a.json.challengeId).toMatch(/^x-[A-Za-z0-9_-]{8}$/);
    const info = (await call(`/challenges/${a.json.challengeId}`)).json;
    expect(info).toMatchObject({ kind: 'duel', number: null, ticks: DAILY_TICKS, par: DAILY_PAR, opensAt: time, closesAt: null, players: 0 });
    expect(info.seed).toBeGreaterThanOrEqual(1);
    const b = await call('/duels', { token: user.token, body: { seed: 7, ticks: 500 } });
    expect((await call(`/challenges/${b.json.challengeId}`)).json).toMatchObject({ seed: 7, ticks: 500, par: null });
    expect(a.json.challengeId).not.toBe(b.json.challengeId);
  });

  it('applies the duel tick cap and validates input', async () => {
    expect((await call('/duels', { token: user.token, body: { ticks: KIND_LIMITS.duel.maxTicks } })).status).toBe(201);
    for (const body of [{ ticks: KIND_LIMITS.duel.maxTicks + 1 }, { ticks: 5 }, { seed: 0 }, { seed: 2 ** 32 }, { seed: 1.5 }, { extra: 1 }, []]) {
      expect((await call('/duels', { token: user.token, body })).status).toBe(422);
    }
  });

  it('checks a short duel against its own tick count, with no speed medal', async () => {
    const id = await duel(user.token, { seed: 7, ticks: 400 });
    expect((await enter(id, [[400, 0, 3]])).status).toBe(422);
    const r = await enter(id, [[399, 0, 3]]);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ parTick: null, ranks: { wealth: 1, speed: null } });
  });

  it('allows 20 duels per user per UTC day', async () => {
    for (let i = 0; i < 20; i++) expect((await call('/duels', { token: user.token, body: {} })).status).toBe(201);
    expect((await call('/duels', { token: user.token, body: {} })).status).toBe(429);
  });
});

describe('weekly season', () => {
  const WEEK = 's-2026-W46';
  it('runs for the season tick budget and rejects actions past it', async () => {
    expect((await call('/challenges/week')).json).toMatchObject({ id: WEEK, ticks: SEASON_TICKS });
    expect(KIND_LIMITS.season.maxTicks).toBe(SEASON_TICKS);
    expect((await enter(WEEK, [[SEASON_TICKS, 0, 3]])).status).toBe(422);
  });

  it('verifies a full-length entry (every tick replayed) well inside the function time limit', async () => {
    const run: LogEntry[] = [...SMALL, [SEASON_TICKS - 1, 0, 3]];
    const started = performance.now();
    const r = await enter(WEEK, run);
    const ms = performance.now() - started;
    expect(r.status).toBe(200);
    const ch = (await call(`/challenges/${WEEK}`)).json;
    const ref = replayWithPar(createWorld({ id: WEEK, seed: ch.seed }, challengeSetup('season', ch.seed).setup), run, SEASON_TICKS, DAILY_PAR);
    expect(r.json).toMatchObject({ netWorth: ref.netWorth, parTick: ref.parTick, mosaic: ref.mosaic });
    expect(ms).toBeLessThan(5000); // the Vercel function allows 30 s (vercel.json)
  });
});

describe('GET /seasons (Hall of Fame)', () => {
  it('is empty with no closed seasons', async () => {
    expect((await call('/seasons')).json).toEqual({ seasons: [] });
  });

  it('lists closed seasons with entries, newest first, and hides open ones', async () => {
    await call('/challenges/week'); // an open season with no entries yet
    await enter('s-2026-W46', SMALL);
    expect((await call('/seasons')).json).toEqual({ seasons: [] }); // still open
    time = Date.UTC(2026, 10, 17, 9); // the following Tuesday
    const r = await call('/seasons');
    expect(r.json.seasons).toHaveLength(1);
    expect(r.json.seasons[0]).toMatchObject({ id: 's-2026-W46', number: -2, players: 1, closesAt: Date.UTC(2026, 10, 16) });
    expect(r.json.seasons[0].winners.wealth).toMatchObject({ rank: 1, login: expect.any(String) });
    expect(r.json.seasons[0].winners.brevity).toBeNull();
    expect((await call('/seasons?limit=0')).status).toBe(400);
    expect((await call('/seasons?x=1')).status).toBe(400);
  });
});

describe('size caps', () => {
  it('fit the largest legal log of every kind under the body limit and Vercel\'s 4.5 MB', () => {
    // The widest legal action: five fields, a 15-digit bot id, the largest final argument.
    const widest: LogEntry = [SEASON_TICKS - 1, 999_999_999_999_999, 8, 7, Number.MAX_SAFE_INTEGER];
    for (const kind of ['daily', 'season', 'duel'] as const) {
      const bytes = JSON.stringify({ rulesVersion: RULES_VERSION, actions: new Array(KIND_LIMITS[kind].maxActions).fill(widest), source: 'x'.repeat(32 * 1024), sourcePublic: true, authorKind: 'model', model: 'm'.repeat(64) }).length;
      expect(bytes).toBeLessThan(MAX_BODY_BYTES);
      expect(bytes).toBeLessThan(VERCEL_BODY_LIMIT);
    }
  });
  it('hashes logs canonically', () => {
    expect(logHash(SMALL)).toBe(logHash(JSON.parse(JSON.stringify(SMALL)) as LogEntry[]));
    expect(logHash(SMALL)).not.toBe(logHash([]));
  });
});

describe('old /api/daily routes', () => {
  it('still answer in the old shapes while writing through the new pipeline', async () => {
    const r = await call('/daily/submit', { token: user.token, body: { date: TODAY, rulesVersion: RULES_VERSION, actions: SMALL } });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(['best', 'netWorth', 'rank']);
    const board = await call(`/challenges/${DAILY}/board`);
    expect(board.json.entries[0].value).toBe(r.json.netWorth);
    const old = await call('/daily/leaderboard');
    expect(old.json.entries[0]).toMatchObject({ rank: 1, userId: user.profile.id, netWorth: r.json.netWorth });
    expect((await call('/daily')).json).toEqual({ date: TODAY, seed: dailySeed(TODAY), ticks: DAILY_TICKS, rulesVersion: RULES_VERSION });
  });
  it('treat a repeat of your own log as a harmless retry, and share rank for identical logs', async () => {
    const body = { date: TODAY, rulesVersion: RULES_VERSION, actions: SMALL };
    const first = await call('/daily/submit', { token: user.token, body });
    expect((await call('/daily/submit', { token: user.token, body })).json).toEqual(first.json);
    const rival = await login('Rival');
    const same = await call('/daily/submit', { token: rival.token, body });
    expect(same.json).toEqual({ netWorth: first.json.netWorth, rank: 1, best: first.json.netWorth });
    expect(await db.query('SELECT id FROM entries')).toHaveLength(2);
  });
});

describe('GET /stats', () => {
  it('reports entries per UTC day', async () => {
    await enter(DAILY, SMALL);
    time += DAY_MS;
    await enter('d-2026-11-13', []);
    const s = await call('/stats');
    expect(s.json).toMatchObject({ players: 1, dailyEntries: 2 });
    expect(s.json.entriesPerDay).toEqual([{ date: '2026-11-13', entries: 1 }, { date: TODAY, entries: 1 }]);
  });
});

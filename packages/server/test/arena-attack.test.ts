import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE_RULES_VERSION } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createApp, createDb, migrate } from '../src/index.ts';
import type { Db, Queryable } from '../src/index.ts';
import { DAY_MS } from '../src/game.ts';
import { board, logHash, recountPlayers } from '../src/arena.ts';
import type { ChallengeRow } from '../src/arena.ts';
import { prune } from '../src/housekeeping.ts';
import { genericCardPng, handleShare } from '../src/share.ts';
import type { SourceVerifier } from '../src/verify-client.ts';

// D2: arena attack review. One test per finding; see brain/notes/D2.md for severity, fix and reasoning.

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Login = { token: string; login: string };
const SMALL: LogEntry[] = [[0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [7, 0, 3], [9, 0, 3], [300, 0, 4], [303, 0, 0, 3], [305, 0, 5], [306, 0, 8, 1, 4]];
const DAY = Date.UTC(2026, 10, 12);

let db: Db;
let app: (request: Request) => Promise<Response>;
let time: number;
let verify: SourceVerifier | undefined;

async function call(path: string, o: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers(o.headers);
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await app(new Request(`http://localhost:8787${path.startsWith('/r/') || path.startsWith('/og/') ? '' : '/api'}${path}`, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }));
  const text = await response.text();
  let json: Json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }
  return { status: response.status, json, headers: response.headers };
}
const login = async (name: string): Promise<Login> => { const r = (await call('/dev/login', { body: { displayName: name } })).json; return { token: r.token as string, login: r.profile.login as string }; };
const enter = (id: string, token: string, actions: unknown = SMALL, extra: Json = {}) => call(`/challenges/${id}/entries`, { token, body: { rulesVersion: BASE_RULES_VERSION, actions, ...extra } });
const make = () => createApp({ db, env: { TENDRIL_DEV_AUTH: '1', PUBLIC_ORIGIN: 'https://tendril.example' }, now: () => time, verifySource: verify });

beforeEach(() => { db = createDb({ url: ':memory:' }); time = DAY + 12 * 3600_000; verify = undefined; app = make(); });
afterEach(() => db.close());

describe('F1 legacy grace must not reopen a challenge whose replays are public', () => {
  it('a closed daily stays sealed while /api/daily/submit still takes yesterday, so a replay cannot be copied', async () => {
    const ann = await login('Ann'), bo = await login('Bo');
    const annEntry = await enter('d-2026-11-12', ann.token);
    expect(annEntry.status).toBe(200);
    time = DAY + DAY_MS + 3600_000; // 01:00 the next day: closed, inside the legacy grace
    const peek = await call(`/entries/${annEntry.json.entryId}/replay`, { token: bo.token });
    const copy = await call('/daily/submit', { token: bo.token, body: { date: '2026-11-12', rulesVersion: BASE_RULES_VERSION, actions: SMALL } });
    // Either answer closes the hole; both together is the bug.
    expect(peek.status === 200 && copy.status === 200).toBe(false);
  });
  it('the replay opens once the grace window has passed', async () => {
    const ann = await login('Ann');
    const annEntry = await enter('d-2026-11-12', ann.token);
    time = DAY + 2 * DAY_MS + 1000;
    expect((await call(`/entries/${annEntry.json.entryId}/replay`)).status).toBe(200);
  });
});

describe('F2 accepting a duel must not force follows again after they were removed', () => {
  it('a challenger who unfollows an accepter stays unfollowed when the accept is repeated', async () => {
    const ann = await login('Ann'), bo = await login('Bo');
    const id = (await call('/duels', { token: ann.token, body: { seed: 7 } })).json.challengeId as string;
    await enter(id, bo.token, []);
    await call(`/duels/${id}/accept`, { token: bo.token, body: {} });
    await call(`/players/${bo.login}/unfollow`, { token: ann.token, body: {} });
    await call(`/duels/${id}/accept`, { token: bo.token, body: {} });
    expect((await call('/me/following', { token: ann.token })).json.players).toEqual([]);
  });
  it('one duel link forces at most a handful of follows onto its challenger', async () => {
    const ann = await login('Ann');
    const id = (await call('/duels', { token: ann.token, body: { seed: 7 } })).json.challengeId as string;
    for (let i = 0; i < 15; i++) {
      const p = await login(`Puppet${i}`);
      await enter(id, p.token, []);
      await call(`/duels/${id}/accept`, { token: p.token, body: {} });
    }
    expect((await call('/me/following', { token: ann.token })).json.players.length).toBeLessThanOrEqual(10);
  });
  it('accepting your own duel, a daily, or without a run is refused', async () => {
    const ann = await login('Ann'), bo = await login('Bo');
    const id = (await call('/duels', { token: ann.token, body: { seed: 7 } })).json.challengeId as string;
    await enter(id, ann.token);
    expect((await call(`/duels/${id}/accept`, { token: ann.token, body: {} })).status).toBe(422);
    expect((await call(`/duels/${id}/accept`, { token: bo.token, body: {} })).status).toBe(409);
    expect((await call(`/duels/${id}/accept`, { body: {} })).status).toBe(401);
    expect((await call('/duels/d-2026-11-12/accept', { token: bo.token, body: {} })).status).toBe(404);
  });
});

describe('F3 the prune keeps the real top 100 of each medal', () => {
  it('entries with a program but no par cannot push a genuine Brevity entry out of retention', async () => {
    await migrate(db);
    const closes = DAY + DAY_MS;
    await db.execute('INSERT INTO challenges (id, kind, number, seed, ticks, par, opens_at, closes_at, created_by, rules_version) VALUES (?, ?, 1, 7, 3000, 100, ?, ?, NULL, ?)', ['d-2026-11-12', 'daily', DAY, closes, BASE_RULES_VERSION]);
    await db.transaction(async (tx: Queryable) => {
      for (let u = 0; u < 150; u++) {
        await tx.execute('INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at) VALUES (?, NULL, ?, ?, NULL, 1)', [`u${u}`, `u${u}`, `P${u}`]);
        // Junk: tiny program, never reaches par, worth 0 .. 149 (outside the top 100 by worth for most).
        await tx.execute(`INSERT INTO entries (id, challenge_id, user_id, net_worth, par_tick, tokens, actions, actions_count, log_hash, mosaic, source, source_public, source_verified, created_at)
          VALUES (?, 'd-2026-11-12', ?, ?, NULL, 1, '[[0,0,0,1]]', 1, ?, 'x', 'x = 1', 0, 1, ?)`, [`junk${u}`.padEnd(12, '_'), `u${u}`, u, `h${u}`, DAY + u]);
      }
      await tx.execute('INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at) VALUES (?, NULL, ?, ?, NULL, 1)', ['real', 'real', 'Real']);
      await tx.execute(`INSERT INTO entries (id, challenge_id, user_id, net_worth, par_tick, tokens, actions, actions_count, log_hash, mosaic, source, source_public, source_verified, created_at)
        VALUES ('real________', 'd-2026-11-12', 'real', 5, 200, 40, '[[0,0,0,1]]', 1, 'hreal', 'x', 'real program', 1, 1, ?)`, [DAY + 999]);
    });
    await prune(db, closes + 3 * DAY_MS);
    const [row] = await db.query<{ actions: string | null; source: string | null }>("SELECT actions, source FROM entries WHERE id = 'real________'");
    expect(row!.actions).not.toBeNull();
    expect(row!.source).not.toBeNull();
  });
  it('never touches an open daily, an open season, or a young duel', async () => {
    await migrate(db);
    for (const [id, kind, closesAt, opensAt] of [['d-2026-11-12', 'daily', DAY + DAY_MS, DAY], ['x-abcdefgh', 'duel', null, DAY - 30 * DAY_MS]] as const) {
      await db.execute('INSERT INTO challenges (id, kind, number, seed, ticks, par, opens_at, closes_at, created_by, rules_version) VALUES (?, ?, 1, 7, 3000, 100, ?, ?, NULL, ?)', [id, kind, opensAt, closesAt, BASE_RULES_VERSION]);
      for (let u = 0; u < 130; u++) {
        await db.execute('INSERT OR IGNORE INTO users (id, github_id, login, display_name, avatar_url, created_at) VALUES (?, NULL, ?, ?, NULL, 1)', [`u${u}`, `u${u}`, `P${u}`]);
        await db.execute(`INSERT INTO entries (id, challenge_id, user_id, net_worth, par_tick, tokens, actions, actions_count, log_hash, mosaic, source, created_at) VALUES (?, ?, ?, ?, NULL, NULL, '[[0,0,0,1]]', 1, ?, 'x', NULL, 1)`, [`${id}${u}`.slice(-12).padStart(12, '_'), id, `u${u}`, u, `${id}${u}`]);
      }
    }
    await prune(db, DAY + 12 * 3600_000);
    const [n] = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM entries WHERE actions IS NULL');
    expect(n!.n).toBe(0);
  });
});

describe('F4 share and og endpoints cannot be turned into a write and render amplifier', () => {
  async function hits(): Promise<number> {
    const [r] = await db.query<{ n: number | null }>("SELECT SUM(hits) AS n FROM share_hits").catch(() => [{ n: 0 }]);
    return Number(r?.n ?? 0);
  }
  it('cache-busting query strings do not each cost a database write', async () => {
    const ann = await login('Ann');
    const entry = (await enter('d-2026-11-12', ann.token)).json.entryId as string;
    for (let i = 0; i < 40; i++) await call(`/og/${entry}.png?cb=${i}`);
    await call(`/r/${entry}`); // flush any lazy table creation
    expect(await hits()).toBeLessThan(5);
  });
  it('unknown ids never write, and the generic card is not re-rendered per request', async () => {
    await migrate(db);
    const ctx = { db, now: time, origin: 'https://t.example', host: 't.example' };
    const a = await handleShare('/og/zzzzzzzzzzzz.png', 'GET', ctx);
    const b = await handleShare('/og/yyyyyyyyyyyy.png', 'GET', ctx);
    expect(Buffer.from(await a!.arrayBuffer()).equals(Buffer.from(await b!.arrayBuffer()))).toBe(true);
    expect(genericCardPng('t.example')).toBe(genericCardPng('t.example')); // rendered once per host
    expect(await hits()).toBe(0);
  });
  it('read-only budget mode stops share hit counting', async () => {
    const ann = await login('Ann');
    const entry = (await enter('d-2026-11-12', ann.token)).json.entryId as string;
    await db.execute("INSERT INTO arena_meta (key, value) VALUES ('guard_mode', 'readonly'), ('guard_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify({ bytes: 0, projectedWrites: 0, checkedAt: time })]);
    app = make();
    const before = await hits();
    for (let i = 0; i < 5; i++) await call(`/r/${entry}`);
    expect(await hits()).toBe(before);
  });
});

describe('F5 follow and unfollow are rate limited', () => {
  it('toggling one follow forever is refused after a day-sized allowance', async () => {
    const ann = await login('Ann'), bo = await login('Bo');
    let refused = 0;
    for (let i = 0; i < 400 && !refused; i++) {
      const r = await call(`/players/${bo.login}/${i % 2 ? 'unfollow' : 'follow'}`, { token: ann.token, body: {} });
      if (r.status === 429) refused = i;
    }
    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThanOrEqual(300);
  });
});

describe('F6 a repeated submission does not pay for a second source check', () => {
  it('the same log and program twice is a 409 and the verify function runs once', async () => {
    let calls = 0;
    verify = async () => { calls++; return { ok: true, tokens: 5, logHash: logHash(SMALL), actions: SMALL.length }; };
    app = make();
    const ann = await login('Ann');
    expect((await enter('d-2026-11-12', ann.token, SMALL, { source: 'x = 1' })).status).toBe(200);
    expect((await enter('d-2026-11-12', ann.token, SMALL, { source: 'x = 1' })).status).toBe(409);
    expect(calls).toBe(1);
  });
});

describe('measure: database work per submission', () => {
  it('stays small and flat', async () => {
    const ann = await login('Ann');
    let reads = 0, writes = 0;
    const count = (sql: string): void => { if (/^\s*(SELECT|WITH)/i.test(sql)) reads++; else writes++; };
    const spy = (q: Queryable): Queryable => ({ query: (s, a) => { count(s); return q.query(s, a); }, execute: (s, a) => { count(s); return q.execute(s, a); } });
    const wrapped: Db = { ...spy(db), transaction: (fn) => db.transaction((tx) => fn(spy(tx))), script: (s) => db.script(s), close: () => db.close() } as Db;
    const counted = createApp({ db: wrapped, env: { TENDRIL_DEV_AUTH: '1' }, now: () => time });
    const send = (actions: unknown) => counted(new Request('http://localhost:8787/api/challenges/d-2026-11-12/entries', { method: 'POST', headers: { Authorization: `Bearer ${ann.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ rulesVersion: BASE_RULES_VERSION, actions }) }));
    await send([]); // warms migration and the challenge row
    reads = writes = 0;
    const r = await send(SMALL);
    expect(r.status).toBe(200);
    console.log(`D2 measure: one new entry = ${reads} statements reading, ${writes} writing`);
    expect(reads).toBeLessThan(40);
    expect(writes).toBeLessThan(15);
  });
});

describe('reviewed and holding: cross-site requests and budget-guard modes', () => {
  it('every mutating arena route refuses a cookie without the client header and any foreign origin', async () => {
    const res = await app(new Request('http://localhost:8787/api/dev/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'Cookie' }) }));
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    const ann = await login('Ann');
    const id = (await call('/duels', { token: ann.token, body: { seed: 7 } })).json.challengeId as string;
    for (const path of ['/duels', `/duels/${id}/accept`, '/challenges/d-2026-11-12/entries', `/players/${ann.login}/follow`, `/players/${ann.login}/unfollow`, '/daily/submit', '/farms', '/auth/logout']) {
      const noHeader = await app(new Request(`http://localhost:8787/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' }));
      expect(noHeader.status, `${path} without header`).toBe(403);
      const foreign = await app(new Request(`http://localhost:8787/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Tendril-Client': '1', Origin: 'https://evil.example' }, body: '{}' }));
      expect(foreign.status, `${path} foreign origin`).toBe(403);
    }
  });
  it('read-only mode refuses every arena write and keeps reads', async () => {
    const ann = await login('Ann'), bo = await login('Bo');
    const id = (await call('/duels', { token: ann.token, body: { seed: 7 } })).json.challengeId as string;
    await db.execute("INSERT INTO arena_meta (key, value) VALUES ('guard_mode', 'readonly'), ('guard_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify({ bytes: 0, projectedWrites: 0, checkedAt: time })]);
    app = make();
    const writes: [string, Json][] = [['/duels', {}], [`/duels/${id}/accept`, {}], ['/challenges/d-2026-11-12/entries', { rulesVersion: BASE_RULES_VERSION, actions: [] }], [`/players/${bo.login}/follow`, {}], ['/daily/submit', {}], ['/farms', {}]];
    for (const [path, body] of writes) expect((await call(path, { token: ann.token, body })).status, path).toBe(503);
    expect((await call(`/duels/${id}`)).status).toBe(200);
    expect((await call('/leaderboard')).status).toBe(200);
  });
  it('tight mode scales the entry allowance down to a quarter', async () => {
    const ann = await login('Ann');
    await db.execute("INSERT INTO arena_meta (key, value) VALUES ('guard_mode', 'tight'), ('guard_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify({ bytes: 0, projectedWrites: 0, checkedAt: time })]);
    app = make();
    let first429 = 0;
    for (let i = 1; i <= 30 && !first429; i++) if ((await enter('d-2026-11-12', ann.token, [])).status === 429) first429 = i;
    expect(first429).toBe(16); // 60 / 4 = 15 allowed
  });
});

describe('F9 an author-filtered board on a big challenge is not a full scan per request', () => {
  async function seed(): Promise<void> {
    await migrate(db);
    await db.execute('INSERT INTO challenges (id, kind, number, seed, ticks, par, opens_at, closes_at, created_by, rules_version) VALUES (?, ?, 1, 7, 3000, 100, ?, ?, NULL, ?)', ['d-2026-11-12', 'daily', DAY, DAY + DAY_MS, BASE_RULES_VERSION]);
    await db.transaction(async (tx: Queryable) => {
      for (let u = 0; u < 60; u++) {
        await tx.execute('INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at) VALUES (?, NULL, ?, ?, NULL, 1)', [`u${u}`, `u${u}`, `P${u}`]);
        await tx.execute(`INSERT INTO entries (id, challenge_id, user_id, net_worth, par_tick, tokens, actions, actions_count, log_hash, mosaic, source, author_kind, model, created_at)
          VALUES (?, 'd-2026-11-12', ?, ?, NULL, NULL, '[[0,0,0,1]]', 1, ?, 'x', NULL, ?, ?, ?)`, [`e${u}`.padEnd(12, '_'), `u${u}`, 1000 - u, `h${u}`, u % 3 === 0 ? 'model' : 'human', u % 3 === 0 ? 'm' : null, DAY + u]);
      }
    });
    await recountPlayers(db, 'd-2026-11-12');
  }
  it('answers like the full computation, then serves repeats and other limits from the stored result', async () => {
    await seed();
    const [c] = await db.query<ChallengeRow>("SELECT * FROM challenges WHERE id = 'd-2026-11-12'");
    const exact = await board(db, c!, { medal: 'wealth', friends: false, author: 'model', limit: 5, viewerId: 'u3', now: time });
    let statements = 0;
    const counted = { query: (s: string, a?: any[]) => { statements++; return db.query(s, a); }, execute: db.execute.bind(db), transaction: db.transaction.bind(db), script: db.script.bind(db), close: db.close.bind(db) } as unknown as Db; // eslint-disable-line @typescript-eslint/no-explicit-any
    const first = await board(counted, c!, { medal: 'wealth', friends: false, author: 'model', limit: 5, viewerId: 'u3', now: time, fullMax: 10 });
    expect(first.entries).toEqual(exact.entries);
    expect(first.total).toBe(exact.total);
    expect(first.me).toEqual(exact.me);
    statements = 0;
    const again = await board(counted, c!, { medal: 'wealth', friends: false, author: 'model', limit: 7, viewerId: 'u6', now: time + 1000, fullMax: 10 });
    expect(statements).toBeLessThanOrEqual(3);
    expect(again.entries.slice(0, 5)).toEqual(exact.entries);
    expect(again.me?.rank).toBe(3);
  });
});

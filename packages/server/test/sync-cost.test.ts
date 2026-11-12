import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, createDb } from '../src/index.ts';
import type { Db } from '../src/index.ts';
import { PENDING_MAX_AGE_MS, RANK_CAP, SAMPLE_EVERY_MS, SLOW_REFRESH_MS, SYNC_TAIL_MS, syncIntervalMs } from '../src/game.ts';
import { projectedMonthlyWrites, syncScale } from '../src/housekeeping.ts';

// Cost model for Endless sync (brain/notes/COST.md): rows written and read per verified chunk.

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const BASE = Date.UTC(2026, 10, 12, 12, 0, 0);
let db: Db;
let app: (request: Request) => Promise<Response>;
let time: number;
let token: string;
let farm: Json;

async function call(path: string, o: { token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await app(new Request(`http://localhost:8787/api${path}`, { method: o.body !== undefined ? 'POST' : 'GET', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }));
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : null) as Json };
}
const totalChanges = async (): Promise<number> => Number((await db.query<{ n: number }>('SELECT total_changes() AS n'))[0]!.n);

/** Advances the clock by `ms`, then syncs everything up to the tick the clock allows. */
async function sync(ms: number) {
  time += ms;
  const current = (await call('/farms/me', { token })).json;
  const toTick = Math.floor((time - current.startedAtMs) / 100);
  const r = await call(`/farms/${current.id}/chunks`, { token, body: { fromTick: current.tick, toTick, actions: [], rulesVersion: current.rulesVersion, checkpointHash: current.checkpointHash } });
  expect(r.status).toBe(200);
  return r.json;
}

async function addRivals(count: number, worth: (i: number) => number): Promise<void> {
  await db.transaction(async (tx) => {
    for (let i = 0; i < count; i++) {
      await tx.execute('INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at) VALUES (?, NULL, ?, ?, NULL, 1)', [`r${i}`, `r${i}`, `r${i}`]);
      await tx.execute(
        `INSERT INTO farms (id, user_id, seed, started_at, tick, checkpoint, checkpoint_hash, rules_version, coins, net_worth, verified_at, sampled_at)
         VALUES (?, ?, 1, 1, 1, '', '', 1, 0, ?, 5, 5)`, [`rf${i}`, `r${i}`, worth(i)]);
    }
  });
}

beforeEach(async () => {
  time = BASE;
  db = createDb({ url: ':memory:' });
  app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1', PUBLIC_ORIGIN: 'https://tendril.example' }, now: () => time });
  token = (await call('/dev/login', { body: { displayName: 'Farmer' } })).json.token;
  farm = (await call('/farms', { token, body: {} })).json;
});
afterEach(() => db.close());

describe('Endless sync writes', () => {
  it('writes exactly one row on a steady-state sync', async () => {
    await sync(20_000); // first sync: also takes the first rank/growth refresh
    const before = await totalChanges();
    await sync(15_000);
    expect((await totalChanges()) - before).toBe(1);
    expect(await db.query('SELECT * FROM chunks')).toHaveLength(0);
    expect(await db.query('SELECT * FROM worth_history')).toHaveLength(1);
  });

  it('flushes the buffered log into one chunk row per 10 minutes and still serves a gapless replay', async () => {
    for (let i = 0; i < 4; i++) await sync(15_000);
    expect(await db.query('SELECT * FROM chunks')).toHaveLength(0);
    await sync(PENDING_MAX_AGE_MS);
    const flushed = await db.query<{ from_tick: number; to_tick: number }>('SELECT from_tick, to_tick FROM chunks');
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.from_tick).toBe(0);
    expect((await db.query('SELECT * FROM farms WHERE pending_from IS NOT NULL'))).toHaveLength(0);
    await sync(15_000);
    const replay = (await call(`/farms/${farm.id}/replay?limit=2`)).json;
    expect(replay.chunks.map((c: Json) => [c.fromTick, c.toTick])).toEqual([[0, flushed[0]!.to_tick], [flushed[0]!.to_tick, (await call('/farms/me', { token })).json.tick]]);
    expect(replay.nextFromTick).toBeNull();
  });

  it('takes a worth sample at most every 30 minutes and refreshes rank and growth every 5', async () => {
    await sync(20_000);
    for (let i = 0; i < 10; i++) await sync(60_000);
    expect(await db.query('SELECT * FROM worth_history')).toHaveLength(1); // creation only, 11 minutes in
    await sync(SAMPLE_EVERY_MS);
    expect(await db.query('SELECT * FROM worth_history')).toHaveLength(2);
    const slow = (await db.query<{ slow_at: number }>('SELECT slow_at FROM farms'))[0]!.slow_at;
    await sync(SLOW_REFRESH_MS - 1000);
    expect((await db.query<{ slow_at: number }>('SELECT slow_at FROM farms'))[0]!.slow_at).toBe(slow);
    await sync(1000);
    expect((await db.query<{ slow_at: number }>('SELECT slow_at FROM farms'))[0]!.slow_at).toBe(time);
  });

  it('keeps counting attempts in the farm row: a refused attempt is free, a failed one costs one write', async () => {
    const bad = { fromTick: 0, toTick: 100, actions: [], rulesVersion: 99, checkpointHash: farm.checkpointHash };
    const before = await totalChanges();
    expect((await call(`/farms/${farm.id}/chunks`, { token, body: bad })).status).toBe(409);
    expect((await totalChanges()) - before).toBe(1);
    expect((await db.query<{ att_n: number }>('SELECT att_n FROM farms'))[0]!.att_n).toBe(1);
  });
});

describe('sync cadence and rank', () => {
  it('asks the tail for 180 s, then 15 s once the farm is inside the top 25', async () => {
    await addRivals(RANK_CAP + 100, (i) => 1_000_000 + i); // all ahead of a farm worth 0
    const first = await sync(20_000);
    expect(first.rank).toBeNull();
    expect(first.nextSyncMs).toBe(SYNC_TAIL_MS);
    await db.execute('UPDATE farms SET net_worth = -1 WHERE id LIKE ?', ['rf%']);
    await db.execute('UPDATE farms SET net_worth = 1000000 WHERE id IN (?, ?, ?)', ['rf1', 'rf2', 'rf3']);
    const now = await sync(SLOW_REFRESH_MS); // the cached rank is refreshed after 5 minutes
    expect(now.rank).toBe(4);
    expect(now.nextSyncMs).toBe(15_000);
  });

  it('computes an exact rank when it is inside the cap, with ties going to the earlier verification', async () => {
    await addRivals(30, () => 10); // all ahead of a farm worth 0
        const r = await sync(20_000);
    expect(r.rank).toBe(31);
    expect(r.nextSyncMs).toBe(60_000);
  });

  it('reads the leaderboards through their indexes', async () => {
    const plan = async (sql: string) => (await db.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)).map((r) => r.detail).join(' | ');
    expect(await plan('SELECT * FROM farms f WHERE f.verified_at IS NOT NULL ORDER BY f.growth DESC, f.verified_at ASC, f.id ASC LIMIT 10')).toContain('farms_growth');
    expect(await plan('SELECT * FROM farms f WHERE f.verified_at IS NOT NULL ORDER BY f.net_worth DESC, f.verified_at ASC, f.id ASC LIMIT 10')).toContain('farms_ranked');
  });

  it('stretches the hint when the budget guard tightens', () => {
    expect(syncIntervalMs(1)).toBe(15_000);
    expect(syncIntervalMs(1, syncScale('lean'))).toBe(30_000);
    expect(syncIntervalMs(1, syncScale('tight'))).toBe(60_000);
    expect(syncIntervalMs(null)).toBe(SYNC_TAIL_MS);
  });
});

describe('write projection', () => {
  it('projects from who is syncing and how often their rank earns, not from stored chunk rows', async () => {
    expect(await projectedMonthlyWrites(db, time)).toBe(0);
    await sync(20_000); // rank 1: the 15 s tier
    const month = 30 * 86_400_000;
    expect(await projectedMonthlyWrites(db, time)).toBe(Math.round((month / 15_000) * 1.1));
    time += 10 * 60_000; // nobody synced in the last 5 minutes
    expect(await projectedMonthlyWrites(db, time)).toBe(0);
  });
});

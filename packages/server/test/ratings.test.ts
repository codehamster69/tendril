import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALGO_VERSION, PLACEMENT_EVENTS, START_RATING, rateContest } from '@tendril/rating/src/index.ts';
import { createApp, createDb, migrate } from '../src/index.ts';
import type { Db } from '../src/index.ts';
import { resetLegacyGrace } from '../src/arena.ts';
import { DAY_MS } from '../src/game.ts';
import { LOCK_KEY, LOCK_TTL_MS, MIN_ACCOUNT_AGE_MS, normalizeSource, rateDue, recomputeRatings } from '../src/ratings.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DEC7 = Date.UTC(2026, 11, 7); // a daily (d-2026-12-06) and a season (s-2026-W49) close at this instant
const OLD = Date.UTC(2020, 0, 1);
const NOW = DEC7 + 3 * DAY_MS;

let db: Db;
beforeEach(async () => { seq = 0; resetLegacyGrace(); db = createDb({ url: ':memory:' }); await migrate(db); });
afterEach(() => db.close());

const uid = (i: number): string => `u${String(i).padStart(2, '0')}`;
async function users(n: number, github: (i: number) => number | null = () => OLD): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    await db.execute('INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at, github_created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)', [uid(i), 1000 + i, `player${i}`, `player${i}`, OLD, github(i)]);
    ids.push(uid(i));
  }
  return ids;
}
async function challenge(id: string, kind: 'daily' | 'season', closesAt: number): Promise<void> {
  await db.execute('INSERT INTO challenges (id, kind, number, seed, ticks, par, opens_at, closes_at, created_by, rules_version, setup_v) VALUES (?, ?, 1, 7, 3000, 100, ?, ?, NULL, 3, 0)',
    [id, kind, closesAt - (kind === 'daily' ? 1 : 7) * DAY_MS, closesAt]);
}
interface E { c: string; u: string; net: number; par?: number | null; tokens?: number | null; hash?: string; kind?: 'human' | 'model'; source?: string | null; at?: number }
let seq = 0;
async function entry(e: E): Promise<void> {
  const id = `e${++seq}`;
  await db.execute(
    'INSERT INTO entries (id, challenge_id, user_id, net_worth, par_tick, tokens, actions_count, log_hash, source, author_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
    [id, e.c, e.u, e.net, e.par === undefined ? 100 : e.par, e.tokens ?? null, e.hash ?? `h-${id}`, e.source ?? null, e.kind ?? 'human', e.at ?? seq]);
}
/** Player i finishes i-th: a strictly decreasing net worth. */
async function field(c: string, ids: string[], reverse = false): Promise<void> {
  for (let i = 0; i < ids.length; i++) await entry({ c, u: ids[i]!, net: reverse ? 5000 + i * 10 : 10000 - i * 10, par: 100 + i, tokens: 50 + i });
}
const profile = async (u: string): Promise<Json | null> => { const [r] = await db.query<{ data: string }>('SELECT data FROM rating_profiles WHERE user_id = ?', [u]); return r ? JSON.parse(r.data) : null; };
const contestRows = (): Promise<Json[]> => db.query('SELECT challenge_id, discipline, field_size, summary FROM rating_contests ORDER BY challenge_id, discipline');
async function snapshot(): Promise<string> {
  return JSON.stringify([await db.query('SELECT * FROM rating_profiles ORDER BY user_id'), await db.query('SELECT * FROM rating_contests ORDER BY challenge_id, discipline'),
    await db.query("SELECT * FROM arena_meta WHERE key = 'rating_through'")]);
}

describe('closing order', () => {
  it('rates a daily before a season that closes at the same instant, carrying ratings across', async () => {
    const ids = await users(12);
    await challenge('d-2026-12-06', 'daily', DEC7);
    await challenge('s-2026-W49', 'season', DEC7);
    await field('s-2026-W49', ids, true); // inserted first, and the better season order is the reverse of the daily's
    await field('d-2026-12-06', ids);

    const run = await rateDue(db, {}, NOW);
    expect(run.ran).toBe(true);
    expect(run.contests.map((c) => c.challengeId)).toEqual(['d-2026-12-06', 's-2026-W49']);

    // The same two contests by hand through the engine, daily then season.
    const place = (i: number): number => i + 1;
    const daily = rateContest({ standings: ids.map((id, i) => ({ id, place: place(i), rating: START_RATING, events: 0 })), weight: 1, algoVersion: ALGO_VERSION });
    const after = new Map(daily.map((d) => [d.id, d.rating]));
    const season = rateContest({ standings: ids.map((id, i) => ({ id, place: ids.length - i, rating: after.get(id)!, events: 1 })), weight: 1.5, algoVersion: ALGO_VERSION });
    for (const s of season) {
      const p = (await profile(s.id))!.d.overall;
      expect(p.h.map((h: Json) => h.c)).toEqual(['d-2026-12-06', 's-2026-W49']);
      expect(p.h[1].b).toBe(p.h[0].r); // the season starts where the daily ended
      expect(p.h[0].r).toBe(after.get(s.id));
      expect(p.r).toBe(s.rating);
      expect(p.n).toBe(2);
    }
    expect((await contestRows()).filter((r) => r.discipline === 'overall').map((r) => r.field_size)).toEqual([12, 12]);
  });

  it('waits for an unsettled daily (legacy alias grace) and never rates the season ahead of it', async () => {
    const ids = await users(10);
    await challenge('d-2026-12-06', 'daily', DEC7);
    await challenge('s-2026-W49', 'season', DEC7);
    await field('d-2026-12-06', ids); await field('s-2026-W49', ids);
    const early = await rateDue(db, {}, DEC7 + 60_000);
    expect(early).toMatchObject({ ran: false });
    expect(await db.query('SELECT 1 FROM rating_contests')).toHaveLength(0);
    expect((await rateDue(db, {}, DEC7 + DAY_MS + 1)).contests).toHaveLength(2);
  });

  it('does not rate an open challenge, an empty one, or the same contest twice', async () => {
    const ids = await users(9);
    await challenge('d-2026-12-06', 'daily', DEC7);
    await challenge('d-2026-12-07', 'daily', DEC7 + DAY_MS);
    await challenge('d-2026-12-05', 'daily', DEC7 - DAY_MS); // closed, no entries
    await field('d-2026-12-06', ids); await field('d-2026-12-07', ids);
    const first = await rateDue(db, {}, DEC7 + DAY_MS + 60_000); // d-12-07 is still open
    expect(first.contests.map((c) => c.challengeId)).toEqual(['d-2026-12-06']);
    expect((await rateDue(db, {}, DEC7 + DAY_MS + 120_000)).reason).toBe('none');
    expect(await db.query("SELECT 1 FROM rating_contests WHERE challenge_id = 'd-2026-12-05'")).toHaveLength(0);
  });
});

describe('the lock', () => {
  async function seeded(): Promise<void> {
    const ids = await users(12);
    await challenge('d-2026-12-06', 'daily', DEC7);
    await challenge('s-2026-W49', 'season', DEC7);
    await field('d-2026-12-06', ids); await field('s-2026-W49', ids, true);
  }

  it('two simultaneous requests rate each contest exactly once, with the same result as one request', async () => {
    await seeded();
    const [a, b] = await Promise.all([rateDue(db, {}, NOW), rateDue(db, {}, NOW)]);
    expect([a, b].filter((r) => r.contests.length > 0)).toHaveLength(1);
    expect([a, b].map((r) => r.reason ?? 'ran').sort()).toEqual(expect.arrayContaining(['ran']));
    expect(await db.query('SELECT 1 FROM rating_contests')).toHaveLength(6);
    expect((await profile(uid(0)))!.d.overall.n).toBe(2);
    expect(await db.query(`SELECT 1 FROM arena_meta WHERE key = '${LOCK_KEY}'`)).toHaveLength(0); // released
    const concurrent = await snapshot();

    // The same data rated by a single caller on a fresh database is identical.
    db.close(); db = createDb({ url: ':memory:' }); await migrate(db); seq = 0; await seeded();
    await rateDue(db, {}, NOW);
    expect(await snapshot()).toBe(concurrent);
  });

  it('a held lock blocks the run; an expired one is taken over; the contest marker makes a stale overlap harmless', async () => {
    await seeded();
    await db.execute('INSERT INTO arena_meta (key, value) VALUES (?, ?)', [LOCK_KEY, `${NOW - 1000}:other`]);
    expect(await rateDue(db, {}, NOW)).toMatchObject({ ran: false, reason: 'locked' });
    expect(await db.query('SELECT 1 FROM rating_contests')).toHaveLength(0);
    await db.execute('UPDATE arena_meta SET value = ? WHERE key = ?', [`${NOW - LOCK_TTL_MS - 1}:other`, LOCK_KEY]);
    expect((await rateDue(db, {}, NOW)).contests).toHaveLength(2);
  });

  it('pauses when the budget guard says so and catches up later', async () => {
    await seeded();
    expect(await rateDue(db, {}, NOW, { canWrite: async () => false })).toMatchObject({ ran: false, reason: 'paused' });
    expect(await db.query('SELECT 1 FROM rating_contests')).toHaveLength(0);
    expect((await rateDue(db, {}, NOW, { canWrite: async () => true })).contests).toHaveLength(2);
  });

  it('respects TENDRIL_RATING_FROM and TENDRIL_RATING=off', async () => {
    await seeded();
    expect((await rateDue(db, { TENDRIL_RATING: 'off' }, NOW)).reason).toBe('off');
    expect((await rateDue(db, { TENDRIL_RATING_FROM: '2026-12-07' }, NOW)).contests).toHaveLength(0); // both close exactly at the gate
    expect((await rateDue(db, { TENDRIL_RATING_FROM: '2026-12-06' }, NOW)).contests).toHaveLength(2);
  });
});

describe('who is rated', () => {
  const rateOne = async (): Promise<void> => { await rateDue(db, {}, NOW); };

  it('leaves a field under 8 unrated, and records the contest so it is not retried', async () => {
    const ids = await users(7);
    await challenge('d-2026-12-06', 'daily', DEC7);
    await field('d-2026-12-06', ids);
    const run = await rateDue(db, {}, NOW);
    expect(run.contests).toHaveLength(1);
    expect(run.contests[0]).toMatchObject({ rated: { overall: false, speed: false, brevity: false }, participants: 0, profileWrites: 0 });
    expect(await db.query('SELECT 1 FROM rating_profiles')).toHaveLength(0);
    expect(JSON.parse((await contestRows())[0]!.summary)).toMatchObject({ rated: false, standings: 7 });
    expect((await rateDue(db, {}, NOW + 1)).reason).toBe('none');
  });

  it('rates exactly 8 and counts players, not entries', async () => {
    const ids = await users(8);
    await challenge('d-2026-12-06', 'daily', DEC7);
    await field('d-2026-12-06', ids);
    await entry({ c: 'd-2026-12-06', u: ids[7]!, net: 1 }); // a worse second entry from the same player
    await rateOne();
    expect((await profile(ids[7]!))!.d.overall.n).toBe(1);
    expect((await contestRows())[0]!.field_size).toBe(8);
  });

  it('leaves a below-par entry unrated and out of the field', async () => {
    const ids = await users(9);
    await challenge('d-2026-12-06', 'daily', DEC7);
    await field('d-2026-12-06', ids.slice(0, 8));
    await entry({ c: 'd-2026-12-06', u: ids[8]!, net: 99999, par: null }); // the best score of the day, but below par
    await rateOne();
    expect(await profile(ids[8]!)).toBeNull();
    const p = (await profile(ids[0]!))!.d.overall.h[0];
    expect(p).toMatchObject({ p: 1, f: 8 }); // a below-par entry does not take first place or a seat in the field
    // Eight par entries are rated; the same day with only seven is not.
    expect(JSON.parse((await contestRows())[0]!.summary)).toMatchObject({ rated: true, excluded: { belowPar: 1 } });
  });

  it('a field of 7 par players plus one below par stays unrated', async () => {
    const ids = await users(8);
    await challenge('d-2026-12-06', 'daily', DEC7);
    await field('d-2026-12-06', ids.slice(0, 7));
    await entry({ c: 'd-2026-12-06', u: ids[7]!, net: 20000, par: null });
    await rateOne();
    expect(await db.query('SELECT 1 FROM rating_profiles')).toHaveLength(0);
  });

  it('leaves a young GitHub account unrated, with the 14-day edge inclusive, and an unknown date unrated', async () => {
    const ids = await users(11, (i) => (i === 8 ? DEC7 - MIN_ACCOUNT_AGE_MS + 1 : i === 9 ? DEC7 - MIN_ACCOUNT_AGE_MS : i === 10 ? null : OLD));
    await challenge('d-2026-12-06', 'daily', DEC7);
    await field('d-2026-12-06', ids);
    await rateOne();
    expect(await profile(ids[8]!)).toBeNull(); // 13 days 23:59:59.999
    expect(await profile(ids[10]!)).toBeNull(); // dev login / never signed in since the migration
    expect(await profile(ids[9]!)).not.toBeNull(); // exactly 14 days
    expect((await profile(ids[0]!))!.d.overall.h[0].f).toBe(9);
    expect(JSON.parse((await contestRows())[0]!.summary).excluded.account).toBe(2);
  });

  it('padding a small real field with young accounts does not raise the field-size weight', async () => {
    const real = await users(8);
    await challenge('d-2026-12-06', 'daily', DEC7);
    await field('d-2026-12-06', real);
    for (let i = 8; i < 60; i++) {
      await db.execute('INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at, github_created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)', [uid(i), 1000 + i, `fake${i}`, `fake${i}`, OLD, DEC7 - DAY_MS]);
      await entry({ c: 'd-2026-12-06', u: uid(i), net: 1000 + i });
    }
    await rateOne();
    const [row] = (await contestRows());
    expect(row!.field_size).toBe(8);
    const alone = rateContest({ standings: real.map((id, i) => ({ id, place: i + 1, rating: START_RATING, events: 0 })), weight: 1, algoVersion: ALGO_VERSION });
    expect((await profile(real[0]!))!.d.overall.h[0].d).toBe(alone.find((a) => a.id === real[0])!.delta);
  });

  it('excludes declared models, identical logs from a second player, and a copy with cosmetic edits', async () => {
    const ids = await users(14);
    await challenge('d-2026-12-06', 'daily', DEC7);
    const src = 'plant(1)  # first\nif x > 2:\n    water(x)\n';
    const copy = '# my own\nplant(1)\nif x > 2:\n        water(x)   # spaced out\n';
    expect(normalizeSource(src)).toBe(normalizeSource(copy));
    expect(normalizeSource(src)).not.toBe(normalizeSource(src.replace('water', 'weed')));
    for (let i = 0; i < 9; i++) await entry({ c: 'd-2026-12-06', u: ids[i]!, net: 10000 - i * 10, par: 100 + i, source: i === 0 ? src : null, at: 10 + i });
    await entry({ c: 'd-2026-12-06', u: ids[9]!, net: 10000 - 55, par: 120, hash: 'h-shared', at: 30 });
    await entry({ c: 'd-2026-12-06', u: ids[10]!, net: 10000 - 56, par: 121, hash: 'h-shared', at: 31 }); // same log, later: out
    await entry({ c: 'd-2026-12-06', u: ids[11]!, net: 10000 - 57, par: 122, source: copy, at: 32 }); // same program as player 0, different log: out
    await entry({ c: 'd-2026-12-06', u: ids[12]!, net: 20000, par: 50, kind: 'model' }); // ghost: not in the human field
    await rateOne();
    for (const out of [10, 11, 12, 13]) expect(await profile(ids[out]!)).toBeNull();
    expect(await profile(ids[9]!)).not.toBeNull(); // the first submitter of the shared log keeps the place
    expect((await profile(ids[0]!))!.d.overall.h[0]).toMatchObject({ p: 1, f: 10 });
    expect(JSON.parse((await contestRows()).find((r) => r.discipline === 'overall')!.summary)).toMatchObject({ excluded: { dupLog: 1, dupSource: 1 }, dupSource: [ids[11]] });
  });

  it('rates Speed and Brevity on their own boards; Brevity needs a counted program', async () => {
    const ids = await users(10);
    await challenge('d-2026-12-06', 'daily', DEC7);
    for (let i = 0; i < 10; i++) await entry({ c: 'd-2026-12-06', u: ids[i]!, net: 10000 + i, par: 100 + i, tokens: i < 8 ? 100 - i : null }); // best net worth is the LAST player
    await rateOne();
    const p0 = (await profile(ids[0]!))!, p9 = (await profile(ids[9]!))!;
    expect(p0.d.overall.h[0].p).toBe(10);
    expect(p0.d.speed.h[0].p).toBe(1);
    expect(p0.d.brevity.h[0]).toMatchObject({ p: 8, f: 8 }); // most tokens of the 8 counted programs
    expect((await profile(ids[7]!))!.d.brevity.h[0].p).toBe(1);
    expect(p9.d.brevity).toBeUndefined(); // no program: no Brevity
    expect(p9.d.speed.h[0].p).toBe(10);
  });
});

describe('writes and bookkeeping', () => {
  it('writes one profile row per participant per contest, plus four bookkeeping rows', async () => {
    const ids = await users(40);
    await challenge('d-2026-12-06', 'daily', DEC7);
    await field('d-2026-12-06', ids);
    const run = await rateDue(db, {}, NOW);
    expect(run.contests[0]).toMatchObject({ participants: 40, profileWrites: 40, bookkeepingWrites: 4, writes: 44 });
    expect(run.lockWrites).toBe(2);
    expect(await db.query('SELECT 1 FROM rating_profiles')).toHaveLength(40);
    // A second contest rewrites those same 40 rows (still one write each).
    await challenge('d-2026-12-07', 'daily', DEC7 + DAY_MS);
    await field('d-2026-12-07', ids, true);
    expect((await rateDue(db, {}, NOW)).contests[0]).toMatchObject({ profileWrites: 40, writes: 44 });
    expect((await profile(ids[0]!))!.d.overall.h).toHaveLength(2);
  });
});

describe('recompute', () => {
  it('rebuilds byte-identical ratings from stored standings, even after the programs are pruned', async () => {
    const ids = await users(12);
    await challenge('d-2026-12-05', 'daily', DEC7 - DAY_MS);
    await challenge('d-2026-12-06', 'daily', DEC7);
    await challenge('s-2026-W49', 'season', DEC7);
    const src = 'plant(1)\nwater(2)\n';
    for (const c of ['d-2026-12-05', 'd-2026-12-06', 's-2026-W49']) {
      await field(c, ids, c === 's-2026-W49');
      await entry({ c, u: 'u00', net: 1, par: 100, source: src, at: 1 }); // u00's first entry carries the program...
    }
    await db.execute("UPDATE entries SET source = ? WHERE challenge_id = 'd-2026-12-06' AND user_id = 'u03'", ['plant(1)   # same\nwater(2)\n']); // ...u03 later submits the same one
    await db.execute("UPDATE entries SET source = ? WHERE challenge_id = 'd-2026-12-06' AND user_id = 'u00'", [src]);
    await rateDue(db, {}, NOW - DAY_MS);
    await rateDue(db, {}, NOW);
    const live = await snapshot();
    expect(JSON.parse(live)[1]).toHaveLength(9);
    expect((await profile('u00'))!.d.overall.h).toHaveLength(3);

    await db.execute('UPDATE entries SET source = NULL, actions = NULL'); // housekeeping prunes the program text after a few days
    const result = await recomputeRatings(db, {}, NOW + 10 * DAY_MS);
    expect(result.contests).toBe(3);
    expect(await snapshot()).toBe(live);
    expect(await db.query("SELECT 1 FROM arena_meta WHERE key IN ('rating_lock', 'rating_recompute')")).toHaveLength(0);
    // Running it again changes nothing.
    await recomputeRatings(db, {}, NOW + 11 * DAY_MS);
    expect(await snapshot()).toBe(live);
  });

  it('refuses an algorithm version this build does not implement, and a held lock', async () => {
    await expect(recomputeRatings(db, {}, NOW, ALGO_VERSION + 1)).rejects.toThrow(/algorithm version/);
    await db.execute('INSERT INTO arena_meta (key, value) VALUES (?, ?)', [LOCK_KEY, `${NOW}:x`]);
    await expect(recomputeRatings(db, {}, NOW)).rejects.toThrow(/lock/);
  });
});

// ---- HTTP ----

describe('routes', () => {
  let app: (request: Request) => Promise<Response>;
  let time: number;
  let token: string;
  async function call(path: string, auth?: string): Promise<{ status: number; json: Json }> {
    const res = await app(new Request(`http://localhost:8787/api${path}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} }));
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  beforeEach(async () => {
    time = DEC7 + 10 * DAY_MS;
    app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1' }, setupVersion: 0, now: () => time });
    const login = await app(new Request('http://localhost:8787/api/dev/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'Alice' }) }));
    const body = await login.json() as { token: string; profile: { id: string } };
    token = body.token;
    await db.execute('UPDATE users SET github_created_at = ? WHERE id = ?', [OLD, body.profile.id]);
    await users(8); // the other seats in the field
    // Six closed dailies. Alice (id from dev login) is added to each field and finishes first.
    for (let d = 0; d < 6; d++) {
      const id = `d-2026-12-0${d + 1}`;
      await challenge(id, 'daily', Date.UTC(2026, 11, d + 2));
      await field(id, [...Array(8).keys()].map(uid));
      await entry({ c: id, u: body.profile.id, net: 99999, par: 90, tokens: 10 });
    }
  });

  it('rates lazily on the first request after the close and serves the player page, ladder and boards', async () => {
    expect(await db.query('SELECT 1 FROM rating_contests')).toHaveLength(0);
    expect((await call('/players/Alice')).status).toBe(200);
    expect(await db.query('SELECT 1 FROM rating_contests')).toHaveLength(12); // four contests per request; the backlog drains on the next
    const page = await call('/players/Alice');
    expect(await db.query('SELECT 1 FROM rating_contests')).toHaveLength(18);
    const r = page.json.rating;
    expect(r.speed.events).toBe(6);
    expect(r.overall).toMatchObject({ events: 6, provisional: false, rank: 1, percentile: 100, tier: { key: expect.any(String), name: expect.any(String) } });
    expect(r.overall.rating).toBeGreaterThan(START_RATING);
    expect(r.overall.history).toHaveLength(6);
    expect(r.overall.history[0]).toMatchObject({ challengeId: 'd-2026-12-01', kind: 'daily', place: 1, field: 9, before: START_RATING });
    expect((await call('/players/player0')).json.rating.overall).toMatchObject({ events: 6, rank: expect.any(Number) });

    const board = await call('/ratings/board?discipline=overall&limit=4');
    expect(board.json.entries.map((e: Json) => e.rank)).toEqual([1, 2, 3, 4]);
    expect(board.json.entries[0]).toMatchObject({ login: 'Alice', events: 6 });
    expect(board.json.nextCursor).toEqual(expect.any(String));
    const next = await call(`/ratings/board?limit=4&cursor=${board.json.nextCursor}`);
    expect(next.json.entries.map((e: Json) => e.rank)).toEqual([5, 6, 7, 8]);
    const last = await call(`/ratings/board?limit=4&cursor=${next.json.nextCursor}`);
    expect(last.json.entries.map((e: Json) => e.rank)).toEqual([9]);
    expect(last.json.nextCursor).toBeNull();
    expect((await call('/ratings/board?discipline=nope')).status).toBe(400);
    expect((await call('/ratings/board?cursor=junk')).status).toBe(400);

    // Inactive players leave the ladder but keep their rating.
    time += 40 * DAY_MS;
    expect((await call('/ratings/board')).json.entries).toEqual([]);
    expect((await call('/players/Alice')).json.rating.overall).toMatchObject({ rank: null, events: 6 });

    expect((await call('/ratings/models')).json).toEqual({ models: [] });
  });

  it('gives closed boards tier and delta per row, and open boards none', async () => {
    const closed = await call('/challenges/d-2026-12-03/board');
    expect(closed.status).toBe(200);
    expect(closed.json.entries[0]).toMatchObject({ login: 'Alice', delta: expect.any(Number), rating: expect.any(Number), tier: { key: expect.any(String), name: expect.any(String) } });
    expect(closed.json.entries[0].delta).toBeGreaterThan(0);
    const speed = await call('/challenges/d-2026-12-03/board?medal=speed');
    expect(speed.json.entries[0]).toMatchObject({ login: 'Alice', delta: expect.any(Number) });
    const withMe = await call('/challenges/d-2026-12-03/board', token);
    expect(withMe.json.me).toMatchObject({ login: 'Alice', delta: closed.json.entries[0].delta });
  });

  it('answers the morning card once per contest, signed-in only', async () => {
    expect((await call('/ratings/me/latest')).status).toBe(401);
    const first = await call('/ratings/me/latest', token);
    expect(first.json.latest).toMatchObject({ challengeId: 'd-2026-12-06', kind: 'daily', overall: { place: 1, field: 9, delta: expect.any(Number), promoted: expect.any(Boolean) }, speed: { place: 1 }, brevity: { place: 1 } });
    expect((await call('/ratings/me/latest?seen=d-2026-12-06', token)).json).toEqual({ latest: null });
    expect((await call('/ratings/me/latest?seen=d-2026-12-05', token)).json.latest.challengeId).toBe('d-2026-12-06');
    expect((await call('/ratings/me/latest?seen=bad', token)).status).toBe(400);
    expect(PLACEMENT_EVENTS).toBe(5);
  });
});

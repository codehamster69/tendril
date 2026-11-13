import { afterEach, describe, expect, it } from 'vitest';
import { createApp, createDb, migrate } from '../src/index.ts';
import type { Db } from '../src/index.ts';
import { resetLegacyGrace } from '../src/arena.ts';
import { DAY_MS } from '../src/game.ts';
import { rateDue, recomputeRatings } from '../src/ratings.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OLD = Date.UTC(2020, 0, 1);
const DAYS = [Date.UTC(2026, 11, 2), Date.UTC(2026, 11, 3), Date.UTC(2026, 11, 4), Date.UTC(2026, 11, 5)];
const NOW = DAYS[3]! + 3 * DAY_MS;
const dbs: Db[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

/** Ten humans over four closed dailies; optionally a model (and a second one) that lands mid-field. */
async function world(models: { name: string; days: number; net: number; kind?: 'model' | 'human' }[]): Promise<Db> {
  resetLegacyGrace();
  const db = createDb({ url: ':memory:' });
  dbs.push(db);
  await migrate(db);
  for (let i = 0; i < 10; i++) await db.execute('INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at, github_created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)', [`u${i}`, 100 + i, `p${i}`, `p${i}`, OLD, OLD]);
  await db.execute('INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at, github_created_at) VALUES (?, ?, ?, ?, NULL, ?, NULL)', ['bot', 999, 'tendril-models', 'bot', OLD]);
  let seq = 0, mseq = 0; // model entries get their own ids, so human entry ids match across worlds
  const entry = (c: string, u: string, net: number, kind: string, model: string | null, par = 100): Promise<unknown> => {
    const id = model === null ? `e${++seq}` : `m${++mseq}`;
    return db.execute('INSERT INTO entries (id, challenge_id, user_id, net_worth, par_tick, tokens, actions_count, log_hash, source, author_kind, model, created_at) VALUES (?, ?, ?, ?, ?, 40, 1, ?, NULL, ?, ?, ?)',
      [id, c, u, net, par, `h-${id}`, kind, model, model === null ? seq : 1000 + mseq]);
  };
  for (let d = 0; d < DAYS.length; d++) {
    const id = `d-2026-12-0${d + 1}`;
    await db.execute('INSERT INTO challenges (id, kind, number, seed, ticks, par, opens_at, closes_at, created_by, rules_version, setup_v) VALUES (?, ?, 1, 7, 3000, 100, ?, ?, NULL, 3, 0)', [id, 'daily', DAYS[d]! - DAY_MS, DAYS[d]!]);
    for (let i = 0; i < 10; i++) await entry(id, `u${i}`, 10000 - i * 100 - d, 'human', null);
    for (const m of models) if (d < m.days) await entry(id, 'bot', m.net - d, m.kind ?? 'model', m.name);
  }
  return db;
}
const humanState = async (db: Db): Promise<string> => JSON.stringify([
  await db.query('SELECT * FROM rating_profiles ORDER BY user_id'), await db.query('SELECT * FROM rating_contests ORDER BY challenge_id, discipline'),
]);
async function models(db: Db): Promise<Json[]> {
  const app = createApp({ db, env: {}, setupVersion: 0, now: () => NOW });
  const res = await app(new Request('http://localhost:8787/api/ratings/models'));
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).models;
}

describe('model ghosts', () => {
  it('leaves human ratings byte-identical with and without model entries', async () => {
    const without = await world([]);
    const withModels = await world([{ name: 'big-model', days: 4, net: 9650 }, { name: 'top-model', days: 4, net: 20000 }, { name: 'tiny', days: 2, net: 1 }]);
    await rateDue(without, {}, NOW);
    await rateDue(withModels, {}, NOW);
    expect(await humanState(withModels)).toBe(await humanState(without));
    // Also after a rebuild of the model-bearing world.
    await recomputeRatings(withModels, {}, NOW);
    expect(await humanState(withModels)).toBe(await humanState(without));
  });

  it('puts a model with three rated days on the ladder and keeps one with two off it', async () => {
    const db = await world([{ name: 'Mid-Model', days: 3, net: 9650 }, { name: 'tiny', days: 2, net: 1 }]);
    await rateDue(db, {}, NOW);
    const list = await models(db);
    expect(list.map((m) => m.name)).toEqual(['Mid-Model']);
    const m = list[0]!;
    expect(m).toMatchObject({ events: 3, provisional: true, tier: { key: expect.any(String) }, humanRank: expect.any(Number), humans: 0 });
    expect(m.history).toHaveLength(3);
    expect(m.history[0]).toMatchObject({ place: 5, field: 10, before: 1200 });
    expect(m.disciplines.overall.rating).toBe(m.rating);
    expect(m.disciplines.speed).not.toBeNull();
  });

  it('rates a strong model above a weak one, places it among humans, and a recompute reproduces it', async () => {
    const db = await world([{ name: 'strong', days: 4, net: 20000 }, { name: 'weak', days: 4, net: 5 }, { name: 'ghost-human', days: 4, net: 20000, kind: 'human' }]);
    await rateDue(db, {}, NOW);
    const list = await models(db);
    expect(list.map((m) => m.name)).toEqual(['strong', 'weak']); // a human entry under a model name is not a model
    expect(list[0]!.rating).toBeGreaterThan(1200);
    expect(list[1]!.rating).toBeLessThan(1200);
    const before = JSON.stringify(list);
    await recomputeRatings(db, {}, NOW);
    expect(JSON.stringify(await models(db))).toBe(before);
  });

  it('does not rate models when the human field is unrated', async () => {
    const db = await world([{ name: 'm', days: 4, net: 9000 }]);
    await db.execute("UPDATE entries SET par_tick = NULL WHERE author_kind = 'human' AND user_id IN ('u0','u1','u2','u3')"); // 6 humans left: below the field minimum
    await rateDue(db, {}, NOW);
    expect(await models(db)).toEqual([]);
  });
});

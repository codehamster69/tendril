import { afterEach, describe, expect, it } from 'vitest';
import { createApp, createDb, migrate } from '../src/index.ts';
import type { Db } from '../src/index.ts';
import { resetLegacyGrace } from '../src/arena.ts';
import { DAY_MS } from '../src/game.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OLD = Date.UTC(2020, 0, 1);
const NOW = Date.UTC(2026, 11, 5, 12);
const dbs: Db[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

async function world(): Promise<Db> {
  resetLegacyGrace();
  const db = createDb({ url: ':memory:' });
  dbs.push(db);
  await migrate(db);
  for (const [id, gh, login] of [['h1', 1, 'ada'], ['h2', 2, 'bo'], ['bot', 3, 'tendril-models']] as const) {
    await db.execute('INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at, github_created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)', [id, gh, login, login, OLD, OLD]);
  }
  let n = 0;
  const entry = (c: string, user: string, net: number, kind: 'human' | 'model', model: string | null) =>
    db.execute('INSERT INTO entries (id, challenge_id, user_id, net_worth, par_tick, tokens, actions_count, log_hash, source, source_verified, author_kind, model, created_at) VALUES (?, ?, ?, ?, 100, 40, 1, ?, NULL, 1, ?, ?, ?)', [`e${++n}`, c, user, net, `h${n}`, kind, model, n]);
  // Dec 2: humans win. Dec 3: the machine wins. Dec 4 (today, open): both in, undecided. Dec 1: a day with no model.
  const days: [string, number, [string, number, 'human' | 'model', string | null][]][] = [
    ['d-2026-12-01', 1, [['h1', 5000, 'human', null]]],
    ['d-2026-12-02', 2, [['h1', 5000, 'human', null], ['h2', 4000, 'human', null], ['bot', 4500, 'model', 'gemini-3.5-flash']]],
    ['d-2026-12-03', 3, [['h1', 5000, 'human', null], ['bot', 5200, 'model', 'gemini-3.5-flash'], ['bot', 3000, 'model', 'other-model']]],
    ['d-2026-12-05', 4, [['h1', 7000, 'human', null], ['bot', 6000, 'model', 'gemini-3.5-flash']]],
  ];
  for (const [id, number, entries] of days) {
    const open = Date.UTC(2026, 11, Number(id.slice(-2)));
    await db.execute('INSERT INTO challenges (id, kind, number, seed, ticks, par, opens_at, closes_at, created_by, rules_version, setup_v) VALUES (?, ?, ?, 7, 3000, 100, ?, ?, NULL, 3, 0)', [id, 'daily', number, open, open + DAY_MS]);
    for (const [u, net, kind, model] of entries) await entry(id, u, net, kind, model);
  }
  return db;
}
const get = async (db: Db, path: string, now = NOW): Promise<{ status: number; json: Json; cache: string | null }> => {
  const res = await createApp({ db, env: {}, setupVersion: 0, now: () => now })(new Request(`http://localhost:8787/api${path}`));
  return { status: res.status, json: (await res.json()) as Json, cache: res.headers.get('cache-control') };
};

describe('GET /bench', () => {
  it('lists days newest first with the best human, the models and the winner', async () => {
    const { status, json, cache } = await get(await world(), '/bench');
    expect(status).toBe(200);
    expect(cache).toBe('public, max-age=300, s-maxage=300');
    expect(json.days.map((d: Json) => d.id)).toEqual(['d-2026-12-05', 'd-2026-12-03', 'd-2026-12-02', 'd-2026-12-01']);
    const [today, dec3, dec2, dec1] = json.days as [Json, Json, Json, Json];
    expect(today).toMatchObject({ closed: false, winner: null, human: { login: 'ada', value: 7000 }, models: [{ model: 'gemini-3.5-flash', value: 6000 }] });
    expect(dec3.winner).toBe('machines');
    expect(dec3.models.map((m: Json) => [m.model, m.value])).toEqual([['gemini-3.5-flash', 5200], ['other-model', 3000]]);
    expect(dec2).toMatchObject({ winner: 'humans', human: { login: 'ada', value: 5000 } });
    expect(dec1).toMatchObject({ winner: null, models: [] });
    expect(json.tally).toEqual({ decided: 2, humans: 1, machines: 1, ties: 0 });
  });

  it('refuses a bad days value and unknown query keys', async () => {
    const db = await world();
    expect((await get(db, '/bench?days=0')).status).toBe(400);
    expect((await get(db, '/bench?days=31')).status).toBe(400);
    expect((await get(db, '/bench?x=1')).status).toBe(400);
    expect((await get(db, '/bench?days=1')).json.days).toHaveLength(1);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RULES_VERSION } from '@tendril/sim/src/index.ts';
import { createDb, migrate } from '../src/index.ts';
import type { Db } from '../src/index.ts';
import { board, challengeInfo, FULL_BOARD_MAX, HISTOGRAM_TTL_MS, recountPlayers } from '../src/arena.ts';
import type { ChallengeRow } from '../src/arena.ts';

// Big boards must give the same answers as the full-scan path, while reading a bounded slice of the entries.

const OPEN = Date.UTC(2026, 10, 12);
const PLAYERS = FULL_BOARD_MAX + 120;
let db: Db;
let c: ChallengeRow;

/** Small deterministic generator so a failure reproduces. */
function rng(seed: number): () => number {
  let x = seed;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

beforeEach(async () => {
  db = createDb({ url: ':memory:' });
  await migrate(db);
  await db.execute('INSERT INTO challenges (id, kind, number, seed, ticks, par, opens_at, closes_at, created_by, rules_version) VALUES (?, ?, 1, 7, 3000, 100, ?, ?, NULL, ?)', ['d-2026-11-12', 'daily', OPEN, OPEN + 86_400_000, RULES_VERSION]);
  const rand = rng(42);
  await db.transaction(async (tx) => {
    let n = 0;
    for (let u = 0; u < PLAYERS; u++) {
      await tx.execute('INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at) VALUES (?, NULL, ?, ?, NULL, 1)', [`u${u}`, `u${u}`, `P${u}`]);
      const entries = 1 + Math.floor(rand() * 3);
      for (let e = 0; e < entries; e++) {
        // Few distinct worths, so there are many ties; a quarter of the players copy one of eight shared logs (same worth, same par tick).
        const shared = rand() < 0.25 ? Math.floor(rand() * 8) : -1;
        const worth = shared >= 0 ? 500 + shared * 37 : Math.floor(rand() * 60) * 10;
        const par = shared >= 0 ? 400 + shared : (rand() < 0.5 ? 300 + Math.floor(rand() * 40) : null);
        await tx.execute(
          `INSERT INTO entries (id, challenge_id, user_id, net_worth, par_tick, tokens, actions, actions_count, log_hash, mosaic, source, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, '[[0,0,0,1]]', 1, ?, 'x', NULL, ?)`,
          [`e${n++}`, 'd-2026-11-12', `u${u}`, worth, par, shared >= 0 ? `shared-${shared}` : `own-${u}-${e}`, OPEN + Math.floor(rand() * 50_000)]);
      }
    }
    await recountPlayers(tx, 'd-2026-11-12');
  });
  [c] = await db.query<ChallengeRow>('SELECT * FROM challenges WHERE id = ?', ['d-2026-11-12']) as [ChallengeRow];
});
afterEach(() => db.close());

describe('big boards', () => {
  for (const medal of ['wealth', 'speed'] as const) {
    it(`${medal}: top rows, totals, histogram and every viewer's own row match the full computation`, async () => {
      const now = OPEN + 1000;
      for (const limit of [5, 100]) {
        const full = await board(db, c, { medal, friends: false, limit, viewerId: 'u7', now, fullMax: Infinity });
        const fast = await board(db, c, { medal, friends: false, limit, viewerId: 'u7', now });
        expect(fast).toEqual(full);
        expect(await db.query("SELECT key FROM arena_meta WHERE key LIKE 'hist:%'")).toHaveLength(1);
        await db.execute('DELETE FROM arena_meta');
      }
      for (let u = 0; u < PLAYERS; u += 13) {
        const full = await board(db, c, { medal, friends: false, limit: 1, viewerId: `u${u}`, now, fullMax: Infinity });
        const fast = await board(db, c, { medal, friends: false, limit: 1, viewerId: `u${u}`, now });
        expect(fast.me, `u${u}`).toEqual(full.me);
        expect(fast.total).toBe(full.total);
      }
    });
  }

  it('takes the bounded path above the size limit and the full path below it', async () => {
    await board(db, c, { medal: 'wealth', friends: false, limit: 5, now: OPEN + 1000 });
    expect(await db.query("SELECT key FROM arena_meta WHERE key LIKE 'hist:%'")).toHaveLength(1); // only the bounded path stores one
    await db.execute('DELETE FROM arena_meta');
    await board(db, c, { medal: 'wealth', friends: false, limit: 5, now: OPEN + 1000, fullMax: Infinity });
    await board(db, c, { medal: 'wealth', friends: true, limit: 5, viewerId: 'u1', now: OPEN + 1000 });
    expect(await db.query("SELECT key FROM arena_meta WHERE key LIKE 'hist:%'")).toHaveLength(0);
  });

  it('keeps the histogram for five minutes on an open board and refreshes it afterwards', async () => {
    const first = await board(db, c, { medal: 'wealth', friends: false, limit: 5, now: OPEN + 1000 });
    await db.execute("INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at) VALUES ('late', NULL, 'late', 'Late', NULL, 1)");
    await db.execute("INSERT INTO entries (id, challenge_id, user_id, net_worth, par_tick, tokens, actions, actions_count, log_hash, mosaic, created_at) VALUES ('late1', 'd-2026-11-12', 'late', 99999, NULL, NULL, '[]', 0, 'late1', 'x', ?)", [OPEN + 2000]);
    const cached = await board(db, c, { medal: 'wealth', friends: false, limit: 5, now: OPEN + 2000 });
    expect(cached.histogram).toEqual(first.histogram);
    const fresh = await board(db, c, { medal: 'wealth', friends: false, limit: 5, now: OPEN + 1000 + HISTOGRAM_TTL_MS });
    expect(fresh.histogram.max).toBe(99999);
  });

  it('reports players from the counter without scanning', async () => {
    expect((await challengeInfo(db, c)).players).toBe(PLAYERS);
  });
});

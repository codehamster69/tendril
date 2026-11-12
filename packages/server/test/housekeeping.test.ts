import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RULES_VERSION } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createApp, createDb } from '../src/index.ts';
import type { Db } from '../src/index.ts';
import { DAY_MS } from '../src/game.ts';
import {
  CHUNK_RETENTION_MS, decideMode, DUEL_RETENTION_MS, edgeSeconds, GUARD_REFRESH_MS, prune, pruneOncePerDay, projectedMonthlyWrites,
  refreshGuard, storageBytes, TOP_KEEP, TIGHT_SCALE,
} from '../src/housekeeping.ts';
import type { GuardMode } from '../src/housekeeping.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const BASE = Date.UTC(2026, 10, 12, 12, 0, 0);
const DAILY = 'd-2026-11-12';
const SMALL: LogEntry[] = [[0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [7, 0, 3], [9, 0, 3], [300, 0, 4], [303, 0, 0, 3], [305, 0, 5], [306, 0, 8, 1, 4]];

let db: Db;
let app: (request: Request) => Promise<Response>;
let time: number;
let env: Record<string, string | undefined>;
let token: string;

async function call(path: string, o: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers(o.headers);
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await app(new Request(`http://localhost:8787/api${path}`, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }));
  const text = await response.text();
  return { status: response.status, headers: response.headers, json: (text ? JSON.parse(text) : null) as Json };
}
const enter = (actions: unknown) => call(`/challenges/${DAILY}/entries`, { token, body: { rulesVersion: RULES_VERSION, actions } });

async function addUsers(n: number, prefix = 'u'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${i}`;
    await db.execute("INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at) VALUES (?, NULL, ?, ?, NULL, 1)", [id, id, id]);
    ids.push(id);
  }
  return ids;
}
async function addChallenge(id: string, kind: 'daily' | 'duel', opensAt: number, closesAt: number | null): Promise<void> {
  await db.execute('INSERT INTO challenges (id, kind, number, seed, ticks, par, opens_at, closes_at, created_by, rules_version) VALUES (?, ?, 1, 7, 3000, 100, ?, ?, NULL, ?)', [id, kind, opensAt, closesAt, RULES_VERSION]);
}
async function addEntry(id: string, challenge: string, user: string, worth: number, extra: { par?: number | null; tokens?: number | null; at?: number } = {}): Promise<void> {
  await db.execute(
    `INSERT INTO entries (id, challenge_id, user_id, net_worth, par_tick, tokens, actions, actions_count, log_hash, mosaic, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '[[0,0,0,1]]', 1, ?, 'x', 'src', ?)`,
    [id, challenge, user, worth, extra.par ?? null, extra.tokens ?? null, `h-${id}`, extra.at ?? 1],
  );
}
const withLog = async (challenge: string): Promise<string[]> =>
  (await db.query<{ id: string }>('SELECT id FROM entries WHERE challenge_id = ? AND actions IS NOT NULL ORDER BY id', [challenge])).map((r) => r.id);

/** Sets the storage budget so the current database is exactly `ratio` of it, then re-measures. */
async function setRatio(ratio: number): Promise<GuardMode> {
  env.TENDRIL_STORAGE_BUDGET_BYTES = String(Math.round((await storageBytes(db)) / ratio));
  time += GUARD_REFRESH_MS + 1;
  return (await refreshGuard(db, env, time)).mode;
}

beforeEach(async () => {
  time = BASE;
  env = { TENDRIL_DEV_AUTH: '1', PUBLIC_ORIGIN: 'https://tendril.example', CRON_SECRET: 'cron-secret' };
  db = createDb({ url: ':memory:' });
  app = createApp({ db, env, now: () => time });
  const r = await call('/dev/login', { body: { displayName: 'Farmer' } });
  token = r.json.token;
});
afterEach(() => db.close());

describe('guard modes', () => {
  it('decides with hysteresis', () => {
    expect(decideMode('normal', 0.49)).toBe('normal');
    expect(decideMode('normal', 0.5)).toBe('lean');
    expect(decideMode('normal', 0.95)).toBe('readonly');
    expect(decideMode('lean', 0.47)).toBe('lean'); // inside the 5-point margin
    expect(decideMode('lean', 0.44)).toBe('normal');
    expect(decideMode('readonly', 0.87)).toBe('readonly');
    expect(decideMode('readonly', 0.84)).toBe('tight');
    expect(decideMode('readonly', 0.1)).toBe('normal');
  });

  it('lean stops storing logs for entries outside the top, tight cuts rate limits, read-only refuses writes, and each releases', async () => {
    await call('/stats');
    await addChallenge(DAILY, 'daily', BASE - 1000, BASE + DAY_MS);
    const others = await addUsers(TOP_KEEP);
    for (let i = 0; i < TOP_KEEP; i++) await addEntry(`top${i}`, DAILY, others[i]!, 100000 - i);

    // normal: a poor entry keeps its log
    expect(await setRatio(0.2)).toBe('normal');
    const stored = await enter(SMALL);
    expect(stored.status).toBe(200);
    expect(stored.json.improved).toBe(true);
    expect((await db.query('SELECT id FROM entries WHERE id = ? AND actions IS NOT NULL', [stored.json.entryId]))).toHaveLength(1);

    // lean: a new, different poor entry from another player is stored without its log; the top 100 keep theirs
    expect(await setRatio(0.55)).toBe('lean');
    const second = await call('/dev/login', { body: { displayName: 'Second' } });
    const lean = await call(`/challenges/${DAILY}/entries`, { token: second.json.token, body: { rulesVersion: RULES_VERSION, actions: SMALL } });
    expect(lean.status).toBe(200);
    expect(await db.query('SELECT id FROM entries WHERE id = ? AND actions IS NULL', [lean.json.entryId])).toHaveLength(1);
    expect(await withLog(DAILY)).toContain('top0');
    expect((await call(`/entries/${lean.json.entryId}/replay`, { token: second.json.token })).status).toBe(404); // the owner can open it, but no log is stored

    // tight: per-user attempt limits shrink (entry limit 60 -> 15)
    expect(await setRatio(0.75)).toBe('tight');
    const limit = Math.floor(60 * TIGHT_SCALE);
    const third = (await call('/dev/login', { body: { displayName: 'Third' } })).json.token as string;
    let refused = 0;
    for (let i = 0; i < limit + 2; i++) {
      const r = await call(`/challenges/${DAILY}/entries`, { token: third, body: { rulesVersion: RULES_VERSION, actions: 'nope' } });
      if (r.status === 429) refused++;
    }
    expect(refused).toBe(2);

    // read-only: writes refused with 503, reads and sign-in still work
    expect(await setRatio(0.95)).toBe('readonly');
    const blocked = await enter(SMALL);
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get('Retry-After')).toBe('1800');
    expect((await call('/stats')).status).toBe(200);
    expect((await call('/dev/login', { body: { displayName: 'Late' } })).status).toBe(201);

    // release, step by step as the database shrinks relative to the budget
    expect(await setRatio(0.6)).toBe('lean'); // 0.6 < 0.9-0.05, < 0.7-0.05: down to lean
    expect(await setRatio(0.2)).toBe('normal');
    expect((await call(`/challenges/${DAILY}/entries`, { token: third, body: { rulesVersion: RULES_VERSION, actions: SMALL } })).status).not.toBe(503);
  });

  it('engages on a projected write rate too', async () => {
    await call('/stats');
    expect((await enter(SMALL)).status).toBe(200);
    const projected = await projectedMonthlyWrites(db, time);
    expect(projected).toBeGreaterThan(0);
    env.TENDRIL_STORAGE_BUDGET_BYTES = String(10 ** 12);
    env.TENDRIL_WRITES_BUDGET_PER_MONTH = String(Math.round(projected / 0.75));
    time += 1;
    expect((await refreshGuard(db, env, time)).mode).toBe('tight');
    env.TENDRIL_WRITES_BUDGET_PER_MONTH = String(projected * 100);
    expect((await refreshGuard(db, env, time)).mode).toBe('normal');
  });
});

describe('prune', () => {
  it('trims closed challenges outside the top of each medal and never touches open ones', async () => {
    await call('/stats');
    const closes = BASE - 3 * DAY_MS;
    const users = await addUsers(TOP_KEEP + 30);
    await addChallenge('d-2026-11-08', 'daily', closes - DAY_MS, closes);
    await addChallenge('d-2026-11-11', 'daily', BASE - 2 * DAY_MS, BASE - DAY_MS); // closed only a day ago: still whole
    await addChallenge(DAILY, 'daily', BASE - 1000, BASE + DAY_MS); // open
    for (const c of ['d-2026-11-08', 'd-2026-11-11', DAILY]) {
      for (let i = 0; i < TOP_KEEP + 30; i++) {
        // the last 30 players are poor on wealth; two of them are best at brevity and speed
        const speedy = i === TOP_KEEP + 5, terse = i === TOP_KEEP + 6;
        await addEntry(`${c}:${i}`, c, users[i]!, 10000 - i, { par: speedy ? 5 : terse ? 9000 : null, tokens: terse ? 1 : null } /* Brevity needs par, so the terse one reaches it */);
      }
    }
    const report = await prune(db, time);
    expect(report.challengesPruned).toBe(1);
    const kept = new Set(await withLog('d-2026-11-08'));
    expect(kept.size).toBe(TOP_KEEP + 2);
    for (let i = 0; i < TOP_KEEP; i++) expect(kept.has(`d-2026-11-08:${i}`)).toBe(true);
    expect(kept.has(`d-2026-11-08:${TOP_KEEP + 5}`)).toBe(true); // top speed
    expect(kept.has(`d-2026-11-08:${TOP_KEEP + 6}`)).toBe(true); // top brevity
    expect(kept.has(`d-2026-11-08:${TOP_KEEP + 7}`)).toBe(false);
    // scores and mosaics survive; the source goes with the log
    const [row] = await db.query<{ net_worth: number; mosaic: string; source: string | null }>("SELECT net_worth, mosaic, source FROM entries WHERE id = ?", [`d-2026-11-08:${TOP_KEEP + 7}`]);
    expect(row).toEqual({ net_worth: 10000 - TOP_KEEP - 7, mosaic: 'x', source: null });
    expect(await withLog('d-2026-11-11')).toHaveLength(TOP_KEEP + 30);
    expect(await withLog(DAILY)).toHaveLength(TOP_KEEP + 30);
    // a second run has nothing left to do
    expect((await prune(db, time)).entriesTrimmed).toBe(0);
  });

  it('expires duel replays by age, old chunks except each farm\'s newest, and stale housekeeping rows', async () => {
    await call('/stats');
    const [u] = await addUsers(1, 'p');
    await addChallenge('x-old', 'duel', BASE - DUEL_RETENTION_MS - DAY_MS, null);
    await addChallenge('x-new', 'duel', BASE - DAY_MS, null);
    await addEntry('xo', 'x-old', u!, 5);
    await addEntry('xn', 'x-new', u!, 5);

    await db.execute("INSERT INTO farms (id, user_id, seed, started_at, tick, checkpoint, checkpoint_hash, rules_version, coins, net_worth, verified_at) VALUES ('f1', ?, 1, 0, 300, '{}', 'h', ?, 0, 0, 1)", [u!, RULES_VERSION]);
    const old = BASE - CHUNK_RETENTION_MS - DAY_MS;
    for (const [from, to, at] of [[0, 100, old], [100, 200, old + 1], [200, 300, old + 2], [300, 400, BASE - 1000]] as const) {
      await db.execute("INSERT INTO chunks (farm_id, from_tick, to_tick, actions, created_at) VALUES ('f1', ?, ?, '[]', ?)", [from, to, at]);
    }
    await db.execute("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('s-old', ?, 1, ?), ('s-live', ?, 1, ?)", [u!, BASE - 1, u!, BASE + DAY_MS]);
    await db.execute("INSERT INTO submission_attempts (user_id, kind, at_ms) VALUES (?, 'chunk', ?), (?, 'chunk', ?)", [u!, BASE - 3 * DAY_MS, u!, BASE - 1000]);
    // worth samples: one fresh, one 4 days old that is the newest at or before 24h ago (kept), one older and superseded (dropped)
    for (const at of [BASE - 6 * DAY_MS, BASE - 4 * DAY_MS, BASE - 1000]) await db.execute("INSERT INTO worth_history (farm_id, net_worth, at_ms) VALUES ('f1', 1, ?)", [at]);

    const report = await prune(db, time);
    expect(report.duelEntriesTrimmed).toBe(1);
    expect(await withLog('x-old')).toEqual([]);
    expect(await withLog('x-new')).toEqual(['xn']);
    expect(report.chunks).toBe(2); // 0-100 and 100-200 go; 200-300 is the farm's last chunk up to its checkpoint tick, 300-400 is recent
    expect((await db.query<{ from_tick: number }>("SELECT from_tick FROM chunks WHERE farm_id = 'f1' ORDER BY from_tick")).map((r) => r.from_tick)).toEqual([200, 300]);
    expect((await db.query<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id = ? AND token_hash LIKE ?', [u!, 's-%'])).map((r) => r.token_hash)).toEqual(['s-live']);
    expect(await db.query('SELECT 1 FROM submission_attempts WHERE at_ms < ?', [BASE - 2 * DAY_MS])).toHaveLength(0);
    expect((await db.query<{ at_ms: number }>('SELECT at_ms FROM worth_history WHERE farm_id = ? ORDER BY at_ms', ['f1'])).map((r) => r.at_ms)).toEqual([BASE - 4 * DAY_MS, BASE - 1000]);
  });

  it('runs lazily once per UTC day and from the cron route only with the secret', async () => {
    await call('/stats'); // the first request of the day claims and runs the prune
    const first = await db.query<{ value: string }>("SELECT value FROM arena_meta WHERE key = 'pruned_day'");
    expect(first[0]!.value).toBe('2026-11-12');
    await db.execute("INSERT INTO oauth_states (state_hash, desktop_nonce_hash, return_path, created_at, expires_at) VALUES ('st', NULL, '/', 1, ?)", [BASE - 1]);
    await call('/stats');
    expect(await db.query('SELECT 1 FROM oauth_states')).toHaveLength(1); // same day: not run again
    expect(await pruneOncePerDay(db, time)).toBeNull();
    time += DAY_MS; // next UTC day: the first request prunes again
    await call('/stats');
    expect(await db.query('SELECT 1 FROM oauth_states')).toHaveLength(0);

    expect((await call('/cron/housekeeping')).status).toBe(401);
    expect((await call('/cron/housekeeping', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const ok = await call('/cron/housekeeping', { headers: { authorization: 'Bearer cron-secret' } });
    expect(ok.status).toBe(200);
    expect(ok.json.guard.mode).toBe('normal');
    delete env.CRON_SECRET;
    expect((await call('/cron/housekeeping', { headers: { authorization: 'Bearer undefined' } })).status).toBe(401);
  });
});

describe('cache headers', () => {
  it('caches anonymous successful reads at the edge and nothing else', async () => {
    const stats = await call('/stats');
    expect(stats.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=300, stale-while-revalidate=600');
    expect(stats.headers.get('Vary')).toBe('Origin'); // never Cookie: Vercel's CDN will not cache a response that varies on it
    expect((await call('/leaderboard')).headers.get('Cache-Control')).toContain('s-maxage=30');
    expect((await call(`/challenges/${DAILY}/board`)).headers.get('Cache-Control')).toContain('s-maxage=30');
    // a signed-in viewer's response may differ per person
    expect((await call('/stats', { token })).headers.get('Cache-Control')).toBe('no-store');
    expect((await call('/leaderboard', { headers: { origin: 'app://tendril' } })).headers.get('Cache-Control')).toBe('no-store');
    // errors, private routes and writes
    expect((await call('/challenges/d-2026-01-01')).headers.get('Cache-Control')).toBe('no-store');
    expect((await call('/me', { token })).headers.get('Cache-Control')).toBe('no-store');
    expect((await call('/farms', { token, body: {}, method: 'POST' })).headers.get('Cache-Control')).toBe('no-store');
  });

  it('lists every public read route and no private one', () => {
    for (const r of ['/leaderboard', '/stats', '/daily', '/daily/leaderboard', '/challenges/today', '/challenges/d-2026-11-12/board', '/entries/abc', '/entries/abc/replay', '/farms/x/replay']) expect(edgeSeconds(r), r).not.toBeNull();
    for (const r of ['/me', '/farms/me', '/auth/github', '/dev/login', '/cron/housekeeping', '/challenges/today/entries']) expect(edgeSeconds(r), r).toBeNull();
  });
});

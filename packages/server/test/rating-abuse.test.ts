import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, createDb, migrate } from '../src/index.ts';
import type { Db } from '../src/index.ts';
import { resetLegacyGrace } from '../src/arena.ts';
import { DAY_MS } from '../src/game.ts';
import { EXCLUDED_KEY, LOCK_KEY, normalizeSource, rateChallenge, rateDue, recomputeRatings } from '../src/ratings.ts';
import { statsCardSvg } from '../src/players.ts';
import type { RatingCardData } from '../src/players.ts';

// R9: attack simulations against the rater, its routes, pins and the image endpoints. Findings: brain/notes/R9.md.
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DEC7 = Date.UTC(2026, 11, 7);
const OLD = Date.UTC(2020, 0, 1);
const NOW = DEC7 + 3 * DAY_MS;
const YOUNG = DEC7 - 2 * DAY_MS;

let db: Db;
let seq = 0;
beforeEach(async () => { seq = 0; resetLegacyGrace(); db = createDb({ url: ':memory:' }); await migrate(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });

const uid = (i: number): string => `u${String(i).padStart(3, '0')}`;
async function users(n: number, from = 0, github: number | null = OLD): Promise<string[]> {
  const ids: string[] = [];
  for (let i = from; i < from + n; i++) {
    await db.execute('INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at, github_created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)', [uid(i), 1000 + i, `player${i}`, `player${i}`, OLD, github]);
    ids.push(uid(i));
  }
  return ids;
}
async function challenge(id: string, kind: 'daily' | 'season', closesAt: number): Promise<void> {
  await db.execute('INSERT INTO challenges (id, kind, number, seed, ticks, par, opens_at, closes_at, created_by, rules_version, setup_v) VALUES (?, ?, 1, 7, 3000, 100, ?, ?, NULL, 3, 0)',
    [id, kind, closesAt - (kind === 'daily' ? 1 : 7) * DAY_MS, closesAt]);
}
interface E { c: string; u: string; net: number; par?: number | null; tokens?: number | null; hash?: string; kind?: 'human' | 'model'; model?: string | null; source?: string | null; at?: number }
async function entry(e: E): Promise<string> {
  const id = `e${++seq}`;
  await db.execute(
    'INSERT INTO entries (id, challenge_id, user_id, net_worth, par_tick, tokens, actions_count, log_hash, source, source_public, source_verified, author_kind, model, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
    [id, e.c, e.u, e.net, e.par === undefined ? 100 : e.par, e.tokens ?? null, e.hash ?? `h-${id}`, e.source ?? null, e.source ? 1 : 0, e.source ? 1 : 0, e.kind ?? 'human', e.model ?? null, e.at ?? seq]);
  return id;
}
async function field(c: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) await entry({ c, u: ids[i]!, net: 10000 - i * 10, par: 100 + i, tokens: 50 + i });
}
const profile = async (u: string): Promise<Json | null> => { const [r] = await db.query<{ data: string }>('SELECT data FROM rating_profiles WHERE user_id = ?', [u]); return r ? JSON.parse(r.data) : null; };
const overall = async (u: string): Promise<number | null> => (await profile(u))?.d.overall?.r ?? null;
const D = 'd-2026-12-06';

describe('F1 a player who can never be rated cannot knock a real player out as the copy', () => {
  it('a young account submitting the victim\'s log first does not exclude the victim', async () => {
    const ids = await users(10);
    const [fake] = await users(1, 50, YOUNG);
    await challenge(D, 'daily', DEC7);
    await entry({ c: D, u: fake!, net: 9999, hash: 'victim-log', at: 1 });         // the griefer re-runs a published program first
    await entry({ c: D, u: ids[0]!, net: 9999, hash: 'victim-log', at: 2 });
    for (let i = 1; i < ids.length; i++) await entry({ c: D, u: ids[i]!, net: 5000 - i, at: 3 + i });
    await rateDue(db, {}, NOW);
    expect(await overall(ids[0]!)).not.toBeNull();
    expect(await overall(fake!)).toBeNull();
  });
  it('same for a program text copy', async () => {
    const ids = await users(10);
    const [fake] = await users(1, 50, YOUNG);
    await challenge(D, 'daily', DEC7);
    await entry({ c: D, u: fake!, net: 9000, source: 'plant carrot\nharvest\n', at: 1 });
    await entry({ c: D, u: ids[0]!, net: 9999, source: '# mine\nplant   carrot\n harvest' .replace(' harvest', 'harvest'), at: 2 });
    for (let i = 1; i < ids.length; i++) await entry({ c: D, u: ids[i]!, net: 5000 - i, at: 3 + i });
    await rateDue(db, {}, NOW);
    expect(await overall(ids[0]!)).not.toBeNull();
  });
});

describe('F2 copies', () => {
  it('a second GitHub account with the same log is out; one with a renamed variable and a changed constant is NOT caught (accepted)', async () => {
    const ids = await users(12);
    await challenge(D, 'daily', DEC7);
    const a = 'n = 3\nrepeat forever:\n    plant carrot\n    wait 100\n';
    const renamed = 'count = 4\nrepeat forever:\n    plant carrot\n    wait 100\n';
    expect(normalizeSource(a)).not.toBe(normalizeSource(renamed));
    await entry({ c: D, u: ids[0]!, net: 9000, hash: 'x', source: a, at: 1 });
    await entry({ c: D, u: ids[1]!, net: 9000, hash: 'x', source: a, at: 2 });          // identical copy
    await entry({ c: D, u: ids[2]!, net: 8999, hash: 'y', source: renamed, at: 3 });    // small edit
    for (let i = 3; i < ids.length; i++) await entry({ c: D, u: ids[i]!, net: 5000 - i, at: 4 + i });
    await rateDue(db, {}, NOW);
    expect(await overall(ids[1]!)).toBeNull();
    expect(await overall(ids[2]!)).not.toBeNull();
  });
  it('one player submitting many entries is one standing', async () => {
    const ids = await users(8);
    await challenge(D, 'daily', DEC7);
    for (let k = 0; k < 6; k++) await entry({ c: D, u: ids[0]!, net: 9000 + k });
    for (let i = 1; i < ids.length; i++) await entry({ c: D, u: ids[i]!, net: 5000 - i });
    await rateDue(db, {}, NOW);
    expect((await profile(ids[0]!))!.d.overall.h).toHaveLength(1);
    const [row] = await db.query<{ summary: string }>("SELECT summary FROM rating_contests WHERE discipline = 'overall'");
    expect(JSON.parse(row!.summary).standings).toBe(8);
  });
});

describe('F3 staying below par', () => {
  it('a below-par run is out of the field and moves nothing; it cannot pad a field of seven', async () => {
    const ids = await users(10);
    await challenge(D, 'daily', DEC7);
    for (let i = 0; i < 7; i++) await entry({ c: D, u: ids[i]!, net: 9000 - i });
    for (let i = 7; i < 10; i++) await entry({ c: D, u: ids[i]!, net: 100, par: null });
    await rateDue(db, {}, NOW);
    expect(await db.query('SELECT 1 FROM rating_profiles')).toHaveLength(0);
  });
});

describe('F4 model lane', () => {
  it('a model declared as human is rated as a human (the honour system, stated in the docs)', async () => {
    const ids = await users(8);
    await challenge(D, 'daily', DEC7);
    await field(D, ids);
    await rateDue(db, {}, NOW);
    expect(await overall(ids[0]!)).not.toBeNull();
  });
  it('throwaway model names that never reach par do not crowd a real model out of the 20 slots', async () => {
    const ids = await users(12);
    const bots = await users(25, 100);
    await challenge(D, 'daily', DEC7);
    await field(D, ids);
    for (let i = 0; i < bots.length; i++) await entry({ c: D, u: bots[i]!, net: 10, par: null, kind: 'model', model: `aaa${String(i).padStart(2, '0')}`, source: `x${i}` });
    const [real] = await users(1, 200);
    await entry({ c: D, u: real!, net: 7000, kind: 'model', model: 'zeta-real', source: 'real' });
    await rateDue(db, {}, NOW);
    const keys = (await db.query<{ key: string }>("SELECT key FROM arena_meta WHERE key LIKE 'model_rating:%'")).map((r) => r.key);
    expect(keys).toEqual(['model_rating:zeta-real']);
  });
});

describe('F5 burst at the moment of a close', () => {
  async function seeded(): Promise<void> {
    const ids = await users(30);
    await challenge(D, 'daily', DEC7);
    await field(D, ids);
  }
  it('60 parallel requests from 6 instances rate the contest once, with a single lock claim that succeeds', async () => {
    await seeded();
    const claims = vi.spyOn(db, 'execute');
    const apps = Array.from({ length: 6 }, () => createApp({ db, env: {}, setupVersion: 0, now: () => NOW }));
    const res = await Promise.all(Array.from({ length: 60 }, (_, i) => apps[i % 6]!(new Request('http://localhost:8787/api/ratings/board'))));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(await db.query('SELECT 1 FROM rating_contests')).toHaveLength(3);
    expect(await db.query('SELECT 1 FROM rating_profiles')).toHaveLength(30);
    const lockCalls = claims.mock.calls.filter((c) => Array.isArray(c[1]) && c[1].includes(LOCK_KEY));
    expect(lockCalls.length).toBeGreaterThanOrEqual(1);
    expect(lockCalls.length).toBeLessThanOrEqual(6 * 2);
  });
  it('two overlapping rateChallenge calls (stale lock) write once', async () => {
    await seeded();
    const [c] = await db.query<any>('SELECT * FROM challenges WHERE id = ?', [D]); // eslint-disable-line @typescript-eslint/no-explicit-any
    const [a, b] = await Promise.all([rateChallenge(db, c, { ratedAt: NOW }), rateChallenge(db, c, { ratedAt: NOW })]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await db.query('SELECT 1 FROM rating_contests')).toHaveLength(3);
  });
  it('an entry stored after the contest was rated is picked up by a recompute (accepted: sub-second race, see notes)', async () => {
    await seeded();
    await rateDue(db, {}, NOW);
    const snap = async (): Promise<string> => JSON.stringify(await db.query('SELECT user_id, data FROM rating_profiles ORDER BY user_id'));
    const before = await snap();
    await entry({ c: D, u: uid(29), net: 99999 });
    await recomputeRatings(db, {}, NOW);
    expect(await snap()).not.toBe(before);
  });
});

describe('F6 write amplification', () => {
  it('rating routes during the alias-grace day cost no database writes', async () => {
    const ids = await users(12);
    await challenge(D, 'daily', DEC7);
    await field(D, ids);
    const t = DEC7 + 60_000; // closed, not settled
    const app = createApp({ db, env: {}, setupVersion: 0, now: () => t });
    const spy = vi.spyOn(db, 'execute');
    for (let i = 0; i < 50; i++) await app(new Request(`http://localhost:8787/api/ratings/board?limit=${(i % 90) + 1}`));
    expect(spy.mock.calls.filter((c) => Array.isArray(c[1]) && c[1].includes(LOCK_KEY))).toHaveLength(0);
    expect(await db.query('SELECT 1 FROM rating_contests')).toHaveLength(0);
  });
  it('an engine-version mismatch costs no writes per request either', async () => {
    const ids = await users(10);
    await challenge(D, 'daily', DEC7);
    await field(D, ids);
    await rateDue(db, {}, NOW);
    await db.execute('UPDATE rating_contests SET algo_version = 99');
    await challenge('d-2026-12-07', 'daily', DEC7 + DAY_MS);
    await field('d-2026-12-07', ids);
    const spy = vi.spyOn(db, 'execute');
    for (let i = 0; i < 20; i++) expect((await rateDue(db, {}, NOW + 2 * DAY_MS)).reason).toBe('stale-algo');
    expect(spy).not.toHaveBeenCalled();
  });
  it('a contest that keeps failing is retried at most once a minute, not on every request', async () => {
    const ids = await users(10);
    await challenge(D, 'daily', DEC7);
    await field(D, ids);
    await db.execute("INSERT INTO rating_profiles (user_id, data, updated_at) VALUES (?, 'not json', 1)", [ids[0]!]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let t = NOW;
    const app = createApp({ db, env: {}, setupVersion: 0, now: () => t });
    for (let i = 0; i < 25; i++) await app(new Request('http://localhost:8787/api/ratings/board'));
    expect(err.mock.calls.filter((c) => c[0] === 'Rating run failed')).toHaveLength(1);
    t += 61_000;
    await app(new Request('http://localhost:8787/api/ratings/board'));
    expect(err.mock.calls.filter((c) => c[0] === 'Rating run failed')).toHaveLength(2);
  });
  it('a 1,000-player contest is N + 4 writes and well under a few seconds', async () => {
    await users(1000);
    await challenge(D, 'daily', DEC7);
    await field(D, Array.from({ length: 1000 }, (_, i) => uid(i)));
    const t0 = Date.now();
    const run = await rateDue(db, {}, NOW);
    expect(run.contests[0]!.writes).toBe(1004);
    expect(Date.now() - t0).toBeLessThan(8000);
  });
});

describe('F7 operator exclusion', () => {
  it('an excluded player is never rated, and the others rate exactly as if the player had not entered', async () => {
    const ids = await users(12);
    await challenge(D, 'daily', DEC7);
    await field(D, ids);
    await db.execute('INSERT INTO arena_meta (key, value) VALUES (?, ?)', [EXCLUDED_KEY, JSON.stringify([ids[0]])]);
    await rateDue(db, {}, NOW);
    expect(await overall(ids[0]!)).toBeNull();
    const withBan = await Promise.all(ids.slice(1).map(overall));
    // Reference: a second database where the player never existed.
    const other = createDb({ url: ':memory:' }); await migrate(other);
    const keep = db; db = other;
    await users(12); await challenge(D, 'daily', DEC7);
    await field(D, ids.slice(1));
    await rateDue(db, {}, NOW);
    const ref = await Promise.all(ids.slice(1).map(overall));
    db = keep; other.close();
    expect(withBan).toEqual(ref);
  });
});

describe('F8 pinning, SVG and card endpoints', () => {
  let t: number;
  let app: (r: Request) => Promise<Response>;
  let alice: { token: string; id: string };
  const call = async (path: string, o: { token?: string; method?: string; body?: unknown } = {}) => {
    const headers = new Headers();
    if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
    if (o.body !== undefined) headers.set('Content-Type', 'application/json');
    const res = await app(new Request(`http://localhost:8787/api${path}`, { method: o.method ?? 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }));
    return { res, text: await res.text() };
  };
  beforeEach(async () => {
    t = DEC7 + 5 * DAY_MS;
    app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1' }, setupVersion: 0, now: () => t });
    const r = await call('/dev/login', { method: 'POST', body: { displayName: 'Alice' } });
    const b = JSON.parse(r.text);
    alice = { token: b.token, id: b.profile.id };
  });
  const XSS = '<script>alert(1)</script>"\'&';

  it('cannot pin another player\'s program, an unpublished one, a duel run, or junk; a huge list is refused before any query', async () => {
    const [bob] = await users(1);
    await challenge(D, 'daily', DEC7);
    await db.execute("INSERT INTO challenges (id, kind, number, seed, ticks, par, opens_at, closes_at, rules_version, setup_v) VALUES ('x-duel', 'duel', 1, 1, 3000, 100, 1, ?, 3, 0)", [DEC7]);
    const theirs = await entry({ c: D, u: bob!, net: 5, source: XSS });
    const mineHidden = await entry({ c: D, u: alice.id, net: 5 });                  // not published
    const mineDuel = await entry({ c: 'x-duel', u: alice.id, net: 5, source: 'x' });
    const mineOk = await entry({ c: D, u: alice.id, net: 5, source: XSS });
    const put = (ids: unknown) => call('/players/me/pinned', { token: alice.token, method: 'PUT', body: { entryIds: ids } });
    for (const ids of [[theirs], [mineHidden], [mineDuel], [theirs, mineOk]]) expect((await put(ids)).res.status).toBe(422);
    expect((await put('nope')).res.status).toBe(400);
    expect((await put([1])).res.status).toBe(400);
    expect((await put([mineOk, mineOk])).res.status).toBe(422);
    const spy = vi.spyOn(db, 'query');
    expect((await put(Array.from({ length: 5000 }, (_, i) => `id${i}`))).res.status).toBe(422);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('entries'))).toBe(false);
    const ok = await put([mineOk]);
    expect(ok.res.status).toBe(200);
    expect(ok.res.headers.get('content-type')).toContain('application/json');
    expect(ok.res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await call('/players/me/pinned', { method: 'PUT', body: { entryIds: [] } })).res.status).toBe(401);
  });

  it('hostile logins in the badge, card and OG routes give valid, inert images', async () => {
    const logins = ['<script>alert(1)</script>', '"><svg onload=alert(1)>', '%3Cscript%3E', 'a'.repeat(10_000), '..%2f..%2fetc%2fpasswd', '%00', 'x y', '‮alice', 'alice%0d%0aSet-Cookie:x=1'];
    for (const login of logins) {
      for (const p of [`/card/${encodeURIComponent(login)}.svg`, `/badge/rating/${encodeURIComponent(login)}.svg`]) {
        const { res, text } = await call(p);
        expect([200, 404]).toContain(res.status);
        if (res.status === 200) {
          expect(res.headers.get('content-type')).toContain('image/svg+xml');
          expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
          expect(text).not.toMatch(/<script|onload=|javascript:/i);
        }
      }
      const og = await app(new Request(`http://localhost:8787/api/og/u/${encodeURIComponent(login)}.png`));
      expect([200, 404]).toContain(og.status);
      if (og.status === 200) expect(og.headers.get('content-type')).toBe('image/png');
    }
  });

  it('a display name full of markup and XML-illegal characters leaves a well-formed card', () => {
    const d: RatingCardData = { state: 'rated', login: 'x', name: `${XSS}\u0000\u0008\u001f￾${'😀'.repeat(20)}`, rating: 1500, tier: { key: 'vine', name: XSS }, events: 9, peak: 1600, topPercent: 5, speed: 1400, brevity: 1300, streak: 3, spark: [1200, 1300, 1500], mosaic: null, promotion: null };
    const svg = statsCardSvg(d);
    // eslint-disable-next-line no-control-regex
    expect(svg).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/);
    const stripped = svg.replace(/<\/?[A-Za-z][^<>]*>/g, '');
    expect(stripped).not.toMatch(/[<>]/);
    expect(svg).not.toContain('<script');
    expect((svg.match(/<(?!\/)[A-Za-z]/g) ?? []).length).toBe((svg.match(/<\/[A-Za-z]|\/>/g) ?? []).length);
  });
});

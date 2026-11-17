// K3: briefs on the server. Secret seeds, hidden farms, par from the reference over every farm, and the lazy closing pass.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE_RULES_VERSION, RULES_VERSION, SETUP_BRIEF, SETUP_VERSION, challengeSetup, createWorld, dailySeed, drawBrief, finalOf, replayWithGoal } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createRun } from '../../lang/src/index.ts';
import { verifySource } from '../../lang/src/verify.ts';
import type { VerifyRequest } from '../../lang/src/verify.ts';
import { createApp, createDb } from '../src/index.ts';
import type { Db } from '../src/index.ts';
import { briefPar, briefSeed, challengeSalt, siblingSeeds } from '../src/brief.ts';
import { REFERENCE_SOURCE } from '../src/reference.ts';
import type { SourceVerifier } from '../src/verify-client.ts';
import { DAY_MS } from '../src/game.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const SALT = 'test-salt-A';
const NOW = Date.UTC(2026, 11, 5, 12);
const ID = 'd-2026-12-05';

let db: Db;
let now = NOW;
let app: (request: Request) => Promise<Response>;
let calls: VerifyRequest[] = [];
let verify: SourceVerifier = async (r) => { calls.push(r); return verifySource(r); };
const make = (env: Record<string, string> = { CHALLENGE_SALT: SALT }, setupVersion: number | null = SETUP_BRIEF) =>
  createApp({ db, env: { TENDRIL_DEV_AUTH: '1', ...env }, setupVersion: setupVersion ?? undefined, now: () => now, verifySource: (r) => verify(r) });
beforeEach(() => {
  now = NOW; calls = [];
  verify = async (r) => { calls.push(r); return verifySource(r); };
  db = createDb({ url: ':memory:' });
  app = make();
});
afterEach(() => db.close());

async function call(path: string, body?: unknown, token?: string) {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await app(new Request(`http://localhost:8787/api${path}`, { method: body !== undefined ? 'POST' : 'GET', headers, body: body !== undefined ? JSON.stringify(body) : undefined }));
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}
const login = async (name: string): Promise<string> => (await call('/dev/login', { displayName: name })).json.token;
const logFor = (source: string, c: Json): LogEntry[] => {
  const run = createRun(createWorld({ id: c.id, seed: c.seed }, challengeSetup(c.kind, c.seed, c.setupVersion, undefined, c.rulesVersion).setup), source);
  run.step(c.ticks);
  return run.pending.filter((a) => a[0] < c.ticks);
};
/** Fixed-FNV continuation: what anyone could compute from the public seed if sibling seeds were a plain hash of salt, id and a suffix. */
const fnvContinue = (state: number, suffix: string): number => { let h = state; for (const b of new TextEncoder().encode(suffix)) { h ^= b; h = Math.imul(h, 0x01000193); } return h >>> 0; };

describe('secret seeds', () => {
  it('a brief daily takes its seed from the salt, not from the date', async () => {
    const c = (await call('/challenges/today')).json;
    expect(c).toMatchObject({ id: ID, setupVersion: SETUP_BRIEF, seed: briefSeed(SALT, ID) });
    expect(c.seed).not.toBe(dailySeed('2026-12-05'));
    expect(briefSeed('another-salt', ID)).not.toBe(c.seed);
    const [row] = await db.query<{ seed: number; setup_v: number }>('SELECT seed, setup_v FROM challenges WHERE id = ?', [ID]);
    expect(row).toEqual({ seed: c.seed, setup_v: SETUP_BRIEF });
  });

  it('sibling seeds cannot be derived from the visible seed', () => {
    const visible = briefSeed(SALT, ID);
    const sib = siblingSeeds(SALT, { id: ID, kind: 'daily', setup_v: SETUP_BRIEF });
    expect(sib).toHaveLength(2);
    // A plain hash of salt:id:hN would be the visible seed's hash state continued with ":hN". Ours is not.
    expect(sib[0]).not.toBe(fnvContinue(visible, ':h1'));
    expect(sib[1]).not.toBe(fnvContinue(visible, ':h2'));
    expect(new Set([visible, ...sib]).size).toBe(3);
    // Different salt, same id: nothing carries over.
    expect(siblingSeeds('another-salt', { id: ID, kind: 'daily', setup_v: SETUP_BRIEF })).not.toEqual(sib);
  });

  it('falls back to a salt derived from the Turso token, and refuses a brief with no salt at all', async () => {
    expect(challengeSalt({ TURSO_AUTH_TOKEN: 'tok' })).toMatch(/^[0-9a-f]{64}$/);
    expect(challengeSalt({ CHALLENGE_SALT: 'x', TURSO_AUTH_TOKEN: 'tok' })).toBe('x');
    expect(challengeSalt({})).toBe('');
    app = make({}, SETUP_BRIEF);
    const r = await call('/challenges/today');
    expect(r.status).toBe(503);
    expect(await db.query('SELECT id FROM challenges')).toHaveLength(0);
  });

  it('publishes the sibling seeds only after the challenge closed', async () => {
    const open = (await call('/challenges/today')).json;
    expect(open).toMatchObject({ hiddenFarms: 2, siblingSeeds: null });
    now = NOW + DAY_MS; // closed at midnight
    const closed = (await call(`/challenges/${ID}`)).json;
    expect(closed.siblingSeeds).toEqual([briefSeed(SALT, ID, 1), briefSeed(SALT, ID, 2)]);
  });
});

describe('the brief on a challenge', () => {
  it('serves the drawn brief, the budget and 2 hidden farms; par is 90% of the reference mean over all three farms', async () => {
    const c = (await call('/challenges/today')).json;
    const drawn = drawBrief('daily', c.seed).brief;
    expect(c.brief).toEqual({ goal: drawn.goal, twists: drawn.twists, notice: drawn.notice, labels: drawn.labels });
    expect(c.ticks).toBe(drawn.ticks);
    const seeds = [c.seed, briefSeed(SALT, ID, 1), briefSeed(SALT, ID, 2)];
    const scores = seeds.map((farmSeed) => { const r = verifySource({ source: REFERENCE_SOURCE, challengeId: ID, kind: 'daily', seed: c.seed, farmSeed, ticks: c.ticks, rulesVersion: c.rulesVersion, setupVersion: SETUP_BRIEF }); return r.ok ? r.score : -1; });
    expect(scores.every((s) => s >= 0)).toBe(true);
    expect(c.par).toBe(briefPar(scores));
    expect(c.par).toBeGreaterThanOrEqual(1);
    expect(calls).toHaveLength(3);
    expect(calls.map((r) => r.farmSeed)).toEqual(seeds);
    expect((await call('/challenges/today')).json.par).toBe(c.par); // stored: no second measurement
    expect(calls).toHaveLength(3);
  });

  it('opens nothing when par cannot be measured, rather than store a wrong one', async () => {
    verify = async () => { throw new Error('down'); };
    expect((await call('/challenges/today')).status).toBe(503);
    expect(await db.query('SELECT id FROM challenges')).toHaveLength(0);
    verify = async (r) => verifySource(r);
    expect((await call('/challenges/today')).status).toBe(200);
  });

  it('seasons have 4 hidden farms and the season brief', async () => {
    const c = (await call('/challenges/week')).json;
    expect(c).toMatchObject({ kind: 'season', hiddenFarms: 4, setupVersion: SETUP_BRIEF });
    expect(c.brief.twists).toHaveLength(2);
    expect(c.seed).toBe(briefSeed(SALT, c.id));
    expect(calls).toHaveLength(5);
  });
});

describe('old challenges are unchanged', () => {
  it('without a brief setup the seed, setup version and info are exactly as before', async () => {
    app = make({}, SETUP_VERSION); // no salt, version pinned to the old one: a pre-brief day needs neither
    const c = (await call('/challenges/today')).json;
    expect(c).toMatchObject({ seed: dailySeed('2026-12-05'), setupVersion: SETUP_VERSION, brief: null, hiddenFarms: 0, siblingSeeds: null });
    now = NOW + DAY_MS;
    expect((await call(`/challenges/${ID}`)).json.siblingSeeds).toBeNull();
  });

  it('a plain entry has no score or final score, and is not provisional', async () => {
    app = make({}, SETUP_VERSION);
    const c = (await call('/challenges/today')).json;
    const token = await login('Old');
    const r = await call(`/challenges/${c.id}/entries`, { rulesVersion: c.rulesVersion, actions: logFor(REFERENCE_SOURCE, c) }, token);
    expect(r.status).toBe(200);
    expect(r.json.score).toBeNull();
    const board = (await call(`/challenges/${c.id}/board`)).json;
    expect(board.entries[0]).toMatchObject({ score: null, finalScore: null, finalParTick: null, provisional: false });
  });
});

describe('verify with a farm seed', () => {
  const festivalSalt = (() => { for (let i = 0; ; i++) { const s = `salt-${i}`; if (drawBrief('daily', briefSeed(s, ID)).brief.goal.kind === 'festival') return s; } })();

  it('runs the same brief on another world, and scores by the goal', () => {
    const seed = briefSeed(festivalSalt, ID);
    const base = { source: REFERENCE_SOURCE, challengeId: ID, kind: 'daily' as const, seed, ticks: 3000, rulesVersion: RULES_VERSION, setupVersion: SETUP_BRIEF };
    const a = verifySource(base), b = verifySource({ ...base, farmSeed: briefSeed(festivalSalt, ID, 1) }), same = verifySource({ ...base, farmSeed: seed });
    expect(a.ok && b.ok && same.ok).toBe(true);
    if (!a.ok || !b.ok || !same.ok) return;
    expect(same.logHash).toBe(a.logHash); // farmSeed = seed is the visible farm
    expect(a.score).toBeLessThanOrEqual(1000); // festival: filled permille, not coins
    expect(a.parTick).toBeNull(); // no par asked
    const withPar = verifySource({ ...base, par: 1 });
    expect(withPar.ok && withPar.parTick !== null).toBe(true);
  });
});

describe('submissions and the closing pass', () => {
  async function submitReference(name: string, c: Json): Promise<{ token: string; entryId: string; result: Json }> {
    const token = await login(name);
    const r = await call(`/challenges/${c.id}/entries`, { rulesVersion: c.rulesVersion, actions: logFor(REFERENCE_SOURCE, c), source: REFERENCE_SOURCE, sourcePublic: false }, token);
    expect(r.status).toBe(200);
    return { token, entryId: r.json.entryId, result: r.json };
  }
  const entryRow = async (id: string) => (await db.query<Json>('SELECT score, net_worth, par_tick, final_score, final_par_tick, hidden_done FROM entries WHERE id = ?', [id]))[0]!;

  it('scores the visible farm by the goal, stores it, and marks the board provisional', async () => {
    const c = (await call('/challenges/today')).json;
    const { entryId, result } = await submitReference('Ann', c);
    const { setup, brief } = challengeSetup('daily', c.seed, SETUP_BRIEF, undefined, c.rulesVersion);
    const expected = replayWithGoal(createWorld({ id: c.id, seed: c.seed }, setup), logFor(REFERENCE_SOURCE, c), c.ticks, brief!.goal, c.par);
    expect(result.score).toBe(expected.score);
    expect(await entryRow(entryId)).toMatchObject({ score: expected.score, net_worth: expected.score, par_tick: expected.parTick, hidden_done: 0, final_score: null });
    const board = (await call(`/challenges/${c.id}/board`)).json;
    expect(board.entries[0]).toMatchObject({ entryId, score: expected.score, value: expected.score, provisional: true, finalScore: null });
  });

  it('after close, runs each verified program on the hidden farms and stores final_score and final_par_tick', async () => {
    const c = (await call('/challenges/today')).json;
    const { entryId } = await submitReference('Ann', c);
    const visible = await entryRow(entryId);
    calls = [];
    now = NOW + DAY_MS + 1000;
    const board = (await call(`/challenges/${c.id}/board`)).json;
    const hiddenRuns = calls.filter((r) => r.farmSeed !== undefined);
    expect(hiddenRuns.map((r) => r.farmSeed).sort()).toEqual([briefSeed(SALT, ID, 1), briefSeed(SALT, ID, 2)].sort());
    const scores = [visible.score], parTicks = [visible.par_tick];
    for (const r of hiddenRuns) { const v = verifySource(r); if (v.ok) { scores.push(v.score); parTicks.push(v.parTick); } }
    const want = finalOf(scores, parTicks, c.ticks, c.par);
    expect(await entryRow(entryId)).toMatchObject({ hidden_done: 1, final_score: want.finalScore, final_par_tick: want.finalParTick });
    expect(board.entries).toHaveLength(1);
    // Done: a marker stops further work, and the next request makes no verify call at all.
    calls = [];
    const again = (await call(`/challenges/${c.id}/board`)).json;
    expect(calls).toHaveLength(0);
    expect(again.entries[0]).toMatchObject({ provisional: false, finalScore: want.finalScore, finalParTick: want.finalParTick });
  });

  it('a program that fails on a hidden farm scores 0 there', async () => {
    const c = (await call('/challenges/today')).json;
    const { entryId } = await submitReference('Ann', c);
    const visible = await entryRow(entryId);
    verify = async (r) => (r.farmSeed === briefSeed(SALT, ID, 1) ? { ok: false, reason: 'timeout', message: 'too slow' } : verifySource(r));
    now = NOW + DAY_MS + 1000;
    await call(`/challenges/${c.id}/board`);
    const other = verifySource({ source: REFERENCE_SOURCE, challengeId: ID, kind: 'daily', seed: c.seed, farmSeed: briefSeed(SALT, ID, 2), ticks: c.ticks, rulesVersion: c.rulesVersion, setupVersion: SETUP_BRIEF, par: c.par });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const want = finalOf([visible.score, 0, other.score], [visible.par_tick, null, other.parTick], c.ticks, c.par);
    expect(await entryRow(entryId)).toMatchObject({ hidden_done: 1, final_score: want.finalScore, final_par_tick: want.finalParTick });
  });

  it('a verify outage leaves the entry for a later request', async () => {
    const c = (await call('/challenges/today')).json;
    const { entryId } = await submitReference('Ann', c);
    verify = async () => { throw new Error('down'); };
    now = NOW + DAY_MS + 1000;
    expect((await call(`/challenges/${c.id}/board`)).status).toBe(200);
    expect(await entryRow(entryId)).toMatchObject({ hidden_done: 0, final_score: null });
    verify = async (r) => verifySource(r);
    now += 61_000;
    await call(`/challenges/${c.id}/board`);
    expect(await entryRow(entryId)).toMatchObject({ hidden_done: 1 });
  });

  it('checks a bounded number of entries per request', async () => {
    const c = (await call('/challenges/today')).json;
    const ids: string[] = [];
    for (const n of ['A1', 'A2', 'A3', 'A4', 'A5']) ids.push((await submitReference(n, c)).entryId);
    now = NOW + DAY_MS + 1000;
    await call(`/challenges/${c.id}/board`);
    const done = async () => (await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM entries WHERE hidden_done = 1'))[0]!.n;
    expect(await done()).toBe(3);
    now += 61_000;
    await call(`/challenges/${c.id}/board`);
    expect(await done()).toBe(5);
  });

  it('log-only entries never get a hidden check, and a brief duel has no hidden farms', async () => {
    const c = (await call('/challenges/today')).json;
    const token = await login('Logger');
    await call(`/challenges/${c.id}/entries`, { rulesVersion: c.rulesVersion, actions: logFor(REFERENCE_SOURCE, c) }, token);
    calls = [];
    now = NOW + DAY_MS + 1000;
    await call(`/challenges/${c.id}/board`);
    expect(calls).toHaveLength(0);
    const duel = await call('/duels', { seed: c.seed, ticks: null, from: c.id }, token);
    expect(duel.status).toBe(201);
    const d = (await call(`/challenges/${duel.json.challengeId}`)).json;
    expect(d).toMatchObject({ kind: 'duel', setupVersion: SETUP_BRIEF, par: c.par, ticks: c.ticks, hiddenFarms: 0, brief: c.brief });
    expect(d.siblingSeeds).toBeNull(); // duels never close
  });
});

describe('constants', () => {
  it('the K3 tests run against rules that make the base version differ from the brief one', () => {
    expect(BASE_RULES_VERSION).toBeLessThan(RULES_VERSION);
  });
});

// F1: challenges generate themselves. Setup comes from the seed, par comes from the reference program,
// and challenges created before modifiers keep replaying exactly as they did.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAILY_PAR, PAR_MIN, BASE_RULES_VERSION, SETUP_LEGACY, SETUP_VERSION, challengeSetup, createWorld, dailySeed, hashWorld, parFromReference, replayWithPar } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createRun } from '../../lang/src/index.ts';
import { verifySource } from '../../lang/src/verify.ts';
import { createApp, createDb } from '../src/index.ts';
import type { Db } from '../src/index.ts';
import { challengeInfo, loadChallenge, marketOf } from '../src/arena.ts';
import { challengeScenario } from '../../client/src/challenge-setup.ts';
import { REFERENCE_SOURCE } from '../src/reference.ts';
import type { SourceVerifier } from '../src/verify-client.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const TODAY = '2026-12-05';
const NOW = Date.UTC(2026, 11, 5, 12);

let db: Db;
let app: (request: Request) => Promise<Response>;
let verify: SourceVerifier | undefined;
let verifyCalls = 0;
beforeEach(() => {
  verify = async (r) => { verifyCalls++; return verifySource(r); }; verifyCalls = 0;
  db = createDb({ url: ':memory:' });
  app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1' }, now: () => NOW, verifySource: (r) => (verify ? verify(r) : Promise.reject(new Error('down'))) });
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
const logOf = (source: string, seed: number, version: number, ticks: number): LogEntry[] => {
  const run = createRun(createWorld({ id: 'x', seed }, challengeSetup('daily', seed, version).setup), source);
  run.step(ticks);
  return run.pending.filter((a) => a[0] < ticks);
};

describe('reference source', () => {
  it('is a copy of the bundled daily.sprout example', () => {
    expect(REFERENCE_SOURCE).toBe(readFileSync(new URL('../../lang/examples/daily.sprout', import.meta.url), 'utf8').trimEnd() + '\n');
  });
});

describe('a daily that creates itself', () => {
  it('takes its setup from the seed, and par from the reference program run on that exact world', async () => {
    const c = (await call('/challenges/today')).json;
    const seed = dailySeed(TODAY);
    const cs = challengeSetup('daily', seed);
    expect(c).toMatchObject({ id: `d-${TODAY}`, seed, ticks: cs.ticks, setupVersion: SETUP_VERSION, rulesVersion: BASE_RULES_VERSION });
    const ref = verifySource({ source: REFERENCE_SOURCE, challengeId: c.id, kind: 'daily', seed, ticks: c.ticks, rulesVersion: BASE_RULES_VERSION, setupVersion: SETUP_VERSION });
    expect(ref.ok && c.par).toBe(ref.ok ? parFromReference(ref.netWorth!) : -1);
    expect(verifyCalls).toBe(1);
    // The same row is served from the database afterwards: no second reference run, par never moves.
    expect((await call('/challenges/today')).json.par).toBe(c.par);
    expect(verifyCalls).toBe(1);
  });

  it('the reference program reaches the par it set, and the server agrees on the same setup', async () => {
    const c = (await call('/challenges/today')).json;
    const actions = logOf(REFERENCE_SOURCE, c.seed, c.setupVersion, c.ticks);
    const user = (await call('/dev/login', { displayName: 'Ref' })).json;
    const r = await call(`/challenges/${c.id}/entries`, { rulesVersion: BASE_RULES_VERSION, actions }, user.token);
    expect(r.status).toBe(200);
    expect(r.json.parTick).not.toBeNull();
    expect(r.json.netWorth).toBeGreaterThanOrEqual(c.par);
  });

  it('falls back to the DAILY_PAR constant when the check cannot be made, and still opens', async () => {
    verify = undefined;
    const c = (await call('/challenges/today')).json;
    expect(c.par).toBe(DAILY_PAR);
    expect(c.setupVersion).toBe(SETUP_VERSION);
  });

  it('ignores a verify answer without a usable net worth', async () => {
    verify = async () => ({ ok: true, tokens: 1, logHash: 'x', actions: 0 });
    expect((await call('/challenges/today')).json.par).toBe(DAILY_PAR);
    expect(PAR_MIN).toBeLessThan(DAILY_PAR);
  });

  it('a duel made from a daily seed shares its setup and gets its own par', async () => {
    const user = (await call('/dev/login', { displayName: 'Duelist' })).json;
    const seed = dailySeed(TODAY);
    const made = await call('/duels', { seed, ticks: challengeSetup('duel', seed).ticks }, user.token);
    expect(made.status).toBe(201);
    const info = (await call(`/challenges/${made.json.challengeId}`)).json;
    expect(info).toMatchObject({ kind: 'duel', seed, setupVersion: SETUP_VERSION });
    expect(info.par).toBeGreaterThanOrEqual(PAR_MIN);
  });
});

describe('old challenges', () => {
  it('rows created before migration 006 report setupVersion 0 and still replay on the plain farm', async () => {
    const seed = dailySeed('2026-11-12');
    await call('/stats'); // applies the migrations
    // A row exactly as the previous schema stored it (no setup_v given, so the column default applies).
    await db.execute('INSERT INTO challenges (id, kind, number, seed, ticks, par, opens_at, closes_at, created_by, rules_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['d-2026-12-05', 'daily', 5, seed, 3000, DAILY_PAR, Date.UTC(2026, 11, 5), Date.UTC(2026, 11, 6), null, BASE_RULES_VERSION]);
    const c = (await call('/challenges/d-2026-12-05')).json;
    expect(c).toMatchObject({ setupVersion: 0, ticks: 3000, par: DAILY_PAR });
    expect(verifyCalls).toBe(0);
    const actions = logOf(REFERENCE_SOURCE, seed, SETUP_LEGACY, 3000);
    const user = (await call('/dev/login', { displayName: 'Old' })).json;
    const r = await call(`/challenges/${c.id}/entries`, { rulesVersion: BASE_RULES_VERSION, actions }, user.token);
    expect(r.status).toBe(200);
    const plain = replayWithPar(createWorld({ id: c.id, seed }, challengeSetup('daily', seed, SETUP_LEGACY).setup), actions, 3000, DAILY_PAR);
    expect(r.json.netWorth).toBe(plain.netWorth);
    expect(r.json.parTick).toBe(plain.parTick);
  });
});

describe('client and server agree on the starting world', () => {
  it('1,000 random dates: the server row, the API info and the client scenario build the same world and tick budget', async () => {
    await call('/stats'); // applies the migrations
    let x = 123456789;
    const next = (n: number): number => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const now = Date.UTC(2026, 11, 1) + (i * 3 + next(3)) * 86_400_000 + next(86_400_000); // 1,000 distinct dates over ~8 years
      const row = await loadChallenge(db, 'today', now);
      seen.add(row.id);
      const info = await challengeInfo(db, row);
      const server = createWorld({ id: row.id, seed: row.seed }, challengeSetup(row.kind, row.seed, row.setup_v, marketOf(row)).setup);
      const scenario = challengeScenario(info);
      const client = createWorld({ id: scenario.farmId, seed: info.seed }, scenario.setup);
      expect(hashWorld(client)).toBe(hashWorld(server));
      expect(client.weatherBias).toBe(server.weatherBias);
      expect(scenario.tickLimit).toBe(row.ticks);
      expect(info.setupVersion).toBe(SETUP_VERSION);
    }
    expect(seen.size).toBe(1000);
  });
});

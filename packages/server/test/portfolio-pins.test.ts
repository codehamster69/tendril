import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETUP_LEGACY, challengeSetup, createWorld, dailySeed, BASE_RULES_VERSION } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createRun } from '../../lang/src/index.ts';
import { countTokens } from '../../lang/src/tokens.ts';
import { verifySource } from '../../lang/src/verify.ts';
import { createApp, createDb } from '../src/index.ts';
import type { Db, Profile } from '../src/index.ts';
import { DAY_MS } from '../src/game.ts';
import type { SourceVerifier } from '../src/verify-client.ts';

type Login = { token: string; profile: Profile };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BASE = Date.UTC(2026, 10, 12, 12, 0, 0);
const DAILY = 'd-2026-11-12';
const daily = readFileSync(new URL('../../lang/examples/daily.sprout', import.meta.url), 'utf8');
/** Same moves as `daily`, three more tokens: a worse Brevity score for the same run. */
const wordy = `x = 1\n${daily}`;

/** The log a program produces on today's daily, made the way the client makes it. */
function logOf(source: string, id = DAILY, seed = dailySeed('2026-11-12')): LogEntry[] {
  const run = createRun(createWorld({ id, seed }, challengeSetup('daily', seed, SETUP_LEGACY).setup), source);
  run.step(3000);
  return run.pending.filter((a) => a[0] < 3000);
}

let db: Db;
let app: (request: Request) => Promise<Response>;
let time: number;
let verify: SourceVerifier | undefined;
const realVerifier: SourceVerifier = async (r) => verifySource(r);

async function call(path: string, o: { token?: string; body?: unknown; method?: string } = {}) {
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await app(new Request(`http://localhost:8787/api${path}`, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }));
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}
async function login(name: string): Promise<Login> { return (await call('/dev/login', { body: { displayName: name } })).json as Login; }
const enter = (token: string, body: Json, id = DAILY) => call(`/challenges/${id}/entries`, { token, body: { rulesVersion: BASE_RULES_VERSION, ...body } });

let ann: Login, bo: Login;
beforeEach(async () => {
  time = BASE; verify = realVerifier;
  db = createDb({ url: ':memory:' });
  app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1', PUBLIC_ORIGIN: 'https://tendril.example' }, setupVersion: 0, now: () => time, verifySource: (r) => (verify ? verify(r) : Promise.reject(new Error('down'))) });
  ann = await login('Ann'); bo = await login('Bo');
});
afterEach(() => db.close());


const put = (token: string | undefined, entryIds: unknown) => call('/players/me/pinned', { token, method: 'PUT', body: { entryIds } });
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe('pinned programs and garden days (R3b)', () => {
  it('pins only own, published, closed programs; shows rank and tokens; max 3; replaces the list', async () => {
    const mine = await enter(ann.token, { actions: logOf(daily), source: daily, sourcePublic: true });
    const priv = await enter(bo.token, { actions: logOf(wordy), source: wordy, sourcePublic: false });
    const cara = await login('Cara');
    const theirs = await enter(cara.token, { actions: logOf(daily), source: daily, sourcePublic: true });
    const mineId = mine.json.entryId as string;
    // open challenge: not pinnable yet
    expect((await put(ann.token, [mineId])).status).toBe(422);
    time = BASE + 2 * DAY_MS;
    expect((await put(undefined, [mineId])).status).toBe(401);
    expect((await put(ann.token, [theirs.json.entryId])).status).toBe(422);
    expect((await put(ann.token, ['nope'])).status).toBe(422);
    expect((await put(ann.token, [mineId, mineId])).status).toBe(422);
    expect((await put(ann.token, [mineId, 'a', 'b', 'c'])).status).toBe(422);
    expect((await put(ann.token, 'x')).status).toBe(400);
    expect((await call('/players/me/pinned', { token: ann.token, method: 'PUT', body: { entryIds: [], extra: 1 } })).status).toBe(400);
    const ok = await put(ann.token, [mineId]);
    expect(ok.status).toBe(200);
    expect(ok.json.pinned).toEqual([expect.objectContaining({ entryId: mineId, challengeId: DAILY, kind: 'daily', tokens: countTokens(daily), players: 3 })]);
    expect(ok.json.pinned[0].rank).toBeGreaterThanOrEqual(1);
    const page = await call('/players/' + ann.profile.login);
    expect(page.json.pinned.map((p: Json) => p.entryId)).toEqual([mineId]);
    expect((await call('/players/' + ann.profile.login, { token: bo.token })).json.pinned).toHaveLength(1);
    // unpublished program can never be pinned
    expect(priv.status).toBe(200);
    expect((await put(bo.token, [priv.json.entryId])).status).toBe(422);
    expect((await put(ann.token, [])).json.pinned).toEqual([]);
    expect((await call('/players/' + ann.profile.login)).json.pinned).toEqual([]);
  });

  it('hides a pin while its challenge is not settled', async () => {
    const mine = await enter(ann.token, { actions: logOf(daily), source: daily, sourcePublic: true });
    time = BASE + 2 * DAY_MS;
    await put(ann.token, [mine.json.entryId]);
    await db.execute('UPDATE challenges SET closes_at = ? WHERE id = ?', [time + DAY_MS, DAILY]);
    expect((await call('/players/' + ann.profile.login)).json.pinned).toEqual([]);
  });

  it('returns played days from the last 140 days only, as ascending UTC dates', async () => {
    await enter(ann.token, { actions: logOf(daily), source: daily });
    expect((await call('/players/' + ann.profile.login)).json.days).toEqual(['2026-11-12']);
    time = BASE + 200 * DAY_MS;
    expect((await call('/players/' + ann.profile.login)).json.days).toEqual([]);
    time = BASE + 100 * DAY_MS;
    expect((await call('/players/' + ann.profile.login)).json.days).toEqual([isoDay(BASE)]);
    expect((await call('/players/' + bo.profile.login)).json.days).toEqual([]);
  });
});

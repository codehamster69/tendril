// D1: the humans vs models board. A model entry must carry a program the server ran and must publish it.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETUP_LEGACY, challengeSetup, createWorld, dailySeed, RULES_VERSION } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createRun } from '../../lang/src/index.ts';
import { verifySource } from '../../lang/src/verify.ts';
import { createApp, createDb } from '../src/index.ts';
import type { Db, Profile } from '../src/index.ts';
import { MODEL_NEEDS_SOURCE } from '../src/validation.ts';

type Login = { token: string; profile: Profile };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BASE = Date.UTC(2026, 10, 12, 12, 0, 0);
const DAILY = 'd-2026-11-12';
const daily = readFileSync(new URL('../../lang/examples/daily.sprout', import.meta.url), 'utf8');
const wordy = `x = 1\n${daily}`;

function logOf(source: string): LogEntry[] {
  const seed = dailySeed('2026-11-12');
  const run = createRun(createWorld({ id: DAILY, seed }, challengeSetup('daily', seed, SETUP_LEGACY).setup), source);
  run.step(3000);
  return run.pending.filter((a) => a[0] < 3000);
}

let db: Db;
let app: (request: Request) => Promise<Response>;
let verifyCalls: number;
let up: boolean;

async function call(path: string, o: { token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await app(new Request(`http://localhost:8787/api${path}`, { method: o.body !== undefined ? 'POST' : 'GET', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }));
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}
const login = async (name: string): Promise<Login> => (await call('/dev/login', { body: { displayName: name } })).json as Login;
const enter = (token: string, body: Json) => call(`/challenges/${DAILY}/entries`, { token, body: { rulesVersion: RULES_VERSION, ...body } });
const asModel = (source: string | undefined, extra: Json = {}) => ({ actions: logOf(source ?? daily), authorKind: 'model', model: 'test-model-1', ...(source === undefined ? {} : { source, sourcePublic: true }), ...extra });

let ann: Login, bo: Login, robot: Login;
beforeEach(async () => {
  verifyCalls = 0; up = true;
  db = createDb({ url: ':memory:' });
  app = createApp({
    db, env: { TENDRIL_DEV_AUTH: '1', PUBLIC_ORIGIN: 'https://tendril.example' }, setupVersion: 0, now: () => BASE,
    verifySource: async (r) => { verifyCalls++; if (!up) throw new Error('down'); return verifySource(r); },
  });
  ann = await login('Ann'); bo = await login('Bo'); robot = await login('Robot');
});
afterEach(() => db.close());

describe('refusing a model entry without verified, published source', () => {
  it('refuses no source, an unpublished source, and an explicit sourcePublic false, before running anything', async () => {
    for (const body of [asModel(undefined), asModel(daily, { sourcePublic: false }), asModel(daily, { sourcePublic: undefined }), asModel(daily, { source: null }), asModel(daily, { source: undefined })]) {
      const r = await enter(robot.token, body);
      expect(r.status).toBe(422);
      expect(r.json.error).toBe(MODEL_NEEDS_SOURCE);
    }
    expect(verifyCalls).toBe(0);
    expect((await call(`/challenges/${DAILY}`)).json.players).toBe(0);
  });

  it('refuses a program that does not produce the submitted log, and stores nothing', async () => {
    const r = await enter(robot.token, asModel(wordy, { actions: logOf(daily).slice(0, -1) }));
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/^Source /);
    expect((await call(`/challenges/${DAILY}/board?author=model`)).json.total).toBe(0);
  });

  it('refuses (503) rather than storing an unchecked model entry when the source check is down', async () => {
    up = false;
    const r = await enter(robot.token, asModel(daily));
    expect(r.status).toBe(503);
    expect((await call(`/challenges/${DAILY}`)).json.players).toBe(0);
  });

  it('accepts a verified, published one and shows it as a model with its name', async () => {
    const r = await enter(robot.token, asModel(daily));
    expect(r.status).toBe(200);
    const e = await call(`/entries/${r.json.entryId}`);
    expect(e.json).toMatchObject({ authorKind: 'model', model: 'test-model-1', sourceVerified: true, sourcePublic: true });
  });

  it('refuses a signed-out model entry, and malformed or abusive model names', async () => {
    expect((await call(`/challenges/${DAILY}/entries`, { body: { rulesVersion: RULES_VERSION, ...asModel(daily) } })).status).toBe(401);
    for (const model of ['', ' '.repeat(3) + '‮', 'x'.repeat(65), 'a\nb', 7, null, ['a']]) {
      expect((await enter(robot.token, asModel(daily, { model }))).status).toBe(422);
    }
    expect((await enter(robot.token, asModel(daily, { authorKind: 'Model' }))).status).toBe(422);
    expect((await enter(robot.token, asModel(daily, { tokens: 1 }))).status).toBe(422); // tokens are never taken from the client
    expect((await enter(ann.token, { actions: logOf(daily), model: 'test-model-1' })).status).toBe(422); // a human has no model name
    expect(verifyCalls).toBe(0);
  });

  it('cannot launder a human entry into a model by repeating its log without a program', async () => {
    const h = await enter(ann.token, { actions: logOf(daily) });
    expect(h.status).toBe(200);
    expect((await enter(ann.token, asModel(undefined))).status).toBe(422);
    expect((await call(`/entries/${h.json.entryId}`)).json.authorKind).toBe('human');
  });

  it('turns the same entry into a model entry when the same log comes back with a published program', async () => {
    const h = await enter(ann.token, { actions: logOf(daily) });
    const m = await enter(ann.token, asModel(daily));
    expect(m.status).toBe(200);
    expect(m.json.entryId).toBe(h.json.entryId);
    expect((await call(`/entries/${h.json.entryId}`)).json).toMatchObject({ authorKind: 'model', model: 'test-model-1', sourceVerified: true });
    expect((await call(`/challenges/${DAILY}/board?author=human`)).json.total).toBe(0);
  });
});

describe('the humans vs models board filter', () => {
  it('splits the same challenge into human and model boards, for every medal', async () => {
    await enter(ann.token, { actions: logOf(daily), source: daily, sourcePublic: false });
    await enter(bo.token, { actions: logOf(wordy), source: wordy });
    await enter(robot.token, asModel(daily));
    const names = async (q: string) => (await call(`/challenges/${DAILY}/board?${q}`)).json.entries.map((e: Json) => e.displayName);
    for (const medal of ['wealth', 'speed', 'brevity']) {
      expect(await names(`medal=${medal}&author=model`)).toEqual(['Robot']);
      expect((await names(`medal=${medal}&author=human`)).sort()).toEqual(['Ann', 'Bo']);
      expect((await names(`medal=${medal}`)).sort()).toEqual(['Ann', 'Bo', 'Robot']);
    }
    const m = (await call(`/challenges/${DAILY}/board?medal=brevity&author=model`)).json;
    expect(m).toMatchObject({ total: expect.any(Number) });
    expect(m.entries[0]).toMatchObject({ rank: 1, authorKind: 'model', model: 'test-model-1' });
    // Ranks inside a filter start at 1 for that filter: the model's own board, not its place among humans.
    const h = (await call(`/challenges/${DAILY}/board?medal=brevity&author=human`)).json;
    expect(h.entries.map((e: Json) => [e.rank, e.displayName])).toEqual([[1, 'Ann'], [1, 'Bo']]); // identical logs share a rank
  });

  it('rejects an unknown author filter', async () => {
    for (const a of ['robot', 'Model', '', 'human,model']) expect((await call(`/challenges/${DAILY}/board?author=${encodeURIComponent(a)}`)).status).toBe(400);
  });
});

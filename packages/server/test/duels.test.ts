import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RULES_VERSION } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createApp, createDb } from '../src/index.ts';
import type { Db, Profile } from '../src/index.ts';

type Login = { token: string; profile: Profile };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const SMALL: LogEntry[] = [[0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [7, 0, 3], [9, 0, 3], [300, 0, 4], [303, 0, 0, 3], [305, 0, 5], [306, 0, 8, 1, 4]];

let db: Db;
let app: (request: Request) => Promise<Response>;

async function call(path: string, o: { method?: string; token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await app(new Request(`http://localhost:8787/api${path}`, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }));
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : null) as Json };
}
const login = async (name: string): Promise<Login> => (await call('/dev/login', { body: { displayName: name } })).json as Login;
const enter = (id: string, token: string, actions: unknown = SMALL) => call(`/challenges/${id}/entries`, { token, body: { rulesVersion: RULES_VERSION, actions } });

let ann: Login, bo: Login, cy: Login;
let id: string;
beforeEach(async () => {
  db = createDb({ url: ':memory:' });
  app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1', PUBLIC_ORIGIN: 'https://tendril.example' }, now: () => Date.UTC(2026, 10, 12, 12) });
  [ann, bo, cy] = [await login('Ann'), await login('Bo'), await login('Cy')];
  id = (await call('/duels', { token: ann.token, body: { seed: 7 } })).json.challengeId as string;
});
afterEach(() => db.close());

describe('duel page and accept', () => {
  it('shows the challenger and their best run, signed out', async () => {
    expect((await call(`/duels/${id}`)).json).toMatchObject({ id, seed: 7, challenger: { displayName: 'Ann' }, entry: null, accepted: 0, viewer: null });
    const run = await enter(id, ann.token);
    const page = (await call(`/duels/${id}`)).json;
    expect(page.entry).toMatchObject({ entryId: run.json.entryId, netWorth: run.json.netWorth });
  });

  it('rejects non-duels and unknown duels', async () => {
    expect((await call('/duels/d-2026-11-12')).status).toBe(404);
    expect((await call('/duels/x-nonexist')).status).toBe(404);
  });

  it('accepting needs a run, is idempotent, and makes both players follow each other', async () => {
    await enter(id, ann.token);
    expect((await call(`/duels/${id}/accept`, { token: bo.token, body: {} })).status).toBe(409); // no run yet
    expect((await call(`/duels/${id}/accept`, { body: {} })).status).toBe(401);
    await enter(id, bo.token, []);
    const first = await call(`/duels/${id}/accept`, { token: bo.token, body: {} });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ accepted: true, changed: true, challenger: { displayName: 'Ann' } });
    expect((await call(`/duels/${id}/accept`, { token: bo.token, body: {} })).json.changed).toBe(false);
    expect((await call('/me/following', { token: bo.token })).json.players.map((p: Json) => p.displayName)).toEqual(['Ann']);
    expect((await call('/me/following', { token: ann.token })).json.players.map((p: Json) => p.displayName)).toEqual(['Bo']);
    expect((await call(`/duels/${id}`, { token: bo.token })).json).toMatchObject({ accepted: 1, viewer: { accepted: true, isChallenger: false } });
    expect((await call('/me/following', { token: cy.token })).json.players).toEqual([]);
  });

  it('the challenger cannot accept their own duel, and stats count created and accepted', async () => {
    await enter(id, ann.token);
    expect((await call(`/duels/${id}/accept`, { token: ann.token, body: {} })).status).toBe(422);
    expect((await call('/stats/duels')).json).toEqual({ created: 1, accepted: 0 });
    await enter(id, bo.token);
    await call(`/duels/${id}/accept`, { token: bo.token, body: {} });
    expect((await call('/stats/duels')).json).toEqual({ created: 1, accepted: 1 });
  });

  it('a friend who has run can read the challenger replay', async () => {
    const run = await enter(id, ann.token);
    expect((await call(`/entries/${run.json.entryId}/replay`, { token: bo.token })).status).toBe(403);
    await enter(id, bo.token);
    expect((await call(`/entries/${run.json.entryId}/replay`, { token: bo.token })).status).toBe(200);
  });
});

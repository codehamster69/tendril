import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETUP_LEGACY, challengeSetup, createWorld, dailySeed, RULES_VERSION } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createRun } from '../../lang/src/index.ts';
import { countTokens } from '../../lang/src/tokens.ts';
import { verifySource } from '../../lang/src/verify.ts';
import { createApp, createDb } from '../src/index.ts';
import type { Db, Profile } from '../src/index.ts';
import { DAY_MS } from '../src/game.ts';
import { SOURCE_MISMATCH, SOURCE_UNAVAILABLE } from '../src/arena.ts';
import { remoteVerifier } from '../src/verify-client.ts';
import type { SourceVerifier } from '../src/verify-client.ts';
import { handleVerify } from '../../lang/src/vercel-verify.ts';

type Login = { token: string; profile: Profile };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BASE = Date.UTC(2026, 10, 12, 12, 0, 0);
const DAILY = 'd-2026-11-12';
const daily = readFileSync(new URL('../../lang/examples/daily.sprout', import.meta.url), 'utf8');
/** Same moves as `daily`, three more tokens: a worse Brevity score for the same run. */
const wordy = `x = 1\n${daily}`;
/** Does nothing at all, so its log is empty and it never reaches par. */
const idle = 'x = 1\n';

/** The log a program produces on today's daily, made the way the client makes it. */
function logOf(source: string, id = DAILY, seed = dailySeed('2026-11-12')): LogEntry[] {
  const run = createRun(createWorld({ id, seed }, challengeSetup('daily', seed, SETUP_LEGACY).setup), source);
  run.step(3000);
  return run.pending.filter((a) => a[0] < 3000);
}

let db: Db;
let app: (request: Request) => Promise<Response>;
let time: number;
let verifyCalls: number;
let verify: SourceVerifier | undefined;
const realVerifier: SourceVerifier = async (r) => { verifyCalls++; return verifySource(r); };

async function call(path: string, o: { token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await app(new Request(`http://localhost:8787/api${path}`, { method: o.body !== undefined ? 'POST' : 'GET', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }));
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}
async function login(name: string): Promise<Login> { return (await call('/dev/login', { body: { displayName: name } })).json as Login; }
const enter = (token: string, body: Json, id = DAILY) => call(`/challenges/${id}/entries`, { token, body: { rulesVersion: RULES_VERSION, ...body } });

let ann: Login, bo: Login;
beforeEach(async () => {
  time = BASE; verifyCalls = 0; verify = realVerifier;
  db = createDb({ url: ':memory:' });
  app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1', PUBLIC_ORIGIN: 'https://tendril.example' }, setupVersion: 0, now: () => time, verifySource: (r) => (verify ? verify(r) : Promise.reject(new Error('down'))) });
  ann = await login('Ann'); bo = await login('Bo');
});
afterEach(() => db.close());

describe('submitting a program', () => {
  it('verifies a source that matches its log, stores it, and ranks Brevity', async () => {
    const actions = logOf(daily);
    const r = await enter(ann.token, { actions, source: daily });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ tokens: countTokens(daily), improved: true, ranks: { wealth: 1, speed: 1, brevity: 1 } });
    expect(r.json.parTick).not.toBeNull();
    const e = await call(`/entries/${r.json.entryId}`, { token: ann.token });
    expect(e.json).toMatchObject({ sourceVerified: true, sourcePublic: false, tokens: countTokens(daily) });
    expect(verifyCalls).toBe(1);
  });

  it('refuses a source that does not produce the submitted log, and stores nothing', async () => {
    const r = await enter(ann.token, { actions: logOf(daily), source: wordy.replace('wait 100', 'wait 90') });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe(SOURCE_MISMATCH);
    expect((await db.query('SELECT 1 FROM entries')).length).toBe(0);
    const empty = await enter(ann.token, { actions: [], source: daily });
    expect(empty.status).toBe(422);
  });

  it('refuses a source that was written for another seed', async () => {
    const other = logOf(daily, 'd-2026-11-11', dailySeed('2026-11-11'));
    expect((await enter(ann.token, { actions: other, source: daily })).status).toBe(422);
  });

  it('cannot be given a token count: the field is refused, only the server counts', async () => {
    const r = await enter(ann.token, { actions: logOf(daily), source: daily, tokens: 1 });
    expect(r.status).toBe(422);
    expect((await db.query('SELECT 1 FROM entries')).length).toBe(0);
  });

  it('counts tokens from the source it ran, not from anything the client says', async () => {
    const r = await enter(bo.token, { actions: logOf(wordy), source: wordy });
    expect(r.json.tokens).toBe(countTokens(daily) + 3);
  });

  it('refuses a program that does not compile', async () => {
    const r = await enter(ann.token, { actions: [], source: 'x = = 1\n' });
    expect(r.status).toBe(422);
    expect(r.json.error).toMatch(/^Source cannot be checked: Line 1/);
  });

  it('turns a program that exhausts the time limit into a clean refusal', async () => {
    verify = async (r) => verifySource(r, { deadlineMs: 50, now: ((t) => () => (t += 20))(0) });
    const spin = 'repeat forever:\n    x = 0\n    while x < 100000:\n        x = x + 1\n';
    const r = await enter(ann.token, { actions: [], source: spin });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('Source took too long to check');
  });

  it('answers 503 when the check cannot be made, and stores nothing', async () => {
    verify = undefined;
    const r = await enter(ann.token, { actions: logOf(daily), source: daily });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe(SOURCE_UNAVAILABLE);
    expect((await db.query('SELECT 1 FROM entries')).length).toBe(0);
    // A plain submission still works while the check is down.
    expect((await enter(ann.token, { actions: logOf(daily) })).status).toBe(200);
  });

  it('never calls the verifier for a submission without a program', async () => {
    expect((await enter(ann.token, { actions: logOf(daily) })).status).toBe(200);
    expect(verifyCalls).toBe(0);
  });

  it('keeps Brevity for programs that reach par: an empty program cannot win it', async () => {
    const r = await enter(ann.token, { actions: [], source: idle });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ tokens: countTokens(idle), parTick: null, ranks: { brevity: null } });
    const board = await call(`/challenges/${DAILY}/board?medal=brevity`);
    expect(board.json.entries).toEqual([]);
  });

  it('ranks the shorter program higher on the Brevity board', async () => {
    await enter(bo.token, { actions: logOf(wordy), source: wordy });
    await enter(ann.token, { actions: logOf(daily), source: daily });
    const board = await call(`/challenges/${DAILY}/board?medal=brevity`);
    expect(board.json.entries.map((e: Json) => [e.displayName, e.value])).toEqual([['Ann', countTokens(daily)], ['Bo', countTokens(daily) + 3]]);
  });

  it('adds the program to your own earlier entry instead of refusing the repeat', async () => {
    const actions = logOf(daily);
    const first = await enter(ann.token, { actions });
    expect(first.json.ranks.brevity).toBeNull();
    expect((await enter(ann.token, { actions })).status).toBe(409);
    const again = await enter(ann.token, { actions, source: daily, sourcePublic: true });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ entryId: first.json.entryId, tokens: countTokens(daily), ranks: { brevity: 1 } });
    expect((await db.query('SELECT 1 FROM entries')).length).toBe(1);
    // Once it has a program, sending the same log again is a plain repeat.
    expect((await enter(ann.token, { actions, source: daily })).status).toBe(409);
  });

  it('keeps the shorter verified program when the same moves come back with a longer one', async () => {
    expect((await enter(ann.token, { actions: logOf(daily), source: daily })).json.ranks.brevity).toBe(1);
    // Same moves again is a repeat of your own log, whatever program you attach.
    expect((await enter(ann.token, { actions: logOf(wordy), source: wordy })).status).toBe(409);
    const stored = await db.query<{ tokens: number }>('SELECT tokens FROM entries');
    expect(stored).toEqual([{ tokens: countTokens(daily) }]);
  });
});

describe('reading programs', () => {
  const put = async (who: Login, source: string, sourcePublic: boolean) => (await enter(who.token, { actions: logOf(source), source, sourcePublic })).json.entryId as string;
  const closeIt = () => { time = BASE + DAY_MS; };

  it('keeps every program hidden from others while the challenge is open', async () => {
    const id = await put(ann, daily, true);
    expect((await call(`/entries/${id}/source`)).status).toBe(403);
    expect((await call(`/entries/${id}/source`, { token: bo.token })).status).toBe(403);
    expect((await call(`/challenges/${DAILY}/sources`)).status).toBe(403);
    const mine = await call(`/entries/${id}/source`, { token: ann.token });
    expect(mine.status).toBe(200);
    expect(mine.json).toMatchObject({ source: daily, tokens: countTokens(daily), sourcePublic: true });
  });

  it('publishes only what the author ticked, once the challenge has closed', async () => {
    const shown = await put(ann, daily, true);
    const hidden = await put(bo, wordy, false);
    closeIt();
    const open = await call(`/entries/${shown}/source`);
    expect(open.status).toBe(200);
    expect(open.json).toMatchObject({ source: daily, player: { displayName: 'Ann' } });
    expect((await call(`/entries/${hidden}/source`)).status).toBe(403);
    expect((await call(`/entries/${hidden}/source`, { token: bo.token })).status).toBe(200); // the author still sees theirs
    const list = await call(`/challenges/${DAILY}/sources`);
    expect(list.status).toBe(200);
    expect(list.json.entries.map((e: Json) => e.entryId)).toEqual([shown]);
    expect(JSON.stringify(list.json)).not.toContain('x = 1');
  });

  it('404s for an entry with no stored program, and never exposes the source in the entry summary', async () => {
    const plain = (await enter(ann.token, { actions: logOf(daily) })).json.entryId as string;
    closeIt();
    expect((await call(`/entries/${plain}/source`, { token: ann.token })).status).toBe(404);
    const withSource = await put(bo, daily, true);
    expect(JSON.stringify((await call(`/entries/${withSource}`)).json)).not.toContain('repeat forever');
  });

  it('lets duel players read each other\'s published programs after both have entered', async () => {
    const duel = (await call('/duels', { token: ann.token, body: { seed: 7 } })).json.challengeId as string;
    const seed = 7;
    const actions = (() => { const run = createRun(createWorld({ id: duel, seed }, challengeSetup('duel', seed, SETUP_LEGACY).setup), daily); run.step(3000); return run.pending.filter((a) => a[0] < 3000); })();
    const annEntry = (await enter(ann.token, { actions, source: daily, sourcePublic: true }, duel)).json.entryId as string;
    expect((await call(`/entries/${annEntry}/source`, { token: bo.token })).status).toBe(403);
    expect((await enter(bo.token, { actions: [] }, duel)).status).toBe(200);
    expect((await call(`/entries/${annEntry}/source`, { token: bo.token })).status).toBe(200);
  });
});

describe('the remote verifier (main function -> verify function)', () => {
  const env = { TURSO_AUTH_TOKEN: 'turso-secret' };
  const request = { source: daily, challengeId: DAILY, kind: 'daily' as const, seed: dailySeed('2026-11-12'), ticks: 3000, rulesVersion: RULES_VERSION };
  it('reaches /api/verify with the shared secret and gets the same answer as running it in-process', async () => {
    const seen: string[] = [];
    const wire = (async (url: string, init: RequestInit) => { seen.push(`${init.method} ${url}`); return handleVerify(new Request(url, init), env); }) as unknown as typeof fetch;
    const answer = await remoteVerifier('https://tendril.example/', env, wire)(request);
    expect(answer).toEqual(verifySource(request));
    expect(seen).toEqual(['POST https://tendril.example/api/verify']);
  });
  it('fails (so the submit answers 503) when the secret does not match or the function is down', async () => {
    const wire = (async (url: string, init: RequestInit) => handleVerify(new Request(url, init), { TURSO_AUTH_TOKEN: 'someone-else' })) as unknown as typeof fetch;
    await expect(remoteVerifier('https://tendril.example', env, wire)(request)).rejects.toThrow();
    const down = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    await expect(remoteVerifier('https://tendril.example', env, down)(request)).rejects.toThrow();
  });
});

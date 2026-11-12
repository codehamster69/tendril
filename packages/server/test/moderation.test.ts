import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { challengeSetup, createWorld, dailySeed, RULES_VERSION } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createRun } from '../../lang/src/index.ts';
import { verifySource } from '../../lang/src/verify.ts';
import { createApp, createDb } from '../src/index.ts';
import type { Db, Profile } from '../src/index.ts';
import { DAY_MS } from '../src/game.ts';
import { HIDE_THRESHOLD, MIN_REPORTER_AGE_MS, REPORTS_PER_DAY } from '../src/moderation.ts';
import { MODEL_PATTERN } from '../src/validation.ts';

type Login = { token: string; profile: Profile };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BASE = Date.UTC(2026, 10, 12, 12, 0, 0);
const DAILY = 'd-2026-11-12';
const daily = readFileSync(new URL('../../lang/examples/daily.sprout', import.meta.url), 'utf8');
const SMALL: LogEntry[] = [[0, 0, 0, 1], [2, 0, 1], [5, 0, 2, 1], [7, 0, 3], [9, 0, 3], [300, 0, 4], [303, 0, 0, 3], [305, 0, 5], [306, 0, 8, 1, 4]];

function logOf(source: string): LogEntry[] {
  const seed = dailySeed('2026-11-12');
  const run = createRun(createWorld({ id: DAILY, seed }, challengeSetup('daily', seed).setup), source);
  run.step(3000);
  return run.pending.filter((a) => a[0] < 3000);
}

let db: Db;
let app: (request: Request) => Promise<Response>;
let time: number;

async function call(path: string, o: { token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await app(new Request(`http://localhost:8787/api${path}`, { method: o.body !== undefined ? 'POST' : 'GET', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }));
  const text = await res.text();
  return { status: res.status, text, json: (text ? JSON.parse(text) : null) as Json };
}
const login = async (name: string): Promise<Login> => (await call('/dev/login', { body: { displayName: name } })).json as Login;
const enter = (token: string, body: Json, id = DAILY) => call(`/challenges/${id}/entries`, { token, body: { rulesVersion: RULES_VERSION, ...body } });
const report = (token: string | undefined, entryId: string) => call(`/entries/${entryId}/report`, { token, body: {} });

/** A player whose account is `ageDays` old, optionally with a verified entry of their own. */
async function reporter(name: string, ageDays: number, withEntry = true): Promise<Login> {
  const l = await login(name);
  await db.execute('UPDATE users SET created_at = ? WHERE id = ?', [time - ageDays * DAY_MS, l.profile.id]);
  if (withEntry) expect((await enter(l.token, { actions: SMALL })).status).toBe(200);
  return l;
}

let author: Login;
let entryId: string;
beforeEach(async () => {
  time = BASE;
  db = createDb({ url: ':memory:' });
  app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1', PUBLIC_ORIGIN: 'https://tendril.example' }, now: () => time, verifySource: async (r) => verifySource(r) });
  author = await login('Author');
  const r = await enter(author.token, { actions: logOf(daily), source: daily, sourcePublic: true });
  expect(r.status).toBe(200);
  entryId = r.json.entryId;
});
afterEach(() => db.close());

const closed = () => { time = BASE + 2 * DAY_MS; }; // closed and past the legacy grace (D2 F1)
const visible = async () => (await call(`/entries/${entryId}/source`)).status === 200;
const listed = async () => ((await call(`/challenges/${DAILY}/sources`)).json.entries as Json[]).some((e) => e.entryId === entryId);

describe('hiding reported programs', () => {
  it('hides a program at the threshold and keeps its score and rank', async () => {
    const olds = [await reporter('R1', 8), await reporter('R2', 30), await reporter('R3', 9)];
    closed();
    expect(await visible()).toBe(true);
    for (const [i, r] of olds.entries()) {
      const res = await report(r.token, entryId);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ reported: true, changed: true, hidden: i + 1 >= HIDE_THRESHOLD });
      if (i + 1 < HIDE_THRESHOLD) expect(await visible()).toBe(true);
    }
    expect(await visible()).toBe(false);
    expect(await listed()).toBe(false);
    // The author still reads it, and the score is untouched.
    expect((await call(`/entries/${entryId}/source`, { token: author.token })).status).toBe(200);
    const board = (await call(`/challenges/${DAILY}/board?medal=wealth`)).json;
    expect(board.entries.some((e: Json) => e.entryId === entryId)).toBe(true);
    expect((await call(`/entries/${entryId}`)).json).toMatchObject({ netWorth: expect.any(Number), sourcePublic: true });
  });

  it('does not hide below the threshold', async () => {
    const olds = [await reporter('R1', 8), await reporter('R2', 8)];
    closed();
    for (const r of olds) await report(r.token, entryId);
    expect(await visible()).toBe(true);
    expect(await listed()).toBe(true);
  });

  it('never hides because of new accounts, however many report', async () => {
    const fresh = [await reporter('N1', 0), await reporter('N2', 1), await reporter('N3', 7 - 1 / 24), await reporter('N4', 0), await reporter('N5', 2)];
    const edge = await reporter('Edge', MIN_REPORTER_AGE_MS / DAY_MS);
    closed();
    for (const r of fresh) expect((await report(r.token, entryId)).json).toMatchObject({ reported: true, changed: true, hidden: false });
    expect(await visible()).toBe(true);
    // Exactly seven days old counts.
    expect((await report(edge.token, entryId)).json.hidden).toBe(false);
    const rows = await db.query<{ counted: number }>('SELECT counted FROM reports WHERE reporter_id = ?', [edge.profile.id]);
    expect(rows).toEqual([{ counted: 1 }]);
  });

  it('ignores reports from old accounts with no verified entry', async () => {
    const empties = [await reporter('E1', 20, false), await reporter('E2', 20, false), await reporter('E3', 20, false)];
    closed();
    for (const r of empties) expect((await report(r.token, entryId)).status).toBe(200);
    expect(await visible()).toBe(true);
  });

  it('counts one report per account', async () => {
    const r = await reporter('R1', 10);
    expect((await report(r.token, entryId)).json.changed).toBe(true);
    for (let i = 0; i < 3; i++) expect((await report(r.token, entryId)).json).toMatchObject({ changed: false, hidden: false });
    expect(await db.query('SELECT COUNT(*) AS n FROM reports')).toEqual([{ n: 1 }]);
  });
});

describe('report route abuse', () => {
  it('needs a session and a published program, and refuses self-reports', async () => {
    expect((await report(undefined, entryId)).status).toBe(401);
    const old = await reporter('R1', 10);
    expect((await report(old.token, 'doesnotexist')).status).toBe(404);
    expect((await report(old.token, entryId.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).status).toBe(404);
    expect((await report(author.token, entryId)).status).toBe(422);
    const mine = await enter(old.token, { actions: logOf(daily), source: daily, sourcePublic: false });
    expect((await report(author.token, mine.json.entryId)).status).toBe(404); // not published
    expect(await db.query('SELECT COUNT(*) AS n FROM reports')).toEqual([{ n: 0 }]);
  });

  it('rejects bodies, queries and other methods', async () => {
    const old = await reporter('R1', 10);
    expect((await call(`/entries/${entryId}/report`, { token: old.token, body: { reason: 'x' } })).status).toBe(400);
    expect((await call(`/entries/${entryId}/report?x=1`, { token: old.token, body: {} })).status).toBe(400);
    expect((await call(`/entries/${entryId}/report`, { token: old.token })).status).toBe(404);
  });

  it(`limits each account to ${REPORTS_PER_DAY} reports per UTC day`, async () => {
    const r = await reporter('R1', 10);
    for (let i = 0; i < REPORTS_PER_DAY; i++) expect((await report(r.token, entryId)).status).toBe(200);
    expect((await report(r.token, entryId)).status).toBe(429);
    const other = await reporter('R2', 10);
    expect((await report(other.token, entryId)).status).toBe(200); // per account
    time += DAY_MS;
    expect((await report(r.token, entryId)).status).toBe(200);
  });
});

describe('names shown to others', () => {
  it('uses the GitHub login only: no route returns a free-text name', async () => {
    const odd = await login('Zed <b>Zee</b> Smith');
    expect(odd.profile.displayName).toBe(odd.profile.login);
    // Even a legacy row with a different display name is rewritten by the migration SQL.
    await db.execute("UPDATE users SET display_name = 'Legacy Free Text' WHERE id = ?", [author.profile.id]);
    await db.execute(readFileSync(new URL('../migrations/005_moderation.sql', import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('UPDATE')).join(' '));
    const second = await reporter('Rival', 10);
    await enter(odd.token, { actions: logOf(daily), source: daily, sourcePublic: true });
    closed();
    await call(`/players/${second.profile.login}/follow`, { token: odd.token, body: {} });
    const paths = [
      '/me', `/challenges/${DAILY}/board?medal=wealth`, `/challenges/${DAILY}/board?medal=speed&scope=friends`, `/challenges/${DAILY}/sources`, `/entries/${entryId}`, `/entries/${entryId}/source`,
      `/players/${author.profile.login}`, `/players/${odd.profile.login}`, '/me/following', '/leaderboard', `/daily/leaderboard?date=2026-11-12`, '/seasons', '/stats',
    ];
    for (const p of paths) {
      const r = await call(p, { token: odd.token });
      expect(r.status, p).toBeLessThan(500);
      expect(r.text, p).not.toMatch(/Legacy Free Text|Zed <b>|Zed-<b>.*Smith.*"displayName":"Zed <b>/);
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
          const o = v as Json;
          if ('displayName' in o && 'login' in o) expect(o.displayName, p).toBe(o.login);
          Object.values(o).forEach(walk);
        }
      };
      walk(r.json);
    }
    // Each distinct displayName-without-login would still have to equal a login that exists.
    const rows = await db.query<{ login: string; display_name: string }>('SELECT login, display_name FROM users');
    for (const u of rows) expect(u.display_name).toBe(u.login);
  });

  it('restricts the model name to a short safe pattern', async () => {
    const bad = ['', ' ', 'claude 5', '<b>x</b>', 'a'.repeat(41), 'x‮y', 'x\ny', '-lead', '日本語', 'a;b', "a'b", 'a"b'];
    for (const model of bad) {
      expect(MODEL_PATTERN.test(model), JSON.stringify(model)).toBe(false);
      const robot = await login('Robot');
      expect((await enter(robot.token, { actions: SMALL, authorKind: 'model', model })).status, JSON.stringify(model)).toBe(422);
    }
    expect((await enter((await login('Robot')).token, { actions: SMALL, authorKind: 'model', model: 5 })).status).toBe(422);
    expect((await enter((await login('Robot')).token, { actions: SMALL, authorKind: 'human', model: 'gpt-4o' })).status).toBe(422);
    for (const model of ['claude-sonnet-5-5', 'gpt-4o', 'llama3.1:8b', 'org/model_v2+x', 'a'.repeat(40)]) {
      const robot = await login('Robot');
      const r = await enter(robot.token, { actions: SMALL, authorKind: 'model', model });
      expect(r.status, model).toBe(200);
      expect((await call(`/entries/${r.json.entryId}`)).json.model).toBe(model);
    }
  });
});

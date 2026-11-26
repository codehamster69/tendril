import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETUP_LEGACY, challengeSetup, createWorld, dailySeed } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createRun } from '../../lang/src/index.ts';
import { verifySource } from '../../lang/src/verify.ts';
import { createApp, createDb } from '../src/index.ts';
import type { Db, Profile } from '../src/index.ts';
import { DAY_MS } from '../src/game.ts';
import { edgeSeconds } from '../src/housekeeping.ts';
import { BASE_RULES_VERSION } from '@tendril/sim/src/index.ts';

type Login = { token: string; profile: Profile };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BASE = Date.UTC(2026, 10, 12, 12, 0, 0);
const DAILY = 'd-2026-11-12';
const daily = readFileSync(new URL('../../lang/examples/daily.sprout', import.meta.url), 'utf8');
const starter = readFileSync(new URL('../../lang/examples/starter.sprout', import.meta.url), 'utf8');

function logOf(source: string): LogEntry[] {
  const seed = dailySeed('2026-11-12');
  const run = createRun(createWorld({ id: DAILY, seed }, challengeSetup('daily', seed, SETUP_LEGACY).setup), source);
  run.step(3000);
  return run.pending.filter((a) => a[0] < 3000);
}

let db: Db;
let app: (request: Request) => Promise<Response>;
let time: number;

async function call(path: string, o: { token?: string; body?: unknown; method?: string } = {}) {
  const headers = new Headers();
  if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await app(new Request(`http://localhost:8787/api${path}`, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }));
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as Json };
}
const login = async (name: string): Promise<Login> => (await call('/dev/login', { body: { displayName: name } })).json as Login;
const share = (token: string | undefined, body: Json) => call('/packets', { token, body: { origin: 'endless', ...body } });
const enter = (token: string, body: Json) => call(`/challenges/${DAILY}/entries`, { token, body: { rulesVersion: BASE_RULES_VERSION, ...body } });
/** An account a week old with a verified entry, so its reports count. */
async function reporter(name: string): Promise<Login> {
  const l = await login(name);
  await db.execute('UPDATE users SET created_at = ? WHERE id = ?', [time - 8 * DAY_MS, l.profile.id]);
  expect((await enter(l.token, { actions: [[0, 0, 0, 1], [2, 0, 1]] })).status).toBe(200);
  return l;
}

let ann: Login;
beforeEach(async () => {
  time = BASE;
  db = createDb({ url: ':memory:' });
  app = createApp({ db, env: { TENDRIL_DEV_AUTH: '1', PUBLIC_ORIGIN: 'https://tendril.example' }, setupVersion: 0, now: () => time, verifySource: async (r) => verifySource(r) });
  ann = await login('Ann');
});
afterEach(() => db.close());

describe('sharing', () => {
  it('shares, lists, reads and caches', async () => {
    const r = await share(ann.token, { name: 'Carrot snake', note: 'My first one.', tags: ['starter', 'tiny'], source: starter });
    expect(r.status).toBe(201);
    const id = r.json.id as string;
    const page = await call(`/packets/${id}`);
    expect(page.status).toBe(200);
    expect(page.json).toMatchObject({ id, name: 'Carrot snake', note: 'My first one.', tags: ['starter', 'tiny'], source: starter, plants: 0, parentId: null, bestResult: null });
    expect(page.json.family).toMatchObject({ rootId: id, nodes: [{ id, parentId: null }] });
    expect(edgeSeconds(`/packets/${id}`)).toBe(60); // anonymous reads are CDN-cached
    expect(edgeSeconds('/packets')).toBe(60);
    const list = await call('/packets?sort=new');
    expect(list.json.packets.map((p: Json) => p.id)).toEqual([id]);
    expect((await call('/packets?tag=starter')).json.packets).toHaveLength(1);
    expect((await call('/packets?tag=bees')).json.packets).toHaveLength(0);
    expect((await call('/packets?tag=nope')).status).toBe(400);
    const profile = await call(`/players/${ann.profile.login}`);
    expect(profile.json.packets).toMatchObject({ list: [{ id, name: 'Carrot snake', plants: 0 }], totalPlants: 0 });
  });

  it('needs a session, a clean name, and refuses links, odd tags and empty programs', async () => {
    expect((await share(undefined, { name: 'Nope', source: starter })).status).toBe(401);
    expect((await share(ann.token, { name: 'Visit http://spam.example', source: starter })).status).toBe(422);
    expect((await share(ann.token, { name: 'ok', source: starter })).status).toBe(422);
    expect((await share(ann.token, { name: 'Fine name', note: 'mail me a@b.co', source: starter })).status).toBe(422);
    expect((await share(ann.token, { name: 'Fine name', tags: ['hax'], source: starter })).status).toBe(422);
    expect((await share(ann.token, { name: 'Fine name', source: '   ' })).status).toBe(422);
    expect((await share(ann.token, { name: 'Fine name', source: starter, origin: 'daily' })).status).toBe(422);
    expect((await share(ann.token, { name: 'Fine name', source: 'x'.repeat(17_000) })).status).toBe(413);
  });

  it('limits publishing to 10 a day and refuses the same program twice', async () => {
    expect((await share(ann.token, { name: 'First one', source: starter })).status).toBe(201);
    const again = await share(ann.token, { name: 'First again', source: `${starter}\n# a comment only`, });
    expect(again.status).toBe(409);
    expect((await share((await login('Bob')).token, { name: 'Copy cat', source: starter })).status).toBe(409);
    // Refused tries count against the 10 a day too: two so far, so eight more fit.
    for (let i = 0; i < 8; i++) expect((await share(ann.token, { name: `Packet ${i}`, source: `${starter}\nsay ${i}` })).status).toBe(201);
    expect((await share(ann.token, { name: 'Too many', source: `${starter}\nsay 99` })).status).toBe(429);
  });
});

describe('remixing and planting', () => {
  it('records the parent, builds the family tree and counts one plant per player', async () => {
    const a = (await share(ann.token, { name: 'Original', source: starter })).json.id as string;
    const bob = await login('Bob');
    expect((await call(`/packets/${a}/plant`, { token: bob.token, body: {} })).json).toMatchObject({ planted: true, plants: 1 });
    expect((await call(`/packets/${a}/plant`, { token: bob.token, body: {} })).json.plants).toBe(1); // same player again
    expect((await call(`/packets/${a}/plant`, { token: ann.token, body: {} })).json.plants).toBe(1); // the author does not count
    expect((await call(`/packets/${a}/plant`, { body: {} })).status).toBe(401);
    const same = await share(bob.token, { name: 'Remix', source: starter, parentId: a });
    expect(same.status).toBe(422); // nothing changed
    const b = (await share(bob.token, { name: 'Remix', source: `${starter}\nsay 1`, parentId: a })).json;
    expect(b.parentId).toBe(a);
    const c = (await share(ann.token, { name: 'Remix of remix', source: `${starter}\nsay 2`, parentId: b.id })).json.id as string;
    const tree = (await call(`/packets/${c}`)).json.family;
    expect(tree.rootId).toBe(a);
    expect(tree.nodes.map((n: Json) => [n.id, n.parentId]).sort()).toEqual([[a, null], [b.id, a], [c, b.id]].sort());
    expect((await share(bob.token, { name: 'Ghost parent', source: `${starter}\nsay 3`, parentId: 'zzzzzzzzzzz' })).status).toBe(422);
    const popular = (await call('/packets?sort=popular')).json.packets;
    expect(popular[0]).toMatchObject({ id: a, plants: 1, plantsThisWeek: 1 });
    time += 8 * DAY_MS;
    expect((await call('/packets?sort=popular')).json.packets[0]).toMatchObject({ id: a, plants: 1, plantsThisWeek: 0 });
    expect((await call(`/players/${ann.profile.login}`)).json.packets.totalPlants).toBe(1);
  });
});

describe('fair play and best result', () => {
  it('refuses a program that is in play on an open daily, until the daily closes', async () => {
    const bob = await login('Bob');
    expect((await enter(bob.token, { actions: logOf(daily), source: daily, sourcePublic: false })).status).toBe(200);
    const blocked = await share(ann.token, { name: 'Daily solution', source: daily });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toMatch(/open daily/);
    expect((await share(ann.token, { name: 'Same, spaced', source: daily.replace(/\n/g, '\n\n') })).status).toBe(409); // normalised
    time = BASE + 2 * DAY_MS;
    expect((await share(ann.token, { name: 'Daily solution', source: daily })).status).toBe(201);
  });

  it('shows the best verified result of entries that ran the same program, but only public ones', async () => {
    const bob = await login('Bob'), cat = await login('Cat');
    expect((await enter(bob.token, { actions: logOf(daily), source: daily, sourcePublic: true })).status).toBe(200);
    expect((await enter(cat.token, { actions: logOf(daily), source: daily, sourcePublic: false })).status).toBe(200); // identical log, private program
    time = BASE + 2 * DAY_MS;
    const id = (await share(ann.token, { name: 'Daily solution', source: daily })).json.id as string;
    const best = (await call(`/packets/${id}`)).json.bestResult;
    expect(best).toMatchObject({ challengeId: DAILY, kind: 'daily', player: { login: bob.profile.login }, entries: 1 }); // Cat's private entry is not shown or counted
    expect(typeof best.entryId).toBe('string');
    expect((await call(`/packets/${id}`)).json.bestResult.score).toBeGreaterThan(0);
  });
});

describe('reports', () => {
  it('hides a packet at three counted reports from established accounts', async () => {
    const id = (await share(ann.token, { name: 'Spammy', source: starter })).json.id as string;
    const rs = [await reporter('R1'), await reporter('R2'), await reporter('R3')];
    for (const [i, r] of rs.entries()) {
      const res = await call(`/packets/${id}/report`, { token: r.token, body: {} });
      expect(res.json).toMatchObject({ reported: true, changed: true, hidden: i === 2 });
    }
    expect((await call(`/packets/${id}`)).status).toBe(404);
    expect((await call('/packets')).json.packets).toHaveLength(0);
    expect((await call(`/players/${ann.profile.login}`)).json.packets.list).toHaveLength(0);
    expect((await call(`/packets/${id}/report`, { token: rs[0]!.token, body: {} })).json.changed).toBe(false);
    expect((await call(`/packets/${id}/report`, { token: ann.token, body: {} })).status).toBe(422);
  });

  it('ignores reports from new accounts', async () => {
    const id = (await share(ann.token, { name: 'Harmless', source: starter })).json.id as string;
    for (const n of ['N1', 'N2', 'N3', 'N4']) await call(`/packets/${id}/report`, { token: (await login(n)).token, body: {} });
    expect((await call(`/packets/${id}`)).status).toBe(200);
  });
});

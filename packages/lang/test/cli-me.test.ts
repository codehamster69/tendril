import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp, createDb } from '../../server/src/index.ts';
import { verifySource } from '../src/verify.ts';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
let server: Server, origin: string, dir: string, env: NodeJS.ProcessEnv;
const migDir = new URL('../../server/migrations/', import.meta.url);
const migrations = readdirSync(migDir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()
  .map((name) => ({ version: Number(/^(\d+)_/.exec(name)![1]), name, sql: readFileSync(new URL(name, migDir), 'utf8') }));
const db = createDb({ url: ':memory:' });

beforeAll(async () => {
  const app = createApp({ db, migrations, env: { TENDRIL_DEV_AUTH: '1', PUBLIC_ORIGIN: 'http://localhost' }, verifySource: async (r) => verifySource(r) });
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const r = await app(new Request(`http://localhost:8787${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: body.length ? body : undefined }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'tendril-me-'));
  env = { ...process.env, TENDRIL_API: origin, TENDRIL_CONFIG_DIR: join(dir, 'cfg') };
  delete env.TENDRIL_TOKEN;
});
afterAll(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const tendrilAs = (token: string | null) => run('node', ['--experimental-transform-types', '--no-warnings', cli, 'me'], { env: { ...env, TENDRIL_TOKEN: token ?? '' } });
const devLogin = async (displayName: string) => ((await (await fetch(`${origin}/api/dev/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName }) })).json()) as { token: string }).token;
const userIdOf = async (token: string) => ((await (await fetch(`${origin}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { profile: { id: string } }).profile.id;

it('prints a rated player: ratings, placement, last change and streak', async () => {
  const token = await devLogin('Rated Me');
  const uid = await userIdOf(token);
  const at = Date.UTC(2026, 10, 12, 21);
  const row = (c: string, r: number, b: number, d: number) => ({ c, k: 'd', at, p: 3, f: 40, pf: 0, d, b, r, e: `e-${c}` });
  const data = { v: 1, d: {
    overall: { r: 1320, n: 7, pk: 1330, h: [row('d-2026-11-11', 1299, 1290, 9), row('d-2026-11-12', 1320, 1299, 21)] },
    speed: { r: 1200, n: 2, pk: 1200, h: [row('d-2026-11-12', 1200, 1200, 0)] },
  } };
  // Written the way the rater writes it (rating_profiles mirror columns included); the rating maths is tested in the server package.
  await db.execute('INSERT INTO rating_profiles (user_id, data, updated_at, r_overall, n_overall, l_overall, r_speed, n_speed, l_speed) VALUES (?, ?, ?, 1320, 7, ?, 1200, 2, ?)',
    [uid, JSON.stringify(data), at, at, at]);
  const out = (await tendrilAs(token)).stdout;
  expect(out).toMatch(/^Rated-Me \(Rated-Me\)$/m);
  expect(out).toMatch(/^Overall\s+1320\s+\S/m);
  expect(out).toMatch(/^Speed\s+In placement, 2 of 5$/m);
  expect(out).toMatch(/^Brevity\s+unrated$/m);
  expect(out).toMatch(/^Last rated: daily d-2026-11-12 \(closed 2026-11-12\)$/m);
  expect(out).toMatch(/^ {2}Overall\s+place 3 of 40, 1320 \(\+21\)$/m);
  expect(out).toMatch(/^ {2}Speed\s+place 3 of 40, 1200 \(0\)$/m);
  expect(out).toMatch(/^Streak: none \(best 0\)$/m);
}, 60_000);

it('prints an unrated player without a rating or last change', async () => {
  const token = await devLogin('New Me');
  const out = (await tendrilAs(token)).stdout;
  expect(out).toMatch(/^New-Me \(New-Me\)$/m);
  expect(out).toMatch(/^Overall\s+unrated$/m);
  expect(out).toMatch(/No rating yet\./);
  expect(out).not.toMatch(/Last rated/);
  expect(out).toMatch(/^Streak: none \(best 0\)$/m);
}, 60_000);

it('tells a signed-out user how to sign in', async () => {
  await expect(tendrilAs(null)).rejects.toThrow(/Not signed in\. Run: tendril login/);
  await expect(tendrilAs('not-a-real-token-that-the-server-does-not-know-000000000000000000000000')).rejects.toThrow(/sign-in has expired|Profile: 401/);
}, 60_000);

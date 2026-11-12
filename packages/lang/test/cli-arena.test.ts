import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { countTokens } from '../src/tokens.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp, createDb } from '../../server/src/index.ts';
import { verifySource } from '../src/verify.ts';

const run = promisify(execFile);
const cli = new URL('../src/cli.ts', import.meta.url).pathname;
const daily = new URL('../examples/daily.sprout', import.meta.url).pathname;
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
  dir = mkdtempSync(join(tmpdir(), 'tendril-cli-'));
  env = { ...process.env, TENDRIL_API: origin, TENDRIL_CONFIG_DIR: join(dir, 'cfg') };
  delete env.TENDRIL_TOKEN;
});
afterAll(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const tendril = (...args: string[]) => run('node', ['--experimental-transform-types', '--no-warnings', cli, ...args], { env });
const tendrilAs = (token: string, ...args: string[]) => run('node', ['--experimental-transform-types', '--no-warnings', cli, ...args], { env: { ...env, TENDRIL_TOKEN: token } });
const devLogin = async (displayName: string) => ((await (await fetch(`${origin}/api/dev/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName }) })).json()) as { token: string }).token;

it('plays the daily example, submits it, and the server agrees with the local score', async () => {
  await expect(tendril('submit')).rejects.toThrow(/Nothing to submit/);
  const played = (await tendril('daily', daily)).stdout;
  const local = /Net worth: (\d+)/.exec(played)![1];
  expect(played).toMatch(/Par tick:/);
  expect(played.split('\n').filter((l) => Array.from(l).filter((c) => /\p{Extended_Pictographic}/u.test(c)).length === 8)).toHaveLength(8);

  await expect(tendril('submit')).rejects.toThrow(/Not signed in/);
  const login = await fetch(`${origin}/api/dev/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'Cli-Tester' }) });
  const { token } = (await login.json()) as { token: string };
  // The stored token is what `tendril login` writes: owner-only.
  const { saveToken } = await import('../src/arena-cli.ts');
  Object.assign(process.env, { TENDRIL_API: origin, TENDRIL_CONFIG_DIR: env.TENDRIL_CONFIG_DIR });
  saveToken(token, 'cli-tester');
  if (process.platform !== 'win32') {
    expect(statSync(join(dir, 'cfg', 'auth.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'cfg')).mode & 0o777).toBe(0o700);
  }

  const submitted = (await tendril('submit')).stdout;
  expect(/Net worth: (\d+)/.exec(submitted)![1]).toBe(local);
  expect(submitted).toMatch(/Rank: wealth 1/);
  // The program travelled with the run: a verified token count and a Brevity rank, kept private without --publish.
  const tokens = Number(/Tokens:\s+(\d+) \(program private\)/.exec(submitted)![1]);
  expect(tokens).toBe(countTokens(readFileSync(daily, 'utf8')));
  expect(submitted).toMatch(/brevity 1 /);
  const board = (await (await fetch(`${origin}/api/challenges/today/board?medal=brevity`)).json()) as { entries: { value: number; displayName: string; authorKind: string }[] };
  expect(board.entries.map((e) => [e.displayName, e.value, e.authorKind])).toEqual([['Cli-Tester', tokens, 'human']]);
}, 120_000);

it('--publish publishes the program, and --model files a declared model entry on the model board', async () => {
  const tendrilPublish = await tendrilAs(await devLogin('Pub Tester'), 'submit', '--publish');
  expect(tendrilPublish.stdout).toMatch(/program published when the challenge closes/);
  const modelToken = await devLogin('Agent-Tester');
  const m = (await tendrilAs(modelToken, 'submit', '--model', 'harness-model-1')).stdout;
  expect(m).toMatch(/as model harness-model-1/);
  expect(m).toMatch(/brevity \d+ /);
  const models = (await (await fetch(`${origin}/api/challenges/today/board?medal=brevity&author=model`)).json()) as { entries: { displayName: string; model: string }[] };
  expect(models.entries.map((e) => [e.displayName, e.model])).toEqual([['Agent-Tester', 'harness-model-1']]);
  const humans = (await (await fetch(`${origin}/api/challenges/today/board?medal=brevity&author=human`)).json()) as { total: number };
  expect(humans.total).toBe(2);
  const sources = (await (await fetch(`${origin}/api/challenges/today/board?medal=wealth`)).json()) as { entries: { entryId: string }[] };
  expect(sources.entries.length).toBe(3);
});

it('rejects bad submit options before touching the network', async () => {
  await expect(tendril('submit', '--model')).rejects.toThrow(/--model needs a name/);
  await expect(tendril('submit', '--model', '--publish')).rejects.toThrow(/--model needs a name/);
  await expect(tendril('submit', '--frobnicate')).rejects.toThrow(/Unknown option/);
}, 60_000);

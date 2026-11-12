// D1: the open model harness (examples/agent). The dry run needs no key and no network; the submit path is checked against a local server.
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp, createDb } from '../../server/src/index.ts';
import { challengePrompt, extractProgram, offlineChallenge, runAgent, systemPrompt } from '../../../examples/agent/agent.ts';
import { verifySource } from '../src/verify.ts';

const run = promisify(execFile);
const harness = new URL('../../../examples/agent/run.ts', import.meta.url).pathname;
const daily = new URL('../examples/daily.sprout', import.meta.url).pathname;
const node = (...args: string[]) => run('node', ['--experimental-transform-types', '--no-warnings', harness, ...args], { env, timeout: 100_000 });
let env: NodeJS.ProcessEnv, dir: string, server: Server, origin: string;
const db = createDb({ url: ':memory:' });
const migDir = new URL('../../server/migrations/', import.meta.url);
const migrations = readdirSync(migDir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()
  .map((name) => ({ version: Number(/^(\d+)_/.exec(name)![1]), name, sql: readFileSync(new URL(name, migDir), 'utf8') }));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tendril-agent-test-'));
  // No API key and a dead API address: the dry run must not need either.
  env = { ...process.env, TENDRIL_API: 'http://127.0.0.1:1', TENDRIL_CONFIG_DIR: join(dir, 'cfg') };
  delete env.ANTHROPIC_API_KEY; delete env.TENDRIL_TOKEN;
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
});
afterAll(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

it('dry run: stubbed model reply, no API key, no network, nothing submitted', async () => {
  const out = (await node('--dry-run')).stdout;
  expect(out).toMatch(/1 attempt\(s\) by dry-run-stub/);
  expect(out).toMatch(/net worth \d+, par (\d+|not reached), \d+ tokens/);
  expect(out).toMatch(/Dry run: nothing submitted/);
  expect(out).toMatch(/tendril submit --model "dry-run-stub"/);
  await expect(node('--model', 'x')).rejects.toThrow(/ANTHROPIC_API_KEY/); // a live run without a key says so plainly
  await expect(node('--dry-run', '--attempts', '99')).rejects.toThrow(/--attempts is 1..10/);
});

it('gives the model the language docs and the challenge, and feeds errors back', async () => {
  const c = offlineChallenge('2026-12-01');
  const seen: { system: string; user: string }[] = [];
  const replies = ['```sprout\nrepeat forever\n  wait\n```', '```sprout\n' + readFileSync(daily, 'utf8') + '```'];
  const result = await runAgent({ challenge: c, attempts: 2, ask: async (p) => { seen.push(p); return replies[seen.length - 1]!; } });
  expect(seen[0]!.system).toBe(systemPrompt());
  expect(seen[0]!.system).toContain('Sprout: the Tendril pseudocode language');
  expect(seen[0]!.user).toBe(challengePrompt(c, []));
  expect(seen[0]!.user).toContain(`d-2026-12-01`);
  expect(seen[1]!.user).toContain('Attempt 1');
  expect(seen[1]!.user).toMatch(/It had errors:\n {2}\S/);
  expect(result.attempts[0]!.errors.length).toBeGreaterThan(0);
  expect(result.best?.n).toBe(2); // the broken attempt is never picked
  expect(extractProgram('Here you go\n```\nx = 1\n```\nbye')).toBe('x = 1\n');
  expect(extractProgram('x = 1')).toBe('x = 1\n');
});

it('with --submit it plays and submits through the CLI as a declared model, on the model board', async () => {
  const token = ((await (await fetch(`${origin}/api/dev/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'Harness' }) })).json()) as { token: string }).token;
  env = { ...env, TENDRIL_API: origin, TENDRIL_TOKEN: token };
  const reply = join(dir, 'reply.sprout');
  writeFileSync(reply, readFileSync(daily, 'utf8'));
  const out = (await node('--reply-file', reply, '--model', 'stub-model-9', '--submit')).stdout;
  expect(out).toMatch(/Submitted to d-\d{4}-\d\d-\d\d as model stub-model-9/);
  expect(out).toMatch(/brevity 1 /);
  const board = (await (await fetch(`${origin}/api/challenges/today/board?medal=brevity&author=model`)).json()) as { entries: { displayName: string; model: string; value: number }[] };
  expect(board.entries.map((e) => [e.displayName, e.model])).toEqual([['Harness', 'stub-model-9']]);
});

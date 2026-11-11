import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url).pathname;
const cli = (...args: string[]) =>
  spawnSync('node', ['--experimental-strip-types', '--no-warnings', 'src/cli.ts', ...args], { cwd: root, encoding: 'utf8' });

describe('cli', () => {
  it('run then replay print the same hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tendril-cli-'));
    const log = join(dir, 'log.json');
    const r = cli('run', 'examples/starter.lua', '--seed', '5', '--ticks', '5000', '--log', log);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.errors).toEqual([]);
    expect(JSON.parse(readFileSync(log, 'utf8'))).toMatchObject({ v: 1, rules: 2, seed: 5, toTick: 5000 });
    const p = cli('replay', log);
    expect(p.status).toBe(0);
    const back = JSON.parse(p.stdout);
    expect(back.hash).toBe(out.hash);
    expect(back.netWorth).toBe(out.netWorth);
  }, 60_000);

  it('exits 1 on script errors and 2 on an illegal log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tendril-cli-'));
    const bad = join(dir, 'bad.lua');
    writeFileSync(bad, 'bot.move("up")');
    const r = cli('run', bad, '--seed', '1', '--ticks', '10');
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).errors).toHaveLength(1);
    const log = join(dir, 'illegal.json');
    writeFileSync(log, JSON.stringify({ v: 1, rules: 2, seed: 1, toTick: 10, actions: [[3, 0, 99]] }));
    expect(cli('replay', log).status).toBe(2);
  }, 60_000);
});

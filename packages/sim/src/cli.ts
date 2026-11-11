// Local runner: `cli.ts run <script.lua> --seed N --ticks N [--log out.json]` and `cli.ts replay <log.json>`.
import { readFileSync, writeFileSync } from 'node:fs';
import { createWorld, hashWorld, IllegalAction, netWorth, replayChunk, RULES_VERSION } from './index.ts';
import type { LogEntry } from './index.ts';
import { createLuaRun } from './lua.ts';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function run(args: string[]): Promise<number> {
  const file = args[0];
  const seed = Number(flag(args, '--seed') ?? 1);
  const ticks = Number(flag(args, '--ticks') ?? 0);
  const logPath = flag(args, '--log');
  if (!file || !Number.isSafeInteger(seed) || !Number.isSafeInteger(ticks) || ticks < 0) {
    console.error('usage: cli.ts run <script.lua> --seed <n> --ticks <n> [--log <out.json>]');
    return 64;
  }
  const lua = await createLuaRun(createWorld({ id: 'cli', seed }), readFileSync(file, 'utf8'));
  try {
    lua.step(ticks);
    const actions: LogEntry[] = lua.takeLog();
    const w = lua.world;
    if (logPath) writeFileSync(logPath, JSON.stringify({ v: 1, rules: RULES_VERSION, seed, toTick: w.tick, actions }));
    console.log(JSON.stringify({
      tick: w.tick, coins: w.coins, netWorth: netWorth(w), hash: hashWorld(w), actions: actions.length,
      bots: w.bots.length, plots: w.plots.length, errors: lua.errors.map((e) => `bot ${e.bot}: ${e.message}`),
    }));
    for (const line of lua.output.slice(-20)) console.error(line);
    return lua.errors.length > 0 ? 1 : 0;
  } finally { lua.close(); }
}

function replay(args: string[]): number {
  const file = args[0];
  if (!file) { console.error('usage: cli.ts replay <log.json>'); return 64; }
  const log = JSON.parse(readFileSync(file, 'utf8')) as { seed: number; toTick: number; actions: LogEntry[] };
  const w = createWorld({ id: 'cli', seed: log.seed });
  try {
    replayChunk(w, log.actions, log.toTick);
  } catch (e) {
    if (e instanceof IllegalAction) { console.error(e.message); return 2; }
    throw e;
  }
  console.log(JSON.stringify({ tick: w.tick, netWorth: netWorth(w), hash: hashWorld(w) }));
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'run') process.exitCode = await run(rest);
else if (cmd === 'replay') process.exitCode = replay(rest);
else { console.error('usage: cli.ts run|replay ...'); process.exitCode = 64; }

import { readFileSync, writeFileSync } from 'node:fs';
import { createWorld, hashWorld, netWorth, replayChunk, RULES_VERSION } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import { createRun } from './index.ts';
const [command, file, ...options] = process.argv.slice(2);
try {
  if (!file || !['run', 'replay'].includes(command ?? '')) throw new Error('Usage: tendril run file.sprout --seed 42 --ticks 3000 [--log file.json], or tendril replay file.json');
  const option = (name: string, fallback: string): string => { const i = options.indexOf(name); return i < 0 ? fallback : options[i + 1] ?? fallback; };
  if (command === 'run') {
    const seed = Number(option('--seed', '42')), ticks = Number(option('--ticks', '3000'));
    if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(ticks) || ticks < 0 || ticks > 1_000_000) throw new Error('Supply a safe integer seed and 0..1,000,000 ticks.');
    const run = createRun(createWorld({ id: 'cli', seed }), readFileSync(file, 'utf8'));
    for (let left = ticks; left > 0; left -= Math.min(left, 20_000)) run.step(Math.min(left, 20_000));
    for (const line of run.output) console.log(`[${line.tick} bot ${line.bot}] ${line.text}`);
    for (const error of run.errors) console.error(`Line ${error.line}, bot ${error.bot}: ${error.message}`);
    console.log(JSON.stringify({ hash: hashWorld(run.world), coins: run.world.coins, netWorth: netWorth(run.world), actions: run.pending.length }));
    if (options.includes('--log')) writeFileSync(option('--log', 'run.json'), JSON.stringify({ rulesVersion: RULES_VERSION, seed, ticks, actions: run.pending }));
    if (run.errors.length) process.exitCode = 1;
  } else {
    const log = JSON.parse(readFileSync(file, 'utf8')) as { rulesVersion: number; seed: number; ticks: number; actions: LogEntry[] };
    if (log.rulesVersion !== RULES_VERSION) throw new Error('Rules version mismatch.');
    const world = createWorld({ id: 'cli', seed: log.seed }); replayChunk(world, log.actions, log.ticks);
    console.log(JSON.stringify({ hash: hashWorld(world), coins: world.coins, netWorth: netWorth(world), actions: log.actions.length }));
  }
} catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }

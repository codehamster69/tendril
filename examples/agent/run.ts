#!/usr/bin/env node
// Usage (from the repo root):
//   node --experimental-transform-types examples/agent/run.ts --dry-run
//   ANTHROPIC_API_KEY=... node --experimental-transform-types examples/agent/run.ts --model <model-id> [--provider anthropic|gemini] [--challenge today] [--attempts 3] [--submit]
// Gemini (free tier): GEMINI_API_KEY=... ... --provider gemini --model gemini-3.5-flash
// Other models: --ask-cmd "<command>" runs a command that reads {"system","user"} JSON on stdin and prints the reply.
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anthropicAsk, geminiAsk, getChallenge, withRetry, offlineChallenge, runAgent } from './agent.ts';
import type { Ask } from './agent.ts';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };

const dry = flag('--dry-run');
const model = opt('--model') ?? (dry ? 'dry-run-stub' : undefined);
const attempts = Number(opt('--attempts') ?? (dry ? 1 : 3));
if (!model) throw new Error('Say which model wrote the program: --model <name>. It is shown on the board.');
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw new Error('--attempts is 1..10');

// The stub reply used by --dry-run and --reply-file: no model, no key, no network.
const replyFile = opt('--reply-file') ?? (dry ? fileURLToPath(new URL('../../packages/lang/examples/daily.sprout', import.meta.url)) : undefined);
const askCmd = opt('--ask-cmd');
const ask: Ask = replyFile
  ? async () => '```sprout\n' + readFileSync(replyFile, 'utf8') + '\n```'
  : askCmd
    ? async (p) => execFileSync('/bin/sh', ['-c', askCmd], { input: JSON.stringify(p), encoding: 'utf8', maxBuffer: 1 << 20 })
    : withRetry(opt('--provider') === 'gemini' ? geminiAsk(model) : anthropicAsk(model));

const challenge = dry ? offlineChallenge() : await getChallenge(opt('--challenge') ?? 'today');
const result = await runAgent({ challenge, ask, attempts });
console.log(`Challenge ${challenge.id}: ${result.attempts.length} attempt(s) by ${model}`);
for (const a of result.attempts) console.log(`  #${a.n}: net worth ${a.netWorth}, par ${a.parTick ?? 'not reached'}, ${a.tokens} tokens${a.errors.length ? `, ${a.errors.length} error(s): ${a.errors[0]}` : ''}`);
if (!result.best) { console.error('No attempt ran cleanly; nothing to submit.'); process.exit(1); }
console.log(`Best: net worth ${result.best.netWorth}, ${result.best.tokens} tokens.`);

const dir = mkdtempSync(join(tmpdir(), 'tendril-agent-'));
const file = join(dir, 'program.sprout');
writeFileSync(file, result.best.source);
console.log(`Program written to ${file}`);

const cli = fileURLToPath(new URL('../../packages/lang/src/cli.ts', import.meta.url));
const tendril = (...a: string[]): void => {
  const r = spawnSync('node', ['--experimental-transform-types', '--no-warnings', cli, ...a], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
if (dry || !flag('--submit')) {
  console.log(`${dry ? 'Dry run: nothing submitted.' : 'Not submitted (add --submit).'} It would run:`);
  console.log(`  tendril challenge ${challenge.id} ${file}\n  tendril submit --model ${JSON.stringify(model)}`);
} else {
  tendril('challenge', challenge.id, file);
  tendril('submit', '--model', model);
}

// An open harness for "humans vs models": give a model the language docs and today's challenge, take a Sprout
// program back, run it, and submit it through the CLI. Nothing here is special to Tendril's server: a model entry
// is an ordinary entry with a declared model name, a program the server re-ran, and that program published.
import { readFileSync } from 'node:fs';
import { challengeSetup, dailySeed, RULES_VERSION, SETUP_VERSION } from '../../packages/sim/src/index.ts';
import { getChallenge, playLocal } from '../../packages/lang/src/arena-cli.ts';
import type { Challenge, LastRun } from '../../packages/lang/src/arena-cli.ts';
import { countTokens } from '../../packages/lang/src/tokens.ts';

export type Ask = (prompt: { system: string; user: string }) => Promise<string>;
export interface Attempt { n: number; source: string; netWorth: number; parTick: number | null; tokens: number; errors: string[]; run: LastRun }
export interface AgentResult { challenge: Challenge; attempts: Attempt[]; best: Attempt | null; system: string; prompts: string[] }

const LANGUAGE_DOC = new URL('../../docs/LANGUAGE.md', import.meta.url);

/** Today's daily built locally from the shared rules, so a dry run needs no network at all. */
export function offlineChallenge(date = new Date().toISOString().slice(0, 10)): Challenge {
  const seed = dailySeed(date);
  // The par of a live challenge is measured by the server, so an offline stand-in has none.
  return { id: `d-${date}`, kind: 'daily', number: null, seed, ticks: challengeSetup('daily', seed, SETUP_VERSION).ticks, par: null, rulesVersion: RULES_VERSION, setupVersion: SETUP_VERSION };
}

export const systemPrompt = (): string => [
  'You write programs in Sprout, the pseudocode language of the farming game Tendril. The full language reference follows.',
  'Reply with exactly one program inside a ```sprout code fence, and nothing else you need me to run. Do not explain it.',
  '', readFileSync(LANGUAGE_DOC, 'utf8'),
].join('\n');

export function challengePrompt(c: Challenge, previous: Attempt[]): string {
  const lines = [
    `Today's challenge is ${c.id}: one fixed seed (${c.seed}), ${c.ticks} ticks, rules version ${c.rulesVersion}.`,
    'Your program is run once on that farm. It is scored three ways:',
    '- Wealth: net worth at the final tick (higher is better).',
    `- Speed: the earliest tick at which net worth reaches par${c.par === null ? ' (this challenge has no par)' : ` (${c.par})`}.`,
    '- Brevity: the fewest Sprout tokens in a program that reaches par (comments and blank lines are free).',
    'Write one complete program.',
  ];
  for (const a of previous) {
    lines.push('', `Attempt ${a.n} scored net worth ${a.netWorth}, par tick ${a.parTick ?? 'not reached'}, ${a.tokens} tokens.`);
    if (a.errors.length) lines.push('It had errors:', ...a.errors.slice(0, 8).map((e) => `  ${e}`));
    lines.push('Improve on it, and reply with the whole new program.');
  }
  return lines.join('\n');
}

/** The program in a reply: the first fenced block, or the whole reply if there is no fence. */
export function extractProgram(reply: string): string {
  const fenced = /```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/.exec(reply);
  return (fenced ? fenced[1]! : reply).replace(/\s+$/, '') + '\n';
}

export async function runAgent(o: { challenge: Challenge; ask: Ask; attempts: number }): Promise<AgentResult> {
  const system = systemPrompt();
  const attempts: Attempt[] = [], prompts: string[] = [];
  for (let n = 1; n <= o.attempts; n++) {
    const user = challengePrompt(o.challenge, attempts.slice(-1));
    prompts.push(user);
    const source = extractProgram(await o.ask({ system, user }));
    let played;
    try { played = playLocal(o.challenge, source); }
    catch (e) { attempts.push({ n, source, netWorth: 0, parTick: null, tokens: 0, errors: [e instanceof Error ? e.message : String(e)], run: null as unknown as LastRun }); continue; }
    const { errors, ...run } = played;
    attempts.push({ n, source, netWorth: run.netWorth, parTick: run.parTick, tokens: countTokens(source), errors, run });
  }
  const clean = attempts.filter((a) => a.errors.length === 0 && a.run);
  const best = clean.sort((a, b) => b.netWorth - a.netWorth || a.tokens - b.tokens)[0] ?? null;
  return { challenge: o.challenge, attempts, best, system, prompts };
}

/** Anthropic Messages API; needs ANTHROPIC_API_KEY. Any other provider can be wired with `--ask-cmd` instead. */
export function anthropicAsk(model: string, apiKey = process.env.ANTHROPIC_API_KEY): Ask {
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY, or use --dry-run, --reply-file or --ask-cmd.');
  return async ({ system, user }) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!r.ok) throw new Error(`Model call failed: ${r.status}`);
    const json = (await r.json()) as { content?: { type: string; text?: string }[] };
    return (json.content ?? []).map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('');
  };
}

export { getChallenge };

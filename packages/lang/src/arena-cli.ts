// Arena commands for the CLI: login, daily, challenge, submit. Talks to the Tendril API with a Bearer token.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { challengeSetup, createWorld, replayWithPar, RULES_VERSION, SETUP_LEGACY, describeModifiers } from '@tendril/sim/src/index.ts';
import type { ChallengeKind, LogEntry } from '@tendril/sim/src/index.ts';
import { createRun } from './index.ts';

export const DEFAULT_API = 'https://tendril.hokora.xyz';
export const apiOrigin = (): string => (process.env.TENDRIL_API ?? DEFAULT_API).replace(/\/+$/, '');
export const configDir = (): string => process.env.TENDRIL_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'tendril');

/** Owner-only: directory 0700, files 0600 (chmod again in case the file or umask was looser). */
function writePrivate(name: string, text: string): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  const file = join(dir, name);
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}
const readJson = <T>(name: string): T | null => {
  const file = join(configDir(), name);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
};
export const saveToken = (token: string, login?: string): void => writePrivate('auth.json', JSON.stringify({ api: apiOrigin(), token, login }));
export function loadToken(): string | null {
  if (process.env.TENDRIL_TOKEN) return process.env.TENDRIL_TOKEN;
  const saved = readJson<{ api: string; token: string }>('auth.json');
  return saved && saved.api === apiOrigin() ? saved.token : null;
}

export interface Challenge { id: string; kind: ChallengeKind; number: number | null; seed: number; ticks: number; par: number | null; rulesVersion: number; setupVersion?: number }
export interface LastRun { api: string; challengeId: string; rulesVersion: number; actions: LogEntry[]; netWorth: number; parTick: number | null; mosaic: string; source: string }

async function api<T>(path: string, init: { body?: unknown; token?: string | null } = {}): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = { 'X-Tendril-Client': '1' };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${apiOrigin()}/api${path}`, { method: init.body !== undefined ? 'POST' : 'GET', headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  const text = await response.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  return { status: response.status, json: json as T };
}
const fail = (what: string, r: { status: number; json: unknown }): never => {
  const msg = (r.json as { error?: string } | null)?.error;
  throw new Error(`${what}: ${r.status}${msg ? ` ${msg}` : ''}`);
};

const MOSAIC: Record<string, string> = { '0': '⬛', t: '🟫', B: '🏠', h: '🍯', c: '♻️', 1: '🟨', 2: '🟧', 3: '🟥', 4: '🟪', 5: '🟦', 6: '⬜' };
export const renderMosaic = (m: string): string => Array.from({ length: 8 }, (_, y) => Array.from(m.slice(y * 8, y * 8 + 8), (c) => MOSAIC[c] ?? '⬛').join('')).join('\n');

export async function login(): Promise<void> {
  const nonce = randomBytes(32).toString('base64url');
  console.log(`Open this link to sign in with GitHub:\n\n  ${apiOrigin()}/api/auth/github?desktop=${nonce}\n\nWaiting...`);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const r = await api<{ token: string; profile: { login: string } }>('/auth/desktop/poll', { body: { nonce } });
    if (r.status === 200) { saveToken(r.json.token, r.json.profile.login); console.log(`Signed in as ${r.json.profile.login}.`); return; }
    if (r.status !== 202) fail('Sign-in failed', r);
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('Sign-in timed out.');
}

export async function getChallenge(id: string): Promise<Challenge> {
  const r = await api<Challenge>(`/challenges/${encodeURIComponent(id)}`);
  return r.status === 200 ? r.json : fail('Challenge', r);
}

/** Run a Sprout file on the challenge's world, then replay its log with par tracking (the same check the server makes). */
export function playLocal(c: Challenge, source: string): LastRun & { errors: string[] } {
  if (c.rulesVersion !== RULES_VERSION) throw new Error(`This CLI plays rules v${RULES_VERSION} but the challenge uses v${c.rulesVersion}. Update the CLI.`);
  const { setup } = challengeSetup(c.kind, c.seed, c.setupVersion ?? SETUP_LEGACY);
  const run = createRun(createWorld({ id: c.id, seed: c.seed }, setup), source);
  for (let left = c.ticks; left > 0; left -= Math.min(left, 20_000)) run.step(Math.min(left, 20_000));
  const actions = run.pending.slice();
  const fresh = createWorld({ id: c.id, seed: c.seed }, setup);
  const result = replayWithPar(fresh, actions, c.ticks, c.par ?? Number.MAX_SAFE_INTEGER);
  const errors = run.errors.map((e) => `Line ${e.line}, bot ${e.bot}: ${e.message}`);
  return { api: apiOrigin(), challengeId: c.id, rulesVersion: c.rulesVersion, actions, netWorth: result.netWorth, parTick: c.par === null ? null : result.parTick, mosaic: result.mosaic, source, errors };
}

export async function play(id: string, file: string | undefined): Promise<void> {
  const c = await getChallenge(id);
  console.log(`${c.kind} ${c.id}${c.number ? ` (#${c.number})` : ''}: seed ${c.seed}, ${c.ticks} ticks${c.par !== null ? `, par ${c.par}` : ''}`);
  const mods = describeModifiers(challengeSetup(c.kind, c.seed, c.setupVersion ?? SETUP_LEGACY).modifiers, c.kind);
  if (mods.length) console.log(`Today's modifiers: ${mods.join(', ')}`);
  if (!file) { console.log('Add a Sprout file to play it: tendril daily my.sprout'); return; }
  const { errors, ...last } = playLocal(c, readFileSync(file, 'utf8'));
  for (const e of errors) console.error(e);
  writePrivate('last-run.json', JSON.stringify(last));
  console.log(`Net worth: ${last.netWorth}`);
  console.log(`Par tick:  ${last.parTick === null ? (c.par === null ? 'no par for this challenge' : `par ${c.par} not reached`) : last.parTick}`);
  console.log(last.mosaic ? renderMosaic(last.mosaic) : '');
  console.log('Submit it with: tendril submit');
  if (errors.length) process.exitCode = 1;
}

export async function submit(): Promise<void> {
  const last = readJson<LastRun>('last-run.json');
  if (!last) throw new Error('Nothing to submit. Play first: tendril daily my.sprout');
  if (last.api !== apiOrigin()) throw new Error(`The last run was for ${last.api}; set TENDRIL_API to match.`);
  const token = loadToken();
  if (!token) throw new Error('Not signed in. Run: tendril login');
  const r = await api<{ netWorth: number; parTick: number | null; mosaic: string; ranks: { wealth: number | null; speed: number | null; brevity: number | null }; percentile: number; improved: boolean; total: number }>(
    `/challenges/${encodeURIComponent(last.challengeId)}/entries`, { token, body: { rulesVersion: last.rulesVersion, actions: last.actions } });
  if (r.status !== 200 && r.status !== 201) fail('Submit', r);
  const e = r.json;
  console.log(`Submitted to ${last.challengeId}${e.improved ? '' : ' (not an improvement on your best)'}`);
  console.log(`Net worth: ${e.netWorth}`);
  console.log(`Par tick:  ${e.parTick ?? 'not reached'}`);
  console.log(renderMosaic(e.mosaic));
  console.log(`Rank: wealth ${e.ranks.wealth ?? '-'}, speed ${e.ranks.speed ?? '-'}, brevity ${e.ranks.brevity ?? '-'} of ${e.total} (top ${100 - e.percentile + 1}%)`);
}

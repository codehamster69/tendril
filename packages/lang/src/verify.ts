// Source check for the Arena (C3): does this program, run on this challenge, produce exactly the submitted moves?
// Runs only in the separate verify function (api/verify.mjs). The main API function never imports this file.
import { createHash } from 'node:crypto';
import { challengeSetup, createWorld, isMarketTable, replayWithPar, RULES_VERSION, SETUP_LEGACY, SUPPORTED_RULES_VERSIONS } from '@tendril/sim/src/index.ts';
import type { ChallengeKind, LogEntry } from '@tendril/sim/src/index.ts';
import { compile } from './parser.ts';
import { createRun } from './interpreter.ts';
import { countTokens } from './tokens.ts';

export interface VerifyRequest { source: string; challengeId: string; kind: ChallengeKind; seed: number; ticks: number; rulesVersion: number; /** Absent means 0, the plain farm of challenges created before modifiers. */ setupVersion?: number;
  /** The day's market table (rules v4). Required for v4 and refused for v3, exactly as the challenge row stores it. */ market?: { p: number[] } | null }
export type VerifyResult =
  | { ok: true; tokens: number; logHash: string; actions: number; /** End net worth of the verified run (used to set par from the reference program). */ netWorth: number }
  | { ok: false; reason: 'compile' | 'timeout' | 'rules' | 'bad'; message: string };

/** SHA-256 hex of JSON.stringify(actions): the same value the server stores as entries.log_hash. */
export const hashLog = (actions: LogEntry[]): string => createHash('sha256').update(JSON.stringify(actions)).digest('hex');

export const MAX_VERIFY_SOURCE_BYTES = 32 * 1024;
export const VERIFY_DEADLINE_MS = 8000;
/** Elements and characters a checked program may allocate in total. Small programs use thousands; a memory bomb reaches this in well under a second and stops with an error instead of exhausting the function. */
export const VERIFY_ALLOCATION_BUDGET = 5_000_000;
/** Ticks run between clock checks. One tick is bounded by the interpreter's 5,000-step budget per bot. */
const SLICE = 4;

export interface VerifyOptions { deadlineMs?: number; now?: () => number }

export function verifySource(req: VerifyRequest, options: VerifyOptions = {}): VerifyResult {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? VERIFY_DEADLINE_MS);
  if (!SUPPORTED_RULES_VERSIONS.includes(req.rulesVersion)) return { ok: false, reason: 'rules', message: 'Rules version mismatch' };
  // Dispatch by data: a v4 challenge carries its table, a v3 challenge never does.
  if ((req.rulesVersion === RULES_VERSION) !== (req.market != null) || (req.market != null && !isMarketTable(req.market))) return { ok: false, reason: 'rules', message: 'Rules version mismatch' };
  if (typeof req.source !== 'string' || new TextEncoder().encode(req.source).length > MAX_VERIFY_SOURCE_BYTES) return { ok: false, reason: 'bad', message: 'Source is too large' };
  if (!Number.isSafeInteger(req.ticks) || req.ticks < 1 || req.ticks > 20_000 || !Number.isSafeInteger(req.seed)) return { ok: false, reason: 'bad', message: 'Invalid challenge' };
  const compiled = compile(req.source);
  if (!compiled.program) {
    const d = compiled.diagnostics.find((x) => x.severity === 'error') ?? compiled.diagnostics[0];
    return { ok: false, reason: 'compile', message: d ? `Line ${d.line}: ${d.message}` : 'The program does not compile' };
  }
  let setup;
  try { setup = challengeSetup(req.kind, req.seed, req.setupVersion ?? SETUP_LEGACY, req.market).setup; } catch { return { ok: false, reason: 'bad', message: 'Invalid challenge' }; }
  const world = createWorld({ id: req.challengeId, seed: req.seed }, setup);
  const run = createRun(world, req.source, { allocationBudget: VERIFY_ALLOCATION_BUDGET });
  while (world.tick < req.ticks) {
    run.step(Math.min(SLICE, req.ticks - world.tick));
    if (world.tick < req.ticks && now() > deadline) { run.close(); return { ok: false, reason: 'timeout', message: 'The program took too long to check' }; }
  }
  const actions = run.pending.filter((a) => a[0] < req.ticks);
  run.close();
  let netWorth: number;
  try { netWorth = replayWithPar(createWorld({ id: req.challengeId, seed: req.seed }, setup), actions, req.ticks, Number.MAX_SAFE_INTEGER).netWorth; }
  catch { return { ok: false, reason: 'bad', message: 'The run is not a legal log' }; }
  return { ok: true, tokens: countTokens(req.source), logHash: hashLog(actions), actions: actions.length, netWorth };
}

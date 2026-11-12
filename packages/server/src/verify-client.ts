// The main function never runs player code. It asks the separate verify function (api/verify.mjs, built from
// @tendril/lang) whether a program produces a submitted log. Only plain data crosses this seam.
import { createHash } from 'node:crypto';
import type { ChallengeKind } from '@tendril/sim/src/index.ts';

export interface VerifyRequest { source: string; challengeId: string; kind: ChallengeKind; seed: number; ticks: number; rulesVersion: number }
export type VerifyResult =
  | { ok: true; tokens: number; logHash: string; actions: number }
  | { ok: false; reason: 'compile' | 'timeout' | 'rules' | 'bad'; message: string };
/** Resolves with the verdict, or rejects when the check could not be made at all (the caller answers 503). */
export type SourceVerifier = (request: VerifyRequest) => Promise<VerifyResult>;

/** Same derivation as packages/lang/src/vercel-verify.ts. VERIFY_SECRET wins; the Turso token is the zero-config default. */
export const verifySecret = (env: Record<string, string | undefined>): string =>
  createHash('sha256').update(`tendril-verify:${env.VERIFY_SECRET ?? env.TURSO_AUTH_TOKEN ?? ''}`).digest('hex');

export function remoteVerifier(origin: string, env: Record<string, string | undefined>, fetchFn: typeof fetch = fetch, timeoutMs = 20_000): SourceVerifier {
  const secret = verifySecret(env);
  return async (request) => {
    const response = await fetchFn(`${origin.replace(/\/+$/, '')}/api/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tendril-Verify': secret },
      body: JSON.stringify(request), signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (!response.ok) throw new Error(`verify ${response.status}`);
    const result = (await response.json()) as VerifyResult;
    if (!result || typeof result.ok !== 'boolean') throw new Error('verify: bad answer');
    return result;
  };
}

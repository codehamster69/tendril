// Vercel function entry for the source check (bundled by scripts/build-api.mjs into dist-api/verify.mjs and
// re-exported by api/verify.mjs). The main API function calls it with a shared secret; nothing else should.
// It holds no database and no user data: the answer is a pure function of the request.
import { createHash, timingSafeEqual } from 'node:crypto';
import { verifySource } from './verify.ts';
import type { VerifyRequest } from './verify.ts';

export const MAX_VERIFY_BODY = 64 * 1024;

/** Shared with the main function (packages/server/src/verify-client.ts derives the same value). */
export const verifySecret = (env: Record<string, string | undefined>): string =>
  createHash('sha256').update(`tendril-verify:${env.VERIFY_SECRET ?? env.TURSO_AUTH_TOKEN ?? ''}`).digest('hex');

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

const KINDS = ['daily', 'season', 'duel'];

export async function handleVerify(request: Request, env: Record<string, string | undefined>): Promise<Response> {
  if (request.method !== 'POST') return reply({ error: 'Not found' }, 404);
  const sent = Buffer.from(request.headers.get('x-tendril-verify') ?? '');
  const want = Buffer.from(verifySecret(env));
  if (sent.length !== want.length || !timingSafeEqual(sent, want)) return reply({ error: 'Not found' }, 404);
  const text = await request.text();
  if (text.length > MAX_VERIFY_BODY) return reply({ error: 'Too large' }, 413);
  let body: Partial<VerifyRequest>;
  try { body = JSON.parse(text) as Partial<VerifyRequest>; } catch { return reply({ error: 'Invalid request' }, 400); }
  if (!body || typeof body !== 'object' || typeof body.source !== 'string' || typeof body.challengeId !== 'string' || typeof body.kind !== 'string'
    || !KINDS.includes(body.kind) || typeof body.seed !== 'number' || typeof body.ticks !== 'number' || typeof body.rulesVersion !== 'number'
    || (body.setupVersion !== undefined && typeof body.setupVersion !== 'number')) return reply({ error: 'Invalid request' }, 400);
  return reply(verifySource(body as VerifyRequest));
}

export default {
  async fetch(request: Request): Promise<Response> { return handleVerify(request, process.env); },
};

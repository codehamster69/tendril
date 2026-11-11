import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { asService } from './db.ts';

export type Auth = (request: Request) => Promise<{ userId: string } | null>;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function createLocalAuth(db: PGlite): Auth {
  return async (request) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '');
    if (!match) return null;
    return asService(db, async (tx) => {
      const result = await tx.query<{ user_id: string }>('SELECT user_id FROM sessions WHERE token_hash = $1', [hashToken(match[1]!)]);
      const session = result.rows[0];
      return session ? { userId: session.user_id } : null;
    });
  };
}

// Display names never authenticate an existing identity; this adapter is local development only.
export async function localLogin(db: PGlite, displayName: string, now: number) {
  const userId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await asService(db, async (tx) => {
    await tx.query('INSERT INTO profiles (id, display_name, created_at_ms) VALUES ($1, $2, $3)', [userId, displayName, now]);
    await tx.query('INSERT INTO sessions (token_hash, user_id, created_at_ms) VALUES ($1, $2, $3)', [hashToken(token), userId, now]);
  });
  return { token, profile: { id: userId, displayName } };
}

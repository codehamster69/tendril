import { readFile } from 'node:fs/promises';
import type { PGlite, Transaction } from '@electric-sql/pglite';

export async function initializeDb(db: PGlite): Promise<void> {
  const sql = await readFile(new URL('../migrations/001_game.up.sql', import.meta.url), 'utf8');
  await db.transaction(async (tx) => {
    await tx.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)');
    const applied = await tx.query('SELECT version FROM schema_migrations WHERE version = $1', [1]);
    if (applied.rows.length === 0) {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [1]);
    }
  });
}

export async function asService<T>(db: PGlite, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    return work(tx);
  });
}

export function safeNumber(value: number | string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Unsafe database number');
  return number;
}

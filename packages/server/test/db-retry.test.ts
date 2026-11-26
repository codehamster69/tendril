import { describe, expect, it } from 'vitest';
import { LibsqlError } from '@libsql/client';
import { createDb, isTransientDbError } from '../src/db.ts';

type Fake = { executes: number; transactions: number; commits: number; rollbacks: number };

/** A client whose calls fail with the scripted errors, in order, before succeeding. */
function fakeClient(script: { execute?: unknown[]; begin?: unknown[]; commit?: unknown[] }, counts: Fake) {
  const next = (queue: unknown[] | undefined) => { const item = queue?.shift(); if (item) throw item; };
  const runner = {
    execute: async () => { counts.executes += 1; next(script.execute); return { columns: ['n'], rows: [[1]], rowsAffected: 0 }; },
  };
  return {
    execute: runner.execute,
    executeMultiple: async () => undefined,
    close: () => undefined,
    transaction: async () => {
      counts.transactions += 1;
      next(script.begin);
      return {
        execute: runner.execute,
        commit: async () => { counts.commits += 1; next(script.commit); },
        rollback: async () => { counts.rollbacks += 1; },
        close: () => undefined,
      };
    },
  };
}

const err = (code: string) => new LibsqlError(`${code} detail`, code);
const fresh = (): Fake => ({ executes: 0, transactions: 0, commits: 0, rollbacks: 0 });

describe('db transient retries', () => {
  it('classifies busy as transient for writes, and network drops only for reads', () => {
    expect(isTransientDbError(err('SQLITE_BUSY'), true)).toBe(true);
    expect(isTransientDbError(err('SERVER_ERROR'), true)).toBe(false);
    expect(isTransientDbError(err('SERVER_ERROR'), false)).toBe(true);
    expect(isTransientDbError(err('SQLITE_CONSTRAINT'), false)).toBe(false);
    expect(isTransientDbError(new Error('plain'), false)).toBe(false);
  });

  it('retries a busy read and then returns the rows', async () => {
    const counts = fresh();
    const db = createDb({ url: 'libsql://x', createClient: () => fakeClient({ execute: [err('SQLITE_BUSY')] }, counts) as never });
    expect(await db.query('SELECT 1')).toEqual([{ n: 1 }]);
    expect(counts.executes).toBe(2);
  });

  it('does not retry a write on a network failure, since it may have applied', async () => {
    const counts = fresh();
    const db = createDb({ url: 'libsql://x', createClient: () => fakeClient({ execute: [err('SERVER_ERROR')] }, counts) as never });
    await expect(db.execute('UPDATE t SET a = 1')).rejects.toMatchObject({ code: 'SERVER_ERROR' });
    expect(counts.executes).toBe(1);
  });

  it('gives up after three attempts and rethrows the last error', async () => {
    const counts = fresh();
    const db = createDb({ url: 'libsql://x', createClient: () => fakeClient({ execute: [err('SQLITE_BUSY'), err('SQLITE_BUSY'), err('SQLITE_BUSY')] }, counts) as never });
    await expect(db.query('SELECT 1')).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    expect(counts.executes).toBe(3);
  });

  it('reruns a whole transaction when it was busy before commit, but never after a failed commit', async () => {
    const busy = fresh();
    const retryDb = createDb({ url: 'libsql://x', createClient: () => fakeClient({ begin: [err('SQLITE_BUSY')] }, busy) as never });
    expect(await retryDb.transaction(async (tx) => (await tx.query('SELECT 1')).length)).toBe(1);
    expect(busy.transactions).toBe(2);

    const commitFail = fresh();
    const commitDb = createDb({ url: 'libsql://x', createClient: () => fakeClient({ commit: [err('SQLITE_BUSY')] }, commitFail) as never });
    await expect(commitDb.transaction(async () => 1)).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    expect(commitFail.transactions).toBe(1);
    expect(commitFail.commits).toBe(1);
  });
});

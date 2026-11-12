import { createClient } from '@libsql/client';
import type { Client, InValue } from '@libsql/client';

export type Args = InValue[];
export interface RunResult { rowsAffected: number }

/** Operations available both on the database and inside a transaction. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, args?: Args): Promise<T[]>;
  execute(sql: string, args?: Args): Promise<RunResult>;
}

export interface Db extends Queryable {
  /** Runs `fn` in a write transaction. Throwing rolls everything back. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Runs a multi-statement script (used by migrations only; never with request data). */
  script(sql: string): Promise<void>;
  close(): void;
}

export interface DbOptions {
  url: string;
  authToken?: string;
  /** Client factory. Defaults to the full `@libsql/client` (file:, :memory: and remote); the Vercel bundle injects the web client. */
  createClient?: (config: { url: string; authToken?: string }) => Client;
}

const isLocal = (url: string): boolean => url === ':memory:' || url.startsWith('file:');

type Run = Pick<Client, 'execute'>;

function queryable(client: Run): Queryable {
  return {
    async query<T>(sql: string, args: Args = []): Promise<T[]> {
      const result = await client.execute({ sql, args });
      return result.rows.map((row) => {
        const plain: Record<string, unknown> = {};
        result.columns.forEach((name, i) => { plain[name] = row[i]; });
        return plain as T;
      });
    },
    async execute(sql: string, args: Args = []): Promise<RunResult> {
      const result = await client.execute({ sql, args });
      return { rowsAffected: result.rowsAffected };
    },
  };
}

/**
 * Thin wrapper over @libsql/client. Remote URLs (libsql:, https:) use real libSQL write transactions.
 * Local URLs (`:memory:`, `file:`) use one connection, so every operation is serialised through a
 * queue and transactions are explicit BEGIN IMMEDIATE ... COMMIT blocks on that connection.
 * The client is created lazily and nothing connects until the first query.
 */
export function createDb(options: DbOptions): Db {
  let client: Client | undefined;
  const get = (): Client => (client ??= (options.createClient ?? createClient)({ url: options.url, authToken: options.authToken || undefined }));
  const local = isLocal(options.url);
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
  const direct = queryable({ execute: (stmt) => get().execute(stmt) });
  return {
    query: (sql, args) => (local ? exclusive(() => direct.query(sql, args)) : direct.query(sql, args)),
    execute: (sql, args) => (local ? exclusive(() => direct.execute(sql, args)) : direct.execute(sql, args)),
    async script(sql) {
      const run = async (): Promise<void> => { await get().executeMultiple(sql); };
      await (local ? exclusive(run) : run());
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      if (!local) {
        const tx = await get().transaction('write');
        try {
          const value = await fn(queryable(tx));
          await tx.commit();
          return value;
        } catch (error) {
          try { await tx.rollback(); } catch { /* connection already gone */ }
          throw error;
        } finally { tx.close(); }
      }
      return exclusive(async () => {
        const conn = get();
        await conn.execute('BEGIN IMMEDIATE');
        try {
          const value = await fn(queryable(conn));
          await conn.execute('COMMIT');
          return value;
        } catch (error) {
          try { await conn.execute('ROLLBACK'); } catch { /* nothing to roll back */ }
          throw error;
        }
      });
    },
    close() { client?.close(); client = undefined; },
  };
}

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

/** Wraps a commit failure so the retry loop stops at it; unwrapped before it reaches callers. */
class AmbiguousCommit extends Error {
  constructor(readonly cause: unknown) { super('commit outcome unknown'); }
}

const isLocal = (url: string): boolean => url === ':memory:' || url.startsWith('file:');

/**
 * Transient libSQL failures: the statement did not run (busy/locked database) or the connection dropped
 * before a reply (remote HTTP/WebSocket failure). Codes come from @libsql/client; nothing else is retried.
 */
const BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED']);
const NETWORK_CODES = new Set(['SERVER_ERROR', 'HRANA_WEBSOCKET_ERROR', 'HRANA_CLOSED_ERROR']);

/** The libSQL error code of a failure, or undefined when it is not a database error. */
export function dbErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'LibsqlError') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
  return undefined;
}

/** True when the failure is transient. `write` limits retries to failures where the statement certainly did not apply. */
export function isTransientDbError(error: unknown, write: boolean): boolean {
  const code = dbErrorCode(error);
  if (code === undefined) return false;
  if (BUSY_CODES.has(code)) return true;
  return !write && NETWORK_CODES.has(code);
}

const ATTEMPTS = 3;
const BACKOFF_MS = [60, 240];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Retries `work` on transient failures with short backoff (about 0.3 s at most, well inside the 30 s function limit). */
async function retried<T>(work: () => Promise<T>, write: boolean): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= ATTEMPTS || !isTransientDbError(error, write)) throw error;
      await sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
    }
  }
}

type Run = Pick<Client, 'execute'>;

function queryable(client: Run, retry: <T>(work: () => Promise<T>, write: boolean) => Promise<T> = (work) => work()): Queryable {
  return {
    async query<T>(sql: string, args: Args = []): Promise<T[]> {
      const result = await retry(() => client.execute({ sql, args }), false);
      return result.rows.map((row) => {
        const plain: Record<string, unknown> = {};
        result.columns.forEach((name, i) => { plain[name] = row[i]; });
        return plain as T;
      });
    },
    async execute(sql: string, args: Args = []): Promise<RunResult> {
      const result = await retry(() => client.execute({ sql, args }), true);
      return { rowsAffected: result.rowsAffected };
    },
  };
}

/**
 * Thin wrapper over @libsql/client. Remote URLs (libsql:, https:) use real libSQL write transactions.
 * Local URLs (`:memory:`, `file:`) serialise every operation through a queue, so a transaction never
 * waits on a connection another open transaction holds.
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
  const direct = queryable({ execute: (stmt) => get().execute(stmt) }, retried);
  return {
    query: (sql, args) => (local ? exclusive(() => direct.query(sql, args)) : direct.query(sql, args)),
    execute: (sql, args) => (local ? exclusive(() => direct.execute(sql, args)) : direct.execute(sql, args)),
    async script(sql) {
      const run = async (): Promise<void> => { await get().executeMultiple(sql); };
      await (local ? exclusive(run) : run());
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      // A libSQL transaction owns its connection; a BEGIN sent through execute() no longer survives,
      // because @libsql/client pools local connections and rolls back any it gets back mid-transaction.
      // The whole transaction is retried only when it failed before its commit: a rollback leaves nothing behind,
      // so re-running `fn` is safe. A failed commit is ambiguous (it may have applied) and is never retried.
      const attempt = async (): Promise<T> => {
        const tx = await get().transaction('write');
        let committing = false;
        try {
          const value = await fn(queryable(tx));
          committing = true;
          await tx.commit();
          return value;
        } catch (error) {
          try { await tx.rollback(); } catch { /* connection already gone */ }
          if (committing) throw new AmbiguousCommit(error);
          throw error;
        } finally { tx.close(); }
      };
      const run = async (): Promise<T> => {
        try {
          return await retried(attempt, true);
        } catch (error) {
          throw error instanceof AmbiguousCommit ? error.cause : error;
        }
      };
      return local ? exclusive(run) : run();
    },
    close() { client?.close(); client = undefined; },
  };
}

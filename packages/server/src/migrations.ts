import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Db } from './db.ts';

/**
 * Candidate migration directories. No `import.meta` here: the Vercel build may compile this file as CommonJS.
 * On Vercel the working directory is the project root and `functions.includeFiles` ships packages/server/migrations.
 */
function migrationDirs(extra: URL[]): URL[] {
  return [
    ...extra,
    new URL(`file://${resolve(process.cwd(), 'packages/server/migrations')}/`),
    new URL(`file://${resolve(process.cwd(), 'migrations')}/`),
  ];
}

async function loadMigrations(extra: URL[]): Promise<{ version: number; name: string; sql: string }[]> {
  for (const dir of migrationDirs(extra)) {
    let files: string[];
    try { files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort(); } catch { continue; }
    if (files.length === 0) continue;
    return Promise.all(files.map(async (name) => ({
      version: Number(/^(\d+)_/.exec(name)![1]), name, sql: await readFile(new URL(name, dir), 'utf8'),
    })));
  }
  throw new Error('Migration files not found');
}

/** Applies pending migrations in order (each file runs in a transaction), recording them in schema_version. */
export async function migrate(db: Db, now: () => number = Date.now, extraDirs: URL[] = []): Promise<number[]> {
  await db.execute('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const done = new Set((await db.query<{ version: number }>('SELECT version FROM schema_version')).map((r) => r.version));
  const applied: number[] = [];
  for (const m of await loadMigrations(extraDirs)) {
    if (done.has(m.version)) continue;
    try {
      // The files are idempotent, so a crash between the script and the stamp only means a harmless re-run.
      await db.script(`BEGIN;\n${m.sql}\nCOMMIT;`);
    } catch (error) {
      try { await db.execute('ROLLBACK'); } catch { /* no open transaction */ }
      throw error;
    }
    await db.execute('INSERT OR IGNORE INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, Math.trunc(now())]);
    applied.push(m.version);
  }
  return applied;
}


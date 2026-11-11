import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.ts';
import { migrate } from './migrations.ts';

// CLI: `pnpm --filter @tendril/server migrate`. Uses TURSO_DATABASE_URL / TURSO_AUTH_TOKEN, else a local file under .data/.
const dataDir = fileURLToPath(new URL('../../../.data', import.meta.url));
if (!process.env.TURSO_DATABASE_URL) await mkdir(dataDir, { recursive: true });
const db = createDb({ url: process.env.TURSO_DATABASE_URL || `file:${resolve(dataDir, 'tendril.db')}`, authToken: process.env.TURSO_AUTH_TOKEN });
try {
  const applied = await migrate(db, Date.now, [new URL('../migrations/', import.meta.url)]);
  console.info(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date');
} finally { db.close(); }

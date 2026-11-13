import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALGO_VERSION } from '@tendril/rating/src/index.ts';
import { createDb } from './db.ts';
import { migrate } from './migrations.ts';
import { recomputeRatings } from './ratings.ts';

// CLI: `pnpm --filter @tendril/server ratings:recompute [-- --algo <n>]`. Rebuilds every rating from stored standings with the engine
// in this checkout (algorithm version must match its ALGO_VERSION). Uses TURSO_DATABASE_URL / TURSO_AUTH_TOKEN, else a local file under .data/.
const flag = process.argv.indexOf('--algo');
const algo = flag > 0 ? Number(process.argv[flag + 1]) : ALGO_VERSION;
if (!Number.isInteger(algo)) throw new Error('--algo needs an integer');
const dataDir = fileURLToPath(new URL('../../../.data', import.meta.url));
if (!process.env.TURSO_DATABASE_URL) await mkdir(dataDir, { recursive: true });
const db = createDb({ url: process.env.TURSO_DATABASE_URL || `file:${resolve(dataDir, 'tendril.db')}`, authToken: process.env.TURSO_AUTH_TOKEN });
try {
  await migrate(db, Date.now, [new URL('../migrations/', import.meta.url)]);
  const r = await recomputeRatings(db, process.env, Date.now(), algo);
  console.info(`Recomputed ${r.contests} contests with algorithm version ${algo} (${r.writes} rows written)`);
} finally { db.close(); }

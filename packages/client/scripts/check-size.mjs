// Fails when the compressed JavaScript needed for first load grows past the budget in perf-budget.json.
// First load = the entry script and modulepreload chunks listed in dist/index.html, plus the simulation worker chunk.
// Run after `pnpm build`:  node scripts/check-size.mjs   (add --update to rewrite the budget to today's size)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, process.env.VITE_OUT ?? 'dist');
const budgetFile = join(root, 'perf-budget.json');
if (!existsSync(join(dist, 'index.html'))) { console.error(`size check: ${dist}/index.html not found. Run the client build first.`); process.exit(1); }

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const files = new Set();
for (const m of html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="\.?\/?(?:[^"]*?\/)?(assets\/[^"]+\.js)"/g)) files.add(m[1]);
for (const f of readdirSync(join(dist, 'assets'))) if (/^sim-worker.*\.js$/.test(f)) files.add(`assets/${f}`);
if (files.size === 0) { console.error('size check: no scripts found in index.html'); process.exit(1); }

let total = 0;
const rows = [];
for (const f of files) {
  const size = gzipSync(readFileSync(join(dist, f)), { level: 9 }).length;
  total += size;
  rows.push([size, f]);
}
rows.sort((a, b) => b[0] - a[0]);
for (const [size, f] of rows) console.log(`${(size / 1024).toFixed(1).padStart(8)} KB gzip  ${f}`);
console.log(`${(total / 1024).toFixed(1).padStart(8)} KB gzip  first-load total (${files.size} scripts)`);

if (process.argv.includes('--update')) {
  const old = existsSync(budgetFile) ? JSON.parse(readFileSync(budgetFile, 'utf8')) : {};
  writeFileSync(budgetFile, JSON.stringify({ ...old, firstLoadGzipBytes: total }, null, 2) + '\n');
  console.log(`budget set to ${total} bytes`);
  process.exit(0);
}
const budget = JSON.parse(readFileSync(budgetFile, 'utf8')).firstLoadGzipBytes;
if (total > budget) {
  console.error(`size check FAILED: ${total} bytes gzip is over the budget of ${budget} (${total - budget} over). If the growth is intended, run: node scripts/check-size.mjs --update`);
  process.exit(1);
}
console.log(`size check ok: ${total} of ${budget} bytes (${((total / budget) * 100).toFixed(1)}%)`);

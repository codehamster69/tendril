// Smoke test for the built Vercel function: run `vercel build` first. Loads .vercel/output/functions/api/index.func
// exactly as built (its .vc-config.json handler), then calls three GET endpoints through the handler:
//   1. with TURSO_DATABASE_URL unset  -> must answer 503 {"error": ...}
//   2. against a local `sqld` (libSQL server, started on a temp database) if the binary is installed -> must answer 200
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const funcDir = resolve('.vercel/output/functions/api/index.func');
const config = JSON.parse(readFileSync(join(funcDir, '.vc-config.json'), 'utf8'));
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
const mod = await import(pathToFileURL(join(funcDir, config.handler)).href); // no ERR_REQUIRE_ESM / missing module
const handler = mod.default;
if (typeof handler?.fetch !== 'function') throw new Error(`handler ${config.handler} has no default fetch()`);
console.log(`loaded ${config.handler} (${config.runtime}, ${config.launcherType})`);

const paths = ['/api/stats', '/api/daily', '/api/leaderboard?board=networth'];
let failed = false;
async function call(path, expect) {
  const res = await handler.fetch(new Request(`http://localhost${path}`));
  const body = await res.text();
  console.log(`${res.status} GET ${path} ${body.slice(0, 300)}`);
  if (res.status !== expect) { failed = true; console.error(`  expected ${expect}`); }
}

console.log('--- without TURSO_DATABASE_URL (expect 503)');
for (const p of paths) await call(p, 503);

const freePort = () => new Promise((ok, no) => {
  const s = createServer(); s.once('error', no);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => { ok(port); }); });
});

if (spawnSync('sqld', ['--version']).error) {
  console.log('--- sqld not installed: skipping the live-database pass');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'tendril-sqld-'));
  const port = await freePort();
  const sqld = spawn('sqld', ['--db-path', join(dir, 'data.sqld'), '--http-listen-addr', `127.0.0.1:${port}`], { stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
      if (i > 100) throw new Error('sqld did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
    process.env.TURSO_DATABASE_URL = `http://127.0.0.1:${port}`;
    console.log('--- with TURSO_DATABASE_URL = local sqld over HTTP (expect 200, migrations run inside the bundle)');
    for (const p of paths) await call(p, 200);
  } finally { sqld.kill(); rmSync(dir, { recursive: true, force: true }); }
}
process.exit(failed ? 1 : 0);

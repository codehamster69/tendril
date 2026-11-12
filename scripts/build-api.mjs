// Bundles the serverless API into ONE self-contained ESM file, dist-api/index.mjs (gitignored, rebuilt by `pnpm build:web`).
// @tendril/sim and the server sources are inlined, the migration SQL is embedded, and the libSQL web client has no
// native dependency, so the function needs neither node_modules tracing nor TypeScript at runtime.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const migrationsDir = resolve(root, 'packages/server/migrations');

const migrationsPlugin = {
  name: 'tendril-migrations',
  setup(b) {
    b.onResolve({ filter: /^virtual:tendril-migrations$/ }, () => ({ path: 'tendril-migrations', namespace: 'tendril' }));
    b.onLoad({ filter: /.*/, namespace: 'tendril' }, () => {
      const files = readdirSync(migrationsDir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
      const list = files.map((name) => ({ version: Number(/^(\d+)_/.exec(name)[1]), name, sql: readFileSync(resolve(migrationsDir, name), 'utf8') }));
      return { contents: `export default ${JSON.stringify(list)};`, loader: 'js', watchFiles: files.map((f) => resolve(migrationsDir, f)) };
    });
  },
};

const webClientPlugin = {
  name: 'libsql-web-client',
  setup(b) {
    b.onResolve({ filter: /^@libsql\/client$/ }, (args) => b.resolve('@libsql/client/web', { resolveDir: args.resolveDir, kind: args.kind }));
  },
};

await build({
  entryPoints: [resolve(root, 'packages/server/src/vercel.ts')],
  outfile: resolve(root, 'dist-api/index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['node', 'import'],
  mainFields: ['module', 'main'],
  // db.ts imports the default client (native `libsql` binding, needed for file:/:memory: in tests and dev); in the
  // function only remote URLs are used, so swap in the pure HTTP/WebSocket client and keep native code out of the bundle.
  plugins: [migrationsPlugin, webClientPlugin],
  // Some CJS dependencies call require(); give them one in ESM output.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('api bundle ready: dist-api/index.mjs');

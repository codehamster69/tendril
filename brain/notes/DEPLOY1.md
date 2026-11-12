# DEPLOY1: Vercel function fix

Root cause (confirmed): Vercel compiled `api/index.ts` to CommonJS `api/index.js`, which `require()`d the raw
`packages/server/src/index.ts` (ESM, `.ts` specifiers, shipped untouched via `includeFiles`) -> ERR_REQUIRE_ESM. Server code
was never compiled and `@libsql/client` was not traced.

Design (proven with `vercel build`): esbuild bundles server + `@tendril/sim` + migration SQL + the libSQL **web** client into one
ESM file `dist-api/index.mjs` (gitignored, built by `pnpm build:web` via `scripts/build-api.mjs`). `api/index.mjs` is a committed
3-line stub re-exporting it. Why the stub: `vercel build` detects functions BEFORE `buildCommand` runs (a generated, gitignored
`api/index.mjs` failed with `unused_function ... doesn't match any Serverless Functions`), so a file must exist at detection time;
Vercel's tracing then pulls the built bundle into `.vercel/output/functions/api/index.func/dist-api/index.mjs`. `.mjs` is run as
native ESM (no CJS compile). Rejected: committed bundle (drift), root `"type":"module"` (still ships raw `.ts`).

Changes: `vercel.json` functions -> `{"api/index.mjs": {"maxDuration": 30}}` (removed `includeFiles`; nothing is read from disk).
`api/index.ts` removed. New `packages/server/src/vercel.ts` (entry; 503 `{"error":"Storage is not configured"}` when
`TURSO_DATABASE_URL` is unset, nothing runs at import), `virtual.d.ts`, `scripts/build-api.mjs`, `scripts/smoke-api.mjs`.
`db.ts`: injectable `createClient` option. `migrations.ts`/`app.ts`: optional embedded `migrations` (disk lookup unchanged when absent).
`build-web.mjs` runs build-api first. Root devDependency `esbuild`. ESLint ignores `dist-api`, `.vercel`.
The bundle aliases `@libsql/client` -> `@libsql/client/web` so no native `libsql` binding is bundled (verified: no reference).
HTTP contract, cookies, CORS and rate limits untouched.

Checks: lint, typecheck exit 0; tests sim 48, server 379, lang 12 pass; `pnpm build:web` exit 0 (game under `/play/`);
`vercel build` ok; `node scripts/smoke-api.mjs` loads the built handler (no module error). Smoke results:
- env unset: 503 `{"error":"Storage is not configured"}` for /api/stats, /api/daily, /api/leaderboard?board=networth.
- live pass against a local `sqld` over HTTP (installed): 200 `{"players":0,"farms":0,"dailyEntries":0}`; 200 `{"date":...,"seed":...,"ticks":3000,"rulesVersion":3}`;
  200 `{"board":"networth","entries":[]}`. Migrations ran from the embedded SQL.

Local note: `vercel build` initially refused (no project settings) and `vercel pull` would write env files, so I temporarily added a
`settings` block to the ignored `.vercel/project.json` (restored afterwards).

Unverifiable without a deployment: real Turso connection/auth token, GitHub OAuth, Vercel's own (git-clone) detection of the
stub (same logic as local `vercel build`), Node 26 runtime behaviour of the lambda wrapper (local CLI used nodejs24.x config).

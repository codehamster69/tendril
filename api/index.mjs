// Vercel function entry. The real code is the self-contained bundle built by scripts/build-api.mjs
// (run from `pnpm build:web`), which inlines the server, @tendril/sim, the libSQL web client and the migration SQL.
// This stub must exist before the build so Vercel detects the function; it only re-exports the bundle.
export { default } from '../dist-api/index.mjs';

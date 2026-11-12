// Vercel function entry for the source check (C3). Like api/index.mjs, this stub only re-exports the bundle built by
// scripts/build-api.mjs. It is a separate function so the main API never imports the Sprout interpreter.
export { default } from '../dist-api/verify.mjs';

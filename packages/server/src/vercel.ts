import { createClient } from '@libsql/client/web';
import { createApp } from './app.ts';
import { createDb } from './db.ts';
import { remoteVerifier } from './verify-client.ts';
// Provided by scripts/build-api.mjs: the contents of packages/server/migrations/*.sql, inlined at build time.
import migrations from 'virtual:tendril-migrations';

// Vercel function entry (bundled by scripts/build-api.mjs into api/index.mjs). Web-standard handler: a default export
// with `fetch(Request)`. The pure HTTP/WebSocket libSQL client is used (no native binding), so only remote
// libsql:// / https:// URLs work here. Nothing runs at import time: missing configuration answers 503.
type Handler = (request: Request) => Promise<Response>;
let handler: Handler | undefined;

function verifyOrigin(env: NodeJS.ProcessEnv): string {
  return env.PUBLIC_ORIGIN?.replace(/\/+$/, '') || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : 'http://localhost:3000');
}

function getHandler(env: NodeJS.ProcessEnv): Handler {
  handler ??= createApp({
    db: createDb({ url: env.TURSO_DATABASE_URL ?? '', authToken: env.TURSO_AUTH_TOKEN, createClient }),
    env,
    fetch: (input, init) => fetch(input, init),
    now: Date.now,
    migrations,
    // The program check runs in its own function (api/verify.mjs); this one never imports the interpreter.
    verifySource: remoteVerifier(verifyOrigin(env), env),
  });
  return handler;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (!process.env.TURSO_DATABASE_URL) {
      return new Response(JSON.stringify({ error: 'Storage is not configured' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    return getHandler(process.env)(request);
  },
};

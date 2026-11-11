import { createApp, createDb } from '../packages/server/src/index.ts';

// Vercel Node.js function using the Web-standard handler form: a default export with a `fetch(Request)` method
// that returns a `Response`. The Vercel rewrite `/api/(.*)` -> `/api` keeps the original URL in `request.url`.
// Nothing connects at import time: the libSQL client and the app are created on the first invocation and
// reused by later invocations of the same warm instance.
let handler: ((request: Request) => Promise<Response>) | undefined;

function getHandler(): (request: Request) => Promise<Response> {
  handler ??= createApp({
    db: createDb({ url: process.env.TURSO_DATABASE_URL ?? '', authToken: process.env.TURSO_AUTH_TOKEN }),
    env: process.env,
    fetch: (input, init) => fetch(input, init),
    now: Date.now,
  });
  return handler;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (!process.env.TURSO_DATABASE_URL) {
      return new Response(JSON.stringify({ error: 'Storage is not configured' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    return getHandler()(request);
  },
};

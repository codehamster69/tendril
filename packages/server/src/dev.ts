import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { createDb } from './db.ts';
// Dev only: the local server runs the source check in-process. Production uses the separate verify function.
import { verifySource } from '../../lang/src/verify.ts';

const PORT = 8787;
const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

/** Adapts Node requests to the Fetch-API app. Importing this module must not open a database or bind the port. */
export function createListener(handler: (request: Request) => Promise<Response>, allowedHosts: ReadonlySet<string> = hosts): RequestListener {
  return async (incoming, outgoing) => {
    try {
      if (!allowedHosts.has(incoming.headers.host ?? '') || !incoming.url?.startsWith('/') || incoming.url.startsWith('//')) {
        outgoing.writeHead(403, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ error: 'Host not allowed' }));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const method = incoming.method ?? 'GET';
      const init: RequestInit & { duplex?: 'half' } = { method, headers };
      if (method !== 'GET' && method !== 'HEAD') {
        init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        init.duplex = 'half';
      }
      const response = await handler(new Request(`http://${incoming.headers.host}${incoming.url}`, init));
      const out: Record<string, string | string[]> = {};
      for (const [name, value] of response.headers) if (name !== 'set-cookie') out[name] = value;
      const cookies = response.headers.getSetCookie();
      if (cookies.length) out['set-cookie'] = cookies;
      // An oversized upload may still be streaming: flush the response first, then close the connection.
      const abandonUpload = response.status === 413;
      if (abandonUpload) out.connection = 'close';
      outgoing.writeHead(response.status, out);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
      if (abandonUpload) outgoing.once('finish', () => { setImmediate(() => { incoming.destroy(); }); });
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'Internal server error' }));
    }
  };
}

function startDev(): void {
  const dataDir = fileURLToPath(new URL('../../../.data', import.meta.url));
  mkdirSync(dataDir, { recursive: true });
  const db = createDb({ url: process.env.TURSO_DATABASE_URL || `file:${resolve(dataDir, 'tendril.db')}`, authToken: process.env.TURSO_AUTH_TOKEN });
  // Local defaults; real variables from the shell win. Dev login stays off when VERCEL_ENV=production.
  const env = { TENDRIL_DEV_AUTH: '1', PUBLIC_ORIGIN: 'http://localhost:5173', ...process.env };
  const server = createServer(createListener(createApp({ db, env, verifySource: async (request) => verifySource(request) })));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('error', () => { console.error('Unable to start local server'); db.close(); process.exitCode = 1; });
  server.listen(PORT, '127.0.0.1', () => { console.info(`Tendril local API: http://127.0.0.1:${PORT}`); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close(() => { db.close(); });
      server.closeIdleConnections();
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startDev();

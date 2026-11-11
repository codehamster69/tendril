import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createApp, initializeDb } from './index.ts';

const hosts = new Set(['127.0.0.1:8787', 'localhost:8787', '[::1]:8787']);

// Importing this factory must not open a database or bind the development port.
export function createListener(app: ReturnType<typeof createApp>, allowedHosts: ReadonlySet<string> = hosts): RequestListener {
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
      const response = await app.handle(new Request(`http://127.0.0.1:8787${incoming.url}`, init));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'Internal server error' }));
    }
  };
}

async function startDev(): Promise<void> {
  const db = new PGlite(fileURLToPath(new URL('../../../.data', import.meta.url)));
  await initializeDb(db);
  const server = createServer(createListener(createApp({ db })));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('error', async () => { console.error('Unable to start local server'); await db.close(); process.exitCode = 1; });
  server.listen(8787, '127.0.0.1', () => { console.info('Tendril local development API: http://127.0.0.1:8787 (not production authentication)'); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close(() => { void db.close(); });
      server.closeIdleConnections();
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startDev();

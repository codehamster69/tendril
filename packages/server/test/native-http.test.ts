import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createApp, initializeDb } from '../src/index.ts';
import { createListener } from '../src/dev.ts';
import { MAX_BODY_BYTES } from '../src/validation.ts';

let db: PGlite;
let server: Server;
let port: number;

beforeAll(async () => {
  db = new PGlite();
  await initializeDb(db);
  server = createServer(createListener(createApp({ db })));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;
}, 30000);
afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
  if (db) await db.close();
});

function post(body: string, finish = false, declaredLength?: number) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown; requestEnded: boolean }>((resolve, reject) => {
    const client = request({
      hostname: '127.0.0.1', port, path: '/api/dev/login', method: 'POST', agent: false,
      headers: { Host: 'localhost:8787', Connection: 'keep-alive', 'Content-Type': 'application/json', ...(declaredLength === undefined ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': String(declaredLength) }) },
    }, (response) => {
      const parts: Buffer[] = [];
      response.on('data', (part: Buffer) => parts.push(part));
      response.on('error', reject);
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown, requestEnded: client.writableEnded });
        } catch (error) { reject(error); }
        finally { client.destroy(); }
      });
    });
    client.on('error', reject);
    client.setTimeout(5000, () => { client.destroy(new Error('Native HTTP response timed out')); });
    client.write(body);
    // Oversize probes deliberately never send the terminating chunk / req.end().
    if (finish) client.end();
  });
}

describe('native HTTP bounded uploads', () => {
  it('flushes JSON 413 for an open chunked body exceeding 2 MiB without resetting the socket', async () => {
    const response = await post(' '.repeat(MAX_BODY_BYTES + 1));
    expect(response.requestEnded).toBe(false);
    expect(response.status).toBe(413);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers.connection).toBe('close');
    expect(response.body).toEqual({ error: 'Request too large' });
  });
});

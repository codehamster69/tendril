import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createDb } from '../src/index.ts';
import type { Db } from '../src/index.ts';
import { createListener } from '../src/dev.ts';
import { MAX_BODY_BYTES } from '../src/validation.ts';

let db: Db;
let dir: string;
let server: Server;
let port: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tendril-http-'));
  db = createDb({ url: `file:${join(dir, 'http.db')}` });
  server = createServer(createListener(createApp({ db, env: { TENDRIL_DEV_AUTH: '1' } })));
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
  db?.close();
  if (dir) try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows keeps SQLite files locked briefly; temp dir cleanup is best effort */ }
});

function post(body: string, finish = false, declaredLength?: number, host = 'localhost:8787') {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown; requestEnded: boolean }>((resolve, reject) => {
    const client = request({
      hostname: '127.0.0.1', port, path: '/api/dev/login', method: 'POST', agent: false,
      headers: { Host: host, Connection: 'keep-alive', 'Content-Type': 'application/json', ...(declaredLength === undefined ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': String(declaredLength) }) },
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

describe('native HTTP adapter', () => {
  it('flushes JSON 413 for an open chunked body exceeding 2 MiB without resetting the socket', async () => {
    const response = await post(' '.repeat(MAX_BODY_BYTES + 1));
    expect(response.requestEnded).toBe(false);
    expect(response.status).toBe(413);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers.connection).toBe('close');
    expect(response.body).toEqual({ error: 'Request too large' });
  });
  it('answers a declared oversized body with JSON 413', async () => {
    const response = await post('{}', false, MAX_BODY_BYTES + 1);
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'Request too large' });
  });
  it('serves normal requests, with Set-Cookie headers, against a file database', async () => {
    const response = await post(JSON.stringify({ displayName: 'Native Farmer' }), true);
    expect(response.status).toBe(201);
    expect(String(response.headers['set-cookie'])).toContain('tendril_session=');
    expect((response.body as { profile: { displayName: string } }).profile.displayName).toBe('Native Farmer');
  });
  it('rejects hostile Host headers', async () => {
    const response = await post('{}', true, undefined, 'evil.example');
    expect(response.status).toBe(403);
  });
});

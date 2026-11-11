import type { PGlite } from '@electric-sql/pglite';
import { createLocalAuth, localLogin } from './auth.ts';
import type { Auth } from './auth.ts';
import { createFarm, getFarm, getReplay, leaderboard, reserveAttempt, verifyChunk } from './game.ts';
import type { Board } from './game.ts';
import { chunkInput, displayName, HttpError, objectWithKeys, readJson, rejectQuery, uuid } from './validation.ts';

const allowedOrigins = new Set(
  ['localhost', '127.0.0.1', '[::1]'].flatMap((host) => [5173, 4173, 8787].map((port) => `http://${host}:${port}`)),
);

export function createApp({ db, now = Date.now, auth, devLogin = auth === undefined }: {
  db: PGlite; now?: () => number; auth?: Auth; devLogin?: boolean;
}): { handle(request: Request): Promise<Response> } {
  const authenticate = auth ?? createLocalAuth(db);
  const clock = (): number => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid server clock');
    return value;
  };
  return {
    async handle(request) {
      const origin = request.headers.get('origin');
      const headers = new Headers({
        'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Vary': 'Origin',
      });
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers });
      try {
        if (origin !== null && !allowedOrigins.has(origin)) throw new HttpError(403, 'Origin not allowed');
        if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
        const url = new URL(request.url);
        if (request.method === 'OPTIONS') {
          if (!url.pathname.startsWith('/api/') || !['GET', 'POST'].includes(request.headers.get('access-control-request-method') ?? '')) throw new HttpError(400, 'Invalid preflight');
          const requested = request.headers.get('access-control-request-headers') ?? '';
          if (requested && requested.split(',').some((header) => !['authorization', 'content-type'].includes(header.trim().toLowerCase()))) throw new HttpError(400, 'Invalid preflight headers');
          headers.set('Access-Control-Allow-Methods', 'GET, POST');
          headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
          return new Response(null, { status: 204, headers });
        }
        if (url.pathname === '/api/dev/login' && request.method === 'POST') {
          if (!devLogin || auth !== undefined) throw new HttpError(404, 'Not found');
          rejectQuery(url);
          const body = objectWithKeys(await readJson(request), ['displayName']);
          return json(await localLogin(db, displayName(body.displayName), clock()), 201);
        }
        if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
          rejectQuery(url, ['board', 'limit']);
          const board = url.searchParams.get('board') ?? 'networth';
          const rawLimit = url.searchParams.get('limit') ?? '20';
          if (!['networth', 'growth'].includes(board) || !/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) throw new HttpError(400, 'Invalid leaderboard query');
          return json({ board, entries: await leaderboard(db, board as Board, Number(rawLimit), clock()) });
        }
        const replay = /^\/api\/farms\/([^/]+)\/replay$/.exec(url.pathname);
        if (replay && request.method === 'GET') {
          rejectQuery(url, ['fromTick', 'limit']);
          const rawFromTick = url.searchParams.get('fromTick') ?? '0';
          const rawLimit = url.searchParams.get('limit') ?? '1';
          if (!/^(0|[1-9]\d*)$/.test(rawFromTick) || !Number.isSafeInteger(Number(rawFromTick)) || !/^[12]$/.test(rawLimit)) throw new HttpError(400, 'Invalid replay query');
          return json(await getReplay(db, uuid(replay[1]!), Number(rawFromTick), Number(rawLimit)));
        }
        const chunk = /^\/api\/farms\/([^/]+)\/chunks$/.exec(url.pathname);
        const farmRoute = url.pathname === '/api/farms' && request.method === 'POST';
        const myFarmRoute = url.pathname === '/api/farms/me' && request.method === 'GET';
        if (farmRoute || myFarmRoute || (chunk && request.method === 'POST')) {
          const identity = await authenticate(request);
          if (!identity) throw new HttpError(401, 'Authentication required');
          if (chunk) await reserveAttempt(db, identity.userId, clock);
          rejectQuery(url);
          if (farmRoute) {
            objectWithKeys(await readJson(request), []);
            const result = await createFarm(db, identity.userId, clock);
            return json(result.farm, result.status);
          }
          if (myFarmRoute) return json(await getFarm(db, identity.userId));
          return json(await verifyChunk(db, identity.userId, uuid(chunk![1]!), chunkInput(await readJson(request)), clock));
        }
        throw new HttpError(404, 'Not found');
      } catch (error) {
        return error instanceof HttpError ? json({ error: error.message }, error.status) : json({ error: 'Internal server error' }, 500);
      }
    },
  };
}

import { DAILY_TICKS, RULES_VERSION } from '@tendril/sim/src/index.ts';
import { authenticate, clearSessionCookie, devAuthEnabled, devLogin, finishGithub, getProfile, logout, pollDesktop, sessionCookie, startGithub } from './auth.ts';
import type { Ctx, Env, FetchFn, Identity } from './auth.ts';
import type { Db } from './db.ts';
import { createFarm, dailyInfo, dailyLeaderboard, getFarm, getReplay, isValidDate, leaderboard, reserveAttempt, stats, submitDaily, utcDate, verifyChunk } from './game.ts';
import type { Board } from './game.ts';
import { migrate } from './migrations.ts';
import type { Migration } from './migrations.ts';
import { chunkInput, displayName, HttpError, objectWithKeys, readJson, rejectQuery, validateActions, uuid } from './validation.ts';

export interface AppOptions {
  db: Db;
  env: Env;
  /** Used for the GitHub OAuth calls; tests inject a stub so nothing touches the network. */
  fetch?: FetchFn;
  now?: () => number;
  /** Migration SQL bundled into the build (serverless); when absent the files are read from disk. */
  migrations?: Migration[];
}

const DESKTOP_ORIGIN = 'app://tendril';
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/;
const DESKTOP_DONE_PAGE = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Tendril</title>'
  + '<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}</style>'
  + '<h1>Signed in</h1><p>You can close this tab and return to Tendril.</p></html>';

function limitParam(url: URL): number {
  const raw = url.searchParams.get('limit') ?? '20';
  if (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > 100) throw new HttpError(400, 'Invalid limit');
  return Number(raw);
}

export function createApp(options: AppOptions): (request: Request) => Promise<Response> {
  const { db, env } = options;
  const clock = options.now ?? Date.now;
  const now = (): number => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid server clock');
    return value;
  };
  const ctx: Ctx = { db, env, fetch: options.fetch ?? ((input, init) => fetch(input, init)), now };
  let ready: Promise<unknown> | undefined;
  // Lazy migration, guarded by schema_version; a failure is retried by the next request.
  const ensureMigrated = (): Promise<unknown> => (ready ??= migrate(db, now, [], options.migrations).catch((error: unknown) => { ready = undefined; throw error; }));

  return async (request) => {
    const headers = new Headers({
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Vary': 'Origin',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    });
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers });
    const empty = (status: number): Response => new Response(null, { status, headers });
    try {
      const url = new URL(request.url);
      const origin = request.headers.get('origin');
      const desktop = origin === DESKTOP_ORIGIN;
      const publicOrigin = env.PUBLIC_ORIGIN?.replace(/\/+$/, '');
      const sameOrigin = origin === null || origin === url.origin || origin === publicOrigin || (devAuthEnabled(env) && LOOPBACK_ORIGIN.test(origin));
      if (!sameOrigin && !desktop) throw new HttpError(403, 'Origin not allowed');
      if (desktop) headers.set('Access-Control-Allow-Origin', DESKTOP_ORIGIN); // Bearer only, never credentials
      const allowCookie = !desktop;

      if (request.method === 'OPTIONS') {
        if (!url.pathname.startsWith('/api/') || !['GET', 'POST'].includes(request.headers.get('access-control-request-method') ?? '')) throw new HttpError(400, 'Invalid preflight');
        const requested = request.headers.get('access-control-request-headers') ?? '';
        if (requested && requested.split(',').some((h) => !['authorization', 'content-type', 'x-tendril-client'].includes(h.trim().toLowerCase()))) throw new HttpError(400, 'Invalid preflight headers');
        headers.set('Access-Control-Allow-Methods', 'GET, POST');
        headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Tendril-Client');
        return empty(204);
      }

      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
      const route = url.pathname.slice(4); // keep the leading "/"
      const method = request.method;
      await ensureMigrated();

      /** Requires a session; cookie-authenticated mutations also need the CSRF header. */
      const requireUser = async (): Promise<Identity> => {
        const identity = await authenticate(ctx, request, allowCookie);
        if (!identity) throw new HttpError(401, 'Authentication required');
        if (identity.via === 'cookie' && method !== 'GET' && method !== 'HEAD' && request.headers.get('x-tendril-client') !== '1') throw new HttpError(403, 'Missing X-Tendril-Client header');
        return identity;
      };

      // ---- auth ----
      if (route === '/auth/github' && method === 'GET') {
        rejectQuery(url, ['return', 'desktop']);
        const redirect = await startGithub(ctx, url);
        headers.set('Location', redirect.location);
        for (const cookie of redirect.setCookies) headers.append('Set-Cookie', cookie);
        return empty(302);
      }
      if (route === '/auth/github/callback' && method === 'GET') {
        // No strict query check here: GitHub owns these parameters and adds new ones over time (error_uri, iss, ...).
        // Only `code`, `state` and `error` are read; `state` is what protects this route.
        const result = await finishGithub(ctx, request, url);
        if (result.kind === 'desktop') {
          headers.set('Content-Type', 'text/html; charset=utf-8');
          headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
          for (const cookie of result.setCookies) headers.append('Set-Cookie', cookie);
          return new Response(DESKTOP_DONE_PAGE, { status: 200, headers });
        }
        headers.set('Location', result.redirect.location);
        for (const cookie of result.redirect.setCookies) headers.append('Set-Cookie', cookie);
        return empty(302);
      }
      if (route === '/auth/desktop/poll' && method === 'POST') {
        rejectQuery(url);
        const body = objectWithKeys(await readJson(request), ['nonce']);
        const result = await pollDesktop(ctx, body.nonce);
        if (result.status === 200) return json({ token: result.token, profile: result.profile });
        return json({ error: result.status === 202 ? 'Pending' : 'Not found' }, result.status);
      }
      if (route === '/auth/logout' && method === 'POST') {
        rejectQuery(url);
        const identity = await authenticate(ctx, request, allowCookie);
        if (identity?.via === 'cookie' && request.headers.get('x-tendril-client') !== '1') throw new HttpError(403, 'Missing X-Tendril-Client header');
        await logout(ctx, request, identity);
        headers.append('Set-Cookie', clearSessionCookie());
        return empty(204);
      }
      if (route === '/me' && method === 'GET') {
        rejectQuery(url);
        const identity = await requireUser();
        const profile = await getProfile(db, identity.userId);
        if (!profile) throw new HttpError(401, 'Authentication required');
        return json({ profile });
      }
      if (route === '/dev/login' && method === 'POST') {
        if (!devAuthEnabled(env)) throw new HttpError(404, 'Not found');
        rejectQuery(url);
        const body = objectWithKeys(await readJson(request), ['displayName']);
        const login = await devLogin(ctx, displayName(body.displayName));
        headers.append('Set-Cookie', sessionCookie(login.token));
        return json(login, 201);
      }

      // ---- farms ----
      if (route === '/farms' && method === 'POST') {
        const identity = await requireUser();
        rejectQuery(url);
        objectWithKeys(await readJson(request), []);
        const result = await createFarm(db, identity.userId, now);
        return json(result.farm, result.status);
      }
      if (route === '/farms/me' && method === 'GET') {
        const identity = await requireUser();
        rejectQuery(url);
        return json(await getFarm(db, identity.userId));
      }
      const chunk = /^\/farms\/([^/]+)\/chunks$/.exec(route);
      if (chunk && method === 'POST') {
        const identity = await requireUser();
        await reserveAttempt(db, identity.userId, 'chunk', now());
        rejectQuery(url);
        const input = chunkInput(await readJson(request));
        return json(await verifyChunk(db, identity.userId, uuid(chunk[1]!), input, now));
      }
      const replay = /^\/farms\/([^/]+)\/replay$/.exec(route);
      if (replay && method === 'GET') {
        rejectQuery(url, ['fromTick', 'limit']);
        const rawFromTick = url.searchParams.get('fromTick') ?? '0';
        const rawLimit = url.searchParams.get('limit') ?? '1';
        if (!/^(0|[1-9]\d*)$/.test(rawFromTick) || !Number.isSafeInteger(Number(rawFromTick)) || !/^[12]$/.test(rawLimit)) throw new HttpError(400, 'Invalid replay query');
        return json(await getReplay(db, uuid(replay[1]!), Number(rawFromTick), Number(rawLimit)));
      }

      // ---- public boards ----
      if (route === '/leaderboard' && method === 'GET') {
        rejectQuery(url, ['board', 'limit']);
        const board = url.searchParams.get('board') ?? 'networth';
        if (board !== 'networth' && board !== 'growth') throw new HttpError(400, 'Invalid board');
        return json({ board, entries: await leaderboard(db, board as Board, limitParam(url), now()) });
      }
      if (route === '/stats' && method === 'GET') {
        rejectQuery(url);
        return json(await stats(db));
      }

      // ---- daily challenge ----
      if (route === '/daily' && method === 'GET') {
        rejectQuery(url);
        return json(dailyInfo(now()));
      }
      if (route === '/daily/leaderboard' && method === 'GET') {
        rejectQuery(url, ['date', 'limit']);
        const date = url.searchParams.get('date') ?? utcDate(now());
        if (!isValidDate(date)) throw new HttpError(400, 'Invalid date');
        return json({ date, entries: await dailyLeaderboard(db, date, limitParam(url)) });
      }
      if (route === '/daily/submit' && method === 'POST') {
        const identity = await requireUser();
        await reserveAttempt(db, identity.userId, 'daily', now());
        rejectQuery(url);
        const body = objectWithKeys(await readJson(request), ['date', 'rulesVersion', 'actions'], 422);
        if (!isValidDate(body.date)) throw new HttpError(422, 'Invalid date');
        if (body.rulesVersion !== RULES_VERSION) throw new HttpError(409, 'Rules version mismatch');
        const actions = validateActions(body.actions, 0, DAILY_TICKS);
        return json(await submitDaily(db, identity.userId, body.date, actions, now()));
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('Unhandled server error:', error instanceof Error ? error.name : typeof error); // never log request data
      return json({ error: 'Internal server error' }, 500);
    }
  };
}

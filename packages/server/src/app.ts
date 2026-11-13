import { DAILY_TICKS } from '@tendril/sim/src/index.ts';
import { authenticate, clearSessionCookie, devAuthEnabled, devLogin, finishGithub, getProfile, logout, pollDesktop, sessionCookie, startGithub } from './auth.ts';
import type { Ctx, Env, FetchFn, Identity } from './auth.ts';
import type { Db } from './db.ts';
import { acceptDuel, duelCounts, duelPage } from './duels.ts';
import { board, challengeInfo, createDuel, entryReplay, entrySource, entrySummary, hallOfFame, publishedSources, KIND_LIMITS, legacyLeaderboard, legacySubmit, noteLegacySubmit, refreshLegacyGrace, loadChallenge, MAX_SOURCE_BYTES, moveLegacyDaily, stats, submitEntry } from './arena.ts';
import type { AuthorKind, Medal } from './arena.ts';
import { createFarm, dailyInfo, getFarm, getReplay, isValidDate, leaderboard, reserveAttempt, utcDate, verifyChunk } from './game.ts';
import type { Board } from './game.ts';
import { badgeFor, follow, listFollowing, playerPage, unfollow } from './players.ts';
import { handleShare } from './share.ts';
import { createGuard, dropReplaysOutsideTop, pruneOncePerDay, rateScale, refreshGuard, prune, syncScale, withCacheHeaders } from './housekeeping.ts';
import type { SourceVerifier } from './verify-client.ts';
import { reportProgram } from './moderation.ts';
import { migrate } from './migrations.ts';
import type { Migration } from './migrations.ts';
import { chunkInput, displayName, duelInput, entryIdParam, entryInput, HttpError, objectWithKeys, readJson, rejectQuery, validateActions, uuid } from './validation.ts';

export interface AppOptions {
  db: Db;
  env: Env;
  /** Used for the GitHub OAuth calls; tests inject a stub so nothing touches the network. */
  fetch?: FetchFn;
  now?: () => number;
  /** Migration SQL bundled into the build (serverless); when absent the files are read from disk. */
  migrations?: Migration[];
  /** Chunk attempts per user per rolling hour. Defaults to CHUNK_ATTEMPTS_PER_HOUR; tests pass a small number. */
  chunkAttemptsPerHour?: number;
  /** Source check (C3). Absent: submissions that carry a program answer 503. Production wires the remote verify function. */
  verifySource?: SourceVerifier;
  /** Setup version for challenges created from now on (default: current). Tests pin 0 to keep plain-farm fixtures. */
  setupVersion?: number;
}

const DESKTOP_ORIGIN = 'app://tendril';
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/;
const DESKTOP_DONE_PAGE = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Tendril</title>'
  + '<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}</style>'
  + '<h1>Signed in</h1><p>You can close this tab and return to Tendril.</p></html>';

function publicOriginOf(env: Env, url: URL): string {
  const configured = env.PUBLIC_ORIGIN?.replace(/\/+$/, '');
  return configured && /^https?:\/\/[^/\s]+$/.test(configured) ? configured : url.origin;
}

function limitParam(url: URL): number {
  const raw = url.searchParams.get('limit') ?? '20';
  if (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > 100) throw new HttpError(400, 'Invalid limit');
  return Number(raw);
}

export function createApp(options: AppOptions): (request: Request) => Promise<Response> {
  return withCache(createInnerApp(options));
}

function withCache(inner: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => withCacheHeaders(request, await inner(request));
}

function createInnerApp(options: AppOptions): (request: Request) => Promise<Response> {
  const { db, env } = options;
  const clock = options.now ?? Date.now;
  const now = (): number => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid server clock');
    return value;
  };
  const ctx: Ctx = { db, env, fetch: options.fetch ?? ((input, init) => fetch(input, init)), now };
  const guard = createGuard(db, env, now);
  let prunedDay = ''; // this instance has already checked today's prune claim
  let ready: Promise<unknown> | undefined;
  // Lazy migration, guarded by schema_version; a failure is retried by the next request.
  const ensureMigrated = (): Promise<unknown> => (ready ??= migrate(db, now, [], options.migrations).then(() => moveLegacyDaily(db)).catch((error: unknown) => { ready = undefined; throw error; }));

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
      // ---- B4 share links and preview cards (public GET pages; no cookies, no CORS) ----
      if (/^(\/api)?\/(r\/[^/]+|og\/[^/]+\.png)$/.test(url.pathname)) {
        await ensureMigrated();
        const shareOrigin = publicOriginOf(env, url);
        const res = await handleShare(url.pathname, request.method, { db, now: now(), origin: shareOrigin, host: new URL(shareOrigin).host, search: url.search, count: (await guard.mode()) === 'normal' });
        if (res) return res;
      }
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
      // Housekeeping: the first request of each UTC day prunes (the cron does the same; whichever comes first wins).
      const today = new Date(now()).toISOString().slice(0, 10);
      if (prunedDay !== today) {
        prunedDay = today;
        await pruneOncePerDay(db, now()).catch(() => { console.error('Housekeeping prune failed'); });
        await refreshLegacyGrace(db, now()).catch(() => { console.error('Legacy grace check failed'); });
      }

      if (route === '/cron/housekeeping' && method === 'GET') {
        // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without the secret set the route is closed and the lazy path still prunes.
        const secret = env.CRON_SECRET;
        if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) throw new HttpError(401, 'Unauthorized');
        rejectQuery(url);
        const report = await prune(db, now());
        return json({ report, guard: await refreshGuard(db, env, now()), legacyGrace: await refreshLegacyGrace(db, now()) });
      }
      // Budget guard: read-only mode refuses writes except sign-in/out, so the game keeps serving without growing.
      const mode = method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? 'normal' : await guard.mode();
      const scale = rateScale(mode);
      if (mode === 'readonly' && !route.startsWith('/auth/') && route !== '/dev/login') {
        headers.set('Retry-After', '1800');
        throw new HttpError(503, 'Tendril is read-only for a while to stay inside its free limits. Your result is safe on your device; try again later.');
      }

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
        rejectQuery(url);
        const input = chunkInput(await readJson(request));
        // The attempt limit lives in the farm row (one write per sync, not two).
        return json(await verifyChunk(db, identity.userId, uuid(chunk[1]!), input, now, { chunkAttemptsPerHour: options.chunkAttemptsPerHour, rateScale: scale, syncScale: syncScale(mode) }));
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
      if (route === '/stats/duels' && method === 'GET') {
        rejectQuery(url);
        return json(await duelCounts(db));
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
        return json({ date, entries: await legacyLeaderboard(db, date, limitParam(url)) });
      }
      if (route === '/daily/submit' && method === 'POST') {
        const identity = await requireUser();
        await noteLegacySubmit(db, now()).catch(() => {}); // telemetry for the LEGACY_GRACE sunset
        await reserveAttempt(db, identity.userId, 'daily', now(), undefined, scale);
        rejectQuery(url);
        const body = objectWithKeys(await readJson(request), ['date', 'rulesVersion', 'actions'], 422);
        if (!isValidDate(body.date)) throw new HttpError(422, 'Invalid date');
        if (!Number.isInteger(body.rulesVersion)) throw new HttpError(409, 'Rules version mismatch');
        const actions = validateActions(body.actions, 0, DAILY_TICKS);
        return json(await legacySubmit(db, identity.userId, body.date, actions, now(), options.setupVersion, body.rulesVersion as number));
      }

      // ---- arena: challenges, entries, duels ----
      const viewerId = async (): Promise<string | undefined> => (await authenticate(ctx, request, allowCookie))?.userId;
      const challengeRoute = /^\/challenges\/([^/]+)(?:\/(entries|board|sources))?$/.exec(route);
      if (challengeRoute) {
        const [, ref, sub] = challengeRoute;
        if (!sub && method === 'GET') {
          rejectQuery(url);
          return json(await challengeInfo(db, await loadChallenge(db, ref!, now(), options.verifySource, options.setupVersion)));
        }
        if (sub === 'entries' && method === 'POST') {
          const identity = await requireUser();
          await reserveAttempt(db, identity.userId, 'entry', now(), undefined, scale);
          rejectQuery(url);
          const challenge = await loadChallenge(db, ref!, now(), options.verifySource, options.setupVersion);
          const input = entryInput(await readJson(request), MAX_SOURCE_BYTES);
          const limits = KIND_LIMITS[challenge.kind];
          const actions = validateActions(input.actions, 0, challenge.ticks, limits.maxActions);
          const result = await submitEntry(db, identity.userId, challenge, input, actions, now(), { verify: options.verifySource });
          if (mode !== 'normal' && result.improved) await dropReplaysOutsideTop(db, challenge.id, result.entryId); // lean and tighter: only top entries keep a log
          return json(result);
        }
        if (sub === 'sources' && method === 'GET') {
          rejectQuery(url, ['limit']);
          return json(await publishedSources(db, await loadChallenge(db, ref!, now(), options.verifySource, options.setupVersion), limitParam(url), now()));
        }
        if (sub === 'board' && method === 'GET') {
          rejectQuery(url, ['medal', 'scope', 'author', 'limit']);
          const medal = url.searchParams.get('medal') ?? 'wealth';
          const scope = url.searchParams.get('scope') ?? 'global';
          const author = url.searchParams.get('author');
          if (medal !== 'wealth' && medal !== 'speed' && medal !== 'brevity') throw new HttpError(400, 'Invalid medal');
          if (scope !== 'global' && scope !== 'friends') throw new HttpError(400, 'Invalid scope');
          if (author !== null && author !== 'human' && author !== 'model') throw new HttpError(400, 'Invalid author');
          const viewer = await viewerId();
          if (scope === 'friends' && !viewer) throw new HttpError(401, 'Authentication required');
          const challenge = await loadChallenge(db, ref!, now(), options.verifySource, options.setupVersion);
          return json(await board(db, challenge, { medal: medal as Medal, friends: scope === 'friends', author: (author ?? undefined) as AuthorKind | undefined, limit: limitParam(url), viewerId: viewer, now: now() }));
        }
      }
      if (route === '/seasons' && method === 'GET') {
        rejectQuery(url, ['limit']);
        return json(await hallOfFame(db, now(), limitParam(url)));
      }
      const reportRoute = /^\/entries\/([^/]+)\/report$/.exec(route);
      if (reportRoute && method === 'POST') {
        const identity = await requireUser();
        await reserveAttempt(db, identity.userId, 'report', now(), undefined, scale);
        rejectQuery(url);
        objectWithKeys(await readJson(request), []);
        return json(await reportProgram(db, identity.userId, entryIdParam(reportRoute[1]!), now()));
      }
      const entryRoute = /^\/entries\/([^/]+)(?:\/(replay|source))?$/.exec(route);
      if (entryRoute && method === 'GET') {
        rejectQuery(url);
        const id = entryIdParam(entryRoute[1]!);
        const part = entryRoute[2];
        return json(part === 'replay' ? await entryReplay(db, id, await viewerId(), now()) : part === 'source' ? await entrySource(db, id, await viewerId(), now()) : await entrySummary(db, id, await viewerId(), now()));
      }
      if (route === '/duels' && method === 'POST') {
        const identity = await requireUser();
        await reserveAttempt(db, identity.userId, 'duel', now(), undefined, scale);
        rejectQuery(url);
        const input = duelInput(await readJson(request), KIND_LIMITS.duel.maxTicks);
        return json(await createDuel(db, identity.userId, input, now(), options.verifySource, options.setupVersion), 201);
      }
      const duelRoute = /^\/duels\/(x-[A-Za-z0-9_-]{8})(?:\/(accept))?$/.exec(route);
      if (duelRoute) {
        const [, ref, action] = duelRoute;
        if (!action && method === 'GET') {
          rejectQuery(url);
          return json(await duelPage(db, await loadChallenge(db, ref!, now(), options.verifySource, options.setupVersion), await viewerId()));
        }
        if (action && method === 'POST') {
          const identity = await requireUser();
          rejectQuery(url);
          objectWithKeys(await readJson(request), []);
          return json(await acceptDuel(db, await loadChallenge(db, ref!, now(), options.verifySource, options.setupVersion), identity.userId, now()));
        }
      }
      // ---- players: profile, follows, README badge (B5) ----
      const playerRoute = /^\/players\/([^/]+?)(?:\/(follow|unfollow))?$/.exec(route);
      if (playerRoute) {
        const [, login, action] = playerRoute;
        if (!action && method === 'GET') {
          rejectQuery(url);
          return json(await playerPage(db, login!, await viewerId(), now(), utcDate(now())));
        }
        if (action && method === 'POST') {
          const identity = await requireUser();
          await reserveAttempt(db, identity.userId, 'follow', now(), undefined, scale);
          rejectQuery(url);
          objectWithKeys(await readJson(request), []);
          return json(action === 'follow' ? await follow(db, identity.userId, login!, now()) : await unfollow(db, identity.userId, login!));
        }
      }
      if (route === '/me/following' && method === 'GET') {
        rejectQuery(url);
        return json(await listFollowing(db, (await requireUser()).userId));
      }
      const badgeRoute = /^\/badge\/([^/]+)\.svg$/.exec(route);
      if (badgeRoute && method === 'GET') {
        rejectQuery(url);
        const svg = await badgeFor(db, badgeRoute[1]!, utcDate(now()));
        headers.set('Content-Type', 'image/svg+xml; charset=utf-8');
        headers.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
        headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
        return new Response(svg, { status: 200, headers });
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('Unhandled server error:', error instanceof Error ? error.name : typeof error); // never log request data
      return json({ error: 'Internal server error' }, 500);
    }
  };
}

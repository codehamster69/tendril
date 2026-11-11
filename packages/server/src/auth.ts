import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { HttpError } from './validation.ts';

export type Env = Record<string, string | undefined>;
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export interface Ctx { db: Db; env: Env; fetch: FetchFn; now: () => number }
export interface Profile { id: string; login: string; displayName: string; avatarUrl: string | null }
export interface Identity { userId: string; via: 'cookie' | 'bearer' }

export const SESSION_COOKIE = 'tendril_session';
export const STATE_COOKIE = 'tendril_oauth_state';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const STATE_TTL_MS = 10 * 60 * 1000;
export const DESKTOP_TTL_MS = 10 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const CALLBACK_PATH = '/api/auth/github/callback';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const newToken = (): string => randomBytes(32).toString('base64url');

export function devAuthEnabled(env: Env): boolean {
  return env.TENDRIL_DEV_AUTH === '1' && env.VERCEL_ENV !== 'production';
}

export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      const name = part.slice(0, index).trim();
      if (!cookies.has(name)) cookies.set(name, part.slice(index + 1).trim());
    }
  }
  return cookies;
}

function cookie(name: string, value: string, maxAgeSeconds: number, path: string): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
}
export const sessionCookie = (token: string): string => cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1000, '/');
export const clearSessionCookie = (): string => cookie(SESSION_COOKIE, '', 0, '/');
const stateCookie = (state: string): string => cookie(STATE_COOKIE, state, STATE_TTL_MS / 1000, '/api/auth');
const clearStateCookie = (): string => cookie(STATE_COOKIE, '', 0, '/api/auth');

const hasUnsafeChar = (value: string): boolean => [...value].some((ch) => ch === '\\' || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

/** Only same-origin relative paths: must start with a single "/", no backslashes, no control characters. */
export function safeReturnPath(value: string | null): string {
  if (value === null || value === '') return '/play/';
  if (value.length > 512 || !value.startsWith('/') || value.startsWith('//') || hasUnsafeChar(value)) throw new HttpError(400, 'Invalid return path');
  const probe = new URL(value, 'https://same-origin.invalid');
  if (probe.origin !== 'https://same-origin.invalid') throw new HttpError(400, 'Invalid return path');
  return value;
}

export async function createSession(ctx: Ctx, userId: string): Promise<string> {
  const token = newToken();
  const now = ctx.now();
  await ctx.db.execute('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [sha256(token), userId, now, now + SESSION_TTL_MS]);
  return token;
}

/** Bearer wins over the cookie. A malformed or unknown Bearer token never falls back to the cookie. */
export async function authenticate(ctx: Ctx, request: Request, allowCookie: boolean): Promise<Identity | null> {
  const authorization = request.headers.get('authorization');
  let token: string | undefined;
  let via: Identity['via'] = 'bearer';
  if (authorization !== null) {
    token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
  } else if (allowCookie) {
    token = parseCookies(request.headers.get('cookie')).get(SESSION_COOKIE);
    via = 'cookie';
  }
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const rows = await ctx.db.query<{ user_id: string }>('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?', [sha256(token), ctx.now()]);
  return rows[0] ? { userId: rows[0].user_id, via } : null;
}

export async function getProfile(db: Db, userId: string): Promise<Profile | null> {
  const rows = await db.query<{ id: string; login: string; display_name: string; avatar_url: string | null }>('SELECT id, login, display_name, avatar_url FROM users WHERE id = ?', [userId]);
  const row = rows[0];
  return row ? { id: row.id, login: row.login, displayName: row.display_name, avatarUrl: row.avatar_url } : null;
}

export async function logout(ctx: Ctx, request: Request, identity: Identity | null): Promise<void> {
  if (!identity) return;
  const token = identity.via === 'bearer'
    ? /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
    : parseCookies(request.headers.get('cookie')).get(SESSION_COOKIE);
  if (token) await ctx.db.execute('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

export async function devLogin(ctx: Ctx, displayName: string): Promise<{ token: string; profile: Profile }> {
  const id = randomUUID();
  await ctx.db.execute('INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at) VALUES (?, NULL, ?, ?, NULL, ?)', [id, `dev-${id.slice(0, 8)}`, displayName, ctx.now()]);
  const token = await createSession(ctx, id);
  return { token, profile: (await getProfile(ctx.db, id))! };
}

export interface Redirect { location: string; setCookies: string[] }

function requireOAuthConfig(env: Env): { clientId: string; clientSecret: string; origin: string } {
  const clientId = env.GITHUB_CLIENT_ID, clientSecret = env.GITHUB_CLIENT_SECRET, origin = env.PUBLIC_ORIGIN;
  if (!clientId || !clientSecret || !origin) throw new HttpError(503, 'Sign-in is not configured');
  return { clientId, clientSecret, origin: origin.replace(/\/+$/, '') };
}

export async function startGithub(ctx: Ctx, url: URL): Promise<Redirect> {
  const config = requireOAuthConfig(ctx.env);
  const returnPath = safeReturnPath(url.searchParams.get('return'));
  const nonce = url.searchParams.get('desktop');
  if (nonce !== null && !NONCE_PATTERN.test(nonce)) throw new HttpError(400, 'Invalid desktop nonce');
  const state = newToken();
  const now = ctx.now();
  await ctx.db.execute('DELETE FROM oauth_states WHERE expires_at <= ?', [now]);
  await ctx.db.execute('DELETE FROM desktop_logins WHERE expires_at <= ?', [now]);
  const nonceHash = nonce === null ? null : sha256(`tendril-desktop-id:${nonce}`);
  await ctx.db.transaction(async (tx) => {
    if (nonceHash !== null) {
      try {
        await tx.execute("INSERT INTO desktop_logins (nonce_hash, status, created_at, expires_at) VALUES (?, 'pending', ?, ?)", [nonceHash, now, now + DESKTOP_TTL_MS]);
      } catch { throw new HttpError(400, 'Desktop nonce already used'); }
    }
    await tx.execute('INSERT INTO oauth_states (state_hash, desktop_nonce_hash, return_path, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [sha256(state), nonceHash, returnPath, now, now + STATE_TTL_MS]);
  });
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', config.clientId);
  authorize.searchParams.set('redirect_uri', `${config.origin}${CALLBACK_PATH}`);
  authorize.searchParams.set('state', state);
  return { location: authorize.toString(), setCookies: [stateCookie(state)] };
}

interface GithubUser { id: number; login: string; name: string | null; avatar_url: string | null }

async function fetchGithubUser(ctx: Ctx, config: { clientId: string; clientSecret: string; origin: string }, code: string): Promise<GithubUser> {
  const fail = (): never => { throw new HttpError(502, 'GitHub sign-in failed'); };
  let accessToken: unknown;
  let user: unknown;
  try {
    const exchange = await ctx.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'tendril-server' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: `${config.origin}${CALLBACK_PATH}` }),
      signal: AbortSignal.timeout(8000),
    });
    if (!exchange.ok) fail();
    accessToken = ((await exchange.json()) as { access_token?: unknown }).access_token;
    if (typeof accessToken !== 'string' || !accessToken) fail();
    const profile = await ctx.fetch('https://api.github.com/user', {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${accessToken as string}`, 'User-Agent': 'tendril-server' },
      signal: AbortSignal.timeout(8000),
    });
    if (!profile.ok) fail();
    user = await profile.json();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return fail();
  }
  const u = user as Partial<GithubUser> | null;
  if (!u || !Number.isSafeInteger(u.id) || (u.id as number) <= 0 || typeof u.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(u.login)) return fail();
  return { id: u.id as number, login: u.login, name: typeof u.name === 'string' ? u.name : null, avatar_url: typeof u.avatar_url === 'string' && u.avatar_url.startsWith('https://') && u.avatar_url.length <= 512 ? u.avatar_url : null };
}

function githubDisplayName(user: GithubUser): string {
  const cleaned = [...(user.name ?? '').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').trim()].slice(0, 32).join('').trim();
  return [...cleaned].length >= 2 ? cleaned : user.login;
}

export type CallbackResult =
  | { kind: 'web'; redirect: Redirect }
  | { kind: 'desktop'; setCookies: string[] };

export async function finishGithub(ctx: Ctx, request: Request, url: URL): Promise<CallbackResult> {
  const config = requireOAuthConfig(ctx.env);
  const fresh = [clearStateCookie()];
  const invalid = (): never => { throw new HttpError(400, 'Invalid or expired sign-in state'); };
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const cookieState = parseCookies(request.headers.get('cookie')).get(STATE_COOKIE);
  if (!state || !cookieState || !TOKEN_PATTERN.test(state) || !TOKEN_PATTERN.test(cookieState)) return invalid();
  const a = Buffer.from(state), b = Buffer.from(cookieState);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return invalid();
  // Single use: whoever deletes the row owns the attempt.
  const rows = await ctx.db.query<{ desktop_nonce_hash: string | null; return_path: string; expires_at: number }>('DELETE FROM oauth_states WHERE state_hash = ? RETURNING desktop_nonce_hash, return_path, expires_at', [sha256(state)]);
  const row = rows[0];
  if (!row || row.expires_at <= ctx.now()) return invalid();
  if (url.searchParams.get('error') || !code || code.length > 512) throw new HttpError(400, 'Sign-in was cancelled');
  const github = await fetchGithubUser(ctx, config, code);
  const users = await ctx.db.query<{ id: string }>(
    `INSERT INTO users (id, github_id, login, display_name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url RETURNING id`,
    [randomUUID(), github.id, github.login, githubDisplayName(github), github.avatar_url, ctx.now()],
  );
  const userId = users[0]!.id;
  if (row.desktop_nonce_hash !== null) {
    const marked = await ctx.db.execute("UPDATE desktop_logins SET status = 'ready', user_id = ? WHERE nonce_hash = ? AND status = 'pending' AND expires_at > ?", [userId, row.desktop_nonce_hash, ctx.now()]);
    if (marked.rowsAffected === 0) return invalid();
    return { kind: 'desktop', setCookies: fresh };
  }
  const token = await createSession(ctx, userId);
  return { kind: 'web', redirect: { location: safeReturnPath(row.return_path), setCookies: [sessionCookie(token), ...fresh] } };
}

/** Desktop poll: 200 once (single use), 202 while the browser sign-in is pending, 404 otherwise. */
export async function pollDesktop(ctx: Ctx, nonce: unknown): Promise<{ status: 200; token: string; profile: Profile } | { status: 202 } | { status: 404 }> {
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) throw new HttpError(400, 'Invalid desktop nonce');
  const hash = sha256(`tendril-desktop-id:${nonce}`);
  const now = ctx.now();
  const ready = await ctx.db.query<{ user_id: string }>("DELETE FROM desktop_logins WHERE nonce_hash = ? AND status = 'ready' AND expires_at > ? RETURNING user_id", [hash, now]);
  if (ready[0]) {
    const token = await createSession(ctx, ready[0].user_id);
    return { status: 200, token, profile: (await getProfile(ctx.db, ready[0].user_id))! };
  }
  const pending = await ctx.db.query("SELECT 1 AS x FROM desktop_logins WHERE nonce_hash = ? AND status = 'pending' AND expires_at > ?", [hash, now]);
  return pending.length ? { status: 202 } : { status: 404 };
}

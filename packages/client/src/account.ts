import { ApiError, FarmApi, isDesktop, setSignedInHint, signedInHint, signIn, readToken, writeToken } from './api-client';
import type { FarmResponse, Profile } from './api-client';
import type { RealSim } from './real-sim';
import { el, toast } from './palette';
import { syncOnce } from './autosync';
import { kvGetMany } from './store';
import { MS_PER_TICK, targetTick } from './clock';
import type { LogChunk } from './chunks';

/** Connects the Endless farm, if requested. Falls back to local play with a toast. */
/** Starts the same sign-in flow as the account dialog's GitHub button. Set by mountAccount. */
let signInStarter: () => void = () => {};
export const startSignIn = (): void => signInStarter();

/** `implicit`: opened because the player is signed in, not because they asked; a stale sign-in then falls back quietly. */
/** Farm rests: more than this behind the clock and the server pauses the farm's clock at the cap (server REST_CAP_MS). */
const REST_CAP_MS = 6 * 3_600_000;

/** If the farm is further behind than the cap, ask the server to rest the excess; says so in a toast. Offline or failing: carry on unrested. */
async function wakeIfBehind(api: FarmApi, farm: FarmResponse): Promise<FarmResponse> {
  const meta = { seed: farm.seed, startedAtMs: farm.startedAtMs, restedMs: farm.restedMs ?? 0, mode: 'live' as const };
  // Ticks this device already simulated but has not synced (a farm played offline) are never rested away.
  let local = farm.tick;
  try {
    const key = `ranked.${farm.id}.pendingLog`;
    const log = (await kvGetMany<Record<string, unknown>>([key]))[key] as LogChunk[] | undefined;
    const last = log?.[log.length - 1];
    if (last && Number.isSafeInteger(last.toTick)) local = Math.max(local, last.toTick);
  } catch { /* no local save */ }
  if ((targetTick(meta, Date.now()) - local) * MS_PER_TICK <= REST_CAP_MS) return farm;
  try {
    const woken = await api.wake(local);
    if (woken.restedNowMs > 0) {
      const hours = Math.round(woken.restedNowMs / 3_600_000);
      // Boot takes longer than a toast lives: say it once the splash has gone (and the farm has drawn).
      const say = (): void => { if (document.getElementById('splash')) setTimeout(say, 250); else toast('Your farm rested', `It rested for ${hours} ${hours === 1 ? 'hour' : 'hours'} while you were away. It ran for the first 6 hours.`); };
      window.addEventListener('tendril:snapshot', say, { once: true });
    }
    return woken;
  } catch { return farm; }
}

export async function connectRanked(api: FarmApi, implicit = false): Promise<FarmResponse | undefined> {
  try { return await wakeIfBehind(api, await api.farm()); } catch (e) {
    if (e instanceof ApiError && e.status === 404) return api.createFarm();
    if (implicit && e instanceof ApiError && e.status === 401) { setSignedInHint(false); return undefined; }
    toast('Could not connect Endless farm', e instanceof Error ? e.message : 'Sign in first.');
    return undefined;
  }
}

/** Who is signed in, as far as this page knows. `fresh` marks a sign-in completed in this page session. */
export interface AccountEvent { profile: Profile | null; fresh: boolean }
const announce = (detail: AccountEvent): void => { window.dispatchEvent(new CustomEvent<AccountEvent>('tendril:account', { detail })); };

/** The account button and its dialog. Local play never needs an account. */
export function mountAccount(api: FarmApi, sim: RealSim): void {
  const account = document.getElementById('btn-account') as HTMLButtonElement;
  let attempt: AbortController | null = null;
  const beginSignIn = (): void => {
    if (attempt) return;
    const mine = attempt = new AbortController();
    if (!isDesktop) { void signIn(mine.signal); return; }
    account.disabled = true;
    account.textContent = 'Waiting for browser…';
    const dialog = el('dialog', { class: 'campaign-map', 'aria-label': 'Waiting for browser sign-in' });
    const hide = el('button', { text: 'Hide' });
    hide.addEventListener('click', () => { dialog.close(); dialog.remove(); });
    const cancel = el('button', { text: 'Cancel', class: 'primary' });
    cancel.addEventListener('click', () => { mine.abort(); dialog.close(); dialog.remove(); });
    dialog.append(el('header', {}, el('h2', { text: 'Waiting for browser…' }), hide),
      el('p', { text: 'Finish signing in with GitHub in the browser window that just opened. This waits up to 5 minutes.' }), cancel);
    document.body.append(dialog);
    dialog.showModal();
    let signedIn = false;
    void signIn(mine.signal).then((profile) => {
      if (!profile) return;
      signedIn = true;
      account.textContent = profile.login;
      announce({ profile, fresh: true });
      toast('Signed in', `Welcome, ${profile.login}.`);
      // Signed-in live play is ranked by default, unless the player chose their local farm.
      if (sim.mode === 'live' && !sim.ranked && new URLSearchParams(location.search).get('ranked') !== '0') location.href = '?mode=live';
    }).catch(() => { toast("Sign-in didn't complete.", 'Try again.'); }).finally(() => {
      attempt = null; account.disabled = false; dialog.close(); dialog.remove();
      if (!signedIn) account.textContent = 'Sign in';
    });
  };
  signInStarter = beginSignIn;
  account.addEventListener('click', async () => {
    const dialog = el('dialog', { class: 'campaign-map', 'aria-label': 'Account and Endless farm' });
    const close = el('button', { text: 'Close' });
    close.addEventListener('click', () => { dialog.close(); dialog.remove(); });
    dialog.append(el('header', {}, el('h2', { text: 'A fair field for everyone' }), close));
    try {
      const { profile } = await api.me();
      dialog.append(el('p', { text: `Signed in as ${profile.displayName}` }));
      if (sim.ranked) {
        dialog.append(el('p', { text: 'Your Endless farm syncs to the leaderboard every few seconds while the game is open.' }));
        const sync = el('button', { text: 'Sync now', class: 'primary' });
        sync.addEventListener('click', async () => {
          sync.disabled = true;
          try {
            const result = await syncOnce(api, sim);
            if (result) toast('Farm verified', `Tick ${result.tick}, ${result.rank === null ? 'outside the top 500' : `rank ${result.rank}`}.`);
            else toast('Already synced', 'No new ticks need verifying.');
          } catch (e) { toast('Sync stopped', e instanceof Error ? e.message : 'Your local logs are kept.'); } finally { sync.disabled = false; }
        });
        dialog.append(sync, el('a', { href: '?mode=live&ranked=0', class: 'next-lesson', text: 'Open your local farm instead' }));
      } else dialog.append(el('a', { href: '?mode=live&ranked=1', class: 'next-lesson', text: 'Open your server-verified farm' }));
      const logout = el('button', { text: 'Sign out', class: 'quiet' });
      logout.addEventListener('click', async () => { await api.logout(); writeToken(null); setSignedInHint(false); location.href = '?mode=live'; });
      dialog.append(logout);
    } catch {
      dialog.append(el('p', { text: 'Local play never needs an account. Sign in with GitHub to verify your farm and submit daily scores.' }));
      const login = el('button', { text: 'Continue with GitHub', class: 'primary' });
      login.addEventListener('click', () => { dialog.close(); dialog.remove(); beginSignIn(); });
      dialog.append(login);
    }
    document.body.append(dialog);
    dialog.showModal();
  });
  if (readToken() || signedInHint()) {
    void api.me().then(({ profile }) => { account.textContent = profile.login; announce({ profile, fresh: false }); })
      .catch((e: unknown) => { if (e instanceof ApiError && e.status === 401) setSignedInHint(false); announce({ profile: null, fresh: false }); });
  } else announce({ profile: null, fresh: false });
}

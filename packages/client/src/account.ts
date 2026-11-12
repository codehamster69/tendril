import { ApiError, FarmApi, isDesktop, setSignedInHint, signedInHint, signIn, readToken, writeToken } from './api-client';
import type { FarmResponse, Profile } from './api-client';
import type { RealSim } from './real-sim';
import { el, toast } from './palette';
import { syncOnce } from './autosync';

/** Connects the ranked farm, if requested. Falls back to local play with a toast. */
/** Starts the same sign-in flow as the account dialog's GitHub button. Set by mountAccount. */
let signInStarter: () => void = () => {};
export const startSignIn = (): void => signInStarter();

/** `implicit`: opened because the player is signed in, not because they asked; a stale sign-in then falls back quietly. */
export async function connectRanked(api: FarmApi, implicit = false): Promise<FarmResponse | undefined> {
  try { return await api.farm(); } catch (e) {
    if (e instanceof ApiError && e.status === 404) return api.createFarm();
    if (implicit && e instanceof ApiError && e.status === 401) { setSignedInHint(false); return undefined; }
    toast('Could not connect ranked farm', e instanceof Error ? e.message : 'Sign in first.');
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
    const dialog = el('dialog', { class: 'campaign-map', 'aria-label': 'Account and ranked farm' });
    const close = el('button', { text: 'Close' });
    close.addEventListener('click', () => { dialog.close(); dialog.remove(); });
    dialog.append(el('header', {}, el('h2', { text: 'A fair field for everyone' }), close));
    try {
      const { profile } = await api.me();
      dialog.append(el('p', { text: `Signed in as ${profile.displayName}` }));
      if (sim.ranked) {
        dialog.append(el('p', { text: 'Your ranked farm syncs to the leaderboard every few seconds while the game is open.' }));
        const sync = el('button', { text: 'Sync now', class: 'primary' });
        sync.addEventListener('click', async () => {
          sync.disabled = true;
          try {
            const result = await syncOnce(api, sim);
            if (result) toast('Farm verified', `Tick ${result.tick}, rank ${result.rank}.`);
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

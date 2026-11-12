import { ApiError, FarmApi, setSignedInHint, signedInHint, signIn, readToken, writeToken } from './api-client';
import type { FarmResponse } from './api-client';
import type { GameLoop } from './game-loop';
import type { RealSim } from './real-sim';
import { el, toast } from './palette';

/** Connects the ranked farm, if requested. Falls back to local play with a toast. */
export async function connectRanked(api: FarmApi): Promise<FarmResponse | undefined> {
  try { return await api.farm(); } catch (e) {
    if (e instanceof ApiError && e.status === 404) return api.createFarm();
    toast('Could not connect ranked farm', e instanceof Error ? e.message : 'Sign in first.');
    return undefined;
  }
}

/** The account button and its dialog. Local play never needs an account. */
export function mountAccount(api: FarmApi, sim: RealSim, loop: GameLoop): void {
  const account = document.getElementById('btn-account') as HTMLButtonElement;
  account.addEventListener('click', async () => {
    const dialog = el('dialog', { class: 'campaign-map', 'aria-label': 'Account and ranked farm' });
    const close = el('button', { text: 'Close' });
    close.addEventListener('click', () => { dialog.close(); dialog.remove(); });
    dialog.append(el('header', {}, el('h2', { text: 'A fair field for everyone' }), close));
    try {
      const { profile } = await api.me();
      dialog.append(el('p', { text: `Signed in as ${profile.displayName}` }));
      dialog.append(el('a', { href: '?mode=live&ranked=1', class: 'next-lesson', text: 'Open your server-verified farm' }));
      if (sim.ranked) {
        const sync = el('button', { text: 'Pause and sync one chunk', class: 'primary' });
        sync.addEventListener('click', async () => {
          sync.disabled = true;
          try {
            await loop.pause();
            const plan = sim.prepareChunk();
            if (plan) {
              const response = await api.submit(sim.accepted!.farm.id, plan.request);
              await sim.acknowledge(plan, response);
              toast('Farm verified', `Tick ${response.tick}, rank ${response.rank}.`);
            } else toast('Already synced', 'No new ticks need verifying.');
          } catch (e) { toast('Sync stopped', e instanceof Error ? e.message : 'Your local logs are kept.'); } finally { sync.disabled = false; }
        });
        dialog.append(sync);
      }
      const logout = el('button', { text: 'Sign out', class: 'quiet' });
      logout.addEventListener('click', async () => { await api.logout(); writeToken(null); setSignedInHint(false); location.href = '?mode=live'; });
      dialog.append(logout);
    } catch {
      dialog.append(el('p', { text: 'Local play never needs an account. Sign in with GitHub to verify your farm and submit daily scores.' }));
      const login = el('button', { text: 'Continue with GitHub', class: 'primary' });
      login.addEventListener('click', () => { void signIn().catch((e: unknown) => toast('Sign-in unavailable', e instanceof Error ? e.message : 'Try again later.')); });
      dialog.append(login);
    }
    document.body.append(dialog);
    dialog.showModal();
  });
  if (readToken() || signedInHint()) {
    void api.me().then(({ profile }) => { account.textContent = profile.displayName; }).catch((e: unknown) => { if (e instanceof ApiError && e.status === 401) setSignedInHint(false); });
  }
}

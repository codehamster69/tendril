import { el } from './palette';
import { startSignIn } from './account';
import type { AccountEvent } from './account';

const DISMISS_KEY = 'tendril.unrankedNotice.dismissedUntil';
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

function dismissedNow(): boolean {
  try { return Number(localStorage.getItem(DISMISS_KEY)) > Date.now(); } catch { return false; }
}
function rememberDismissal(): void {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_MS)); } catch { /* private mode: dismissed for this page only */ }
}

/** A slim bar telling a live-mode player that this farm is not on the leaderboard. Hidden everywhere else. */
export function mountNotice({ live, verified }: { live: boolean; verified: boolean }): void {
  const bar = document.getElementById('unranked-notice');
  if (!bar) return;
  if (!live) { bar.hidden = true; return; }
  let closed = dismissedNow();
  const render = ({ profile, fresh }: AccountEvent): void => {
    if (fresh) closed = true; // Just signed in: the sign-in prompt has done its job for this session.
    bar.replaceChildren();
    if (closed || (profile && verified)) { bar.hidden = true; return; }
    const close = el('button', { class: 'quiet notice-close', type: 'button', 'aria-label': 'Dismiss this notice', title: 'Dismiss for 7 days', text: '×' });
    close.addEventListener('click', () => { closed = true; rememberDismissal(); bar.hidden = true; });
    if (profile) {
      bar.append(el('span', { text: "You're signed in, but this is your local farm. Open your ranked farm to compete." }),
        el('a', { class: 'notice-link', href: '?mode=live&ranked=1', text: 'Open ranked farm' }), close);
    } else {
      const signIn = el('button', { class: 'primary', type: 'button', text: 'Sign in' });
      signIn.addEventListener('click', () => startSignIn());
      bar.append(el('span', { text: 'This farm is saved only on this computer and is not ranked. Sign in to join the leaderboard.' }), signIn, close);
    }
    bar.hidden = false;
  };
  window.addEventListener('tendril:account', (event) => render((event as CustomEvent<AccountEvent>).detail));
}

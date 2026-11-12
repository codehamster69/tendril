// C1: duel flow on the result panel. "Challenge a friend" creates a duel from this run and copies its link; when the
// page itself is a duel, the panel compares scores, accepts it (mutual follow) and opens the ghost race.
import { API_ORIGIN, ApiError } from './api-client';
import type { ChallengeInfo, DuelPage, EntryResult, FarmApi } from './api-client';
import { startSignIn } from './account';
import { el, toast } from './palette';
import { copyText, SHARE_HOST } from './share';
import type { LogEntry } from '@tendril/sim/src/index.ts';

/** Where a friend opens the duel: the site page, not the game. */
export const duelLink = (id: string): string => {
  const origin = API_ORIGIN || (location.protocol === 'app:' ? `https://${SHARE_HOST}` : location.origin);
  return `${origin}/duel/?id=${encodeURIComponent(id)}`;
};
export const raceUrl = (theirs: string, mine: string): string =>
  `replay.html?e=${encodeURIComponent(theirs)}&vs=${encodeURIComponent(mine)}`;

export interface DuelState { signedIn: boolean; netWorth: number; entry: EntryResult | null }
export interface DuelPanel { el: HTMLElement; update(state: DuelState): void }

/** One panel per finished run. `update` is called whenever the result is redrawn; it never repeats a network call. */
export function createDuelPanel(api: FarmApi, c: ChallengeInfo, getActions: () => LogEntry[]): DuelPanel {
  const root = el('div', { id: 'arena-duel', class: 'duel-panel' });
  let state: DuelState = { signedIn: false, netWorth: 0, entry: null };
  let page: DuelPage | null = null;
  let pageLoaded = false;
  let accepting: Promise<void> | null = null;
  let acceptNote = '';
  let created: string | null = null; // link made from this run
  let busy = false;
  let race: HTMLIFrameElement | null = null; // reused across redraws so the race does not restart

  const outcome = (mine: number, theirs: number, name: string): string =>
    mine > theirs ? `You beat ${name} by ${(mine - theirs).toLocaleString('en-US')} coins.` : mine < theirs ? `${name} is ahead by ${(theirs - mine).toLocaleString('en-US')} coins.` : `A tie with ${name}.`;

  const challengeButton = (): HTMLElement => {
    if (created) {
      const link = el('input', { id: 'duel-link', class: 'duel-link', readonly: '', value: created, 'aria-label': 'Duel link' });
      link.addEventListener('focus', () => link.select());
      const again = el('button', { id: 'btn-copy-duel', text: 'Copy link' });
      again.addEventListener('click', async () => { const ok = await copyText(created!); toast(ok ? 'Duel link copied' : 'Could not copy', ok ? 'Send it to a friend.' : created!); });
      return el('p', { class: 'duel-row' }, link, again);
    }
    const b = el('button', { id: 'btn-challenge', text: busy ? 'Creating duel…' : 'Challenge a friend' });
    if (busy) b.setAttribute('disabled', '');
    b.addEventListener('click', () => {
      if (!state.signedIn) { toast('Sign in first', 'A duel link carries your score, so it needs your account.'); startSignIn(); return; }
      void make();
    });
    return el('p', { class: 'duel-row' }, b, state.signedIn ? '' : el('span', { class: 'muted', text: ' Sign in to challenge a friend with this score.' }));
  };

  async function make(): Promise<void> {
    busy = true; draw();
    try {
      const { challengeId } = await api.createDuel({ seed: c.seed, ticks: c.ticks });
      await api.submitEntry(challengeId, { rulesVersion: c.rulesVersion, actions: getActions() });
      created = duelLink(challengeId);
      const ok = await copyText(created);
      toast(ok ? 'Duel link copied' : 'Duel ready', ok ? 'Send it to a friend. They can play without an account.' : created);
    } catch (e) {
      toast('Could not create the duel', e instanceof ApiError && e.status === 429 ? 'You have made enough duels for today.' : e instanceof Error ? e.message : 'Try again in a moment.');
    }
    busy = false; draw();
  }

  async function load(): Promise<void> {
    try { page = await api.duel(c.id); } catch { page = null; }
    pageLoaded = true; draw();
  }

  function accept(): void {
    const mine = state.entry?.entryId;
    if (accepting || !state.signedIn || !mine || !page || page.viewer?.isChallenger) return;
    accepting = api.acceptDuel(c.id).then((r) => { acceptNote = `You and ${r.challenger.displayName} now follow each other.`; }, (e: unknown) => { acceptNote = e instanceof Error ? e.message : ''; }).then(() => { draw(); });
  }

  function draw(): void {
    const kids: (Node | string)[] = [];
    if (c.kind === 'duel') {
      if (!pageLoaded) { void load(); }
      const name = page?.challenger?.displayName ?? 'the challenger';
      if (page?.viewer?.isChallenger) {
        kids.push(el('p', { id: 'duel-status', text: 'This is your duel. Send the link and wait for a friend to beat you.' }));
      } else if (page?.entry) {
        const theirs = page.entry.netWorth;
        kids.push(el('p', { id: 'duel-status' }, el('b', { text: `You ${state.netWorth.toLocaleString('en-US')}` }), ` · ${name} ${theirs.toLocaleString('en-US')} · `, outcome(state.netWorth, theirs, name)));
        if (state.signedIn && state.entry) {
          accept();
          if (acceptNote) kids.push(el('p', { id: 'duel-follow', class: 'muted', text: acceptNote }));
          const src = raceUrl(page.entry.entryId, state.entry.entryId);
          if (race?.getAttribute('src') !== `${src}&embed=1`) race = el('iframe', { id: 'duel-race', class: 'duel-race', src: `${src}&embed=1`, title: `Ghost race against ${name}` });
          kids.push(race, el('p', {}, el('a', { id: 'duel-race-link', href: src, target: '_blank', rel: 'noopener', text: 'Open the race full size' })));
        } else if (!state.signedIn) {
          const si = el('button', { id: 'btn-duel-signin', text: `Sign in to race ${name}'s ghost` });
          si.addEventListener('click', () => startSignIn());
          kids.push(el('p', { class: 'muted', text: 'Your score above is from this device. Signing in submits it, lets you watch the ghost race and makes you and the challenger follow each other.' }), el('p', {}, si));
        }
      }
    }
    kids.push(challengeButton());
    root.replaceChildren(...kids);
  }

  return { el: root, update(next) { state = next; draw(); } };
}

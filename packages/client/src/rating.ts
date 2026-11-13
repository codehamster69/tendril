import type { FarmApi, LatestRating, Profile, RatingChange } from './api-client';
import { copyText, ordinal, ratingShareText, signed } from './share';
import { el, toast } from './palette';

const SEEN_KEY = 'tendril.rating.seen';
const DISCIPLINES = ['overall', 'speed', 'brevity'] as const;
const NAME = { overall: 'Overall', speed: 'Speed', brevity: 'Brevity' } as const;

const readSeen = (user: string): string | null => { try { return localStorage.getItem(`${SEEN_KEY}.${user}`); } catch { return null; } };
const writeSeen = (user: string, id: string): void => { try { localStorage.setItem(`${SEEN_KEY}.${user}`, id); } catch { /* private mode: the card may show again */ } };

/** "d-2026-12-04" -> "daily 4 Dec"; a season id reads "weekly season". */
export function contestLabel(l: Pick<LatestRating, 'challengeId' | 'kind'>): string {
  if (l.kind === 'season') return 'weekly season';
  const m = /^d-(\d{4})-(\d{2})-(\d{2})$/.exec(l.challengeId);
  return m ? `daily ${Number(m[3])} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]}` : 'daily';
}

/** Line on the result panel: is this run on course to be rated? Null when the challenge is never rated (duels, practice) or the player is signed out. */
export function rateLine(c: { kind: string; number: number | null }, signedIn: boolean, parTick: number | null): string | null {
  if (!signedIn || (c.kind !== 'daily' && c.kind !== 'season') || c.number === null || c.number <= 0) return null;
  return parTick !== null
    ? 'On course to be rated: you reached par, so this run counts when the day closes.'
    : 'Not on course to be rated: par was not reached. A run below par is never rated, so it costs you nothing.';
}

const tierVar = (key: string): string => `var(--tier-${key}, var(--wheat))`;
const fmt = (n: number): string => n.toLocaleString('en-US');

export function mountRating(api: FarmApi): void {
  const right = document.querySelector('#statusbar .status-right');
  if (!right) return;
  let chip: HTMLButtonElement | null = null;
  let card: HTMLElement | null = null;
  let profile: Profile | null = null;

  const clear = (): void => { chip?.remove(); chip = null; card?.remove(); card = null; };

  const drawChip = (l: LatestRating): void => {
    const o = l.overall;
    if (!o) { chip?.remove(); chip = null; return; }
    if (!chip) {
      chip = el('button', { id: 'rating-chip', class: 'rating-chip', type: 'button', 'aria-haspopup': 'dialog' });
      right.prepend(chip);
      chip.addEventListener('click', () => { if (latest) showCard(latest, false); });
    }
    chip.style.setProperty('--chip', tierVar(o.tier.key));
    chip.dataset.tier = o.tier.key;
    chip.textContent = `${fmt(o.rating)}${o.provisional ? '?' : ''} ${o.tier.name}`;
    chip.title = `Your overall rating${o.provisional ? ' (still in placement)' : ''}. Click for your last result.`;
  };

  let latest: LatestRating | null = null;

  const promoted = (l: LatestRating): { d: (typeof DISCIPLINES)[number]; c: RatingChange } | null => {
    for (const d of DISCIPLINES) { const c = l[d]; if (c?.promoted) return { d, c }; }
    return null;
  };

  function showCard(l: LatestRating, first: boolean): void {
    const main = l.overall ?? l.speed ?? l.brevity;
    if (!main || !profile) return;
    const mainD = l.overall ? 'overall' : l.speed ? 'speed' : 'brevity';
    const promo = promoted(l);
    card?.remove();
    const shown = promo ? promo.c : main;
    const tierName = shown.tier.name;
    const heading = promo ? `Promoted to ${tierName}${promo.d === 'overall' ? '' : ` in ${NAME[promo.d]}`}` : first ? 'Yesterday' : 'Last result';
    const label = contestLabel(l);
    const rows = DISCIPLINES.filter((d) => l[d] && d !== mainD).map((d) => {
      const c = l[d]!;
      return el('li', {}, `${NAME[d]}: ${ordinal(c.place)} of ${fmt(c.field)} · ${signed(c.delta)} · ${fmt(c.rating)}${c.provisional ? '?' : ''} ${c.tier.name}`);
    });
    const copy = el('button', { id: 'btn-rating-copy', class: 'primary', type: 'button', text: 'Copy result' });
    const text = ratingShareText({ label, place: main.place, field: main.field, delta: main.delta, rating: main.rating, tier: main.tier.name, provisional: main.provisional, promotedTo: promo ? tierName : null, login: profile.login });
    copy.addEventListener('click', async () => { const ok = await copyText(text); toast(ok ? 'Result copied' : 'Could not copy', ok ? 'Paste it anywhere.' : text); });
    const close = el('button', { id: 'btn-rating-close', class: 'quiet', type: 'button', text: 'Close' });
    const node = el('aside', { id: 'rating-card', class: 'rating-card', role: 'dialog', 'aria-label': heading, 'data-state': promo ? 'promotion' : 'result' },
      el('p', { class: 'eyebrow', text: `${label}${mainD === 'overall' ? '' : ` · ${NAME[mainD]}`}` }),
      el('h3', { id: 'rating-heading', text: heading }),
      el('p', { id: 'rating-line' }, el('b', { text: `${ordinal(main.place)} of ${fmt(main.field)}` }), ' · ', el('b', { class: main.delta >= 0 ? 'up' : 'down', text: signed(main.delta) })),
      el('p', { id: 'rating-now', text: `You are now ${fmt(main.rating)}${main.provisional ? '?' : ''}, ${main.tier.name}.${main.provisional ? ` Placement: ${main.events} of 5 rated days.` : ''}` }),
      ...(rows.length ? [el('ul', { class: 'rating-more' }, ...rows)] : []),
      el('div', { class: 'rating-actions' }, copy, close));
    node.style.setProperty('--chip', tierVar(shown.tier.key));
    close.addEventListener('click', () => { node.remove(); if (card === node) card = null; chip?.focus(); });
    node.addEventListener('keydown', (e) => { if (e.key === 'Escape') close.click(); });
    document.body.append(node);
    card = node;
    copy.focus();
  }

  const load = async (p: Profile): Promise<void> => {
    try {
      const { latest: l } = await api.ratingLatest();
      if (profile?.id !== p.id) return;
      latest = l;
      if (!l) { clear(); return; }
      drawChip(l);
      if (readSeen(p.id) !== l.challengeId) { writeSeen(p.id, l.challengeId); showCard(l, true); }
    } catch { /* no rating UI if the server cannot say; the game does not depend on it */ }
  };

  window.addEventListener('tendril:account', (event) => {
    const p = (event as CustomEvent<{ profile: Profile | null }>).detail.profile;
    profile = p; latest = null; clear();
    if (p) void load(p);
  });
}

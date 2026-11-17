import type { Snapshot } from '@tendril/sim/src/index.ts';
import type { Editor } from './editor';
import { cap, el, toast } from './palette';
import { CARDS, NEEDS, TRACKS, newlyOwned, stateOf, unseenAffordable, visible, withBuyLine, type SeedCard } from './catalogue';
import { playStamp } from './catalogue-fx';
import './catalogue.css';

const pictures = import.meta.glob('../../../assets/thumbs/{crop_*_s3,prop_beehive,prop_compost,prop_crate}.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const pictureUrl = (name: string): string => Object.entries(pictures).find(([k]) => k.endsWith(`/${name}.png`))?.[1] ?? '';
const SEEN_KEY = 'tendril.catalogue.seen.v1';
const loadSeen = (): Set<string> => { try { const v: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]'); return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []); } catch { return new Set(); } };
const saveSeen = (s: Set<string>): void => { try { localStorage.setItem(SEEN_KEY, JSON.stringify([...s])); } catch { /* the badge simply returns next visit */ } };
const SVG = 'http://www.w3.org/2000/svg';
function vine(grown: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 48 24'); svg.setAttribute('class', `cat-vine${grown ? ' grown' : ''}`); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M0 12 C10 0, 16 24, 24 12 S38 0, 48 12');
  const leaf = document.createElementNS(SVG, 'circle');
  leaf.setAttribute('cx', '24'); leaf.setAttribute('cy', '12'); leaf.setAttribute('r', '3');
  svg.append(path, leaf);
  return svg;
}

/** Full-screen seed catalogue. Buying adds `unlock <name>` to the code (the only way research is bought); the stamp plays when the farm confirms it. */
export function mountCatalogue({ editor }: { editor: Editor }): void {
  let snap: Pick<Snapshot, 'coins' | 'unlocks'> = { coins: 0, unlocks: 1 };
  let prevUnlocks: number | null = null;
  const pendingStamps = new Set<string>();
  const seen = loadSeen();
  const filter = { query: '', affordableOnly: false };
  let opener: HTMLElement | null = null;

  const search = el('input', { type: 'search', class: 'cat-search', placeholder: 'Search a seed or a function, e.g. build', 'aria-label': 'Search by name or function' });
  const afford = el('button', { class: 'hk-button', type: 'button', 'aria-pressed': 'false', text: 'What can I afford' });
  const purse = el('span', { class: 'hk-chip' }, el('small', { text: 'Coins' }), el('b', { text: '0' }));
  const closeBtn = el('button', { class: 'hk-button', type: 'button', text: 'Close' });
  const body = el('div', { class: 'cat-body' });
  const live = el('p', { class: 'cat-live', 'aria-live': 'polite' });
  const card = el('div', { class: 'hk-card cat-card-wrap' },
    el('header', {}, el('h2', { id: 'catalogue-title', text: 'Seed catalogue' }), purse, closeBtn),
    el('p', { class: 'cat-lead', text: 'Pick a packet, add its line to your code, and run it. Research is bought with the code unlock name.' }),
    el('div', { class: 'cat-tools' }, search, afford), live, body);
  const overlay = el('div', { id: 'catalogue-overlay', class: 'hk-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'catalogue-title', hidden: '' }, card);
  document.body.append(overlay);

  const buy = (c: SeedCard): void => {
    const next = withBuyLine(editor.getSource(), c);
    if (next === null) { toast('Already in your code', `unlock ${c.name} is waiting for a run.`); return; }
    editor.setSource(next);
    toast(`${cap(c.name)} added`, `Press Run to pay ${c.price} coins.`);
    close();
  };

  let shownSig = '';
  const render = (): void => {
    shownSig = CARDS.map((c) => stateOf(c, snap.unlocks, snap.coins)).join();
    const shown = visible(CARDS, filter, snap.unlocks, snap.coins);
    const filtered = filter.query.trim() !== '' || filter.affordableOnly;
    (purse.querySelector('b') as HTMLElement).textContent = snap.coins.toLocaleString('en-US');
    live.textContent = filtered ? `${shown.length} of ${CARDS.length} shown` : '';
    const frag = document.createDocumentFragment();
    for (const track of TRACKS) {
      const cards = shown.filter((c) => c.track === track.id);
      if (!cards.length) continue;
      const row = el('div', { class: 'cat-track' });
      cards.forEach((c, i) => {
        const st = stateOf(c, snap.unlocks, snap.coins);
        if (i > 0 && !filtered) row.append(vine(stateOf(cards[i - 1]!, snap.unlocks, snap.coins) === 'owned'));
        const stamp = pendingStamps.has(c.name);
        const btn = el('button', { class: 'cat-packet', type: 'button', 'data-seed': c.name, 'data-state': st, 'aria-label': `${cap(c.name)}, ${c.price === 0 ? 'free' : `${c.price} coins`}, ${st === 'owned' ? 'researched' : st === 'affordable' ? 'you can afford it, add to code' : 'not enough coins yet'}` });
        if (st === 'owned') btn.setAttribute('aria-disabled', 'true');
        btn.append(
          el('img', { src: pictureUrl(c.picture), alt: '', width: '64', height: '64' }),
          el('b', { class: 'cat-name', text: cap(c.name) }),
          el('span', { class: 'cat-cost', text: c.price === 0 ? 'Free' : `${c.price.toLocaleString('en-US')} coins` }),
          el('span', { class: 'cat-blurb', text: c.blurb }),
          el('code', { class: 'cat-code', text: c.adds.join('\n') }),
          el('span', { class: 'cat-needs', text: `Needs: ${NEEDS}` }),
          el('span', { class: 'cat-status', text: st === 'owned' ? 'Researched' : st === 'affordable' ? 'Add to code' : 'Not enough coins yet' }),
        );
        if (st === 'owned') btn.append(el('span', { class: `cat-stamp${stamp ? ' play' : ''}`, text: 'Researched', 'aria-hidden': 'true' }));
        btn.addEventListener('click', () => { if (st === 'affordable') buy(c); else if (st === 'locked') toast(`${cap(c.name)} costs ${c.price} coins`, `You have ${snap.coins.toLocaleString('en-US')}. Keep farming.`); });
        row.append(btn);
      });
      frag.append(el('section', { class: 'cat-section', 'aria-label': track.title }, el('h3', { text: track.title }), row));
    }
    if (!shown.length) frag.append(el('p', { class: 'cat-empty', text: filter.affordableOnly ? 'Nothing affordable yet. Harvest, sell, then come back.' : 'No seed or function matches that.' }));
    body.replaceChildren(frag);
    for (const name of pendingStamps) { const s = body.querySelector(`[data-seed="${name}"] .cat-stamp`); if (s) playStamp(s as HTMLElement); }
    if (!overlay.hidden) pendingStamps.clear();
  };

  // ---- badge on the menu button and the menu entry ----
  const badges: HTMLElement[] = [];
  const attachBadge = (host: Element | null): void => { if (!host) return; const b = el('span', { class: 'cat-badge', 'aria-hidden': 'true', hidden: '' }); host.append(b); badges.push(b); };
  attachBadge(document.getElementById('btn-menu')); attachBadge(document.querySelector('[data-entry="catalogue"]'));
  const syncBadge = (): void => {
    const fresh = unseenAffordable(snap.unlocks, snap.coins, seen);
    for (const b of badges) b.hidden = fresh.length === 0;
    const menuBtn = document.getElementById('btn-menu');
    if (menuBtn) menuBtn.setAttribute('aria-label', fresh.length ? `Menu, ${fresh.length} new in the seed catalogue` : 'Menu');
  };

  const open = (): void => {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.hidden = false;
    for (const c of unseenAffordable(snap.unlocks, snap.coins, seen)) seen.add(c.name);
    saveSeen(seen); syncBadge(); render();
    search.focus();
  };
  function close(): void { overlay.hidden = true; (opener && opener.offsetParent ? opener : document.getElementById('btn-menu'))?.focus(); }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') { // keep focus inside the modal
      const f = [...overlay.querySelectorAll<HTMLElement>('button, input')].filter((n) => !n.hasAttribute('disabled'));
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      return;
    }
    if (e.key.startsWith('Arrow') && document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('cat-packet')) {
      const packets = [...body.querySelectorAll<HTMLElement>('.cat-packet')], i = packets.indexOf(document.activeElement);
      const next = packets[i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0)];
      if (next) { e.preventDefault(); next.focus(); }
    }
  });
  search.addEventListener('input', () => { filter.query = search.value; render(); });
  afford.addEventListener('click', () => { filter.affordableOnly = !filter.affordableOnly; afford.setAttribute('aria-pressed', String(filter.affordableOnly)); render(); });
  window.addEventListener('tendril:open-catalogue', open);

  window.addEventListener('tendril:snapshot', (event) => {
    const s = (event as CustomEvent<Snapshot>).detail;
    if (prevUnlocks !== null) for (const c of newlyOwned(prevUnlocks, s.unlocks)) { pendingStamps.add(c.name); toast(`${cap(c.name)} researched`, 'Stamped into your catalogue.'); }
    prevUnlocks = s.unlocks; snap = { coins: s.coins, unlocks: s.unlocks };
    if (!overlay.hidden) {
      for (const c of unseenAffordable(snap.unlocks, snap.coins, seen)) seen.add(c.name);
      (purse.querySelector('b') as HTMLElement).textContent = snap.coins.toLocaleString('en-US');
      // Rebuild only when a card changes state, so focus is not lost on every coin.
      const sig = CARDS.map((c) => stateOf(c, snap.unlocks, snap.coins)).join();
      if (sig !== shownSig) render();
    } else syncBadge();
  });
  syncBadge();
}

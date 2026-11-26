// H8 seed packets in the game: browse and plant other players' programs, share your own, and the empty-editor offer.
// Everything a player wrote is put on the page with textContent. Planting only ever happens in Endless and sandbox.
import './packets.css';
import { compile } from '@tendril/lang/src/index.ts';
import { API_ORIGIN, ApiError } from './api-client';
import type { FarmApi, PacketPage, PacketSummary } from './api-client';
import type { Editor } from './editor';
import { EXAMPLES } from './editor';
import { startSignIn } from './account';
import { el, toast } from './palette';
import { copyText, SHARE_HOST } from './share';
import { PACKET_TAGS, isBlank, parsePacketId, plantRefusal, recallParent, rememberParent, shareRefusal } from './packets-core';
import type { PacketMode } from './packets-core';

const siteOrigin = (): string => API_ORIGIN || (location.protocol === 'app:' ? `https://${SHARE_HOST}` : location.origin);
export const packetLink = (id: string): string => `${siteOrigin()}/packets/${encodeURIComponent(id)}`;

export interface PacketsContext { editor: Editor; api: FarmApi; mode: PacketMode }

export function mountPackets({ editor, api, mode }: PacketsContext): void {
  const editorHost = document.getElementById('editor');
  if (!editorHost?.parentElement || document.getElementById('btn-packets')) return;
  const browse = el('button', { id: 'btn-packets', class: 'hk-button', type: 'button', title: 'Programs other players shared. Plant one to start from it.', text: 'Start from a seed packet' });
  const share = el('button', { id: 'btn-share-packet', class: 'hk-button', type: 'button', title: 'Share this program so other players can plant and remix it', text: 'Share' });
  editorHost.parentElement.insertBefore(el('div', { class: 'pk-actions', role: 'group', 'aria-label': 'Seed packets' }, browse, share), editorHost);

  /** Opens a modal dialog and resolves nothing: each flow closes it itself. */
  const open = (title: string): { dialog: HTMLDialogElement; body: HTMLElement; close: () => void } => {
    document.querySelector('.pk-dialog')?.remove();
    const body = el('div', { class: 'pk-body' });
    const closeButton = el('button', { class: 'hk-button', type: 'button', text: 'Close' });
    const dialog = el('dialog', { class: 'pk-dialog', 'aria-label': title }, el('header', {}, el('h2', { text: title }), closeButton), body);
    const close = (): void => { if (dialog.open) dialog.close(); dialog.remove(); };
    closeButton.addEventListener('click', close);
    dialog.addEventListener('cancel', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    return { dialog, body, close };
  };

  // ---- plant ----
  const doPlant = async (page: PacketPage): Promise<void> => {
    editor.setSource(page.source);
    rememberParent({ id: page.id, name: page.name });
    toast(`Planted "${page.name}"`, 'It is in your editor. Press Run to try it, then change it to make it yours.');
    api.plantPacket(page.id).catch(() => { /* counting a plant is best effort and needs a sign-in */ });
  };
  const confirmPlant = (id: string, into?: { body: HTMLElement; close: () => void }): void => {
    const refusal = plantRefusal(mode);
    if (refusal) { toast('Not here', refusal); return; }
    const frame = into ?? open('Plant this packet');
    frame.body.replaceChildren(el('p', { class: 'pk-note', text: 'Loading…' }));
    api.packet(id).then(async (page) => {
      const current = editor.getSource();
      const starterText = EXAMPLES.starter!.source;
      if (isBlank(current) || current === starterText || current === page.source) { await doPlant(page); frame.close(); return; }
      const status = el('p', { class: 'pk-status' });
      const yes = el('button', { class: 'hk-button hk-primary', type: 'button', text: 'Plant it' });
      const no = el('button', { class: 'hk-button', type: 'button', text: 'Keep my code' });
      yes.addEventListener('click', () => { void doPlant(page).then(frame.close); });
      no.addEventListener('click', frame.close);
      frame.body.replaceChildren(
        el('p', { class: 'pk-lede', text: `"${page.name}" by ${page.author.login} will replace the code in your editor. Press Ctrl+Z (Cmd+Z on a Mac) in the editor to get your code back.` }),
        el('div', { class: 'pk-row-buttons' }, yes, no), status);
    }).catch((e: unknown) => {
      frame.body.replaceChildren(el('p', { class: 'pk-status', 'data-tone': 'bad', text: e instanceof ApiError && e.status === 404 ? 'That packet is gone or was never shared.' : 'The packet list could not be reached. Try again in a moment.' }));
    });
  };

  // ---- browse ----
  const openBrowse = (): void => {
    const { body, close } = open('Seed packets');
    let sort: 'popular' | 'new' = 'popular';
    let tag = '';
    const list = el('ul', { class: 'pk-list' });
    const status = el('p', { class: 'pk-status' });
    const pop = el('button', { class: 'hk-button', type: 'button', 'aria-pressed': 'true', text: 'Popular this week' });
    const fresh = el('button', { class: 'hk-button', type: 'button', 'aria-pressed': 'false', text: 'New' });
    const tags = el('select', { 'aria-label': 'Filter by tag' }, el('option', { value: '', text: 'All tags' }), ...PACKET_TAGS.map((t) => el('option', { value: t, text: t })));
    const load = (): void => {
      pop.setAttribute('aria-pressed', String(sort === 'popular')); fresh.setAttribute('aria-pressed', String(sort === 'new'));
      list.replaceChildren(); status.textContent = 'Loading…'; status.removeAttribute('data-tone');
      api.packets(sort).then((r) => {
        const rows = tag ? r.packets.filter((p) => p.tags.includes(tag)) : r.packets;
        status.textContent = rows.length ? '' : 'Nothing here yet. Share a program of your own to start the list.';
        list.replaceChildren(...rows.map((p) => row(p)));
      }).catch(() => { status.textContent = 'The packets could not be loaded. Try again in a moment.'; status.setAttribute('data-tone', 'bad'); });
    };
    const row = (p: PacketSummary): HTMLElement => {
      const plant = el('button', { class: 'hk-button hk-primary', type: 'button', text: 'Plant this' });
      if (plantRefusal(mode)) { plant.disabled = true; plant.title = plantRefusal(mode)!; }
      plant.addEventListener('click', () => confirmPlant(p.id, { body, close }));
      const view = el('a', { class: 'hk-button', href: packetLink(p.id), target: '_blank', rel: 'noopener', 'data-site-link': '', text: 'Read the code' });
      return el('li', { class: 'pk-item' },
        el('strong', { text: p.name }),
        el('span', { class: 'pk-meta', text: `by ${p.author.login} · ${p.plants} ${p.plants === 1 ? 'plant' : 'plants'}${p.parentId ? ' · a remix' : ''}${p.tags.length ? ` · ${p.tags.join(', ')}` : ''}` }),
        ...(p.note ? [el('p', { text: p.note })] : []),
        el('div', { class: 'pk-row-buttons' }, plant, view));
    };
    pop.addEventListener('click', () => { sort = 'popular'; load(); });
    fresh.addEventListener('click', () => { sort = 'new'; load(); });
    tags.addEventListener('change', () => { tag = tags.value; load(); });
    body.append(
      el('p', { class: 'pk-lede', text: 'Programs other players shared. Plant one to load it into your editor, run it, then change it to make it your own.' }),
      el('div', { class: 'pk-tabs' }, pop, fresh, tags), status, list);
    const refusal = plantRefusal(mode);
    if (refusal) body.prepend(el('p', { class: 'pk-status', 'data-tone': 'bad', text: refusal }));
    load();
  };

  // ---- share ----
  const openShare = (): void => {
    const refusal = shareRefusal(mode);
    if (refusal) { toast('Not here', refusal); return; }
    const source = editor.getSource();
    if (isBlank(source)) { toast('Nothing to share yet', 'Write a program first, then share it as a seed packet.'); return; }
    const errors = compile(source).diagnostics.filter((d) => d.severity !== 'warning');
    if (errors.length) { toast('Fix this first', `Line ${errors[0]!.line}: ${errors[0]!.message}`); return; }
    const { body, close } = open('Share as a seed packet');
    const parent = recallParent();
    const name = el('input', { type: 'text', maxlength: '40', id: 'pk-name', placeholder: 'Carrot snake with bees' });
    const note = el('textarea', { rows: '3', maxlength: '280', id: 'pk-note', placeholder: 'What does it do? What would you change next?' });
    const picked = new Set<string>();
    const tagBox = el('div', { class: 'pk-tagpick' }, ...PACKET_TAGS.map((t) => {
      const box = el('input', { type: 'checkbox', value: t });
      box.addEventListener('change', () => { if (box.checked && picked.size >= 3) { box.checked = false; return; } if (box.checked) picked.add(t); else picked.delete(t); });
      return el('label', {}, box, t);
    }));
    const status = el('p', { class: 'pk-status' });
    const send = el('button', { class: 'hk-button hk-primary', type: 'button', text: 'Share packet' });
    const fail = (text: string): void => { status.textContent = text; status.setAttribute('data-tone', 'bad'); send.disabled = false; };
    send.addEventListener('click', () => {
      status.textContent = 'Sharing…'; status.removeAttribute('data-tone'); send.disabled = true;
      void (async () => {
        try { await api.me(); } catch { fail('Sign in first, so your name goes on the packet.'); startSignIn(); return; }
        try {
          const r = await api.sharePacket({ name: name.value, note: note.value, tags: [...picked], source, parentId: parent?.id ?? null, origin: mode === 'sandbox' ? 'sandbox' : 'endless' });
          rememberParent({ id: r.id, name: name.value.trim() });
          const link = el('input', { type: 'text', readonly: '', value: packetLink(r.id), 'aria-label': 'Packet link' });
          const copy = el('button', { class: 'hk-button', type: 'button', text: 'Copy link' });
          copy.addEventListener('click', () => { void copyText(link.value).then((ok) => { copy.textContent = ok ? 'Copied' : 'Copy failed'; }); });
          const done = el('button', { class: 'hk-button hk-primary', type: 'button', text: 'Done' });
          done.addEventListener('click', close);
          body.replaceChildren(el('p', { class: 'pk-lede', text: 'Shared. Anyone can plant it now, and it shows on your profile.' }), el('div', { class: 'pk-link' }, link, copy), el('div', { class: 'pk-row-buttons' }, done));
        } catch (e) {
          fail(e instanceof ApiError ? e.message : 'Could not share the packet. Try again in a moment.');
        }
      })();
    });
    body.append(el('div', { class: 'pk-form' },
      el('p', { class: 'pk-lede', text: 'Other players can plant your program in their editor and remix it. Your name goes on it. Keep it kind: reports hide a packet.' }),
      ...(parent ? [el('p', { class: 'pk-note', text: `Planted from "${parent.name}". It is listed as a remix of that packet.` })] : []),
      el('label', {}, 'Name', name), el('label', {}, 'Note (optional)', note), el('label', {}, 'Tags (up to 3)', tagBox), status, el('div', { class: 'pk-row-buttons' }, send)));
    name.focus();
  };

  browse.addEventListener('click', openBrowse);
  share.addEventListener('click', openShare);
  window.addEventListener('tendril:open-packets', () => openBrowse());

  // ---- the empty editor ----
  const canPlant = plantRefusal(mode) === null;
  const host = document.getElementById('editor');
  if (host && canPlant) {
    const useStarter = el('button', { class: 'hk-button', type: 'button', text: 'Use the starter' });
    const pick = el('button', { class: 'hk-button hk-primary', type: 'button', text: 'Start from a popular packet' });
    const empty = el('div', { class: 'pk-empty', id: 'pk-empty', hidden: '' }, el('p', { text: 'Your editor is empty. Start from something that already works.' }), el('div', { class: 'pk-row-buttons' }, pick, useStarter));
    useStarter.addEventListener('click', () => editor.setSource(EXAMPLES.starter!.source));
    pick.addEventListener('click', openBrowse);
    host.append(empty);
    const sync = (): void => { empty.hidden = !isBlank(editor.getSource()) || !!document.querySelector('.fr-card:not([hidden])'); };
    editor.onChange(sync);
    window.setInterval(sync, 700);
    sync();
  }

  // ---- ?plant=<id>: a link from the site's packet page ----
  const query = new URLSearchParams(location.search);
  const wanted = parsePacketId(query.get('plant'));
  if (wanted) {
    query.delete('plant');
    try { history.replaceState(null, '', `${location.pathname}${query.toString() ? `?${query}` : ''}${location.hash}`); } catch { /* ignore */ }
    window.setTimeout(() => confirmPlant(wanted), 600);
  }
}

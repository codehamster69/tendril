import { el, toast } from './palette';
import { parseDuelId } from './duel-id';

/** "Join duel" in the mode bar: paste a link a friend sent, in the desktop app or the browser. */
export function mountJoinDuel(): void {
  const button = document.getElementById('btn-join-duel');
  if (!button) return;
  button.addEventListener('click', () => {
    const dialog = el('dialog', { class: 'campaign-map', 'aria-label': 'Join a duel' });
    const close = el('button', { text: 'Close' });
    const input = el('input', { type: 'text', id: 'join-duel-input', class: 'duel-link', 'aria-label': 'Duel link', placeholder: 'Paste the duel link from your friend' });
    const go = el('button', { class: 'primary', text: 'Play this duel' });
    const done = (): void => { dialog.close(); dialog.remove(); };
    close.addEventListener('click', done);
    const submit = (): void => {
      const id = parseDuelId(input.value);
      if (!id) { toast('That is not a duel link', 'It looks like https://tendril.hokora.xyz/duel/?id=x-…'); return; }
      location.href = `?mode=challenge&id=${encodeURIComponent(id)}`;
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    dialog.append(el('header', {}, el('h2', { text: 'Join a duel' }), close),
      el('p', { text: 'A friend sent you a duel link? Paste it here to play their farm. No account is needed to play; sign in to submit your score.' }), input, go);
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

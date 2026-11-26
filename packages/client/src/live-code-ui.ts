// Live code in the page: waits for the player to stop typing, hands the code to the loop, and shows what happened.
import './live-code.css';
import type { Editor } from './editor';
import type { GameLoop } from './game-loop';
import { APPLY_DELAY_MS, EQUIP_EVENT, isMeaningfulChange, type EquipState } from './live-code';
import { getSettings } from './settings';

const BUSY_RETRY_MS = 150;
const BUSY_RETRIES = 40;

export function mountLiveCode({ loop, editor }: { loop: GameLoop; editor: Editor }): void {
  const chip = document.getElementById('equip-chip');
  let timer = 0;

  const show = (state: 'equipped' | 'kept' | 'pending', text: string, title: string): void => {
    if (!chip) return;
    chip.hidden = false;
    chip.dataset.state = state;
    chip.textContent = text;
    chip.title = title;
    chip.dataset.fresh = 'true';
    chip.addEventListener('animationend', () => { chip.dataset.fresh = 'false'; }, { once: true });
  };

  window.addEventListener(EQUIP_EVENT, (e) => {
    const s = (e as CustomEvent<EquipState>).detail;
    if (s.kind === 'equipped') {
      show('equipped', `Equipped at tick ${s.tick.toLocaleString('en-US')}`, 'Every bot restarts the new program from the top. Your farm is kept.');
      if (s.lines.length) editor.flashLines(s.lines);
    } else if (chip?.dataset.state !== 'kept' || chip.title !== (s.line ? `Line ${s.line}: ${s.message}` : s.message)) {
      show('kept', 'Still running your last working code', s.line ? `Line ${s.line}: ${s.message}` : s.message);
    }
  });

  const attempt = (tries: number): void => {
    timer = 0;
    if (!getSettings().liveCode) return;
    if (loop.applyLive(editor.getSource()) === 'busy' && tries < BUSY_RETRIES) timer = window.setTimeout(() => attempt(tries + 1), BUSY_RETRY_MS);
  };

  editor.onChange(() => {
    clearTimeout(timer);
    timer = 0;
    if (!loop.running) return;
    if (!getSettings().liveCode) {
      const running = loop.runningSource;
      if (running !== null && isMeaningfulChange(running, editor.getSource())) show('pending', 'Edited · press Run to apply', 'Apply code as I type is off in Settings.');
      return;
    }
    timer = window.setTimeout(() => attempt(0), APPLY_DELAY_MS);
  });
}

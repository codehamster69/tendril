// The settings screen body (shown inside the menu). The values and their storage live in settings.ts.
import { el } from './palette';
import { FONT_MAX, FONT_MIN, getSettings, updateSettings } from './settings';
import type { MotionPref, Quality } from './settings';

export const KEYS: [string, string][] = [
  ['?', 'Show these shortcuts'],
  ['Esc', 'Open or close the menu'],
  ['Enter', 'Start the day (on the start card)'],
  ['Space', 'Run or pause'],
  ['Ctrl/Cmd + Enter', 'Run the program'],
  ['Ctrl/Cmd + E', 'Hide or show the code slate'],
  ['F9', 'Set a breakpoint on this line'],
  ['F10', 'Step one line'],
  ['Arrow keys', 'Move between tiles on the farm'],
  ['W A S D', 'Pan the camera'],
  ['Q E', 'Turn the camera'],
  ['F', 'Follow a bot'],
  ['Home', 'Back to the whole farm'],
];

const row = (label: string, control: HTMLElement, hint?: string): HTMLElement =>
  el('div', { class: 'set-row' }, el('div', { class: 'set-label' }, el('b', { text: label }), ...(hint ? [el('small', { text: hint })] : [])), control);

function segmented<T extends string>(name: string, options: [T, string][], value: T, onPick: (v: T) => void): HTMLElement {
  const group = el('div', { class: 'set-seg', role: 'radiogroup', 'aria-label': name });
  const buttons = options.map(([v, text]) => {
    const b = el('button', { class: 'hk-button', type: 'button', role: 'radio', 'data-value': v, 'aria-checked': String(v === value), text });
    b.addEventListener('click', () => { for (const o of buttons) o.setAttribute('aria-checked', String(o === b)); onPick(v); });
    return b;
  });
  group.append(...buttons);
  return group;
}

/** The settings screen body. `accountButton` is whatever the menu uses to show or change the account. */
export function buildSettingsPanel(account: HTMLElement): HTMLElement {
  const s = getSettings();
  const mute = el('input', { type: 'checkbox', id: 'set-muted', 'aria-label': 'Sound off' }) as HTMLInputElement;
  mute.checked = s.muted;
  mute.addEventListener('change', () => updateSettings({ muted: mute.checked }));
  const vol = el('input', { type: 'range', id: 'set-volume', min: '0', max: '100', step: '5', 'aria-label': 'Volume' }) as HTMLInputElement;
  vol.value = String(Math.round(s.volume * 100));
  vol.addEventListener('input', () => updateSettings({ volume: Number(vol.value) / 100 }));
  const font = el('input', { type: 'number', id: 'set-font', min: String(FONT_MIN), max: String(FONT_MAX), step: '1', 'aria-label': 'Editor font size in pixels' }) as HTMLInputElement;
  font.value = String(s.fontSize);
  font.addEventListener('change', () => { font.value = String(updateSettings({ fontSize: Number(font.value) }).fontSize); });
  const keys = el('dl', { class: 'set-keys' });
  for (const [k, what] of KEYS) keys.append(el('dt', {}, el('kbd', { text: k })), el('dd', { text: what }));
  return el('div', { id: 'settings-panel', class: 'settings-panel' },
    el('h3', { text: 'Sound' }), row('Sound off', mute), row('Volume', vol),
    el('h3', { text: 'Display' }),
    row('Graphics quality', segmented<Quality>('Graphics quality', [['auto', 'Auto'], ['low', 'Low'], ['high', 'High']], s.quality, (v) => updateSettings({ quality: v })), 'Low: no shadows, lower resolution. High: sharpest. Auto adapts to your machine.'),
    row('Reduced motion', segmented<MotionPref>('Reduced motion', [['system', 'System'], ['reduced', 'On'], ['full', 'Off']], s.motion, (v) => updateSettings({ motion: v }))),
    row('Editor font size', font, `${FONT_MIN} to ${FONT_MAX} px`),
    el('h3', { text: 'Key bindings' }), keys,
    el('h3', { text: 'Account' }), account);
}

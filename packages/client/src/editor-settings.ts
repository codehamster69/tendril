// Editor settings popover: theme, font size, tab width, tick column. The button sits in the editor footer when there is
// one (the game screen), else in the corner of the editor itself. Border-first: a text button, a hairline-bordered panel.
import { EDITOR_DEFAULTS, THEME_LABELS, type EditorPrefs, type EditorTheme } from './editor-prefs';
import { FONT_MAX, FONT_MIN, getSettings, onSettings, updateSettings } from './settings';
import './editor-settings.css';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...kids);
  return e;
};

export function mountEditorSettings(editorEl: HTMLElement, prefs: EditorPrefs, change: (next: EditorPrefs) => void): void {
  const host = editorEl.parentElement?.querySelector<HTMLElement>('.editor-footer') ?? null;
  const btn = node('button', { type: 'button', class: 'ed-settings-btn', textContent: 'Editor settings' });
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  const panel = node('div', { class: 'ed-settings', hidden: true });
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Editor settings');

  const theme = node('select', { id: 'ed-theme' });
  for (const [k, label] of Object.entries(THEME_LABELS)) theme.append(node('option', { value: k, textContent: label }));
  theme.value = prefs.theme;
  const font = node('input', { id: 'ed-font', type: 'range', min: String(FONT_MIN), max: String(FONT_MAX), step: '1' });
  font.value = String(getSettings().fontSize);
  const fontOut = node('output', { textContent: `${font.value} px` });
  const tab = node('select', { id: 'ed-tab' });
  for (const n of [2, 4, 8]) tab.append(node('option', { value: String(n), textContent: `${n} spaces` }));
  tab.value = String(prefs.tabWidth);
  const ticks = node('input', { id: 'ed-ticks', type: 'checkbox', checked: prefs.tickColumn });

  const row = (label: string, id: string, ...ctl: Node[]): HTMLElement => node('div', { class: 'ed-row' }, node('label', { htmlFor: id, textContent: label }), ...ctl);
  const reset = node('button', { type: 'button', class: 'ed-settings-btn ed-reset', textContent: 'Reset' });
  panel.append(
    row('Theme', 'ed-theme', theme),
    row('Font size', 'ed-font', font, fontOut),
    row('Tab width', 'ed-tab', tab),
    row('Tick column', 'ed-ticks', ticks),
    node('div', { class: 'ed-row ed-end' }, reset),
  );

  const emit = (): void => change({ theme: theme.value as EditorTheme, tabWidth: Number(tab.value) as EditorPrefs['tabWidth'], tickColumn: ticks.checked });
  theme.addEventListener('change', emit);
  tab.addEventListener('change', emit);
  ticks.addEventListener('change', emit);
  font.addEventListener('input', () => { fontOut.textContent = `${font.value} px`; updateSettings({ fontSize: Number(font.value) }); });
  onSettings((s) => { font.value = String(s.fontSize); fontOut.textContent = `${s.fontSize} px`; });
  reset.addEventListener('click', () => {
    theme.value = EDITOR_DEFAULTS.theme; tab.value = String(EDITOR_DEFAULTS.tabWidth); ticks.checked = EDITOR_DEFAULTS.tickColumn;
    emit();
  });

  const setOpen = (open: boolean): void => { panel.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', () => setOpen(panel.hidden));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { setOpen(false); btn.focus(); } });
  document.addEventListener('mousedown', (e) => { if (!panel.hidden && !panel.contains(e.target as Node) && e.target !== btn) setOpen(false); });

  if (host) { host.classList.add('ed-has-settings'); host.append(btn); host.parentElement?.append(panel); panel.classList.add('ed-above-footer'); }
  else { editorEl.style.position = editorEl.style.position || 'relative'; panel.classList.add('ed-corner'); btn.classList.add('ed-corner-btn'); editorEl.append(btn, panel); }
}

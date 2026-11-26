// Editor colour themes: Bark (dark, the default), Field (light) and High contrast. Colours come from the palette in
// the approved workbench design; nothing here animates.
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';
import type { EditorTheme } from './editor-prefs';

interface Palette {
  dark: boolean; bg: string; text: string; gutter: string; gutterActive: string; caret: string; selection: string; activeLine: string;
  keyword: string; fn: string; string: string; number: string; comment: string; atom: string; variable: string; line: string; tooltipBg: string;
  error: string; hot: string; ok: string; info: string;
}
const PALETTES: Record<EditorTheme, Palette> = {
  bark: { dark: true, bg: '#120e0a', text: '#ece2d0', gutter: '#6e604d', gutterActive: '#f08a3a', caret: '#f08a3a', selection: '#3b2f24', activeLine: 'rgba(240,138,58,.07)',
    keyword: '#e3a86b', fn: '#9fc86e', string: '#d9c27a', number: '#8cbbd9', comment: '#77684f', atom: '#f08a3a', variable: '#ece2d0', line: '#3b2f24', tooltipBg: '#18130e',
    error: '#e8645a', hot: '#f08a3a', ok: '#93c160', info: '#7fb2d6' },
  field: { dark: false, bg: '#f3ecdf', text: '#2a2119', gutter: '#a8957a', gutterActive: '#a4520f', caret: '#a4520f', selection: '#e2d3b8', activeLine: 'rgba(240,138,58,.14)',
    keyword: '#a4520f', fn: '#3f7419', string: '#8a6a0b', number: '#1f6a99', comment: '#9b8a70', atom: '#a4520f', variable: '#2a2119', line: '#d4c6ae', tooltipBg: '#f3ecdf',
    error: '#b3362d', hot: '#a4520f', ok: '#3f7419', info: '#1f6a99' },
  contrast: { dark: true, bg: '#000000', text: '#ffffff', gutter: '#bbbbbb', gutterActive: '#ffb36b', caret: '#ffffff', selection: '#2a4a8a', activeLine: 'rgba(255,255,255,.12)',
    keyword: '#ffb36b', fn: '#b9f27d', string: '#ffe27a', number: '#8fd0ff', comment: '#c9c9c9', atom: '#ffb36b', variable: '#ffffff', line: '#ffffff', tooltipBg: '#000000',
    error: '#ff8a80', hot: '#ffb36b', ok: '#b9f27d', info: '#8fd0ff' },
};

const FONT = '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

export function editorTheme(name: EditorTheme): Extension {
  const p = PALETTES[name];
  const hairline = `1px solid ${p.dark ? 'rgba(236,226,208,.18)' : 'rgba(42,33,25,.22)'}`;
  return [
    EditorView.theme({
      '&': { height: '100%', backgroundColor: p.bg, color: p.text, '--ed-error': p.error, '--ed-hot': p.hot, '--ed-ok': p.ok, '--ed-info': p.info, '--ed-line': p.line, '--ed-text': p.text, '--ed-muted': p.gutter },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: FONT, overflow: 'auto' },
      '.cm-content': { padding: '12px 0', caretColor: p.caret },
      '.cm-line': { padding: '0 14px 0 6px' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: p.caret },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: p.selection },
      '.cm-activeLine': { backgroundColor: p.activeLine },
      '.cm-gutters': { backgroundColor: p.bg, color: p.gutter, border: 'none' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: p.gutterActive },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 8px', cursor: 'pointer' },
      '.cm-bp-gutter .cm-gutterElement': { width: '20px', cursor: 'pointer' },
      '.cm-bp-dot': { display: 'block', width: '10px', height: '10px', margin: '0.45em 0 0 5px', borderRadius: '50%', border: `2px solid ${p.hot}` },
      '.cm-mark-gutter': { width: '14px' },
      '.cm-bot-marker': { display: 'block', width: '4px', height: '1.55em', marginLeft: '3px', background: 'var(--mark)' },
      '.cm-heat': { display: 'block', width: '3px', height: '1.55em', marginLeft: '9px', background: 'var(--mark)' },
      '.cm-bot-line': { backgroundColor: 'color-mix(in srgb, var(--mark) 9%, transparent)' },
      '.cm-bot-line.cm-bot-selected': { backgroundColor: 'color-mix(in srgb, var(--mark) 18%, transparent)', boxShadow: 'inset 3px 0 0 var(--mark)' },
      '.cm-bot-marker-selected': { width: '6px', marginLeft: '2px' },
      '.cm-mark-gutter .cm-bot-marker': { cursor: 'pointer' },
      '.cm-bot-line.cm-bot-paused': { backgroundColor: 'color-mix(in srgb, var(--mark) 24%, transparent)' },
      '.cm-matchingBracket': { backgroundColor: 'transparent', outline: `1px solid ${p.hot}` },
      '.cm-nonmatchingBracket': { outline: `1px solid ${p.error}` },
      '.cm-selectionMatch': { backgroundColor: p.dark ? 'rgba(127,178,214,.2)' : 'rgba(31,106,153,.18)' },
      '.cm-searchMatch': { backgroundColor: 'transparent', outline: `1px solid ${p.hot}` },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: p.dark ? 'rgba(240,138,58,.3)' : 'rgba(240,138,58,.35)' },
      '.cm-tooltip': { background: p.tooltipBg, border: hairline, borderRadius: '3px', color: p.text, overflow: 'hidden' },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'inherit' },
      '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'transparent', color: p.text, boxShadow: `inset 2px 0 0 ${p.hot}` },
      '.cm-completionDetail': { color: p.gutter, marginLeft: '1em' },
      '.cm-completionInfo': { padding: '6px 10px', maxWidth: '340px' },
      '.cm-sprout-doc': { padding: '8px 12px', maxWidth: '340px', fontFamily: '"Atkinson Hyperlegible", system-ui, sans-serif', fontSize: '13px', lineHeight: '1.45' },
      '.cm-sprout-doc strong': { display: 'block', fontFamily: FONT, fontSize: '12px', fontWeight: '400', color: p.fn },
      '.cm-sprout-doc p': { margin: '4px 0', whiteSpace: 'normal' },
      '.cm-sprout-doc .cm-doc-cost': { fontFamily: FONT, fontSize: '12px', color: p.hot },
      '.cm-sprout-doc pre': { margin: '6px 0 0', padding: '4px 0 0', borderTop: hairline, fontFamily: FONT, fontSize: '12px', whiteSpace: 'pre-wrap' },
      '.cm-diagnostic': { padding: '3px 8px' },
      '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: `underline wavy ${p.error}`, textUnderlineOffset: '3px' },
      '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: `underline wavy ${p.hot}`, textUnderlineOffset: '3px' },
      '.cm-panels': { background: p.tooltipBg, color: p.text, borderColor: p.line },
      '.cm-panels input, .cm-panels button': { background: 'transparent', color: p.text, border: hairline, borderRadius: '3px', padding: '2px 6px' },
      '.cm-panels label': { color: p.gutter },
      '.cm-foldPlaceholder': { background: 'transparent', border: hairline, color: p.gutter, padding: '0 4px', borderRadius: '2px' },
      '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer', padding: '0 3px', color: p.gutter },
      '.cm-tick-gutter': { minWidth: '34px' },
      '.cm-tick-gutter .cm-gutterElement': { textAlign: 'right', padding: '0 8px 0 4px', fontSize: '.82em', color: p.gutter },
      '.cm-tick-gutter .cm-tick-hot': { color: p.hot },
      '.cm-err-line': { margin: '2px 0 4px 8px', padding: '2px 8px', borderLeft: `2px solid ${p.error}`, fontFamily: '"Atkinson Hyperlegible", system-ui, sans-serif', fontSize: '12.5px', lineHeight: '1.4', color: p.error, whiteSpace: 'normal', display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' },
      '.cm-err-line .cm-err-text': { color: p.text, flex: '1 1 180px' },
      '.cm-err-line button': { font: '600 12px/1 "Barlow Condensed", "Arial Narrow", sans-serif', letterSpacing: '.07em', textTransform: 'uppercase', color: p.hot, background: 'none', border: '1px solid transparent', borderRadius: '3px', padding: '5px 8px', cursor: 'pointer', transition: 'border-color .15s ease-out' },
      '.cm-err-line button:hover, .cm-err-line button:focus-visible': { borderColor: p.hot, outline: 'none' },
      '.cm-inline-value': { marginLeft: '14px', padding: '0 4px', fontSize: '.85em', color: p.gutter, border: hairline, borderRadius: '2px', pointerEvents: 'none' },
    }, { dark: p.dark }),
    syntaxHighlighting(HighlightStyle.define([
      { tag: t.comment, color: p.comment, fontStyle: 'italic' },
      { tag: t.keyword, color: p.keyword },
      { tag: t.string, color: p.string },
      { tag: t.number, color: p.number },
      { tag: t.atom, color: p.atom },
      { tag: t.standard(t.variableName), color: p.fn },
      { tag: t.variableName, color: p.variable },
    ])),
  ];
}

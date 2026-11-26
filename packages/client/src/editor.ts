import { boot } from './boot';
import { EditorState, RangeSetBuilder, StateEffect, StateField, Prec, type Extension } from '@codemirror/state';
import {
  EditorView, Decoration, GutterMarker, gutter, lineNumbers, keymap, drawSelection, highlightActiveLine, highlightActiveLineGutter,
  hoverTooltip, gutterLineClass, type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent } from '@codemirror/commands';
import {
  StreamLanguage, HighlightStyle, syntaxHighlighting, bracketMatching, indentService, indentUnit, type StringStream,
} from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, snippetCompletion, type Completion, type CompletionContext } from '@codemirror/autocomplete';
import { setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { API, CONSTANTS, KEYWORDS } from '@tendril/lang/src/index.ts';
import type { BotDebug, Diagnostic, ScriptError } from '@tendril/lang/src/index.ts';

import starter from '../../lang/examples/starter.sprout?raw';
import expander from '../../lang/examples/expander.sprout?raw';
import orchard from '../../lang/examples/orchard.sprout?raw';
import compost from '../../lang/examples/compost.sprout?raw';
import orders from '../../lang/examples/orders.sprout?raw';
import daily from '../../lang/examples/daily.sprout?raw';
import { BOT_PALETTE, botColour } from './bot-colours';

export const EXAMPLES: Record<string, { title: string; source: string }> = {
  starter: { title: 'Carrot snake · starter', source: starter },
  expander: { title: 'Research & expansion', source: expander },
  orchard: { title: 'Orchard & hives', source: orchard },
  compost: { title: 'Compost loop', source: compost },
  orders: { title: 'Contracts & forecast', source: orders },
  daily: { title: 'Daily challenge strategy', source: daily },
};
export const DEFAULT_SCRIPT = starter;
export const BOT_COLORS: readonly string[] = BOT_PALETTE;

let allowedFeatures: ReadonlySet<string> | null = null;

const WORD_KEYWORDS = new Set(KEYWORDS);
const WORD_CONSTANTS = new Set(CONSTANTS);
const WORD_BUILTINS = new Set(API.filter((a) => a.kind !== 'constant').map((a) => a.name));

/** Stream tokenizer built from the same keyword, constant and builtin lists that the compiler and reference use. */
const sproutLanguage = StreamLanguage.define<null>({
  name: 'sprout',
  startState: () => null,
  token(stream: StringStream) {
    if (stream.eatSpace()) return null;
    if (stream.match('#')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match(/^"([^"\\]|\\.)*"?/) || stream.match(/^'([^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/^\d[\d_]*/)) return 'number';
    if (stream.match(/^[a-zA-Z_]\w*/)) {
      const w = stream.current();
      return WORD_KEYWORDS.has(w) ? 'keyword' : WORD_CONSTANTS.has(w) ? 'atom' : WORD_BUILTINS.has(w) ? 'builtin' : 'variableName';
    }
    if (stream.match(/^[+\-*/%<>=!]+/)) return 'operator';
    if (stream.match(/^[()[\]{}]/)) return 'bracket';
    stream.next();
    return 'punctuation';
  },
  languageData: { commentTokens: { line: '#' }, closeBrackets: { brackets: ['(', '[', '{', '"', "'"] } },
  tokenTable: {},
});

const highlight = HighlightStyle.define([
  { tag: t.comment, color: '#77684f', fontStyle: 'italic' },
  { tag: t.keyword, color: '#e3a86b', fontWeight: 'bold' },
  { tag: t.string, color: '#d9c27a' },
  { tag: t.number, color: '#8cbbd9' },
  { tag: t.atom, color: '#8cbbd9' },
  { tag: t.standard(t.variableName), color: '#9fc86e' },
  { tag: t.variableName, color: '#ece2d0' },
]);

const INDENT = '    ';
const OPENS_BLOCK = /:\s*(#.*)?$/;
/** Indent one level after a line ending in `:`, keep the previous indent otherwise, and pull `else`/`elif` back out. */
const sproutIndent = indentService.of((ctx, pos) => {
  const line = ctx.state.doc.lineAt(pos);
  if (line.number === 1) return 0;
  let prev = ctx.state.doc.line(line.number - 1);
  while (prev.number > 1 && !prev.text.trim()) prev = ctx.state.doc.line(prev.number - 1);
  const base = /^\s*/.exec(prev.text)![0].length;
  const after = ctx.state.doc.sliceString(pos, line.to);
  let n = OPENS_BLOCK.test(prev.text) ? base + INDENT.length : base;
  if (/^\s*(else|elif)\b/.test(after)) n = Math.max(0, n - INDENT.length);
  return n;
});

const cost = (t: number | 'n'): string => (t === 'n' ? 'n ticks' : t ? `${t} tick${t === 1 ? '' : 's'}` : 'free');
const visible = () => API.filter((e) => !allowedFeatures || allowedFeatures.has(e.feature));
const SNIPPETS: [string, string, string][] = [
  ['repeat forever', 'repeat forever:\n    ${}', 'repeat'],
  ['repeat times', 'repeat ${3} times:\n    ${}', 'repeat'],
  ['for each', 'for each ${tile} in ${tiles()}:\n    ${}', 'for'],
  ['for from to', 'for ${i} from ${0} to ${7}:\n    ${}', 'for'],
  ['if', 'if ${condition}:\n    ${}', 'if'],
  ['if else', 'if ${condition}:\n    ${}\nelse:\n    ${}', 'if'],
  ['while', 'while ${condition}:\n    ${}', 'while'],
  ['define', 'define ${name}(${}):\n    ${}', 'functions'],
];
const completionType = (k: string): string => (k === 'keyword' ? 'keyword' : k === 'constant' ? 'constant' : k === 'query' ? 'property' : 'function');

function docNode(signature: string, ticks: number | 'n', doc: string, example: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'cm-sprout-doc';
  const sig = document.createElement('strong');
  sig.textContent = `${signature} · ${cost(ticks)}`;
  const text = document.createElement('p');
  text.textContent = doc;
  const code = document.createElement('pre');
  code.textContent = example;
  root.append(sig, text, code);
  return root;
}

function sproutCompletions(ctx: CompletionContext) {
  const word = ctx.matchBefore(/[A-Za-z_]\w*/);
  if (!word && !ctx.explicit) return null;
  const options: Completion[] = visible().map((e) => ({
    label: e.name, type: completionType(e.kind), detail: `${e.signature} · ${cost(e.ticks)}`, info: () => docNode(e.signature, e.ticks, e.doc, e.example),
  }));
  for (const [label, body, feature] of SNIPPETS) {
    if (allowedFeatures && !allowedFeatures.has(feature)) continue;
    options.push(snippetCompletion(body, { label, type: 'text', detail: 'snippet' }));
  }
  for (const k of KEYWORDS) if (!options.some((o) => o.label === k)) options.push({ label: k, type: 'keyword' });
  return { from: word ? word.from : ctx.pos, options, validFor: /^\w*$/ };
}

const hover = hoverTooltip((view, pos) => {
  const w = view.state.wordAt(pos);
  if (!w) return null;
  const name = view.state.sliceDoc(w.from, w.to);
  const e = API.find((x) => x.name === name);
  if (!e) return null;
  return { pos: w.from, end: w.to, above: true, create: () => ({ dom: docNode(e.signature, e.ticks, e.doc, e.example) }) };
}, { hoverTime: 250 });

/** Colour used when the caller supplies none: the bot's own colour, the same one its drone ring wears. */
export type BotColorFn = (bot: number) => string;
const defaultBotColor: BotColorFn = botColour;

export interface Editor {
  getSource(): string;
  setSource(text: string): void;
  setDiagnostics(d: Diagnostic[]): void;
  setErrors(e: ScriptError[]): void;
  breakpoints(): number[];
  setBreakpoints(lines: number[]): void;
  onBreakpointsChange(cb: (lines: number[]) => void): void;
  showBotLines(debug: BotDebug[], paused?: { bot: number; line: number } | null, colorOf?: BotColorFn): void;
  showHeat(heat: [number, number][]): void;
  setFeatures(features: ReadonlySet<string> | null): void;
  /** Move the cursor to a line and scroll it into view. `focus: false` leaves keyboard focus where it was. */
  revealLine(line: number, opts?: { focus?: boolean }): void;
  /** Highlight one bot's running line more strongly (null clears it). Re-applies the last marks at once. */
  setSelectedBot(bot: number | null): void;
  /** Called with the bot id when a running-line mark in the gutter is clicked. */
  onBotMarkClick(cb: (bot: number) => void): void;
  onRun(cb: () => void): void;
  onChange(cb: () => void): void;
  onStepLine(cb: () => void): void;
  /** A short green pulse on lines that just went onto the bots. */
  flashLines(lines: number[]): void;
}

function loadBreakpoints(key: string): number[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
  } catch { return []; }
}

// ---- gutter and line marks -------------------------------------------------------------------------------------

class DotMarker extends GutterMarker {
  override toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-bp-dot';
    el.title = 'Breakpoint · click to remove';
    return el;
  }
}
const BP_DOT = new DotMarker();

class BarMarker extends GutterMarker {
  constructor(readonly cls: string, readonly color: string, readonly tip: string) { super(); }
  override eq(o: BarMarker): boolean { return o.cls === this.cls && o.color === this.color && o.tip === this.tip; }
  override toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = this.cls;
    el.style.setProperty('--mark', this.color);
    el.title = this.tip;
    return el;
  }
}

type MarkSpec = { line: number; cls: string; color: string; tip: string; paused?: boolean; bot?: number; selected?: boolean };
const setBotMarks = StateEffect.define<MarkSpec[]>();
const setHeatMarks = StateEffect.define<MarkSpec[]>();

const botMarks = StateField.define<MarkSpec[]>({
  create: () => [],
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setBotMarks)) return e.value; return v; },
});
const heatMarks = StateField.define<MarkSpec[]>({
  create: () => [],
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setHeatMarks)) return e.value; return v; },
});

const botLineDecorations = EditorView.decorations.compute([botMarks], (state): DecorationSet => {
  const b = new RangeSetBuilder<Decoration>();
  const marks = [...state.field(botMarks)].filter((m) => m.line <= state.doc.lines).sort((x, y) => x.line - y.line);
  for (const m of marks) {
    const at = state.doc.line(m.line).from;
    b.add(at, at, Decoration.line({ class: `cm-bot-line${m.paused ? ' cm-bot-paused' : ''}${m.selected ? ' cm-bot-selected' : ''}`, attributes: { style: `--mark:${m.color}` } }));
  }
  return b.finish();
});

// Lines that just went onto the bots: a short green wash on the line and its gutter. Positions follow the text while the player keeps typing.
const setAppliedLines = StateEffect.define<number[]>();
const appliedLines = StateField.define<number[]>({
  create: () => [],
  update: (v, tr) => {
    let next = tr.docChanged ? v.map((p) => tr.changes.mapPos(p)) : v;
    for (const e of tr.effects) if (e.is(setAppliedLines)) next = e.value;
    return next;
  },
  provide: (f) => [
    EditorView.decorations.compute([f], (state): DecorationSet => {
      const b = new RangeSetBuilder<Decoration>();
      for (const at of [...new Set(state.field(f).map((p) => state.doc.lineAt(Math.min(p, state.doc.length)).from))].sort((x, y) => x - y)) b.add(at, at, Decoration.line({ class: 'cm-applied-line' }));
      return b.finish();
    }),
    gutterLineClass.compute([f], (state) => {
      const b = new RangeSetBuilder<GutterMarker>();
      const mark = new (class extends GutterMarker { elementClass = 'cm-applied-gutter'; })();
      for (const at of [...new Set(state.field(f).map((p) => state.doc.lineAt(Math.min(p, state.doc.length)).from))].sort((x, y) => x - y)) b.add(at, at, mark);
      return b.finish();
    }),
  ],
});

const markClick = new WeakMap<EditorView, (bot: number) => void>();
const markGutter = gutter({
  class: 'cm-mark-gutter',
  domEventHandlers: {
    mousedown(view, line) {
      const n = view.state.doc.lineAt(line.from).number;
      const m = view.state.field(botMarks).filter((x) => x.line === n && x.bot !== undefined);
      if (!m.length) return false;
      markClick.get(view)?.((m.find((x) => x.selected) ?? m[m.length - 1]!).bot!);
      return true;
    },
  },
  lineMarker(view, line) {
    const n = view.state.doc.lineAt(line.from).number;
    const bots = view.state.field(botMarks).filter((m) => m.line === n);
    if (bots.length) { const m = bots.find((x) => x.selected) ?? bots[bots.length - 1]!; return new BarMarker(m.selected ? 'cm-bot-marker cm-bot-marker-selected' : 'cm-bot-marker', m.color, m.tip); }
    const heat = view.state.field(heatMarks).find((m) => m.line === n);
    return heat ? new BarMarker(heat.cls, heat.color, heat.tip) : null;
  },
  lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setBotMarks) || e.is(setHeatMarks))),
  initialSpacer: () => new BarMarker('cm-bot-marker', 'transparent', ''),
});

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#120e0a', color: '#ece2d0', fontSize: '13.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace', lineHeight: '21px', overflow: 'auto' },
  '.cm-content': { padding: '14px 0 12px', caretColor: '#f08a3a' },
  '.cm-line': { padding: '0 14px 0 6px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#f08a3a' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: '#4a3a2b' },
  '.cm-activeLine': { backgroundColor: '#1c150e' },
  '.cm-gutters': { backgroundColor: '#120e0a', color: '#6e604d', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: '#1c150e', color: '#f08a3a' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 8px', cursor: 'pointer' },
  '.cm-bp-gutter .cm-gutterElement': { width: '20px', cursor: 'pointer' },
  '.cm-bp-dot': { display: 'block', width: '10px', height: '10px', margin: '5.5px 0 0 5px', borderRadius: '50%', background: '#e8645a' },
  '.cm-mark-gutter': { width: '14px' },
  '.cm-bot-marker': { display: 'block', width: '4px', height: '21px', marginLeft: '3px', borderRadius: '2px', background: 'var(--mark)' },
  '.cm-heat': { display: 'block', width: '3px', height: '21px', marginLeft: '9px', borderRadius: '2px', background: 'var(--mark)' },
  '.cm-bot-line': { background: 'color-mix(in srgb, var(--mark) 9%, transparent)' },
  '.cm-bot-line.cm-bot-selected': { background: 'color-mix(in srgb, var(--mark) 24%, transparent)', boxShadow: 'inset 3px 0 0 var(--mark)' },
  '.cm-bot-marker-selected': { width: '6px', marginLeft: '2px' },
  '.cm-mark-gutter .cm-bot-marker': { cursor: 'pointer' },
  '.cm-applied-line': { animation: 'cm-applied 1.1s ease-out' },
  '.cm-applied-gutter': { animation: 'cm-applied 1.1s ease-out' },
  '.cm-bot-line.cm-bot-paused': { background: 'rgba(240,138,58,.22)' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(240,138,58,.2)', outline: '1px solid rgba(240,138,58,.45)' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(127,178,214,.2)' },
  '.cm-searchMatch': { backgroundColor: 'rgba(240,138,58,.25)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(240,138,58,.5)' },
  '.cm-tooltip': { background: '#18130e', border: '1px solid #5c4835', borderRadius: '3px', color: '#ece2d0', overflow: 'hidden' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'inherit' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { background: '#4a3a2b', color: '#fff' },
  '.cm-completionDetail': { color: '#6e604d', marginLeft: '1em' },
  '.cm-completionInfo': { padding: '6px 10px', maxWidth: '340px' },
  '.cm-sprout-doc': { padding: '6px 10px', maxWidth: '340px', fontFamily: 'inherit' },
  '.cm-sprout-doc p': { margin: '4px 0', whiteSpace: 'normal' },
  '.cm-sprout-doc pre': { margin: '4px 0 0', padding: '4px 6px', background: '#120e0a', borderRadius: '4px', whiteSpace: 'pre-wrap' },
  '.cm-diagnostic': { padding: '3px 8px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid #e8645a' },
  '.cm-diagnostic-warning': { borderLeft: '3px solid #f08a3a' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy #e8645a', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy #f08a3a', textUnderlineOffset: '3px' },
  '.cm-panels': { background: '#18130e', color: '#ece2d0', borderColor: '#5c4835' },
  '.cm-panels input, .cm-panels button': { background: '#120e0a', color: '#ece2d0', border: '1px solid #5c4835', borderRadius: '4px', padding: '2px 6px' },
  '.cm-panels label': { color: '#6e604d' },
}, { dark: true });

const HEAT_ALPHA = [0.2, 0.35, 0.55, 0.75, 1];

export function createEditor(container: HTMLElement, storageKey: string, fallback = DEFAULT_SCRIPT): Editor {
  const load = (): string => { try { return localStorage.getItem(storageKey) ?? fallback; } catch { return fallback; } };
  let bps = new Set<number>(loadBreakpoints(storageKey + '.bp'));
  const bpListeners: ((lines: number[]) => void)[] = [];
  const changeCbs: (() => void)[] = [];
  let selectedBot: number | null = null;
  let lastLines: { debug: BotDebug[]; paused: { bot: number; line: number } | null; colorOf: BotColorFn } = { debug: [], paused: null, colorOf: defaultBotColor };
  const applyBotMarks = (): void => {
    const { debug, paused, colorOf } = lastLines;
    const marks: MarkSpec[] = debug.filter((d) => d.line !== null && d.status !== 'done').map((d) => ({
      line: clampLine(d.line ?? 1), cls: 'cm-bot-marker', color: colorOf(d.bot), tip: `Bot ${d.bot} · ${d.status}`, paused: paused?.bot === d.bot, bot: d.bot, selected: selectedBot === d.bot,
    }));
    view.dispatch({ effects: setBotMarks.of(marks) });
  };
  let flashTimer = 0;
  let runCb: (() => void) | null = null;
  let stepCb: (() => void) | null = null;

  const saveDraft = (): void => {
    const status = document.getElementById('editor-save');
    try {
      localStorage.setItem(storageKey, view.state.doc.toString());
      if (status) status.textContent = 'Saved on this device';
    } catch {
      if (status) status.textContent = 'Save failed · copy your code before closing';
    }
  };
  const lineCount = (): number => view.state.doc.lines;
  const renderBps = (): void => {
    view.dispatch({ effects: setBreakpointEffect.of([...bps].filter((l) => l <= lineCount())) });
    container.dataset.breakpoints = [...bps].sort((a, b) => a - b).join(',');
    try { localStorage.setItem(storageKey + '.bp', JSON.stringify([...bps])); } catch { /* storage full */ }
  };
  const toggleBp = (line: number): void => {
    if (line < 1 || line > lineCount()) return;
    if (bps.has(line)) bps.delete(line); else bps.add(line);
    renderBps();
    const lines = [...bps].sort((a, b) => a - b);
    for (const cb of bpListeners) cb(lines);
  };

  const setBreakpointEffect = StateEffect.define<number[]>();
  const bpField = StateField.define<number[]>({
    create: () => [],
    update: (v, tr) => { for (const e of tr.effects) if (e.is(setBreakpointEffect)) return e.value; return v; },
  });
  const lineAt = (v: EditorView, block: { from: number }): number => v.state.doc.lineAt(block.from).number;
  const bpGutter = gutter({
    class: 'cm-bp-gutter',
    lineMarker: (v, block) => (v.state.field(bpField).includes(lineAt(v, block)) ? BP_DOT : null),
    lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setBreakpointEffect))),
    initialSpacer: () => BP_DOT,
    domEventHandlers: { mousedown: (v, block) => { toggleBp(lineAt(v, block)); return true; } },
  });

  const extensions: Extension[] = [
    theme,
    lineNumbers({ domEventHandlers: { mousedown: (v, block) => { toggleBp(lineAt(v, block)); return true; } } }),
    bpField, bpGutter, appliedLines, botMarks, heatMarks, markGutter, botLineDecorations,
    highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
    history(), EditorState.tabSize.of(4), indentUnit.of(INDENT),
    sproutLanguage, syntaxHighlighting(highlight), sproutIndent, bracketMatching(), closeBrackets(),
    autocompletion({ override: [sproutCompletions], icons: false }),
    search({ top: true }), highlightSelectionMatches(), hover,
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': 'Sprout program for your farm bots' }),
    Prec.highest(keymap.of([
      { key: 'Mod-Enter', run: () => { runCb?.(); return true; }, preventDefault: true },
      { key: 'F10', run: () => { stepCb?.(); return true; }, preventDefault: true },
      { key: 'F9', run: (v) => { toggleBp(v.state.doc.lineAt(v.state.selection.main.head).number); return true; }, preventDefault: true },
      { key: 'Enter', run: insertNewlineAndIndent },
    ])),
    keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      saveDraft();
      changeCbs.forEach((cb) => cb());
    }),
  ];
  const view = new EditorView({ parent: container, state: EditorState.create({ doc: load(), extensions }) });
  boot.done('editor');
  renderBps();

  const clampLine = (l: number | undefined): number => Math.min(Math.max(1, l || 1), lineCount());
  let lastDiagnostics: CmDiagnostic[] = [];
  let lastErrors: CmDiagnostic[] = [];
  const publish = (): void => {
    const all = [...lastDiagnostics, ...lastErrors];
    container.dataset.errorLines = all.map((m) => view.state.doc.lineAt(m.from).number).join(',');
    view.dispatch(setDiagnostics(view.state, all));
  };

  return {
    getSource: () => view.state.doc.toString(),
    setSource(text) {
      if (text !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
    },
    setDiagnostics(d) {
      const doc = view.state.doc;
      lastDiagnostics = d.map((x): CmDiagnostic => {
        const line = doc.line(clampLine(x.line));
        const from = Math.min(line.to, line.from + Math.max(0, x.col - 1));
        const to = x.endCol ? Math.min(line.to, line.from + x.endCol - 1) : line.to;
        return { from, to: Math.max(to, Math.min(line.to, from + 1), from), severity: x.severity === 'warning' ? 'warning' : 'error', message: x.message };
      });
      publish();
    },
    setErrors(errors) {
      const doc = view.state.doc;
      lastErrors = errors.map((e): CmDiagnostic => {
        const line = doc.line(clampLine(e.line));
        return { from: line.from, to: line.to, severity: 'error', message: `${e.bot < 0 ? 'Program' : `Bot ${e.bot}`}: ${e.message}` };
      });
      publish();
    },
    breakpoints: () => [...bps].sort((a, b) => a - b),
    setBreakpoints(lines) { bps = new Set(lines); renderBps(); },
    onBreakpointsChange(cb) { bpListeners.push(cb); },
    showBotLines(debug, paused, colorOf = defaultBotColor) {
      lastLines = { debug, paused: paused ?? null, colorOf };
      applyBotMarks();
      if (paused) {
        const pos = view.state.doc.line(clampLine(paused.line)).from;
        if (!view.visibleRanges.some((r) => pos >= r.from && pos <= r.to)) view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      }
    },
    showHeat(heat) {
      const max = heat.reduce((m, [, n]) => Math.max(m, n), 0);
      const marks: MarkSpec[] = !max ? [] : heat.filter(([l]) => l >= 1 && l <= lineCount()).map(([l, n]) => ({
        line: l, cls: 'cm-heat', color: `rgba(217,119,66,${HEAT_ALPHA[Math.min(5, Math.ceil((n / max) * 5)) - 1]})`, tip: `${n.toLocaleString()} steps on this line`,
      }));
      view.dispatch({ effects: setHeatMarks.of(marks) });
    },
    setFeatures(f) { allowedFeatures = f; },
    revealLine(line, opts) {
      const pos = view.state.doc.line(clampLine(line)).from;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      if (opts?.focus !== false) view.focus();
    },
    onRun(cb) { runCb = cb; },
    onChange(cb) { changeCbs.push(cb); },
    onStepLine(cb) { stepCb = cb; },
    flashLines(lines) {
      const at = lines.filter((l) => l >= 1 && l <= lineCount()).map((l) => view.state.doc.line(l).from);
      if (!at.length) return;
      view.dispatch({ effects: setAppliedLines.of(at) });
      clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => view.dispatch({ effects: setAppliedLines.of([]) }), 1200);
    },
    setSelectedBot(bot) { selectedBot = bot; applyBotMarks(); },
    onBotMarkClick(cb) { markClick.set(view, cb); },
  };
}

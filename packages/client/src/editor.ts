import * as monaco from 'monaco-editor';
import { API, KEYWORDS, monarchTokens } from '@tendril/lang/src/index.ts';
import type { BotDebug, Diagnostic, ScriptError } from '@tendril/lang/src/index.ts';

import starter from '../../lang/examples/starter.sprout?raw';
import expander from '../../lang/examples/expander.sprout?raw';
import orchard from '../../lang/examples/orchard.sprout?raw';
import compost from '../../lang/examples/compost.sprout?raw';
import orders from '../../lang/examples/orders.sprout?raw';
import daily from '../../lang/examples/daily.sprout?raw';

export const EXAMPLES: Record<string, { title: string; source: string }> = {
  starter: { title: 'Carrot snake · starter', source: starter },
  expander: { title: 'Research & expansion', source: expander },
  orchard: { title: 'Orchard & hives', source: orchard },
  compost: { title: 'Compost loop', source: compost },
  orders: { title: 'Contracts & forecast', source: orders },
  daily: { title: 'Daily challenge strategy', source: daily },
};
export const DEFAULT_SCRIPT = starter;
export const BOT_COLORS = ['#D5B65B', '#D97742', '#8EA98B', '#7FB7D9', '#C792EA', '#F28FAD', '#A6E3A1', '#F9E2AF'];

const LANG = 'sprout';
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () =>
    new Worker(new URL('../node_modules/monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type: 'module' }),
};

let registered = false;
let allowedFeatures: ReadonlySet<string> | null = null;

function register(): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: LANG, extensions: ['.sprout'], aliases: ['Sprout'] });
  monaco.languages.setMonarchTokensProvider(LANG, monarchTokens() as monaco.languages.IMonarchLanguage);
  monaco.languages.setLanguageConfiguration(LANG, {
    comments: { lineComment: '#' },
    brackets: [['(', ')'], ['[', ']'], ['{', '}']],
    autoClosingPairs: [
      { open: '(', close: ')' }, { open: '[', close: ']' }, { open: '{', close: '}' },
      { open: '"', close: '"', notIn: ['string'] }, { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
    indentationRules: { increaseIndentPattern: /:\s*(#.*)?$/, decreaseIndentPattern: /^\s*(else|elif)\b/ },
    onEnterRules: [{ beforeText: /:\s*(#.*)?$/, action: { indentAction: monaco.languages.IndentAction.Indent } }],
  });
  const kindOf = (k: string): monaco.languages.CompletionItemKind => {
    const K = monaco.languages.CompletionItemKind;
    return k === 'keyword' ? K.Keyword : k === 'constant' ? K.Constant : k === 'query' ? K.Property : K.Function;
  };
  const cost = (t: number | 'n'): string => (t === 'n' ? 'n ticks' : t ? `${t} tick${t === 1 ? '' : 's'}` : 'free');
  const visible = () => API.filter((e) => !allowedFeatures || allowedFeatures.has(e.feature));
  const SNIPPETS: [string, string, string][] = [
    ['repeat forever', 'repeat forever:\n\t$0', 'repeat'],
    ['repeat times', 'repeat ${1:3} times:\n\t$0', 'repeat'],
    ['for each', 'for each ${1:tile} in ${2:tiles()}:\n\t$0', 'for'],
    ['for from to', 'for ${1:i} from ${2:0} to ${3:7}:\n\t$0', 'for'],
    ['if', 'if ${1:condition}:\n\t$0', 'if'],
    ['if else', 'if ${1:condition}:\n\t$2\nelse:\n\t$0', 'if'],
    ['while', 'while ${1:condition}:\n\t$0', 'while'],
    ['define', 'define ${1:name}(${2}):\n\t$0', 'functions'],
  ];
  monaco.languages.registerCompletionItemProvider(LANG, {
    provideCompletionItems(m, pos) {
      const word = m.getWordUntilPosition(pos);
      const range = new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn);
      const items: monaco.languages.CompletionItem[] = visible().map((e) => ({
        label: e.name, kind: kindOf(e.kind), detail: `${e.signature} · ${cost(e.ticks)}`,
        documentation: { value: `${e.doc}\n\n\`\`\`sprout\n${e.example}\n\`\`\`` }, insertText: e.name, range,
      }));
      for (const [label, body, feature] of SNIPPETS) {
        if (allowedFeatures && !allowedFeatures.has(feature)) continue;
        items.push({
          label, kind: monaco.languages.CompletionItemKind.Snippet, insertText: body, range, detail: 'snippet',
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        });
      }
      for (const k of KEYWORDS) if (!items.some((i) => i.label === k)) {
        items.push({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k, range });
      }
      return { suggestions: items };
    },
  });
  monaco.languages.registerHoverProvider(LANG, {
    provideHover(m, pos) {
      const w = m.getWordAtPosition(pos);
      const e = w && API.find((x) => x.name === w.word);
      if (!e) return null;
      return {
        range: new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn),
        contents: [{ value: `**${e.signature}** · ${cost(e.ticks)}` }, { value: e.doc }, { value: '```sprout\n' + e.example + '\n```' }],
      };
    },
  });
  monaco.editor.defineTheme('greenhouse', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: 'comment', foreground: '8EA98B', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'D5B65B', fontStyle: 'bold' },
      { token: 'string', foreground: 'B8E0C8' },
      { token: 'number', foreground: 'D97742' },
      { token: 'constant', foreground: 'F2A97E' },
      { token: 'predefined', foreground: '9CD3E0' },
      { token: 'identifier', foreground: 'DCEBEC' },
    ],
    colors: {
      'editor.background': '#0F2C31', 'editor.foreground': '#DCEBEC',
      'editorLineNumber.foreground': '#5F8784', 'editorLineNumber.activeForeground': '#D5B65B',
      'editorCursor.foreground': '#D5B65B', 'editor.selectionBackground': '#315C60',
      'editor.lineHighlightBackground': '#15393E', 'editorError.foreground': '#E8875A',
      'editorGutter.background': '#0F2C31',
    },
  });
}

export interface Editor {
  getSource(): string;
  setSource(text: string): void;
  setDiagnostics(d: Diagnostic[]): void;
  setErrors(e: ScriptError[]): void;
  breakpoints(): number[];
  setBreakpoints(lines: number[]): void;
  onBreakpointsChange(cb: (lines: number[]) => void): void;
  showBotLines(debug: BotDebug[], paused?: { bot: number; line: number } | null): void;
  showHeat(heat: [number, number][]): void;
  setFeatures(features: ReadonlySet<string> | null): void;
  revealLine(line: number): void;
  onRun(cb: () => void): void;
  onChange(cb: () => void): void;
  onStepLine(cb: () => void): void;
}

function loadBreakpoints(key: string): number[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
  } catch { return []; }
}

export function createEditor(container: HTMLElement, storageKey: string, fallback = DEFAULT_SCRIPT): Editor {
  register();
  const load = (): string => { try { return localStorage.getItem(storageKey) ?? fallback; } catch { return fallback; } };
  const ed = monaco.editor.create(container, {
    value: load(), language: LANG, theme: 'greenhouse', ariaLabel: 'Sprout program for your farm bots',
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace', fontLigatures: false,
    padding: { top: 14, bottom: 12 }, renderLineHighlight: 'all', automaticLayout: true, minimap: { enabled: false },
    fontSize: 13.5, lineHeight: 21, scrollBeyondLastLine: false, glyphMargin: true, tabSize: 4, insertSpaces: true,
    detectIndentation: false, lineDecorationsWidth: 14, smoothScrolling: true, cursorBlinking: 'smooth',
    guides: { indentation: true }, bracketPairColorization: { enabled: true },
  });
  const model = ed.getModel()!;
  let bps = new Set<number>(loadBreakpoints(storageKey + '.bp'));
  const bpListeners: ((lines: number[]) => void)[] = [];
  const bpDeco = ed.createDecorationsCollection();
  const botDeco = ed.createDecorationsCollection();
  const heatDeco = ed.createDecorationsCollection();

  const saveDraft = (): void => {
    const status = document.getElementById('editor-save');
    try {
      localStorage.setItem(storageKey, ed.getValue());
      if (status) status.textContent = 'Saved on this device';
    } catch {
      if (status) status.textContent = 'Save failed · copy your code before closing';
    }
  };
  ed.onDidChangeModelContent(saveDraft);
  const changeCbs: (() => void)[] = [];
  ed.onDidChangeModelContent(() => changeCbs.forEach((cb) => cb()));

  const renderBps = (): void => {
    bpDeco.set([...bps].filter((l) => l <= model.getLineCount()).map((l) => ({
      range: new monaco.Range(l, 1, l, 1),
      options: { isWholeLine: false, glyphMarginClassName: 'bp-glyph', glyphMarginHoverMessage: { value: 'Breakpoint · click to remove' } },
    })));
    container.dataset.breakpoints = [...bps].sort((a, b) => a - b).join(',');
    try { localStorage.setItem(storageKey + '.bp', JSON.stringify([...bps])); } catch { /* storage full */ }
  };
  const toggleBp = (line: number): void => {
    if (bps.has(line)) bps.delete(line); else bps.add(line);
    renderBps();
    const lines = [...bps].sort((a, b) => a - b);
    for (const cb of bpListeners) cb(lines);
  };
  ed.onMouseDown((e) => {
    const t = e.target.type;
    if ((t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || t === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS)
      && e.target.position) toggleBp(e.target.position.lineNumber);
  });
  ed.addCommand(monaco.KeyCode.F9, () => toggleBp(ed.getPosition()?.lineNumber ?? 1));
  renderBps();

  let runCb: (() => void) | null = null;
  let stepCb: (() => void) | null = null;
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runCb?.());
  ed.addCommand(monaco.KeyCode.F10, () => stepCb?.());

  let lastDiagnostics: monaco.editor.IMarkerData[] = [];
  let lastErrors: monaco.editor.IMarkerData[] = [];
  const publish = (): void => {
    const all = [...lastDiagnostics, ...lastErrors];
    container.dataset.errorLines = all.map((m) => m.startLineNumber).join(',');
    monaco.editor.setModelMarkers(model, 'sprout', all);
  };
  const clampLine = (l: number | undefined): number => Math.min(Math.max(1, l || 1), model.getLineCount());

  return {
    getSource: () => ed.getValue(),
    setSource: (text) => { if (text !== ed.getValue()) ed.setValue(text); },
    setDiagnostics(d) {
      lastDiagnostics = d.map((x) => {
        const ln = clampLine(x.line);
        return {
          severity: x.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
          message: x.message, startLineNumber: ln, startColumn: Math.max(1, x.col),
          endLineNumber: ln, endColumn: Math.max(x.col + 1, x.endCol || model.getLineMaxColumn(ln)),
        };
      });
      publish();
    },
    setErrors(errors) {
      lastErrors = errors.map((e) => {
        const ln = clampLine(e.line);
        return {
          severity: monaco.MarkerSeverity.Error, message: `${e.bot < 0 ? 'Program' : `Bot ${e.bot}`}: ${e.message}`,
          startLineNumber: ln, startColumn: 1, endLineNumber: ln, endColumn: Math.max(2, model.getLineMaxColumn(ln)),
        };
      });
      publish();
    },
    breakpoints: () => [...bps].sort((a, b) => a - b),
    setBreakpoints(lines) { bps = new Set(lines); renderBps(); },
    onBreakpointsChange(cb) { bpListeners.push(cb); },
    showBotLines(debug, paused) {
      botDeco.set(debug.filter((d) => d.line !== null && d.status !== 'done').map((d) => {
        const ln = clampLine(d.line ?? 1);
        const isPaused = paused?.bot === d.bot;
        return {
          range: new monaco.Range(ln, 1, ln, 1),
          options: {
            isWholeLine: true,
            className: isPaused ? 'bot-line paused' : `bot-line bot-${d.bot % BOT_COLORS.length}`,
            linesDecorationsClassName: `bot-marker bot-${d.bot % BOT_COLORS.length}`,
            hoverMessage: { value: `Bot ${d.bot} · ${d.status}` },
          },
        };
      }));
      if (paused) ed.revealLineInCenterIfOutsideViewport(clampLine(paused.line));
    },
    showHeat(heat) {
      const max = heat.reduce((m, [, n]) => Math.max(m, n), 0);
      if (!max) { heatDeco.clear(); return; }
      heatDeco.set(heat.filter(([l]) => l <= model.getLineCount()).map(([l, n]) => ({
        range: new monaco.Range(l, 1, l, 1),
        options: {
          linesDecorationsClassName: `heat heat-${Math.min(5, Math.ceil((n / max) * 5))}`,
          hoverMessage: { value: `${n.toLocaleString()} steps on this line` },
        },
      })));
    },
    setFeatures(f) { allowedFeatures = f; },
    revealLine(line) { const ln = clampLine(line); ed.revealLineInCenter(ln); ed.setPosition({ lineNumber: ln, column: 1 }); ed.focus(); },
    onRun(cb) { runCb = cb; },
    onChange(cb) { changeCbs.push(cb); },
    onStepLine(cb) { stepCb = cb; },
  };
}

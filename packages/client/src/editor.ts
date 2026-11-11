import * as monaco from 'monaco-editor';
import { API_SPEC } from './api-spec';

const STORAGE_KEY = 'tendril.script';

const DEFAULT_SCRIPT = `-- Every bot runs this program. Read the world, then act.
while true do
  local t = bot.scan()
  if t.crop ~= nil and t.stage == 3 then bot.harvest() end
  if not t.barn and t.crop == nil then bot.till(); bot.plant("carrot") end
  if not bot.move("east") then bot.move("south") end
end
`;

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () =>
    new Worker(new URL('../node_modules/monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type: 'module' }),
};

function load(): string {
  try { return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_SCRIPT; } catch { return DEFAULT_SCRIPT; }
}

export interface Editor {
  getSource(): string;
  setMarkers(errors: { bot: number; message: string }[]): void;
}

export function createEditor(container: HTMLElement): Editor {
  const ed = monaco.editor.create(container, {
    value: load(),
    language: 'lua',
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    scrollBeyondLastLine: false,
  });
  const model = ed.getModel()!;

  ed.onDidChangeModelContent(() => {
    try { localStorage.setItem(STORAGE_KEY, ed.getValue()); } catch { /* ignore */ }
  });

  monaco.languages.registerCompletionItemProvider('lua', {
    triggerCharacters: ['.'],
    provideCompletionItems(m, pos) {
      const word = m.getWordUntilPosition(pos);
      const range = new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn);
      const dotted = word.startColumn > 1 && m.getValueInRange(
        new monaco.Range(pos.lineNumber, word.startColumn - 1, pos.lineNumber, word.startColumn)) === '.';
      const prefix = dotted ? m.getWordUntilPosition({ lineNumber: pos.lineNumber, column: word.startColumn - 1 }).word : '';
      const entries = dotted ? API_SPEC.filter((e) => e.label.startsWith(prefix + '.')) : API_SPEC;
      return {
        suggestions: entries.map((e) => {
          const short = dotted ? e.label.slice(prefix.length + 1) : e.label;
          return {
            label: short,
            kind: monaco.languages.CompletionItemKind.Function,
            detail: e.signature,
            documentation: e.doc,
            insertText: short,
            filterText: short,
            range,
          };
        }),
      };
    },
  });

  return {
    getSource: () => ed.getValue(),
    setMarkers(errors) {
      monaco.editor.setModelMarkers(model, 'tendril', errors.map((e) => ({
        severity: monaco.MarkerSeverity.Error,
        message: `bot ${e.bot}: ${e.message}`,
        startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2,
      })));
    },
  };
}

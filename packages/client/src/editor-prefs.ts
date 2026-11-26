// Editor preferences. Font size is the game-wide setting (Settings panel); the rest live here.
export type EditorTheme = 'bark' | 'field' | 'contrast';
export interface EditorPrefs { theme: EditorTheme; tabWidth: 2 | 4 | 8; tickColumn: boolean }
export const EDITOR_PREFS_KEY = 'tendril.editor.v1';
export const EDITOR_DEFAULTS: EditorPrefs = { theme: 'bark', tabWidth: 4, tickColumn: true };
export const THEME_LABELS: Record<EditorTheme, string> = { bark: 'Bark (dark)', field: 'Field (light)', contrast: 'High contrast' };

export function normalizePrefs(raw: unknown): EditorPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    theme: r.theme === 'field' || r.theme === 'contrast' || r.theme === 'bark' ? r.theme : EDITOR_DEFAULTS.theme,
    tabWidth: r.tabWidth === 2 || r.tabWidth === 8 || r.tabWidth === 4 ? r.tabWidth : EDITOR_DEFAULTS.tabWidth,
    tickColumn: typeof r.tickColumn === 'boolean' ? r.tickColumn : EDITOR_DEFAULTS.tickColumn,
  };
}

export function loadPrefs(): EditorPrefs {
  try { return normalizePrefs(JSON.parse(localStorage.getItem(EDITOR_PREFS_KEY) ?? 'null')); } catch { return { ...EDITOR_DEFAULTS }; }
}
export function savePrefs(p: EditorPrefs): void {
  try { localStorage.setItem(EDITOR_PREFS_KEY, JSON.stringify(p)); } catch { /* blocked storage: the choice lasts this session */ }
}

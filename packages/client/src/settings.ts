// Player settings: one small record in localStorage, applied to the page through CSS variables and data attributes.
// Other modules read them with `getSettings()` and listen for the `tendril:settings` window event.

export type Quality = 'auto' | 'low' | 'high';
export type MotionPref = 'system' | 'reduced' | 'full';
export interface Settings { muted: boolean; volume: number; quality: Quality; motion: MotionPref; fontSize: number }

export const SETTINGS_KEY = 'tendril.settings.v1';
export const FONT_MIN = 11, FONT_MAX = 20;
export const DEFAULTS: Settings = { muted: false, volume: 0.6, quality: 'auto', motion: 'system', fontSize: 14 };

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Reads whatever is stored and returns a complete, valid record (unknown or broken values fall back to the default). */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    muted: r.muted === true,
    volume: typeof r.volume === 'number' && Number.isFinite(r.volume) ? clamp(r.volume, 0, 1) : DEFAULTS.volume,
    quality: r.quality === 'low' || r.quality === 'high' || r.quality === 'auto' ? r.quality : DEFAULTS.quality,
    motion: r.motion === 'reduced' || r.motion === 'full' || r.motion === 'system' ? r.motion : DEFAULTS.motion,
    fontSize: typeof r.fontSize === 'number' && Number.isFinite(r.fontSize) ? Math.round(clamp(r.fontSize, FONT_MIN, FONT_MAX)) : DEFAULTS.fontSize,
  };
}

let current: Settings | null = null;
export function getSettings(): Settings {
  if (current) return current;
  let raw: unknown = null;
  try { raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'); } catch { /* blocked or corrupt: defaults */ }
  return (current = normalizeSettings(raw));
}

/** True when the page should hold still: the player's choice, else the system preference. */
export function reducedMotion(s: Settings = getSettings()): boolean {
  return s.motion === 'reduced' || (s.motion === 'system' && typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

export function applySettings(s: Settings = getSettings()): void {
  const root = document.documentElement;
  root.style.setProperty('--editor-font', `${s.fontSize}px`);
  root.dataset.quality = s.quality;
  root.dataset.motion = reducedMotion(s) ? 'reduced' : 'full';
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = normalizeSettings({ ...getSettings(), ...patch });
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(current)); } catch { /* storage blocked: the choice lasts this session */ }
  applySettings(current);
  window.dispatchEvent(new CustomEvent('tendril:settings', { detail: current }));
  return current;
}

/** Call once at startup: applies the saved settings and keeps "system" motion in step with the OS. */
export function initSettings(): void {
  applySettings();
  if (typeof matchMedia === 'function') matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => applySettings());
}

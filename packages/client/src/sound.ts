// Game sound (U4). Every sound is made in code with Web Audio: short tones and filtered noise bursts.
// No audio files and no dependency. Nothing is created or played until the first click or key press.
import type { ViewEvent } from './sim-protocol';
import { getSettings as getGameSettings, onSettings, updateSettings as updateGameSettings } from './settings.ts';

export type SoundName = 'plant' | 'harvest' | 'sale' | 'error' | 'order' | 'run' | 'sunset' | 'click' | 'medal';
export interface SoundSettings { volume: number; ambient: boolean; muted: boolean }

const KEY = 'tendril.sound.v1';
const DEFAULTS: SoundSettings = { volume: 0.6, ambient: true, muted: false };
// Event kinds, as EVENT in sim-protocol.ts. Kept here so this module also loads in node tests.
const KIND_SOUND: Record<number, SoundName> = { 1: 'harvest', 2: 'sale', 3: 'order', 4: 'error' };
// Most important first: an error is never lost behind a harvest in the same batch.
const PRIORITY = [4, 3, 2, 1];
export const MAX_EVENT_SOUNDS_PER_SECOND = 8;
const AMBIENT_WIND = 0.05;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export function parseSettings(raw: string | null | undefined): SoundSettings {
  try {
    const p = JSON.parse(raw ?? '') as Partial<Record<keyof SoundSettings, unknown>>;
    return {
      volume: typeof p.volume === 'number' && Number.isFinite(p.volume) ? clamp01(p.volume) : DEFAULTS.volume,
      ambient: typeof p.ambient === 'boolean' ? p.ambient : DEFAULTS.ambient,
      muted: typeof p.muted === 'boolean' ? p.muted : DEFAULTS.muted,
    };
  } catch { return { ...DEFAULTS }; }
}

// Muted and volume belong to the Settings screen (settings.ts, tendril.settings.v1); this key only keeps `ambient`.
function loadSettings(): SoundSettings {
  let own: SoundSettings;
  try { own = parseSettings(globalThis.localStorage?.getItem(KEY)); } catch { own = { ...DEFAULTS }; }
  const game = getGameSettings();
  return { ...own, muted: game.muted, volume: game.volume };
}
let settings: SoundSettings = loadSettings();
function saveSettings(): void {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(settings)); } catch { /* private window or blocked storage: settings last for this page only */ }
}

/** Sliding one-second window. At 4x and 16x a flood of events cannot exceed this many sounds. */
export class SoundBudget {
  private stamps: number[] = [];
  private readonly perSecond: number;
  constructor(perSecond = MAX_EVENT_SOUNDS_PER_SECOND) { this.perSecond = perSecond; }
  take(now: number): boolean {
    while (this.stamps.length && now - this.stamps[0]! >= 1000) this.stamps.shift();
    if (this.stamps.length >= this.perSecond) return false;
    this.stamps.push(now);
    return true;
  }
}

/** One sound per event kind in a batch. Many harvests in one batch become one harvest sound (merged), then the budget applies. */
export function pickEventSounds(events: readonly ViewEvent[], budget: SoundBudget, now: number): SoundName[] {
  const kinds = new Set(events.map((e) => e[0]));
  const out: SoundName[] = [];
  for (const k of PRIORITY) if (kinds.has(k) && budget.take(now)) out.push(KIND_SOUND[k]!);
  return out;
}

export interface Voice { kind: 'tone' | 'noise'; at: number; dur: number; freq: number; peak: number; to?: number; wave?: OscillatorType; q?: number }
const tone = (at: number, dur: number, freq: number, peak: number, wave: OscillatorType = 'sine', to?: number): Voice => ({ kind: 'tone', at, dur, freq, peak, wave, to });
const noise = (at: number, dur: number, freq: number, peak: number, q: number): Voice => ({ kind: 'noise', at, dur, freq, peak, q });

/** Soft and short. Peaks stay under 0.2 so repeats never grate. */
export const RECIPES: Record<SoundName, Voice[]> = {
  plant: [noise(0, 0.05, 1800, 0.05, 1), tone(0, 0.12, 330, 0.2, 'sine', 440)],
  harvest: [tone(0, 0.1, 660, 0.16, 'triangle'), tone(0.06, 0.14, 880, 0.16, 'triangle')],
  sale: [tone(0, 0.12, 1319, 0.14, 'triangle'), tone(0.07, 0.16, 1760, 0.14, 'triangle')],
  error: [tone(0, 0.2, 220, 0.12, 'triangle', 165)],
  order: [tone(0, 0.12, 523, 0.14), tone(0.08, 0.12, 659, 0.14), tone(0.16, 0.2, 784, 0.14)],
  run: [tone(0, 0.25, 392, 0.14, 'sine', 587)],
  sunset: [tone(0, 0.35, 523, 0.12), tone(0.18, 0.35, 392, 0.12), tone(0.36, 0.5, 262, 0.12)],
  click: [noise(0, 0.03, 2400, 0.1, 2), tone(0, 0.02, 900, 0.05)],
  medal: [tone(0, 0.14, 784, 0.12, 'triangle'), tone(0.1, 0.14, 988, 0.12, 'triangle'), tone(0.2, 0.14, 1175, 0.12, 'triangle'), tone(0.3, 0.36, 1568, 0.14, 'triangle')],
};

interface Audio { ctx: AudioContext; master: GainNode; ambient: GainNode }
let audio: Audio | null = null;
let birdTimer: number | undefined;

/** Schedules voices on the context. `pitch` scales every frequency. */
function render(ctx: AudioContext, dest: AudioNode, voices: readonly Voice[], when: number, pitch: number): void {
  for (const v of voices) {
    const t0 = when + v.at;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v.peak, t0 + Math.min(0.01, v.dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + v.dur);
    g.connect(dest);
    if (v.kind === 'tone') {
      const o = ctx.createOscillator();
      o.type = v.wave ?? 'sine';
      o.frequency.setValueAtTime(v.freq * pitch, t0);
      if (v.to) o.frequency.exponentialRampToValueAtTime(v.to * pitch, t0 + v.dur);
      o.connect(g);
      o.start(t0); o.stop(t0 + v.dur + 0.03);
    } else {
      const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * v.dur), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = v.freq * pitch;
      band.Q.value = v.q ?? 1;
      src.connect(band).connect(g);
      src.start(t0); src.stop(t0 + v.dur + 0.03);
    }
  }
}

function startWind(ctx: AudioContext, out: AudioNode): void {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true;
  // Low-passed noise with a slow LFO on the cutoff: a gust that comes and goes.
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass'; low.frequency.value = 700; low.Q.value = 0.5;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.09;
  const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 250;
  lfo.connect(lfoDepth).connect(low.frequency);
  const level = ctx.createGain(); level.gain.value = AMBIENT_WIND;
  src.connect(low).connect(level).connect(out);
  src.start(); lfo.start();
}

function scheduleBird(): void {
  window.clearTimeout(birdTimer);
  birdTimer = window.setTimeout(() => {
    const a = audio;
    if (a && settings.ambient && !settings.muted && !document.hidden) {
      const f = 2600 + Math.random() * 800;
      const n = 2 + Math.floor(Math.random() * 3);
      const voices: Voice[] = [];
      for (let i = 0; i < n; i++) voices.push(tone(i * 0.16 + Math.random() * 0.04, 0.09, f, 0.03, 'sine', f * 1.25));
      render(a.ctx, a.ambient, voices, a.ctx.currentTime + 0.02, 1);
    }
    scheduleBird();
  }, 3000 + Math.random() * 5000);
}

/** What the speakers are set to, for the e2e tests: whether audio has started and the master gain it is heading to. */
function exposeDebug(): void {
  document.documentElement.dataset.soundGain = audio ? String(settings.muted ? 0 : settings.volume) : '';
}

function applySettings(): void {
  if (!audio) return;
  exposeDebug();
  const t = audio.ctx.currentTime;
  audio.master.gain.setTargetAtTime(settings.muted ? 0 : settings.volume, t, 0.03);
  audio.ambient.gain.setTargetAtTime(settings.ambient ? 1 : 0, t, 0.3);
}

/** Creates the audio graph. Only called from a user gesture, so browsers allow it. */
function ensureAudio(): Audio | null {
  if (audio) return audio;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = settings.muted ? 0 : settings.volume;
    master.connect(ctx.destination);
    const ambient = ctx.createGain();
    ambient.gain.value = settings.ambient ? 1 : 0;
    ambient.connect(master);
    audio = { ctx, master, ambient };
    exposeDebug();
    startWind(ctx, ambient);
    scheduleBird();
    void ctx.resume().catch(() => {});
    return audio;
  } catch { return null; }
}

/** Plays a sound. Silent until the first click or key press, while muted, and while the window is hidden. */
export function play(name: SoundName): void {
  const a = audio;
  if (!a || settings.muted || document.hidden) return;
  render(a.ctx, a.master, RECIPES[name], a.ctx.currentTime + 0.005, 1 + (Math.random() - 0.5) * 0.06);
}

export function getSettings(): SoundSettings { return { ...settings }; }
export function setVolume(volume: number): void { settings = { ...settings, volume: clamp01(volume) }; updateGameSettings({ volume: settings.volume }); applySettings(); }
export function setAmbient(on: boolean): void { settings = { ...settings, ambient: on }; saveSettings(); applySettings(); }
export function setMuted(muted: boolean): void { settings = { ...settings, muted }; updateGameSettings({ muted }); applySettings(); }

/** Wires the game's events to sound and starts listening for the first input. Returns a disposer. */
export function mountSound(): () => void {
  const budget = new SoundBudget();
  let running = false;
  const unlock = (): void => {
    if (!ensureAudio()) return;
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);

  const onVisibility = (): void => {
    if (!audio) return;
    if (document.hidden) void audio.ctx.suspend().catch(() => {});
    else if (!settings.muted) void audio.ctx.resume().catch(() => {});
  };
  document.addEventListener('visibilitychange', onVisibility);

  const listen = (name: string, fn: (e: CustomEvent) => void): (() => void) => {
    const h = (e: Event): void => fn(e as CustomEvent);
    window.addEventListener(`tendril:${name}`, h);
    return () => window.removeEventListener(`tendril:${name}`, h);
  };
  const offs = [
    onSettings((g) => { settings = { ...settings, muted: g.muted, volume: g.volume }; applySettings(); }),
    listen('events', (e) => { for (const name of pickEventSounds(e.detail as ViewEvent[], budget, performance.now())) play(name); }),
    listen('status', (e) => { const now = !!(e.detail as { running?: boolean }).running; if (now && !running) play('run'); running = now; }),
    listen('scenario-end', () => play('sunset')),
    listen('medal', () => play('medal')),
  ];
  const onClick = (e: Event): void => {
    if ((e.target as Element | null)?.closest?.('button, a, [role="button"]')) play('click');
  };
  document.addEventListener('click', onClick, true);

  return () => {
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('click', onClick, true);
    for (const off of offs) off();
    window.clearTimeout(birdTimer);
  };
}

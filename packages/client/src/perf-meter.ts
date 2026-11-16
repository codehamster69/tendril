// Performance meter: an overlay that is off by default (F3 or ?perf=1). It exists so speed can be measured
// before anyone tunes it. When off it costs one null check per hook site and nothing else.
import type * as THREE from 'three';

/** Hook points other modules call as `perfHook.x?.(...)`. They are set only while the meter is open. */
export const perfHook: {
  /** Called every animation frame with the requestAnimationFrame timestamp (ms). */
  frame?: (ms: number) => void;
  /** Called with each worker state message; the meter measures its JSON size (a close proxy for the transfer cost). */
  update?: (message: unknown) => void;
  /** Called with the milliseconds the farm view spent applying one snapshot. */
  apply?: (ms: number) => void;
} = {};

export interface PerfSource {
  renderInfo(): THREE.WebGLInfo;
  canvas: HTMLCanvasElement;
}

const WINDOW_MS = 2000;
const REFRESH_MS = 250;

/** Pure maths, kept apart from the DOM so it can be tested. */
export function frameStats(times: number[], now: number): { fps: number; avg: number; worst: number } {
  const recent = times.filter((t) => now - t.valueOf() <= WINDOW_MS);
  if (recent.length < 2) return { fps: 0, avg: 0, worst: 0 };
  let worst = 0;
  for (let i = 1; i < recent.length; i++) worst = Math.max(worst, recent[i]! - recent[i - 1]!);
  const span = recent[recent.length - 1]! - recent[0]!;
  const avg = span / (recent.length - 1);
  return { fps: avg > 0 ? 1000 / avg : 0, avg, worst };
}

const fmtBytes = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${Math.round(n)} B`);

class PerfMeter {
  private root: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private frames: number[] = [];
  private updates: { at: number; bytes: number; apply: number }[] = [];
  private lastApply = 0;
  private timer = 0;
  private text = '';

  private source: PerfSource;

  constructor(source: PerfSource) { this.source = source; }

  get open(): boolean { return this.root !== null; }

  show(): void {
    if (this.root) return;
    const root = document.createElement('div');
    root.id = 'perf-meter';
    root.setAttribute('role', 'status');
    root.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;background:rgba(8,20,22,.88);color:#e7f0ea;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;padding:8px 10px;border:1px solid #3b5a5c;border-radius:8px;min-width:230px;';
    const body = document.createElement('pre');
    body.style.cssText = 'margin:0 0 6px;white-space:pre;font:inherit;';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.style.cssText = 'font:inherit;padding:2px 8px;cursor:pointer;';
    copy.addEventListener('click', () => {
      const done = (): void => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); };
      if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(this.text).then(done, () => { copy.textContent = 'Copy failed'; });
      else copy.textContent = 'Copy unavailable';
    });
    root.append(body, copy);
    document.body.append(root);
    this.root = root;
    this.body = body;
    this.frames = [];
    this.updates = [];
    perfHook.frame = (ms) => { this.frames.push(ms); if (this.frames.length > 600) this.frames.splice(0, this.frames.length - 600); };
    perfHook.apply = (ms) => { this.lastApply = ms; const u = this.updates[this.updates.length - 1]; if (u) u.apply = ms; };
    perfHook.update = (message) => {
      const bytes = JSON.stringify(message)?.length ?? 0;
      this.updates.push({ at: performance.now(), bytes, apply: 0 });
      if (this.updates.length > 200) this.updates.splice(0, this.updates.length - 200);
    };
    this.timer = window.setInterval(() => this.render(), REFRESH_MS);
    this.render();
  }

  hide(): void {
    if (!this.root) return;
    clearInterval(this.timer);
    this.root.remove();
    this.root = null;
    this.body = null;
    this.frames = [];
    this.updates = [];
    perfHook.frame = perfHook.apply = perfHook.update = undefined;
  }

  toggle(): void { if (this.open) this.hide(); else this.show(); }

  /** The numbers as plain text, as the Copy button gives them. */
  report(): string { return this.text; }

  private render(): void {
    if (!this.body) return;
    const now = performance.now();
    const f = frameStats(this.frames, now);
    const recent = this.updates.filter((u) => now - u.at <= WINDOW_MS);
    const bytes = recent.reduce((s, u) => s + u.bytes, 0);
    const last = this.updates[this.updates.length - 1];
    const applyAvg = recent.length ? recent.reduce((s, u) => s + u.apply, 0) / recent.length : 0;
    const info = this.source.renderInfo();
    const c = this.source.canvas;
    const lines = [
      `fps          ${f.fps.toFixed(1)}`,
      `frame avg    ${f.avg.toFixed(1)} ms`,
      `frame worst  ${f.worst.toFixed(1)} ms`,
      `draw calls   ${info.render.calls}`,
      `triangles    ${info.render.triangles.toLocaleString('en-US')}`,
      `pixel ratio  ${window.devicePixelRatio} (canvas ${c.width}x${c.height})`,
      `update size  ${last ? fmtBytes(last.bytes) : 'n/a'}`,
      `update rate  ${fmtBytes(bytes / (WINDOW_MS / 1000))}/s (${recent.length} in 2 s)`,
      `apply time   ${applyAvg.toFixed(2)} ms avg, ${this.lastApply.toFixed(2)} ms last`,
    ];
    this.text = lines.join('\n');
    this.body.textContent = this.text;
  }
}

/** Wire the meter to a view. Returns the meter so tests and the console can read it. */
export function mountPerfMeter(source: PerfSource, query: URLSearchParams): PerfMeter {
  const meter = new PerfMeter(source);
  if (query.get('perf') === '1') meter.show();
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'F3' || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    meter.toggle();
  });
  return meter;
}

import './day-dial.css';
import { CROPS, createWorld, forecast } from '@tendril/sim/src/index.ts';
import type { Segment } from '@tendril/sim/src/index.ts';
import type { Snapshot } from './sim-types';
import { markAt, type DayInfo } from './day-clock';

// dayProgress() is the single clock for the dial and the sky (farm-light.ts). It lives in day-clock.ts so tests can load it without CSS.
export { dayProgress } from './day-clock';

/** What the dial needs to know about the run. `seed` is a getter because the farm's seed is only known once the save is loaded. */
export interface DayConfig { runTicks: number | null; seed?: () => number | null; weatherBias?: number }

const NS = 'http://www.w3.org/2000/svg';
// Arc geometry, same as the mockup: an ellipse centred at (150, 70).
const CX = 150, CY = 70, RX = 130, RY = 62;
const ARC = `M${CX - RX} ${CY} A${RX} ${RY} 0 0 1 ${CX + RX} ${CY}`;
const at = (f: number): [number, number] => { const a = Math.PI * (1 - f); return [CX + RX * Math.cos(a), CY - RY * Math.sin(a)]; };
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Node[]): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};
const fmt = (n: number): string => n.toLocaleString('en-US');

interface Mark { id: string; node: SVGGElement; text: string }

/** The day dial: a sun that crosses an arc as the run goes from sunrise to sunset. Weather and order deadlines are marks on the arc. */
export class DayDial {
  readonly root: HTMLElement;
  private sun: SVGGElement;
  private done: SVGPathElement;
  private marksG: SVGGElement;
  private tick: HTMLElement;
  private tip: HTMLElement;
  private marks = new Map<string, Mark>();
  private cfg: DayConfig = { runTicks: null };
  private scratch: ReturnType<typeof createWorld> | null = null;
  private scratchKey = '';
  private weatherKey = '';
  private weatherNodes: Mark[] = [];
  private lastProgress = -1;
  private lastLabel = '';
  private lastOrders = '';
  private lastWindow = -1;

  constructor(host: HTMLElement) {
    this.done = svg('path', { class: 'dd-done', d: ARC, pathLength: '100', 'stroke-dasharray': '0 100' });
    this.marksG = svg('g', { class: 'dd-marks' });
    this.sun = svg('g', { class: 'dd-sun' }, svg('circle', { r: '12', class: 'dd-halo' }), svg('circle', { r: '8', class: 'dd-disc' }));
    const art = svg('svg', { viewBox: '0 0 300 78', class: 'dd-art', 'aria-hidden': 'true' },
      svg('path', { class: 'dd-track', d: ARC }), this.done, this.marksG, this.sun);
    this.tick = document.createElement('span');
    this.tick.className = 'dd-tick hk-chip';
    this.tip = document.createElement('div');
    this.tip.className = 'dd-tip hk-card';
    this.tip.hidden = true;
    this.tip.setAttribute('role', 'tooltip');
    this.root = document.createElement('div');
    this.root.id = 'day-dial';
    this.root.className = 'dd';
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Day dial');
    this.root.append(art, this.tick, this.tip);
    host.append(this.root);
    // Keep clear of the top-left chips and push the tool row below the dial (stage.css reads --dd-bottom).
    this.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(this.layout) : null;
    const hud = document.getElementById('game-hud');
    if (hud) this.ro?.observe(hud);
    this.ro?.observe(this.root);
    window.addEventListener('resize', this.layout);
    window.addEventListener('tendril:slate-inset', this.layout);
    this.root.addEventListener('transitionend', this.layout);
    // The slate slides in and out; measure again once it has arrived.
    window.addEventListener('transitionend', this.slateMoved, true);
    requestAnimationFrame(this.layout);
  }

  private ro: ResizeObserver | null;
  private slateMoved = (e: TransitionEvent): void => { if ((e.target as Element | null)?.id === 'side') this.layout(); };
  /**
   * When the chips on the left reach under the dial (narrow stage, slate open), the dial moves into the gap right of
   * them, smaller; when that gap is too narrow it drops below the chips. Either way the tool row starts below it.
   */
  private layout = (): void => {
    if (!this.root.isConnected) return;
    const st = this.root.style;
    st.top = ''; st.left = ''; st.width = '';
    const d = this.root.getBoundingClientRect();
    const h = document.getElementById('game-hud')?.getBoundingClientRect();
    if (h && h.height > 0 && h.right + 8 > d.left && h.top < d.bottom && h.bottom > d.top) {
      // Right edge: the slate if it is open, else whatever sits top right (menu, Show code).
      // The open slate always bounds the room, whatever its top and even when the chips reach past its left edge
      // (wide chip text): then there is no room and the dial drops below the chips instead of sitting on the slate.
      const lefts = ['side', 'game-hud-tr', 'slate-toggle'].map((id) => [id, document.getElementById(id)?.getBoundingClientRect()] as const)
        .filter((e): e is readonly [string, DOMRect] => !!e[1] && e[1].width > 0 && (e[0] === 'side' ? e[1].left < window.innerWidth : e[1].top < d.bottom && e[1].left > h.right))
        .map(([, r]) => r.left);
      const from = h.right + 16, to = Math.min(window.innerWidth, ...lefts) - 16, room = to - from;
      if (room >= 200) { const w = Math.min(300, room); st.width = `${w}px`; st.left = `${Math.round(from + w / 2)}px`; }
      else st.top = `${Math.round(h.bottom + 6)}px`;
    }
    document.documentElement.style.setProperty('--dd-bottom', `${Math.round(this.root.getBoundingClientRect().bottom + 8)}px`);
  };

  /** Called with every snapshot. Cheap when nothing visible changed. */
  update(s: Snapshot, info: DayInfo, cfg: DayConfig): void {
    this.cfg = cfg;
    if (Math.abs(info.progress - this.lastProgress) > 0.0004 || info.start !== this.lastWindow) {
      this.lastProgress = info.progress;
      const [x, y] = at(info.progress);
      this.sun.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      this.done.setAttribute('stroke-dasharray', `${(info.progress * 100).toFixed(2)} 100`);
    }
    const label = info.looping ? `Day ${fmt(info.day)} · tick ${fmt(s.tick - info.start)} of ${fmt(info.length)}` : `Tick ${fmt(s.tick)} of ${fmt(info.length)}`;
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      this.tick.textContent = label;
      this.root.setAttribute('aria-label', `Day dial. ${label}, ${Math.round(info.progress * 100)}% of the day`);
    }
    if (info.start !== this.lastWindow) { this.lastWindow = info.start; this.weatherKey = ''; this.lastOrders = ''; }
    this.syncWeather(info);
    this.syncOrders(s, info);
  }

  private segments(info: DayInfo): Segment[] {
    const seed = this.cfg.seed?.();
    if (seed === null || seed === undefined) return [];
    const key = `${seed}|${this.cfg.weatherBias ?? 0}`;
    if (!this.scratch || this.scratchKey !== key) {
      this.scratch = createWorld({ id: 'dial', seed }, this.cfg.weatherBias ? { weatherBias: this.cfg.weatherBias } : undefined);
      this.scratchKey = key;
    }
    this.scratch.tick = info.start;
    return forecast(this.scratch, info.length);
  }

  private syncWeather(info: DayInfo): void {
    const key = `${info.start}|${this.cfg.runTicks}|${this.cfg.seed?.() ?? ''}|${this.cfg.weatherBias ?? 0}`;
    if (key === this.weatherKey) return;
    this.weatherKey = key;
    for (const m of this.weatherNodes) m.node.remove();
    this.weatherNodes = [];
    for (const seg of this.segments(info)) {
      const a = Math.max(0, markAt(Math.max(seg.start, info.start), info) ?? 0), b = Math.min(1, markAt(Math.min(seg.end, info.start + info.length), info) ?? 1);
      if (b <= a) continue;
      const [mx, my] = at((a + b) / 2);
      const text = `${seg.kind === 'rain' ? 'Rain' : 'Frost'} · tick ${fmt(seg.start)} to ${fmt(seg.end)}${seg.kind === 'rain' ? ' · crops drink' : ' · tender crops suffer'}`;
      const node = svg('g', { class: `dd-mark dd-${seg.kind}`, tabindex: '0', role: 'img', 'aria-label': text },
        svg('path', { class: 'dd-seg', d: ARC, pathLength: '100', 'stroke-dasharray': `${((b - a) * 100).toFixed(2)} 100`, 'stroke-dashoffset': (-a * 100).toFixed(2) }),
        svg('circle', { class: 'dd-dot', cx: mx.toFixed(1), cy: (my - 9).toFixed(1), r: '3.6' }));
      this.bind(node, text);
      this.marksG.append(node);
      this.weatherNodes.push({ id: `w${seg.start}`, node, text });
    }
  }

  private syncOrders(s: Snapshot, info: DayInfo): void {
    const key = s.orders.map((o) => `${o.id}:${o.deadline}`).join(',');
    if (key === this.lastOrders) return;
    this.lastOrders = key;
    const live = new Set<string>();
    for (const o of s.orders) {
      const p = markAt(o.deadline, info);
      if (p === null) continue;
      const id = `o${o.id}`;
      live.add(id);
      const text = `${fmt(o.qty)} ${CROPS[o.crop]?.name ?? 'crop'} · pays ${fmt(o.reward)} · due tick ${fmt(o.deadline)}`;
      const [x, y] = at(p);
      let m = this.marks.get(id);
      if (!m) {
        const node = svg('g', { class: 'dd-mark dd-order', tabindex: '0', role: 'img' }, svg('line', { y1: '-8', y2: '8' }), svg('circle', { class: 'dd-hit', r: '9' }));
        m = { id, node, text };
        this.bind(node, () => this.marks.get(id)?.text ?? text);
        this.marksG.append(node);
        this.marks.set(id, m);
      }
      m.text = text;
      m.node.setAttribute('aria-label', `Order: ${text}`);
      m.node.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    }
    for (const [id, m] of this.marks) if (!live.has(id)) { m.node.remove(); this.marks.delete(id); }
  }

  private bind(node: SVGGElement, text: string | (() => string)): void {
    const show = (): void => {
      const box = this.root.getBoundingClientRect(), r = node.getBoundingClientRect();
      this.tip.textContent = typeof text === 'function' ? text() : text;
      this.tip.hidden = false;
      const w = this.tip.offsetWidth;
      this.tip.style.left = `${Math.min(Math.max(r.left + r.width / 2 - box.left - w / 2, 0), Math.max(0, box.width - w))}px`;
    };
    const hide = (): void => { this.tip.hidden = true; };
    node.addEventListener('pointerenter', show); node.addEventListener('pointerleave', hide);
    node.addEventListener('focus', show); node.addEventListener('blur', hide);
    node.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') hide(); });
  }

  dispose(): void {
    this.ro?.disconnect();
    window.removeEventListener('resize', this.layout);
    window.removeEventListener('tendril:slate-inset', this.layout);
    window.removeEventListener('transitionend', this.slateMoved, true);
    this.root.remove();
    document.documentElement.style.removeProperty('--dd-bottom');
  }
}

export function mountDayDial(host: HTMLElement): DayDial { return new DayDial(host); }

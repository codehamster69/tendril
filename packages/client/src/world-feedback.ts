import './world-feedback.css';
import { ITEMS } from '@tendril/sim/src/index.ts';
import type { BotDebug, ScriptError } from '@tendril/lang/src/index.ts';
import type { Editor } from './editor';
import type { FarmView } from './farm-view';
import type { Snapshot } from './sim-types';
import { botColour } from './bot-colours';
import { ITEM_COLORS, el } from './palette';
import { BUBBLE_ICON, MAX_FLOATS, bubbleFor, floatCurve, itemGains, pickBubbles, planFloats, type BubbleKind, type FeedbackEvent, type FloatSpec } from './feedback-core';
import { motionQuery } from './settings';

const FLOAT_MS = 1100;
const TIP_MS = 6000;
const COIN_COLOUR = 'var(--carrot)';

interface Float { node: HTMLElement; x: number; z: number; born: number; free: boolean }

const BUBBLE_TEXT: Record<BubbleKind, string> = { error: 'Stopped on an error', blocked: 'Stopped at a breakpoint', waiting: 'Waiting' };

/**
 * Everything that tells the player what a bot just did without opening a panel: floating +numbers on harvest and sale, status
 * bubbles over bots that wait, stop or fail, the coin chip pulse, and the link between a bot and its line in the editor.
 * All DOM, pooled, and driven by its own animation frame that runs only while something is on screen.
 */
export function mountWorldFeedback(o: { view: FarmView; editor: Editor }): void {
  const { view, editor } = o;
  const stage = document.getElementById('farm-stage');
  if (!stage) return;
  const reduced = motionQuery;
  const layer = el('div', { class: 'wf-layer' });
  const tip = el('div', { class: 'wf-tip hk-card', role: 'status', hidden: '' });
  layer.append(tip);
  stage.append(layer);

  // ---- state kept from the game loop's events
  let prev: Snapshot | null = null, last: Snapshot | null = null;
  let debug: BotDebug[] = [];
  const errors = new Map<number, ScriptError>();
  let selected: number | null = null;

  // ---- floating numbers
  const pool: Float[] = [];
  for (let i = 0; i < MAX_FLOATS; i++) {
    const node = el('span', { class: 'wf-float' });
    node.hidden = true;
    layer.append(node);
    pool.push({ node, x: 0, z: 0, born: 0, free: true });
  }
  const spawn = (spec: FloatSpec, now: number): void => {
    const at = view.botPosition(spec.bot) ?? view.botPosition(0);
    if (!at) return;
    let f = pool.find((p) => p.free);
    if (!f) f = pool.reduce((a, b) => (a.born <= b.born ? a : b));
    f.free = false; f.x = at.x; f.z = at.z; f.born = now;
    f.node.textContent = spec.text;
    f.node.style.setProperty('--wf-colour', spec.kind === 'coin' ? COIN_COLOUR : ITEM_COLORS[spec.item] ?? COIN_COLOUR);
    f.node.hidden = false;
  };

  // ---- bubbles
  const bubbles = new Map<number, { node: HTMLButtonElement; kind: BubbleKind; line: number | null }>();
  let tipFor: number | null = null, tipTimer = 0;
  const messageFor = (bot: number, kind: BubbleKind, line: number | null): string => {
    const e = errors.get(bot);
    const where = line ? ` on line ${line}` : '';
    if (kind === 'error') return `Bot ${bot}${where}: ${e?.message ?? BUBBLE_TEXT.error}`;
    return `Bot ${bot}${where}: ${BUBBLE_TEXT[kind]}`;
  };
  const hideTip = (): void => { tip.hidden = true; tipFor = null; clearTimeout(tipTimer); };
  const showTip = (bot: number): void => {
    const b = bubbles.get(bot);
    if (!b) return;
    tip.textContent = messageFor(bot, b.kind, b.line);
    tip.hidden = false; tipFor = bot;
    clearTimeout(tipTimer);
    tipTimer = window.setTimeout(hideTip, TIP_MS);
    kick();
  };
  const syncBubbles = (): void => {
    const states: { bot: number; kind: BubbleKind }[] = [];
    debug.forEach((d) => {
      const kind = bubbleFor({ status: d.status, line: d.line, op: last?.bots[d.bot]?.op ?? null });
      if (kind) states.push({ bot: d.bot, kind });
    });
    const want = new Map(pickBubbles(states).map((s) => [s.bot, s.kind]));
    for (const [bot, b] of bubbles) if (!want.has(bot)) { b.node.remove(); bubbles.delete(bot); if (tipFor === bot) hideTip(); }
    for (const [bot, kind] of want) {
      const line = debug.find((d) => d.bot === bot)?.line ?? errors.get(bot)?.line ?? null;
      let b = bubbles.get(bot);
      if (!b) {
        const node = el('button', { class: 'wf-bubble', type: 'button' });
        node.addEventListener('click', () => {
          const cur = bubbles.get(bot);
          view.selectBot(bot);
          if (cur?.line) editor.revealLine(cur.line);
          showTip(bot);
        });
        layer.append(node);
        b = { node, kind, line };
        bubbles.set(bot, b);
      }
      b.kind = kind; b.line = line;
      b.node.dataset.kind = kind;
      b.node.textContent = BUBBLE_ICON[kind];
      b.node.style.setProperty('--wf-bot', botColour(bot));
      b.node.setAttribute('aria-label', messageFor(bot, kind, line));
      if (tipFor === bot) tip.textContent = messageFor(bot, kind, line);
    }
    if (bubbles.size) kick();
  };

  // ---- frame: reproject everything that floats over the world
  let raf = 0;
  const frame = (now: number): void => {
    raf = 0;
    const calm = reduced.matches;
    let live = 0;
    for (const f of pool) {
      if (f.free) continue;
      const age = now - f.born;
      if (age >= (calm ? FLOAT_MS * 0.7 : FLOAT_MS)) { f.free = true; f.node.hidden = true; continue; }
      const p = view.project(f.x, f.z, 1.1);
      const { rise, opacity } = floatCurve(age / (calm ? FLOAT_MS * 0.7 : FLOAT_MS), calm);
      if (!p?.visible) { f.node.style.opacity = '0'; live++; continue; }
      f.node.style.transform = `translate(${p.x.toFixed(1)}px, ${(p.y - rise).toFixed(1)}px) translate(-50%, -100%)`;
      f.node.style.opacity = opacity.toFixed(2);
      live++;
    }
    for (const [bot, b] of bubbles) {
      const at = view.botPosition(bot);
      const p = at ? view.project(at.x, at.z, 1.5) : null;
      b.node.hidden = !p?.visible;
      if (p?.visible) b.node.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
      if (tipFor === bot && p?.visible) tip.style.transform = `translate(${p.x.toFixed(1)}px, ${(p.y - 30).toFixed(1)}px) translate(-50%, -100%)`;
    }
    if (live || bubbles.size || !tip.hidden) raf = requestAnimationFrame(frame);
  };
  const kick = (): void => { if (!raf) raf = requestAnimationFrame(frame); };

  // ---- coin chip pulse
  const pulse = (): void => {
    if (reduced.matches) return;
    const chip = document.getElementById('chip-coins')?.closest<HTMLElement>('.hk-chip');
    if (!chip) return;
    chip.classList.remove('wf-pulse');
    void chip.offsetWidth; // restart the animation when coins change twice in a row
    chip.classList.add('wf-pulse');
  };

  // ---- game loop events
  window.addEventListener('tendril:snapshot', (e) => {
    prev = last;
    last = (e as CustomEvent<Snapshot>).detail;
    if (prev && last.coins !== prev.coins) pulse();
  });
  window.addEventListener('tendril:events', (e) => {
    const events = (e as CustomEvent<FeedbackEvent[]>).detail;
    if (!events.length || document.hidden) return;
    const orders = prev?.orders ?? [];
    const specs = planFloats(events, {
      gained: (bot) => itemGains(prev?.bots[bot]?.items, last?.bots[bot]?.items),
      itemName: (i) => ITEMS[i]?.name ?? 'item',
      saleValue: (item, units) => (ITEMS[item]?.price ?? 0) * units,
      orderReward: (id) => orders.find((x) => x.id === id)?.reward ?? null,
    });
    const now = performance.now();
    for (const s of specs) spawn(s, now);
    if (specs.length) kick();
  });
  window.addEventListener('tendril:debug', (e) => {
    debug = (e as CustomEvent<{ bots: BotDebug[] }>).detail.bots;
    syncBubbles();
  });
  window.addEventListener('tendril:errors', (e) => {
    for (const err of (e as CustomEvent<ScriptError[]>).detail) if (err.bot >= 0) errors.set(err.bot, err);
  });
  window.addEventListener('tendril:notice', (e) => {
    if ((e as CustomEvent<{ kind: string }>).detail.kind === 'clear') { errors.clear(); hideTip(); }
  });

  // ---- bot <-> line links
  const lineOf = (bot: number): number | null => debug.find((d) => d.bot === bot)?.line ?? null;
  stage.addEventListener('tendril:bot', (e) => {
    selected = (e as CustomEvent<{ bot: number | null }>).detail.bot;
    editor.setSelectedBot(selected);
    const line = selected === null ? null : lineOf(selected);
    if (line) editor.revealLine(line, { focus: false });
  });
  editor.onBotMarkClick((bot) => view.selectBot(bot));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !tip.hidden) hideTip(); });
}

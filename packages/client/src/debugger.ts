import type { BotDebug } from '@tendril/lang/src/index.ts';
import { BOT_COLORS } from './editor';
import { el } from './palette';

export function mountDebugger(): void {
  const host = document.getElementById('debugger')!;
  window.addEventListener('tendril:debug', (event) => {
    const { bots, paused } = (event as CustomEvent<{ bots: BotDebug[]; paused: { bot: number; line: number } | null }>).detail;
    const grid = el('div', { class: 'bots' });
    for (const b of bots) {
      const name = el('span', { text: `Bot ${b.bot}` });
      name.style.color = BOT_COLORS[b.bot % BOT_COLORS.length]!;
      const vars = el('dl');
      for (const v of b.vars.slice(0, 40)) vars.append(el('dt', { text: v.name }), el('dd', { text: v.value, title: v.value }));
      if (!b.vars.length) vars.append(el('dt', { text: '—' }), el('dd', { class: 'muted', text: 'no variables yet' }));
      const stack = el('div', { class: 'stack', text: b.stack.length ? b.stack.map((f) => `${f.fn}:${f.line}`).join(' ← ') : '' });
      grid.append(el('section', { class: `bot${paused?.bot === b.bot ? ' paused' : ''}` },
        el('header', {}, name, el('span', { class: 'status', text: `${b.status}${b.line ? ` · line ${b.line}` : ''}` })), vars, stack));
    }
    host.replaceChildren(grid);
  });
}

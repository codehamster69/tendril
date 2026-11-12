import type { OutputLine, ScriptError } from '@tendril/lang/src/index.ts';
import type { Editor } from './editor';
import { BOT_COLORS } from './editor';
import type { Notice } from './game-loop';

const MAX_LINES = 600;

/** The program console: printed output, notices, compile diagnostics and per-bot runtime errors. */
export function mountConsole(editor: Pick<Editor, 'revealLine'>): void {
  const host = document.getElementById('console')!;
  const append = (kind: 'out' | 'err' | 'info', tick: number, bot: number, text: string, jump?: number): void => {
    const row = document.createElement('div');
    row.className = `line ${kind}`;
    const when = document.createElement('span');
    when.className = 'tick';
    when.textContent = tick.toLocaleString();
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = bot >= 0 ? `bot ${bot}` : '·';
    if (bot >= 0) who.style.color = BOT_COLORS[bot % BOT_COLORS.length]!;
    const body = document.createElement('span');
    body.className = 'text';
    body.textContent = text;
    row.append(when, who, body);
    if (jump) {
      row.classList.add('jump');
      row.title = `Go to line ${jump}`;
      row.addEventListener('click', () => editor.revealLine(jump));
    }
    const atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 8;
    host.appendChild(row);
    while (host.childElementCount > MAX_LINES) host.firstElementChild!.remove();
    if (atBottom) host.scrollTop = host.scrollHeight;
  };
  window.addEventListener('tendril:notice', (event) => {
    const n = (event as CustomEvent<Notice>).detail;
    if (n.kind === 'clear') host.replaceChildren();
    else append(n.kind, n.tick, n.bot ?? -1, n.text, n.line);
  });
  window.addEventListener('tendril:output', (event) => {
    for (const line of (event as CustomEvent<OutputLine[]>).detail) append('out', line.tick, line.bot, line.text);
  });
  window.addEventListener('tendril:errors', (event) => {
    for (const e of (event as CustomEvent<ScriptError[]>).detail) {
      append('err', e.tick, e.bot, `${e.bot < 0 ? 'Program' : `Bot ${e.bot}`} · line ${e.line}: ${e.message}`, e.line);
    }
  });
}

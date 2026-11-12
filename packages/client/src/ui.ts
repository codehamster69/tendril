import type { BotDebug, Diagnostic, ScriptError } from '@tendril/lang/src/index.ts';
import type { Editor } from './editor';
import type { GameLoop, LoopStatus } from './game-loop';
import type { Snapshot } from './sim-types';

type Listen = <T>(name: string, cb: (detail: T) => void) => void;
const listen: Listen = (name, cb) => window.addEventListener(`tendril:${name}`, (event) => cb((event as CustomEvent).detail));
const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Wires the toolbar, HUD, status bar and editor seam to the loop. The loop itself never touches the DOM. */
export function mountControls({ loop, editor }: { loop: GameLoop; editor: Editor }): void {
  const run = byId<HTMLButtonElement>('btn-run'), pause = byId<HTMLButtonElement>('btn-pause');
  const reset = byId<HTMLButtonElement>('btn-reset'), step = byId<HTMLButtonElement>('btn-step');
  const stepLine = byId<HTMLButtonElement>('btn-step-line'), speed = byId<HTMLSelectElement>('speed');
  const live = loop.mode === 'live';
  const failed = (e: unknown): void => { console.warn(e instanceof Error ? e.message : e); };

  loop.sourceProvider = () => editor.getSource();
  run.addEventListener('click', () => loop.run());
  pause.addEventListener('click', () => { void loop.pause().catch(failed); });
  reset.addEventListener('click', () => {
    if (live && !window.confirm('Reset this live farm? This permanently replaces its saved farm and action history. Your program stays in the editor.')) return;
    void loop.reset();
  });
  step.addEventListener('click', () => { void loop.step(100); });
  stepLine.addEventListener('click', () => { void loop.stepLine(); });
  step.hidden = stepLine.hidden = live;
  speed.addEventListener('change', () => loop.setSpeed(Number(speed.value)));
  loop.setSpeed(Number(speed.value));
  if (live) { // A live farm follows the real clock, so a speed choice would do nothing there.
    speed.hidden = speed.disabled = true;
    byId('speed-label').textContent = 'Live farms run in real time';
  }

  editor.onRun(() => loop.run());
  editor.onStepLine(() => { void loop.stepLine(); });
  editor.onBreakpointsChange((lines) => { void loop.setBreakpoints(lines); });

  listen<string>('source', (text) => editor.setSource(text));
  listen<Diagnostic[]>('diagnostics', (d) => {
    editor.setDiagnostics(d);
    if (!d.some((x) => x.severity === 'error')) editor.setErrors([]);
  });
  listen<ScriptError[]>('errors', (e) => editor.setErrors(e));
  listen<{ bots: BotDebug[]; paused: { bot: number; line: number } | null }>('debug', ({ bots, paused }) => editor.showBotLines(bots, paused));
  listen<[number, number][]>('heat', (heat) => editor.showHeat(heat));

  const hud = { tick: byId('hud-tick'), coins: byId('hud-coins'), net: byId('hud-networth'), weather: byId('hud-weather') };
  listen<Snapshot>('snapshot', (s) => {
    hud.tick.textContent = String(s.tick);
    hud.coins.textContent = s.coins.toLocaleString();
    hud.net.textContent = s.netWorth.toLocaleString();
    hud.weather.textContent = s.weather;
    hud.weather.dataset.weather = s.weather;
  });

  const status = byId('status'), saved = byId('save-status');
  listen<LoopStatus>('status', (s) => {
    status.dataset.state = s.state;
    status.textContent = s.message;
    saved.textContent = s.save;
    run.disabled = !s.canRun;
    run.classList.toggle('is-running', s.running);
    pause.disabled = !s.canPause;
    reset.disabled = !s.canReset;
    step.disabled = !s.canStep;
    stepLine.disabled = !s.canStep;
    pause.setAttribute('aria-pressed', String(!s.running));
  });
}

import type { SimSource } from './sim-types';
import type { FarmView } from './farm-view';
import type { Editor } from './editor';

const TICKS_PER_SECOND = 10;
const MAX_TICKS_PER_FRAME = 2000;
const MAX_LINES = 500;

export class GameLoop {
  private running = false;
  private acc = 0;
  private last = 0;
  private speed = 1;
  private loaded = false;
  private el = {
    tick: document.getElementById('hud-tick')!,
    coins: document.getElementById('hud-coins')!,
    net: document.getElementById('hud-networth')!,
    weather: document.getElementById('hud-weather')!,
    console: document.getElementById('console')!,
  };

  constructor(private sim: SimSource, private view: FarmView, private editor: Editor) {
    document.getElementById('btn-run')!.addEventListener('click', () => void this.run());
    document.getElementById('btn-pause')!.addEventListener('click', () => { this.running = false; });
    document.getElementById('btn-reset')!.addEventListener('click', () => void this.reset());
    const speed = document.getElementById('speed') as HTMLSelectElement;
    speed.addEventListener('change', () => { this.speed = Number(speed.value); });
    this.speed = Number(speed.value);
    this.render();
    requestAnimationFrame(this.frame);
  }

  private async run(): Promise<void> {
    if (!this.loaded) {
      await this.sim.load(this.editor.getSource());
      this.loaded = true;
    }
    this.last = performance.now();
    this.running = true;
  }

  private async reset(): Promise<void> {
    this.running = false;
    this.acc = 0;
    await this.sim.reset();
    this.loaded = false;
    this.el.console.textContent = '';
    this.editor.setMarkers([]);
    this.render();
  }

  private frame = (now: number): void => {
    if (this.running) {
      this.acc += ((now - this.last) / 1000) * TICKS_PER_SECOND * this.speed;
      const n = Math.min(MAX_TICKS_PER_FRAME, Math.floor(this.acc));
      this.acc -= Math.floor(this.acc);
      if (n > 0) this.sim.step(n);
    }
    this.last = now;
    if (this.running) this.render();
    requestAnimationFrame(this.frame);
  };

  private render(): void {
    const s = this.sim.snapshot();
    this.view.update(s);
    this.el.tick.textContent = String(s.tick);
    this.el.coins.textContent = String(s.coins);
    this.el.net.textContent = String(s.netWorth);
    this.el.weather.textContent = s.weather;
    const lines = this.sim.drainOutput();
    const errors = this.sim.drainErrors();
    if (lines.length || errors.length) {
      for (const l of lines) this.append(l, false);
      for (const e of errors) this.append(`[bot ${e.bot}] ${e.message}`, true);
      if (errors.length) this.editor.setMarkers(errors);
      const c = this.el.console;
      while (c.childElementCount > MAX_LINES) c.firstElementChild!.remove();
      c.scrollTop = c.scrollHeight;
    }
  }

  private append(text: string, isErr: boolean): void {
    const d = document.createElement('div');
    d.textContent = text;
    if (isErr) d.className = 'err';
    this.el.console.appendChild(d);
  }
}

import type { Snapshot } from './sim-types';
import { targetTick, TICKS_PER_SECOND } from './clock';
import type { RealSim } from './real-sim';
import type { FarmView } from './farm-view';
import { BOT_COLORS, type Editor } from './editor';
import type { OutputLine, SimError } from './sim-protocol';

const MAX_TICKS_PER_FRAME = 2000;
const MAX_LINES = 600;
const emit = (name: string, detail: unknown): void => { window.dispatchEvent(new CustomEvent(`tendril:${name}`, { detail })); };

export class GameLoop {
  running = false;
  speed = 1;
  private acc = 0;
  private last = 0;
  private loaded = false;
  private changing = false;
  private actionBusy = false;
  private pausing = 0;
  private intent = 0;
  private rendered: Snapshot | null = null;
  private compiled = '';
  private compileFailed = false;
  private ended = false;
  private error: string | null = null;
  private progress: { done: number; total: number } | null = null;
  private raf = 0;
  private el = {
    tick: document.getElementById('hud-tick')!,
    coins: document.getElementById('hud-coins')!,
    net: document.getElementById('hud-networth')!,
    weather: document.getElementById('hud-weather')!,
    console: document.getElementById('console')!,
    status: document.getElementById('status')!,
    saved: document.getElementById('save-status')!,
    run: document.getElementById('btn-run') as HTMLButtonElement,
    pause: document.getElementById('btn-pause') as HTMLButtonElement,
    reset: document.getElementById('btn-reset') as HTMLButtonElement,
    step: document.getElementById('btn-step') as HTMLButtonElement,
    stepLine: document.getElementById('btn-step-line') as HTMLButtonElement,
  };

  constructor(readonly sim: RealSim, private view: FarmView, private editor: Editor) {
    this.el.run.addEventListener('click', () => this.run());
    this.el.pause.addEventListener('click', () => { void this.pause().catch((e: unknown) => this.showError(e)); });
    this.el.reset.addEventListener('click', () => this.action(() => this.reset()));
    this.el.step.addEventListener('click', () => this.action(() => this.step()));
    this.el.stepLine.addEventListener('click', () => this.action(() => this.stepLine()));
    editor.onRun(() => this.run());
    editor.onStepLine(() => this.action(() => this.stepLine()));
    editor.onBreakpointsChange((lines) => { void this.sim.setBreakpoints(lines).catch(() => {}); });
    const speed = document.getElementById('speed') as HTMLSelectElement;
    speed.addEventListener('change', () => this.setSpeed(Number(speed.value)));
    this.setSpeed(Number(speed.value));
    const clocked = sim.mode === 'live';
    this.el.step.hidden = clocked;
    this.el.stepLine.hidden = clocked;
    this.sim.onProgress = (done, total) => { this.progress = { done, total }; this.updateStatus(); };
    this.updateStatus();
  }

  get mode(): string { return this.sim.mode; }

  setSpeed(n: number): void { this.speed = Number.isFinite(n) ? Math.min(64, Math.max(1, n)) : 1; }

  async init(): Promise<void> {
    try {
      this.compiled = this.editor.getSource();
      await this.sim.init(this.compiled);
      await this.sim.setBreakpoints(this.editor.breakpoints());
      this.loaded = true;
      this.afterCompile();
      this.render();
      if (this.sim.mode === 'live' && !this.compileFailed) this.resume();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
      throw e;
    } finally {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
      this.updateStatus();
    }
  }

  snapshot(): Snapshot | null { return this.sim.latest(); }
  debug() { return this.sim.debug; }
  logChunks() { return this.sim.logChunks(); }

  run(): void {
    this.action(async () => {
      const version = ++this.intent;
      if (this.editor.getSource() !== this.compiled || this.compileFailed) await this.compile(this.editor.getSource());
      if (version === this.intent && !this.compileFailed) this.resume();
    });
  }

  pause(): Promise<void> {
    ++this.intent;
    return this.halt();
  }

  private async halt(): Promise<void> {
    this.running = false;
    this.acc = 0;
    this.pausing++;
    const saveFailure = this.sim.persistenceError;
    this.updateStatus();
    try {
      if (this.sim.latest()) await this.sim.flush();
      this.render();
      if (saveFailure && !this.sim.persistenceError && this.error === saveFailure) this.error = null;
    } finally {
      this.pausing--;
      this.updateStatus();
    }
  }

  resume(): void {
    if (!this.loaded || this.changing || this.sim.persistenceError || this.ended) return;
    this.error = null;
    this.last = performance.now();
    this.acc = 0;
    this.running = true;
    this.updateStatus();
  }

  /** Compile against the current world; this never creates a new farm. A broken program never replaces a working one. */
  async setSource(source: string) {
    ++this.intent;
    await this.compile(source);
    return this.sim.diagnostics;
  }

  private async compile(source: string): Promise<void> {
    await this.halt();
    this.changing = true;
    this.error = null;
    this.updateStatus();
    try {
      this.editor.setSource(source);
      this.editor.setErrors([]);
      await this.sim.setSource(source);
      this.afterCompile();
      if (!this.compileFailed) {
        this.compiled = source;
        this.append({ bot: -1, tick: this.snapshot()?.tick ?? 0, text: `Program loaded at tick ${this.snapshot()?.tick ?? 0}. Every bot restarts from the top; the farm is kept.` }, 'info');
      }
      this.render();
    } finally {
      this.changing = false;
      this.updateStatus();
    }
  }

  private afterCompile(): void {
    const d = this.sim.diagnostics;
    this.editor.setDiagnostics(d);
    emit('diagnostics', d);
    const errors = d.filter((x) => x.severity === 'error');
    this.compileFailed = errors.length > 0;
    for (const x of errors) {
      this.append({ bot: -1, tick: this.snapshot()?.tick ?? 0, text: `Line ${x.line}: ${x.message}` }, 'err', x.line);
    }
    if (this.compileFailed) this.append({ bot: -1, tick: this.snapshot()?.tick ?? 0, text: 'Your program was not started. Fix the marked lines and press Run.' }, 'err');
  }

  async step(): Promise<void> {
    if (this.sim.mode === 'live') return;
    await this.pause();
    if (this.editor.getSource() !== this.compiled || this.compileFailed) await this.compile(this.editor.getSource());
    if (this.compileFailed) return;
    this.sim.requestStep(100);
    await this.sim.flush();
    this.render();
  }

  async stepLine(): Promise<void> {
    if (this.sim.mode === 'live') return;
    await this.pause();
    if (this.editor.getSource() !== this.compiled || this.compileFailed) await this.compile(this.editor.getSource());
    if (this.compileFailed) return;
    await this.sim.stepLine();
    this.render();
  }

  async reset(): Promise<void> {
    if (this.sim.mode === 'live' && !window.confirm('Reset this live farm? This permanently replaces its saved farm and action history. Your program stays in the editor.')) return;
    ++this.intent;
    await this.pause();
    this.changing = true;
    this.error = null;
    this.ended = false;
    this.updateStatus();
    try {
      this.compiled = this.editor.getSource();
      await this.sim.reset(this.compiled);
      this.loaded = true;
      this.el.console.replaceChildren();
      this.afterCompile();
      this.append({ bot: -1, tick: 0, text: 'Fresh farm ready. Press Run when you are.' }, 'info');
      this.render();
    } finally {
      this.changing = false;
      this.updateStatus();
    }
  }

  dispose(): void { this.running = false; cancelAnimationFrame(this.raf); }

  private action(job: () => Promise<void>): void {
    if (this.actionBusy) return;
    this.actionBusy = true;
    void job().catch((e: unknown) => this.showError(e)).finally(() => {
      this.actionBusy = false;
      this.updateStatus();
    });
    this.updateStatus();
  }

  private showError(e: unknown): void {
    this.running = false;
    this.error = e instanceof Error ? e.message : String(e);
    this.render();
    this.updateStatus();
  }

  private frame = (now: number): void => {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    if (this.running && !this.changing) {
      const rate = this.sim.mode === 'live' ? 200 : TICKS_PER_SECOND;
      this.acc = Math.min(MAX_TICKS_PER_FRAME, this.acc + elapsed * rate * this.speed);
      if (!this.sim.busy) {
        let n = Math.floor(this.acc);
        if (this.sim.mode === 'live') n = Math.min(n, Math.max(0, targetTick(this.sim.meta, Date.now()) - (this.snapshot()?.tick ?? 0)));
        if (n > 0) { this.acc -= n; this.sim.requestStep(n); }
      }
    }
    this.render();
    this.updateStatus();
    this.raf = requestAnimationFrame(this.frame);
  };

  private render(): void {
    const s = this.snapshot();
    if (s && s !== this.rendered) {
      this.rendered = s;
      this.progress = null;
      this.view.update(s);
      this.el.tick.textContent = s.tick.toLocaleString();
      this.el.coins.textContent = s.coins.toLocaleString();
      this.el.net.textContent = s.netWorth.toLocaleString();
      this.el.weather.textContent = s.weather;
      this.el.weather.dataset.weather = s.weather;
      emit('snapshot', s);
      if (this.sim.paused) {
        this.running = false;
        const p = this.sim.paused;
        this.append({ bot: p.bot, tick: s.tick, text: `Paused at breakpoint, line ${p.line}. Step line (F10) or Run to continue.` }, 'info', p.line);
      }
      this.editor.showBotLines(this.sim.debug, this.sim.paused);
      this.editor.showHeat(this.sim.heat);
      emit('debug', { bots: this.sim.debug, paused: this.sim.paused });
      emit('heat', this.sim.heat);
      const limit = this.sim.scenario.tickLimit;
      if (limit !== undefined && s.tick >= limit && !this.ended) {
        this.ended = true;
        this.running = false;
        emit('scenario-end', { snapshot: s, log: this.sim.logChunks() });
      }
    }
    const lines = this.sim.drainOutput();
    const errors = this.sim.drainErrors();
    if (lines.length) emit('output', lines);
    for (const line of lines) this.append(line, 'out');
    if (errors.length) {
      emit('errors', errors);
      const script = errors.filter((e) => !e.kind || e.kind === 'script');
      if (script.length) this.editor.setErrors(script);
      for (const e of errors) {
        if (e.kind && e.kind !== 'script') { this.error = e.message; this.running = false; }
        this.appendError(e);
      }
    }
  }

  private updateStatus(): void {
    let state = 'paused';
    let text = this.sim.mode === 'live' ? 'Paused · the farm clock keeps counting. Run to catch up.' : 'Paused · edit your program, run, or step.';
    if (this.error || this.sim.persistenceError) { state = 'error'; text = this.error ?? this.sim.persistenceError!; }
    else if (this.compileFailed) { state = 'error'; text = 'Program has errors. Fix the marked lines, then Run.'; }
    else if (this.ended) { state = 'paused'; text = 'Challenge finished · see your results.'; }
    else if (this.sim.paused && !this.running) { state = 'paused'; text = `Breakpoint · bot ${this.sim.paused.bot} on line ${this.sim.paused.line}`; }
    else if (this.pausing > 0) { state = 'pausing'; text = 'Pausing · finishing the current batch and saving…'; }
    else if (this.changing) { state = 'compiling'; text = 'Loading your program onto the bots…'; }
    else if (!this.loaded) { state = 'loading'; text = 'Loading your farm…'; }
    else if (this.running) {
      const debt = this.sim.mode === 'live' ? Math.max(0, targetTick(this.sim.meta, Date.now()) - (this.snapshot()?.tick ?? 0)) : 0;
      state = debt > 10 ? 'catching-up' : 'running';
      text = debt > 10 ? `Catching up · ${debt.toLocaleString()} ticks behind` : this.sim.mode === 'live' ? 'Live · 10 ticks per second' : `Running · ${this.speed}× speed`;
      if (this.progress) text += ` · ${this.progress.done}/${this.progress.total}`;
    } else if (this.sim.busy) { state = 'pausing'; text = 'Saving…'; }
    this.el.status.dataset.state = state;
    this.el.status.textContent = text;
    this.el.saved.textContent = this.sim.persistenceError ? 'Save failed · keep window open' : this.sim.busy ? 'Saving on this device…' : this.sim.durableTick !== null ? `Saved · tick ${this.sim.durableTick.toLocaleString()}` : 'Not saved yet';
    this.el.run.disabled = !this.loaded || this.changing || this.actionBusy || this.ended;
    this.el.run.classList.toggle('is-running', this.running);
    this.el.pause.disabled = !this.loaded;
    this.el.reset.disabled = this.changing || this.actionBusy || (!this.loaded && !this.error);
    this.el.step.disabled = !this.loaded || this.changing || this.sim.busy || this.actionBusy || this.ended;
    this.el.stepLine.disabled = this.el.step.disabled;
    this.el.pause.setAttribute('aria-pressed', String(!this.running));
    emit('status', { running: this.running, mode: this.sim.mode, tick: this.snapshot()?.tick ?? 0, durableTick: this.sim.durableTick, message: text, state });
  }

  private appendError(e: SimError): void {
    const who = e.kind === 'storage' ? 'Save' : e.kind === 'worker' ? 'Engine' : e.bot < 0 ? 'Program' : `Bot ${e.bot}`;
    this.append({ bot: e.bot, tick: e.tick ?? this.snapshot()?.tick ?? 0, text: `${who}${e.line ? ` · line ${e.line}` : ''}: ${e.message}` }, 'err', e.line);
  }

  private append(line: OutputLine, kind: 'out' | 'err' | 'info', jump?: number): void {
    const row = document.createElement('div');
    row.className = `line ${kind}`;
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = line.tick.toLocaleString();
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = line.bot >= 0 ? `bot ${line.bot}` : '·';
    if (line.bot >= 0) who.style.color = BOT_COLORS[line.bot % BOT_COLORS.length]!;
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = line.text;
    row.append(tick, who, text);
    if (jump) {
      row.classList.add('jump');
      row.title = `Go to line ${jump}`;
      row.addEventListener('click', () => this.editor.revealLine(jump));
    }
    const atBottom = this.el.console.scrollTop + this.el.console.clientHeight >= this.el.console.scrollHeight - 8;
    this.el.console.appendChild(row);
    while (this.el.console.childElementCount > MAX_LINES) this.el.console.firstElementChild!.remove();
    if (atBottom) this.el.console.scrollTop = this.el.console.scrollHeight;
  }
}

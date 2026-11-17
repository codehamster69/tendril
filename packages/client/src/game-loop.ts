import type { Snapshot } from './sim-types';
import { targetTick, TICKS_PER_SECOND } from './clock';
import { LEAN_BEHIND_TICKS, type CatchUp, type RealSim } from './real-sim';
import type { BotDebug, Diagnostic, Scenario, SimError } from './sim-protocol';

const MAX_TICKS_PER_FRAME = 2000;
/** "41% · about 2 min left", from the catch-up's own numbers. */
export function catchUpText(c: CatchUp): string {
  const pct = Math.min(99, Math.max(0, Math.floor((1 - c.behind / c.startBehind) * 100)));
  return `${pct}%${c.etaSeconds === null ? '' : ` · ${formatEta(c.etaSeconds)}`}`;
}
export function formatEta(sec: number): string {
  if (sec < 10) return 'a few seconds left';
  if (sec < 90) return `about ${Math.round(sec / 5) * 5} s left`;
  if (sec < 5400) return `about ${Math.round(sec / 60)} min left`;
  return `about ${(sec / 3600).toFixed(1)} h left`;
}
const emit = (name: string, detail: unknown): void => { window.dispatchEvent(new CustomEvent(`tendril:${name}`, { detail })); };

/** Human-facing messages for the console. `clear` empties it (new farm). */
export interface Notice { kind: 'info' | 'err' | 'clear'; text: string; tick: number; bot?: number; line?: number }
export interface LoopStatus {
  running: boolean; mode: string; tick: number; durableTick: number | null; message: string; state: string;
  /** A long catch-up in progress (lean mode), else null. */
  catchUp: CatchUp | null;
  save: string; canRun: boolean; canPause: boolean; canStep: boolean; canReset: boolean; paused: { bot: number; line: number } | null;
}

/** DOM-free game clock. It talks to the worker through RealSim and to the UI through `tendril:*` window events. */
export class GameLoop {
  running = false;
  speed = 1;
  /** The editor registers itself here so Run, Step and Reset always use the text on screen. */
  sourceProvider: (() => string) | null = null;
  private source = '';
  private acc = 0;
  private last = 0;
  private loaded = false;
  private changing = false;
  private actionBusy = false;
  private pausing = 0;
  /** While a resume is in flight the worker still reports the old pause; such a snapshot must not cancel the Run just pressed. */
  private resuming = 0;
  private intent = 0;
  private rendered: Snapshot | null = null;
  private compiled = '';
  private compileFailed = false;
  private scriptErrored = false;
  private hasProgram = false;
  private breakpoints: number[] = [];
  private ended = false;
  private error: string | null = null;
  private progress: { done: number; total: number } | null = null;
  private lastStatus = '';
  private pauseKey = '';
  private raf = 0;
  private lastSnapAt = 0;

  constructor(readonly sim: RealSim) {
    this.sim.onProgress = (done, total) => { this.progress = { done, total }; this.updateStatus(); };
  }

  get mode(): string { return this.sim.mode; }

  setSpeed(n: number): void { this.speed = Number.isFinite(n) ? Math.min(64, Math.max(1, Math.trunc(n))) : 1; }

  async init(scenario?: Scenario, source?: string): Promise<void> {
    try {
      if (scenario) this.sim.scenario = scenario;
      this.compiled = this.source = source ?? this.current();
      await this.sim.init(this.compiled);
      await this.sim.setBreakpoints(this.breakpoints);
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
  debug(): BotDebug[] { return this.sim.debug; }
  logChunks() { return this.sim.logChunks(); }
  /** Action kinds seen so far: a cheap stand-in for scanning the whole log on every frame. */
  opKinds() { return this.sim.opKinds(); }
  get busy(): boolean { return this.actionBusy || this.changing; }
  /** The program the farm runs now (null before the first program loads). */
  get runningSource(): string | null { return this.hasProgram ? this.compiled : null; }

  private current(): string { return this.sourceProvider ? this.sourceProvider() : this.source; }
  private stale(): boolean { return this.current() !== this.compiled || this.compileFailed || this.scriptErrored; }

  run(): void {
    this.action(async () => {
      const version = ++this.intent;
      if (this.stale()) await this.compile(this.current());
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
    if (this.sim.paused) { // Finish the tick a breakpoint or line step interrupted.
      this.resuming++;
      void this.sim.resume().catch(() => {}).finally(() => { this.resuming--; this.rendered = null; /* look again: the worker may have stopped at another breakpoint */ });
    }
    this.updateStatus();
  }

  /** Compile against the current world; never creates a new farm. Errors are returned and the old program keeps running. */
  async setSource(source: string): Promise<Diagnostic[]> {
    const wasRunning = this.running;
    ++this.intent;
    this.source = source;
    await this.compile(source);
    if (wasRunning && this.compileFailed && this.hasProgram) this.resume();
    return this.sim.diagnostics;
  }

  setBreakpoints(lines: number[]): Promise<void> {
    this.breakpoints = [...lines];
    return this.loaded ? this.sim.setBreakpoints(this.breakpoints).catch(() => {}) : Promise.resolve();
  }

  private async compile(source: string): Promise<void> {
    const wasRunning = this.running;
    await this.halt();
    this.changing = true;
    this.error = null;
    this.updateStatus();
    try {
      emit('source', source);
      await this.sim.setSource(source);
      this.afterCompile(wasRunning);
      if (!this.compileFailed) {
        this.compiled = source;
        this.scriptErrored = false;
        this.hasProgram = true;
        this.notice('info', `Program loaded at tick ${this.snapshot()?.tick ?? 0} · every bot restarts from the top · farm kept.`);
      } else if (wasRunning && this.hasProgram) {
        this.notice('info', 'Your previous program is still running. Fix the marked lines to apply your changes.');
      }
      this.render();
    } finally {
      this.changing = false;
      this.updateStatus();
    }
  }

  private afterCompile(keepRunning = false): void {
    const d = this.sim.diagnostics;
    emit('diagnostics', d);
    const errors = d.filter((x) => x.severity === 'error');
    this.compileFailed = errors.length > 0;
    if (!this.compileFailed && this.loaded) this.hasProgram = true;
    for (const x of errors) this.notice('err', `Line ${x.line}: ${x.message}`, { line: x.line });
    if (this.compileFailed && !keepRunning) this.notice('err', 'Your program was not started. Fix the marked lines and press Run.');
  }

  /** Advance exactly `ticks` ticks (sandbox, campaign, daily). The live farm follows the clock only. */
  step(ticks = 100): Promise<void> {
    return this.guarded(async () => {
      if (this.sim.mode === 'live') return;
      await this.pause();
      if (this.stale()) await this.compile(this.current());
      if (this.compileFailed) return;
      this.sim.requestStep(ticks);
      await this.sim.flush();
      this.render();
    });
  }

  /** Finish a challenge without drawing every tick: one worker command, one render at the end. */
  runToEnd(): Promise<void> {
    const limit = this.sim.scenario.tickLimit;
    const left = limit === undefined ? 0 : limit - (this.snapshot()?.tick ?? 0);
    return left > 0 ? this.step(left) : Promise.resolve();
  }

  stepLine(): Promise<void> {
    return this.guarded(async () => {
      if (this.sim.mode === 'live') return;
      await this.pause();
      if (this.stale()) await this.compile(this.current());
      if (this.compileFailed) return;
      await this.sim.stepLine();
      this.render();
    });
  }

  /** The caller confirms in live mode. The program stays in the editor. */
  reset(): Promise<void> {
    return this.guarded(() => this.fresh(this.current()));
  }

  startScenario(s: Scenario & { seed: number; source: string }): Promise<void> {
    const { seed, source, ...scenario } = s;
    return this.guarded(() => this.fresh(source, scenario, seed));
  }

  private async fresh(source: string, scenario?: Scenario, seed?: number): Promise<void> {
    ++this.intent;
    await this.pause();
    this.changing = true;
    this.error = null;
    this.ended = false;
    this.scriptErrored = false;
    this.updateStatus();
    try {
      this.compiled = this.source = source;
      emit('source', source);
      await this.sim.reset(source, { scenario, seed });
      this.loaded = true;
      this.rendered = null;
      this.notice('clear', '');
      this.afterCompile();
      this.notice('info', 'Fresh farm ready. Press Run when you are.', { tick: 0 });
      this.render();
    } finally {
      this.changing = false;
      this.updateStatus();
    }
  }

  dispose(): void { this.running = false; cancelAnimationFrame(this.raf); }

  private guarded(job: () => Promise<void>): Promise<void> {
    if (this.actionBusy) return Promise.resolve();
    this.actionBusy = true;
    this.updateStatus();
    return job().catch((e: unknown) => this.showError(e)).finally(() => {
      this.actionBusy = false;
      this.updateStatus();
    });
  }

  private action(job: () => Promise<void>): void { void this.guarded(job); }

  private showError(e: unknown): void {
    this.running = false;
    this.error = e instanceof Error ? e.message : String(e);
    this.render();
    this.updateStatus();
  }

  private notice(kind: Notice['kind'], text: string, extra: { line?: number; tick?: number; bot?: number } = {}): void {
    emit('notice', { kind, text, tick: extra.tick ?? this.snapshot()?.tick ?? 0, ...extra } satisfies Notice);
  }

  private frame = (now: number): void => {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.render(); // First: a breakpoint reply must stop the clock before another step is requested.
    if (this.running && !this.changing && !this.sim.busy) {
      const tick = this.snapshot()?.tick ?? 0;
      let n: number;
      if (this.sim.mode === 'live') {
        // Speed cannot mint ticks: the clock is the only source. Behind it, catch up as fast as the worker allows.
        // Far behind, RealSim picks its own big lean batch; within a couple of seconds of live, normal frames.
        const behind = Math.max(0, targetTick(this.sim.meta, Date.now()) - tick);
        n = behind > LEAN_BEHIND_TICKS ? behind : Math.min(MAX_TICKS_PER_FRAME, behind);
      } else {
        this.acc = Math.min(MAX_TICKS_PER_FRAME, this.acc + elapsed * TICKS_PER_SECOND * this.speed);
        n = Math.floor(this.acc);
        this.acc -= n;
      }
      if (n > 0) this.sim.requestStep(n);
    }
    this.updateStatus();
    this.raf = requestAnimationFrame(this.frame);
  };

  private render(): void {
    const s = this.snapshot();
    // Far behind the clock the island redraws a few times a second, not once per batch.
    const hold = !!s && s !== this.rendered && !this.sim.paused && this.sim.catchUp() !== null && performance.now() - this.lastSnapAt < 250;
    if (s && s !== this.rendered && !hold) {
      this.lastSnapAt = performance.now();
      this.rendered = s;
      this.progress = null;
      emit('snapshot', s);
      const p = this.resuming ? null : this.sim.paused; // See `resuming`.
      const key = p ? `${p.bot}:${p.line}:${s.tick}` : '';
      if (p) {
        this.running = false;
        if (key !== this.pauseKey) this.notice('info', `Paused · bot ${p.bot} is at line ${p.line}. Step (F10) or Run to continue.`, { line: p.line, bot: p.bot });
      }
      this.pauseKey = key;
      emit('debug', { bots: this.sim.debug, paused: p });
      emit('heat', this.sim.heat);
      const limit = this.sim.scenario.tickLimit;
      if (limit !== undefined && s.tick >= limit && !this.ended) {
        this.ended = true;
        this.running = false;
        emit('scenario-end', { snapshot: s, log: this.sim.logChunks() });
      }
    }
    const lines = this.sim.drainOutput();
    if (lines.length) emit('output', lines);
    const events = this.sim.drainEvents?.();
    if (events?.length) emit('events', events);
    const errors: SimError[] = this.sim.drainErrors();
    if (!errors.length) return;
    const script = errors.filter((e) => !e.kind || e.kind === 'script');
    if (script.length) {
      emit('errors', script);
      const first = script[0]!;
      this.scriptErrored = true;
      this.running = false;
      this.error = `Bot ${first.bot} stopped on line ${first.line}: ${first.message}`;
    }
    for (const e of errors) {
      if (e.kind && e.kind !== 'script') { this.error = e.message; this.running = false; this.notice('err', `${e.kind === 'storage' ? 'Save' : 'Engine'}: ${e.message}`); }
    }
  }

  private updateStatus(): void {
    const sim = this.sim;
    let state = 'paused';
    const catchUp = this.running ? sim.catchUp() : null;
    let text = sim.mode === 'live' ? 'Paused · the farm clock keeps counting. Run to catch up.' : 'Paused · edit your program, run, or step.';
    if (this.error || sim.persistenceError) { state = 'error'; text = this.error ?? sim.persistenceError!; }
    else if (this.compileFailed && !this.running) { state = 'error'; text = 'Program has errors. Fix the marked lines, then Run.'; }
    else if (this.ended) { state = 'paused'; text = 'Challenge finished · see your results.'; }
    else if (sim.paused && !this.running) { state = 'paused'; text = `Paused · bot ${sim.paused.bot} on line ${sim.paused.line}`; }
    else if (this.pausing > 0) { state = 'pausing'; text = 'Pausing · finishing the current batch and saving…'; }
    else if (this.changing) { state = 'compiling'; text = 'Loading your program onto the bots…'; }
    else if (!this.loaded) { state = 'loading'; text = 'Loading your farm…'; }
    else if (this.running) {
      const debt = sim.mode === 'live' ? Math.max(0, targetTick(sim.meta, Date.now()) - (this.snapshot()?.tick ?? 0)) : 0;
      state = debt > 10 ? 'catching-up' : 'running';
      text = debt > 10 ? `Catching up · ${debt.toLocaleString()} ticks behind${catchUp ? ` · ${catchUpText(catchUp)}` : ''}` : sim.mode === 'live' ? 'Live · 10 ticks per second' : `Running · ${this.speed}× speed`;
      if (this.compileFailed) text += ' · previous program (fix the marked lines)';
      if (this.progress) text += ` · ${this.progress.done}/${this.progress.total}`;
    } else if (sim.busy) { state = 'pausing'; text = 'Saving…'; }
    const free = !this.changing && !this.actionBusy;
    const detail: LoopStatus = {
      catchUp, running: this.running, mode: sim.mode, tick: this.snapshot()?.tick ?? 0, durableTick: sim.durableTick, message: text, state,
      save: sim.persistenceError ? 'Save failed · keep window open' : sim.busy ? 'Saving on this device…'
        : sim.durableTick !== null ? `Saved locally · tick ${sim.durableTick.toLocaleString()}` : 'Not saved yet',
      canRun: this.loaded && free && !this.ended,
      canPause: this.loaded,
      canStep: this.loaded && free && !sim.busy && !this.ended,
      canReset: free && (this.loaded || !!this.error),
      paused: sim.paused,
    };
    const signature = JSON.stringify(detail);
    if (signature !== this.lastStatus) { this.lastStatus = signature; emit('status', detail); }
  }
}

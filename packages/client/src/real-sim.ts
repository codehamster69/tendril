// Main-thread worker wrapper. Commands finish after checkpoint and logs are durable.
import { deserialize, hashWorld, replayChunk } from '@tendril/sim/src/index.ts';
import type { LogEntry, Snapshot } from '@tendril/sim/src/index.ts';
import type { ChunkResponse, FarmResponse } from './api-client';
import { targetTick, type Meta, type Mode } from './clock';
import { planSubmission, validateFarm, type Accepted, type LogChunk, type Submission } from './chunks';
import type { BotDebug, Diagnostic, FromWorker, OutputLine, Scenario, SimError, StateMessage, ToWorker } from './sim-protocol';
import type { SimSource } from './sim-types';
import { kvGetMany, kvSetMany } from './store';

export type { LogChunk, Accepted, Submission } from './chunks';
export interface RealSimOptions { authoritative?: FarmResponse; replyTimeoutMs?: number; scenario?: Scenario; storageKey?: string; seed?: number }
type Command = ToWorker extends infer T ? T extends ToWorker ? Omit<T, 'id'> : never : never;

export class RealSim implements SimSource {
  onProgress?: (done: number, total: number) => void;
  meta: Meta;
  persistenceError: string | null = null;
  durableTick: number | null = null;
  hash: string | null = null;
  private worker: Worker;
  private snap: Snapshot | null = null;
  private out: OutputLine[] = [];
  diagnostics: Diagnostic[] = [];
  debug: BotDebug[] = [];
  paused: { bot: number; line: number } | null = null;
  heat: [number, number][] = [];
  scenario: Scenario;
  /** Actions logged inside a tick a breakpoint interrupted. They become durable only once that tick completes. */
  private held: { from: { tick: number; hash: string }; log: LogEntry[] } | null = null;
  private durableHash: string | null = null;
  private errs: SimError[] = [];
  private pendingLog: LogChunk[] = [];
  readonly prefix: string;
  accepted: Accepted | null = null;
  private savedWorld: string | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private source = '';
  private count = 0;
  private serial: Promise<void> = Promise.resolve();
  private nextId = 0;
  private disposed = false;
  private fatal: string | null = null;
  private waiting: { id: number; total: number; done: number; resolve: (m: StateMessage) => void; reject: (e: Error) => void } | null = null;

  constructor(readonly mode: Mode, private options: RealSimOptions = {}) {
    if (options.authoritative && mode !== 'live') throw new Error('Server farms must use the live clock.');
    this.scenario = options.scenario ?? { kind: mode };
    this.prefix = options.authoritative ? `ranked.${options.authoritative.id}.`
      : options.storageKey ? `${options.storageKey}.` : mode === 'live' ? '' : `${mode}.`;
    this.meta = { seed: 0, startedAtMs: 0, mode };
    this.worker = this.createWorker();
  }
  get workerError(): string | null { return this.fatal; }
  get ranked(): boolean { return !!this.options.authoritative; }

  /** Explicit only: never retry an interrupted command or auto-resume a program. */
  async restartWorker(): Promise<void> {
    if (!this.fatal) throw new Error('Cancel the busy worker before restarting it.');
    await this.serial;
    if (this.disposed) throw new Error('Simulation was disposed.');
    if (this.persistenceError) throw new Error('Unsaved actions are still in memory. Retry Pause/save before restarting.');
    this.worker.terminate();
    this.worker = this.createWorker();
    this.fatal = null;
    this.errs = [];
    await this.enqueue(() => this.restore(this.source, true));
  }
  cancelWorker(): void {
    if (this.disposed || this.fatal) return;
    this.stopWorker('Worker cancelled. Last durable farm and logs are kept. Choose Restart worker; interrupted work will not be retried.');
  }

  get busy(): boolean { return this.count > 0; }
  latest(): Snapshot | null { return this.snap; }
  drainOutput(): OutputLine[] { return this.out.splice(0); }
  drainErrors(): SimError[] { return this.errs.splice(0); }
  /** Copy for future replay/submission. Never evict unacknowledged actions. */
  logChunks(): LogChunk[] { return structuredClone(this.pendingLog); }

  init(source: string): Promise<void> { return this.enqueue(() => this.restore(source, false)); }

  private async restore(source: string, recovering: boolean): Promise<void> {
    const keys = ['world', 'meta', 'pendingLog', 'source', 'hash', 'accepted'].map((key) => this.prefix + key);
    const saved = await kvGetMany<Record<string, unknown>>(keys);
    let world = saved[keys[0]] as string | undefined;
    let meta = saved[keys[1]] as Meta | undefined;
    const log = saved[keys[2]] as LogChunk[] | undefined;
    if (recovering && !world) throw new Error('No durable checkpoint exists yet. Reload to initialize explicitly.');
    if (world && !meta) throw new Error('Saved farm is missing its clock. Reset explicitly to start a new farm.');
    if (world && meta && (meta.mode !== this.mode || !Number.isSafeInteger(meta.startedAtMs) || !Number.isSafeInteger(meta.seed))) throw new Error('Saved farm clock is invalid. Reset explicitly to start a new farm.');
    const authoritative = this.options.authoritative;
    if (authoritative) {
      validateFarm(authoritative);
      if (world && meta && (meta.farmId !== authoritative.id || meta.seed !== authoritative.seed || meta.startedAtMs !== authoritative.startedAtMs || meta.rulesVersion !== authoritative.rulesVersion)) throw new Error('Saved server farm identity, seed, clock or rules mismatch. Pending logs retained; no replacement or retry.');
      this.accepted = world ? saved[keys[5]] as Accepted : { farm: authoritative, receivedAtMs: null };
      if (!this.accepted) throw new Error('Saved server farm is missing its accepted checkpoint. Logs retained.');
      validateFarm(this.accepted.farm);
      if (this.accepted.farm.id !== authoritative.id || this.accepted.farm.seed !== authoritative.seed || this.accepted.farm.startedAtMs !== authoritative.startedAtMs) throw new Error('Saved accepted checkpoint identity mismatch.');
      world ??= authoritative.checkpoint;
      meta ??= { seed: authoritative.seed, startedAtMs: authoritative.startedAtMs, mode: 'live', farmId: authoritative.id, rulesVersion: authoritative.rulesVersion };
    }
    this.pendingLog = log ?? [];
    if (world) {
      const restored = deserialize(world);
      if (restored.seed !== meta!.seed || (authoritative && restored.id !== authoritative.id)) throw new Error('Saved world does not match farm metadata.');
      if (saved[keys[4]] && hashWorld(restored) !== saved[keys[4]]) throw new Error('Saved checkpoint hash mismatch.');
      if (this.accepted) {
        const replay = deserialize(this.accepted.farm.checkpoint);
        for (const chunk of this.pendingLog) {
          if (chunk.fromTick !== replay.tick || chunk.fromHash !== hashWorld(replay)) throw new Error('Saved pending log chain is inconsistent. Logs retained.');
          replayChunk(replay, chunk.actions, chunk.toTick);
          if (chunk.hash !== hashWorld(replay)) throw new Error('Saved pending log hash mismatch. Logs retained.');
        }
        if (hashWorld(replay) !== hashWorld(restored)) throw new Error('Saved pending logs do not reach the durable checkpoint.');
      }
    }
    this.snap = null;
    source = recovering ? (saved[keys[3]] as string | undefined) ?? source : source;
    const nextMeta = meta ?? this.newMeta();
    await this.command({ type: 'init', saved: world ?? null, seed: nextMeta.seed, source, scenario: this.scenario }, nextMeta, source);
  }

  setSource(source: string): Promise<void> {
    return this.enqueue(() => this.command({ type: 'setSource', source }, this.meta, source));
  }

  /** Replace the farm. A scenario and seed may be supplied to start a different challenge in the same keyspace. */
  reset(source: string, over: { scenario?: Scenario; seed?: number } = {}): Promise<void> {
    if (this.ranked) return Promise.reject(new Error('Server-owned farms cannot be reset locally. Your local farm is still in its original keyspace.'));
    return this.enqueue(() => {
      const meta = this.newMeta();
      if (over.seed !== undefined) meta.seed = over.seed;
      const scenario = over.scenario ?? this.scenario;
      // Never delete the old save first: replace all related keys atomically.
      this.scenario = scenario;
      return this.command({ type: 'reset', seed: meta.seed, source, scenario }, meta, source, true);
    });
  }

  setBreakpoints(lines: number[]): Promise<void> {
    return this.enqueue(() => this.command({ type: 'setBreakpoints', lines }, this.meta, this.source));
  }
  stepLine(): Promise<void> {
    return this.enqueue(() => this.command({ type: 'stepLine' }, this.meta, this.source));
  }
  resume(): Promise<void> {
    return this.enqueue(() => this.command({ type: 'resume' }, this.meta, this.source));
  }

  requestStep(ticks: number): void {
    if (this.busy || this.disposed || this.fatal || this.persistenceError || !this.snap) return;
    if (!Number.isSafeInteger(ticks) || ticks <= 0) return;
    ticks = Math.min(ticks, 20_000);
    if (this.mode === 'live') ticks = Math.min(ticks, targetTick(this.meta, Date.now()) - this.snap.tick);
    if (ticks <= 0) return;
    void this.enqueue(() => this.command({ type: 'step', ticks }, this.meta, this.source)).catch(() => {});
  }

  /** FIFO barrier including in-flight stepping and actual IndexedDB completion. */
  flush(): Promise<void> {
    return this.enqueue(() => this.command({ type: 'step', ticks: 0 }, this.meta, this.source));
  }

  /**
   * Plans the next chunk from inside the command queue, so it reads a consistent durable state without
   * pausing the program. Steps queued after it simply become part of a later chunk.
   */
  planChunk(): Promise<Submission | null> {
    let plan: Submission | null = null;
    return this.enqueue(async () => {
      if (!this.accepted || !this.snap || this.persistenceError || this.fatal) throw new Error('The server farm is not ready to sync.');
      plan = planSubmission(this.accepted.farm, this.pendingLog, this.snap.tick);
    }).then(() => plan);
  }
  acknowledge(plan: Submission, response: ChunkResponse): Promise<void> {
    return this.enqueue(async () => {
      if (!this.accepted || plan.request.fromTick !== this.accepted.farm.tick || plan.request.checkpointHash !== this.accepted.farm.checkpointHash) throw new Error('Accepted checkpoint changed during sync. Logs retained.');
      if (response.tick !== plan.request.toTick || response.checkpointHash !== plan.hash || response.netWorth !== plan.netWorth) throw new Error('Verifier response differs from the replayed prefix. Logs retained; refetch for recovery.');
      const w = deserialize(plan.checkpoint);
      await this.acceptPrefix({ ...this.accepted.farm, tick: w.tick, checkpoint: plan.checkpoint, checkpointHash: plan.hash, coins: w.coins, netWorth: plan.netWorth }, Date.now());
    });
  }
  /** User-approved recovery after 409/uncertain response; only a matching replay prefix can be acknowledged. */
  reconcile(farm: FarmResponse): Promise<void> {
    return this.enqueue(async () => {
      validateFarm(farm);
      if (!this.accepted || !this.snap || farm.id !== this.meta.farmId || farm.seed !== this.meta.seed || farm.startedAtMs !== this.meta.startedAtMs || farm.tick < this.accepted.farm.tick || farm.tick > this.snap.tick) throw new Error('Server checkpoint cannot be reconciled with retained local history. No logs were removed.');
      const w = deserialize(this.accepted.farm.checkpoint);
      for (const chunk of this.pendingLog) {
        if (chunk.fromTick >= farm.tick) break;
        replayChunk(w, chunk.actions.filter((e) => e[0] < farm.tick), Math.min(chunk.toTick, farm.tick));
        if (w.tick === farm.tick) break;
      }
      if (w.tick !== farm.tick || hashWorld(w) !== farm.checkpointHash) throw new Error('Server checkpoint is on a different history. Local pending logs retained; export/review is required.');
      await this.acceptPrefix(farm, null);
    });
  }
  private async acceptPrefix(farm: FarmResponse, receivedAtMs: number | null): Promise<void> {
    const remaining = this.pendingLog.filter((c) => c.toTick > farm.tick).map((c) => c.fromTick < farm.tick
      ? { ...c, fromTick: farm.tick, fromHash: farm.checkpointHash, actions: c.actions.filter((e) => e[0] >= farm.tick) } : c);
    const accepted = { farm, receivedAtMs };
    // Memory changes only after the acknowledgement transaction is durable.
    await this.persist(this.savedWorld!, this.meta, this.source, remaining, this.durableHash!, accepted);
    this.pendingLog = remaining;
    this.accepted = accepted;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.clearWatchdog();
    this.worker.terminate();
    this.waiting?.reject(new Error('Simulation was disposed.'));
    this.waiting = null;
  }

  private newMeta(): Meta {
    return { seed: this.options.seed ?? crypto.getRandomValues(new Uint32Array(1))[0]!, startedAtMs: Date.now(), mode: this.mode };
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL('./sim-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FromWorker>) => { if (worker === this.worker) this.onMessage(e.data); };
    worker.onerror = (e) => { if (worker === this.worker) this.stopWorker(e.message || 'Simulation worker stopped. Choose Restart worker.'); };
    worker.onmessageerror = () => { if (worker === this.worker) this.stopWorker('Worker reply could not be read. Choose Restart worker.'); };
    return worker;
  }
  private clearWatchdog(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private armWatchdog(): void {
    this.clearWatchdog();
    this.timer = setTimeout(() => this.stopWorker('Worker did not reply within its time limit (30 seconds by default). Last durable farm and logs are kept. Choose Restart worker.'), this.options.replyTimeoutMs ?? 30_000);
  }
  private stopWorker(message: string): void {
    this.fatal = message;
    this.generation++;
    this.clearWatchdog();
    this.worker.terminate();
    this.waiting?.reject(new Error(message));
    this.waiting = null;
    this.errs.push({ bot: -1, message, kind: 'worker' });
  }
  private enqueue(job: () => Promise<void>): Promise<void> {
    const generation = this.generation;
    this.count++;
    const next = this.serial.then(async () => {
      if (this.disposed) throw new Error('Simulation was disposed.');
      if (this.fatal || generation !== this.generation) throw new Error(this.fatal ?? 'Queued command cancelled; it was not retried.');
      await job();
    }).catch((e: unknown) => {
      this.errs.push({ bot: -1, message: e instanceof Error ? e.message : String(e), kind: this.persistenceError ? 'storage' : 'worker' });
      throw e;
    }).finally(() => { this.count--; });
    this.serial = next.catch(() => {});
    return next;
  }

  private async command(m: Command, meta: Meta, source: string, reset = false): Promise<void> {
    const id = ++this.nextId;
    const state = await new Promise<StateMessage>((resolve, reject) => {
      this.waiting = { id, total: m.type === 'step' ? m.ticks : 0, done: 0, resolve, reject };
      this.armWatchdog();
      try { this.worker.postMessage({ ...m, id } satisfies ToWorker); }
      catch (e) { this.stopWorker(e instanceof Error ? e.message : String(e)); }
    });
    if (!reset && this.snap && (state.fromTick !== this.snap.tick || state.fromHash !== this.hash)) {
      throw new Error('Simulation checkpoint is out of order. Cancel and restart before continuing.');
    }
    if (reset) { this.pendingLog = []; this.held = null; }
    this.meta = meta;
    this.source = source;
    this.snap = state.snapshot;
    this.hash = state.hash;
    this.out.push(...state.output);
    this.errs.push(...state.errors.map((e) => ({ ...e, kind: 'script' as const })));
    this.diagnostics = state.diagnostics;
    this.debug = state.debug;
    this.paused = state.paused;
    this.heat = state.heat;
    // A breakpoint can stop the world inside tick T (some bots already acted). That state cannot be replayed
    // from a log, so it is kept in memory and only becomes a checkpoint once the tick completes.
    const log = [...(this.held?.log ?? []), ...state.log];
    const from = this.held?.from ?? { tick: state.fromTick, hash: state.fromHash };
    if (log.some((entry) => entry[0] >= state.snapshot.tick)) {
      this.held = { from, log };
      return;
    }
    this.held = null;
    this.savedWorld = state.saved;
    this.durableHash = state.hash;
    if (from.tick !== state.snapshot.tick || log.length) {
      this.pendingLog.push({ fromTick: from.tick, toTick: state.snapshot.tick, actions: log, fromHash: from.hash, hash: state.hash });
    }
    await this.persist(state.saved, meta, source, this.pendingLog, state.hash, this.accepted);
    this.durableTick = state.snapshot.tick;
  }

  private async persist(world: string, meta: Meta, source: string, logs: LogChunk[], hash: string, accepted: Accepted | null): Promise<void> {
    try {
      await kvSetMany({
        [this.prefix + 'world']: world,
        [this.prefix + 'meta']: meta,
        [this.prefix + 'pendingLog']: logs,
        [this.prefix + 'hash']: hash,
        [this.prefix + 'source']: source,
        ...(accepted ? { [this.prefix + 'accepted']: accepted } : {}),
      });
      this.persistenceError = null;
    } catch (e) {
      this.persistenceError = `Farm save failed: ${e instanceof Error ? e.message : String(e)}. Keep this window open and pause to retry saving.`;
      // Preserve all pending actions in memory; automatic stepping stops.
      throw new Error(this.persistenceError, { cause: e });
    }
  }

  private onMessage(m: FromWorker): void {
    if (!this.waiting || m.id !== this.waiting.id) return;
    if (m.type === 'progress') { this.onProgress?.(m.done, m.total); return; }
    const waiting = this.waiting;
    this.waiting = null;
    if (m.type === 'fatal') waiting.reject(new Error(m.message));
    else waiting.resolve(m);
  }
}

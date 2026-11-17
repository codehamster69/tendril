// Main-thread worker wrapper. Commands finish after checkpoint and logs are durable.
import { perfHook } from './perf-meter';
import { deserialize, endlessSiloTick, hashWorld, replayChunk, withEndlessSilos } from '@tendril/sim/src/index.ts';
import type { LogEntry } from '@tendril/sim/src/index.ts';
import type { ChunkResponse, FarmResponse } from './api-client';
import { targetTick, type Meta, type Mode } from './clock';
import { planSubmission, trimLocalLog, validateFarm, type Accepted, type LogChunk, type Submission } from './chunks';
import type { GoalProgress } from './goal-progress';
import type { BotDebug, Diagnostic, FromWorker, OutputLine, Scenario, SimError, StateMessage, ToWorker, ViewEvent } from './sim-protocol';
import { ViewStore } from './view-codec';
import type { ViewSnapshot } from './view-codec';
import type { SimSource } from './sim-types';
import { kvGetMany, kvWrite } from './store';

export type { LogChunk, Accepted, Submission } from './chunks';
export interface RealSimOptions { authoritative?: FarmResponse; replyTimeoutMs?: number; scenario?: Scenario; storageKey?: string; seed?: number }
type Command = ToWorker extends infer T ? T extends ToWorker ? Omit<T, 'id'> : never : never;

/** The longest a running farm goes between saves (more for very large farms, see requestStep). */
const SAVE_EVERY_MS = 2_000;
/** Behind the clock by more than this, the farm catches up in lean mode (see requestStep). Within it, ticks are watched live. */
export const LEAN_BEHIND_TICKS = 1_200;
/** While catching up a full checkpoint (world + log chunk) is saved at least this often, so a reload resumes near where it stopped. */
export const CHECKPOINT_TICKS = 20_000;
const CHECKPOINT_MAX_MS = 10_000;
/** Each lean batch aims to take about this long, so the page, saves and sync stay responsive whatever the farm's size. */
const BATCH_TARGET_MS = 400;
const BATCH_MIN = 500;
const BATCH_MAX = 20_000;

/** Where a catch-up stands; null while the farm is live (see RealSim.catchUp). */
export interface CatchUp { behind: number; startBehind: number; ticksPerSecond: number; etaSeconds: number | null }

const isLean = (m: Command): boolean => m.type === 'step' && m.lean === true;

export class RealSim implements SimSource {
  onProgress?: (done: number, total: number) => void;
  meta: Meta;
  persistenceError: string | null = null;
  durableTick: number | null = null;
  hash: string | null = null;
  private worker: Worker;
  private snap: ViewSnapshot | null = null;
  private view = new ViewStore();
  private viewEvents: ViewEvent[] = [];
  private out: OutputLine[] = [];
  diagnostics: Diagnostic[] = [];
  debug: BotDebug[] = [];
  paused: { bot: number; line: number } | null = null;
  heat: [number, number][] = [];
  scenario: Scenario;
  /** Actions logged inside a tick a breakpoint interrupted. They become durable only once that tick completes. */
  private held: { from: { tick: number; hash: string }; log: LogEntry[] } | null = null;
  private durableHash: string | null = null;
  /** True while light steps have run since the last full save, so `hash` no longer describes the world. */
  private hashStale = false;
  private lastSaveAt = 0;
  /** How long the last full save took (worker hash and copy, transfer, database write). */
  private saveCostMs = 0;
  private errs: SimError[] = [];
  private pendingLog: LogChunk[] = [];
  /** Log chunks are stored one key each (`log.<id>`) plus an ordered index, so a save writes only new chunks, never the whole backlog. */
  private logIds = new WeakMap<LogChunk, number>();
  private storedIds = new Set<number>();
  private nextLogId = 1;
  private lean = false;
  private batch = 500;
  private rate = 0;
  private startBehind = 0;
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
  latest(): ViewSnapshot | null { return this.snap; }
  private goal: GoalProgress | null = null;
  goalProgress(): GoalProgress | null { return this.goal; }
  /** Events the screen must not miss (harvest, sale, order filled, error), oldest first. */
  drainEvents(): ViewEvent[] { return this.viewEvents.splice(0); }
  drainOutput(): OutputLine[] { return this.out.splice(0); }
  drainErrors(): SimError[] { return this.errs.splice(0); }
  /** Every action kind this farm has ever logged, kept cheaply so achievements need not scan or copy the log. */
  private opsSeen = new Set<number>();
  opKinds(): ReadonlySet<number> { return this.opsSeen; }
  /** Server-owned farms keep every unacknowledged action. A local farm submits nothing, so only a recent window stays: a farm left running for hours must not grow its save without end. */
  private trimLocal(): void {
    if (!this.accepted && (this.scenario.kind === 'live' || this.scenario.kind === 'sandbox')) this.pendingLog = trimLocalLog(this.pendingLog);
  }
  /** Copy for future replay/submission. Never evict unacknowledged actions. */
  logChunks(): LogChunk[] { return structuredClone(this.pendingLog); }

  init(source: string): Promise<void> { return this.enqueue(() => this.restore(source, false)); }

  private async restore(source: string, recovering: boolean): Promise<void> {
    const keys = ['world', 'meta', 'pendingLog', 'source', 'hash', 'accepted', 'logIdx'].map((key) => this.prefix + key);
    const saved = await kvGetMany<Record<string, unknown>>(keys);
    let world = saved[keys[0]] as string | undefined;
    let meta = saved[keys[1]] as Meta | undefined;
    const log = await this.loadLog(saved[keys[6]] as number[] | undefined, saved[keys[2]] as LogChunk[] | undefined);
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
      if (meta) meta = { ...meta, restedMs: Math.max(meta.restedMs ?? 0, authoritative.restedMs ?? 0) };
      meta ??= { seed: authoritative.seed, startedAtMs: authoritative.startedAtMs, restedMs: authoritative.restedMs ?? 0, mode: 'live', farmId: authoritative.id, rulesVersion: authoritative.rulesVersion };
    }
    this.pendingLog = log ?? [];
    this.opsSeen = new Set(this.pendingLog.flatMap((c) => c.actions.map((e) => e[2])));
    this.trimLocal();
    if (world) {
      const restored = deserialize(world);
      if (restored.seed !== meta!.seed || (authoritative && restored.id !== authoritative.id)) throw new Error('Saved world does not match farm metadata.');
      if (saved[keys[4]] && hashWorld(restored) !== saved[keys[4]]) throw new Error('Saved checkpoint hash mismatch.');
      if (this.accepted) {
        const replay = withEndlessSilos(deserialize(this.accepted.farm.checkpoint), this.accepted.farm.startedAtMs);
        for (const chunk of this.pendingLog) {
          if (chunk.fromTick !== replay.tick || chunk.fromHash !== hashWorld(replay)) throw new Error('Saved pending log chain is inconsistent. Logs retained.');
          replayChunk(replay, chunk.actions, chunk.toTick);
          if (chunk.hash !== hashWorld(replay)) throw new Error('Saved pending log hash mismatch. Logs retained.');
        }
        if (hashWorld(replay) !== hashWorld(restored)) throw new Error('Saved pending logs do not reach the durable checkpoint.');
      }
    }
    this.snap = null;
    this.view = new ViewStore();
    this.viewEvents = [];
    source = recovering ? (saved[keys[3]] as string | undefined) ?? source : source;
    const nextMeta = meta ?? this.newMeta();
    await this.command({ type: 'init', saved: world ?? null, seed: nextMeta.seed, source, scenario: this.silos(this.scenario, nextMeta) }, nextMeta, source);
  }

  /** The stored log: chunk keys named by the index, or (farms saved before the index existed) the old single array, which the next save converts. */
  private async loadLog(index: number[] | undefined, legacy: LogChunk[] | undefined): Promise<LogChunk[] | undefined> {
    this.storedIds = new Set();
    if (!index) return legacy;
    const keys = index.map((id) => `${this.prefix}log.${id}`);
    const got = await kvGetMany<Record<string, LogChunk>>(keys);
    const chunks = keys.map((k) => got[k]);
    if (chunks.some((c) => !c)) throw new Error('Saved pending log is missing a chunk. Logs retained; no replacement or retry.');
    index.forEach((id, i) => { this.logIds.set(chunks[i]!, id); this.storedIds.add(id); this.nextLogId = Math.max(this.nextLogId, id + 1); });
    return chunks as LogChunk[];
  }

  /** Endless and sandbox farms get silos by the clock (rules v5, SILO_EPOCH); challenges and lessons take theirs from their setup. */
  private silos(scenario: Scenario, meta: Meta): Scenario {
    if (scenario.kind !== 'live' && scenario.kind !== 'sandbox') return scenario;
    return { ...scenario, siloTick: endlessSiloTick(meta.startedAtMs) };
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
      return this.command({ type: 'reset', seed: meta.seed, source, scenario: this.silos(scenario, meta) }, meta, source, true);
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
    let behind = 0;
    if (this.mode === 'live') {
      behind = targetTick(this.meta, Date.now()) - this.snap.tick;
      ticks = Math.min(ticks, behind);
    }
    if (ticks <= 0) return;
    // Far behind the clock (a long time away): nobody watches single ticks, so run big adaptive batches in lean mode
    // and checkpoint on a tick schedule. The last stretch before the clock runs normally, with full detail.
    if (this.mode === 'live' && behind > LEAN_BEHIND_TICKS) {
      if (!this.lean) { this.lean = true; this.startBehind = behind; this.rate = 0; this.batch = BATCH_MIN; }
      ticks = Math.min(behind - LEAN_BEHIND_TICKS / 2, this.batch);
      const full = !this.snap || this.snap.tick - (this.durableTick ?? 0) + ticks >= CHECKPOINT_TICKS || Date.now() - this.lastSaveAt >= CHECKPOINT_MAX_MS;
      const started = performance.now();
      void this.enqueue(() => this.command({ type: 'step', ticks, light: !full, lean: true }, this.meta, this.source))
        .then(() => this.tune(ticks, performance.now() - started), () => {});
      return;
    }
    this.lean = false;
    // Saving costs time that grows with the farm (hash, full-world copy, database write), so a farm that is merely
    // running is saved at most every few seconds, and never spends more than ~5% of its time saving. Pausing,
    // editing, syncing and every other command still save at once. A crash loses at most that window, which the
    // clock (live) or the same program (sandbox) re-simulates identically. Challenges and lessons save every step.
    const lazy = this.mode === 'live' || this.mode === 'sandbox';
    const light = lazy && Date.now() - this.lastSaveAt < Math.max(SAVE_EVERY_MS, this.saveCostMs * 20);
    void this.enqueue(() => this.command({ type: 'step', ticks, light }, this.meta, this.source)).catch(() => {});
  }

  /** Steers the next batch toward BATCH_TARGET_MS and keeps a smoothed ticks-per-second figure for the ETA. */
  private tune(ticks: number, ms: number): void {
    if (ms <= 0) return;
    const perSecond = ticks / (ms / 1000);
    this.rate = this.rate ? this.rate * 0.7 + perSecond * 0.3 : perSecond;
    this.batch = Math.round(Math.min(BATCH_MAX, Math.max(BATCH_MIN, this.batch * Math.min(2, Math.max(0.5, BATCH_TARGET_MS / ms)))));
  }

  /** Progress of a long catch-up for the screen, or null when the farm is (nearly) live. */
  catchUp(nowMs = Date.now()): CatchUp | null {
    if (!this.lean || !this.snap || this.mode !== 'live') return null;
    const behind = Math.max(0, targetTick(this.meta, nowMs) - this.snap.tick);
    if (behind <= LEAN_BEHIND_TICKS / 2) return null;
    const net = this.rate - 10; // The clock keeps running while the farm catches up.
    return { behind, startBehind: Math.max(this.startBehind, behind), ticksPerSecond: Math.round(this.rate), etaSeconds: this.rate > 0 && net > 0 ? behind / net : null };
  }

  /** The last durable checkpoint, read after every queued command. A copy for the dry run; the farm itself is not touched. */
  async durableWorld(): Promise<string | null> {
    await this.flush();
    return this.savedWorld;
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
      if (this.persistenceError || this.fatal) throw new Error('The farm could not be saved, so it cannot sync. Your local logs are kept.');
      if (!this.accepted || !this.snap) return; // Still loading: nothing to sync yet.
      plan = planSubmission(this.accepted.farm, this.pendingLog, this.durableTick ?? this.snap.tick);
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
      const w = withEndlessSilos(deserialize(this.accepted.farm.checkpoint), farm.startedAtMs);
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

  private async ask(m: Command): Promise<StateMessage> {
    const id = ++this.nextId;
    return new Promise<StateMessage>((resolve, reject) => {
      this.waiting = { id, total: m.type === 'step' ? m.ticks : 0, done: 0, resolve, reject };
      this.armWatchdog();
      try { this.worker.postMessage({ ...m, id } satisfies ToWorker); }
      catch (e) { this.stopWorker(e instanceof Error ? e.message : String(e)); }
    });
  }

  private async command(m: Command, meta: Meta, source: string, reset = false): Promise<void> {
    const state = await this.ask(m);
    if (!reset && this.snap && (state.fromTick !== this.snap.tick || (state.fromHash !== '' && !this.hashStale && state.fromHash !== this.hash))) {
      throw new Error('Simulation checkpoint is out of order. Cancel and restart before continuing.');
    }
    if (reset) { this.pendingLog = []; this.held = null; }
    this.meta = meta;
    this.source = source;
    // A delta that does not follow the last update (or another format version) is answered with a full view.
    let view = state.view;
    if (!this.view.apply(view)) {
      view = (await this.ask({ type: 'fullView' })).view;
      if (!this.view.apply(view)) throw new Error('The farm view could not be rebuilt. Cancel and restart the worker.');
    }
    if (!isLean(m)) this.viewEvents.push(...state.view.events);
    if (this.viewEvents.length > 512) this.viewEvents.splice(0, this.viewEvents.length - 512);
    this.snap = this.view.latest();
    const light = state.hash === '';
    if (!light) { this.hash = state.hash; this.hashStale = false; }
    this.out.push(...state.output);
    this.errs.push(...state.errors.map((e) => ({ ...e, kind: 'script' as const })));
    this.diagnostics = state.diagnostics;
    if (!isLean(m)) { this.debug = state.debug; this.heat = state.heat; }
    this.paused = state.paused;
    this.goal = state.goal ?? null;
    // A breakpoint can stop the world inside tick T (some bots already acted). That state cannot be replayed
    // from a log, so it is kept in memory and only becomes a checkpoint once the tick completes.
    // A light step is not saved: its actions wait in memory with the others until the next full save (see requestStep).
    const log = this.held ? this.held.log : [];
    for (const entry of state.log) log.push(entry);
    const from = this.held?.from ?? { tick: state.fromTick, hash: state.fromHash || this.durableHash || '' };
    if (light || log.some((entry) => entry[0] >= state.view.tick)) {
      this.hashStale ||= light;
      this.held = { from, log };
      return;
    }
    this.held = null;
    for (const entry of log) this.opsSeen.add(entry[2]);
    this.savedWorld = state.saved;
    this.durableHash = state.hash;
    if (from.tick !== state.view.tick || log.length) {
      this.pendingLog.push({ fromTick: from.tick, toTick: state.view.tick, actions: log, fromHash: from.hash, hash: state.hash });
      this.trimLocal();
    }
    const started = performance.now();
    await this.persist(state.saved, meta, source, this.pendingLog, state.hash, this.accepted);
    this.durableTick = state.view.tick;
    this.lastSaveAt = Date.now();
    this.saveCostMs = performance.now() - started;
  }

  private async persist(world: string, meta: Meta, source: string, logs: LogChunk[], hash: string, accepted: Accepted | null): Promise<void> {
    try {
      // Append-only: only chunks not yet stored are written; chunks the server acknowledged (or trimmed) are deleted.
      const ids: number[] = [];
      const entries: Record<string, unknown> = {
        [this.prefix + 'world']: world,
        [this.prefix + 'meta']: meta,
        [this.prefix + 'hash']: hash,
        [this.prefix + 'source']: source,
        ...(accepted ? { [this.prefix + 'accepted']: accepted } : {}),
      };
      for (const chunk of logs) {
        let id = this.logIds.get(chunk);
        if (id === undefined) { id = this.nextLogId++; this.logIds.set(chunk, id); }
        ids.push(id);
        if (!this.storedIds.has(id)) entries[`${this.prefix}log.${id}`] = chunk;
      }
      entries[this.prefix + 'logIdx'] = ids;
      const keep = new Set(ids);
      const remove = [this.prefix + 'pendingLog', ...[...this.storedIds].filter((id) => !keep.has(id)).map((id) => `${this.prefix}log.${id}`)];
      await kvWrite(entries, remove);
      this.storedIds = keep;
      this.persistenceError = null;
    } catch (e) {
      this.persistenceError = `Farm save failed: ${e instanceof Error ? e.message : String(e)}. Keep this window open and pause to retry saving.`;
      // Preserve all pending actions in memory; automatic stepping stops.
      throw new Error(this.persistenceError, { cause: e });
    }
  }

  private onMessage(m: FromWorker): void {
    if (!this.waiting || m.id !== this.waiting.id) return;
    if (m.type === 'progress') { this.armWatchdog(); this.onProgress?.(m.done, m.total); return; }
    // The worker answered: stop the countdown, or an idle (paused) farm would be reported as a dead worker 30 s later.
    this.clearWatchdog();
    const waiting = this.waiting;
    this.waiting = null;
    perfHook.update?.(m);
    if (m.type === 'fatal') waiting.reject(new Error(m.message));
    else waiting.resolve(m);
  }
}

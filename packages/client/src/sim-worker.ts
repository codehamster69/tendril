// Owns the World and the Sprout run. Player code never runs on the main thread or the server.
import { createWorld, deserialize, hashWorld, OP, serialize, tickWorld } from '@tendril/sim/src/index.ts';
import type { LogEntry, World } from '@tendril/sim/src/index.ts';
import { compile, createRun } from '@tendril/lang/src/index.ts';
import type { Diagnostic, ScriptError, ScriptRun } from '@tendril/lang/src/index.ts';
import { EVENT } from './sim-protocol';
import type { FromWorker, Scenario, ToWorker, ViewEvent } from './sim-protocol';
import { ViewEncoder } from './view-codec';

const SLICE = 250;
let world: World | null = null;
let run: ScriptRun | null = null;
let scenario: Scenario = { kind: 'live' };
let breakpoints: number[] = [];
/** Where a breakpoint or line step stopped the world. Kept until a command runs ticks again. */
let paused: { bot: number; line: number } | null = null;
const encoder = new ViewEncoder();
let chain: Promise<void> = Promise.resolve();
const post = (m: FromWorker, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(m, transfer);

function eventsOf(log: LogEntry[], errors: ScriptError[]): ViewEvent[] {
  const out: ViewEvent[] = [];
  for (const [t, bot, op, a, b] of log) {
    if (op === OP.harvest) out.push([EVENT.harvest, t, bot, 0, 0]);
    else if (op === OP.sell) out.push([EVENT.sale, t, bot, a ?? 0, b ?? 0]);
    else if (op === OP.deliver) out.push([EVENT.order, t, bot, a ?? 0, 0]);
  }
  for (const e of errors) out.push([EVENT.error, e.tick ?? 0, e.bot, 0, 0]);
  return out;
}

function features(): ReadonlySet<string> | undefined {
  return scenario.features ? new Set(scenario.features) : undefined;
}

/** Compile first; a broken program never replaces a working one. */
function startRun(source: string): Diagnostic[] {
  const { program, diagnostics } = compile(source, { features: features() });
  if (!program || diagnostics.some((d) => d.severity === 'error')) return diagnostics;
  const next = createRun(world!, source, { features: features() });
  run?.close();
  run = next;
  run.setBreakpoints(breakpoints);
  return diagnostics;
}

async function handle(m: ToWorker): Promise<void> {
  let diagnostics: Diagnostic[] = [];
  if (m.type === 'init' || m.type === 'reset') {
    scenario = m.scenario;
    encoder.reset();
    run?.close();
    run = null;
    paused = null;
    world = m.type === 'init' && m.saved
      ? deserialize(m.saved)
      : createWorld({ id: scenario.farmId ?? 'farm', seed: m.seed }, scenario.setup);
  }
  if (!world) throw new Error('Farm is not initialized. Reload to try again.');
  if (m.type === 'fullView') encoder.reset();
  const fromTick = world.tick;
  const fromHash = hashWorld(world);
  if (m.type === 'init' || m.type === 'reset' || m.type === 'setSource') {
    diagnostics = startRun(m.source);
    if (run && !diagnostics.some((d) => d.severity === 'error')) paused = null;
  }
  if (m.type === 'setBreakpoints') { breakpoints = m.lines; run?.setBreakpoints(m.lines); }

  if (m.type === 'step' && run) {
    if (!Number.isSafeInteger(m.ticks) || m.ticks < 0 || m.ticks > 20_000) {
      throw new Error('Step must be an integer from 0 to 20,000 ticks.');
    }
    let total = m.ticks;
    if (total > 0) paused = null;
    if (scenario.tickLimit !== undefined) total = Math.min(total, Math.max(0, scenario.tickLimit - world.tick));
    try {
      for (let done = 0; done < total;) {
        const r = run.step(Math.min(SLICE, total - done));
        done += r.ticks;
        if (r.paused) { paused = r.paused; break; }
        if (r.ticks === 0) break;
        if (done < total) {
          post({ type: 'progress', id: m.id, done, total });
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    } catch (err) {
      run.errors.push({ bot: -1, line: 0, col: 0, tick: world.tick, message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (m.type === 'step' && !run) {
    // A farm without a working program still lives through time.
    let total = Math.max(0, Math.min(m.ticks, 20_000));
    if (scenario.tickLimit !== undefined) total = Math.min(total, Math.max(0, scenario.tickLimit - world.tick));
    for (let i = 0; i < total; i++) tickWorld(world);
  }
  if (m.type === 'stepLine' && run) paused = run.stepLine().paused;
  // Finish the tick a breakpoint interrupted (or stop at the next breakpoint inside it).
  if (m.type === 'resume' && run) paused = run.step(1).paused;

  // One reply per command and the main thread asks at most once per animation frame, so at most one view update
  // per frame leaves here however many ticks ran (16x just means a longer step). Only the final state is sent.
  const errors = run ? run.errors.splice(0) : [];
  const log = run ? run.takeLog() : [];
  const { update, transfer } = encoder.encode(world, eventsOf(log, errors));
  post({
    type: 'state', id: m.id, fromTick, fromHash, hash: hashWorld(world),
    view: update,
    output: run ? run.output.splice(0) : [],
    errors,
    diagnostics,
    log,
    saved: serialize(world),
    debug: run ? run.debug() : [],
    paused,
    heat: run ? [...run.lineHeat()] : [],
  }, transfer);
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  chain = chain.then(() => handle(e.data)).catch((err: unknown) => {
    post({ type: 'fatal', id: e.data.id, message: err instanceof Error ? err.message : String(err) });
  });
};

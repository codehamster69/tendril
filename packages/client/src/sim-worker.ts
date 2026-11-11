// Owns the World and the Sprout run. Player code never runs on the main thread or the server.
import { createWorld, deserialize, hashWorld, serialize, snapshot, tickWorld } from '@tendril/sim/src/index.ts';
import type { World } from '@tendril/sim/src/index.ts';
import { compile, createRun } from '@tendril/lang/src/index.ts';
import type { Diagnostic, ScriptRun } from '@tendril/lang/src/index.ts';
import type { FromWorker, Scenario, ToWorker } from './sim-protocol';

const SLICE = 250;
let world: World | null = null;
let run: ScriptRun | null = null;
let scenario: Scenario = { kind: 'live' };
let breakpoints: number[] = [];
let chain: Promise<void> = Promise.resolve();
const post = (m: FromWorker): void => (self as unknown as Worker).postMessage(m);

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
  let paused: { bot: number; line: number } | null = null;
  if (m.type === 'init' || m.type === 'reset') {
    scenario = m.scenario;
    run?.close();
    run = null;
    world = m.type === 'init' && m.saved
      ? deserialize(m.saved)
      : createWorld({ id: scenario.farmId ?? 'farm', seed: m.seed }, scenario.setup);
  }
  if (!world) throw new Error('Farm is not initialized. Reload to try again.');
  const fromTick = world.tick;
  const fromHash = hashWorld(world);
  if (m.type === 'init' || m.type === 'reset' || m.type === 'setSource') diagnostics = startRun(m.source);
  if (m.type === 'setBreakpoints') { breakpoints = m.lines; run?.setBreakpoints(m.lines); }

  if (m.type === 'step' && run) {
    if (!Number.isSafeInteger(m.ticks) || m.ticks < 0 || m.ticks > 20_000) {
      throw new Error('Step must be an integer from 0 to 20,000 ticks.');
    }
    let total = m.ticks;
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

  post({
    type: 'state', id: m.id, fromTick, fromHash, hash: hashWorld(world),
    snapshot: snapshot(world),
    output: run ? run.output.splice(0) : [],
    errors: run ? run.errors.splice(0).map((e) => ({ ...e, kind: 'script' as const })) : [],
    diagnostics,
    log: run ? run.takeLog() : [],
    saved: serialize(world),
    debug: run ? run.debug() : [],
    paused,
    heat: run ? [...run.lineHeat()] : [],
  });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  chain = chain.then(() => handle(e.data)).catch((err: unknown) => {
    post({ type: 'fatal', id: e.data.id, message: err instanceof Error ? err.message : String(err) });
  });
};

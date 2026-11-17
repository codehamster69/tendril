// Compiled Sprout engine. Turns a program into JavaScript source once, then runs every bot from that code.
//
// It must behave exactly like the reference interpreter in interpreter.ts: the same action log, the same step counts,
// the same errors, the same 5,000-steps-per-tick limit, the same debug view. test/equivalence.test.ts checks that on every
// bundled program, every lesson and a few thousand random programs. When the two disagree, the reference is right.
//
// How it differs from the reference:
//  - One generator per bot (plus one per user function call) instead of one per expression and statement.
//  - Interpreter "events" (a line, a call, a loop pass, an action) are counted inline. A bot only yields to the
//    scheduler when it acts (its turn ends) or when it reaches the 5,000th event of the turn.
//  - Builtins are looked up once at compile time when the program never reassigns their name.
// What it keeps: variables live in Maps (so the debug view works), frames are pushed and popped, and breakpoints,
// line stepping and line heat all work, switched on by flags that the generated code checks on every statement.
//
// The generated source is built from fixed text plus JSON-encoded names and integers taken from the parsed program,
// never from raw program text, so a Sprout program cannot inject JavaScript.
import { briefBotCap, briefBudget, briefGoal, briefPlotCap, briefQuota, briefTwists } from './brief.ts';
import {
  applyAction, BUILDINGS, capacity, CROPS, FARM_OPS, forecast, isUnlocked, ITEMS, OP, openOrders, plotCost, botCost,
  scanAt, silosActive, siloCost, UNLOCKS, weatherAt, tickWorld,
} from '@tendril/sim/src/index.ts';
import type { LogEntry, World } from '@tendril/sim/src/index.ts';
import { rand } from '@tendril/sim/src/weather.ts';
import type { Expr, Stmt } from './ast.ts';
import type { Program } from './parser.ts';
import { SproutError } from './errors.ts';
import { explainSellRefusal } from './sell-note.ts';
import {
  binary, bounded, equal, index as listIndex, list, LoopFlow, MAX_COLLECTION, member, nameOf, nearestDrop, numeric, record, ReturnFlow,
  silos, StopFlow, text, truth,
} from './interpreter.ts';
import type { BotDebug, BotState, Frame, RecordValue, RunOptions, ScriptError, ScriptRun, StepResult, Value, OutputLine, FunctionValue } from './interpreter.ts';

/** Marks the compiled body on a function value. A symbol key stays invisible to Object.keys, so equality and printing are unchanged. */
const CODE = Symbol('sprout.code');
type Code = (R: FastRun, b: FastBot, fr: Frame) => Generator<number, Value, void>;
interface FastBot extends BotState { ev: number }
/** Values a bot yields to the scheduler. Anything else is never yielded. */
const Y_LIMIT = 0, Y_ACTION = 1, Y_PAUSE = 2;
const STEP_LIMIT = 5000;
const EMPTY: Value[] = Object.freeze([]) as unknown as Value[];
const CONSTANTS = new Set('north east south west carrot wheat clover pumpkin berry apple honey hive composter silo satchel all'.split(' '));
const IS_FARM: boolean[] = [];
for (const op of FARM_OPS) IS_FARM[op] = true;

// ---------------------------------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------------------------------

function lookup(R: FastRun, b: FastBot, fr: Frame, name: string): Value {
  let v = fr.locals.get(name);
  if (v !== undefined) return v;
  v = b.globals.get(name);
  if (v !== undefined) return v;
  if (name === 'shared') return R.shared;
  if (name === 'barn') return { x: 0, y: 0 };
  if (CONSTANTS.has(name)) return name;
  return { builtin: name };
}
function setName(fr: Frame, b: FastBot, name: string, v: Value): void { (fr.declarations.has(name) ? b.globals : fr.locals).set(name, v); }

const isInt = Number.isSafeInteger;
const add = (a: Value, b: Value): Value => { if (typeof a === 'number' && typeof b === 'number') { const r = a + b; if (isInt(a) && isInt(b) && isInt(r)) return r; } return binary('+', a, b); };
const sub = (a: Value, b: Value): Value => { if (typeof a === 'number' && typeof b === 'number') { const r = a - b; if (isInt(a) && isInt(b) && isInt(r)) return r; } return binary('-', a, b); };
const mul = (a: Value, b: Value): Value => { if (typeof a === 'number' && typeof b === 'number') { const r = a * b; if (isInt(a) && isInt(b) && isInt(r)) return r; } return binary('*', a, b); };
const div = (a: Value, b: Value): Value => { if (typeof a === 'number' && typeof b === 'number' && isInt(a) && isInt(b) && b !== 0) { const r = Math.floor(a / b); if (isInt(r)) return r; } return binary('/', a, b); };
const mod = (a: Value, b: Value): Value => { if (typeof a === 'number' && typeof b === 'number' && isInt(a) && isInt(b) && b !== 0) { const r = a - Math.floor(a / b) * b; if (isInt(r)) return r; } return binary('%', a, b); };
const lt = (a: Value, b: Value): Value => (typeof a === 'number' && typeof b === 'number' ? a < b : binary('<', a, b));
const le = (a: Value, b: Value): Value => (typeof a === 'number' && typeof b === 'number' ? a <= b : binary('<=', a, b));
const gt = (a: Value, b: Value): Value => (typeof a === 'number' && typeof b === 'number' ? a > b : binary('>', a, b));
const ge = (a: Value, b: Value): Value => (typeof a === 'number' && typeof b === 'number' ? a >= b : binary('>=', a, b));
const eq = (a: Value, b: Value): boolean => a === b || (typeof a === 'object' && typeof b === 'object' && equal(a, b));
const ne = (a: Value, b: Value): boolean => !eq(a, b);
const isIn = (a: Value, b: Value): boolean => member(a, b);
const notIn = (a: Value, b: Value): boolean => !member(a, b);
const neg = (v: Value): Value => bounded(-numeric(v));
const sizeOf = (v: Value): number => (typeof v === 'string' ? v.length : Array.isArray(v) ? v.length : 0);

const fld = (o: Value, name: string): Value => record(o)[name] ?? null;
const idx = (o: Value, i: Value): Value => {
  if (typeof o === 'string') return o[listIndex(i, o.length)]!;
  if (Array.isArray(o)) return o[listIndex(i, o.length)]!;
  return record(o)[nameOf(i)] ?? null;
};
function setField(o: Value, name: string, value: Value): void {
  const r = record(o);
  if (!Object.hasOwn(r, name) && Object.keys(r).length >= MAX_COLLECTION) throw new SproutError('Record is too large.');
  r[name] = value;
}
function setIndex(o: Value, i: Value, value: Value): void {
  if (Array.isArray(o)) o[listIndex(i, o.length)] = value;
  else { const r = record(o), key = nameOf(i); if (!Object.hasOwn(r, key) && Object.keys(r).length >= MAX_COLLECTION) throw new SproutError('Record is too large.'); r[key] = value; }
}
function mkRecord(R: FastRun, keys: string[], values: Value[]): RecordValue {
  const o = Object.create(null) as RecordValue;
  for (let i = 0; i < keys.length; i++) o[keys[i]!] = values[i]!;
  return R.charge(o, keys.length);
}
function interpolated(R: FastRun, s: string): string {
  if (s.length > MAX_COLLECTION) throw new SproutError('String is too long.');
  return R.charge(s, s.length);
}
function timesCount(R: FastRun, v: Value): number {
  const n = numeric(v);
  if (n > MAX_COLLECTION) throw new SproutError('Repeat at most 100,000 times in one block; use while for longer loops.');
  R.charge(0, Math.max(0, n));
  return n;
}
function eachValues(R: FastRun, v: Value): Value[] {
  const values = Array.isArray(v) ? v.slice() : typeof v === 'string' ? [...v] : Object.keys(record(v));
  R.charge(0, values.length);
  return values;
}
function rangeValues(R: FastRun, start: number, end: number, step?: number): Value[] {
  const delta = step !== undefined ? step : start <= end ? 1 : -1;
  if (!delta) throw new SproutError('Loop step cannot be zero.');
  const values: Value[] = [];
  for (let i = start; delta > 0 ? i <= end : i >= end; i = bounded(i + delta)) { if (values.length >= MAX_COLLECTION) throw new SproutError('Loop range is too large.'); values.push(i); }
  R.charge(0, values.length);
  return values;
}
function mkFunction(name: string, params: string[], body: Stmt[], code: Code): Value {
  const f = { functionName: name, params, body } as FunctionValue & { [CODE]?: Code };
  f[CODE] = code;
  return f;
}

// Actions ---------------------------------------------------------------------------------------------------------------
// An action applies at once and is logged. A bot's own action also ends its turn: it sets R.did and the generated code yields.
function act0(R: FastRun, b: FastBot, op: number): number {
  const w = R.world, farm = IS_FARM[op] === true;
  const entry: LogEntry = [w.tick, farm ? -1 : b.bot, op];
  const result = applyAction(w, entry); R.pending.push(entry);
  if (!farm) R.did = true;
  return result;
}
function act1(R: FastRun, b: FastBot, op: number, a: number): number {
  const w = R.world, farm = IS_FARM[op] === true;
  const entry: LogEntry = [w.tick, farm ? -1 : b.bot, op, a];
  const result = applyAction(w, entry); R.pending.push(entry);
  if (!farm) R.did = true;
  return result;
}
function act2(R: FastRun, b: FastBot, op: number, a: number, c: number): number {
  const w = R.world, farm = IS_FARM[op] === true;
  const entry: LogEntry = [w.tick, farm ? -1 : b.bot, op, a, c];
  const result = applyAction(w, entry); R.pending.push(entry);
  if (!farm) R.did = true;
  return result;
}

const need = (name: string, a: Value[], i: number): Value => { if (i >= a.length) throw new SproutError(`${name} needs more arguments.`); return a[i]!; };
const ITEM_INDEX = new Map<string, number>();
ITEMS.forEach((x, i) => { if (!ITEM_INDEX.has(x.name)) ITEM_INDEX.set(x.name, i); });
const ITEM_NAMES = ITEMS.slice(1).map((x) => x.name);
const UNLOCK_INDEX = new Map<string, number>();
UNLOCKS.forEach((x, i) => { if (!UNLOCK_INDEX.has(x.name)) UNLOCK_INDEX.set(x.name, i); });
const item = (name: string, a: Value[], i: number): number => { const n = ITEM_INDEX.get(nameOf(need(name, a, i))) ?? -1; if (n < 1) throw new SproutError('Unknown item name.'); return n; };
const unlockIndex = (name: string, a: Value[], i: number): number => { const n = UNLOCK_INDEX.get(nameOf(need(name, a, i))) ?? -1; if (n < 0) throw new SproutError('Unknown research name.'); return n; };
const int = (name: string, a: Value[], i: number): number => numeric(need(name, a, i));
const cargo = (stock: ArrayLike<number>): RecordValue => { const o: RecordValue = {}; for (let i = 0; i < ITEM_NAMES.length; i++) o[ITEM_NAMES[i]!] = stock[i + 1] ?? 0; return o; };
const DIRECTIONS = ['north', 'east', 'south', 'west'];

type Handler = (R: FastRun, b: FastBot, a: Value[]) => Value;
/** Builtins that return at once. Acting ones set R.did and the caller yields; see act0. */
const HANDLERS = new Map<string, Handler>();
const def = (name: string, fn: Handler): void => { HANDLERS.set(name, fn); };
const scanned = (w: World, x: number, y: number): Value => { const t = scanAt(w, x, y); return t ? { ...t, x, y, crop: t.crop ? CROPS[t.crop]!.name : null, building: t.building ? BUILDINGS[t.building]!.name : null, ripe: t.stage === 3, empty: !t.crop && !t.building && !t.barn } : null; };

def('till', (R, b) => act0(R, b, OP.till) === 1);
def('water', (R, b) => act0(R, b, OP.water) === 1);
def('clear', (R, b) => act0(R, b, OP.clear) === 1);
def('fertilize', (R, b) => act0(R, b, OP.fertilize) === 1);
def('harvest', (R, b) => act0(R, b, OP.harvest));
def('deposit', (R, b) => act0(R, b, OP.deposit));
def('compost', (R, b) => act0(R, b, OP.compost));
def('move', (R, b, a) => { const d = DIRECTIONS.indexOf(nameOf(need('move', a, 0))); if (d < 0) throw new SproutError('Move north, east, south or west.'); return act1(R, b, OP.move, d) === 1; });
def('plant', (R, b, a) => { const c = item('plant', a, 0); if (c > 6) throw new SproutError('Plant a crop, not honey or compost.'); return act1(R, b, OP.plant, c) === 1; });
def('build', (R, b, a) => { const k = BUILDINGS.findIndex((x) => x.name === nameOf(need('build', a, 0))); if (k < 1) throw new SproutError('Build a hive, composter or silo.'); return act1(R, b, OP.build, k) === 1; });
def('unlock', (R, b, a) => act1(R, b, OP.unlock, unlockIndex('unlock', a, 0)) === 1);
def('buy_plot', (R, b, a) => act2(R, b, OP.buyPlot, int('buy_plot', a, 0), int('buy_plot', a, 1)) === 1);
def('sell_plot', (R, b, a) => {
  const px = int('sell_plot', a, 0), py = int('sell_plot', a, 1);
  const paid = act2(R, b, OP.sellPlot, px, py);
  if (paid === 0) explainSellRefusal(R.output, R.sellMemo, R.world, b.bot, px, py);
  return paid;
});
def('buy_bot', (R, b) => { const n = act0(R, b, OP.buyBot); return n ? n - 1 : null; });
def('sell', (R, b, a) => {
  const c = item('sell', a, 0); if (c > 7) throw new SproutError('Compost cannot be sold.');
  const n = nameOf(need('sell', a, 1)) === 'all' ? R.world.stock[c]! : int('sell', a, 1);
  if (n < 1) return 0;
  return act2(R, b, OP.sell, c, n);
});
def('deliver', (R, b, a) => { const order = need('deliver', a, 0); const id = typeof order === 'number' ? order : numeric(record(order).id!); return act1(R, b, OP.deliver, id); });

def('scan', (R, b) => { const bot = R.world.bots[b.bot]!; return scanned(R.world, bot.x, bot.y); });
def('scan_at', (R, _b, a) => scanned(R.world, int('scan_at', a, 0), int('scan_at', a, 1)));
def('position', (R, b) => { const bot = R.world.bots[b.bot]!; return { x: bot.x, y: bot.y }; });
def('my_id', (_R, b) => b.bot);
def('tick', (R) => R.world.tick);
def('coins', (R) => R.world.coins);
def('bots', (R) => R.world.bots.length);
def('load', (R, b) => cargo(R.world.bots[b.bot]!.load));
def('stock', (R) => cargo(R.world.stock));
def('carried', (R, b) => [...R.world.bots[b.bot]!.load].reduce((n, x) => n + x, 0));
def('capacity', (R) => capacity(R.world));
def('owns', (R, _b, a) => scanAt(R.world, int('owns', a, 0), int('owns', a, 1)) !== null);
def('plots', (R) => R.world.plots.map((p) => ({ px: p.px, py: p.py })));
def('tiles', (R) => {
  const w = R.world, out: Value[] = [];
  if (w.plots.length * 64 > MAX_COLLECTION) throw new SproutError('tiles() exceeds 100,000 tiles; iterate plots instead.');
  for (const p of w.plots) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out.push({ x: p.px * 8 + x, y: p.py * 8 + y });
  return R.charge(out, out.length * 2);
});
def('forecast', (R, _b, a) => { const horizon = int('forecast', a, 0); if (horizon < 0 || horizon > 100_000) throw new SproutError('Forecast between 0 and 100,000 ticks.'); return forecast(R.world, horizon).map((s) => ({ ...s })); });
def('weather', (R) => weatherAt(R.world, R.world.tick));
def('orders', (R) => openOrders(R.world).map((o) => ({ ...o, crop: CROPS[o.crop]!.name })));
def('plot_cost', (R) => plotCost(R.world));
def('bot_cost', (R) => botCost(R.world));
def('unlocked', (R, _b, a) => isUnlocked(R.world, unlockIndex('unlocked', a, 0)));
def('unlock_cost', (_R, _b, a) => UNLOCKS[unlockIndex('unlock_cost', a, 0)]!.price);
def('price', (R, _b, a) => { const i = item('price', a, 0); if (i > 7) throw new SproutError('Compost has no price.'); return R.world.prices ? R.world.prices[i]! : ITEMS[i]!.price; });
def('silo_cost', (R) => (silosActive(R.world) ? siloCost(R.world) : 0));
def('silos', (R) => silos(R.world));
def('goal', (R) => briefGoal(R.world)); def('budget', (R) => briefBudget(R.world)); def('twists', (R) => briefTwists(R.world));
def('quota', (R, _b, a) => briefQuota(R.world, item('quota', a, 0))); def('bot_cap', (R) => briefBotCap(R.world)); def('plot_cap', (R) => briefPlotCap(R.world));
def('nearest_drop', (R, b) => nearestDrop(R.world, R.world.bots[b.bot]!));
const say: Handler = (R, b, a) => { if (R.output.length < 2000) R.output.push({ bot: b.bot, tick: R.world.tick, text: a.map((v) => text(v)).join(' ').slice(0, 2000) }); return null; };
def('say', say); def('print', say);
def('len', (_R, _b, a) => { const v = need('len', a, 0); return typeof v === 'string' || Array.isArray(v) ? v.length : Object.keys(record(v)).length; });
def('str', (_R, _b, a) => text(need('str', a, 0)));
def('int', (_R, _b, a) => { const v = need('int', a, 0); const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : typeof v === 'number' ? v : NaN; return Number.isSafeInteger(n) ? n : null; });
def('abs', (_R, _b, a) => Math.abs(int('abs', a, 0)));
const minmax = (name: 'min' | 'max'): Handler => (_R, _b, a) => {
  const values = a.length === 1 && Array.isArray(a[0]) ? a[0] : a;
  if (!values.length) throw new SproutError('Supply at least one integer.');
  return values.map(numeric).reduce((x, y) => (name === 'min' ? Math.min(x, y) : Math.max(x, y)));
};
def('min', minmax('min')); def('max', minmax('max'));
def('range', (R, _b, a) => {
  const start = a.length === 1 ? 0 : int('range', a, 0), end = a.length === 1 ? int('range', a, 0) : int('range', a, 1);
  if (end - start > MAX_COLLECTION) throw new SproutError('Range is too large.');
  const out: Value[] = []; for (let i = start; i < end; i++) out.push(i);
  return R.charge(out, out.length);
});
def('append', (_R, _b, a) => { const xs = list(need('append', a, 0)); if (xs.length >= MAX_COLLECTION) throw new SproutError('List is too long.'); xs.push(need('append', a, 1)); return null; });
def('insert', (_R, _b, a) => { const xs = list(need('insert', a, 0)); if (xs.length >= MAX_COLLECTION) throw new SproutError('List is too long.'); xs.splice(listIndex(need('insert', a, 1), xs.length, true), 0, need('insert', a, 2)); return null; });
def('pop', (_R, _b, a) => { const xs = list(need('pop', a, 0)); if (!xs.length) throw new SproutError('Cannot pop an empty list.'); return xs.pop()!; });
def('remove', (_R, _b, a) => { const xs = list(need('remove', a, 0)); return xs.splice(listIndex(need('remove', a, 1), xs.length), 1)[0]!; });
def('keys', (_R, _b, a) => Object.keys(record(need('keys', a, 0))));
def('contains', (_R, _b, a) => member(need('contains', a, 1), need('contains', a, 0)));
def('reversed', (_R, _b, a) => list(need('reversed', a, 0)).slice().reverse());
def('sorted', (_R, _b, a) => {
  const xs = list(need('sorted', a, 0)).slice();
  if (xs.some((v) => typeof v !== typeof xs[0] || (typeof v !== 'number' && typeof v !== 'string'))) throw new SproutError('Sort a list of integers or a list of strings.');
  return xs.sort((x, y) => (typeof x === 'number' ? x - (y as number) : x === y ? 0 : (x as string) < (y as string) ? -1 : 1));
});
def('random', (_R, b, a) => { const upper = int('random', a, 0); if (upper < 1) throw new SproutError('random needs a positive upper bound.'); b.rng = rand(b.rng); return b.rng % upper; });
def('distance', (_R, _b, a) => { const x = record(need('distance', a, 0)), y = record(need('distance', a, 1)); return bounded(Math.abs(numeric(x.x!) - numeric(y.x!)) + Math.abs(numeric(x.y!) - numeric(y.y!))); });

/** Event bookkeeping for a yield in a helper generator (the generated code does the same inline). */
function* actionEvent(R: FastRun, b: FastBot, line: number): Generator<number, void, void> {
  b.line = line; R.heat[line] = R.heat[line]! + 1; b.ev++; yield Y_ACTION;
}
function* waitCommand(R: FastRun, b: FastBot, a: Value[], line: number): Generator<number, Value, void> {
  let n = int('wait', a, 0);
  if (n < 1) throw new SproutError('Wait at least one tick.');
  while (n > 0) { const step = Math.min(n, 1000); act1(R, b, OP.wait, step); R.did = false; yield* actionEvent(R, b, line); n -= step; }
  return true;
}
function* goToCommand(R: FastRun, b: FastBot, a: Value[], line: number): Generator<number, Value, void> {
  const bot = R.world.bots[b.bot]!;
  const v = need('go_to', a, 0), x = typeof v === 'object' && v ? numeric(record(v).x!) : int('go_to', a, 0), y = typeof v === 'object' && v ? numeric(record(v).y!) : int('go_to', a, 1);
  while (bot.x !== x || bot.y !== y) {
    const d = bot.x !== x ? bot.x < x ? 1 : 3 : bot.y < y ? 2 : 0;
    const moved = act1(R, b, OP.move, d); R.did = false;
    yield* actionEvent(R, b, line);
    if (!moved) return false;
  }
  return true;
}
function* callBuiltin(R: FastRun, b: FastBot, name: string, a: Value[], line: number): Generator<number, Value, void> {
  if (name === 'wait') return yield* waitCommand(R, b, a, line);
  if (name === 'go_to') return yield* goToCommand(R, b, a, line);
  const h = HANDLERS.get(name);
  if (!h) throw new SproutError(`I don't know the command ${name}.`);
  const v = h(R, b, a);
  if (R.did) { R.did = false; yield* actionEvent(R, b, line); }
  return v;
}
/** A call whose callee is not known at compile time: a user function, or a builtin reached through a variable. */
function* callValue(R: FastRun, b: FastBot, fn: Value, a: Value[], line: number): Generator<number, Value, void> {
  if (fn && typeof fn === 'object' && 'functionName' in fn) {
    const f = fn as FunctionValue & { [CODE]?: Code };
    if (b.frames.length > 200) throw new SproutError('Too many nested function calls (maximum 200).');
    if (a.length !== f.params.length) throw new SproutError(`${f.functionName} needs ${f.params.length} arguments.`);
    const locals = new Map<string, Value>();
    for (let i = 0; i < f.params.length; i++) locals.set(f.params[i]!, a[i]!);
    const frame: Frame = { fn: f.functionName, line, locals, declarations: new Set() };
    b.frames.push(frame);
    try {
      const code = f[CODE];
      if (!code) { if (Array.isArray(f.body) && f.body.length === 0) return null; throw new SproutError('Expected a record.'); }
      return yield* code(R, b, frame);
    } finally { b.frames.pop(); }
  }
  if (!fn || typeof fn !== 'object' || !('builtin' in fn)) throw new SproutError(`${text(fn)} is not a command.`);
  return yield* callBuiltin(R, b, String(fn.builtin), a, line);
}

// ---------------------------------------------------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------------------------------------------------

interface Ctx { inFunction: boolean; loops: number; safeSet: boolean }
const BIN_HELPER: Record<string, string> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge', in: 'isIn', 'not in': 'notIn' };
const BOOLEAN_OPS = new Set(['==', '!=', '<', '<=', '>', '>=', 'in', 'not in']);
const lit = (v: string | number): string => JSON.stringify(v);

interface Analysis { assigned: Set<string>; strayFlow: boolean; maxLine: number }
function analyze(program: Program): Analysis {
  const assigned = new Set<string>(); let strayFlow = false, maxLine = 1;
  const visitExpr = (e: Expr): void => {
    maxLine = Math.max(maxLine, e.pos.line);
    switch (e.k) {
      case 'interp': for (const p of e.parts) if (typeof p !== 'string') visitExpr(p); break;
      case 'list': e.items.forEach(visitExpr); break;
      case 'record': e.entries.forEach((x) => visitExpr(x.value)); break;
      case 'unary': visitExpr(e.e); break;
      case 'logic': case 'binary': visitExpr(e.l); visitExpr(e.r); break;
      case 'call': visitExpr(e.callee); e.args.forEach(visitExpr); break;
      case 'index': visitExpr(e.obj); visitExpr(e.idx); break;
      case 'field': visitExpr(e.obj); break;
      default: break;
    }
  };
  const visit = (body: Stmt[], loops: number): void => {
    for (const s of body) {
      maxLine = Math.max(maxLine, s.pos.line);
      switch (s.k) {
        case 'assign': if (s.target.k === 'name') assigned.add(s.target.name); visitExpr(s.target); visitExpr(s.value); break;
        case 'expr': visitExpr(s.e); break;
        case 'if': for (const br of s.branches) { visitExpr(br.cond); visit(br.body, loops); } if (s.orelse) visit(s.orelse, loops); break;
        case 'while': visitExpr(s.cond); visit(s.body, loops + 1); break;
        case 'forever': visit(s.body, loops + 1); break;
        case 'times': visitExpr(s.count); visit(s.body, loops + 1); break;
        case 'foreach': assigned.add(s.name); visitExpr(s.iter); visit(s.body, loops + 1); break;
        case 'forrange': assigned.add(s.name); visitExpr(s.from); visitExpr(s.to); if (s.step) visitExpr(s.step); visit(s.body, loops + 1); break;
        case 'define': assigned.add(s.name); for (const p of s.params) assigned.add(p.name); visit(s.body, 0); break;
        case 'return': if (s.value) visitExpr(s.value); break;
        case 'break': case 'continue': if (loops === 0) strayFlow = true; break;
        default: break;
      }
    }
  };
  visit(program.body, 0);
  return { assigned, strayFlow, maxLine };
}

interface Compiled { main: Code; heatSize: number }
export interface CompileFlags { budgeted: boolean; heat: boolean }

class CodeGen {
  private fnCode: string[] = []; private consts: { params: string[]; body: Stmt[] }[] = []; private used = new Set<string>();
  private uid = 0;
  constructor(private program: Program, private an: Analysis, private flags: CompileFlags) {}
  private id(prefix: string): string { return `${prefix}${++this.uid}`; }
  private event(line: number): string { return `b.line=${line};${this.flags.heat ? `heat[${line}]++;` : ''}if(++b.ev===${STEP_LIMIT})yield ${Y_LIMIT};`; }
  /** The same event as an expression, for use inside a larger expression. */
  private eventExpr(line: number): string { return `(b.line=${line},${this.flags.heat ? `heat[${line}]++,` : ''}++b.ev===${STEP_LIMIT}&&(yield ${Y_LIMIT}))`; }
  private handler(name: string): string { this.used.add(name); return `h_${name}`; }

  build(): string {
    const body = this.block(this.program.body, { inFunction: false, loops: 0, safeSet: true });
    const main = `function* main(R,b,fr){const heat=R.heat;let t;try{${body}}catch(e){if(!(e instanceof StopFlow))throw e;}return null;}`;
    const handlers = [...this.used].map((n) => `const h_${n}=HF.get(${lit(n)});`).join('');
    return `"use strict";const {${RUNTIME_NAMES.join(',')}}=L;${handlers}${this.fnCode.join('\n')}\n${main}\nreturn main;`;
  }
  constantsArray(): { params: string[]; body: Stmt[] }[] { return this.consts; }

  private block(body: Stmt[], ctx: Ctx): string { return body.map((s) => this.stmt(s, ctx)).join('\n'); }
  private prologue(line: number): string {
    return `fr.line=${line};b.line=${line};${this.flags.heat ? `heat[${line}]++;` : ''}if(R.dbg&&R.hit(${line})){yield ${Y_PAUSE};}else if(++b.ev===${STEP_LIMIT}){yield ${Y_LIMIT};}`;
  }
  private setVar(name: string, value: string, ctx: Ctx): string {
    return ctx.safeSet ? `fr.locals.set(${lit(name)},${value});` : `setName(fr,b,${lit(name)},${value});`;
  }
  private cond(e: Expr, ctx: Ctx): string {
    const x = this.expr(e, ctx);
    const boolean = (e.k === 'binary' && BOOLEAN_OPS.has(e.op)) || e.k === 'logic' || (e.k === 'unary' && e.op === 'not');
    return boolean ? x : `truth(${x})`;
  }
  /** `for` loop bodies. With stray break/continue in the program a loop must also catch them thrown by called functions. */
  private loopBody(inner: string, line: number): string {
    const work = this.event(line);
    if (!this.an.strayFlow) return `${work}${inner}`;
    return `${work}try{${inner}}catch(x){if(!(x instanceof LoopFlow))throw x;if(x.kind==='break')break;}`;
  }
  private stmt(s: Stmt, ctx: Ctx): string {
    const L = s.pos.line, pro = this.prologue(L);
    const inLoop: Ctx = { ...ctx, loops: ctx.loops + 1 };
    switch (s.k) {
      case 'pass': return pro;
      case 'stop': return `${pro}throw new StopFlow();`;
      case 'global': return `${pro}${s.names.map((n) => `fr.declarations.add(${lit(n.name)});`).join('')}`;
      case 'expr': return `${pro}${this.expr(s.e, ctx)};`;
      case 'return': {
        const v = s.value ? this.expr(s.value, ctx) : 'null';
        return ctx.inFunction ? `${pro}return ${v};` : `${pro}throw new ReturnFlow(${v});`;
      }
      case 'break': case 'continue': return ctx.loops > 0 ? `${pro}${s.k};` : `${pro}throw ${s.k === 'break' ? 'BREAK' : 'CONTINUE'};`;
      case 'define': {
        const code = this.func(s);
        const k = this.consts.push({ params: s.params.map((p) => p.name), body: s.body }) - 1;
        return `${pro}${this.setVar(s.name, `mkFunction(${lit(s.name)},K[${k}].params,K[${k}].body,${code})`, ctx)}`;
      }
      case 'assign': {
        const v = this.expr(s.value, ctx), t = s.target;
        if (s.op === '=') return `${pro}${this.assignTo(t, v, ctx)}`;
        const x = this.id('v'), y = this.id('y');
        const op = BIN_HELPER[s.op[0]!]!;
        const result = this.flags.budgeted ? `chargeSize(R,${op}(${y},${x}))` : `${op}(${y},${x})`;
        return `${pro}{const ${x}=${v};const ${y}=${this.expr(t, ctx)};${this.assignTo(t, result, ctx)}}`;
      }
      case 'if': {
        let out = `${pro}`;
        s.branches.forEach((br, i) => { out += `${i ? 'else ' : ''}if(${this.cond(br.cond, ctx)}){${this.block(br.body, ctx)}}`; });
        if (s.orelse) out += `else{${this.block(s.orelse, ctx)}}`;
        return out;
      }
      case 'while': return `${pro}while(${this.cond(s.cond, ctx)}){${this.loopBody(this.block(s.body, inLoop), L)}}`;
      case 'forever': return `${pro}for(;;){${this.loopBody(this.block(s.body, inLoop), L)}}`;
      case 'times': {
        const n = this.id('n'), i = this.id('i');
        return `${pro}{const ${n}=timesCount(R,${this.expr(s.count, ctx)});for(let ${i}=0;${i}<${n};${i}++){${this.loopBody(this.block(s.body, inLoop), L)}}}`;
      }
      case 'foreach': {
        const vs = this.id('vs'), x = this.id('x');
        return `${pro}{const ${vs}=eachValues(R,${this.expr(s.iter, ctx)});for(const ${x} of ${vs}){${this.loopBody(`${this.setVar(s.name, x, ctx)}${this.block(s.body, inLoop)}`, L)}}}`;
      }
      case 'forrange': {
        const vs = this.id('vs'), x = this.id('x');
        const args = `numeric(${this.expr(s.from, ctx)}),numeric(${this.expr(s.to, ctx)})${s.step ? `,numeric(${this.expr(s.step, ctx)})` : ''}`;
        return `${pro}{const ${vs}=rangeValues(R,${args});for(const ${x} of ${vs}){${this.loopBody(`${this.setVar(s.name, x, ctx)}${this.block(s.body, inLoop)}`, L)}}}`;
      }
    }
  }
  private assignTo(t: Expr, value: string, ctx: Ctx): string {
    if (t.k === 'name') return this.setVar(t.name, value, ctx);
    if (t.k === 'field') return `setField(${this.expr(t.obj, ctx)},${lit(t.name)},${value});`;
    if (t.k === 'index') return `setIndex(${this.expr(t.obj, ctx)},${this.expr(t.idx, ctx)},${value});`;
    return '';
  }
  /** One user function: its own generator, with the frame its caller already pushed. */
  private func(s: Extract<Stmt, { k: 'define' }>): string {
    const name = this.id('f');
    const safeSet = !hasGlobal(s.body);
    const body = this.block(s.body, { inFunction: true, loops: 0, safeSet });
    this.fnCode.push(`function* ${name}(R,b,fr){const heat=R.heat;let t;${body}\nreturn null;}`);
    return name;
  }
  private expr(e: Expr, ctx: Ctx): string {
    switch (e.k) {
      case 'int': return String(e.v);
      case 'str': return lit(e.v);
      case 'bool': return e.v ? 'true' : 'false';
      case 'none': return 'null';
      case 'name': {
        if (this.an.assigned.has(e.name)) return `lookup(R,b,fr,${lit(e.name)})`;
        if (e.name === 'shared') return 'R.shared';
        if (e.name === 'barn') return '({x:0,y:0})';
        if (CONSTANTS.has(e.name)) return lit(e.name);
        return `({builtin:${lit(e.name)}})`;
      }
      case 'interp': {
        const parts = e.parts.map((x) => (typeof x === 'string' ? lit(x) : `text(${this.expr(x, ctx)})`));
        return `interpolated(R,${parts.length ? parts.join('+') : '""'})`;
      }
      case 'list': { const xs = `[${e.items.map((x) => this.expr(x, ctx)).join(',')}]`; return this.flags.budgeted ? `R.charge(${xs},${e.items.length})` : xs; }
      case 'record': return `mkRecord(R,${lit(e.entries.map((x) => x.key) as unknown as string)},[${e.entries.map((x) => this.expr(x.value, ctx)).join(',')}])`;
      case 'unary': return e.op === 'not' ? `!truth(${this.expr(e.e, ctx)})` : `neg(${this.expr(e.e, ctx)})`;
      case 'logic': return `(${this.cond(e.l, ctx)}${e.op === 'and' ? '&&' : '||'}${this.cond(e.r, ctx)})`;
      case 'binary': {
        const r = `${BIN_HELPER[e.op]}(${this.expr(e.l, ctx)},${this.expr(e.r, ctx)})`;
        return this.flags.budgeted ? `chargeSize(R,${r})` : r;
      }
      case 'field': return `fld(${this.expr(e.obj, ctx)},${lit(e.name)})`;
      case 'index': return `idx(${this.expr(e.obj, ctx)},${this.expr(e.idx, ctx)})`;
      case 'call': return this.call(e, ctx);
    }
  }
  private call(e: Extract<Expr, { k: 'call' }>, ctx: Ctx): string {
    const p = e.pos.line, work = this.eventExpr(p);
    const args = e.args.length ? `[${e.args.map((x) => this.expr(x, ctx)).join(',')}]` : 'EMPTY';
    const callee = e.callee;
    if (callee.k === 'name' && !this.an.assigned.has(callee.name)) {
      const name = callee.name;
      if (name === 'wait') return `(${work},yield* waitCommand(R,b,${args},${p}))`;
      if (name === 'go_to') return `(${work},yield* goToCommand(R,b,${args},${p}))`;
      if (HANDLERS.has(name)) {
        const h = this.handler(name);
        if (ACTING.has(name)) return `(${work},t=${h}(R,b,${args}),R.did&&(R.did=false,b.line=${p},${this.flags.heat ? `heat[${p}]++,` : ''}b.ev++,(yield ${Y_ACTION})),t)`;
        return `(${work},${h}(R,b,${args}))`;
      }
    }
    return `(${work},yield* callValue(R,b,${this.expr(callee, ctx)},${args},${p}))`;
  }
}
const ACTING = new Set(['till', 'water', 'clear', 'fertilize', 'harvest', 'deposit', 'compost', 'move', 'plant', 'build', 'unlock', 'buy_plot', 'sell_plot', 'buy_bot', 'sell', 'deliver']);
function hasGlobal(body: Stmt[]): boolean {
  // `global` inside a nested define belongs to that function's own frame, so it is not looked at here.
  for (const s of body) {
    if (s.k === 'global') return true;
    if (s.k === 'if') { for (const br of s.branches) if (hasGlobal(br.body)) return true; if (s.orelse && hasGlobal(s.orelse)) return true; }
    else if (s.k === 'while' || s.k === 'forever' || s.k === 'times' || s.k === 'foreach' || s.k === 'forrange') { if (hasGlobal(s.body)) return true; }
  }
  return false;
}

const BREAK = new LoopFlow('break'), CONTINUE = new LoopFlow('continue');
function chargeSize(R: FastRun, v: Value): Value { return R.charge(v, sizeOf(v)); }
const RUNTIME: Record<string, unknown> = {
  lookup, setName, add, sub, mul, div, mod, lt, le, gt, ge, eq, ne, isIn, notIn, neg, truth, text, numeric, fld, idx, setField, setIndex, mkRecord,
  interpolated, timesCount, eachValues, rangeValues, mkFunction, callValue, waitCommand, goToCommand, chargeSize, EMPTY, BREAK, CONTINUE,
  StopFlow, ReturnFlow, LoopFlow, HF: HANDLERS,
};
const RUNTIME_NAMES = Object.keys(RUNTIME);

const cache = new Map<string, Compiled | null>();
/** Compile once per distinct (program text, flags); null when this environment cannot build functions from text. */
function compileProgram(program: Program, source: string, flags: CompileFlags): Compiled | null {
  const key = `${flags.budgeted ? 1 : 0}${flags.heat ? 1 : 0}${source}`;
  if (cache.has(key)) return cache.get(key)!;
  let result: Compiled | null;
  try {
    const an = analyze(program);
    const gen = new CodeGen(program, an, flags);
    const js = gen.build();
    const consts = gen.constantsArray();
    const factory = new Function('L', 'K', js) as (L: Record<string, unknown>, K: unknown) => Code;
    result = { main: factory(RUNTIME, consts), heatSize: an.maxLine + 2 };
  } catch {
    result = null;
  }
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------------------------------------------------

export class FastRun implements ScriptRun {
  readonly engine = 'compiled' as const;
  pending: LogEntry[] = []; errors: ScriptError[] = []; output: OutputLine[] = [];
  sellMemo = new Map<string, number>();
  steps = 0; exhausted = false;
  shared: RecordValue = Object.create(null) as RecordValue;
  heat: Float64Array;
  /** True while breakpoints or line stepping are active: every statement then asks hit(). */
  dbg = false;
  /** Set by an action that ends the calling bot's turn. */
  did = false;
  private bots: FastBot[] = []; private breakpoints = new Set<number>(); private singleLine = false; private cursor = 0;
  private closed = false; private paused: { bot: number; line: number } | null = null; private allocated = 0;
  constructor(readonly world: World, private compiled: Compiled, private allocationBudget = Infinity, private stepBudget = Infinity) {
    this.heat = new Float64Array(compiled.heatSize);
    this.ensureBots();
  }
  charge<T extends Value>(value: T, size: number): T {
    this.allocated += size + 1;
    if (this.allocated > this.allocationBudget) throw new SproutError('The program used too much memory.');
    return value;
  }
  hit(line: number): boolean { return this.singleLine || this.breakpoints.has(line); }
  private ensureBots(): void {
    while (this.bots.length < this.world.bots.length) {
      const bot = this.bots.length;
      const state = { bot, line: null, status: 'ready', globals: new Map(), frames: [], rng: ((this.world.seed ^ Math.imul(bot + 1, 0x9E3779B1)) >>> 0) || 1, generator: null!, ev: 0 } as FastBot;
      const frame: Frame = { fn: '<program>', line: 1, locals: state.globals, declarations: new Set() };
      state.frames.push(frame);
      state.generator = this.compiled.main(this, state, frame) as unknown as BotState['generator'];
      this.bots.push(state);
    }
  }
  private advance(ticks: number, singleLine: boolean): StepResult {
    if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks > 20_000) throw new SproutError('Step between zero and 20,000 ticks.');
    const start = this.world.tick; this.paused = null;
    if (this.closed) return { ticks: 0, paused: null };
    this.singleLine = singleLine; this.dbg = singleLine || this.breakpoints.size > 0;
    try {
      while (this.world.tick - start < ticks) {
        this.ensureBots();
        while (this.cursor < this.bots.length) {
          const b = this.bots[this.cursor]!;
          if (b.status === 'done' || b.status === 'error' || this.world.bots[b.bot]!.busyUntil > this.world.tick) { if (b.status !== 'done' && b.status !== 'error') b.status = 'busy'; this.cursor++; continue; }
          b.status = 'ready'; b.ev = 0;
          try {
            const result = (b.generator as unknown as Generator<number, Value, void>).next();
            let worked: number;
            if (result.done) { b.status = 'done'; worked = b.ev + 1; }
            else if (result.value === Y_ACTION) { b.status = 'busy'; worked = b.ev; }
            else if (result.value === Y_PAUSE) { b.status = 'paused'; this.paused = { bot: b.bot, line: b.line! }; return { ticks: this.world.tick - start, paused: this.paused }; }
            else { worked = STEP_LIMIT + 1; if (b.status === 'ready') b.status = 'thinking'; }
            this.steps += Math.min(worked, STEP_LIMIT);
            if (this.steps > this.stepBudget) { this.exhausted = true; this.close(); return { ticks: this.world.tick - start, paused: null }; }
          } catch (e) {
            b.status = 'error'; this.errors.push({ bot: b.bot, line: b.line ?? 1, col: 1, tick: this.world.tick, message: e instanceof LoopFlow ? `${e.kind} needs a surrounding loop.` : e instanceof ReturnFlow ? 'return needs a surrounding function.' : e instanceof Error ? e.message : 'Program stopped.' });
          }
          this.cursor++; this.ensureBots();
        }
        tickWorld(this.world); this.cursor = 0;
        if (singleLine) break;
      }
      return { ticks: this.world.tick - start, paused: this.paused };
    } finally {
      this.singleLine = false; this.dbg = this.breakpoints.size > 0;
    }
  }
  step(ticks: number): StepResult { return this.advance(ticks, false); }
  stepLine(): StepResult { return this.advance(1, true); }
  setBreakpoints(lines: Iterable<number>): void { this.breakpoints = new Set([...lines].filter((n) => Number.isInteger(n) && n > 0)); this.dbg = this.breakpoints.size > 0; }
  debug(): BotDebug[] { return this.bots.map((b) => ({ bot: b.bot, line: b.line, status: b.status, vars: [...new Map([...b.globals, ...b.frames.at(-1)!.locals])].slice(0, 40).map(([name, value]) => ({ name, value: text(value).slice(0, 200) })), stack: b.frames.map((f) => ({ fn: f.fn, line: f.line })) })); }
  lineHeat(): Map<number, number> { const m = new Map<number, number>(); for (let i = 0; i < this.heat.length; i++) if (this.heat[i]) m.set(i, this.heat[i]!); return m; }
  takeLog(): LogEntry[] { return this.pending.splice(0); }
  close(): void { this.closed = true; this.bots = []; }
}

/** The compiled engine for an already-parsed program, or null when it cannot be built here (callers fall back to the reference). */
export function createCompiledRun(world: World, program: Program, source: string, opts?: RunOptions): FastRun | null {
  const budgeted = opts?.allocationBudget !== undefined && opts.allocationBudget !== Infinity;
  const compiled = compileProgram(program, source, { budgeted, heat: true });
  return compiled ? new FastRun(world, compiled, opts?.allocationBudget, opts?.stepBudget) : null;
}

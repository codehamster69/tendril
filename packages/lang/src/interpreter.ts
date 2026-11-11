import {
  applyAction, BUILDINGS, capacity, CROPS, forecast, isUnlocked, ITEMS, OP, openOrders, plotCost, botCost,
  scanAt, tickWorld, UNLOCKS, weatherAt,
} from '@tendril/sim/src/index.ts';
import type { LogEntry, World } from '@tendril/sim/src/index.ts';
import type { Expr, Stmt } from './ast.ts';
import { compile, type CompileOptions, type Program } from './parser.ts';
import { CompileError, SproutError } from './errors.ts';
import { rand } from '@tendril/sim/src/weather.ts';

type RecordValue = { [key: string]: Value };
type Value = number | string | boolean | null | Value[] | RecordValue | FunctionValue | Builtin;
interface FunctionValue { functionName: string; params: string[]; body: Stmt[] }
interface Builtin { builtin: string }
interface Frame { fn: string; line: number; locals: Map<string, Value>; declarations: Set<string> }
interface BotState {
  bot: number; line: number | null; status: BotDebug['status']; globals: Map<string, Value>; frames: Frame[];
  generator: Generator<Event, void, void>; rng: number;
}
interface Event { k: 'line' | 'work' | 'action'; line: number }
export interface ScriptError { bot: number; line: number; col: number; tick: number; message: string }
export interface OutputLine { bot: number; tick: number; text: string }
export interface BotDebug { bot: number; line: number | null; status: 'ready' | 'busy' | 'thinking' | 'paused' | 'done' | 'error'; vars: { name: string; value: string }[]; stack: { fn: string; line: number }[] }
export interface StepResult { ticks: number; paused: { bot: number; line: number } | null }
export interface ScriptRun {
  readonly world: World; pending: LogEntry[]; errors: ScriptError[]; output: OutputLine[];
  step(ticks: number): StepResult; stepLine(): StepResult; setBreakpoints(lines: Iterable<number>): void;
  debug(): BotDebug[]; lineHeat(): Map<number, number>; takeLog(): LogEntry[]; close(): void;
}
class ReturnFlow { constructor(readonly value: Value) {} }
class LoopFlow { constructor(readonly kind: 'break' | 'continue') {} }
class StopFlow {}
const MAX_COLLECTION = 100_000;
const numeric = (v: Value): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new SproutError('Expected an integer.'); return v; };
const bounded = (n: number): number => { if (!Number.isSafeInteger(n)) throw new SproutError('Number too large.'); return n; };
const list = (v: Value): Value[] => { if (!Array.isArray(v)) throw new SproutError('Expected a list.'); return v; };
const record = (v: Value): RecordValue => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || 'builtin' in v || 'functionName' in v) throw new SproutError('Expected a record.');
  return v;
};
const truth = (v: Value): boolean => v !== null && v !== false && v !== 0 && v !== '' && (!Array.isArray(v) || v.length > 0) && (typeof v !== 'object' || !v || Array.isArray(v) || Object.keys(v).length > 0);
const text = (v: Value, seen = new Set<object>(), depth = 0): string => {
  if (v === null) return 'none'; if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v !== 'object') return String(v);
  if ('builtin' in v) return v.builtin as string;
  if ('functionName' in v) return `<function ${v.functionName}>`;
  if (seen.has(v) || depth > 6) return '…'; seen.add(v);
  const out = Array.isArray(v) ? `[${v.map((x) => text(x, seen, depth + 1)).join(', ')}]` : `{${Object.entries(v).map(([k, x]) => `${k}: ${text(x, seen, depth + 1)}`).join(', ')}}`;
  seen.delete(v); return out.slice(0, MAX_COLLECTION);
};
const nameOf = (v: Value): string => typeof v === 'string' ? v : v && typeof v === 'object' && 'builtin' in v ? String(v.builtin) : text(v);
const index = (v: Value, size: number, allowEnd = false): number => {
  const n = numeric(v), i = n < 0 ? size + n : n;
  if (i < 0 || i >= size + (allowEnd ? 1 : 0)) throw new SproutError('List index is outside its range.'); return i;
};
function equal(a: Value, b: Value, depth = 0): boolean {
  if (a === b) return true;
  if (depth > 100 || a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b); if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.hasOwn(b, k) && equal((a as RecordValue)[k]!, (b as RecordValue)[k]!, depth + 1));
}
const member = (value: Value, collection: Value): boolean => typeof collection === 'string' ? collection.includes(nameOf(value)) : Array.isArray(collection) ? collection.some((x) => equal(x, value)) : Object.hasOwn(record(collection), nameOf(value));
function binary(op: string, a: Value, b: Value): Value {
  if (op === '==') return equal(a, b); if (op === '!=') return !equal(a, b);
  if (op === 'in' || op === 'not in') { const found = member(a, b); return op === 'in' ? found : !found; }
  if (op === '+' && (typeof a === 'string' || typeof b === 'string')) { const s = text(a) + text(b); if (s.length > MAX_COLLECTION) throw new SproutError('String is too long.'); return s; }
  if (op === '+' && Array.isArray(a) && Array.isArray(b)) { if (a.length + b.length > MAX_COLLECTION) throw new SproutError('List is too long.'); return [...a, ...b]; }
  if (['<', '<=', '>', '>='].includes(op)) {
    if (typeof a !== typeof b || (typeof a !== 'number' && typeof a !== 'string')) throw new SproutError('Compare two integers or two strings.');
    const x = a as number, y = b as number; return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
  }
  const x = numeric(a), y = numeric(b);
  if ((op === '/' || op === '%') && y === 0) throw new SproutError('Cannot divide by zero.');
  return bounded(op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '/' ? Math.floor(x / y) : x - Math.floor(x / y) * y);
}

class Run implements ScriptRun {
  pending: LogEntry[] = []; errors: ScriptError[] = []; output: OutputLine[] = [];
  private bots: BotState[] = []; private shared: RecordValue = Object.create(null) as RecordValue;
  private breakpoints = new Set<number>(); private heat = new Map<number, number>(); private cursor = 0;
  private closed = false; private paused: { bot: number; line: number } | null = null;
  constructor(readonly world: World, private program: Program) { this.ensureBots(); }
  private ensureBots(): void {
    while (this.bots.length < this.world.bots.length) {
      const bot = this.bots.length;
      const state: BotState = { bot, line: null, status: 'ready', globals: new Map(), frames: [], rng: ((this.world.seed ^ Math.imul(bot + 1, 0x9E3779B1)) >>> 0) || 1, generator: null! };
      state.frames.push({ fn: '<program>', line: 1, locals: state.globals, declarations: new Set() });
      state.generator = this.execute(state); this.bots.push(state);
    }
  }
  private lookup(b: BotState, name: string): Value {
    const frame = b.frames.at(-1)!;
    if (frame.locals.has(name)) return frame.locals.get(name)!;
    if (b.globals.has(name)) return b.globals.get(name)!;
    if (name === 'shared') return this.shared;
    if (name === 'barn') return { x: 0, y: 0 };
    if ('north east south west carrot wheat clover pumpkin berry apple honey hive composter satchel all'.split(' ').includes(name)) return name;
    return { builtin: name };
  }
  private setName(b: BotState, name: string, value: Value): void {
    const frame = b.frames.at(-1)!;
    (frame.declarations.has(name) ? b.globals : frame.locals).set(name, value);
  }
  private *expr(b: BotState, e: Expr): Generator<Event, Value, void> {
    const p = e.pos.line;
    switch (e.k) {
      case 'int': case 'str': case 'bool': return e.v;
      case 'none': return null;
      case 'name': return this.lookup(b, e.name);
      case 'interp': { let s = ''; for (const x of e.parts) s += typeof x === 'string' ? x : text(yield* this.expr(b, x)); if (s.length > MAX_COLLECTION) throw new SproutError('String is too long.'); return s; }
      case 'list': { const items: Value[] = []; for (const x of e.items) items.push(yield* this.expr(b, x)); return items; }
      case 'record': { const o = Object.create(null) as RecordValue; for (const x of e.entries) o[x.key] = yield* this.expr(b, x.value); return o; }
      case 'unary': { const x = yield* this.expr(b, e.e); return e.op === 'not' ? !truth(x) : bounded(-numeric(x)); }
      case 'logic': { const l = truth(yield* this.expr(b, e.l)); return e.op === 'and' ? l && truth(yield* this.expr(b, e.r)) : l || truth(yield* this.expr(b, e.r)); }
      case 'binary': return binary(e.op, yield* this.expr(b, e.l), yield* this.expr(b, e.r));
      case 'field': { const o = record(yield* this.expr(b, e.obj)); return o[e.name] ?? null; }
      case 'index': {
        const o = yield* this.expr(b, e.obj), i = yield* this.expr(b, e.idx);
        if (typeof o === 'string') return o[index(i, o.length)]!;
        if (Array.isArray(o)) return o[index(i, o.length)]!;
        return record(o)[nameOf(i)] ?? null;
      }
      case 'call': {
        yield { k: 'work', line: p };
        const fn = yield* this.expr(b, e.callee), args: Value[] = [];
        for (const x of e.args) args.push(yield* this.expr(b, x));
        if (fn && typeof fn === 'object' && 'functionName' in fn) {
          const f = fn as FunctionValue;
          if (b.frames.length > 200) throw new SproutError('Too many nested function calls (maximum 200).');
          if (args.length !== f.params.length) throw new SproutError(`${f.functionName} needs ${f.params.length} arguments.`);
          b.frames.push({ fn: f.functionName, line: p, locals: new Map(f.params.map((n, i) => [n, args[i]!])), declarations: new Set() });
          try { yield* this.block(b, f.body); return null; } catch (x) { if (x instanceof ReturnFlow) return x.value; throw x; } finally { b.frames.pop(); }
        }
        if (!fn || typeof fn !== 'object' || !('builtin' in fn)) throw new SproutError(`${text(fn)} is not a command.`);
        return yield* this.builtin(b, String(fn.builtin), args, p);
      }
    }
  }
  private *assign(b: BotState, target: Expr, value: Value): Generator<Event, void, void> {
    if (target.k === 'name') this.setName(b, target.name, value);
    else if (target.k === 'field') { const o = record(yield* this.expr(b, target.obj)); if (!Object.hasOwn(o, target.name) && Object.keys(o).length >= MAX_COLLECTION) throw new SproutError('Record is too large.'); o[target.name] = value; }
    else if (target.k === 'index') {
      const o = yield* this.expr(b, target.obj), i = yield* this.expr(b, target.idx);
      if (Array.isArray(o)) o[index(i, o.length)] = value;
      else { const r = record(o), key = nameOf(i); if (!Object.hasOwn(r, key) && Object.keys(r).length >= MAX_COLLECTION) throw new SproutError('Record is too large.'); r[key] = value; }
    }
  }
  private *block(b: BotState, body: Stmt[]): Generator<Event, void, void> {
    for (const s of body) {
      b.line = s.pos.line; b.frames.at(-1)!.line = s.pos.line;
      yield { k: 'line', line: s.pos.line };
      switch (s.k) {
        case 'assign': { const value = yield* this.expr(b, s.value); yield* this.assign(b, s.target, s.op === '=' ? value : binary(s.op[0]!, yield* this.expr(b, s.target), value)); break; }
        case 'expr': yield* this.expr(b, s.e); break;
        case 'pass': break;
        case 'stop': throw new StopFlow();
        case 'return': throw new ReturnFlow(s.value ? yield* this.expr(b, s.value) : null);
        case 'break': case 'continue': throw new LoopFlow(s.k);
        case 'global': for (const n of s.names) b.frames.at(-1)!.declarations.add(n.name); break;
        case 'define': this.setName(b, s.name, { functionName: s.name, params: s.params.map((n) => n.name), body: s.body }); break;
        case 'if': { let matched = false; for (const branch of s.branches) if (truth(yield* this.expr(b, branch.cond))) { yield* this.block(b, branch.body); matched = true; break; } if (!matched && s.orelse) yield* this.block(b, s.orelse); break; }
        case 'while': case 'forever': {
          while (s.k === 'forever' || truth(yield* this.expr(b, s.cond))) {
            yield { k: 'work', line: s.pos.line };
            try { yield* this.block(b, s.body); } catch (x) { if (!(x instanceof LoopFlow)) throw x; if (x.kind === 'break') break; }
          }
          break;
        }
        case 'times': case 'foreach': case 'forrange': {
          let values: Value[];
          if (s.k === 'times') { const n = numeric(yield* this.expr(b, s.count)); values = []; if (n > MAX_COLLECTION) throw new SproutError('Repeat at most 100,000 times in one block; use while for longer loops.'); for (let i = 0; i < n; i++) values.push(i); }
          else if (s.k === 'foreach') { const v = yield* this.expr(b, s.iter); values = Array.isArray(v) ? v.slice() : typeof v === 'string' ? [...v] : Object.keys(record(v)); }
          else {
            const start = numeric(yield* this.expr(b, s.from)), end = numeric(yield* this.expr(b, s.to)); const delta = s.step ? numeric(yield* this.expr(b, s.step)) : start <= end ? 1 : -1;
            if (!delta) throw new SproutError('Loop step cannot be zero.'); values = [];
            for (let i = start; delta > 0 ? i <= end : i >= end; i = bounded(i + delta)) { if (values.length >= MAX_COLLECTION) throw new SproutError('Loop range is too large.'); values.push(i); }
          }
          for (const value of values) {
            yield { k: 'work', line: s.pos.line }; if (s.k !== 'times') this.setName(b, s.name, value);
            try { yield* this.block(b, s.body); } catch (x) { if (!(x instanceof LoopFlow)) throw x; if (x.kind === 'break') break; }
          }
          break;
        }
      }
    }
  }
  private *execute(b: BotState): Generator<Event, void, void> { try { yield* this.block(b, this.program.body); } catch (e) { if (!(e instanceof StopFlow)) throw e; } }
  private *action(b: BotState, op: number, args: number[], line: number): Generator<Event, number, void> {
    const farm = op === OP.buyPlot || op === OP.buyBot || op === OP.unlock;
    const entry: LogEntry = [this.world.tick, farm ? -1 : b.bot, op]; entry.push(...args);
    const result = applyAction(this.world, entry); this.pending.push(entry);
    if (!farm) yield { k: 'action', line };
    return result;
  }
  private *builtin(b: BotState, name: string, a: Value[], line: number): Generator<Event, Value, void> {
    const w = this.world, bot = w.bots[b.bot]!;
    const arg = (i: number): Value => { if (i >= a.length) throw new SproutError(`${name} needs more arguments.`); return a[i]!; };
    const integer = (i: number): number => numeric(arg(i));
    const item = (i: number): number => { const n = ITEMS.findIndex((x) => x.name === nameOf(arg(i))); if (n < 1) throw new SproutError('Unknown item name.'); return n; };
    const unlock = (i: number): number => { const n = UNLOCKS.findIndex((x) => x.name === nameOf(arg(i))); if (n < 0) throw new SproutError('Unknown research name.'); return n; };
    const position = (): RecordValue => ({ x: bot.x, y: bot.y });
    const cargo = (stock: ArrayLike<number>): RecordValue => Object.fromEntries(ITEMS.slice(1).map((x, i) => [x.name, stock[i + 1] ?? 0]));
    const scanned = (x: number, y: number): Value => { const t = scanAt(w, x, y); return t ? { ...t, x, y, crop: t.crop ? CROPS[t.crop]!.name : null, building: t.building ? BUILDINGS[t.building]!.name : null, ripe: t.stage === 3, empty: !t.crop && !t.building && !t.barn } : null; };
    const simple: Record<string, number> = { till: OP.till, water: OP.water, harvest: OP.harvest, deposit: OP.deposit, clear: OP.clear, compost: OP.compost, fertilize: OP.fertilize };
    if (Object.hasOwn(simple, name)) { const n = yield* this.action(b, simple[name]!, [], line); return ['harvest', 'deposit', 'compost'].includes(name) ? n : n === 1; }
    switch (name) {
      case 'move': { const d = ['north', 'east', 'south', 'west'].indexOf(nameOf(arg(0))); if (d < 0) throw new SproutError('Move north, east, south or west.'); return (yield* this.action(b, OP.move, [d], line)) === 1; }
      case 'plant': { const c = item(0); if (c > 6) throw new SproutError('Plant a crop, not honey or compost.'); return (yield* this.action(b, OP.plant, [c], line)) === 1; }
      case 'build': { const k = BUILDINGS.findIndex((x) => x.name === nameOf(arg(0))); if (k < 1) throw new SproutError('Build a hive or composter.'); return (yield* this.action(b, OP.build, [k], line)) === 1; }
      case 'unlock': return (yield* this.action(b, OP.unlock, [unlock(0)], line)) === 1;
      case 'buy_plot': return (yield* this.action(b, OP.buyPlot, [integer(0), integer(1)], line)) === 1;
      case 'buy_bot': { const n = yield* this.action(b, OP.buyBot, [], line); return n ? n - 1 : null; }
      case 'sell': { const c = item(0); if (c > 7) throw new SproutError('Compost cannot be sold.'); const n = nameOf(arg(1)) === 'all' ? w.stock[c]! : integer(1); if (n < 1) return 0; return yield* this.action(b, OP.sell, [c, n], line); }
      case 'deliver': { const order = arg(0); const id = typeof order === 'number' ? order : numeric(record(order).id!); return yield* this.action(b, OP.deliver, [id], line); }
      case 'wait': { let n = integer(0); if (n < 1) throw new SproutError('Wait at least one tick.'); while (n > 0) { const step = Math.min(n, 1000); yield* this.action(b, OP.wait, [step], line); n -= step; } return true; }
      case 'go_to': {
        const v = arg(0), x = typeof v === 'object' && v ? numeric(record(v).x!) : integer(0), y = typeof v === 'object' && v ? numeric(record(v).y!) : integer(1);
        while (bot.x !== x || bot.y !== y) { const d = bot.x !== x ? bot.x < x ? 1 : 3 : bot.y < y ? 2 : 0; if (!(yield* this.action(b, OP.move, [d], line))) return false; }
        return true;
      }
      case 'scan': return scanned(bot.x, bot.y); case 'scan_at': return scanned(integer(0), integer(1)); case 'position': return position();
      case 'my_id': return b.bot; case 'tick': return w.tick; case 'coins': return w.coins; case 'bots': return w.bots.length;
      case 'load': return cargo(bot.load); case 'stock': return cargo(w.stock); case 'carried': return [...bot.load].reduce((n, x) => n + x, 0); case 'capacity': return capacity(w);
      case 'owns': return scanAt(w, integer(0), integer(1)) !== null; case 'plots': return w.plots.map((p) => ({ px: p.px, py: p.py }));
      case 'tiles': { const out: Value[] = []; if (w.plots.length * 64 > MAX_COLLECTION) throw new SproutError('tiles() exceeds 100,000 tiles; iterate plots instead.'); for (const p of w.plots) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out.push({ x: p.px * 8 + x, y: p.py * 8 + y }); return out; }
      case 'forecast': { const horizon = integer(0); if (horizon < 0 || horizon > 100_000) throw new SproutError('Forecast between 0 and 100,000 ticks.'); return forecast(w, horizon).map((s) => ({ ...s })); }
      case 'weather': return weatherAt(w, w.tick); case 'orders': return openOrders(w).map((o) => ({ ...o, crop: CROPS[o.crop]!.name }));
      case 'plot_cost': return plotCost(w); case 'bot_cost': return botCost(w); case 'unlocked': return isUnlocked(w, unlock(0)); case 'unlock_cost': return UNLOCKS[unlock(0)]!.price; case 'price': return ITEMS[item(0)]!.price;
      case 'say': case 'print': { if (this.output.length < 2000) this.output.push({ bot: b.bot, tick: w.tick, text: a.map((v) => text(v)).join(' ').slice(0, 2000) }); return null; }
      case 'len': { const v = arg(0); return typeof v === 'string' || Array.isArray(v) ? v.length : Object.keys(record(v)).length; }
      case 'str': return text(arg(0)); case 'int': { const v = arg(0); const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : typeof v === 'number' ? v : NaN; return Number.isSafeInteger(n) ? n : null; }
      case 'abs': return Math.abs(integer(0)); case 'min': case 'max': { const values = a.length === 1 && Array.isArray(a[0]) ? a[0] : a; if (!values.length) throw new SproutError('Supply at least one integer.'); return values.map(numeric).reduce((x, y) => name === 'min' ? Math.min(x, y) : Math.max(x, y)); }
      case 'range': { const start = a.length === 1 ? 0 : integer(0), end = a.length === 1 ? integer(0) : integer(1); if (end - start > MAX_COLLECTION) throw new SproutError('Range is too large.'); const out: Value[] = []; for (let i = start; i < end; i++) out.push(i); return out; }
      case 'append': case 'insert': { const xs = list(arg(0)); if (xs.length >= MAX_COLLECTION) throw new SproutError('List is too long.'); if (name === 'append') xs.push(arg(1)); else xs.splice(index(arg(1), xs.length, true), 0, arg(2)); return null; }
      case 'pop': { const xs = list(arg(0)); if (!xs.length) throw new SproutError('Cannot pop an empty list.'); return xs.pop()!; }
      case 'remove': { const xs = list(arg(0)); return xs.splice(index(arg(1), xs.length), 1)[0]!; }
      case 'keys': return Object.keys(record(arg(0))); case 'contains': return member(arg(1), arg(0)); case 'reversed': return list(arg(0)).slice().reverse();
      case 'sorted': { const xs = list(arg(0)).slice(); if (xs.some((v) => typeof v !== typeof xs[0] || (typeof v !== 'number' && typeof v !== 'string'))) throw new SproutError('Sort a list of integers or a list of strings.'); return xs.sort((x, y) => typeof x === 'number' ? x - (y as number) : x === y ? 0 : (x as string) < (y as string) ? -1 : 1); }
      case 'random': { const upper = integer(0); if (upper < 1) throw new SproutError('random needs a positive upper bound.'); b.rng = rand(b.rng); return b.rng % upper; }
      case 'distance': { const x = record(arg(0)), y = record(arg(1)); return bounded(Math.abs(numeric(x.x!) - numeric(y.x!)) + Math.abs(numeric(x.y!) - numeric(y.y!))); }
      default: throw new SproutError(`I don't know the command ${name}.`);
    }
  }
  private advance(ticks: number, singleLine: boolean): StepResult {
    if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks > 20_000) throw new SproutError('Step between zero and 20,000 ticks.');
    const start = this.world.tick; this.paused = null;
    if (this.closed) return { ticks: 0, paused: null };
    while (this.world.tick - start < ticks) {
      this.ensureBots();
      while (this.cursor < this.bots.length) {
        const b = this.bots[this.cursor]!;
        if (b.status === 'done' || b.status === 'error' || this.world.bots[b.bot]!.busyUntil > this.world.tick) { if (b.status !== 'done' && b.status !== 'error') b.status = 'busy'; this.cursor++; continue; }
        b.status = 'ready';
        try {
          let worked = 0;
          while (worked++ < 5000) {
            const result = b.generator.next();
            if (result.done) { b.status = 'done'; break; }
            const event = result.value; b.line = event.line;
            this.heat.set(event.line, (this.heat.get(event.line) ?? 0) + 1);
            if (event.k === 'line' && (singleLine || this.breakpoints.has(event.line))) {
              b.status = 'paused'; this.paused = { bot: b.bot, line: event.line }; return { ticks: this.world.tick - start, paused: this.paused };
            }
            if (event.k === 'action') { b.status = 'busy'; break; }
          }
          if (worked > 5000 && b.status === 'ready') b.status = 'thinking';
        } catch (e) {
          b.status = 'error'; this.errors.push({ bot: b.bot, line: b.line ?? 1, col: 1, tick: this.world.tick, message: e instanceof LoopFlow ? `${e.kind} needs a surrounding loop.` : e instanceof ReturnFlow ? 'return needs a surrounding function.' : e instanceof Error ? e.message : 'Program stopped.' });
        }
        this.cursor++; this.ensureBots();
      }
      tickWorld(this.world); this.cursor = 0;
      if (singleLine) break;
    }
    return { ticks: this.world.tick - start, paused: this.paused };
  }
  step(ticks: number): StepResult { return this.advance(ticks, false); }
  stepLine(): StepResult { return this.advance(1, true); }
  setBreakpoints(lines: Iterable<number>): void { this.breakpoints = new Set([...lines].filter((n) => Number.isInteger(n) && n > 0)); }
  debug(): BotDebug[] { return this.bots.map((b) => ({ bot: b.bot, line: b.line, status: b.status, vars: [...new Map([...b.globals, ...b.frames.at(-1)!.locals])].slice(0, 40).map(([name, value]) => ({ name, value: text(value).slice(0, 200) })), stack: b.frames.map((f) => ({ fn: f.fn, line: f.line })) })); }
  lineHeat(): Map<number, number> { return new Map(this.heat); }
  takeLog(): LogEntry[] { return this.pending.splice(0); }
  close(): void { this.closed = true; this.bots = []; }
}
export function createRun(world: World, source: string, opts?: CompileOptions): ScriptRun {
  const result = compile(source, opts); if (!result.program) throw new CompileError(result.diagnostics);
  return new Run(world, result.program);
}

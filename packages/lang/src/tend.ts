// `tend` blocks and `when` rules: the logic-first way to write a farming program (docs/LANGUAGE.md section 11).
// The parser reads them into the TendNode and WhenNode shapes below, and `desugar` turns every one of them into ordinary
// Sprout statements before the program leaves `compile`. The interpreter and the compiled engine never see a `tend`, so
// both run exactly the code that `expandTend` prints. Nodes made here carry `gen: true`: they skip the lesson feature
// check (the player did not write them) but keep the position of the line that produced them.
import type { Expr, Pos, Stmt } from './ast.ts';
import { API } from './api.ts';
import type { Diagnostic } from './errors.ts';
import { unparseExpr } from './unparse.ts';

export interface TendRule { cond: Expr; body: Stmt[]; pos: Pos }
export type TendTarget =
  | { kind: 'tiles' }
  | { kind: 'list'; expr: Expr }
  | { kind: 'region'; x1: Expr; y1: Expr; x2: Expr; y2: Expr };
export interface TendNode { k: 'tend'; target: TendTarget; rules: TendRule[]; pos: Pos }
export interface WhenNode { k: 'when'; cond: Expr; body: Stmt[]; pos: Pos }

/** Constants of the tile rules; the thresholds match the shipped starter program. */
export const DRY_BELOW = 25;
export const HUNGRY_BELOW = 25;
export const TIRED_ABOVE = 40;
export const IDLE_WAIT = 10;

const SCAN_FIELDS = ['moisture', 'nitrogen', 'fatigue', 'stage', 'crop', 'honey'];
const FOOD = ['carrot', 'wheat', 'clover', 'pumpkin', 'berry', 'apple', 'honey'];
const QUERIES = new Set(API.filter((a) => a.kind === 'query' && a.signature.endsWith('()')).map((a) => a.name));
/** Plain words usable in a rule's condition. Each one is documented in the reference under `when`. */
export const TEND_WORDS = ['ripe', 'empty', 'tilled', 'growing', 'dry', 'tired', 'hungry', 'frost', 'rain', 'full', 'carrying', 'stocked', ...SCAN_FIELDS];

const gen = <T extends object>(n: T): T => Object.assign(n, { gen: true });
const nm = (name: string, pos: Pos): Expr => gen({ k: 'name', name, pos }) as Expr;
const num = (v: number, pos: Pos): Expr => gen({ k: 'int', v, pos }) as Expr;
const str = (v: string, pos: Pos): Expr => gen({ k: 'str', v, pos }) as Expr;
const call = (fn: string, args: Expr[], pos: Pos): Expr => gen({ k: 'call', callee: nm(fn, pos), args, pos }) as Expr;
const field = (obj: Expr, name: string, pos: Pos): Expr => gen({ k: 'field', obj, name, pos }) as Expr;
const bin = (op: '<' | '>' | '>=' | '<=' | '==' | '!=' | '+' | '-' | '*' | '/', l: Expr, r: Expr, pos: Pos): Expr => gen({ k: 'binary', op, l, r, pos }) as Expr;
const and = (l: Expr, r: Expr, pos: Pos): Expr => gen({ k: 'logic', op: 'and', l, r, pos }) as Expr;
const not = (e: Expr, pos: Pos): Expr => gen({ k: 'unary', op: 'not', e, pos }) as Expr;
const assign = (name: string, value: Expr, pos: Pos): Stmt => gen({ k: 'assign', target: nm(name, pos), op: '=', value, pos }) as Stmt;
const cmd = (fn: string, args: Expr[], pos: Pos): Stmt => gen({ k: 'expr', e: call(fn, args, pos), command: true, pos }) as Stmt;
const ifs = (cond: Expr, body: Stmt[], orelse: Stmt[] | null, pos: Pos): Stmt => gen({ k: 'if', branches: [{ cond, body, pos }], orelse, pos }) as Stmt;
const SCAN = '_scan';

/** The expression a condition word stands for, or null when `name` is not one. `p` is where the word was written. */
function wordExpr(name: string, p: Pos): Expr | null {
  const s = (f: string): Expr => field(nm(SCAN, p), f, p);
  switch (name) {
    case 'ripe': case 'empty': case 'tilled': return s(name);
    case 'growing': return and(bin('!=', s('crop'), gen({ k: 'none', pos: p }) as Expr, p), not(s('ripe'), p), p);
    case 'dry': return bin('<', s('moisture'), num(DRY_BELOW, p), p);
    case 'tired': return bin('>', s('fatigue'), num(TIRED_ABOVE, p), p);
    case 'hungry': return bin('<', s('nitrogen'), num(HUNGRY_BELOW, p), p);
    case 'frost': case 'rain': return bin('==', call('weather', [], p), str(name, p), p);
    case 'full': return bin('>=', call('carried', [], p), call('capacity', [], p), p);
    case 'carrying': return bin('>', call('carried', [], p), num(0, p), p);
    case 'stocked': {
      const units = FOOD.map((f) => field(call('stock', [], p), f, p)).reduce((l, r) => bin('+', l, r, p));
      return bin('>', units, num(0, p), p);
    }
    default: return SCAN_FIELDS.includes(name) ? s(name) : QUERIES.has(name) ? call(name, [], p) : null;
  }
}

/** Rewrites the plain words in a rule condition. Names that are neither words nor known stay put, marked so the "I don't know" message can suggest a word. */
export function rewriteCond(e: Expr): Expr {
  switch (e.k) {
    case 'name': return wordExpr(e.name, e.pos) ?? Object.assign({}, e, { cond: true });
    case 'call': return { ...e, callee: e.callee.k === 'name' ? e.callee : rewriteCond(e.callee), args: e.args.map(rewriteCond) };
    case 'unary': return { ...e, e: rewriteCond(e.e) };
    case 'binary': case 'logic': return { ...e, l: rewriteCond(e.l), r: rewriteCond(e.r) } as Expr;
    case 'list': return { ...e, items: e.items.map(rewriteCond) };
    case 'record': return { ...e, entries: e.entries.map((x) => ({ key: x.key, value: rewriteCond(x.value) })) };
    case 'index': return { ...e, obj: rewriteCond(e.obj), idx: rewriteCond(e.idx) };
    case 'field': return { ...e, obj: rewriteCond(e.obj) };
    case 'interp': return { ...e, parts: e.parts.map((x) => (typeof x === 'string' ? x : rewriteCond(x))) };
    default: return e;
  }
}

const isCmd = (s: Stmt, name: string): s is Extract<Stmt, { k: 'expr' }> & { e: Extract<Expr, { k: 'call' }> } =>
  s.k === 'expr' && s.e.k === 'call' && s.e.callee.k === 'name' && s.e.callee.name === name && !(s.e as { gen?: boolean }).gen;

/** The trip to the nearest drop, then the sale. `item` null means every crop. */
function sellTrip(item: Expr | null, p: Pos): Stmt[] {
  const sales = item ? [cmd('sell', [item, nm('all', p)], p)] : FOOD.map((f) => cmd('sell', [nm(f, p), nm('all', p)], p));
  return [cmd('go_to', [call('nearest_drop', [], p)], p), ifs(bin('>', call('carried', [], p), num(0, p), p), [cmd('deposit', [], p)], null, p), ...sales];
}

/**
 * The words only a rule knows, written directly in a rule's body:
 *   `sell everything` / `sell carrot` walk to the nearest drop, deposit what the bot carries, then sell all of it.
 *   `plant carrot` tills first when the soil is not tilled yet.
 * Everything else (and `sell carrot, 5`, `plant(carrot)` inside your own functions) is ordinary Sprout.
 */
export function tendBody(body: Stmt[]): Stmt[] {
  const out: Stmt[] = [];
  for (const s of body) {
    if (isCmd(s, 'sell') && s.e.args.length === 1) {
      const a = s.e.args[0]!;
      out.push(...sellTrip(a.k === 'name' && a.name === 'everything' ? null : a, s.pos));
    } else if (isCmd(s, 'plant') && s.e.args.length === 1) {
      out.push(ifs(not(field(call('scan', [], s.pos), 'tilled', s.pos), s.pos), [cmd('till', [], s.pos)], null, s.pos), s);
    } else if (s.k === 'if') out.push({ ...s, branches: s.branches.map((b) => ({ ...b, body: tendBody(b.body) })), orelse: s.orelse && tendBody(s.orelse) });
    else if (s.k === 'while' || s.k === 'forever' || s.k === 'times' || s.k === 'foreach' || s.k === 'forrange') out.push({ ...s, body: tendBody(s.body) } as Stmt);
    else out.push(s);
  }
  return out;
}

/** `action unless cond` and `action unless cond, else other`. `elseArgs` reuses the action's verb (`plant carrot unless tired, else clover`). */
export function unlessBody(action: Stmt, cond: Expr, other: Stmt | null, pos: Pos): Stmt[] {
  return [{ k: 'if', branches: [{ cond, body: other ? [other] : [{ k: 'pass', pos }], pos }], orelse: [action], pos } as Stmt];
}

// ---- warnings: rules that can never run -------------------------------------------------------------------------

interface Lit { key: string; neg: boolean }
const EXCLUSIVE: [string, string][] = [['_scan.ripe', '_scan.empty'], ['_scan.empty', '_scan.crop != none'], ['weather() == \'frost\'', 'weather() == \'rain\'']];

/** Disjunctive normal form of a condition (a list of alternatives, each a list of facts that all hold), or null when it is too large to reason about. */
function dnf(e: Expr, neg = false): Lit[][] | null {
  if (e.k === 'unary' && e.op === 'not') return dnf(e.e, !neg);
  if (e.k === 'bool') return e.v !== neg ? [[]] : [];
  if (e.k === 'logic') {
    const l = dnf(e.l, neg), r = dnf(e.r, neg);
    if (!l || !r) return null;
    const or = (e.op === 'or') !== neg;
    if (or) return [...l, ...r];
    const out = l.flatMap((a) => r.map((b) => [...a, ...b]));
    return out.length > 64 ? null : out;
  }
  return [[{ key: unparseExpr(e), neg }]];
}
const impossible = (c: Lit[]): boolean =>
  c.some((a) => c.some((b) => a.key === b.key && a.neg !== b.neg)) ||
  EXCLUSIVE.some(([x, y]) => c.some((a) => a.key === x && !a.neg) && c.some((a) => a.key === y && !a.neg));
const covers = (earlier: Lit[], later: Lit[]): boolean => earlier.every((a) => later.some((b) => b.key === a.key && b.neg === a.neg));

/** Warnings for rules that no tile can ever reach: contradictions, and rules an earlier rule always catches first. */
export function ruleWarnings(rules: { cond: Expr; pos: Pos }[], what: string): Diagnostic[] {
  const out: Diagnostic[] = [], forms = rules.map((r) => dnf(r.cond));
  rules.forEach((rule, j) => {
    const mine = forms[j];
    if (!mine) return;
    const live = mine.filter((c) => !impossible(c));
    const warn = (message: string): void => { out.push({ line: rule.pos.line, col: rule.pos.col, endCol: rule.pos.endCol, message, severity: 'warning' }); };
    if (!live.length) { warn(`This ${what} can never run: its conditions contradict each other.`); return; }
    for (let i = 0; i < j; i++) {
      const before = forms[i];
      if (before && live.every((c) => before.some((d) => !impossible(d) && covers(d, c)))) { warn(`This ${what} can never run: the one on line ${rules[i]!.pos.line} already catches everything it would. Put the more specific rule first.`); return; }
    }
  });
  return out;
}

// ---- desugaring --------------------------------------------------------------------------------------------------

const chain = (rules: { cond: Expr; body: Stmt[]; pos: Pos }[], pos: Pos): Stmt[] =>
  rules.length ? [gen({ k: 'if', branches: rules.map((r) => ({ cond: r.cond, body: r.body, pos: r.pos })), orelse: null, pos }) as Stmt] : [];

/** The ordinary statements for one pass over a `tend` block. The order is fixed and documented under "What a tend block does". */
function expandBlock(t: TendNode, chores: WhenNode[]): Stmt[] {
  const p = t.pos, tiles = '_tiles';
  const listing: Stmt[] = t.target.kind === 'tiles' ? [assign(tiles, call('tiles', [], p), p)]
    : t.target.kind === 'list' ? [assign(tiles, t.target.expr, p)]
      : (() => {
        const r = t.target, c = nm('_c', p);
        const within = (axis: 'x' | 'y', a: Expr, b: Expr): Expr => and(bin('>=', field(c, axis, p), call('min', [a, b], p), p), bin('<=', field(c, axis, p), call('max', [a, b], p), p), p);
        return [assign(tiles, gen({ k: 'list', items: [], pos: p }) as Expr, p),
          gen({ k: 'foreach', name: '_c', namePos: p, iter: call('tiles', [], p), body: [ifs(and(within('x', r.x1, r.x2), within('y', r.y1, r.y2), p), [cmd('append', [nm(tiles, p), c], p)], null, p)], pos: p }) as Stmt];
      })();
  const choreChain = (): Stmt[] => (chores.length ? [assign(SCAN, call('scan', [], p), p), ...chain(chores, p)] : []);
  const total = call('len', [nm(tiles, p)], p), n = call('bots', [], p), me = call('my_id', [], p);
  const first = bin('/', bin('*', total, me, p), n, p);
  const last = bin('/', bin('*', call('len', [nm(tiles, p)], p), bin('+', call('my_id', [], p), num(1, p), p), p), call('bots', [], p), p);
  const visit: Stmt[] = [
    assign('_tile', gen({ k: 'index', obj: nm(tiles, p), idx: nm('_i', p), pos: p }) as Expr, p),
    cmd('go_to', [nm('_tile', p)], p),
    assign(SCAN, call('scan', [], p), p),
    ...chain(t.rules, p),
    ...choreChain(),
    ifs(bin('>=', call('carried', [], p), call('capacity', [], p), p), [cmd('go_to', [call('nearest_drop', [], p)], p), cmd('deposit', [], p)], null, p),
  ];
  return [
    assign('_tick0', call('tick', [], p), p),
    ...listing,
    assign('_first', first, p),
    assign('_last', bin('-', last, num(1, p), p), p),
    gen({ k: 'forrange', name: '_i', namePos: p, from: nm('_first', p), to: nm('_last', p), step: num(1, p), body: visit, pos: p }) as Stmt,
    cmd('go_to', [call('nearest_drop', [], p)], p),
    ifs(bin('>', call('carried', [], p), num(0, p), p), [cmd('deposit', [], p)], null, p),
    ...choreChain(),
    ifs(bin('==', call('tick', [], p), nm('_tick0', p), p), [cmd('wait', [num(IDLE_WAIT, p)], p)], null, p),
  ];
}

type Host = { body: Stmt[] };
/** Replaces every `tend` in a statement list (nested ones too) with its expansion. */
function expandIn(body: Stmt[], chores: WhenNode[]): Stmt[] {
  return body.flatMap((s): Stmt[] => {
    const n = s as unknown as TendNode;
    if (n.k === 'tend') return expandBlock(n, chores);
    if (s.k === 'if') return [{ ...s, branches: s.branches.map((b) => ({ ...b, body: expandIn(b.body, chores) })), orelse: s.orelse && expandIn(s.orelse, chores) }];
    if ('body' in s) return [{ ...(s as Stmt & Host), body: expandIn((s as Stmt & Host).body, chores) } as Stmt];
    return [s];
  });
}
const hasTend = (body: Stmt[]): boolean => body.some((s) => {
  if ((s as unknown as TendNode).k === 'tend') return true;
  if (s.k === 'if') return s.branches.some((b) => hasTend(b.body)) || (s.orelse ? hasTend(s.orelse) : false);
  return 'body' in s && hasTend((s as Stmt & Host).body);
});
const tendNodes = (body: Stmt[], out: TendNode[] = []): TendNode[] => {
  for (const s of body) {
    if ((s as unknown as TendNode).k === 'tend') out.push(s as unknown as TendNode);
    else if (s.k === 'if') { for (const b of s.branches) tendNodes(b.body, out); if (s.orelse) tendNodes(s.orelse, out); }
    else if ('body' in s) tendNodes((s as Stmt & Host).body, out);
  }
  return out;
};

/**
 * Turns the `tend` and top-level `when` nodes of a parsed program into ordinary statements.
 * A program with no `tend` and no `when` comes back untouched. When a `tend` sits at the top level, everything from the first one
 * down repeats forever (what is above it, such as your functions, runs once).
 */
export function desugar(body: Stmt[], features: ReadonlySet<string> | undefined, diagnostics: Diagnostic[]): Stmt[] {
  const chores = body.filter((s) => (s as unknown as WhenNode).k === 'when') as unknown as WhenNode[];
  const rest = body.filter((s) => (s as unknown as WhenNode).k !== 'when');
  if (!chores.length && !hasTend(rest)) return body;
  const error = (p: Pos, message: string): void => { diagnostics.push({ ...p, message, severity: 'error' }); };
  const nodes = tendNodes(rest);
  if (!nodes.length) { error(chores[0]!.pos, 'A `when` rule at the start of a line runs between the tiles of a `tend` block. Add a `tend every tile:` block, or write the rule inside one.'); return body; }
  if (features && !features.has('tend')) { error(nodes[0]!.pos, 'The tend feature is locked. Complete its campaign lesson first.'); return body; }
  for (const t of nodes) diagnostics.push(...ruleWarnings(t.rules, 'rule'));
  diagnostics.push(...ruleWarnings(chores, 'between-tile rule'));
  const expanded = expandIn(rest, chores);
  const at = rest.findIndex((s) => (s as unknown as TendNode).k === 'tend');
  if (at < 0) return expanded;
  const first = nodes[0]!;
  // Everything from the first top-level tend onward repeats; expansion kept statement order, so cut where the first tend began.
  const before = rest.slice(0, at), after = expanded.slice(before.length);
  return [...before, gen({ k: 'forever', body: after, pos: first.pos }) as Stmt];
}

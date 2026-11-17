// Random Sprout programs for the equivalence tests. Deterministic from the seed. Not every output compiles; callers skip those.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const VARS = ['a', 'b', 'c', 'd', 'xs', 'r', 'name'];
const NUM_VARS = ['a', 'b', 'c', 'd'];
const FUNCS = ['f', 'g', 'h'];
const QUERIES = ['scan().ripe', 'scan().empty', 'scan().crop', 'position().x', 'position().y', 'tick()', 'coins()', 'bots()', 'my_id()', 'carried()', 'capacity()', 'len(tiles())', 'len(plots())',
  'weather()', 'len(orders())', 'plot_cost()', 'bot_cost()', 'unlocked(wheat)', 'unlock_cost(wheat)', 'price(carrot)', 'silo_cost()', 'len(silos())', 'nearest_drop().x', 'len(forecast(60))', 'load().carrot', 'stock().carrot',
  'scan_at(1, 0).crop', 'owns(1, 0)', 'owns(9, 9)', 'distance(position(), barn)', 'random(5)', 'int("12")', 'str(a)', 'abs(b - 3)'];
const SAFE_COMMANDS = ['till', 'plant carrot', 'plant wheat', 'harvest', 'water', 'deposit', 'compost', 'fertilize', 'clear', 'move east', 'move west', 'move north', 'move south', 'go_to barn', 'go_to 2, 1', 'go_to {x: 1, y: 1}', 'wait 1', 'wait 3', 'wait 2500', 'sell carrot, all', 'sell carrot, 1', 'build hive', 'build silo', 'buy_plot 1, 0', 'buy_plot 0, 1', 'sell_plot 1, 0', 'unlock clover', 'buy_bot', 'say "hi", a', 'print a + 1', 'pass', 'say scan()', 'say position()'];
const COMMANDS = ['till', 'plant carrot', 'plant wheat', 'harvest', 'water', 'deposit', 'compost', 'fertilize', 'clear', 'move east', 'move west', 'move north', 'move south', 'go_to barn', 'go_to 2, 1', 'go_to {x: 1, y: 1}',
  'wait 1', 'wait 3', 'wait 2500', 'sell carrot, all', 'sell carrot, 1', 'sell wheat, all', 'build hive', 'build silo', 'buy_plot 1, 0', 'buy_plot 0, 1', 'sell_plot 1, 0', 'unlock clover', 'buy_bot', 'deliver orders()[0]',
  'move "up"', 'plant "rock"', 'wait 0', 'sell compost, 1', 'say "hi", a', 'print a + 1', 'pass'];

type Rng = () => number;
/** Safe mode builds programs that rarely fail, so bots live long enough to reach deep behaviour. Set per program by genProgram. */
let SAFE = false;
let CALLABLE: string[] = ['f', 'g', 'h'];
const ARITY: Record<string, number> = { f: 2, g: 1, h: 0 };
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const chance = (rng: Rng, p: number): boolean => rng() < p;

const NUM_QUERIES = ['tick()', 'coins()', 'bots()', 'my_id()', 'carried()', 'capacity()', 'len(tiles())', 'len(plots())', 'len(orders())', 'len(xs)', 'len(name)', 'abs(b - 3)', 'random(5)', 'min(a, b)', 'max(c, 1)', 'position().x', 'position().y', 'plot_cost()', 'price(carrot)', 'int("12")', 'len(silos())', 'len(forecast(60))', 'distance(position(), barn)'];
/** Integer-valued expressions that rarely fail, so programs survive long enough to exercise later statements. */
export function genNum(rng: Rng, depth: number): string {
  if (depth <= 0 || chance(rng, 0.3)) return chance(rng, 0.4) ? String(Math.floor(rng() * 12)) : chance(rng, 0.5) ? pick(rng, NUM_VARS) : pick(rng, NUM_QUERIES);
  const k = rng();
  if (k < 0.5) return `(${genNum(rng, depth - 1)}) ${pick(rng, ['+', '-', '*'])} (${genNum(rng, depth - 1)})`;
  if (k < 0.65) return `(${genNum(rng, depth - 1)}) ${pick(rng, ['/', '%'])} ${pick(rng, ['2', '3', '7', '-4'])}`;
  if (k < 0.8) { if (!CALLABLE.length) return '1'; const fn = pick(rng, CALLABLE); return `${fn}(${Array.from({ length: SAFE ? ARITY[fn]! : pick(rng, [0, 1, 2]) }, () => genNum(rng, depth - 1)).join(', ')})`; }
  return `len(${pick(rng, ['xs', 'name', 'range(3)'])})`;
}
export function genCond(rng: Rng, depth: number): string {
  const k = rng();
  if (k < 0.5) return `(${genNum(rng, depth)}) ${pick(rng, ['<', '<=', '>', '>=', '==', '!='])} (${genNum(rng, depth)})`;
  if (k < 0.65) return pick(rng, ['scan().ripe', 'scan().empty', 'not scan().empty', 'owns(1, 0)', 'unlocked(wheat)', 'a in xs', 'weather() == "rain"']);
  if (k < 0.85) return `(${genCond(rng, depth - 1)}) ${pick(rng, ['and', 'or'])} (${genCond(rng, depth - 1)})`;
  return genExpr(rng, 2);
}
export function genExpr(rng: Rng, depth: number, fnDepth = 0): string {
  if (SAFE) return chance(rng, 0.6) ? genNum(rng, depth) : chance(rng, 0.7) ? genCond(rng, 1) : pick(rng, ['xs', 'r', 'name', '"s"', 'xs[0]', 'r.k', 'len(xs)']);
  if (depth <= 0 || chance(rng, 0.25)) {
    const k = rng();
    if (k < 0.3) return String(Math.floor(rng() * 12));
    if (k < 0.5) return pick(rng, VARS);
    if (k < 0.6) return pick(rng, ['"s"', '"ab"', 'true', 'false', 'none', 'north', 'carrot', 'barn', 'shared']);
    return pick(rng, QUERIES);
  }
  const k = rng();
  if (k < 0.3) return `(${genExpr(rng, depth - 1)}) ${pick(rng, ['+', '-', '*', '/', '%'])} (${genExpr(rng, depth - 1)})`;
  if (k < 0.45) return `(${genExpr(rng, depth - 1)}) ${pick(rng, ['==', '!=', '<', '<=', '>', '>=', 'in', 'not in'])} (${genExpr(rng, depth - 1)})`;
  if (k < 0.52) return `(${genExpr(rng, depth - 1)}) ${pick(rng, ['and', 'or'])} (${genExpr(rng, depth - 1)})`;
  if (k < 0.56) return `not (${genExpr(rng, depth - 1)})`;
  if (k < 0.59) return `-(${genExpr(rng, depth - 1)})`;
  if (k < 0.65) return `[${Array.from({ length: Math.floor(rng() * 4) }, () => genExpr(rng, depth - 1)).join(', ')}]`;
  if (k < 0.7) return `{k: ${genExpr(rng, depth - 1)}, m: ${genExpr(rng, depth - 1)}}`;
  if (k < 0.74) return `${pick(rng, ['xs', 'r', 'name', 'scan()', 'position()'])}[${pick(rng, ['0', '1', '-1', '"k"', 'a'])}]`;
  if (k < 0.77) return `${pick(rng, ['r', 'scan()', 'position()', 'xs', 'a'])}.${pick(rng, ['k', 'x', 'm', 'ripe'])}`;
  if (k < 0.83) return `"v={${pick(rng, VARS)}} {${pick(rng, NUM_VARS)}}"`;
  if (k < 0.93 && fnDepth < 3) { if (!CALLABLE.length) return String(Math.floor(rng() * 9)); const fn = pick(rng, CALLABLE); return `${fn}(${Array.from({ length: SAFE ? ARITY[fn]! : pick(rng, [0, 1, 1, 2, 2, 3]) }, () => genExpr(rng, depth - 1)).join(', ')})`; }
  const fn = pick(rng, ['len', 'str', 'abs', 'min', 'max', 'range', 'pop', 'keys', 'contains', 'reversed', 'sorted', 'random', 'sorted', 'insert', 'append', 'remove', 'distance', 'int', 'say']);
  const arity = fn === 'contains' || fn === 'append' || fn === 'remove' || fn === 'min' || fn === 'max' || fn === 'distance' ? 2 : fn === 'insert' ? 3 : 1;
  const args = Array.from({ length: arity }, (_, i) => (i === 0 && ['len', 'pop', 'keys', 'reversed', 'sorted', 'contains', 'append', 'insert', 'remove'].includes(fn) ? pick(rng, ['xs', 'r', 'name', genExpr(rng, depth - 1)]) : genExpr(rng, depth - 1)));
  return `${fn}(${args.join(', ')})`;
}

function genBlock(rng: Rng, depth: number, indent: string, flags: { loop: boolean; fn: boolean }, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(...genStmt(rng, depth, indent, flags));
  return out;
}

function genStmt(rng: Rng, depth: number, indent: string, flags: { loop: boolean; fn: boolean }): string[] {
  const k = rng(), inner = indent + '    ';
  const body = (f = flags, n = 1 + Math.floor(rng() * 3)): string[] => genBlock(rng, depth - 1, inner, f, n);
  if (depth <= 0 || k < 0.35) {
    const j = rng();
    if (j < 0.45) return [`${indent}${pick(rng, SAFE ? SAFE_COMMANDS : COMMANDS)}`];
    if (j < 0.7) return [`${indent}${SAFE || chance(rng, 0.75) ? pick(rng, NUM_VARS) + ' = ' + genNum(rng, 2) : pick(rng, VARS) + ' = ' + genExpr(rng, 2)}`];
    if (j < 0.8) return [`${indent}${pick(rng, NUM_VARS)} ${pick(rng, ['+=', '-=', '*='])} ${genNum(rng, 1)}`];
    if (j < 0.85) return [`${indent}${pick(rng, SAFE ? ['xs[0]', 'xs[1]', 'r.k', 'r["m"]', 'r.z'] : ['xs[0]', 'xs[1]', 'xs[a]', 'r.k', 'r["m"]', 'r.z', 'name[0]'])} = ${SAFE ? genNum(rng, 1) : genExpr(rng, 1)}`];
    if (j < 0.9) return [`${indent}${pick(rng, SAFE ? ['xs[0]', 'r.k', 'a'] : ['xs[0]', 'r.k', 'a'])} ${pick(rng, ['+=', '-='])} ${SAFE ? genNum(rng, 1) : genExpr(rng, 1)}`];
    if (j < 0.94) return [`${indent}say (${genExpr(rng, 2)})`];
    if (j < 0.97) return [`${indent}(${genExpr(rng, 2)})`];
    return [`${indent}${pick(rng, ['global a', 'global b, c', 'pass'])}`];
  }
  if (k < 0.5) {
    const lines = [`${indent}if ${chance(rng, 0.8) ? genCond(rng, 2) : genExpr(rng, 2)}:`, ...body()];
    if (chance(rng, 0.4)) lines.push(`${indent}elif ${genCond(rng, 1)}:`, ...body());
    if (chance(rng, 0.5)) lines.push(`${indent}else:`, ...body());
    return lines;
  }
  if (k < 0.6) return [`${indent}repeat ${chance(rng, 0.9) ? pick(rng, ['2', '3', '5', 'c', '0', '4']) : pick(rng, ['-1', '"x"', 'a'])} times:`, ...body({ ...flags, loop: true })];
  if (k < 0.7) return [`${indent}for each ${pick(rng, ['i', 'j', 'name'])} in ${pick(rng, SAFE ? ['xs', 'range(4)', 'r', 'name', 'tiles()', 'plots()', 'range(c)'] : ['xs', 'range(4)', 'r', 'name', 'tiles()', 'orders()', 'plots()', genExpr(rng, 1)])}:`, ...body({ ...flags, loop: true })];
  if (k < 0.76) return [`${indent}for i from ${pick(rng, ['0', 'a', '3'])} to ${pick(rng, ['3', '5', 'b', '0'])}${chance(rng, 0.3) ? ` step ${pick(rng, ['1', '2', '-1', '0'])}` : ''}:`, ...body({ ...flags, loop: true })];
  if (k < 0.82) return [`${indent}while ${genCond(rng, 1)}:`, `${inner}${pick(rng, NUM_VARS)} += 1`, ...body({ ...flags, loop: true })];
  if (k < 0.85) return [`${indent}repeat forever:`, ...body({ ...flags, loop: true }), `${inner}wait ${pick(rng, ['1', '2', '7'])}`];
  if (k < 0.9 && !flags.fn && !SAFE) return [`${indent}define ${pick(rng, FUNCS)}(${pick(rng, ['', 'p', 'p, q', 'a'])}):`, ...genBlock(rng, depth - 1, inner, { loop: false, fn: true }, 1 + Math.floor(rng() * 3)), `${inner}return ${genExpr(rng, 1)}`];
  const j = rng();
  if (SAFE) {
    if (flags.loop && j < 0.4) return [`${indent}if ${genCond(rng, 1)}:`, `${inner}${pick(rng, ['break', 'continue'])}`];
    if (flags.fn && j < 0.6) return [`${indent}if ${genCond(rng, 1)}:`, `${inner}return ${genNum(rng, 1)}`];
    if (j < 0.65) return [`${indent}if ${genCond(rng, 1)}:`, `${inner}stop`];
    return [`${indent}${pick(rng, SAFE_COMMANDS)}`];
  }
  if (j < 0.3) return [`${indent}break`]; if (j < 0.5) return [`${indent}continue`];
  if (j < 0.7) return [`${indent}return ${genExpr(rng, 1)}`]; if (j < 0.8) return [`${indent}stop`];
  return [`${indent}${pick(rng, COMMANDS)}`];
}

export function genProgram(seed: number): string {
  const rng = mulberry32(seed);
  SAFE = seed % 3 !== 0;
  const lines: string[] = [];
  if (chance(rng, 0.5)) lines.push('if bots() < 3:', '    buy_bot');
  lines.push('a = 0', 'b = 1', 'c = 3', 'd = 7', 'xs = [1, 2, 3]', 'r = {k: 1, m: 2}', 'name = "hello"');
  for (const f of FUNCS) { CALLABLE = FUNCS.slice(FUNCS.indexOf(f) + 1); lines.push(`define ${f}(${SAFE ? ['p, q', 'p', ''][FUNCS.indexOf(f)]! : pick(rng, ['', 'p', 'p, q'])}):`, ...genBlock(rng, 2, '    ', { loop: false, fn: true }, 1 + Math.floor(rng() * 3)), `    return ${SAFE ? genNum(rng, 2) : genExpr(rng, 2)}`); }
  CALLABLE = [...FUNCS];
  const main = genBlock(rng, 3, chance(rng, 0.6) ? '    ' : '', { loop: false, fn: false }, 3 + Math.floor(rng() * 6));
  if (main[0]?.startsWith('    ')) lines.push('repeat forever:', ...main, '    wait 1'); else lines.push(...main);
  return lines.join('\n') + '\n';
}

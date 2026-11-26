import type { AssignOp, BinaryOp, Expr, Pos, Stmt } from './ast.ts';
import { API, CONSTANTS } from './api.ts';
import { didYouMean, type Diagnostic, SproutError, suggest } from './errors.ts';
import { lex, type Token } from './lexer.ts';
import { desugar, rewriteCond, tendBody, TEND_WORDS, unlessBody } from './tend.ts';
import type { TendNode, TendRule, TendTarget, WhenNode } from './tend.ts';
export interface Program { body: Stmt[] }
export interface CompileOptions { features?: ReadonlySet<string> }
const pos = (t: Pos): Pos => ({ line: t.line, col: t.col, endCol: t.endCol });
const PRECEDENCE: Record<string, number> = { or: 1, and: 2, '==': 4, '!=': 4, '<': 4, '<=': 4, '>': 4, '>=': 4, is: 4, in: 4, not: 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
class Parser {
  i = 0;
  /** True while reading the one-line action of a rule, where `unless` ends a command. */
  inRule = false;
  /** Block nesting, and how deep inside a rule body we are (a `when` or `tend` cannot start there). */
  depth = 0; ruleDepth = 0;
  constructor(private tokens: Token[]) {}
  get t(): Token { return this.tokens[this.i]!; }
  take(): Token { return this.tokens[this.i++]!; }
  eat(text: string): boolean { if (this.t.text === text) { this.i++; return true; } return false; }
  fail(message: string): never { throw Object.assign(new SproutError(message), pos(this.t)); }
  need(text: string): Token { if (this.t.text !== text) this.fail(`Expected ${text === ':' ? 'a colon (:) to begin the block' : `\`${text}\``}.`); return this.take(); }
  name(): Token { if (this.t.kind !== 'word') this.fail('Expected a name.'); return this.take(); }
  expression(min = 0): Expr {
    let left: Expr;
    const t = this.take(), p = pos(t);
    if (t.kind === 'number') {
      const v = Number(t.text.replace(/_/g, ''));
      if (!Number.isSafeInteger(v)) this.fail('Number too large.');
      left = { k: 'int', v, pos: p };
    } else if (t.kind === 'string') {
      const v = t.text.slice(1, -1).replace(/\\([nt\\"'])/g, (_, c: string) => c === 'n' ? '\n' : c === 't' ? '\t' : c);
      if (t.text[0] === '"' && /(?<!\{)\{[^{}]+\}(?!\})/.test(v)) {
        const parts: (string | Expr)[] = []; let end = 0;
        for (const match of v.matchAll(/(?<!\{)\{([^{}]+)\}(?!\})/g)) {
          parts.push(v.slice(end, match.index).replace(/\{\{/g, '{').replace(/\}\}/g, '}'));
          const sub = new Parser(lex(match[1]!)); parts.push(sub.expression()); end = match.index + match[0].length;
        }
        parts.push(v.slice(end).replace(/\{\{/g, '{').replace(/\}\}/g, '}')); left = { k: 'interp', parts, pos: p };
      } else left = { k: 'str', v: v.replace(/\{\{/g, '{').replace(/\}\}/g, '}'), pos: p };
    } else if (t.text === 'true' || t.text === 'false') left = { k: 'bool', v: t.text === 'true', pos: p };
    else if (t.text === 'none') left = { k: 'none', pos: p };
    else if (t.text === '-' || t.text === 'not') left = { k: 'unary', op: t.text, e: this.expression(t.text === 'not' ? 3 : 7), pos: p };
    else if (t.text === '(') { left = this.expression(); this.need(')'); }
    else if (t.text === '[') {
      const items: Expr[] = []; if (!this.eat(']')) { do { items.push(this.expression()); } while (this.eat(',') && this.t.text !== ']'); this.need(']'); }
      left = { k: 'list', items, pos: p };
    } else if (t.text === '{') {
      const entries: { key: string; value: Expr }[] = [];
      if (!this.eat('}')) { do { const key = this.take(); if (!['word', 'string'].includes(key.kind)) this.fail('Record keys must be names or strings.'); this.need(':'); entries.push({ key: key.kind === 'string' ? key.text.slice(1, -1) : key.text, value: this.expression() }); } while (this.eat(',') && this.t.text !== '}'); this.need('}'); }
      left = { k: 'record', entries, pos: p };
    } else if (t.kind === 'word') left = { k: 'name', name: t.text, pos: p };
    else this.fail('Expected a value or a command.');
    for (;;) {
      if (this.t.text === '(') {
        this.take(); const args: Expr[] = []; if (!this.eat(')')) { do { args.push(this.expression()); } while (this.eat(',')); this.need(')'); }
        left = { k: 'call', callee: left, args, pos: p }; continue;
      }
      if (this.eat('.')) { left = { k: 'field', obj: left, name: this.name().text, pos: p }; continue; }
      if (this.eat('[')) { const idx = this.expression(); this.need(']'); left = { k: 'index', obj: left, idx, pos: p }; continue; }
      let op = this.t.text, precedence = PRECEDENCE[op];
      if (!precedence || precedence <= min) break;
      if (op === 'not' && this.tokens[this.i + 1]?.text !== 'in') break;
      this.take();
      if (op === 'is') op = this.eat('not') ? '!=' : '==';
      if (op === 'not') { this.need('in'); op = 'not in'; precedence = 4; }
      const r = this.expression(precedence);
      left = op === 'and' || op === 'or' ? { k: 'logic', op, l: left, r, pos: p } : { k: 'binary', op: op as BinaryOp, l: left, r, pos: p };
      if (precedence === 4 && PRECEDENCE[this.t.text] === 4) this.fail('Use and to combine comparisons.');
    }
    return left;
  }
  block(): Stmt[] { this.need(':'); this.need('\n'); this.need('INDENT'); this.depth++; const body = this.statements(); this.depth--; this.need('DEDENT'); return body; }
  statements(): Stmt[] {
    const out: Stmt[] = [];
    while (this.t.kind !== 'dedent' && this.t.kind !== 'eof') { if (this.eat('\n')) continue; out.push(this.statement()); }
    return out;
  }
  statement(): Stmt {
    const t = this.t, p = pos(t), k = t.text;
    if (k === 'tend' && this.colonOnLine(true)) return this.tendBlock();
    if (k === 'when' && this.colonOnLine(false)) {
      if (this.depth > 0 || this.ruleDepth > 0) this.fail('A top-level `when` rule belongs at the start of your program, or inside a `tend` block, not inside another block.');
      const rule = this.rule();
      return { k: 'when', cond: rule.cond, body: rule.body, pos: rule.pos } as WhenNode as unknown as Stmt;
    }
    if (['if', 'while', 'repeat', 'for', 'define', 'def'].includes(k)) {
      this.take();
      if (k === 'if') {
        const cond = this.expression(), body = this.block(); const branches = [{ cond, body, pos: p }];
        while (this.t.text === 'elif' || (this.t.text === 'else' && this.tokens[this.i + 1]?.text === 'if')) {
          const q = this.take(); if (q.text === 'else') this.need('if'); const c = this.expression(); branches.push({ cond: c, body: this.block(), pos: pos(q) });
        }
        return { k: 'if', branches, orelse: this.eat('else') ? this.block() : null, pos: p };
      }
      if (k === 'while') { const cond = this.expression(); return { k: 'while', cond, body: this.block(), pos: p }; }
      if (k === 'repeat') {
        if (this.eat('forever')) return { k: 'forever', body: this.block(), pos: p };
        const count = this.expression(); this.need('times'); return { k: 'times', count, body: this.block(), pos: p };
      }
      if (k === 'for') {
        this.eat('each'); const n = this.name();
        if (this.eat('in')) { const iter = this.expression(); return { k: 'foreach', name: n.text, namePos: pos(n), iter, body: this.block(), pos: p }; }
        this.need('from'); const from = this.expression(); this.need('to'); const to = this.expression(); const step = this.eat('step') ? this.expression() : null;
        return { k: 'forrange', name: n.text, namePos: pos(n), from, to, step, body: this.block(), pos: p };
      }
      const name = this.name(); this.need('('); const params: { name: string; pos: Pos }[] = [];
      if (!this.eat(')')) { do { const n = this.name(); params.push({ name: n.text, pos: pos(n) }); } while (this.eat(',')); this.need(')'); }
      return { k: 'define', name: name.text, namePos: pos(name), params, body: this.block(), pos: p };
    }
    const s = this.simple();
    this.need('\n'); return s;
  }
  /** One statement that fits on a line, without its line break. */
  simple(): Stmt {
    const t = this.t, p = pos(t), k = t.text;
    let s: Stmt;
    if (['pass', 'break', 'continue', 'stop'].includes(k)) { this.take(); s = { k: k as 'pass', pos: p }; }
    else if (k === 'return') { this.take(); s = { k: 'return', value: this.t.kind === 'newline' ? null : this.expression(), pos: p }; }
    else if (k === 'global') { this.take(); const names: { name: string; pos: Pos }[] = []; do { const n = this.name(); names.push({ name: n.text, pos: pos(n) }); } while (this.eat(',')); s = { k: 'global', names, pos: p }; }
    else if (k === 'set') { this.take(); const n = this.name(); this.need('to'); s = { k: 'assign', target: { k: 'name', name: n.text, pos: pos(n) }, op: '=', value: this.expression(), pos: p }; }
    else {
      const e = this.expression();
      if (['=', '+=', '-=', '*='].includes(this.t.text)) {
        if (!['name', 'index', 'field'].includes(e.k)) this.fail('Assign to a variable, list index or record field.');
        const op = this.take().text as AssignOp; s = { k: 'assign', target: e, op, value: this.expression(), pos: p };
      } else if (e.k === 'name' && this.t.kind !== 'newline' && this.t.kind !== 'eof' && !(this.inRule && this.t.text === 'unless')) {
        const args: Expr[] = []; do { args.push(this.expression()); } while (this.eat(',')); s = { k: 'expr', e: { k: 'call', callee: e, args, pos: p }, command: true, pos: p };
      } else s = { k: 'expr', e: e.k === 'name' ? { k: 'call', callee: e, args: [], pos: p } : e, command: e.k === 'name', pos: p };
    }
    return s;
  }
  /** Is the rest of this line a block head (`tend ...:`) or a rule (`when ...: action`)? Looks for a colon outside brackets. */
  colonOnLine(last: boolean): boolean {
    let depth = 0, prev = '';
    for (let j = this.i + 1; this.tokens[j]!.kind !== 'newline' && this.tokens[j]!.kind !== 'eof'; j++) {
      const x = this.tokens[j]!.text;
      if ('([{'.includes(x)) depth++; else if (')]}'.includes(x)) depth--;
      else if (x === ':' && depth === 0 && !last) return true;
      prev = x;
    }
    return last && prev === ':';
  }
  /** `tend every tile:`, `tend <list>:` or `tend region x1, y1 to x2, y2:` and its indented `when` rules. */
  tendBlock(): Stmt {
    const head = this.take(), p = pos(head);
    if (this.ruleDepth > 0) this.fail('Put `tend` at the top of your program or inside your own loop, not inside a rule.');
    let target: TendTarget;
    if (this.eat('every')) { if (!this.eat('tile')) this.fail('Write `tend every tile:` to visit every tile you own.'); target = { kind: 'tiles' }; }
    else if (this.eat('region')) {
      const x1 = this.expression(); this.need(','); const y1 = this.expression(); this.need('to'); const x2 = this.expression(); this.need(','); const y2 = this.expression();
      target = { kind: 'region', x1, y1, x2, y2 };
    } else target = { kind: 'list', expr: this.expression() };
    this.need(':'); this.need('\n'); this.need('INDENT');
    const rules: TendRule[] = [];
    while (this.t.kind !== 'dedent' && this.t.kind !== 'eof') {
      if (this.eat('\n')) continue;
      if (this.t.text !== 'when') this.fail(`Inside \`tend\`, every rule starts with \`when\`.${didYouMean(this.t.text, ['when'])}`);
      rules.push(this.rule());
    }
    this.need('DEDENT');
    if (!rules.length) this.fail('Add at least one `when` rule inside this `tend` block.');
    return { k: 'tend', target, rules, pos: p } as TendNode as unknown as Stmt;
  }
  /** `when <condition>: <action>` or `when <condition>:` with an indented block. Used inside `tend` and at the top of a program. */
  rule(): TendRule {
    const head = this.take(), p = pos(head);
    const cond = rewriteCond(this.expression());
    this.need(':');
    this.ruleDepth++;
    let body: Stmt[];
    if (this.t.kind === 'newline') { this.need('\n'); this.need('INDENT'); this.depth++; body = this.statements(); this.depth--; this.need('DEDENT'); }
    else body = this.inlineAction();
    this.ruleDepth--;
    return { cond, body: tendBody(body), pos: p };
  }
  inlineAction(): Stmt[] {
    this.inRule = true;
    const action = this.simple();
    let body: Stmt[] = [action];
    if (this.eat('unless')) {
      const cond = rewriteCond(this.expression());
      let other: Stmt | null = null;
      if (this.eat(',')) {
        this.need('else');
        const q = pos(this.t);
        const name = this.t.kind === 'word' ? this.t.text : '';
        if (name && API.some((a) => a.name === name && ['action', 'farm', 'utility'].includes(a.kind))) other = this.simple();
        else {
          // `plant carrot unless tired, else clover`: the same verb with different arguments.
          const call = action.k === 'expr' && action.e.k === 'call' && action.e.callee.k === 'name' ? action.e : null;
          if (!call) this.fail('After `else`, name a full action, such as `else water`.');
          const args: Expr[] = []; do { args.push(this.expression()); } while (this.eat(','));
          other = { k: 'expr', e: { ...call, args, pos: q }, command: true, pos: q };
        }
      }
      body = unlessBody(action, cond, other, pos(this.t));
    }
    this.inRule = false;
    this.need('\n');
    return body;
  }
}
export function compile(source: string, opts: CompileOptions = {}): { program: Program | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  try {
    const parser = new Parser(lex(source)); const statements = parser.statements();
    if (parser.t.kind !== 'eof') parser.fail('Unexpected indentation.');
    const program = { body: desugar(statements, opts.features, diagnostics) };
    if (diagnostics.some((d) => d.severity === 'error')) return { program: null, diagnostics };
    const names = new Set([...API.map((a) => a.name), ...CONSTANTS]);
    const collect = (v: unknown): void => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) { for (const x of v) collect(x); return; }
      const o = v as Record<string, unknown>;
      if (o.k === 'assign' && (o.target as Expr).k === 'name') names.add((o.target as Extract<Expr, { k: 'name' }>).name);
      if (['foreach', 'forrange', 'define'].includes(o.k as string)) names.add(o.name as string);
      if (o.k === 'define') for (const param of o.params as { name: string }[]) names.add(param.name);
      for (const [key, x] of Object.entries(o)) if (key !== 'pos') collect(x);
    };
    collect(program);
    const error = (p: Pos, message: string): void => { diagnostics.push({ ...p, message, severity: 'error' }); };
    const visit = (v: unknown): void => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) { for (const x of v) visit(x); return; }
      const o = v as Record<string, unknown>, p = o.pos as Pos;
      if (o.k === 'name' && !names.has(o.name as string)) error(p, `I don't know what \`${o.name}\` means.${didYouMean(o.name as string, o.cond && suggest(o.name as string, TEND_WORDS) ? TEND_WORDS : names)}`);
      if (o.k === 'assign') { const target = o.target as Expr; if (target.k === 'name' && (API.some((a) => a.name === target.name) || CONSTANTS.includes(target.name))) error(target.pos, 'Choose a variable name that is not a built-in.'); }
      const features: Record<string, string> = { forever: 'repeat', times: 'repeat', assign: 'variables', if: 'if', while: 'while', foreach: 'for', forrange: 'for', define: 'functions', list: 'lists', record: 'records' };
      const feature = o.k === 'name' ? API.find((a) => a.name === o.name)?.feature : features[o.k as string];
      if (feature && !o.gen && opts.features && !opts.features.has(feature)) error(p, `The ${feature} feature is locked. Complete its campaign lesson first.`);
      for (const [key, x] of Object.entries(o)) if (key !== 'pos') visit(x);
    };
    visit(program);
    return { program: diagnostics.some((d) => d.severity === 'error') ? null : program, diagnostics };
  } catch (e) {
    const x = e as Error & Partial<Pos>;
    return { program: null, diagnostics: [{ line: x.line ?? 1, col: x.col ?? 1, endCol: x.endCol ?? (x.col ?? 1) + 1, message: x.message ?? 'Invalid program.', severity: 'error' }] };
  }
}

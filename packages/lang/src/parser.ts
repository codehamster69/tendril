import type { AssignOp, BinaryOp, Expr, Pos, Stmt } from './ast.ts';
import { API, CONSTANTS } from './api.ts';
import { didYouMean, type Diagnostic, SproutError } from './errors.ts';
import { lex, type Token } from './lexer.ts';
export interface Program { body: Stmt[] }
export interface CompileOptions { features?: ReadonlySet<string> }
const pos = (t: Pos): Pos => ({ line: t.line, col: t.col, endCol: t.endCol });
const PRECEDENCE: Record<string, number> = { or: 1, and: 2, '==': 4, '!=': 4, '<': 4, '<=': 4, '>': 4, '>=': 4, is: 4, in: 4, not: 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
class Parser {
  i = 0;
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
  block(): Stmt[] { this.need(':'); this.need('\n'); this.need('INDENT'); const body = this.statements(); this.need('DEDENT'); return body; }
  statements(): Stmt[] {
    const out: Stmt[] = [];
    while (this.t.kind !== 'dedent' && this.t.kind !== 'eof') { if (this.eat('\n')) continue; out.push(this.statement()); }
    return out;
  }
  statement(): Stmt {
    const t = this.t, p = pos(t), k = t.text;
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
      } else if (e.k === 'name' && this.t.kind !== 'newline' && this.t.kind !== 'eof') {
        const args: Expr[] = []; do { args.push(this.expression()); } while (this.eat(',')); s = { k: 'expr', e: { k: 'call', callee: e, args, pos: p }, command: true, pos: p };
      } else s = { k: 'expr', e: e.k === 'name' ? { k: 'call', callee: e, args: [], pos: p } : e, command: e.k === 'name', pos: p };
    }
    this.need('\n'); return s;
  }
}
export function compile(source: string, opts: CompileOptions = {}): { program: Program | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  try {
    const parser = new Parser(lex(source)); const program = { body: parser.statements() };
    if (parser.t.kind !== 'eof') parser.fail('Unexpected indentation.');
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
      if (o.k === 'name' && !names.has(o.name as string)) error(p, `I don't know what \`${o.name}\` means.${didYouMean(o.name as string, names)}`);
      if (o.k === 'assign') { const target = o.target as Expr; if (target.k === 'name' && (API.some((a) => a.name === target.name) || CONSTANTS.includes(target.name))) error(target.pos, 'Choose a variable name that is not a built-in.'); }
      const features: Record<string, string> = { forever: 'repeat', times: 'repeat', assign: 'variables', if: 'if', while: 'while', foreach: 'for', forrange: 'for', define: 'functions', list: 'lists', record: 'records' };
      const feature = o.k === 'name' ? API.find((a) => a.name === o.name)?.feature : features[o.k as string];
      if (feature && opts.features && !opts.features.has(feature)) error(p, `The ${feature} feature is locked. Complete its campaign lesson first.`);
      for (const [key, x] of Object.entries(o)) if (key !== 'pos') visit(x);
    };
    visit(program);
    return { program: diagnostics.length ? null : program, diagnostics };
  } catch (e) {
    const x = e as Error & Partial<Pos>;
    return { program: null, diagnostics: [{ line: x.line ?? 1, col: x.col ?? 1, endCol: x.endCol ?? (x.col ?? 1) + 1, message: x.message ?? 'Invalid program.', severity: 'error' }] };
  }
}

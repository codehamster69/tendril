// Prints a Sprout syntax tree back as source text. Used to show the full program a `tend` block expands to.
// Comments and the original spelling are not kept (`set x to 1` prints as `x = 1`); the printed text parses to the same tree.
import type { BinaryOp, Expr, Stmt } from './ast.ts';

const PREC: Record<string, number> = { or: 1, and: 2, '==': 4, '!=': 4, '<': 4, '<=': 4, '>': 4, '>=': 4, in: 4, 'not in': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

const quote = (v: string, q: '"' | "'"): string => {
  const body = v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(new RegExp(q, 'g'), `\\${q}`);
  return q + body + q;
};
const braces = (s: string): string => s.replace(/\{/g, '{{').replace(/\}/g, '}}');

/** `min` is the lowest operator level the printed expression may have without brackets (see the table in docs/LANGUAGE.md). */
export function unparseExpr(e: Expr, min = 0): string {
  const wrap = (level: number, text: string): string => (level < min ? `(${text})` : text);
  const sub = (x: Expr, m: number): string => unparseExpr(x, m);
  switch (e.k) {
    case 'int': return String(e.v);
    case 'str': return quote(braces(e.v), "'");
    case 'interp': return `"${e.parts.map((p) => (typeof p === 'string' ? braces(p).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/"/g, '\\"') : `{${unparseExpr(p, 0)}}`)).join('')}"`;
    case 'bool': return e.v ? 'true' : 'false';
    case 'none': return 'none';
    case 'name': return e.name;
    case 'list': return `[${e.items.map((x) => sub(x, 0)).join(', ')}]`;
    case 'record': return `{${e.entries.map((x) => `${/^[A-Za-z_]\w*$/.test(x.key) ? x.key : quote(x.key, "'")}: ${sub(x.value, 0)}`).join(', ')}}`;
    case 'unary': return e.op === 'not' ? wrap(3, `not ${sub(e.e, 4)}`) : wrap(7, `-${sub(e.e, 8)}`);
    case 'binary': { const p = PREC[e.op as BinaryOp]!; return wrap(p, `${sub(e.l, p === 4 ? 5 : p)} ${e.op} ${sub(e.r, p === 4 ? 5 : p + 1)}`); }
    case 'logic': { const p = PREC[e.op]!; return wrap(p, `${sub(e.l, p)} ${e.op} ${sub(e.r, p + 1)}`); }
    case 'call': return `${sub(e.callee, 8)}(${e.args.map((x) => sub(x, 0)).join(', ')})`;
    case 'index': return `${sub(e.obj, 8)}[${sub(e.idx, 0)}]`;
    case 'field': return `${sub(e.obj, 8)}.${e.name}`;
  }
}

export function unparseStmts(body: Stmt[], depth = 0): string[] {
  const pad = '    '.repeat(depth), out: string[] = [];
  const block = (head: string, inner: Stmt[]): void => { out.push(`${pad}${head}:`); out.push(...unparseStmts(inner, depth + 1)); };
  for (const s of body) {
    switch (s.k) {
      case 'assign': out.push(`${pad}${unparseExpr(s.target, 8)} ${s.op} ${unparseExpr(s.value)}`); break;
      case 'expr': {
        const call = s.e;
        if (s.command && call.k === 'call' && call.callee.k === 'name') {
          const args = call.args.map((x) => unparseExpr(x));
          if (!args.length) out.push(`${pad}${call.callee.name}`);
          else if (args[0]!.startsWith('(')) out.push(`${pad}${call.callee.name}(${args.join(', ')})`);
          else out.push(`${pad}${call.callee.name} ${args.join(', ')}`);
        } else out.push(`${pad}${unparseExpr(s.e)}`);
        break;
      }
      case 'if': s.branches.forEach((b, i) => block(`${i ? 'elif' : 'if'} ${unparseExpr(b.cond)}`, b.body)); if (s.orelse) block('else', s.orelse); break;
      case 'while': block(`while ${unparseExpr(s.cond)}`, s.body); break;
      case 'forever': block('repeat forever', s.body); break;
      case 'times': block(`repeat ${unparseExpr(s.count)} times`, s.body); break;
      case 'foreach': block(`for each ${s.name} in ${unparseExpr(s.iter)}`, s.body); break;
      case 'forrange': block(`for ${s.name} from ${unparseExpr(s.from)} to ${unparseExpr(s.to)}${s.step ? ` step ${unparseExpr(s.step)}` : ''}`, s.body); break;
      case 'define': block(`define ${s.name}(${s.params.map((p) => p.name).join(', ')})`, s.body); break;
      case 'return': out.push(`${pad}${s.value ? `return ${unparseExpr(s.value)}` : 'return'}`); break;
      case 'break': case 'continue': case 'pass': case 'stop': out.push(`${pad}${s.k}`); break;
      case 'global': out.push(`${pad}global ${s.names.map((n) => n.name).join(', ')}`); break;
    }
  }
  return out;
}

export const unparse = (body: Stmt[]): string => `${unparseStmts(body).join('\n')}\n`;

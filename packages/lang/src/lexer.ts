import type { Pos } from './ast.ts';
import { SproutError } from './errors.ts';
export interface Token extends Pos { text: string; kind: 'word' | 'number' | 'string' | 'symbol' | 'newline' | 'indent' | 'dedent' | 'eof' }
export function lex(source: string): Token[] {
  if (source.length > 200_000) throw new SproutError('Program is too long (maximum 200,000 characters).');
  const out: Token[] = [], levels = [0];
  let depth = 0;
  const lines = source.replace(/\r/g, '').split('\n');
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n]!.replace(/\t/g, '    '), line = n + 1;
    const space = raw.match(/^ */)![0].length;
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const push = (text: string, kind: Token['kind'], col: number, endCol = col + text.length): void => { out.push({ text, kind, line, col, endCol }); };
    if (depth === 0) {
      if (space > levels.at(-1)!) { levels.push(space); push('INDENT', 'indent', 1); }
      while (space < levels.at(-1)!) { levels.pop(); push('DEDENT', 'dedent', 1); }
      if (space !== levels.at(-1)) throw Object.assign(new SproutError('Indentation does not match an outer block.'), { line, col: 1 });
    }
    let i = space;
    while (i < raw.length) {
      const c = raw[i]!;
      if (/\s/.test(c)) { i++; continue; }
      if (c === '#') break;
      const col = i + 1;
      if (c === '"' || c === "'") {
        const start = i++;
        while (i < raw.length && raw[i] !== c) { if (raw[i] === '\\') i++; i++; }
        if (raw[i] !== c) throw Object.assign(new SproutError('Close this string with its matching quote.'), { line, col });
        i++; push(raw.slice(start, i), 'string', col, i + 1); continue;
      }
      const m = raw.slice(i).match(/^(\d[\d_]*|[A-Za-z_]\w*|==|!=|<=|>=|\+=|-=|\*=|[+\-*/%=<>()\[\]{},.:])/);
      if (!m) throw Object.assign(new SproutError(`Unexpected character ${c}.`), { line, col });
      const text = m[0]; i += text.length;
      if ('([{'.includes(text)) depth++;
      if (')]}'.includes(text)) depth--;
      if (depth < 0) throw Object.assign(new SproutError('Closing bracket has no opening bracket.'), { line, col });
      push(text, /^\d/.test(text) ? 'number' : /^\w/.test(text) ? 'word' : 'symbol', col, i + 1);
    }
    if (depth === 0) push('\n', 'newline', raw.length + 1);
  }
  if (depth !== 0) throw Object.assign(new SproutError('Close the opening bracket.'), { line: lines.length, col: 1 });
  while (levels.length > 1) { levels.pop(); out.push({ text: 'DEDENT', kind: 'dedent', line: lines.length, col: 1, endCol: 1 }); }
  out.push({ text: 'EOF', kind: 'eof', line: lines.length, col: 1, endCol: 1 });
  return out;
}

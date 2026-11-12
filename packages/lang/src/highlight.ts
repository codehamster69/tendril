// Syntax colouring for published programs on the website. Pure text in, spans out; imports api.ts only, so the
// site can load it without the interpreter. It also colours comments, which the lexer throws away.
import { API, CONSTANTS, KEYWORDS } from './api.ts';

export type SpanKind = 'comment' | 'string' | 'number' | 'keyword' | 'constant' | 'builtin' | 'plain';
export interface Span { text: string; kind: SpanKind }

const keywords = new Set(KEYWORDS), constants = new Set(CONSTANTS);
const builtins = new Set(API.filter((e) => e.kind !== 'keyword' && e.kind !== 'constant').map((e) => e.name));
const PIECE = /("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?)|(#.*)|(\d[\d_]*)|([A-Za-z_]\w*)/g;

/** Splits a program into coloured spans. The spans always join back into exactly `source`. */
export function highlight(source: string): Span[] {
  const out: Span[] = [];
  let at = 0;
  const push = (text: string, kind: SpanKind): void => { if (text) out.push({ text, kind }); };
  for (const m of source.matchAll(PIECE)) {
    push(source.slice(at, m.index), 'plain');
    const [text, str, comment, num, word] = m;
    if (str !== undefined) push(text, 'string');
    else if (comment !== undefined) push(text, 'comment');
    else if (num !== undefined) push(text, 'number');
    else if (word !== undefined) push(text, keywords.has(word) ? 'keyword' : constants.has(word) ? 'constant' : builtins.has(word) ? 'builtin' : 'plain');
    at = m.index + text.length;
  }
  push(source.slice(at), 'plain');
  return out;
}

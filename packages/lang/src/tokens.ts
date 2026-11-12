import { lex } from './lexer.ts';

/** A string literal this long (characters between the quotes) costs one token; each further chunk costs one more. */
export const STRING_CHUNK = 16;

/**
 * Brevity score of a program: its lexer tokens. Comments, blank lines, indentation and line breaks are free.
 * Words, numbers, symbols and strings cost one each. A long string costs one extra token per further
 * STRING_CHUNK characters, so a program cannot hide its whole action log in one literal and decode it for ~50 tokens.
 * Throws SproutError on text the lexer rejects; compile first when the source is untrusted.
 */
export function countTokens(source: string): number {
  let total = 0;
  for (const t of lex(source)) {
    if (t.kind === 'word' || t.kind === 'number' || t.kind === 'symbol') total++;
    else if (t.kind === 'string') total += Math.max(1, Math.ceil((t.text.length - 2) / STRING_CHUNK));
  }
  return total;
}

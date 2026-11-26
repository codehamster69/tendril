import { createHash } from 'node:crypto';

/**
 * Canonical form of a Sprout program for the duplicate-source check: comments, blank lines, spacing and indentation width are
 * dropped (nesting depth and every token kept). Names are NOT normalised, so a copy with renamed variables is not caught here
 * (it still runs the same log, which the log-hash check catches). Deliberately a lexer-free approximation: the server never imports the interpreter.
 */
export function normalizeSource(source: string): string {
  const out: string[] = [];
  const indents = [0];
  const token = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#.*|\d[\d_]*|[A-Za-z_]\w*|==|!=|<=|>=|\+=|-=|\*=|\S/g;
  for (const raw of source.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\t/g, '    ');
    const body = line.trim();
    if (!body || body.startsWith('#')) continue;
    const space = line.length - line.trimStart().length;
    while (space < indents[indents.length - 1]!) indents.pop();
    if (space > indents[indents.length - 1]!) indents.push(space);
    const tokens = (body.match(token) ?? []).filter((t) => !t.startsWith('#'));
    out.push(`${indents.length - 1}:${tokens.join(' ')}`);
  }
  return out.join('\n');
}

/** SHA-256 (hex) of the normalised program: what packets and entries are matched on. */
export const programHash = (source: string): string => createHash('sha256').update(normalizeSource(source)).digest('hex');

/** Records the program hash of an entry that now carries a verified program (arena.ts calls this when it saves one). */
export async function recordEntryProgram(db: { execute: (sql: string, args?: (string | number | null)[]) => Promise<unknown> }, entryId: string, source: string): Promise<void> {
  await db.execute('INSERT OR REPLACE INTO entry_programs (entry_id, hash) VALUES (?, ?)', [entryId, programHash(source)]);
}

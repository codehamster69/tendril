// Prints the brief of the next 30 dailies and 8 seasons from a start date, to eyeball balance.
// Usage: node --experimental-strip-types packages/sim/scripts/brief-preview.ts [YYYY-MM-DD] [salt]
// Seeds here are fnv1a32("tendril-brief:" + salt + ":" + id) like the server's, with a preview salt, so they are not the live ones.
import { challengeSetup, SETUP_BRIEF } from '../src/index.ts';

const start = process.argv[2] ?? '2027-01-04';
const salt = process.argv[3] ?? 'preview';
const fnv = (s: string): number => { let h = 0x811c9dc5; for (const b of new TextEncoder().encode(s)) { h ^= b; h = Math.imul(h, 0x01000193); } return (h >>> 0) || 1; };
const addDays = (d: string, n: number): string => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

function show(kind: 'daily' | 'season', id: string): void {
  const { brief, setup } = challengeSetup(kind, fnv(`tendril-brief:${salt}:${id}`), SETUP_BRIEF);
  const g = brief.goal;
  const extra = g.quotas ? ` quotas=${g.quotas.slice(1).join('/')}` : g.favoured ? ` fav=${g.favoured} shun=${g.shunned}` : '';
  console.log(`${id}  ${g.kind.padEnd(10)} ${String(brief.ticks).padStart(4)}t${extra}`);
  console.log(`    ${brief.notice}`);
  console.log(`    twists: ${brief.labels.length ? brief.labels.join('; ') : '-'}   setup: ${JSON.stringify({ ...setup, goal: undefined })}`);
}
console.log(`# 30 dailies from ${start}`);
for (let i = 0; i < 30; i++) show('daily', `d-${addDays(start, i)}`);
console.log(`\n# 8 seasons from ${start}`);
for (let i = 0; i < 8; i++) show('season', `s-${addDays(start, i * 7)}`);

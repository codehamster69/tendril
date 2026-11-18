// Practice farms (K6): today's brief on a random local world seed. Never submitted, never rated. Pure helpers; the page navigates with them.
const MAX_SEED = 0xffffffff;

/** The practice seed in a page's query, or null. A seed is a whole number 1..2^32-1; anything else is ignored. */
export function practiceParam(query: URLSearchParams): number | null {
  const raw = query.get('practice');
  if (raw === null || !/^\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_SEED ? n : null;
}

/** A fresh practice seed that is not `not`. `random` returns a float in [0, 1) (Math.random by default; tests pass their own). */
export function newPracticeSeed(not: number | null = null, random: () => number = Math.random): number {
  for (let i = 0; i < 8; i++) {
    const n = 1 + Math.floor(random() * MAX_SEED);
    if (n !== not) return n;
  }
  return not === 1 ? 2 : 1;
}

/** The same page with another practice seed. */
export function practiceSearch(search: string, seed: number): string {
  const q = new URLSearchParams(search);
  q.set('practice', String(seed));
  return `?${q.toString()}`;
}

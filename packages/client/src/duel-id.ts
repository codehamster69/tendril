/** Pulls a duel/challenge id out of a pasted link or a bare id such as d-abc123 or x-abc123. */
export function parseDuelId(text: string): string | null {
  const t = text.trim();
  const fromQuery = /[?&]id=([dsx]-[A-Za-z0-9_-]{1,40})(?:[&#]|$)/.exec(t)?.[1];
  const id = fromQuery ?? (/^[dsx]-[A-Za-z0-9_-]{1,40}$/.test(t) ? t : null);
  return id;
}

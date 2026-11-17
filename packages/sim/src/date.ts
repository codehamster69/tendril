const DAY_MS = 86_400_000;
/** UTC day number of a real `YYYY-MM-DD` date (throws on anything else). */
export function utcDay(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error('date must be YYYY-MM-DD');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw new Error('not a real date');
  return ms / DAY_MS;
}

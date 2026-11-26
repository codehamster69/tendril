// Beat the machine (H1): today's daily has a model entry (the robot player "tendril-models"). The start card names its score, the
// goal HUD marks it on the progress bar, and the result screen and share text compare the run with it. Nothing here blocks play:
// the board read runs in the background, and every failure leaves the game exactly as it was.
import type { BoardEntry, ChallengeInfo, FarmApi } from './api-client';

export interface Rival {
  /** Model id as the board stores it, e.g. "gemini-3.5-flash". */
  model: string;
  /** Its score on the visible farm (the goal's own score on a brief day, net worth otherwise). */
  score: number;
  /** Its final score over all farms once the hidden farms are scored, else null. */
  finalScore: number | null;
}
/** What the page knows about the machine for today: still loading, nothing to show, the clock for its run, or its score. */
export type RivalState = { kind: 'loading' } | { kind: 'none' } | { kind: 'soon'; at: number } | { kind: 'playing' } | { kind: 'rival'; rival: Rival };

/** The machine plays at this many minutes after the day opens (00:40 UTC). */
export const MACHINE_DELAY_MS = 40 * 60_000;
/** After this long without an entry, the card stops promising one. */
const MACHINE_GRACE_MS = 60 * 60_000;
const fmt = (n: number): string => n.toLocaleString('en-US');
const CACHE_KEY = 'tendril.rival.v1';
const CACHE_MS = 10 * 60_000;

/** "gemini-3.5-flash" -> "Gemini 3.5 Flash"; "claude-sonnet-5-5" -> "Claude Sonnet 5.5". */
export function modelLabel(id: string): string {
  const parts = id.trim().split(/[-_\s]+/).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (/^\d+$/.test(p) && prev !== undefined && /^\d+(\.\d+)*$/.test(prev) && p.length === 1 && prev.length === 1) out[out.length - 1] = `${prev}.${p}`;
    else out.push(/^\d/.test(p) ? p : p[0]!.toUpperCase() + p.slice(1));
  }
  return out.join(' ') || 'The machine';
}
/** The first word: "Gemini". */
export const shortName = (id: string): string => modelLabel(id).split(' ')[0]!;

/** Only a real daily has a machine. Practice farms, duels, seasons and the offline fallback do not. */
export const hasMachine = (c: ChallengeInfo): boolean => c.kind === 'daily' && !c.practice && !c.offline;

/** The better of the two ways a board row carries a score. */
export const rowScore = (r: Pick<BoardEntry, 'value' | 'score'>): number => r.score ?? r.value;

/** The machine's best entry among board rows, or null. */
export function pickRival(rows: readonly BoardEntry[]): Rival | null {
  let best: BoardEntry | null = null;
  for (const r of rows) if (r.authorKind === 'model' && r.model && (!best || rowScore(r) > rowScore(best))) best = r;
  return best ? { model: best.model!, score: rowScore(best), finalScore: best.finalScore ?? null } : null;
}

/** What to say before there is an entry: when the machine plays (viewer's local time), or nothing once that time is well past. */
export function waitingState(c: Pick<ChallengeInfo, 'opensAt'>, now: number): RivalState {
  if (c.opensAt === null) return { kind: 'none' };
  const at = c.opensAt + MACHINE_DELAY_MS;
  return now < at ? { kind: 'soon', at } : now < at + MACHINE_GRACE_MS ? { kind: 'playing' } : { kind: 'none' };
}

/** "6:10 AM IST" in the viewer's own zone. */
export function localTime(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

/** The start card's one line. Null means say nothing. */
export function startLine(s: RivalState, score: (n: number) => string = fmt, locale?: string): string | null {
  switch (s.kind) {
    case 'rival': return `${modelLabel(s.rival.model)} scored ${score(s.rival.score)} on the visible farm. Beat it.`;
    case 'soon': return `The machine plays at ${localTime(s.at, locale)}. Come back and beat its score.`;
    case 'playing': return 'The machine is playing today\'s farm now. Its score appears here soon.';
    default: return null;
  }
}

export interface Comparison { text: string; won: boolean | null; pct: number | null }
/**
 * "Beat Gemini by 14%" / "Gemini won by 6%" / "Tied with Gemini". The percent is the gap over the lower score; with a lower score of 0 or less no
 * percent is given. Under 1% reads "by less than 1%".
 */
export function compare(mine: number, theirs: number, model: string): Comparison {
  const name = shortName(model);
  if (mine === theirs) return { text: `Tied with ${name}`, won: null, pct: 0 };
  const won = mine > theirs;
  const low = Math.min(mine, theirs), gap = Math.abs(mine - theirs);
  const pct = low > 0 ? Math.max(0, Math.round((gap * 100) / low)) : null;
  const by = pct === null ? '' : pct < 1 ? ' by less than 1%' : ` by ${fmt(pct)}%`;
  return { text: won ? `Beat ${name}${by}` : `${name} won${by}`, won, pct };
}

/**
 * The result screen's comparison. Both sides final: the final scores. Otherwise the visible farms, marked provisional
 * (the hidden farms are scored when the day closes, for the machine too).
 */
export function resultLine(rival: Rival, mine: { score: number; finalScore: number | null }, hiddenFarms: number): { text: string; won: boolean | null; provisional: boolean } {
  const bothFinal = mine.finalScore !== null && rival.finalScore !== null;
  const c = bothFinal ? compare(mine.finalScore!, rival.finalScore!, rival.model) : compare(mine.score, rival.score, rival.model);
  const provisional = !bothFinal && hiddenFarms > 0;
  return { text: provisional ? `${c.text} on the visible farm` : c.text, won: c.won, provisional };
}

// ---- loading (browser) ----

let state: RivalState = { kind: 'none' };
export const getRival = (): RivalState => state;
const publish = (s: RivalState): void => { state = s; window.dispatchEvent(new CustomEvent('tendril:rival', { detail: s })); };

const readCache = (id: string, now: number): Rival | null | undefined => {
  try {
    const v = JSON.parse(sessionStorage.getItem(`${CACHE_KEY}.${id}`) ?? 'null') as { at: number; rival: Rival | null } | null;
    return v && now - v.at < CACHE_MS ? v.rival : undefined;
  } catch { return undefined; }
};
const writeCache = (id: string, now: number, rival: Rival | null): void => { try { sessionStorage.setItem(`${CACHE_KEY}.${id}`, JSON.stringify({ at: now, rival })); } catch { /* private mode: no cache */ } };

/** Starts the background read. The state is `loading` until it answers; failures settle on the clock line or nothing. */
export function mountRival({ api, challenge: c }: { api: FarmApi; challenge: ChallengeInfo }): void {
  if (!hasMachine(c)) { state = { kind: 'none' }; return; }
  const now = Date.now();
  const cached = readCache(c.id, now);
  if (cached) { state = { kind: 'rival', rival: cached }; return; }
  state = cached === null ? waitingState(c, now) : { kind: 'loading' };
  if (cached === null) return;
  void api.challengeBoard(c.id, 'model').then(({ entries }) => {
    const rival = pickRival(entries);
    writeCache(c.id, Date.now(), rival);
    publish(rival ? { kind: 'rival', rival } : waitingState(c, Date.now()));
  }).catch(() => publish({ kind: 'none' })); // a failed read says nothing rather than promising an entry
}

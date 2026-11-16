// Pure rules behind the sunset result screen (U6): medals, the hint for a missed run, the line about the player's best. No DOM, unit tested.
import type { ChallengeInfo, EntryResult } from './api-client.ts';
import { ordinal } from './share.ts';
import type { ProgramStatus } from './publish.ts';

const fmt = (n: number): string => n.toLocaleString('en-US');

export type MedalKey = 'wealth' | 'speed' | 'brevity';
export interface MedalView { key: MedalKey; name: string; state: 'earned' | 'missed' | 'pending' | 'locked'; line: string; rank: string | null }
export interface MedalInput {
  par: number | null; netWorth: number; parTick: number | null; ticks: number;
  signedIn: boolean; /** The server's answer, or null while it is still thinking or when signed out. */
  server: Pick<EntryResult, 'tokens' | 'ranks' | 'total'> | null; program: ProgramStatus | null; submitting: boolean;
}

export const rankText = (rank: number | null | undefined, total: number | undefined): string | null => (rank == null ? null : `${ordinal(rank)}${total ? ` of ${fmt(total)}` : ''}`);

/** The three medals. Wealth and Speed come from the exact local replay; Brevity needs the server to check the program. */
export function medals(i: MedalInput): MedalView[] {
  const wealthEarned = i.par === null ? i.netWorth > 0 : i.netWorth >= i.par;
  const wealth: MedalView = {
    key: 'wealth', name: 'Wealth', state: wealthEarned ? 'earned' : 'missed',
    line: i.par === null ? `${fmt(i.netWorth)} coins` : wealthEarned ? `${fmt(i.netWorth - i.par)} coins over par` : `${fmt(i.par - i.netWorth)} coins short of par`,
    rank: rankText(i.server?.ranks.wealth, i.server?.total),
  };
  const speed: MedalView = {
    key: 'speed', name: 'Speed', state: i.parTick !== null ? 'earned' : 'missed',
    line: i.parTick !== null ? `Par at tick ${fmt(i.parTick)} · ${fmt(Math.max(0, i.ticks - i.parTick))} ticks to spare` : i.par === null ? 'No par today' : 'Par not reached',
    rank: rankText(i.server?.ranks.speed, i.server?.total),
  };
  let brevity: MedalView;
  if (!i.signedIn) brevity = { key: 'brevity', name: 'Brevity', state: 'locked', line: 'Sign in to enter', rank: null };
  else if (i.submitting) brevity = { key: 'brevity', name: 'Brevity', state: 'pending', line: 'The server is checking your program…', rank: null };
  else if (i.parTick === null && i.par !== null) brevity = { key: 'brevity', name: 'Brevity', state: 'missed', line: 'Needs par first', rank: null };
  else if (i.server?.tokens != null && i.program === 'verified') {
    const r = rankText(i.server.ranks.brevity, i.server.total);
    brevity = { key: 'brevity', name: 'Brevity', state: r ? 'earned' : 'missed', line: `${fmt(i.server.tokens)} tokens`, rank: r };
  } else brevity = { key: 'brevity', name: 'Brevity', state: 'missed', line: i.program === 'mismatch' ? 'Program did not match the run' : i.program === 'unavailable' ? 'The program check is busy' : 'Needs a program on the slate', rank: null };
  return [wealth, speed, brevity];
}

export const belowPar = (c: Pick<ChallengeInfo, 'par'>, parTick: number | null): boolean => c.par !== null && parTick === null;

export interface Trail { lastSale: number | null; lastGrow: number | null; error: { bot: number; line?: number; message: string } | null }

/** One concrete hint for a run that missed par: a crashed bot first, else the tick where selling stopped. */
export function hintFor(t: Trail, ticks: number, netWorth: number, par: number | null): string {
  if (t.error) return `Bot ${t.error.bot} stopped${t.error.line ? ` on line ${t.error.line}` : ''}: ${t.error.message}. Fix that and the day runs on.`;
  const stop = t.lastSale ?? t.lastGrow;
  if (stop === null || stop <= 0) return 'Your coins never grew. Get one harvest sold early and build from there.';
  const left = Math.max(0, ticks - stop);
  const gap = par !== null && netWorth < par ? ` You finished ${fmt(par - netWorth)} coins short of par.` : '';
  return `Your coins stopped growing at tick ${fmt(stop)}, ${fmt(left)} ticks before sunset.${gap} What were your bots doing after that?`;
}

/** The "compared with your best" line. `prev` is the best this player scored here before this run, `top` the score to beat. */
export function bestLine(prev: number | null, now: number, top: number | null): string {
  const topBit = top === null ? '' : now >= top ? ' · at or above the score to beat' : ` · ${fmt(top - now)} below the score to beat`;
  if (prev === null) return `First run on this seed${topBit}`;
  if (now > prev) return `New personal best, ${fmt(now - prev)} above your last best (${fmt(prev)})${topBit}`;
  if (now === prev) return `Matches your best (${fmt(prev)})${topBit}`;
  return `${fmt(prev - now)} below your best (${fmt(prev)})${topBit}`;
}


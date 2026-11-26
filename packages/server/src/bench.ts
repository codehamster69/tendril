import { challengeSetup } from '@tendril/sim/src/index.ts';
import type { Db } from './db.ts';
import { isClosed, marketOf } from './arena.ts';
import type { ChallengeRow } from './arena.ts';
import { isBriefSetup } from './brief.ts';

/**
 * H1: "Humans vs machines". For each recent daily, the best human run against the best run of every declared model. Read only.
 * A run's number is the goal's own score when the day has a brief (the final score once the hidden farms are scored, else the
 * visible farm's), and net worth on a plain day. `final` says whether the number is final.
 */

export const BENCH_DAYS = 14;
const MAX_DAYS = 30;
const MAX_MODELS_PER_DAY = 6;

export interface BenchRun { login: string; displayName: string; model: string | null; value: number; final: boolean; entryId: string }
export interface BenchDay {
  id: string; date: string; number: number | null; closed: boolean; goal: string | null;
  human: BenchRun | null; models: BenchRun[];
  /** 'humans' or 'machines' once the day is closed and both best runs are final; 'tie' on equal numbers; null while undecided or when a side is missing. */
  winner: 'humans' | 'machines' | 'tie' | null;
}
export interface BenchResult { days: BenchDay[]; tally: { decided: number; humans: number; machines: number; ties: number } }

interface Row { challenge_id: string; id: string; author_kind: string; model: string | null; login: string; display_name: string; v: number; fin: number }

export const winnerOf = (human: BenchRun | null, models: readonly BenchRun[]): BenchDay['winner'] => {
  const top = models[0];
  if (!human || !top || !human.final || !top.final) return null;
  return human.value > top.value ? 'humans' : human.value < top.value ? 'machines' : 'tie';
};

export async function benchDays(db: Db, now: number, days: number = BENCH_DAYS): Promise<BenchResult> {
  const n = Math.max(1, Math.min(MAX_DAYS, Math.trunc(days)));
  const challenges = await db.query<ChallengeRow>(
    `SELECT * FROM challenges WHERE kind = 'daily' AND opens_at <= ? ORDER BY opens_at DESC LIMIT ?`, [now, n]);
  if (challenges.length === 0) return { days: [], tally: { decided: 0, humans: 0, machines: 0, ties: 0 } };
  const ids = challenges.map((c) => c.id);
  const marks = ids.map(() => '?').join(',');
  // One row per challenge and author (humans together, each model name apart): the best run, earliest first on a tie.
  const rows = await db.query<Row>(
    `WITH x AS (
       SELECT e.challenge_id, e.id, e.author_kind, e.model, u.login, u.display_name, e.created_at,
         CASE WHEN e.hidden_done = 1 AND e.final_score IS NOT NULL THEN e.final_score WHEN e.score IS NOT NULL THEN e.score ELSE e.net_worth END AS v,
         CASE WHEN e.score IS NULL OR e.hidden_done = 1 THEN 1 ELSE 0 END AS fin,
         CASE WHEN e.author_kind = 'model' THEN lower(trim(e.model)) ELSE '' END AS who
       FROM entries e JOIN users u ON u.id = e.user_id
       WHERE e.challenge_id IN (${marks}) AND (e.author_kind = 'human' OR (e.author_kind = 'model' AND e.model IS NOT NULL AND trim(e.model) <> ''))
     ), r AS (
       SELECT x.*, ROW_NUMBER() OVER (PARTITION BY challenge_id, author_kind, who ORDER BY v DESC, created_at ASC, id ASC) AS pick FROM x
     )
     SELECT challenge_id, id, author_kind, model, login, display_name, v, fin FROM r WHERE pick = 1 ORDER BY challenge_id, v DESC`, ids);
  const byChallenge = new Map<string, Row[]>();
  for (const r of rows) (byChallenge.get(r.challenge_id) ?? byChallenge.set(r.challenge_id, []).get(r.challenge_id)!).push(r);
  const run = (r: Row): BenchRun => ({ login: r.login, displayName: r.display_name, model: r.author_kind === 'model' ? r.model!.trim() : null, value: r.v, final: r.fin === 1, entryId: r.id });
  const out: BenchDay[] = challenges.map((c) => {
    const mine = byChallenge.get(c.id) ?? [];
    const human = mine.find((r) => r.author_kind === 'human');
    const models = mine.filter((r) => r.author_kind === 'model').slice(0, MAX_MODELS_PER_DAY).map(run);
    const closed = isClosed(c, now);
    let goal: string | null = null;
    if (isBriefSetup(c.setup_v)) {
      try { goal = challengeSetup(c.kind, c.seed, c.setup_v, marketOf(c), c.rules_version).brief?.goal.kind ?? null; } catch { goal = null; }
    }
    const h = human ? run(human) : null;
    return { id: c.id, date: c.id.slice(2), number: c.number, closed, goal, human: h, models, winner: closed ? winnerOf(h, models) : null };
  });
  const tally = { decided: 0, humans: 0, machines: 0, ties: 0 };
  for (const d of out) {
    if (!d.winner) continue;
    tally.decided++;
    if (d.winner === 'humans') tally.humans++; else if (d.winner === 'machines') tally.machines++; else tally.ties++;
  }
  return { days: out, tally };
}

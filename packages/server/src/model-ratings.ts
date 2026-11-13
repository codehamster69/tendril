import { ALGO_VERSION, PLACEMENT_EVENTS, START_RATING, rateContest, tierOf } from '@tendril/rating/src/index.ts';
import type { Standing, TierInfo } from '@tendril/rating/src/index.ts';
import type { Queryable } from './db.ts';
import { percentileOf } from './arena.ts';
import { DAY_MS } from './game.ts';
import type { Cand, Discipline } from './ratings.ts';

/**
 * R7: model ghosts. A declared model is rated against the finished human field with the same engine, but it is never part of
 * the field the humans were rated in: the human step runs first and is not touched, and each ghost is rated in a separate
 * `rateContest` call whose only output kept is the ghost's own row. So human ratings cannot depend on model entries.
 * Ratings live in `arena_meta` under `model_rating:<lowercased name>` (a handful of rows; no migration), written inside the
 * same transaction as the contest, so a recompute (which clears the keys) rebuilds them with the humans.
 */

export const MODEL_KEY_PREFIX = 'model_rating:';
/** A model shows on the ladder from this many rated days (humans need PLACEMENT_EVENTS to rank; models are flagged provisional below that). */
export const MODEL_LADDER_MIN_EVENTS = 3;
/** Most distinct models rated per discipline per contest (each costs one engine run over the field); models beyond it, in name order, are skipped for that contest. */
export const MAX_MODELS_PER_CONTEST = 20;
const HISTORY_CAP = 400;
const ACTIVE_WINDOW_MS = 30 * DAY_MS;
const HISTORY_SHOWN = 30;
const DISCS: readonly Discipline[] = ['overall', 'speed', 'brevity'];

interface Hist { c: string; k: 'd' | 's'; at: number; p: number; f: number; pf: number; d: number; b: number; r: number; e: string }
interface Disc { r: number; n: number; pk: number; h: Hist[] }
interface ModelData { v: 1; name: string; d: Partial<Record<Discipline, Disc>> }

export const modelKey = (name: string): string => name.trim().toLowerCase();

export interface GhostInput {
  challenge: { id: string; kind: string; closesAt: number };
  weight: number;
  /** Every entry of the contest (the human ones are ignored here). */
  cands: readonly (Cand & { model: string | null })[];
  /** Per discipline: false when the human field went unrated (then no ghost is rated either); the humans' standings with the ratings they started the contest on. */
  humans: Record<Discipline, { rated: boolean; standings: { standing: Standing; entryId: string }[] }>;
  order: Record<Discipline, (a: Cand, b: Cand) => number>;
  tieKey: Record<Discipline, (c: Cand) => string>;
  /** Whether the entry counts in this discipline (reached par; Brevity also needs a counted program). */
  gate: (d: Discipline, c: Cand) => boolean;
}

/** Rates every declared model that reached par in this contest. Returns the number of rows written. */
export async function rateGhosts(tx: Queryable, input: GhostInput): Promise<number> {
  const models = input.cands.filter((c) => c.author_kind === 'model' && c.model !== null && modelKey(c.model) !== '');
  if (models.length === 0) return 0;
  const byModel = new Map<string, { name: string; cands: typeof models }>();
  for (const c of models) {
    const key = modelKey(c.model!);
    const m = byModel.get(key) ?? { name: c.model!.trim(), cands: [] };
    m.cands.push(c);
    byModel.set(key, m);
  }
  // R9: names that reached par somewhere take the slots, strongest run first (then name). Sorting by name alone let a few throwaway
  // names ("aaa1", "aaa2", ...) that never reached par crowd a real model out of the per-contest cap.
  const strength = (key: string): number => Math.max(-1, ...byModel.get(key)!.cands.filter((c) => DISCS.some((d) => input.gate(d, c))).map((c) => c.net_worth));
  const keys = [...byModel.keys()].filter((k) => strength(k) >= 0).sort((a, b) => strength(b) - strength(a) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_MODELS_PER_CONTEST);
  const candOf = new Map(input.cands.map((c) => [c.id, c]));
  let writes = 0;
  for (const key of keys) {
    const m = byModel.get(key)!;
    const [stored] = await tx.query<{ value: string }>('SELECT value FROM arena_meta WHERE key = ?', [MODEL_KEY_PREFIX + key]);
    const data: ModelData = stored ? (JSON.parse(stored.value) as ModelData) : { v: 1, name: m.name, d: {} };
    let touched = false;
    for (const d of DISCS) {
      const h = input.humans[d];
      if (!h.rated) continue;
      const entries = m.cands.filter((c) => input.gate(d, c));
      if (entries.length === 0) continue;
      const best = entries.reduce((a, b) => (input.order[d](b, a) < 0 ? b : a));
      // Humans keep their relative order; the ghost slots in by the discipline's board order, sharing a place on an equal tie key.
      const field = h.standings.map((s) => ({ s, cand: candOf.get(s.entryId)! }));
      const merged: { id: string; cand: Cand; standing: Standing | null }[] = field.map((f) => ({ id: f.s.standing.id, cand: f.cand, standing: f.s.standing }));
      let at = merged.findIndex((x) => input.order[d](best, x.cand) < 0);
      if (at < 0) at = merged.length;
      const ghostId = `model:${key}`;
      merged.splice(at, 0, { id: ghostId, cand: best, standing: null });
      const prior = data.d[d];
      const standings: Standing[] = [];
      let prevKey = '', prevPlace = 0;
      merged.forEach((x, i) => {
        const k = input.tieKey[d](x.cand);
        const place = i > 0 && k === prevKey ? prevPlace : i + 1;
        prevKey = k; prevPlace = place;
        standings.push(x.standing ? { ...x.standing, place } : { id: ghostId, place, rating: prior?.r ?? START_RATING, events: prior?.n ?? 0 });
      });
      const change = rateContest({ standings, weight: input.weight, algoVersion: ALGO_VERSION }).find((c) => c.id === ghostId);
      if (!change) continue;
      const x: Disc = prior ?? { r: START_RATING, n: 0, pk: START_RATING, h: [] };
      const place = standings.find((s) => s.id === ghostId)!.place;
      x.h.push({ c: input.challenge.id, k: input.challenge.kind === 'season' ? 's' : 'd', at: input.challenge.closesAt, p: place, f: h.standings.length, pf: change.performance, d: change.delta, b: x.r, r: change.rating, e: best.id });
      if (x.h.length > HISTORY_CAP) x.h.splice(0, x.h.length - HISTORY_CAP);
      x.r = change.rating; x.n++; x.pk = Math.max(x.pk, change.rating);
      data.d[d] = x;
      touched = true;
    }
    if (!touched) continue;
    await tx.execute('INSERT INTO arena_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [MODEL_KEY_PREFIX + key, JSON.stringify(data)]);
    writes++;
  }
  return writes;
}

// ---- reading ----

export interface GhostDiscipline {
  rating: number; tier: TierInfo; provisional: boolean; events: number; peak: number; lastRatedAt: number;
  /** The place the model would hold on the human ladder: 1 + established, active humans rated higher. */
  humanRank: number; humans: number; percentile: number;
}
export interface GhostHistory { challengeId: string; kind: 'daily' | 'season'; closesAt: number; place: number; field: number; performance: number; delta: number; before: number; rating: number; entryId: string }
export interface GhostModel extends GhostDiscipline {
  name: string;
  disciplines: Record<Discipline, GhostDiscipline | null>;
  /** Overall history, newest last, the latest 30 days. */
  history: GhostHistory[];
}

/**
 * GET /ratings/models: declared models with at least three rated days and a rated run in the last 30 days, best overall rating
 * first. Top-level fields repeat `disciplines.overall`. Each discipline carries where the rating would sit on the human ladder
 * (`humanRank` of `humans`), so a leaderboard can slot a ghost row between players without a second request.
 */
export async function ratingModels(db: Queryable, now: number): Promise<{ models: GhostModel[] }> {
  const rows = await db.query<{ value: string }>("SELECT value FROM arena_meta WHERE substr(key, 1, ?) = ?", [MODEL_KEY_PREFIX.length, MODEL_KEY_PREFIX]);
  const since = now - ACTIVE_WINDOW_MS;
  const out: GhostModel[] = [];
  for (const row of rows) {
    const data = JSON.parse(row.value) as ModelData;
    const overall = data.d.overall;
    if (!overall || overall.n < MODEL_LADDER_MIN_EVENTS) continue;
    const last = overall.h[overall.h.length - 1]!.at;
    if (last < since) continue;
    const disciplines = { overall: null, speed: null, brevity: null } as Record<Discipline, GhostDiscipline | null>;
    for (const d of DISCS) {
      const x = data.d[d];
      if (!x) continue;
      const [r] = await db.query<{ above: number; total: number }>(
        `SELECT (SELECT COUNT(*) FROM rating_profiles WHERE n_${d} >= ?1 AND l_${d} >= ?2 AND r_${d} > ?3) AS above,
                (SELECT COUNT(*) FROM rating_profiles WHERE n_${d} >= ?1 AND l_${d} >= ?2) AS total`, [PLACEMENT_EVENTS, since, x.r]);
      const humanRank = r!.above + 1;
      disciplines[d] = {
        rating: x.r, tier: tierOf(x.r), provisional: x.n < PLACEMENT_EVENTS, events: x.n, peak: x.pk, lastRatedAt: x.h[x.h.length - 1]!.at,
        humanRank, humans: r!.total, percentile: r!.total === 0 ? 100 : percentileOf(humanRank, r!.total),
      };
    }
    out.push({
      name: data.name, ...disciplines.overall!, disciplines,
      history: overall.h.slice(-HISTORY_SHOWN).map((h) => ({ challengeId: h.c, kind: h.k === 's' ? 'season' : 'daily', closesAt: h.at, place: h.p, field: h.f, performance: h.pf, delta: h.d, before: h.b, rating: h.r, entryId: h.e })),
    });
  }
  out.sort((a, b) => b.rating - a.rating || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { models: out };
}

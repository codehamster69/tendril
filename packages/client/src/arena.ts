// Challenge play: daily (`?mode=daily`) and any challenge (`?mode=challenge&id=`). The sim mode is always 'daily'.
import { setupOf, challengeScenario } from './challenge-setup';
import { challengeSetup, createWorld, marketFits, dailyNumber, dailySeed, DAILY_PAR, daysUntilMarket, describeModifiers, describeMarket, replayWithPar, BASE_RULES_VERSION, SETUP_VERSION, SUPPORTED_RULES_VERSIONS } from '@tendril/sim/src/index.ts';
import type { LogEntry, Snapshot } from '@tendril/sim/src/index.ts';
import { ApiError } from './api-client';
import type { ChallengeInfo, EntryResult, FarmApi } from './api-client';
import type { GameLoop } from './game-loop';
import { el, toast } from './palette';
import { createPendingRuns } from './pending-run';
import { declaredModel, modelBox, publishBox, submitWithProgram } from './publish';
import type { ProgramStatus } from './publish';

export const CHALLENGE_ID = /^(?:week|[dsx]-[A-Za-z0-9_-]{1,40})$/; // `week` = the current season, resolved by the server

export const utcToday = (): string => new Date().toISOString().slice(0, 10);

/** Which challenge this page plays. Daily falls back to a local copy when the server is unreachable. */
export async function loadChallenge(api: FarmApi, query: URLSearchParams): Promise<ChallengeInfo> {
  const requested = query.get('mode') === 'challenge' ? query.get('id') ?? '' : `d-${utcToday()}`;
  if (!CHALLENGE_ID.test(requested)) { location.replace('?mode=daily'); throw new Error('Unknown challenge'); }
  try { return requireKnownRules(await api.challenge(requested)); } catch (e) {
    if (e instanceof RulesTooNew) throw e;
    if (query.get('mode') === 'challenge') {
      if (e instanceof ApiError && e.status !== 0) { toast('Challenge not found', 'Opening today\'s farm instead.'); location.replace('?mode=daily'); }
      throw e;
    }
    const date = utcToday();
    return {
      id: `d-${date}`, kind: 'daily', number: dailyNumber(date), seed: dailySeed(date), ticks: challengeSetup('daily', dailySeed(date)).ticks, par: DAILY_PAR,
      opensAt: null, closesAt: null, rulesVersion: BASE_RULES_VERSION, setupVersion: SETUP_VERSION, players: 0, best: null,
      market: null, // offline: base prices, practice only (a market day's table comes from the server)
    };
  }
}

export const UPDATE_NEEDED = 'This day needs a newer Tendril. Update the app.';
export class RulesTooNew extends Error { constructor() { super(UPDATE_NEEDED); this.name = 'RulesTooNew'; } }

/**
 * A client plays only rules versions it knows (SIM_SPEC 4.6). Anything newer, or a market day without its table, is refused
 * before the game starts, with a visible message instead of a run that could never be accepted.
 */
export function requireKnownRules(c: ChallengeInfo): ChallengeInfo {
  const known = SUPPORTED_RULES_VERSIONS.includes(c.rulesVersion) && marketFits(c.rulesVersion, c.kind, !!c.market);
  if (known) return c;
  const banner = el('div', { id: 'update-needed', class: 'update-needed', role: 'alert' }, UPDATE_NEEDED);
  banner.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:1000;padding:14px 16px;background:#b3261e;color:#fff;font:600 15px system-ui,sans-serif;text-align:center';
  document.body.prepend(banner);
  throw new RulesTooNew();
}

export { challengeScenario, setupOf };

/** Days until the shared market opens for a daily dated before the market epoch (0 otherwise): feeds the farm's market card. */
export function marketOpensIn(c: ChallengeInfo): number {
  if (c.kind !== 'daily' || !/^d-\d{4}-\d{2}-\d{2}$/.test(c.id)) return 0;
  return c.market ? 0 : daysUntilMarket(c.id.slice(2));
}

/** The market block: "Market opens in N days" before the epoch, the day's prices and yesterday's shares from then on. */
export function marketPanel(c: ChallengeInfo): HTMLElement | null {
  if (c.kind !== 'daily' || !/^d-\d{4}-\d{2}-\d{2}$/.test(c.id)) return null;
  const view = describeMarket(c.id.slice(2), c.market);
  if (!view) return null;
  if (view.kind === 'soon') return view.days > 0 ? el('p', { id: 'arena-market', class: 'market-soon', text: view.text }) : null;
  const head = el('tr', {}, ...['Item', 'Price', 'vs base', 'Sold yesterday'].map((t) => el('th', { scope: 'col', text: t })));
  const body = view.rows.map((r) => el('tr', { class: `m-${r.trend}` },
    el('th', { scope: 'row', text: r.name }), el('td', { text: r.price }), el('td', { text: r.change }), el('td', { text: r.share ?? '—' })));
  return el('details', { id: 'arena-market', class: 'market', open: '' },
    el('summary', { text: "Today's market" }),
    el('p', { class: 'muted', text: `${view.text}. Orders always pay the base price.` }),
    el('table', {}, el('thead', {}, head), el('tbody', {}, ...body)));
}

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
};

/** The score the player just earned, replayed locally exactly as the server will replay it. */
export function localResult(c: ChallengeInfo, actions: LogEntry[]): { netWorth: number; parTick: number | null; mosaic: string } {
  const world = createWorld({ id: c.id, seed: c.seed }, setupOf(c).setup);
  return replayWithPar(world, actions, c.ticks, c.par ?? Number.MAX_SAFE_INTEGER);
}

const PENDING_KEY = 'tendril.pending-runs.v1';
let pendingRuns: ReturnType<typeof createPendingRuns> | undefined;
/** A run the server could not take (offline, rate limit, read-only budget guard) is kept on this device and retried. */
function pending(api: FarmApi): ReturnType<typeof createPendingRuns> {
  return (pendingRuns ??= createPendingRuns({
    load: () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}'); } catch { return {}; } },
    save: (all) => { try { localStorage.setItem(PENDING_KEY, JSON.stringify(all)); } catch { /* storage full or blocked: the run stays in memory only */ } },
    submit: (run) => api.submitEntry(run.challengeId, { rulesVersion: run.rulesVersion, actions: run.actions }),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as number),
    now: Date.now,
    onSubmitted: (run, entry) => { window.dispatchEvent(new CustomEvent('tendril:entry-submitted', { detail: { challengeId: run.challengeId, entry } })); toast('Run submitted', 'Your saved run reached the server.'); },
  }));
}

/** Submits the finished run; if it cannot be delivered it is kept and retried automatically (F2). */
async function submitPlain(api: FarmApi, c: ChallengeInfo, actions: LogEntry[]): Promise<EntryResult> {
  try {
    return await pending(api).submit({ challengeId: c.id, rulesVersion: c.rulesVersion, actions }) as EntryResult;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 0 || e.status === 429 || e.status >= 500)) throw new ApiError(e.status, 'Could not reach the server right now. Your run is saved on this device and will be sent automatically.');
    throw e;
  }
}

/** With a program: sent with the run for the Brevity check. If the server cannot be reached the plain run goes through the retry queue. */
export async function submitRun(api: FarmApi, c: ChallengeInfo, actions: LogEntry[], source: string | null = null): Promise<EntryResult & { program: ProgramStatus }> {
  if (source !== null && source.trim() !== '') {
    try { return await submitWithProgram(api, c, actions, source); }
    catch (e) { if (declaredModel() !== null || !(e instanceof ApiError && (e.status === 0 || e.status === 429 || e.status >= 500))) throw e; }
  }
  if (declaredModel() !== null) throw new ApiError(422, 'A model entry needs a program. Write one in the editor first.');
  return { ...(await submitPlain(api, c, actions)), program: 'none' as const };
}

/** The challenge's name: "Daily farm #12", "Weekly season #3", "Duel", or a practice label. */
export function challengeTitle(c: ChallengeInfo): string {
  const number = c.number !== null && c.number > 0 ? c.number : null; // days before the 1 Dec 2026 launch count as practice
  return c.kind === 'season' ? (number !== null ? `Weekly season #${number}` : 'Practice week') : number !== null ? `Daily farm #${number}` : c.kind === 'daily' ? `Practice farm · ${c.id.slice(2)}` : c.kind === 'duel' ? 'Duel' : c.id;
}

export function mountArena({ loop, api, challenge: c }: { loop: GameLoop; api: FarmApi; challenge: ChallengeInfo }): void {
  const host = document.getElementById('lesson-card')!; host.hidden = false;
  void pending(api).flush(); // send any run left over from an earlier visit
  window.addEventListener('online', () => { void pending(api).flush(); });
  window.addEventListener('tendril:account', (event) => { if ((event as CustomEvent<{ profile: unknown }>).detail.profile) void pending(api).flush(); });
  const title = challengeTitle(c);
  const left = el('b', { id: 'arena-left', text: '' });
  const beat = el('b', { id: 'arena-beat', text: '' });
  const runEnd = el('button', { id: 'btn-run-end', class: 'primary', text: 'Run to end' });
  runEnd.addEventListener('click', () => { void loop.runToEnd(); });
  const fold = el('button', { id: 'btn-arena-fold', class: 'quiet', 'aria-expanded': 'true', 'aria-controls': 'arena-body', text: 'Hide details' });
  const head = el('header', { id: 'arena-head' }, el('span', { class: 'eyebrow', text: title }), el('span', { class: 'arena-head-actions' }, fold, runEnd));
  const mods = describeModifiers(setupOf(c).modifiers, c.kind);
  const modLine = mods.length ? el('p', { id: 'arena-mods', title: "Today's modifiers", text: `Today: ${mods.join(' · ')}` }) : null;
  // Practice challenges have no deadline, so they say that instead of "Time left open".
  const stats = el('p', { id: 'arena-stats' }, c.closesAt === null ? 'No deadline in practice' : 'Time left ', left, ' · Score to beat ', beat);
  const marketEl = marketPanel(c);
  const body = el('div', { id: 'arena-body' }, publishBox(), modelBox(), el('h3', { text: `One seed. ${c.ticks.toLocaleString('en-US')} ticks. Your best program.` }), ...(modLine ? [modLine] : []), ...(marketEl ? [marketEl] : []), stats);
  host.append(head, body);
  // The card can be folded away so the editor always has room; it also scrolls if it is taller than the panel allows.
  fold.addEventListener('click', () => { const open = body.hidden; body.hidden = !open; fold.setAttribute('aria-expanded', String(open)); fold.textContent = open ? 'Hide details' : 'Show details'; });

  const draw = (): void => {
    left.textContent = c.closesAt === null ? '' : c.closesAt <= Date.now() ? 'closed' : clock(c.closesAt - Date.now());
    const target = c.best ?? c.par;
    beat.textContent = target === null ? '—' : `${target.toLocaleString('en-US')} coins`;
  };
  draw(); setInterval(draw, 1000);
  window.addEventListener('tendril:status', (event) => { runEnd.disabled = !(event as CustomEvent<{ canStep: boolean }>).detail.canStep; });
  // The finished run is shown by result-screen.ts (U6); the market block reopens when a new run starts.
  window.addEventListener('tendril:snapshot', (event) => { if ((event as CustomEvent<Snapshot>).detail.tick < c.ticks && marketEl instanceof HTMLDetailsElement) marketEl.open = true; });
}

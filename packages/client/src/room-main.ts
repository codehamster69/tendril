import { FarmView } from './farm-view';
import type { Snapshot } from '@tendril/sim/src/index.ts';
import { DUEL_ID, RoomClock, drawMiniFarm, loadRoom, playerName, rankOrder } from './room';
import type { RoomRun } from './room';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const id = params.get('id') ?? '';
if (params.get('embed') === '1') document.body.classList.add('embed');
const fmt = (n: number): string => n.toLocaleString('en-US');

function fail(message: string): void {
  const el = $('error');
  el.textContent = message;
  el.hidden = false;
  $('meta').textContent = '';
}

interface Tile { run: RoomRun; root: HTMLElement; canvas: HTMLCanvasElement | null; rank: HTMLElement; worth: HTMLElement }

function tileFor(run: RoomRun): Tile {
  const root = document.createElement('div');
  root.className = 'tile';
  root.dataset.entry = run.player.entryId;
  const head = document.createElement('div');
  head.className = 'head';
  const who = document.createElement('span');
  who.className = 'name';
  const rank = document.createElement('span');
  rank.className = 'rank';
  const name = document.createElement('span');
  name.textContent = playerName(run.player);
  who.append(rank, name);
  const worth = document.createElement('span');
  worth.className = 'worth';
  worth.textContent = run.state === 'live' ? '0' : '';
  head.append(who, worth);
  root.append(head);
  let canvas: HTMLCanvasElement | null = null;
  if (run.state === 'live') {
    canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 120;
    canvas.setAttribute('aria-label', `${playerName(run.player)}'s farm`);
    root.append(canvas);
  } else {
    root.classList.add('off');
    const note = document.createElement('div');
    note.className = 'off-note';
    note.textContent = run.state === 'sealed' ? 'Sealed. Finish this duel yourself to watch.' : 'No replay stored for this run.';
    root.append(note);
  }
  return { run, root, canvas, rank, worth };
}

async function main(): Promise<void> {
  if (!DUEL_ID.test(id)) return fail('This room link is not valid. Open it from a duel page.');
  const { duel, runs } = await loadRoom(id, (done, total) => { $('meta').textContent = `Loading farms ${done} / ${total}…`; }).catch((e: unknown) => {
    fail(e instanceof Error ? e.message : 'Could not load the room.');
    return { duel: null, runs: [] as RoomRun[] };
  });
  if (!duel) return;
  if (runs.length === 0) return fail('Nobody has posted a run on this duel yet.');

  const hostAt = Math.max(0, runs.findIndex((r) => r.player.host)); // no posted host score: the top run is shown large
  const large = runs[hostAt]!;
  const total = Math.max(1, duel.ticks);
  $('meta').textContent = `${duel.id} · ${runs.length} ${runs.length === 1 ? 'farm' : 'farms'} on one clock`;
  $<HTMLAnchorElement>('duel-link').href = `../duel/?id=${encodeURIComponent(duel.id)}`;
  $('host-name').textContent = playerName(large.player);
  const hostStage = $('host').querySelector<HTMLElement>('.stage')!;
  const flat = hostStage.querySelector('canvas')!;
  let hostView: FarmView | null = null;
  let hostCanvas3d: HTMLCanvasElement | null = null;
  let lastHost: Snapshot | null = null;
  // The large host farm is drawn flat by default: always 30 frames a second, light on a streamer's CPU and GPU, and it
  // survives OBS capture. The real 3D renderer is an opt-in toggle (it needs a GPU; software rendering manages a few fps).
  const drawHost = (): void => {
    if (!lastHost) return;
    if (hostView) hostView.update(lastHost);
    else drawMiniFarm(flat, lastHost);
  };
  if (large.state !== 'live') {
    flat.hidden = true;
    $('toggle-3d-label').hidden = true;
    const note = document.createElement('p');
    note.className = 'off-note';
    note.style.cssText = 'margin:auto;padding:24px;text-align:center;position:relative;color:#1c3a2a';
    note.textContent = large.state === 'sealed' ? 'The host farm is sealed. Finish this duel yourself to watch it.' : 'The host farm has no stored replay.';
    hostStage.append(note);
  }
  const set3d = (on: boolean): void => {
    if (on === !!hostView) return;
    if (on) {
      hostCanvas3d = document.createElement('canvas');
      hostCanvas3d.setAttribute('aria-label', 'Host farm, 3D');
      hostStage.append(hostCanvas3d);
      flat.hidden = true;
      hostView = new FarmView(hostCanvas3d);
    } else {
      hostView?.dispose();
      hostCanvas3d?.remove();
      hostView = hostCanvas3d = null;
      flat.hidden = false;
    }
    document.body.dataset.host3d = String(on);
    drawHost();
  };
  $<HTMLInputElement>('toggle-3d').addEventListener('change', (e) => set3d((e.target as HTMLInputElement).checked));
  if (params.get('view') === '3d' && large.state === 'live') { $<HTMLInputElement>('toggle-3d').checked = true; set3d(true); }

  const tiles = runs.map((r, i) => (i === hostAt ? null : tileFor(r)));
  const field = $('field');
  for (const t of tiles) if (t) field.append(t.root);
  const sealedCount = runs.filter((r) => r.state === 'sealed').length;
  if (sealedCount > 0) {
    $('note').textContent = `${sealedCount} ${sealedCount === 1 ? 'farm is' : 'farms are'} sealed until you finish your own run on this duel. Sealed runs stay out of the ranking.`;
    $('note').hidden = false;
  }
  $('room').hidden = false;

  const live = runs.map((r, i) => ({ r, i })).filter((x) => x.r.state === 'live') as { r: Extract<RoomRun, { state: 'live' }>; i: number }[];
  const clock = new RoomClock(total);
  const scrub = $<HTMLInputElement>('scrub');
  scrub.max = String(total);
  $('controls').hidden = false;
  const worthEls = new Map<number, HTMLElement>();
  const rankEls = new Map<number, HTMLElement>();
  tiles.forEach((t, i) => { if (t) { worthEls.set(i, t.worth); rankEls.set(i, t.rank); } });
  const hostWorth = document.querySelector<HTMLElement>('[data-testid="host-worth"]')!;
  const hostRank = document.querySelector<HTMLElement>('[data-testid="host-rank"]')!;

  let frames = 0, windowStart = performance.now(), windowFrames = 0;
  let drawMs = 0;
  const draw = (): void => {
    const started = performance.now();
    const worth = live.map(() => 0);
    live.forEach(({ r, i }, k) => {
      const snap = r.timeline.seek(Math.min(clock.tick, r.timeline.ticks));
      worth[k] = snap.netWorth;
      const tile = tiles[i];
      if (tile?.canvas) drawMiniFarm(tile.canvas, snap);
      else if (i === hostAt) { lastHost = snap; drawHost(); }
    });
    const hostSlot = live.findIndex((x) => x.i === hostAt);
    const order = rankOrder(worth, hostSlot);
    order.forEach((k, place) => {
      const { i } = live[k]!;
      const label = `#${place + 1}`;
      if (i === hostAt) { hostRank.textContent = label; hostWorth.textContent = fmt(worth[k]!); hostWorth.dataset.value = String(worth[k]); hostRank.dataset.place = String(place + 1); }
      else {
        const tile = tiles[i]!;
        tile.root.style.order = String(place);
        tile.root.dataset.place = String(place + 1);
        rankEls.get(i)!.textContent = label;
        const w = worthEls.get(i)!;
        w.textContent = fmt(worth[k]!);
        w.dataset.value = String(worth[k]);
      }
    });
    tiles.forEach((t, i) => { if (t && runs[i]!.state !== 'live') t.root.style.order = String(1000 + i); });
    scrub.value = String(clock.tick);
    $('clock').textContent = `tick ${clock.tick} / ${total}`;
    document.body.dataset.tick = String(clock.tick);
    frames++; windowFrames++;
    drawMs = drawMs === 0 ? performance.now() - started : drawMs * 0.9 + (performance.now() - started) * 0.1; // rolling mean cost of one frame
    document.body.dataset.frames = String(frames);
    document.body.dataset.drawMs = drawMs.toFixed(2);
  };

  const label = (): void => { $('btn-play').textContent = clock.playing ? 'Pause' : clock.tick >= total ? 'Replay' : 'Play'; };
  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    if (!clock.due(now)) return;
    const wasPlaying = clock.playing;
    if (clock.advance(now) || dirty) { dirty = false; draw(); }
    if (wasPlaying && !clock.playing) label();
    if (now - windowStart >= 1000) {
      document.body.dataset.fps = String(Math.round((windowFrames * 1000) / (now - windowStart)));
      windowStart = now; windowFrames = 0;
    }
  };
  let dirty = true;
  $('btn-play').addEventListener('click', () => { if (clock.playing) clock.pause(); else clock.play(performance.now()); dirty = true; label(); });
  scrub.addEventListener('input', () => { clock.seek(Number(scrub.value), performance.now()); dirty = true; });
  $<HTMLSelectElement>('speed').addEventListener('change', (e) => { clock.speed = Number((e.target as HTMLSelectElement).value); });
  label();
  draw();
  requestAnimationFrame(frame);
  document.body.dataset.state = 'ready';
  document.body.dataset.farms = String(runs.length);
  document.body.dataset.live = String(live.length);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : 'Could not load the room.'));

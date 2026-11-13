import { FarmView } from './farm-view';
import { clipSupport, downloadClip, exportClip, UNSUPPORTED_MESSAGE } from './clip';
import { paneHeader, Timeline } from './replay-view';
import type { ReplayData, ReplayEntry } from './replay-view';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const idA = params.get('e') ?? params.get('entry');
const idB = params.get('vs');
if (params.get('embed') === '1') document.body.classList.add('embed');
const api = (path: string): string => `/api${path}`;

function fail(message: string): void {
  const el = $('error');
  el.textContent = message;
  el.hidden = false;
  $('meta').textContent = '';
}

type Loaded = { entry: ReplayEntry; timeline: Timeline } | { entry: ReplayEntry; sealed: true };

async function load(id: string): Promise<Loaded> {
  const res = await fetch(api(`/entries/${encodeURIComponent(id)}`));
  if (!res.ok) throw new Error(res.status === 404 ? 'That run does not exist.' : 'Could not load that run.');
  const entry = (await res.json()) as ReplayEntry;
  if (entry.sealed) return { entry, sealed: true };
  const rep = await fetch(api(`/entries/${encodeURIComponent(id)}/replay`));
  if (rep.status === 403) return { entry, sealed: true };
  if (!rep.ok) throw new Error(rep.status === 404 ? 'This run has no stored replay.' : 'Could not load the replay.');
  const data = (await rep.json()) as ReplayData;
  return { entry, timeline: new Timeline(entry.challenge.kind, data.seed, data.ticks, data.actions, data.setupVersion, data.market?.prices ?? null) };
}

async function main(): Promise<void> {
  if (!idA) return fail('No run selected. Open a replay link.');
  const loaded = await Promise.all([load(idA), ...(idB ? [load(idB)] : [])]);
  const sealed = loaded.find((l): l is Loaded & { sealed: true } => 'sealed' in l);
  if (sealed) {
    const closes = sealed.entry.challenge.closesAt;
    $('sealed-note').textContent = closes ? `Replays open to everyone when the challenge closes (${new Date(closes).toUTCString()}).` : 'Replays open to everyone when the challenge closes.';
    $('sealed').hidden = false;
    $('meta').textContent = 'Sealed';
    document.body.dataset.state = 'sealed';
    return;
  }
  const runs = loaded as { entry: ReplayEntry; timeline: Timeline }[];
  const panes = [$('pane-a'), $('pane-b')].slice(0, runs.length);
  $('panes').classList.toggle('race', runs.length > 1);
  const views = runs.map((run, i) => {
    panes[i]!.hidden = false;
    const header = paneHeader(panes[i]!, run.entry);
    const view = new FarmView(panes[i]!.querySelector('canvas')!);
    return { ...run, header, view };
  });
  const total = Math.max(...runs.map((r) => r.timeline.ticks));
  const c = runs[0]!.entry.challenge;
  $('meta').textContent = `${c.kind === 'daily' && c.number != null ? (c.number > 0 ? `Daily #${c.number}` : 'Practice daily') : c.id} · ${runs.map((r) => r.entry.player.displayName || r.entry.player.login).join(' vs ')}`;
  $<HTMLAnchorElement>('play-link').href = `./?mode=${c.kind === 'daily' ? 'daily' : 'live'}`;

  const scrub = $<HTMLInputElement>('scrub');
  scrub.max = String(total);
  $('controls').hidden = false;
  let tick = 0, playing = false, last = 0, carry = 0;
  const show = (t: number): void => {
    tick = Math.max(0, Math.min(total, Math.floor(t)));
    for (const v of views) {
      const snap = v.timeline.seek(Math.min(tick, v.timeline.ticks));
      v.view.update(snap);
      v.header.setWorth(snap.netWorth);
    }
    scrub.value = String(tick);
    $('clock').textContent = `tick ${tick} / ${total}`;
    document.body.dataset.tick = String(tick);
  };
  const setPlaying = (on: boolean): void => { playing = on; $('btn-play').textContent = on ? 'Pause' : tick >= total ? 'Replay' : 'Play'; last = performance.now(); };
  const frame = (now: number): void => {
    if (playing) {
      carry += ((now - last) / 100) * Number($<HTMLSelectElement>('speed').value);
      last = now;
      const whole = Math.floor(carry);
      if (whole > 0) { carry -= whole; show(tick + whole); if (tick >= total) setPlaying(false); }
    }
    requestAnimationFrame(frame);
  };
  $('btn-play').addEventListener('click', () => { if (!playing && tick >= total) show(0); setPlaying(!playing); });
  scrub.addEventListener('input', () => { show(Number(scrub.value)); if (tick >= total) setPlaying(false); });
  const clipBtn = $<HTMLButtonElement>('btn-clip');
  const clipStatus = $('clip-status');
  const names = runs.map((r) => r.entry.player.displayName || r.entry.player.login);
  clipBtn.addEventListener('click', () => {
    if (!clipSupport()) { clipStatus.textContent = UNSUPPORTED_MESSAGE; return; }
    setPlaying(false);
    const resume = tick;
    clipBtn.disabled = true;
    const label = c.kind === 'daily' && c.number != null ? (c.number > 0 ? `Daily #${c.number}` : 'Practice daily') : c.id;
    const worth = Math.max(...runs.map((r) => r.timeline.finalNetWorth));
    exportClip({
      canvases: panes.map((p) => p.querySelector('canvas')!),
      names,
      total,
      seek: (t) => show(t),
      caption: `${label} · ${names.join(' vs ')} · ${worth.toLocaleString('en-US')}`,
      onProgress: (f) => { clipStatus.textContent = `Recording… ${Math.round(f * 100)}%`; },
    }).then((res) => {
      downloadClip(res, `tendril-${c.id}-${runs[0]!.entry.id}`);
      clipStatus.textContent = 'Clip saved.';
      document.body.dataset.clip = String(res.blob.size);
    }).catch((e: unknown) => {
      clipStatus.textContent = e instanceof Error ? e.message : 'Could not export the clip.';
    }).finally(() => { clipBtn.disabled = false; show(resume); });
  });
  show(0);
  setPlaying(false);
  requestAnimationFrame(frame);
  // Test and diagnostics hooks: final values come from a full re-run of the log, not the server's claim.
  document.body.dataset.state = 'ready';
  document.body.dataset.finalA = String(runs[0]!.timeline.finalNetWorth);
  document.body.dataset.verifiedA = String(runs[0]!.timeline.finalNetWorth === runs[0]!.entry.netWorth);
  if (runs[1]) {
    document.body.dataset.finalB = String(runs[1].timeline.finalNetWorth);
    document.body.dataset.verifiedB = String(runs[1].timeline.finalNetWorth === runs[1].entry.netWorth);
  }
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : 'Could not load the replay.'));

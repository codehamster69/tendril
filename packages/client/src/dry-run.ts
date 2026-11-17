// Dry run (Endless farms): try the editor's code on a private copy of the farm before it touches the real one.
import './dry-run.css';
import { DRY_RUN_SPANS, dryRows, dryVerdict } from './dry-run-core';
import type { DryRunResult } from './dry-run-core';
import type { DryFromWorker, DryToWorker } from './dry-run-worker';
import type { Editor } from './editor';
import type { GameLoop } from './game-loop';
import { el, toast } from './palette';

const fmt = (n: number): string => n.toLocaleString('en-US');
const SPAN_KEY = 'tendril.dryrun.span';
const savedSpan = (): number => { try { const n = Number(localStorage.getItem(SPAN_KEY)); return (DRY_RUN_SPANS as readonly number[]).includes(n) ? n : DRY_RUN_SPANS[0]; } catch { return DRY_RUN_SPANS[0]; } };

export function mountDryRun({ loop, editor }: { loop: GameLoop; editor: Editor }): void {
  if (loop.mode !== 'live') return;
  const open = el('button', { id: 'tp-dryrun', class: 'hk-button tp-dryrun', type: 'button', text: 'Dry run', title: 'Try the code in the editor on a private copy of your farm', disabled: '' });
  document.getElementById('transport')?.append(open);
  window.addEventListener('tendril:snapshot', () => { open.disabled = false; }, { once: true });

  let span = savedSpan();
  let worker: Worker | null = null;
  let job = 0;
  let tested: string | null = null;
  let result: DryRunResult | null = null;

  const title = el('h2', { id: 'dr-title', text: 'Dry run' });
  const close = el('button', { class: 'hk-button dr-close', type: 'button', text: 'Close' });
  const lede = el('p', { class: 'dr-lede', text: 'Plays the code in your editor on a private copy of your farm, next to the code running now. Your real farm keeps going and nothing changes until you apply.' });
  const spans = DRY_RUN_SPANS.map((n) => el('button', { class: 'hk-button dr-span', type: 'button', 'data-ticks': String(n), 'aria-pressed': String(n === span), text: fmt(n) }));
  const start = el('button', { class: 'hk-button hk-primary dr-start', type: 'button', text: 'Start dry run' });
  const spanRow = el('div', { class: 'dr-spans', role: 'group', 'aria-label': 'How long to run' }, el('span', { class: 'dr-label', text: 'Ticks' }), ...spans, start);
  const bar = el('progress', { class: 'dr-progress', max: '1', value: '0', 'aria-label': 'Dry run progress' });
  const status = el('p', { class: 'dr-status', role: 'status', 'aria-live': 'polite' });
  const verdict = el('p', { class: 'dr-verdict' });
  const table = el('table', { class: 'dr-table' });
  const note = el('p', { class: 'dr-note' });
  const apply = el('button', { class: 'hk-button hk-primary dr-apply', type: 'button', text: 'Apply code' });
  const again = el('button', { class: 'hk-button dr-again', type: 'button', text: 'Run again' });
  const results = el('div', { class: 'dr-results', hidden: '' }, verdict, table, note, el('div', { class: 'dr-buttons' }, apply, again));
  const card = el('section', { id: 'dry-run', class: 'hk-card dr-card', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'dr-title' },
    el('header', {}, el('div', {}, el('span', { class: 'dr-eyebrow', text: 'Private copy · not synced' }), title), close), lede, spanRow, bar, status, results);
  const layer = el('div', { class: 'dr-layer', hidden: '' }, card);
  document.body.append(layer);

  const busy = (on: boolean): void => {
    card.dataset.busy = String(on);
    start.disabled = on;
    for (const b of spans) b.disabled = on;
    start.textContent = on ? 'Running…' : result ? 'Start again' : 'Start dry run';
    bar.hidden = !on;
  };
  const stop = (): void => { job++; worker?.terminate(); worker = null; busy(false); };
  const hide = (): void => { stop(); layer.hidden = true; open.setAttribute('aria-expanded', 'false'); open.focus(); };
  const show = (): void => {
    layer.hidden = false; open.setAttribute('aria-expanded', 'true');
    refreshStale();
    (results.hidden ? start : apply.disabled ? again : apply).focus();
  };
  const refreshStale = (): void => {
    if (!result) return;
    const changed = tested !== editor.getSource();
    apply.disabled = !result.after || changed || loop.runningSource === tested;
    note.textContent = changed ? 'The editor has changed since this dry run. Run again to test the new text.'
      : loop.runningSource === tested ? 'This code is already running on your farm.'
      : `Both ran on a copy of your farm from tick ${fmt(result.startTick)}, with the same weather and orders.`;
  };

  function paint(r: DryRunResult): void {
    verdict.textContent = dryVerdict(r);
    verdict.dataset.tone = !r.after || r.after.crashes > (r.before?.crashes ?? 0) ? 'bad' : r.before && r.after.netWorthPer1000 < r.before.netWorthPer1000 ? 'bad' : 'good';
    table.replaceChildren(el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: `${fmt(r.ticks)} ticks` }), el('th', { scope: 'col', text: 'Code now' }), el('th', { scope: 'col', text: 'New code' }))));
    const body = el('tbody');
    for (const row of dryRows(r)) {
      const tr = el('tr', { 'data-better': row.better === null ? 'same' : String(row.better) },
        el('th', { scope: 'row', text: row.label }), el('td', { text: row.before }), el('td', { class: 'dr-after', text: row.after }));
      body.append(tr);
      if (row.hint && r.after && r.after.crashes) body.append(el('tr', { class: 'dr-hint' }, el('td', { colspan: '3', text: row.hint })));
    }
    if (!r.after) for (const d of r.diagnostics.filter((x) => x.severity === 'error').slice(0, 3)) body.append(el('tr', { class: 'dr-hint' }, el('td', { colspan: '3', text: `Line ${d.line}: ${d.message}` })));
    table.append(body);
    results.hidden = false;
    refreshStale();
  }

  async function begin(): Promise<void> {
    stop();
    const mine = ++job;
    busy(true);
    results.hidden = true; // an old result must not read as the new one
    bar.value = 0;
    status.textContent = 'Copying your farm…';
    let world: string | null;
    try { world = await loop.sim.durableWorld(); } catch (e) { world = null; status.textContent = e instanceof Error ? e.message : String(e); }
    if (mine !== job) return;
    if (!world) { busy(false); status.textContent ||= 'Your farm has not loaded yet.'; return; }
    const source = editor.getSource();
    const w = new Worker(new URL('./dry-run-worker.ts', import.meta.url), { type: 'module' });
    worker = w;
    status.textContent = `Running ${fmt(span)} ticks twice…`;
    w.onmessage = (e: MessageEvent<DryFromWorker>) => {
      const m = e.data;
      if (mine !== job || m.id !== mine) return;
      if (m.type === 'progress') { bar.value = m.done / m.total; return; }
      w.terminate(); if (worker === w) worker = null;
      if (m.type === 'error') { busy(false); status.textContent = m.message; return; }
      result = m.result; tested = source;
      busy(false);
      status.textContent = '';
      paint(m.result);
      (apply.disabled ? again : apply).focus();
    };
    w.onerror = (e) => { if (mine !== job) return; stop(); status.textContent = e.message || 'The dry run stopped. Try again.'; };
    w.postMessage({ id: mine, world, before: loop.runningSource, after: source, ticks: span, features: loop.sim.scenario.features } satisfies DryToWorker);
  }

  for (const b of spans) b.addEventListener('click', () => {
    span = Number(b.dataset.ticks);
    for (const o of spans) o.setAttribute('aria-pressed', String(o === b));
    try { localStorage.setItem(SPAN_KEY, String(span)); } catch { /* storage blocked: choice not remembered */ }
  });
  start.addEventListener('click', () => { void begin(); });
  again.addEventListener('click', () => { void begin(); });
  close.addEventListener('click', hide);
  apply.addEventListener('click', () => {
    if (apply.disabled || tested !== editor.getSource()) return;
    loop.run();
    hide();
    toast('New code applied', 'Your farm runs the code you tested. Every bot starts from the top.');
  });
  open.addEventListener('click', () => { if (layer.hidden) show(); else hide(); });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || layer.hidden || !(card.contains(e.target as Node) || e.target === document.body)) return;
    e.preventDefault(); e.stopPropagation(); hide();
  }, true); // capture: before the menu's own Escape shortcut
  window.addEventListener('tendril:source', () => refreshStale());
  window.addEventListener('tendril:status', () => { if (!layer.hidden) refreshStale(); });
  editor.onChange(() => { if (!layer.hidden) refreshStale(); });
}

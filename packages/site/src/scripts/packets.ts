// Seed packets (H8): the /packets/ list and the /packets/<id> page. The site is static, so both fill in from /api at view time.
// Everything a player wrote goes in with textContent. Reads are CDN-cached by the API.
import { highlight } from '@tendril/lang/src/highlight.ts';
import { api, fmt } from './arena';

export const TAGS = ['starter', 'tiny', 'fast', 'wealth', 'orchard', 'bees', 'market', 'silo', 'multi-bot', 'tricks'];
export interface PacketSummary {
  id: string; name: string; note: string; tags: string[]; plants: number; plantsThisWeek: number; parentId: string | null; createdAt: number;
  author: { login: string; displayName: string; avatarUrl: string | null };
}
export interface PacketPage extends PacketSummary {
  source: string;
  family: { rootId: string; nodes: { id: string; name: string; parentId: string | null; login: string; plants: number; createdAt: number }[] };
  bestResult: { entryId: string; score: number; challengeId: string; kind: string; number: number | null; player: { login: string; displayName: string }; entries: number } | null;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const when = (t: number): string => new Date(t).toISOString().slice(0, 10);
const plants = (n: number): string => `${fmt.format(n)} ${n === 1 ? 'plant' : 'plants'}`;
const playerLink = (login: string): HTMLAnchorElement => { const a = h('a', undefined, login); a.href = `/u/?login=${encodeURIComponent(login)}`; return a; };

function card(p: PacketSummary): HTMLElement {
  const box = h('li', 'pk-card');
  const title = h('a', 'pk-title', p.name);
  title.href = `/packets/${encodeURIComponent(p.id)}`;
  const meta = h('p', 'pk-meta');
  meta.append('by ', playerLink(p.author.login), ` · ${plants(p.plants)}${p.plantsThisWeek ? ` (${fmt.format(p.plantsThisWeek)} this week)` : ''}${p.parentId ? ' · a remix' : ''} · ${when(p.createdAt)}`);
  box.append(title, meta);
  if (p.note) box.append(h('p', 'pk-note', p.note));
  if (p.tags.length) { const t = h('p', 'pk-tags'); for (const x of p.tags) t.append(h('span', 'pk-tag', x)); box.append(t); }
  return box;
}

export async function initList(root: HTMLElement): Promise<void> {
  const list = root.querySelector<HTMLElement>('[data-list]')!, state = root.querySelector<HTMLElement>('[data-state]')!;
  const sortButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-sort]')];
  const tags = root.querySelector<HTMLElement>('[data-tags]')!;
  let sort: 'popular' | 'new' = 'popular', tag = '';
  const tagButtons = ['', ...TAGS].map((t) => {
    const b = h('button', undefined, t === '' ? 'All' : t); b.type = 'button'; b.dataset.tag = t; b.setAttribute('aria-pressed', String(t === ''));
    b.addEventListener('click', () => { tag = t; void load(); });
    tags.append(b); return b;
  });
  async function load(): Promise<void> {
    for (const b of sortButtons) b.setAttribute('aria-pressed', String(b.dataset.sort === sort));
    for (const b of tagButtons) b.setAttribute('aria-pressed', String(b.dataset.tag === tag));
    state.hidden = false; state.textContent = 'Loading…'; list.replaceChildren();
    const r = await api<{ packets: PacketSummary[] }>(`/packets?sort=${sort}&limit=50${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`);
    if (!r) { state.textContent = "The packets can't be loaded right now. Try again in a moment."; return; }
    if (r.packets.length === 0) { state.textContent = tag ? 'No packets with that tag yet.' : 'No packets yet. Be the first: open the game, write a program and press Share.'; return; }
    state.hidden = true;
    list.replaceChildren(...r.packets.map(card));
  }
  for (const b of sortButtons) b.addEventListener('click', () => { sort = b.dataset.sort as 'popular' | 'new'; void load(); });
  await load();
}

function tree(nodes: PacketPage['family']['nodes'], current: string): HTMLElement {
  const kids = new Map<string | null, typeof nodes>();
  for (const n of nodes) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  const build = (parent: string | null): HTMLElement | null => {
    const children = kids.get(parent);
    if (!children) return null;
    const ul = h('ul', 'pk-tree');
    for (const n of children) {
      const li = h('li');
      if (n.id === current) { const b = h('strong', undefined, n.name); b.setAttribute('aria-current', 'true'); li.append(b); }
      else { const a = h('a', undefined, n.name); a.href = `/packets/${encodeURIComponent(n.id)}`; li.append(a); }
      li.append(` by ${n.login} · ${plants(n.plants)}`);
      const sub = build(n.id);
      if (sub) li.append(sub);
      ul.append(li);
    }
    return ul;
  };
  return build(null) ?? h('p', 'pk-note', 'No remixes yet.');
}

/** The id from /packets/<id> (the host rewrites it to this page) or from ?id=. */
export const packetIdFromLocation = (): string => {
  const fromPath = /^\/packets\/([A-Za-z0-9_-]{8,16})\/?$/.exec(location.pathname)?.[1];
  return fromPath ?? new URLSearchParams(location.search).get('id')?.trim() ?? '';
};

export async function initPage(root: HTMLElement): Promise<void> {
  const q = <T extends HTMLElement>(s: string): T => root.querySelector<T>(s)!;
  const state = q('[data-state]');
  const id = packetIdFromLocation();
  if (!/^[A-Za-z0-9_-]{8,16}$/.test(id)) { state.textContent = 'That packet link is not valid.'; return; }
  const p = await api<PacketPage>(`/packets/${encodeURIComponent(id)}`);
  if (!p) { state.textContent = 'This packet is gone, or the server is busy. Try again in a moment.'; return; }
  state.hidden = true; q('[data-packet]').hidden = false;
  document.title = `${p.name} | Tendril seed packet`;
  q('[data-name]').textContent = p.name;
  const by = q('[data-by]'); by.replaceChildren('by ', playerLink(p.author.login), ` · ${plants(p.plants)} · shared ${when(p.createdAt)}`);
  q('[data-note]').textContent = p.note; q('[data-note]').hidden = !p.note;
  const tagBox = q('[data-tags]'); for (const t of p.tags) tagBox.append(h('span', 'pk-tag', t));
  const code = q('[data-code]');
  code.replaceChildren(...highlight(p.source).map((s) => { if (s.kind === 'plain') return document.createTextNode(s.text); const e = h('span', `t-${s.kind}`, s.text); return e; }));
  q<HTMLAnchorElement>('[data-plant]').href = `/play/?mode=sandbox&plant=${encodeURIComponent(p.id)}`;
  q('[data-cli]').textContent = `tendril packet plant ${p.id}`;
  q('[data-lines]').textContent = `${p.source.replace(/\s+$/, '').split('\n').length} lines`;
  const copy = q<HTMLButtonElement>('[data-copy]');
  copy.addEventListener('click', () => { void navigator.clipboard?.writeText(p.source).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Copy failed'; }); });
  const best = q('[data-best]');
  if (p.bestResult) {
    const b = p.bestResult;
    const label = b.kind === 'season' ? 'a season' : b.number && b.number > 0 ? `Daily #${b.number}` : 'a daily';
    const a = h('a', undefined, 'Watch the replay'); a.href = `/r/${encodeURIComponent(b.entryId)}`;
    best.replaceChildren(`${fmt.format(b.score)} coins on ${label}, by `, playerLink(b.player.login), '. ', a, b.entries > 1 ? ` (${fmt.format(b.entries)} runs have used this exact program)` : '');
  } else best.textContent = 'No verified run of this exact program yet. A published program from a closed daily or season shows here.';
  q('[data-family]').replaceChildren(tree(p.family.nodes, p.id));
  const report = q<HTMLButtonElement>('[data-report]'), msg = q('[data-report-msg]');
  report.addEventListener('click', async () => {
    report.disabled = true; msg.textContent = '';
    try {
      const res = await fetch(`/api/packets/${encodeURIComponent(p.id)}/report`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tendril-client': '1' }, body: '{}' });
      msg.textContent = res.ok ? 'Thanks. Three reports from established players hide a packet.' : res.status === 401 ? 'Sign in to report a packet.' : res.status === 422 ? 'You cannot report your own packet.' : "Couldn't send the report. Try again later.";
    } catch { msg.textContent = "Couldn't send the report. Try again later."; }
    report.disabled = false;
  });
}

export const packetsCss = `
.pk-page { padding-top: clamp(2.5rem, 6vw, 4.5rem); max-width: 52rem; }
.pk-page .lede { font-size: 1.2rem; color: var(--dim); margin: 1rem 0 1.5rem; }
.pk-state { color: var(--dim); padding: 1.5rem 0; }
.pk-controls { display: flex; flex-wrap: wrap; gap: 0.75rem 1rem; margin-bottom: 1.25rem; align-items: center; }
.pk-seg { display: inline-flex; flex-wrap: wrap; gap: 0.4rem; }
.pk-seg button { background: none; border: 1.5px solid var(--line); color: var(--ink); border-radius: 999px; padding: 0.3rem 0.85rem; font: 600 0.9rem var(--display); cursor: pointer; }
.pk-seg button[aria-pressed='true'] { background: var(--ink); border-color: var(--ink); color: var(--paper); }
.pk-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
.pk-card { border: 1.5px solid var(--line); border-radius: 10px; padding: 0.9rem 1rem; display: grid; gap: 0.3rem; }
.pk-title { font: 700 1.15rem var(--display); color: var(--ink); text-decoration: none; }
.pk-title:hover { text-decoration: underline; }
.pk-meta, .pk-note { margin: 0; color: var(--dim); font-size: 0.92rem; }
.pk-note { color: var(--ink); overflow-wrap: anywhere; }
.pk-tags { margin: 0; display: flex; flex-wrap: wrap; gap: 0.35rem; }
.pk-tag { font-size: 0.75rem; border: 1px solid var(--line); border-radius: 999px; padding: 0 0.5rem; color: var(--dim); margin-right: 0.3rem; }
.pk-actions { display: flex; flex-wrap: wrap; gap: 0.6rem; margin: 1.25rem 0; align-items: center; }
.pk-code-head { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-top: 1.5rem; }
pre.pk-code { margin: 0.5rem 0 0; padding: 1rem; overflow-x: auto; max-height: 32rem; border: 1px solid var(--line); border-radius: 0.6rem; background: var(--code-bg); font: 0.9rem/1.55 var(--mono); tab-size: 4; --t-str: #8a5a1c; --t-num: #7a4aa8; --t-const: #b0562a; --t-builtin: #1f6f8b; }
@media (prefers-color-scheme: dark) { pre.pk-code { --t-str: #e0b070; --t-num: #c9a0ef; --t-const: #f0a47a; --t-builtin: #7cc8e0; } }
pre.pk-code .t-comment { color: var(--dim); font-style: italic; }
pre.pk-code .t-string { color: var(--t-str); }
pre.pk-code .t-number { color: var(--t-num); }
pre.pk-code .t-keyword { color: var(--leaf); font-weight: 700; }
pre.pk-code .t-constant { color: var(--t-const); }
pre.pk-code .t-builtin { color: var(--t-builtin); }
.pk-section { margin-top: 2rem; }
.pk-section h2 { font-size: 1.3rem; margin-bottom: 0.5rem; }
.pk-tree { list-style: none; margin: 0.3rem 0 0; padding-left: 1.2rem; border-left: 2px solid var(--line); display: grid; gap: 0.35rem; }
.pk-section > .pk-tree { padding-left: 0; border-left: 0; }
.pk-dim { color: var(--dim); }
.pk-cli { font: 0.9rem var(--mono); background: var(--code-bg); border-radius: 4px; padding: 0.15rem 0.45rem; }
`;

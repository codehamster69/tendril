// C6: daily winner post. Reads yesterday's closed daily from the Tendril API, formats the three medal winners
// (mosaic + share link) and posts to a Discord webhook. With no DISCORD_WEBHOOK_URL it prints the message and exits 0.
// Usage: node scripts/daily-post.mjs [YYYY-MM-DD]   env: TENDRIL_ORIGIN (default https://tendril.hokora.xyz), DISCORD_WEBHOOK_URL
import { pathToFileURL } from 'node:url';

const MEDALS = [
  { key: 'wealth', icon: '💰', label: 'Wealth', fmt: (v) => `${Math.round(v).toLocaleString('en-US')} net worth` },
  { key: 'speed', icon: '⚡', label: 'Speed', fmt: (v) => `par at tick ${Math.round(v).toLocaleString('en-US')}` },
  { key: 'brevity', icon: '✂️', label: 'Brevity', fmt: (v) => `${Math.round(v).toLocaleString('en-US')} tokens` },
];

export const yesterdayUtc = (now = new Date()) => new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);

/** @param {{ date: string, challenge: any|null, boards: Record<string, any|null>, origin: string }} d */
export function formatMessage({ date, challenge, boards, origin }) {
  const title = challenge?.number > 0 ? `Tendril Daily #${challenge.number} (${date})` : `Tendril Daily ${date}`;
  const players = challenge?.players ?? 0;
  if (!challenge || players === 0) {
    return `🌱 **${title}**\nNo farms were submitted yesterday. Today's daily is open: ${origin}/play/`;
  }
  const lines = [`🌱 **${title}** · ${players} ${players === 1 ? 'farm' : 'farms'}`];
  for (const m of MEDALS) {
    const top = boards[m.key]?.entries?.[0];
    if (!top) { lines.push(`${m.icon} **${m.label}**: no winner`); continue; }
    const by = top.authorKind === 'model' && top.model ? `${top.displayName || top.login} (model: ${top.model})` : (top.displayName || top.login);
    lines.push(`${m.icon} **${m.label}**: ${by} · ${m.fmt(top.value)}`);
    if (top.mosaic) lines.push(top.mosaic);
    lines.push(`${origin}/r/${top.entryId}`);
  }
  lines.push(`Play today's daily: ${origin}/play/`);
  return lines.join('\n').slice(0, 2000); // Discord's message limit
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

export async function run({ env = process.env, now = new Date(), argv = process.argv } = {}) {
  const origin = (env.TENDRIL_ORIGIN || 'https://tendril.hokora.xyz').replace(/\/+$/, '');
  const date = argv[2] || yesterdayUtc(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad date: ${date}`);
  const id = `d-${date}`;
  const challenge = await getJson(`${origin}/api/challenges/${id}`);
  const boards = {};
  if (challenge && challenge.players > 0) {
    for (const m of MEDALS) boards[m.key] = await getJson(`${origin}/api/challenges/${id}/board?medal=${m.key}&limit=1`);
  }
  const content = formatMessage({ date, challenge, boards, origin });
  const hook = env.DISCORD_WEBHOOK_URL;
  if (!hook) { console.log(content); console.log('\n(no DISCORD_WEBHOOK_URL set: nothing posted)'); return content; }
  const res = await fetch(hook, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) throw new Error(`Discord webhook -> ${res.status}`);
  console.log(`posted ${content.length} chars for ${id}`);
  return content;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run().catch((e) => { console.error(e.message); process.exit(1); });
}

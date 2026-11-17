#!/usr/bin/env node
// Health watch. Run every 30 minutes by .github/workflows/health.yml:
//   node --experimental-strip-types scripts/health.mjs
// Checks the live site and API, replays a stored known-good log locally, and compares a canary
// farm's server checkpoint with a local replay. On failure it opens (or updates) one issue labelled
// `health`; on recovery it comments and closes that issue. Env: HEALTH_BASE_URL, HEALTH_CANARY_TOKEN,
// GITHUB_TOKEN + GITHUB_REPOSITORY (issue sync; skipped when absent), HEALTH_SIMULATE_FAILURE=1 (forced failure test).
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorld, dailySeed, deserialize, hashWorld, replayChunk, RULES_VERSION } from '../packages/sim/src/index.ts';

export const FIXTURE_PATH = fileURLToPath(new URL('./health/canary-log.json', import.meta.url));
export const ISSUE_LABEL = 'health';
export const ISSUE_TITLE = 'Health: site or game check failing';
const DEFAULT_BASE = 'https://tendril.hokora.xyz';

const todayUtc = (now) => new Date(now).toISOString().slice(0, 10);

/** Replays the fixture log on a fresh world and compares the state hash with the stored one. */
export function replayFixture(fixture) {
  const world = createWorld({ id: 'canary-fixture', seed: fixture.seed });
  replayChunk(world, fixture.actions, fixture.toTick);
  return hashWorld(world);
}

async function getJson(fetchFn, url, headers = {}) {
  const res = await fetchFn(url, { headers: { accept: 'application/json', ...headers } });
  return { status: res.status, body: res.status === 200 ? await res.json().catch(() => null) : null };
}

/** Runs every check. Each result: { name, ok, skipped?, detail }. Pure apart from `deps.fetch`. */
export async function runChecks(deps) {
  const { fetch: fetchFn, now, fixture, baseUrl, canaryToken, simulateFailure } = deps;
  const api = `${baseUrl}/api`;
  const results = [];
  const add = (name, ok, detail, skipped = false) => results.push({ name, ok, skipped, detail });

  // 1. Today's challenge: date is today (UTC), seed matches the sim, rules version matches this build.
  try {
    const { status, body } = await getJson(fetchFn, `${api}/daily`);
    const date = todayUtc(now);
    const good = status === 200 && body && body.date === date && body.seed === dailySeed(date)
      && typeof body.ticks === 'number' && body.rulesVersion === RULES_VERSION;
    add('daily challenge', good, good ? `${date}, rules v${RULES_VERSION}` : `HTTP ${status}, body ${JSON.stringify(body)}`);
  } catch (e) { add('daily challenge', false, String(e)); }

  // 2. Home page and web game load (the game is built to /play/).
  for (const [name, path] of [['home page', '/'], ['web game', '/play/']]) {
    try {
      const res = await fetchFn(`${baseUrl}${path}`);
      const text = await res.text();
      const ok = res.status === 200 && text.includes('<html');
      add(name, ok, `HTTP ${res.status}`);
    } catch (e) { add(name, false, String(e)); }
  }

  // 3. Stored known-good log replays to the stored hash under the current sim.
  try {
    const got = replayFixture(fixture);
    const ok = got === fixture.expectedHash;
    add('local replay of known-good log', ok, ok ? `hash ${got}` : `expected ${fixture.expectedHash}, got ${got}`);
  } catch (e) { add('local replay of known-good log', false, String(e)); }

  // 4. Canary: the server's verified checkpoint must match a local replay of the same tick.
  if (!canaryToken) {
    add('canary verify', true, 'HEALTH_CANARY_TOKEN not set', true);
  } else {
    try {
      const auth = { authorization: `Bearer ${canaryToken}`, 'x-tendril-client': '1' };
      const me = await getJson(fetchFn, `${api}/farms/me`, auth);
      if (me.status !== 200 || !me.body) throw new Error(`GET /farms/me HTTP ${me.status}`);
      const farm = me.body;
      const toTick = farm.tick + 1;
      const local = deserialize(farm.checkpoint);
      replayChunk(local, [], toTick);
      const localHash = hashWorld(local);
      const res = await fetchFn(`${api}/farms/${farm.id}/chunks`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ fromTick: farm.tick, toTick, actions: [], rulesVersion: farm.rulesVersion, checkpointHash: farm.checkpointHash }),
      });
      if (res.status === 429 || res.status === 422) {
        // Rate limited, or the canary sits at the server clock: nothing to compare this run.
        add('canary verify', true, `skipped this run: HTTP ${res.status}`, true);
      } else if (res.status !== 200) {
        add('canary verify', false, `POST chunk HTTP ${res.status}`);
      } else {
        const served = await res.json();
        const ok = served.checkpointHash === localHash;
        add('canary verify', ok, ok ? `tick ${toTick}, hash matches` : `server ${served.checkpointHash} != local ${localHash}`);
      }
    } catch (e) { add('canary verify', false, String(e)); }
  }

  // 5. Budget guard mode (F2). Not deployed yet, so 404 is reported as skipped.
  try {
    const res = await fetchFn(`${api}/budget`);
    if (res.status === 404) add('budget guard', true, 'not deployed yet', true);
    else if (res.status === 200) add('budget guard', true, `mode ${(await res.json()).mode}`);
    else add('budget guard', false, `HTTP ${res.status}`);
  } catch (e) { add('budget guard', false, String(e)); }

  if (simulateFailure) add('simulated failure', false, 'HEALTH_SIMULATE_FAILURE is set');
  return results;
}

export const isFailing = (results) => results.some((r) => !r.ok && !r.skipped);

export function renderReport(results, { runUrl, at }) {
  const lines = [`Last checked ${at}${runUrl ? ` ([run](${runUrl}))` : ''}.`, '', '| check | result | detail |', '| --- | --- | --- |'];
  for (const r of results) {
    const mark = r.skipped ? 'skipped' : r.ok ? 'ok' : 'FAIL';
    lines.push(`| ${r.name} | ${mark} | ${String(r.detail).replace(/\|/g, '\\|')} |`);
  }
  lines.push('', '_Generated by scripts/health.mjs. This issue closes itself after a passing run._');
  return lines.join('\n');
}

/**
 * Keeps one open `health` issue in step with the results. Opens one when failing, updates it on later
 * failing runs, comments and closes it on recovery. Returns the action taken.
 */
export async function syncIssue(results, { fetch: fetchFn, repo, token, now, runUrl }) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' };
  const api = `https://api.github.com/repos/${repo}`;
  const listed = await (await fetchFn(`${api}/issues?labels=${ISSUE_LABEL}&state=open&per_page=10`, { headers })).json();
  const open = listed.filter((i) => !i.pull_request).sort((a, b) => a.number - b.number);
  const existing = open[0];
  const at = new Date(now).toISOString();
  const report = renderReport(results, { runUrl, at });
  const call = (url, method, payload) => fetchFn(url, { method, headers, body: JSON.stringify(payload) });

  if (isFailing(results)) {
    if (existing) {
      await call(`${api}/issues/${existing.number}`, 'PATCH', { body: report });
      return { action: 'updated', number: existing.number };
    }
    const res = await call(`${api}/issues`, 'POST', { title: ISSUE_TITLE, labels: [ISSUE_LABEL], body: report });
    const created = await res.json();
    return { action: 'opened', number: created.number };
  }
  if (existing) {
    await call(`${api}/issues/${existing.number}/comments`, 'POST', { body: `Recovered at ${at}. Closing.` });
    await call(`${api}/issues/${existing.number}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
    return { action: 'closed', number: existing.number };
  }
  return { action: 'none' };
}

function summarize(results) {
  return results.map((r) => `${r.skipped ? 'SKIP' : r.ok ? 'OK  ' : 'FAIL'} ${r.name}: ${r.detail}`).join('\n');
}

async function main() {
  if (process.argv.includes('--record-fixture')) {
    const fixture = { seed: 20261201, toTick: 200, actions: [] };
    fixture.expectedHash = replayFixture(fixture);
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`wrote ${FIXTURE_PATH} (hash ${fixture.expectedHash})`);
    return;
  }
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  const results = await runChecks({
    fetch: globalThis.fetch, now: Date.now(), fixture,
    baseUrl: process.env.HEALTH_BASE_URL || DEFAULT_BASE,
    canaryToken: process.env.HEALTH_CANARY_TOKEN || '',
    simulateFailure: process.env.HEALTH_SIMULATE_FAILURE === '1',
  });
  console.log(summarize(results));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${renderReport(results, { runUrl, at: new Date().toISOString() })}\n`);
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
    const sync = await syncIssue(results, { fetch: globalThis.fetch, repo: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, now: Date.now(), runUrl });
    console.log(`issue: ${sync.action}${sync.number ? ` #${sync.number}` : ''}`);
  } else {
    console.log('issue sync skipped: GITHUB_TOKEN or GITHUB_REPOSITORY not set');
  }
  // Exit 0 on a failing check: the labelled issue is the alert. Non-zero only for crashes (uncaught above).
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

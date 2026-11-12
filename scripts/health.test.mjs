import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIXTURE_PATH, ISSUE_LABEL, isFailing, replayFixture, runChecks, syncIssue } from './health.mjs';
import { RULES_VERSION, dailySeed } from '../packages/sim/src/index.ts';

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const NOW = Date.UTC(2026, 10, 12, 18, 0, 0);
const DATE = '2026-11-12';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function healthySite(overrides = {}) {
  return async (url) => {
    if (overrides[url]) return overrides[url]();
    if (url.endsWith('/api/daily')) return json({ date: DATE, seed: dailySeed(DATE), ticks: 1000, rulesVersion: RULES_VERSION });
    if (url.endsWith('/play/')) return new Response('<html>game</html>');
    if (url.endsWith('/api/budget')) return json({}, 404);
    if (url.endsWith('/')) return new Response('<html>home</html>');
    throw new Error(`unexpected ${url}`);
  };
}
const deps = (fetchFn, extra = {}) => ({ fetch: fetchFn, now: NOW, fixture, baseUrl: 'https://example.test', canaryToken: '', simulateFailure: false, ...extra });

test('healthy site passes every check and canary is skipped without a token', async () => {
  const results = await runChecks(deps(healthySite()));
  assert.equal(isFailing(results), false);
  assert.equal(results.find((r) => r.name === 'canary verify').skipped, true);
  assert.equal(results.find((r) => r.name === 'local replay of known-good log').ok, true);
});

test('stale daily challenge fails the daily check', async () => {
  const results = await runChecks(deps(healthySite({ 'https://example.test/api/daily': () => json({ date: '2026-11-11', seed: dailySeed('2026-11-11'), ticks: 1000, rulesVersion: RULES_VERSION }) })));
  assert.equal(results.find((r) => r.name === 'daily challenge').ok, false);
  assert.equal(isFailing(results), true);
});

test('a changed fixture hash fails the local replay check', async () => {
  const results = await runChecks(deps(healthySite(), { fixture: { ...fixture, expectedHash: 'deadbeef' } }));
  assert.equal(results.find((r) => r.name === 'local replay of known-good log').ok, false);
});

test('replayFixture is deterministic', () => {
  assert.equal(replayFixture(fixture), fixture.expectedHash);
});

function ghFake(initialIssues) {
  const calls = [];
  let issues = [...initialIssues];
  const fetchFn = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (method === 'GET') return json(issues);
    if (method === 'POST' && url.endsWith('/issues')) {
      const created = { number: 100 + calls.length, ...JSON.parse(opts.body) };
      issues.push(created);
      return json(created, 201);
    }
    if (method === 'PATCH') {
      const n = Number(url.split('/').pop());
      issues = issues.map((i) => (i.number === n ? { ...i, ...JSON.parse(opts.body) } : i));
      return json({});
    }
    return json({});
  };
  return { fetchFn, calls, issues: () => issues };
}
const failing = [{ name: 'home page', ok: false, skipped: false, detail: 'HTTP 500' }];
const passing = [{ name: 'home page', ok: true, skipped: false, detail: 'HTTP 200' }];
const sync = (fetchFn, results) => syncIssue(results, { fetch: fetchFn, repo: 'o/r', token: 't', now: NOW, runUrl: 'https://run' });

test('forced failure opens exactly one issue, repeated failures update it, recovery closes it', async () => {
  const gh = ghFake([]);
  assert.equal((await sync(gh.fetchFn, failing)).action, 'opened');
  assert.equal((await sync(gh.fetchFn, failing)).action, 'updated');
  assert.equal((await sync(gh.fetchFn, failing)).action, 'updated');
  const created = gh.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/issues'));
  assert.equal(created.length, 1, 'one issue created');
  assert.deepEqual(created[0].body.labels, [ISSUE_LABEL]);
  assert.equal((await sync(gh.fetchFn, passing)).action, 'closed');
  assert.equal(gh.issues()[0].state, 'closed');
  assert.equal(gh.issues()[0].state_reason, 'completed');
});

test('a passing run with no open health issue does nothing', async () => {
  const gh = ghFake([]);
  assert.equal((await sync(gh.fetchFn, passing)).action, 'none');
  assert.equal(gh.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('an existing open health issue is reused, not duplicated', async () => {
  const gh = ghFake([{ number: 7, title: 'x', labels: [{ name: ISSUE_LABEL }], body: '' }]);
  assert.equal((await sync(gh.fetchFn, failing)).number, 7);
  assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 0);
});

test('canary passes when the server checkpoint matches a local replay, and fails when it does not', async () => {
  const { createWorld: cw, serialize, hashWorld: hw, replayChunk: rc, deserialize: ds } = await import('../packages/sim/src/index.ts');
  const world = cw({ id: 'canary-farm', seed: 42 });
  const checkpoint = serialize(world);
  const toTick = world.tick + 1;
  const expected = (() => { const w = ds(checkpoint); rc(w, [], toTick); return hw(w); })();
  const make = (served) => async (url, opts = {}) => {
    if (url.endsWith('/api/daily')) return json({ date: DATE, seed: dailySeed(DATE), ticks: 1000, rulesVersion: RULES_VERSION });
    if (url.endsWith('/farms/me')) return json({ id: 'f1', tick: world.tick, checkpoint, checkpointHash: hw(world), rulesVersion: RULES_VERSION });
    if (url.endsWith('/farms/f1/chunks') && opts.method === 'POST') return json({ tick: toTick, checkpointHash: served });
    return healthySite()(url, opts);
  };
  const ok = await runChecks(deps(make(expected), { canaryToken: 't' }));
  assert.equal(ok.find((r) => r.name === 'canary verify').ok, true);
  const bad = await runChecks(deps(make('0000'), { canaryToken: 't' }));
  assert.equal(bad.find((r) => r.name === 'canary verify').ok, false);
});

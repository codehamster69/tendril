import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { challengeSetup, createWorld, BASE_RULES_VERSION, SETUP_LEGACY, SETUP_VERSION } from '@tendril/sim/src/index.ts';
import { createRun } from '../src/index.ts';
import { countTokens, STRING_CHUNK } from '../src/tokens.ts';
import { handleVerify, verifySecret } from '../src/vercel-verify.ts';
import { hashLog, verifySource } from '../src/verify.ts';
import type { VerifyRequest } from '../src/verify.ts';

const daily = readFileSync(new URL('../examples/daily.sprout', import.meta.url), 'utf8');
const req = (source: string, over: Partial<VerifyRequest> = {}): VerifyRequest => ({ source, challengeId: 'd-2026-12-01', kind: 'daily', seed: 7, ticks: 3000, rulesVersion: BASE_RULES_VERSION, setupVersion: SETUP_VERSION, ...over });
/** The log a program really produces, made the way the client and CLI make it. */
function produce(r: VerifyRequest) {
  const run = createRun(createWorld({ id: r.challengeId, seed: r.seed }, challengeSetup(r.kind, r.seed, r.setupVersion).setup), r.source);
  run.step(r.ticks);
  return run.pending.filter((a) => a[0] < r.ticks);
}

describe('countTokens', () => {
  it('counts words, numbers, symbols and strings; comments, blank lines and indentation are free', () => {
    expect(countTokens('x = 1')).toBe(3);
    expect(countTokens('# note\n\nx = 1   # trailing\n')).toBe(3);
    expect(countTokens('if x == 1:\n    wait 5\n')).toBe(7);
    expect(countTokens('if x == 1:\n\n\n        wait 5\n')).toBe(7);
    expect(countTokens('say "hi"')).toBe(2);
  });
  it('charges long strings so a log cannot hide in one literal', () => {
    expect(countTokens(`s = "${'a'.repeat(STRING_CHUNK)}"`)).toBe(3);
    expect(countTokens(`s = "${'a'.repeat(STRING_CHUNK * 10)}"`)).toBe(12);
    expect(countTokens('s = ""')).toBe(3);
  });
  it('does not count a # inside a string as a comment', () => { expect(countTokens('s = "a # b"')).toBe(3); });
});

describe('verifySource', () => {
  it('accepts a program with the log it produces, and reports its tokens', () => {
    const r = req(daily);
    const actions = produce(r);
    expect(actions.length).toBeGreaterThan(50);
    const v = verifySource(r);
    expect(v).toEqual({ ok: true, tokens: countTokens(daily), logHash: hashLog(actions), actions: actions.length, netWorth: expect.any(Number) });
  });
  it('matches a run the client made in uneven chunks, as the game loop does', () => {
    const r = req(daily);
    const run = createRun(createWorld({ id: r.challengeId, seed: r.seed }, challengeSetup(r.kind, r.seed, r.setupVersion).setup), daily);
    for (let left = r.ticks, n = 1; left > 0; n = (n * 7) % 211 + 1) { const k = Math.min(left, n); run.step(k); left -= k; }
    const chunked = hashLog(run.pending.filter((a) => a[0] < r.ticks));
    expect(verifySource(r)).toMatchObject({ ok: true, logHash: chunked });
  });
  it('a request without setupVersion is an old challenge (plain farm) and still verifies', () => {
    const old = req(daily);
    delete old.setupVersion;
    const run = createRun(createWorld({ id: old.challengeId, seed: old.seed }, challengeSetup(old.kind, old.seed, SETUP_LEGACY).setup), daily);
    run.step(old.ticks);
    const hash = hashLog(run.pending.filter((a) => a[0] < old.ticks));
    expect(verifySource(old)).toMatchObject({ ok: true, logHash: hash });
  });
  it('is deterministic and depends on the seed', () => {
    const a = verifySource(req(daily)), b = verifySource(req(daily)), c = verifySource(req(daily, { seed: 8 }));
    expect(a).toEqual(b);
    expect(a.ok && c.ok && a.logHash !== c.logHash).toBe(true);
  });
  it('gives a different hash for a different program', () => {
    const a = verifySource(req(daily)), b = verifySource(req(daily.replace('wait 100', 'wait 101')));
    expect(a.ok && b.ok && a.logHash !== b.logHash).toBe(true);
  });
  it('reports a compile error with its line', () => {
    const v = verifySource(req('wait 1\nx = = 2\n'));
    expect(v.ok).toBe(false);
    if (!v.ok) { expect(v.reason).toBe('compile'); expect(v.message).toMatch(/^Line \d+: /); }
  });
  it('rejects other rules versions and oversized sources', () => {
    expect(verifySource(req(daily, { rulesVersion: 5 }))).toMatchObject({ ok: false, reason: 'rules' });
    expect(verifySource(req(`x = 1\n${'# pad\n'.repeat(8000)}`))).toMatchObject({ ok: false, reason: 'bad' });
    expect(verifySource(req(daily, { ticks: 0 }))).toMatchObject({ ok: false, reason: 'bad' });
  });
  it('cuts a program that burns its whole thinking budget off at the deadline', () => {
    const spin = 'repeat forever:\n    x = 0\n    while x < 100000:\n        x = x + 1\n';
    let clock = 0;
    const started = Date.now();
    const v = verifySource(req(spin), { deadlineMs: 300, now: () => (clock += 7) });
    expect(v).toMatchObject({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
  });
  it('finishes a budget-burning program inside the real default time limit, or times out cleanly', () => {
    const spin = 'repeat forever:\n    x = 0\n    while x < 100000:\n        x = x + 1\n';
    const started = Date.now();
    const v = verifySource(req(spin));
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(v.ok || v.reason === 'timeout').toBe(true);
  }, 20_000);
});

describe('verify function handler', () => {
  const env = { TURSO_AUTH_TOKEN: 'secret-token' };
  const post = (body: unknown, headers: Record<string, string> = { 'X-Tendril-Verify': verifySecret(env) }) =>
    handleVerify(new Request('http://x/api/verify', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }), env);
  it('answers only requests that carry the shared secret', async () => {
    expect((await post(req(daily), {})).status).toBe(404);
    expect((await post(req(daily), { 'X-Tendril-Verify': 'nope' })).status).toBe(404);
    expect((await handleVerify(new Request('http://x/api/verify'), env)).status).toBe(404);
  });
  it('verifies, and refuses malformed or oversized bodies', async () => {
    const ok = await post(req(daily));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, tokens: countTokens(daily) });
    expect((await post('not json')).status).toBe(400);
    expect((await post({ ...req(daily), kind: 'weekly' })).status).toBe(400);
    expect((await post('x'.repeat(70_000))).status).toBe(413);
  });
  it('derives the secret from VERIFY_SECRET first', () => {
    expect(verifySecret({ VERIFY_SECRET: 'a', TURSO_AUTH_TOKEN: 'b' })).not.toBe(verifySecret({ TURSO_AUTH_TOKEN: 'b' }));
  });
});

describe('highlight', () => {
  it('colours comments, strings, numbers, keywords, names and commands, and loses no text', async () => {
    const { highlight } = await import('../src/highlight.ts');
    const src = '# grow\nrepeat forever:\n    plant carrot  # now\n    say "hi # there"\n    wait 100\n    x = foo_1\n';
    const spans = highlight(src);
    expect(spans.map((s) => s.text).join('')).toBe(src);
    const kind = (text: string) => spans.find((s) => s.text === text)?.kind;
    expect(kind('# grow')).toBe('comment');
    expect(kind('# now')).toBe('comment');
    expect(kind('repeat')).toBe('keyword');
    expect(kind('carrot')).toBe('constant');
    expect(kind('plant')).toBe('builtin');
    expect(kind('"hi # there"')).toBe('string');
    expect(kind('100')).toBe('number');
    expect(kind('foo_1')).toBe('plain');
    for (const e of ['"open', "it's", '#', '']) expect(highlight(e).map((s) => s.text).join('')).toBe(e);
  });
  it('highlights every shipped example without losing text', async () => {
    const { highlight } = await import('../src/highlight.ts');
    expect(highlight(daily).map((s) => s.text).join('')).toBe(daily);
  });
});

describe('verifySource bounds (D2)', () => {
  it('stops a memory bomb quickly and without holding much heap', () => {
    const before = process.memoryUsage().heapUsed;
    const started = Date.now();
    const v = verifySource(req('big = []\nrepeat forever:\n    append big, range(100000)\n'));
    expect(v.ok).toBe(true); // the bot stops with an error; whether the log matches is the caller's check
    expect(Date.now() - started).toBeLessThan(3000);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(400e6);
  });
  it('still runs ordinary programs under the allocation budget', () => {
    expect(verifySource(req(daily)).ok).toBe(true);
  });
  it('reports absurdly nested source as a compile error, not a crash', () => {
    expect(verifySource(req(`x = ${'('.repeat(15000)}1${')'.repeat(15000)}`))).toMatchObject({ ok: false, reason: 'compile' });
  });
});

describe('market days (rules v4)', () => {
  const m = { m: [0, 1250, 750, 1000, 1000, 1000, 1000, 1000], p: [0, 250, 225, 100, 600, 400, 500, 800], t: [0, 1000, 1000, 1000, 1000, 1000, 1000, 1000], sh: null, n: 0, from: null };
  const marketReq = (source: string, over: Partial<VerifyRequest> = {}): VerifyRequest => req(source, { rulesVersion: 4, market: m, ...over });

  it('checks a program under the day\'s table and the table changes the run\'s value', () => {
    const base = verifySource(req(daily)), market = verifySource(marketReq(daily));
    expect(base.ok && market.ok).toBe(true);
    if (base.ok && market.ok) { expect(market.logHash).toBe(base.logHash); expect(market.netWorth).not.toBe(base.netWorth); }
  });
  it('dispatches by data: v4 needs a table, v3 refuses one, a damaged table is refused', () => {
    expect(verifySource(req(daily, { rulesVersion: 4 }))).toMatchObject({ ok: false, reason: 'rules' });
    expect(verifySource(req(daily, { market: m }))).toMatchObject({ ok: false, reason: 'rules' });
    expect(verifySource(marketReq(daily, { market: { ...m, p: m.p.map((x) => x + 1) } as never }))).toMatchObject({ ok: false, reason: 'rules' });
  });
  it('the price query is the base price in coins on a v3 day and the day\'s price in centicoins on a market day', () => {
    const probe = 'say price(carrot)\nsay price(wheat)\nsay price(honey)\n';
    const out = (r: VerifyRequest): string[] => {
      const world = createWorld({ id: r.challengeId, seed: r.seed }, challengeSetup(r.kind, r.seed, r.setupVersion, r.market).setup);
      const run = createRun(world, r.source); run.step(1);
      return run.output.map((l) => l.text);
    };
    expect(out(req(probe))).toEqual(['2', '3', '8']);
    expect(out(marketReq(probe))).toEqual(['250', '225', '800']);
  });
  it('price(compost) is a script error, not a free sale price', () => {
    const world = createWorld({ id: 'p', seed: 1 }, { prices: m.p });
    const run = createRun(world, 'say price(compost)\n'); run.step(1);
    expect(run.errors.length).toBe(1);
  });
  it('the verify route passes the table through', async () => {
    const env = { VERIFY_SECRET: 's' };
    const res = await handleVerify(new Request('https://x/api/verify', { method: 'POST', headers: { 'x-tendril-verify': verifySecret(env) }, body: JSON.stringify(marketReq(daily)) }), env);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });
});

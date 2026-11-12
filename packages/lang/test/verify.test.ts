import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { challengeSetup, createWorld, RULES_VERSION } from '@tendril/sim/src/index.ts';
import { createRun } from '../src/index.ts';
import { countTokens, STRING_CHUNK } from '../src/tokens.ts';
import { handleVerify, verifySecret } from '../src/vercel-verify.ts';
import { hashLog, verifySource } from '../src/verify.ts';
import type { VerifyRequest } from '../src/verify.ts';

const daily = readFileSync(new URL('../examples/daily.sprout', import.meta.url), 'utf8');
const req = (source: string, over: Partial<VerifyRequest> = {}): VerifyRequest => ({ source, challengeId: 'd-2026-12-01', kind: 'daily', seed: 7, ticks: 3000, rulesVersion: RULES_VERSION, ...over });
/** The log a program really produces, made the way the client and CLI make it. */
function produce(r: VerifyRequest) {
  const run = createRun(createWorld({ id: r.challengeId, seed: r.seed }, challengeSetup(r.kind, r.seed).setup), r.source);
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
    expect(v).toEqual({ ok: true, tokens: countTokens(daily), logHash: hashLog(actions), actions: actions.length });
  });
  it('matches a run the client made in uneven chunks, as the game loop does', () => {
    const r = req(daily);
    const run = createRun(createWorld({ id: r.challengeId, seed: r.seed }, challengeSetup(r.kind, r.seed).setup), daily);
    for (let left = r.ticks, n = 1; left > 0; n = (n * 7) % 211 + 1) { const k = Math.min(left, n); run.step(k); left -= k; }
    const chunked = hashLog(run.pending.filter((a) => a[0] < r.ticks));
    expect(verifySource(r)).toMatchObject({ ok: true, logHash: chunked });
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
    expect(verifySource(req(daily, { rulesVersion: RULES_VERSION + 1 }))).toMatchObject({ ok: false, reason: 'rules' });
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMessage, run, yesterdayUtc } from './daily-post.mjs';

const origin = 'https://t.example';
const entry = (id, name, value, extra = {}) => ({ entries: [{ entryId: id, login: name, displayName: name, value, mosaic: '🟩🟨', authorKind: 'human', model: null, ...extra }] });

test('yesterday is the previous UTC date', () => {
  assert.equal(yesterdayUtc(new Date('2026-12-02T00:10:00Z')), '2026-12-01');
  assert.equal(yesterdayUtc(new Date('2027-01-01T00:10:00Z')), '2026-12-31');
});

test('message with entries lists three winners with links', () => {
  const m = formatMessage({ date: '2026-12-01', origin, challenge: { number: 1, players: 2 },
    boards: { wealth: entry('aaa', 'ann', 12345), speed: entry('bbb', 'bo', 900), brevity: entry('ccc', 'cy', 40, { authorKind: 'model', model: 'gpt-x' }) } });
  assert.match(m, /Daily #1 \(2026-12-01\)\*\* · 2 farms/);
  assert.match(m, /ann · 12,345 net worth/);
  assert.match(m, /par at tick 900/);
  assert.match(m, /cy \(model: gpt-x\) · 40 tokens/);
  assert.match(m, /t\.example\/r\/ccc/);
});

test('empty day and missing medal are sensible', () => {
  assert.match(formatMessage({ date: '2026-12-01', origin, challenge: { number: 1, players: 0 }, boards: {} }), /No farms were submitted/);
  assert.match(formatMessage({ date: '2026-12-01', origin, challenge: null, boards: {} }), /No farms were submitted/);
  const m = formatMessage({ date: 'd', origin, challenge: { number: 2, players: 1 }, boards: { wealth: entry('a', 'x', 1), speed: { entries: [] }, brevity: null } });
  assert.match(m, /Speed\*\*: no winner/);
});

test('run without a webhook prints and does not post', async () => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return String(url).includes('/board') ? Response.json(entry('a', 'x', 5)) : Response.json({ number: 3, players: 1 }); };
  try {
    const out = await run({ env: { TENDRIL_ORIGIN: origin }, now: new Date('2026-12-03T00:10:00Z'), argv: ['node', 'x'] });
    assert.match(out, /Daily #3 \(2026-12-02\)/);
    assert.equal(calls.length, 4);
    assert.ok(calls[0].endsWith('/api/challenges/d-2026-12-02'));
  } finally { globalThis.fetch = real; }
});

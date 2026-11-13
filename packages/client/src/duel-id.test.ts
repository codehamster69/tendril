import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuelId } from './duel-id.ts';

it('Join duel accepts a duel link, a play link or a bare id, and nothing else', () => {
  assert.equal(parseDuelId('https://tendril.hokora.xyz/duel/?id=x-AbC_12-z'), 'x-AbC_12-z');
  assert.equal(parseDuelId('  https://tendril.hokora.xyz/play/?mode=challenge&id=d-2026-12-01#top '), 'd-2026-12-01');
  assert.equal(parseDuelId('x-abc123'), 'x-abc123');
  assert.equal(parseDuelId('s-2026-w49'), 's-2026-w49');
  for (const bad of ['', 'hello', 'https://evil.example/?id=../../api', 'x-', 'y-abc', 'x-abc def', 'javascript:alert(1)']) assert.equal(parseDuelId(bad), null, bad);
});

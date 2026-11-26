import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compare, modelLabel, pickRival, resultLine, shortName, startLine, waitingState, MACHINE_DELAY_MS } from './machine.ts';
import { shareText } from './share.ts';

const rival = { model: 'gemini-3.5-flash', score: 3120, finalScore: null };

describe('machine labels', () => {
  it('turns model ids into names', () => {
    assert.equal(modelLabel('gemini-3.5-flash'), 'Gemini 3.5 Flash');
    assert.equal(modelLabel('claude-sonnet-5-5'), 'Claude Sonnet 5.5');
    assert.equal(shortName('gemini-3.5-flash'), 'Gemini');
    assert.equal(modelLabel(''), 'The machine');
  });
});

describe('picking the rival', () => {
  it('takes the best model row by its goal score, ignoring humans', () => {
    const rows = [
      { rank: 1, login: 'a', value: 9000, authorKind: 'human' as const, model: null },
      { rank: 2, login: 'tendril-models', value: 3000, authorKind: 'model' as const, model: 'small', score: 2900 },
      { rank: 3, login: 'tendril-models', value: 3100, authorKind: 'model' as const, model: 'gemini-3.5-flash', score: null, finalScore: 6000 },
    ];
    assert.deepEqual(pickRival(rows), { model: 'gemini-3.5-flash', score: 3100, finalScore: 6000 });
    assert.equal(pickRival([]), null);
  });
});

describe('the start card line', () => {
  it('names the score, or when the machine plays, or nothing', () => {
    assert.equal(startLine({ kind: 'rival', rival }), 'Gemini 3.5 Flash scored 3,120 on the visible farm. Beat it.');
    assert.match(startLine({ kind: 'soon', at: Date.UTC(2026, 10, 24, 0, 40) }, undefined, 'en-GB')!, /^The machine plays at .*00:40/);
    assert.equal(startLine({ kind: 'none' }), null);
    assert.equal(startLine({ kind: 'loading' }), null);
  });
  it('stops promising an entry long after the machine should have played', () => {
    const opensAt = Date.UTC(2026, 10, 24);
    assert.equal(waitingState({ opensAt }, opensAt + 10 * 60_000).kind, 'soon');
    assert.equal(waitingState({ opensAt }, opensAt + MACHINE_DELAY_MS + 5 * 60_000).kind, 'playing');
    assert.equal(waitingState({ opensAt }, opensAt + 5 * 3600_000).kind, 'none');
    assert.equal(waitingState({ opensAt: null }, opensAt).kind, 'none');
  });
});

describe('comparison wording', () => {
  it('says who won and by how much', () => {
    assert.deepEqual(compare(3557, 3120, 'gemini-3.5-flash'), { text: 'Beat Gemini by 14%', won: true, pct: 14 });
    assert.deepEqual(compare(3000, 3180, 'gemini-3.5-flash'), { text: 'Gemini won by 6%', won: false, pct: 6 });
    assert.equal(compare(3000, 3000, 'gemini-3.5-flash').text, 'Tied with Gemini');
    assert.equal(compare(3001, 3000, 'gemini-3.5-flash').text, 'Beat Gemini by less than 1%');
    assert.equal(compare(100, 0, 'gemini-3.5-flash').text, 'Beat Gemini');
  });
  it('is provisional until both sides are final on a day with hidden farms', () => {
    assert.deepEqual(resultLine(rival, { score: 3557, finalScore: null }, 2), { text: 'Beat Gemini by 14% on the visible farm', won: true, provisional: true });
    assert.equal(resultLine(rival, { score: 3557, finalScore: null }, 0).provisional, false);
    const both = resultLine({ ...rival, finalScore: 9000 }, { score: 3557, finalScore: 8100 }, 2);
    assert.deepEqual(both, { text: 'Gemini won by 11%', won: false, provisional: false });
  });
});

describe('share text', () => {
  it('adds the machine line under the par line', () => {
    const base = { number: 7, netWorth: 3557, parTick: 2400, par: 2000, percentile: null, mosaic: '0'.repeat(64), entryId: null };
    const lines = shareText({ ...base, machine: 'Beat Gemini by 14%' }).split('\n');
    assert.equal(lines[2], '🤖 Beat Gemini by 14%');
    assert.ok(!shareText(base).includes('🤖'));
  });
});

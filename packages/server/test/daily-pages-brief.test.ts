import { describe, expect, it } from 'vitest';
import { SETUP_BRIEF, challengeSetup } from '@tendril/sim/src/index.ts';
import { briefOf, openPage } from '../src/daily-pages.ts';
import type { ChallengeRow } from '../src/arena.ts';

const row = (setup_v: number): ChallengeRow => ({ id: 'd-2026-12-03', kind: 'daily', number: 3, seed: 4242, ticks: 3000, par: null,
  opens_at: 0, closes_at: null, created_by: null, rules_version: 4, setup_v } as ChallengeRow);

describe('brief on daily pages', () => {
  it('a brief day has its brief, and older days have none', () => {
    expect(briefOf(row(0))).toBeNull();
    expect(briefOf(row(1))).toBeNull();
    const brief = briefOf(row(SETUP_BRIEF));
    expect(brief).toEqual(challengeSetup('daily', 4242, SETUP_BRIEF).brief);
  });

  it('an open brief day shows its notice and twists', () => {
    const brief = briefOf(row(SETUP_BRIEF))!;
    const html = openPage({ number: 3 }, '2026-12-03', 'https://tendril.example', brief);
    expect(html).toContain("Today's brief");
    expect(html).toContain(brief.notice.replace(/'/g, '&#39;'));
    if (brief.labels.length) expect(html).toContain(`Twists: ${brief.labels[0]!.replace(/'/g, '&#39;')}`);
    expect(openPage({ number: 3 }, '2026-12-03', 'https://tendril.example')).not.toContain("Today's brief");
  });
});

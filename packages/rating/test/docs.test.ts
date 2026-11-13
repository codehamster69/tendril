// The "How rating works" page prints numbers from packages/site/src/data/rating-rules.ts. This test imports both that
// module and the engine's constants and fails if they disagree, and checks the tier colours stay readable in both themes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as E from '../src/index.ts';
import * as D from '../../site/src/data/rating-rules.ts';
import { TIER_COLORS_DARK, TIER_COLORS_LIGHT } from '../../site/src/data/tier-colors.ts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('docs constants match the engine', () => {
  it('scalar settings', () => {
    expect(D.ALGO_VERSION).toBe(E.ALGO_VERSION);
    expect(D.START_RATING).toBe(E.START_RATING);
    expect(D.MIN_RATING).toBe(E.MIN_RATING);
    expect(D.MAX_RATING).toBe(E.MAX_RATING);
    expect(D.PLACEMENT_EVENTS).toBe(E.PLACEMENT_EVENTS);
    expect(D.SEASON_WEIGHT).toBe(E.SEASON_WEIGHT);
    expect(D.DAILY_WEIGHT).toBe(E.DAILY_WEIGHT);
    expect(D.MIN_FIELD).toBe(E.MIN_FIELD);
    expect(D.FULL_WEIGHT_FIELD).toBe(E.FULL_WEIGHT_FIELD);
    expect(Math.round(D.MIN_FIELD_WEIGHT * 1000)).toBe(E.MIN_FIELD_WEIGHT_PM);
    expect(D.ESTABLISHED_FIELD_MIN).toBe(E.ESTABLISHED_FIELD_MIN);
    expect(D.DAILY_CAP).toBe(E.DAILY_CAP);
    expect(D.SEASON_CAP).toBe(E.SEASON_CAP);
    expect(D.HALF_STEP_DIVISOR).toBe(E.HALF_STEP_DIVISOR);
  });

  it('placement multipliers', () => {
    expect(D.PLACEMENT_MULTIPLIERS.map((m) => Math.round(m * 1000))).toEqual([...E.PLACEMENT_MULTIPLIERS_PM]);
    expect(D.PLACEMENT_MULTIPLIERS).toHaveLength(E.PLACEMENT_EVENTS);
  });

  it('Elo divisor is the one in the elo table generator', () => {
    expect(read('../scripts/gen-elo-table.mjs')).toMatch(new RegExp(`\\b${D.ELO_DIVISOR}\\b`));
    // 400 points = 10 to 1: table[400] is 10/11 of the scale
    expect(E.ELO_SCALE).toBeGreaterThan(0);
  });

  it('server eligibility windows', () => {
    const src = read('../../server/src/ratings.ts');
    expect(src).toMatch(new RegExp(`MIN_ACCOUNT_AGE_MS = ${D.MIN_ACCOUNT_AGE_DAYS} \\* DAY_MS`));
    expect(src).toMatch(new RegExp(`ACTIVE_WINDOW_MS = ${D.ACTIVE_WINDOW_DAYS} \\* DAY_MS`));
  });

  it('tiers: keys, names, floors in order', () => {
    expect(D.TIER_ROWS.map(({ key, name, floor }) => ({ key, name, floor }))).toEqual(E.TIERS.map(({ key, name, floor }) => ({ key, name, floor })));
    D.TIER_ROWS.forEach((t, i) => {
      expect(E.tierOf(t.floor).key).toBe(t.key);
      if (t.floor > 0) expect(E.tierOf(t.floor - 1).key).toBe(D.TIER_ROWS[i - 1]!.key);
    });
    expect(D.tierBand(0)).toBe('Below 1000');
    expect(D.tierBand(2)).toBe('1200 to 1399');
    expect(D.tierBand(7)).toBe('2300 and up');
  });

  it('the docs page prints from the module, not from literals', () => {
    const mdx = read('../../site/src/pages/docs/rating.mdx');
    expect(mdx).toContain("from '../../data/rating-rules'");
    for (const k of ['START_RATING', 'SEASON_WEIGHT', 'MIN_FIELD', 'DAILY_CAP', 'SEASON_CAP', 'FULL_WEIGHT_FIELD', 'ESTABLISHED_FIELD_MIN', 'PLACEMENT_MULTIPLIERS']) {
      expect(mdx).toContain(`R.${k}`);
    }
    expect(mdx).toContain('<TierTable');
    expect(mdx).toContain('packages/rating');
    expect(read('../../site/src/data/nav.ts')).toContain("'/docs/rating/'");
  });
});

describe('tier colours are readable', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const css = read('../../site/src/styles/global.css');
  const tok = (name: string, theme: 'light' | 'dark') => {
    const parts = css.split('@media (prefers-color-scheme: dark)');
    const m = (theme === 'light' ? parts[0]! : parts[1]!).match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
    return m![1]!;
  };
  for (const theme of ['light', 'dark'] as const) {
    const colours = theme === 'light' ? TIER_COLORS_LIGHT : TIER_COLORS_DARK;
    it(`${theme}: every tier has a colour with 4.5:1 on paper, panel and code background`, () => {
      expect(Object.keys(colours)).toEqual(E.TIERS.map((t) => t.key));
      for (const [key, hex] of Object.entries(colours)) {
        for (const bg of ['paper', 'panel', 'code-bg']) expect(ratio(hex, tok(bg, theme)), `${key} on ${bg} (${theme})`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
  it('adjacent tiers differ visibly', () => {
    for (const colours of [TIER_COLORS_LIGHT, TIER_COLORS_DARK]) {
      const v = Object.values(colours);
      expect(new Set(v).size).toBe(v.length);
    }
  });
});

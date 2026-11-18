import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REFERENCE_SOURCES } from '../src/reference.ts';

describe('brief reference sources', () => {
  it('are copies of the bundled brief-<goal>.sprout examples', () => {
    for (const [goal, text] of Object.entries(REFERENCE_SOURCES)) {
      expect(text, goal).toBe(readFileSync(new URL(`../../lang/examples/brief-${goal}.sprout`, import.meta.url), 'utf8'));
    }
    expect(Object.keys(REFERENCE_SOURCES).sort()).toEqual(['festival', 'inherited', 'orders', 'specialist', 'wealth']);
  });
});

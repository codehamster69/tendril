import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { measureExample } from './example-health.ts';

// Report only: HEALTH=1 [ONLY=expander] pnpm exec vitest run test/example-health.test.ts
it.skipIf(!process.env.HEALTH)('example health report', () => {
  const dir = new URL('../examples/', import.meta.url);
  for (const file of readdirSync(dir)) {
    if (process.env.ONLY && !file.startsWith(process.env.ONLY)) continue;
    for (const h of measureExample(readFileSync(new URL(file, dir), 'utf8'), [50_000, 100_000, 200_000])) console.log(file.padEnd(16), JSON.stringify(h));
  }
}, 600_000);

const example = (name: string) => readFileSync(new URL(`../examples/${name}.sprout`, import.meta.url), 'utf8');
// netWorth of the previous expander (no soil care) at 200k ticks, seed 7. Its soil ended at fatigue 99, nitrogen 0.
const OLD_EXPANDER_NET_WORTH_200K = 119_501;

it('expander keeps the soil healthy and keeps growing for 200k ticks', () => {
  const [, at100k, at200k] = measureExample(example('expander'), [50_000, 100_000, 200_000]);
  expect(at200k!.errors).toBe(0);
  expect(at200k!.netWorth).toBeGreaterThan(OLD_EXPANDER_NET_WORTH_200K);
  expect(at200k!.fatigue).toBeLessThan(60);
  expect(at200k!.netWorth).toBeGreaterThan(1.8 * at100k!.netWorth);
}, 120_000);

it('starter also rotates clover so the soil stays usable', () => {
  const [at200k] = measureExample(example('starter'), [200_000]);
  expect(at200k!.errors).toBe(0);
  expect(at200k!.fatigue).toBeLessThan(60);
  expect(at200k!.netWorth).toBeGreaterThan(27_884); // old starter at 200k, seed 7
}, 120_000);

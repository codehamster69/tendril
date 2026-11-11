import { describe, expect, it } from 'vitest';
import { CROPS, createWorld, forecast, scanAt, tickWorld, weatherAt } from '../src/index.ts';
import { tileHash } from '../src/tiles.ts';
import { Driver, OP, farm } from './helpers.ts';

interface Ref { moisture: number; nitrogen: number; fatigue: number; crop: number; growth: number; rate: number; died: boolean }

/** Per-tick reference for tile (1,0): tilled+planted at tick P. Returns state at each requested tick. */
function reference(seed: number, crop: number, P: number, at: number[]): Map<number, Ref> {
  const w = createWorld(farm(seed));
  const frostStarts = new Set(forecast(w, at[at.length - 1]! + 10).filter((s) => s.kind === 'frost').map((s) => s.start));
  const c = CROPS[crop]!;
  const s: Ref = { moisture: 50, nitrogen: 30 + (tileHash(w.seed, 1, 0) % 21), fatigue: 0, crop: 0, growth: 0, rate: 0, died: false };
  const out = new Map<number, Ref>();
  for (let T = 0; T <= at[at.length - 1]!; T++) {
    if (T > 0) {
      const p = T - 1; // advance p -> T
      const wp = weatherAt(w, p);
      if (wp === 'rain' && p % 4 === 0) s.moisture = Math.min(100, s.moisture + 2);
      if (!s.crop && !s.died && Math.floor(T / 16) > Math.floor(p / 16)) s.fatigue = Math.max(0, s.fatigue - 1);
      if (s.crop) {
        if (!(wp === 'frost' && !c.hardy)) s.growth += s.rate;
        if (!c.hardy && frostStarts.has(T) && s.growth < c.stageLen) { s.crop = 0; s.died = true; s.growth = 0; }
      }
    }
    if (T === P) {
      s.rate = s.moisture >= c.thirst && s.nitrogen >= c.hunger ? 2 : 1;
      s.moisture = Math.max(0, s.moisture - c.drink);
      s.crop = crop;
    }
    if (at.includes(T)) out.set(T, { ...s });
  }
  return out;
}

describe('lazy settle equals eager', () => {
  for (const seed of [1, 4242, 987654321]) {
    for (const crop of [1, 2, 3, 4]) {
      it(`seed ${seed} crop ${crop}`, () => {
        for (const P of [5, 37, 1203, 4000]) {
          const at = [...new Set([P + 30, P + 100, P + 400, P + 1500, 5100, 7000])].sort((a, b) => a - b);
          const ref = reference(seed, crop, P, at);
          const d = new Driver(farm(seed));
          d.do(0, OP.move, 1);
          d.advance(P - 3 - d.w.tick);
          d.do(0, OP.till);
          d.advance(P - d.w.tick);
          expect(d.do(0, OP.plant, crop)).toBe(1);
          for (const T of at) {
            d.advance(T - d.w.tick);
            const got = scanAt(d.w, 1, 0)!;
            const r = ref.get(T)!;
            const stage = r.crop ? Math.min(3, Math.floor(Math.min(3 * CROPS[crop]!.stageLen, r.growth) / CROPS[crop]!.stageLen)) : 0;
            expect({ T, crop: got.crop, stage, m: got.moisture, n: got.nitrogen })
              .toEqual({ T, crop: r.crop, stage, m: r.moisture, n: r.nitrogen });
            expect(got.stage).toBe(stage);
            if (!r.died) expect(got.fatigue).toBe(r.fatigue);
          }
        }
      });
    }
  }

  it('crosses tick 5000 without per-tick work in settle', () => {
    const w = createWorld(farm(9));
    for (let i = 0; i < 6000; i++) tickWorld(w);
    expect(scanAt(w, 3, 3)!.moisture).toBeGreaterThanOrEqual(50);
  });
});

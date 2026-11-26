import { describe, expect, it } from 'vitest';
import {
  GOAL_WEIGHTS, GOAL_WEIGHTS_V3, PICTURES, PICTURE_EPOCH, PIC_BARN, SETUP_BRIEF, SETUP_PICTURE, SETUP_VERSION, applyAction, challengeSetup, createWorld,
  describeBrief, drawBrief, hashWorld, pictureActive, pictureCodes, pictureScore, picCrops, picturePlots, proceduralPicture, replayWithGoal, setupVersionFor,
  tickWorld,
} from '../src/index.ts';
import type { Goal, LogEntry, Picture } from '../src/index.ts';
import { Driver, OP, farm } from './helpers.ts';

const seeds = (n: number): number[] => Array.from({ length: n }, (_, i) => (Math.imul(i + 1, 0x9E3779B1) >>> 0) || 1);
const fnv = (s: string): string => { let h = 0x811c9dc5; for (const b of new TextEncoder().encode(s)) { h ^= b; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); };
const pic = (w: number, h: number, rows: string, title = 'A test', id = 't'): Picture => ({ id, w, h, title, cells: rows.replaceAll('/', '') });
const goalOf = (p: Picture): Goal => ({ kind: 'picture', budget: 3000, picture: p });

describe('setup version 3: the draw', () => {
  it('ships off, and the version-2 draw is byte-identical to before Crop Circles', () => {
    expect(PICTURE_EPOCH).toBe('2099-01-01');
    expect(pictureActive('2026-12-01')).toBe(false);
    expect(pictureActive('2099-01-01')).toBe(true);
    expect(setupVersionFor('2026-12-01')).toBe(SETUP_BRIEF);
    expect(setupVersionFor('2026-11-01')).toBe(SETUP_VERSION);
    expect(setupVersionFor('2099-01-01')).toBe(SETUP_PICTURE);
    // Digest of 1500 seeds x daily/season/duel, computed on main before this change. A change here breaks every stored challenge.
    let h = 0x811c9dc5;
    for (const kind of ['daily', 'season', 'duel'] as const) for (const s of seeds(1500)) for (const b of new TextEncoder().encode(JSON.stringify(challengeSetup(kind, s, SETUP_BRIEF)))) { h ^= b; h = Math.imul(h, 0x01000193); }
    expect((h >>> 0).toString(16)).toBe('d88cfc30');
    for (const s of seeds(300)) expect(drawBrief('daily', s).brief.goal.kind).not.toBe('picture');
  });

  it('v3 weights: 19 draws, picture 4, a separate table; seasons keep the v2 table', () => {
    expect(Object.values(GOAL_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(16);
    expect(Object.values(GOAL_WEIGHTS_V3).reduce((a, b) => a + b, 0)).toBe(19);
    for (const s of seeds(400)) expect(drawBrief('season', s, 'daily', SETUP_PICTURE)).toEqual(drawBrief('season', s, 'daily', SETUP_BRIEF));
    const n: Record<string, number> = {};
    let glyphs = 0, pics = 0;
    for (const s of seeds(6000)) {
      const g = drawBrief('daily', s, 'daily', SETUP_PICTURE).brief.goal;
      n[g.kind] = (n[g.kind] ?? 0) + 1;
      if (g.picture) { pics++; if (g.picture.id.startsWith('glyph-')) glyphs++; }
    }
    expect(n.picture! / 6000).toBeGreaterThan(0.19); expect(n.picture! / 6000).toBeLessThan(0.23); // 4/19 = 0.21
    for (const k of ['wealth', 'festival', 'specialist', 'orders', 'inherited']) { expect(n[k]! / 6000).toBeGreaterThan(0.14); expect(n[k]! / 6000).toBeLessThan(0.17); }
    expect(glyphs / pics).toBeGreaterThan(0.17); expect(glyphs / pics).toBeLessThan(0.23);
  });

  it('every picture draw is complete: plots, no land or hive twist, no locked crop, a plot cap that fits', () => {
    const sizes: Record<string, number> = {};
    let seen = 0;
    for (const s of seeds(5000)) {
      const { brief, setup } = challengeSetup('daily', s, SETUP_PICTURE);
      expect(challengeSetup('daily', s, SETUP_PICTURE)).toEqual(challengeSetup('daily', s, SETUP_PICTURE));
      expect(challengeSetup('duel', s, SETUP_PICTURE).brief).toEqual(brief);
      const g = brief!.goal;
      if (g.kind !== 'picture') { expect(g.picture).toBeUndefined(); continue; }
      seen++;
      const p = g.picture!;
      sizes[`${p.w}x${p.h}`] = (sizes[`${p.w}x${p.h}`] ?? 0) + 1;
      expect(p.cells).toHaveLength(p.w * p.h);
      expect(p.cells[0]).toBe('8');
      expect(setup.plots ?? []).toEqual(picturePlots(p.w, p.h));
      const keys = brief!.twists.map((t) => t.key);
      expect(keys).not.toContain('land'); expect(keys).not.toContain('hive');
      const locked = brief!.twists.find((t) => t.key === 'research_locked');
      if (locked) expect(picCrops(p.cells) & (1 << (locked.value! + 1))).toBe(0); // research bit b locks crop b + 1
      const cap = brief!.twists.find((t) => t.key === 'plot_cap');
      const w = createWorld({ id: 't', seed: s }, setup); // the setup is accepted
      expect(w.plots).toHaveLength(1 + (setup.plots?.length ?? 0) / 2);
      if (cap) { expect(cap.value).toBeGreaterThanOrEqual(w.plots.length); expect(setup.maxPlots).toBe(cap.value); }
      expect(w.brief?.goal?.picture).toEqual(p);
      expect(brief!.notice).toMatch(/^The village wants .+ in the fields by sundown\.$/);
      expect(describeBrief(brief!, 'daily')).toEqual({ notice: brief!.notice, labels: brief!.labels });
    }
    expect(seen).toBeGreaterThan(900);
    for (const k of ['8x8', '16x8', '16x16']) expect(sizes[k]).toBeGreaterThan(50);
  });

  it('describes the picture as the village notice', () => {
    const b = { goal: goalOf(pic(8, 8, '8'.padEnd(64, '0'), 'A fox')), twists: [], ticks: 3000, notice: '', labels: [] };
    expect(describeBrief(b, 'daily').notice).toBe('The village wants a fox in the fields by sundown.');
    expect(describeBrief({ ...b, goal: goalOf(pic(8, 8, '8'.padEnd(64, '0'), 'The letter K')) }, 'daily').notice).toBe('The village wants the letter K in the fields by sundown.');
  });

  it('rejects a malformed picture goal', () => {
    const ok = pic(8, 8, '8'.padEnd(64, '0'));
    expect(() => createWorld(farm(1), { goal: goalOf(ok) })).not.toThrow();
    for (const bad of [{ ...ok, cells: ok.cells.slice(1) }, { ...ok, cells: ok.cells.replace('0', '9') }, { ...ok, w: 0 }, { ...ok, title: 5 as unknown as string }])
      expect(() => createWorld(farm(1), { goal: goalOf(bad) })).toThrow('bad setup goal');
    expect(() => createWorld(farm(1), { goal: { kind: 'picture', budget: 3000 } })).toThrow('bad setup goal');
    expect(() => createWorld(farm(1), { goal: { kind: 'wealth', budget: 3000, picture: ok } })).toThrow('bad setup goal');
    expect(() => challengeSetup('daily', 1, 4)).toThrow('bad setup version');
  });
});

describe('the picture pool', () => {
  it('has about 150 original pictures at 8x8, 16x8 and 16x16 with no do-nothing win', () => {
    expect(PICTURES.length).toBeGreaterThanOrEqual(150);
    expect(new Set(PICTURES.map((p) => p.id)).size).toBe(PICTURES.length);
    expect(new Set(PICTURES.map((p) => p.cells)).size).toBe(PICTURES.length); // no two pictures alike
    const sz = new Set<string>();
    for (const p of PICTURES) {
      sz.add(`${p.w}x${p.h}`);
      expect(p.title.length).toBeGreaterThan(3);
      expect(p.cells).toHaveLength(p.w * p.h);
      expect(/^[0-8]+$/.test(p.cells)).toBe(true);
      expect(p.cells[0]).toBe('8'); // the barn pixel, and only there
      expect(p.cells.slice(1)).not.toContain('8');
      const total = p.w * p.h - 1, count = new Array<number>(9).fill(0);
      for (let i = 1; i < p.cells.length; i++) count[+p.cells[i]!]!++;
      expect(count[0]! / total, p.id).toBeLessThanOrEqual(0.4); // an empty farm scores at most 40%
      expect(count[1]! / total, p.id).toBeLessThanOrEqual(0.45); // so does a tilled one
      expect(picCrops(p.cells), p.id).toBeGreaterThan(0);
    }
    expect([...sz].sort()).toEqual(['16x16', '16x8', '8x8']);
  });

  it('glyphs: seeded, symmetric, bounded, and only the crops allowed', () => {
    for (let i = 0; i < 2000; i++) {
      const seed = (Math.imul(i + 1, 0x9E3779B1) >>> 0) & 0xFFFFFF, allowed = i % 3 === 0 ? 0b0001110 : 0b1111110; // carrot, wheat, clover only, or all
      const p = proceduralPicture(seed, allowed);
      expect(proceduralPicture(seed, allowed)).toEqual(p);
      expect(p.cells).toHaveLength(p.w * p.h);
      expect(picCrops(p.cells) & ~allowed).toBe(0);
      for (let y = 0; y < p.h; y++) for (let x = 1; x < p.w; x++) {
        const mx = p.w - 1 - x, my = p.h - 1 - y;
        if (x > 0 && y > 0 && mx > 0 && my > 0) expect(p.cells[y * p.w + x]).toBe(p.cells[my * p.w + mx]);
      }
      const t = p.w * p.h - 1; let grass = 0; for (let k = 1; k < p.cells.length; k++) if (p.cells[k] === '0') grass++;
      expect(grass).toBeLessThanOrEqual(0.4 * t);
    }
  });

  it('uses at most the 8 colours plus the barn pixel', () => {
    for (const p of PICTURES) for (const ch of p.cells) expect('012345678').toContain(ch);
    expect(PIC_BARN).toBe(8);
  });
});

describe('Crop Circles scoring', () => {
  // 8x8 picture: row 0 is the barn then grass; rows 1-2 carrots, row 3 soil, the rest grass.
  const rows = '8.......' + '22222222' + '22222222' + 'ssssssss'.replaceAll('s', '1') + '.'.repeat(32);
  const p = pic(8, 8, rows.replaceAll('.', '0'));
  const mk = () => new Driver(farm(11), { goal: goalOf(p), coins: 0, unlocks: 0b111111 });

  it('counts grass, soil, ripe crops and the barn pixel, floor(matches * 1000 / pixels)', () => {
    const d = mk();
    expect(pictureScore(d.w, p)).toBe(Math.floor((1 + 7 + 32) * 1000 / 64)); // barn + 7 grass in row 0 + 32 grass
    d.do(0, OP.move, 1); d.do(0, OP.till); // (1,0) was grass, is now soil: a mismatch
    expect(pictureScore(d.w, p)).toBe(Math.floor((1 + 6 + 32) * 1000 / 64));
    expect(pictureCodes(d.w, p)[1]).toBe(1);
    // (1,1): wanted carrot. Tilled + planted but unripe shows as soil (mismatch); ripe shows as the crop.
    d.do(0, OP.move, 2); d.do(0, OP.till); d.do(0, OP.plant, 1);
    expect(pictureCodes(d.w, p)[9]).toBe(1);
    expect(pictureScore(d.w, p)).toBe(Math.floor(39 * 1000 / 64));
    d.advance(89); expect(pictureCodes(d.w, p)[9]).toBe(1);
    d.advance(1); expect(pictureCodes(d.w, p)[9]).toBe(2); // good soil: rate 2, so ripe after 3 x 60 / 2 ticks; carrot = code 2
    expect(pictureScore(d.w, p)).toBe(Math.floor(40 * 1000 / 64));
    d.do(0, OP.harvest); // a harvested annual leaves untilled grass
    expect(pictureCodes(d.w, p)[9]).toBe(0);
    expect(pictureScore(d.w, p)).toBe(Math.floor(39 * 1000 / 64));
  });

  it('tilled soil, cleared soil and a building count as they look', () => {
    const d = mk();
    d.do(0, OP.move, 2); d.do(0, OP.till);
    expect(pictureCodes(d.w, p)[8]).toBe(1);
    d.do(0, OP.clear);
    expect(pictureCodes(d.w, p)[8]).toBe(0);
    const w = createWorld(farm(3), { goal: goalOf(p), hive: [2, 2], coins: 0 });
    expect(pictureCodes(w, p)[2 * 8 + 2]).toBe(9); // a hive matches no cell
  });

  it('unowned tiles never match, and buying the plot makes them grass', () => {
    const wide = pic(16, 8, '8' + '0'.repeat(127));
    const w = createWorld(farm(5), { goal: goalOf(wide), coins: 500 });
    expect(pictureScore(w, wide)).toBe(Math.floor((1 + 63) * 1000 / 128));
    expect(applyAction(w, [0, -1, OP.buyPlot, 1, 0])).toBe(1);
    expect(pictureScore(w, wide)).toBe(1000);
  });

  it('replayWithGoal agrees with a brute-force check at every tick (score and first tick at par)', () => {
    // Plant ripening carrots across the picture, then wander, so the score moves by actions and by ripening.
    const log: LogEntry[] = [];
    const d = mk();
    for (let i = 0; i < 7; i++) { d.do(0, OP.move, 1); d.do(0, OP.till); d.do(0, OP.plant, 1); }
    for (let i = 0; i < 7; i++) d.do(0, OP.move, 3);
    d.do(0, OP.move, 2);
    for (let i = 0; i < 7; i++) { d.do(0, OP.till); d.do(0, OP.plant, 1); d.do(0, OP.move, 1); }
    d.do(0, OP.wait, 400);
    d.do(0, OP.harvest);
    log.push(...d.log);
    const goal = goalOf(p);
    // brute force
    const w = createWorld(farm(11), { goal, coins: 0, unlocks: 0b111111 });
    const scores: number[] = [pictureScore(w, p)];
    let i = 0;
    for (let t = 0; t < 3000; t++) {
      while (i < log.length && log[i]![0] === w.tick) { applyAction(w, log[i]!); i++; scores.push(pictureScore(w, p)); }
      tickWorld(w); scores.push(pictureScore(w, p));
    }
    const final = scores[scores.length - 1]!;
    const first = (par: number): number | null => { // first world tick (after an action or a tick) at or above par; scores are in event order
      const w2 = createWorld(farm(11), { goal, coins: 0, unlocks: 0b111111 });
      if (pictureScore(w2, p) >= par) return 0;
      let j = 0;
      for (let t = 0; t < 3000; t++) {
        while (j < log.length && log[j]![0] === w2.tick) { applyAction(w2, log[j]!); j++; if (pictureScore(w2, p) >= par) return w2.tick; }
        tickWorld(w2); if (pictureScore(w2, p) >= par) return w2.tick;
      }
      return null;
    };
    for (const par of [1, 300, 480, 520, 600, 700, 800, 900, 1000, 1001]) {
      const r = replayWithGoal(createWorld(farm(11), { goal, coins: 0, unlocks: 0b111111 }), log, 3000, goal, par);
      expect(r.score).toBe(final);
      expect(r.parTick, `par ${par}`).toBe(first(par));
    }
    expect(final).toBeGreaterThan(300);
  });

  it('is deterministic: the same log gives the same score and world hash', () => {
    const d = mk();
    for (let i = 0; i < 5; i++) { d.do(0, OP.move, 1); d.do(0, OP.till); d.do(0, OP.plant, 2); }
    const a = replayWithGoal(createWorld(farm(11), { goal: goalOf(p), unlocks: 0b111111 }), d.log, 3000, goalOf(p), 100);
    const b = replayWithGoal(createWorld(farm(11), { goal: goalOf(p), unlocks: 0b111111 }), d.log, 3000, goalOf(p), 100);
    expect(a).toEqual(b);
  });
});

describe('golden: setup version 3', () => {
  it('pins the first draws and a scored replay', () => {
    const rows: string[] = [];
    for (const s of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) {
      const { brief, setup } = challengeSetup('daily', s, SETUP_PICTURE);
      rows.push(`${s}|${brief!.goal.kind}|${brief!.goal.picture?.id ?? '-'}|${brief!.twists.map((t) => t.key + (t.value ?? '')).join(',')}|${(setup.plots ?? []).join(',')}`);
    }
    expect(rows).toMatchInlineSnapshot(`
      [
        "1|wealth|-|hard_frost,stock40|",
        "2|orders|-|poor_soil20,dry_soil20|",
        "3|picture|letter-z||",
        "4|specialist|-|dry_soil20|",
        "5|inherited|-|stock20|",
        "6|specialist|-|poor_soil20|",
        "7|orders|-|research_locked7|",
        "8|specialist|-|dry_soil40|",
        "9|inherited|-|dry_soil20|",
        "10|specialist|-|stock20|",
        "11|festival|-|plot_cap1|",
        "12|orders|-||",
        "13|specialist|-|research_locked4,stock20|",
        "14|wealth|-|hard_frost,bot_cap2|",
        "15|wealth|-||",
        "16|orders|-|drought|",
        "17|festival|-|land3|0,1,-1,1,-1,0",
        "18|inherited|-|research_given8|",
        "19|inherited|-|dry_soil20|",
        "20|inherited|-|dry_soil40,hard_frost|",
      ]
    `);
    expect(fnv(JSON.stringify(seeds(400).map((s) => challengeSetup('daily', s, SETUP_PICTURE))))).toMatchInlineSnapshot(`"94b81756"`);
    const s = seeds(60).find((x) => challengeSetup('daily', x, SETUP_PICTURE).brief!.goal.picture?.id === 'letter-t' || challengeSetup('daily', x, SETUP_PICTURE).brief!.goal.picture?.w === 8)!;
    const { setup, brief } = challengeSetup('daily', s, SETUP_PICTURE);
    const d = new Driver(farm(s), setup);
    for (let i = 0; i < 6; i++) { d.do(0, OP.move, 1); d.do(0, OP.till); d.do(0, OP.plant, 1); }
    d.do(0, OP.wait, 250);
    const r = replayWithGoal(createWorld(farm(s), setup), d.log, 3000, brief!.goal, 500);
    expect({ id: brief!.goal.picture!.id, score: r.score, parTick: r.parTick, hash: hashWorld(d.w) }).toMatchInlineSnapshot(`
      {
        "hash": "053f7a78",
        "id": "letter-t",
        "parTick": null,
        "score": 468,
      }
    `);
  });
});

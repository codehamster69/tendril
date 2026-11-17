import { describe, expect, it } from 'vitest';
import { API, KEYWORDS, compile } from '../src/index.ts';
import { API_DOCS, KEYWORD_DOCS, runDemo } from '../src/api-docs.ts';

describe('reference worked examples', () => {
  it('cover every API name, and nothing else', () => {
    expect(Object.keys(API_DOCS).sort()).toEqual(API.map((a) => a.name).sort());
    expect(Object.keys(KEYWORD_DOCS).sort()).toEqual([...KEYWORDS].sort());
  });
  it('give every call, question and helper its rules', () => {
    for (const a of API.filter((e) => e.kind !== 'constant')) expect(API_DOCS[a.name]!.rules?.length, a.name).toBeGreaterThan(0);
  });
  for (const [name, doc] of Object.entries(API_DOCS)) {
    it(`${name}: the worked example runs without errors`, () => {
      expect(compile(doc.demo).diagnostics, name).toEqual([]);
      const r = runDemo(doc);
      expect(r.errors, name).toEqual([]);
    });
  }
  for (const [name, source] of Object.entries(KEYWORD_DOCS)) {
    it(`keyword ${name}: the example compiles and runs`, () => {
      expect(compile(source).diagnostics, name).toEqual([]);
      expect(runDemo({ demo: source, world: 'start', ticks: 50 }).errors, name).toEqual([]);
    });
  }
  it('sell_plot example shows both refusals and the sale', () => {
    expect(runDemo(API_DOCS.sell_plot!).lines).toEqual([
      'sell_plot 1, 0 paid nothing. Plot (1, 0) connects other plots to the barn. Sell a plot at the end of a branch instead.',
      'middle plot: 0',
      'sell_plot 0, 0 paid nothing. The barn plot cannot be sold.',
      'barn plot: 0',
      'edge plot: 300',
      'plots left: 2',
    ]);
  });
});

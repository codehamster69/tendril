import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createWorld, OP, snapshot, tickWorld } from '@tendril/sim/src/index.ts';
import type { World } from '@tendril/sim/src/index.ts';
import { ViewEncoder, ViewStore } from './view-codec.ts';
import { VIEW_VERSION } from './sim-protocol.ts';

const act = (w: World, bot: number, op: number, a?: number, b?: number): void => {
  if (bot >= 0) while (w.bots[bot]!.busyUntil > w.tick) tickWorld(w);
  applyAction(w, [w.tick, bot, op, a, b] as never);
};

/** A busy farm: several plots, two bots tilling, planting, watering, harvesting and selling over time. */
function busyFarm(): World {
  const w = createWorld({ id: 'view', seed: 4242 }, { coins: 100_000, unlocks: 0b111111 });
  for (const [x, y] of [[1, 0], [0, 1], [1, 1]] as const) act(w, -1, OP.buyPlot, x, y);
  act(w, -1, OP.buyBot);
  return w;
}

function drive(w: World, step: (t: number) => void, ticks: number, every: number, check: () => void): void {
  for (let t = 0; t < ticks; t++) {
    step(t);
    tickWorld(w);
    if (t % every === 0) check();
  }
}

describe('compact view', () => {
  it('a run seen through the deltas ends identical to snapshot()', () => {
    const w = busyFarm();
    const enc = new ViewEncoder(), store = new ViewStore();
    let updates = 0, planted = 0;
    const check = (): void => {
      assert.ok(store.apply(enc.encode(w, []).update), 'update applies');
      updates++;
      const want = snapshot(w), got = store.latest()!;
      if (want.tiles.some((t) => t.crop > 0)) planted++;
      const rest = { ...got } as Partial<typeof got>;
      delete rest.delta;
      assert.deepEqual(rest, want);
    };
    drive(w, (t) => {
      if (t % 9 === 0) {
        const bot = (t / 9) % 2;
        act(w, bot, OP.move, 1);
        act(w, bot, OP.till);
        act(w, bot, OP.plant, 1 + (t % 3));
        act(w, bot, OP.water);
      }
      if (t % 150 === 100) { act(w, 0, OP.harvest); act(w, 0, OP.deposit); act(w, 0, OP.sell, 1, 2); }
    }, 900, 7, check);
    check();
    assert.ok(updates > 100);
    assert.ok(planted > 20, 'the run really grew crops');
  });

  it('selling a plot and buying another (rules v5) still ends identical to snapshot()', () => {
    const w = createWorld({ id: 'view', seed: 77 }, { coins: 1_000_000, unlocks: 0b1111111111, siloTick: 0 });
    for (const [x, y] of [[1, 0], [2, 0], [0, 1]] as const) act(w, -1, OP.buyPlot, x, y);
    const enc = new ViewEncoder(), store = new ViewStore();
    const same = (): void => {
      assert.ok(store.apply(enc.encode(w, []).update));
      const rest = { ...store.latest()! } as Partial<ReturnType<ViewStore['latest']>> & object;
      delete (rest as { delta?: unknown }).delta;
      assert.deepEqual(rest, snapshot(w));
    };
    same();
    act(w, 0, OP.move, 1); act(w, 0, OP.till); act(w, 0, OP.plant, 1);
    tickWorld(w); same();
    act(w, -1, OP.sellPlot, 1, 0 + 0); // refused: it would cut (2,0) off
    act(w, -1, OP.sellPlot, 2, 0);
    act(w, -1, OP.sellPlot, 0, 1);
    act(w, -1, OP.buyPlot, 1, 1);
    act(w, -1, OP.buyPlot, 0, 1);
    tickWorld(w); same();
    assert.deepEqual(w.plots.map((p) => [p.px, p.py]), [[0, 0], [1, 0], [1, 1], [0, 1]]);
  });

  it('an idle farm sends near-empty updates', () => {
    const w = createWorld({ id: 'idle', seed: 7 }, { coins: 100_000 });
    for (const [x, y] of [[1, 0], [0, 1], [1, 1]] as const) act(w, -1, OP.buyPlot, x, y);
    const enc = new ViewEncoder(), store = new ViewStore();
    assert.ok(store.apply(enc.encode(w, []).update));
    let bytes = 0;
    for (let i = 0; i < 20; i++) {
      for (let t = 0; t < 10; t++) tickWorld(w);
      const { update } = enc.encode(w, []);
      assert.ok(store.apply(update));
      assert.equal(update.plotIndex.length, 0, 'no plot changed');
      assert.equal(update.botIndex.length, 0, 'no bot changed');
      assert.equal(update.tiles.byteLength + update.bots.byteLength, 0);
      bytes += JSON.stringify(update).length;
    }
    assert.ok(bytes / 20 < 400, `idle update is ${bytes / 20} bytes`);
  });

  it('only plots whose tiles changed are sent', () => {
    const w = busyFarm();
    const enc = new ViewEncoder(), store = new ViewStore();
    assert.ok(store.apply(enc.encode(w, []).update));
    act(w, 0, OP.move, 1);
    act(w, 0, OP.till);
    const { update } = enc.encode(w, []);
    assert.deepEqual([...update.plotIndex], [0]);
    assert.ok(store.apply(update));
  });

  it('asks for a full view on a gap or another format version', () => {
    const w = busyFarm();
    const enc = new ViewEncoder(), store = new ViewStore();
    assert.ok(store.apply(enc.encode(w, []).update));
    enc.encode(w, []); // an update the store never saw
    assert.equal(store.apply(enc.encode(w, []).update), false);
    enc.reset();
    assert.ok(store.apply(enc.encode(w, []).update), 'a full update repairs it');
    const next = enc.encode(w, []).update;
    assert.equal(store.apply({ ...next, version: VIEW_VERSION + 1 }), false);
    assert.equal(new ViewStore().apply(enc.encode(w, []).update), false, 'a delta cannot start a store');
  });

  it('changes since a version cover skipped updates', () => {
    const w = busyFarm();
    const enc = new ViewEncoder(), store = new ViewStore();
    assert.ok(store.apply(enc.encode(w, []).update));
    const seen = store.latest()!.delta.version;
    act(w, 0, OP.move, 1); act(w, 0, OP.till); assert.ok(store.apply(enc.encode(w, []).update));
    act(w, 0, OP.move, 1); act(w, 0, OP.till); assert.ok(store.apply(enc.encode(w, []).update));
    const changes = store.latest()!.delta.since(seen)!;
    assert.ok(changes.length > 0 && changes.length % 64 === 0);
    assert.equal(store.latest()!.delta.since(0), null, 'before the first update the reader rebuilds');
  });
});

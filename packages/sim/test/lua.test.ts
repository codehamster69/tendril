import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWorld, deserialize, hashWorld, netWorth, replayChunk, serialize } from '../src/local.ts';
import type { LogEntry, World } from '../src/local.ts';
import { createLuaRun } from '../src/local.ts';
import { farm } from './helpers.ts';

const example = (n: string): string => readFileSync(new URL(`../examples/${n}.lua`, import.meta.url), 'utf8');

async function run(src: string, ticks: number, seed = 7) {
  const lua = await createLuaRun(createWorld(farm(seed)), src);
  lua.step(ticks);
  return lua;
}
function replayed(seed: number, chunks: { log: LogEntry[]; to: number }[]): World {
  const w = createWorld(farm(seed));
  for (const c of chunks) replayChunk(w, c.log, c.to);
  return w;
}

describe('example scripts', () => {
  it('starter.lua runs clean and replays identically', async () => {
    const lua = await run(example('starter'), 20_000);
    expect(lua.errors).toEqual([]);
    expect(netWorth(lua.world)).toBeGreaterThan(0);
    const w = replayed(7, [{ log: lua.takeLog(), to: 20_000 }]);
    expect(hashWorld(w)).toBe(hashWorld(lua.world));
    expect(netWorth(w)).toBe(netWorth(lua.world));
    lua.close();
  }, 60_000);

  it('expander.lua grows, beats starter, replays identically, and is fast', async () => {
    const starter = await run(example('starter'), 200_000);
    const t0 = Date.now();
    const lua = await run(example('expander'), 200_000);
    const ms = Date.now() - t0;
    expect(lua.errors).toEqual([]);
    expect(lua.world.plots.length).toBeGreaterThan(1);
    expect(lua.world.bots.length).toBeGreaterThan(1);
    expect(netWorth(lua.world)).toBeGreaterThan(netWorth(starter.world));
    expect(ms).toBeLessThan(20_000);
    const w = replayed(7, [{ log: lua.takeLog(), to: 200_000 }]);
    expect(hashWorld(w)).toBe(hashWorld(lua.world));
    starter.close(); lua.close();
  }, 120_000);

  it('expander.lua is restart-safe through serialize/deserialize', async () => {
    const a = await run(example('expander'), 50_000);
    expect(a.errors).toEqual([]);
    const mid = netWorth(a.world);
    const saved = serialize(a.world);
    a.close();
    const b = await createLuaRun(deserialize(saved), example('expander'));
    b.step(50_000);
    expect(b.errors).toEqual([]);
    expect(b.world.tick).toBe(100_000);
    expect(netWorth(b.world)).toBeGreaterThan(mid);
    b.close();
  }, 120_000);
});

describe('log chunking', () => {
  it('replays three takeLog() chunks in order', async () => {
    const lua = await createLuaRun(createWorld(farm(7)), example('expander'));
    const chunks: { log: LogEntry[]; to: number }[] = [];
    for (let i = 1; i <= 3; i++) { lua.step(10_000); chunks.push({ log: lua.takeLog(), to: i * 10_000 }); }
    expect(lua.pending).toEqual([]);
    expect(hashWorld(replayed(7, chunks))).toBe(hashWorld(lua.world));
    lua.close();
  }, 60_000);
});

describe('API surface', () => {
  it('every function is callable and returns the documented type', async () => {
    const lua = await run(`
      local function is_int(v) return math.type(v) == "integer" end
      assert(is_int(bot.id()) and bot.id() == 0)
      local x, y = bot.pos(); assert(is_int(x) and is_int(y))
      assert(type(bot.move("north")) == "boolean")
      assert(type(bot.move("east")) == "boolean")
      assert(type(bot.move("south")) == "boolean")
      assert(type(bot.move("west")) == "boolean")
      assert(bot.move("east") == true)
      assert(type(bot.till()) == "boolean")
      local s = bot.scan()
      assert(type(s) == "table" and s.tilled == true and s.crop == nil)
      assert(is_int(s.stage) and is_int(s.moisture) and is_int(s.nitrogen) and is_int(s.fatigue))
      assert(s.barn == false)
      assert(bot.plant("wheat") == true)
      assert(bot.scan().crop == "wheat")
      assert(type(bot.water()) == "boolean")
      assert(is_int(bot.harvest()))
      assert(bot.wait(3) == true)
      assert(next(bot.load()) == nil)
      assert(bot.move("west"))
      assert(is_int(bot.deposit()))
      assert(type(bot.load()) == "table")
      assert(is_int(world.tick()))
      local b = world.scan(0, 0); assert(b.barn == true)
      assert(world.scan(100, 100) == nil)
      assert(world.owns(1, 1) == true and world.owns(8, 0) == false)
      local plots = world.plots(); assert(#plots == 1 and plots[1].px == 0 and plots[1].py == 0)
      for i, p in ipairs(plots) do assert(i == 1 and is_int(p.px)) end
      local fc = world.forecast(5000); assert(type(fc) == "table" and #fc > 0)
      for _, f in ipairs(fc) do
        assert(f.kind == "rain" or f.kind == "frost")
        assert(is_int(f.start) and is_int(f["end"]) and f.stop == f["end"])
      end
      local wx = world.weather(); assert(wx == "clear" or wx == "rain" or wx == "frost")
      local os_ = market.orders(); assert(type(os_) == "table")
      assert(is_int(market.deliver(999)))
      assert(is_int(market.sell("carrot", 1)))
      assert(type(market.stock()) == "table")
      assert(is_int(market.coins()))
      assert(is_int(farm.plot_cost()) and is_int(farm.bot_cost()) and farm.bots() == 1)
      assert(farm.buy_plot(5, 5) == false)
      assert(farm.buy_bot() == nil)
      signal.set("k", 42); assert(signal.get("k") == 42)
      log("a", 1, nil, true)
      world.__done = true
    `, 100);
    expect(lua.errors).toEqual([]);
    expect(lua.output).toEqual(['[bot 0] a\t1\tnil\ttrue']);
    lua.close();
  });

  it('buys plots and bots synchronously and shares signal across bots', async () => {
    const w = createWorld(farm(3));
    w.coins = 1000;
    const lua = await createLuaRun(w, `
      if bot.id() == 0 then
        assert(farm.buy_plot(1, 0) == true)
        local n = farm.buy_bot(); assert(n == 1, tostring(n))
        signal.set("hello", "world")
      else
        log(signal.get("hello"), farm.bots(), #world.plots())
      end
    `);
    lua.step(5);
    expect(lua.errors).toEqual([]);
    expect(lua.output).toEqual(['[bot 1] world\t2\t2']);
    expect(lua.takeLog().map((e) => e[2])).toEqual([9, 10]);
    lua.close();
  });
});

describe('errors and sandbox', () => {
  it('syntax errors are reported with bot -1 and ticks still advance', async () => {
    const lua = await run('this is not lua', 10);
    expect(lua.errors).toHaveLength(1);
    expect(lua.errors[0]!.bot).toBe(-1);
    expect(lua.errors[0]!.message).toMatch(/bot:1:/);
    expect(lua.world.tick).toBe(10);
    lua.close();
  });

  it('bad arguments raise Lua errors with the caller line', async () => {
    const lua = await run('local a = 1\nbot.move("up")', 5);
    expect(lua.errors).toHaveLength(1);
    expect(lua.errors[0]!.message).toBe("bot:2: bot.move: unknown direction 'up'");
    expect(lua.pending).toEqual([]);
    for (const [call, text] of [
      ['bot.plant("rose")', "unknown crop 'rose'"], ['market.sell("wheat", 1.5)', 'must be an integer'],
      ['bot.wait("x")', 'must be an integer'], ['farm.buy_plot(1)', 'must be an integer'],
    ] as const) {
      const l = await run(call, 3);
      expect(l.errors[0]!.message).toContain(text);
      l.close();
    }
    lua.close();
  });

  it('one bot erroring does not stop the others', async () => {
    const w = createWorld(farm(7)); w.coins = 100;
    const lua = await createLuaRun(w, `
      if bot.id() == 0 then farm.buy_bot(); bot.move("up") end
      while true do bot.wait(5) end
    `);
    lua.step(100);
    expect(lua.errors).toHaveLength(1);
    expect(lua.errors[0]!.bot).toBe(0);
    expect(lua.takeLog().filter((e) => e[1] === 1).length).toBeGreaterThan(10);
    lua.close();
  });

  it('os, io, require, debug and friends are nil', async () => {
    const lua = await run(`
      for _, n in ipairs({"os", "io", "require", "dofile", "loadfile", "package", "debug"}) do
        assert(_G[n] == nil, n)
      end
      assert(load("return 1", "x", "b") == nil)
    `, 3);
    expect(lua.errors).toEqual([]);
    lua.close();
  });

  it('a script that returns leaves the bot dead and the world ticking', async () => {
    const lua = await run('local x = 1', 50);
    expect(lua.errors).toEqual([]);
    expect(lua.world.tick).toBe(50);
    expect(lua.pending).toEqual([]);
    lua.close();
  });

  it('an infinite loop without acting is stopped as a bot error', async () => {
    const lua = await run('while true do end', 3);
    expect(lua.errors).toHaveLength(1);
    expect(lua.errors[0]!.message).toContain('too long');
    expect(lua.world.tick).toBe(3);
    lua.close();
  }, 60_000);

  it('step throws after close, and output keeps only the last 1000 lines', async () => {
    const lua = await run('for i = 1, 1500 do log(i) end', 1);
    expect(lua.output).toHaveLength(1000);
    expect(lua.output[999]).toBe('[bot 0] 1500');
    lua.close();
    expect(() => lua.step(1)).toThrow();
  });
});

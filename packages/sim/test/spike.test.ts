import { describe, expect, it } from 'vitest';
import { IllegalAction, hashWorld, replay, runLua } from '../src/index.ts';

const SCRIPT = `
local w, h = world.size()
local x, dir = 0, "east"
while true do
  local t = bot.scan()
  if t.crop ~= 0 and t.stage == 3 then bot.harvest() end
  t = bot.scan()
  if t.crop == 0 then bot.till(); bot.plant("carrot") end
  if not bot.move(dir) then
    if not bot.move("south") then for i = 1, h - 1 do bot.move("north") end end
    dir = (dir == "east") and "west" or "east"
  end
end`;

describe('spike: Lua run -> action log -> replay', () => {
  it('replay without Lua reproduces the exact state hash', async () => {
    const END = 20000;
    const a = await runLua(4, 4, 7, [SCRIPT], END);
    const b = await runLua(4, 4, 7, [SCRIPT], END);
    expect(a.errors).toEqual([]);
    expect(a.world.coins).toBeGreaterThan(0);
    expect(hashWorld(b.world)).toBe(hashWorld(a.world));
    const t0 = performance.now();
    const r = replay(4, 4, 7, 1, END, a.log);
    const ms = performance.now() - t0;
    expect(hashWorld(r)).toBe(hashWorld(a.world));
    expect(r.coins).toBe(a.world.coins);
    console.log(`coins=${a.world.coins} actions=${a.log.length} hash=${hashWorld(r)} replay=${ms.toFixed(1)}ms logJson=${JSON.stringify(a.log).length}B`);
  });
  it('a different seed gives a different result', async () => {
    const a = await runLua(4, 4, 7, [SCRIPT], 3000), b = await runLua(4, 4, 8, [SCRIPT], 3000);
    expect(hashWorld(a.world)).not.toBe(hashWorld(b.world));
  });
  it('rejects a log with a move made while the bot is busy', async () => {
    const a = await runLua(4, 4, 7, [SCRIPT], 500);
    const forged = [...a.log]; forged.splice(1, 0, { ...forged[0]!, op: 'harvest' });
    expect(() => replay(4, 4, 7, 1, 500, forged)).toThrow(IllegalAction);
  });
  it('script errors are reported, not thrown', async () => {
    const r = await runLua(4, 4, 1, ['bot.move("east") error("boom")'], 50);
    expect(r.errors[0]).toContain('boom');
  });
});

// Runs player Lua scripts locally and records the action log. Never used on the server.
import { LuaFactory } from 'wasmoon';
import { Action, Op, World, applyAction, createWorld, scan, tickWorld } from './world.ts';

const PRELUDE = `
local co, cur = {}, 0
local function act(op, arg) return coroutine.yield(op, arg) end
bot = {
  move = function(d) return act("move", d) ~= 0 end,
  till = function() return act("till") ~= 0 end,
  plant = function(c) return act("plant", c) ~= 0 end,
  harvest = function() return act("harvest") end,
  wait = function() return act("wait") end,
  scan = function() return __scan(cur) end,
}
world = { tick = function() return __tick() end, size = function() return __w, __h end }
function __spawn(id, src)
  local f, err = load(src, "=bot" .. id, "t")
  if not f then return err end
  co[id] = coroutine.create(f)
end
function __resume(id, res)
  cur = id
  local ok, op, arg = coroutine.resume(co[id], res)
  if not ok then return "error|" .. tostring(op) end
  if coroutine.status(co[id]) == "dead" then return "done|" end
  return tostring(op) .. "|" .. tostring(arg or "")
end
`;

export interface RunResult { world: World; log: Action[]; errors: string[] }

export async function runLua(w: number, h: number, seed: number, scripts: string[], endTick: number): Promise<RunResult> {
  const lua = await new LuaFactory().createEngine({ openStandardLibs: true });
  const world = createWorld(w, h, seed, scripts.length);
  const log: Action[] = []; const errors: string[] = [];
  try {
    lua.global.set('__scan', (id: number) => scan(world, id));
    lua.global.set('__tick', () => world.tick);
    lua.global.set('__w', w); lua.global.set('__h', h);
    await lua.doString('os, io, require, dofile, loadfile, package, debug = nil');
    await lua.doString(PRELUDE);
    const spawn = lua.global.get('__spawn') as (id: number, src: string) => string | undefined;
    const resume = lua.global.get('__resume') as (id: number, res: number) => string;
    const alive = scripts.map((src, id) => { const e = spawn(id, src); if (e) errors.push(e); return !e; });
    const last = scripts.map(() => 0);
    while (world.tick < endTick) {
      for (let id = 0; id < scripts.length; id++) {
        if (!alive[id] || world.bots[id]!.busyUntil > world.tick) continue;
        const out = resume(id, last[id]!); const cut = out.indexOf('|');
        const op = out.slice(0, cut), arg = out.slice(cut + 1);
        if (op === 'done' || op === 'error') { alive[id] = false; if (op === 'error') errors.push(`bot ${id}: ${arg}`); continue; }
        const a: Action = arg ? { t: world.tick, bot: id, op: op as Op, arg } : { t: world.tick, bot: id, op: op as Op };
        try { last[id] = applyAction(world, a); log.push(a); }
        catch (e) { alive[id] = false; errors.push(`bot ${id}: ${(e as Error).message}`); }
      }
      tickWorld(world);
    }
  } finally { lua.global.close(); }
  return { world, log, errors };
}

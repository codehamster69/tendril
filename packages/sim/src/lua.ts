// Runs a player Lua program against a World, one coroutine per bot. Local play only: never import from the server.
// All coroutines live inside one Lua state; each action is coroutine.yield(op, a, b) and JS calls __resume(id, last).
// Data crossing from JS to Lua is always primitives (numbers, booleans, packed strings); tables are built in the prelude.
import { LuaFactory } from 'wasmoon';
import type { LuaEngine } from 'wasmoon';
import {
  applyAction, botCost, forecast, openOrders, plotCost, scan, scanAt, tickWorld, weatherAt,
} from './world.ts';
import type { LogEntry, ScanResult, World } from './types.ts';

export interface LuaRun {
  world: World; pending: LogEntry[];
  errors: { bot: number; message: string }[]; output: string[];
  step(ticks: number): void;
  takeLog(): LogEntry[];
  close(): void;
}

const MAX_OUTPUT = 1000;
const HOOK_INSTRUCTIONS = 20_000_000;

const PRELUDE = String.raw`
local co, hook = {}, debug.sethook
local chunk
local NAMES = { "carrot", "wheat", "clover", "pumpkin" }
local CROP = { carrot = 1, wheat = 2, clover = 3, pumpkin = 4 }
local DIR = { north = 0, east = 1, south = 2, west = 3 }
local floor, mtype, tointeger = math.floor, math.type, math.tointeger

local function int(fn, what, v)
  local i = (type(v) == "number") and tointeger(v)
  if not i then error(fn .. ": " .. what .. " must be an integer, got " .. tostring(v), 3) end
  return i
end
local function crop(fn, name)
  local c = CROP[name]
  if not c then error(fn .. ": unknown crop '" .. tostring(name) .. "'", 3) end
  return c
end
local function nums(s)
  local t = {}
  for v in string.gmatch(s, "[^,]+") do t[#t + 1] = tonumber(v) end
  return t
end
local function parse_scan(s)
  if s == "" then return nil end
  local n = nums(s)
  local t = { tilled = n[1] ~= 0, stage = n[3], moisture = n[4], nitrogen = n[5], fatigue = n[6], barn = n[7] ~= 0 }
  if n[2] ~= 0 then t.crop = NAMES[n[2]] end
  return t
end
local function by_name(s)
  local n, t = nums(s), {}
  for i = 1, 4 do if n[i] > 0 then t[NAMES[i]] = n[i] end end
  return t
end
local function act(op, a, b) return coroutine.yield(op, a, b) end

bot = {
  id = function() return __bot() end,
  move = function(d)
    local dir = DIR[d]
    if dir == nil then error("bot.move: unknown direction '" .. tostring(d) .. "'", 2) end
    return act(0, dir) ~= 0
  end,
  till = function() return act(1) ~= 0 end,
  plant = function(name) return act(2, crop("bot.plant", name)) ~= 0 end,
  water = function() return act(3) ~= 0 end,
  harvest = function() return tointeger(act(4)) end,
  deposit = function() return tointeger(act(5)) end,
  wait = function(n)
    n = int("bot.wait", "ticks", n)
    if n < 1 or n > 1000 then error("bot.wait: ticks must be 1..1000, got " .. n, 2) end
    act(7, n)
    return true
  end,
  scan = function() return parse_scan(__scan()) end,
  pos = function() local n = nums(__pos()); return n[1], n[2] end,
  load = function() return by_name(__load()) end,
}
world = {
  tick = function() return __tick() end,
  scan = function(x, y)
    return parse_scan(__scan_at(int("world.scan", "x", x), int("world.scan", "y", y)))
  end,
  owns = function(x, y) return __owns(int("world.owns", "x", x), int("world.owns", "y", y)) end,
  plots = function()
    local out = {}
    for r in string.gmatch(__plots(), "[^;]+") do
      local n = nums(r)
      out[#out + 1] = { px = n[1], py = n[2] }
    end
    return out
  end,
  forecast = function(n)
    local out = {}
    for r in string.gmatch(__forecast(int("world.forecast", "ticks", n)), "[^;]+") do
      local kind, s, e = string.match(r, "^(%a+),(-?%d+),(-?%d+)$")
      s, e = tonumber(s), tonumber(e)
      out[#out + 1] = { kind = kind, start = s, ["end"] = e, stop = e }
    end
    return out
  end,
  weather = function() return __weather() end,
}
market = {
  orders = function()
    local out = {}
    for r in string.gmatch(__orders(), "[^;]+") do
      local n = nums(r)
      out[#out + 1] = { id = n[1], crop = NAMES[n[2]], qty = n[3], reward = n[4], deadline = n[5] }
    end
    return out
  end,
  deliver = function(id) return tointeger(act(6, int("market.deliver", "order id", id))) end,
  sell = function(name, units)
    local c = crop("market.sell", name)
    units = int("market.sell", "units", units)
    if units < 1 then error("market.sell: units must be >= 1, got " .. units, 2) end
    return tointeger(act(8, c, units))
  end,
  stock = function() return by_name(__stock()) end,
  coins = function() return __coins() end,
}
farm = {
  plot_cost = function() return __plot_cost() end,
  buy_plot = function(px, py)
    return __buy_plot(int("farm.buy_plot", "px", px), int("farm.buy_plot", "py", py))
  end,
  bot_cost = function() return __bot_cost() end,
  buy_bot = function() local i = __buy_bot(); if i < 0 then return nil end; return i end,
  bots = function() return __bots() end,
}
local shared = {}
signal = {
  set = function(k, v) shared[k] = v end,
  get = function(k) return shared[k] end,
}
function log(...)
  local t = table.pack(...)
  for i = 1, t.n do t[i] = tostring(t[i]) end
  __log(table.concat(t, "\t", 1, t.n))
end

function __load_program(src)
  local f, err = load(src, "=bot", "t")
  if not f then return err end
  chunk = f
  return ""
end
local function too_long() error("script ran too long without acting (infinite loop?)", 2) end
function __spawn(id) co[id] = coroutine.create(chunk) end
function __resume(id, res)
  local c = co[id]
  hook(c, too_long, "", ${HOOK_INSTRUCTIONS})
  local ok, op, a, b = coroutine.resume(c, res)
  if not ok then return "error|" .. tostring(op) end
  if coroutine.status(c) == "dead" then return "done|" end
  return tostring(op) .. "|" .. tostring(a or "") .. "|" .. tostring(b or "")
end
`;

const packScan = (s: ScanResult | null): string =>
  s === null ? '' : [s.tilled, s.crop, s.stage, s.moisture, s.nitrogen, s.fatigue, s.barn ? 1 : 0].join(',');

export async function createLuaRun(world: World, source: string): Promise<LuaRun> {
  const lua: LuaEngine = await new LuaFactory().createEngine({ openStandardLibs: true });
  let closed = false;
  let curBot = -1;
  const pending: LogEntry[] = [];
  const errors: { bot: number; message: string }[] = [];
  const output: string[] = [];
  const g = lua.global;

  const farmAction = (e: LogEntry): number => {
    const r = applyAction(world, e);
    pending.push(e);
    return r;
  };
  const rows = (items: (string | number)[][]): string => items.map((r) => r.join(',')).join(';');

  g.set('__bot', () => curBot);
  g.set('__tick', () => world.tick);
  g.set('__scan', () => packScan(scan(world, curBot)));
  g.set('__pos', () => { const b = world.bots[curBot]!; return `${b.x},${b.y}`; });
  g.set('__load', () => Array.from(world.bots[curBot]!.load).slice(1, 5).join(','));
  g.set('__scan_at', (x: number, y: number) => packScan(scanAt(world, x, y)));
  g.set('__owns', (x: number, y: number) => scanAt(world, x, y) !== null);
  g.set('__plots', () => rows(world.plots.map((p) => [p.px, p.py])));
  g.set('__forecast', (n: number) => rows(forecast(world, n).map((s) => [s.kind, s.start, s.end])));
  g.set('__weather', () => weatherAt(world, world.tick));
  g.set('__orders', () => rows(openOrders(world).map((o) => [o.id, o.crop, o.qty, o.reward, o.deadline])));
  g.set('__stock', () => world.stock.slice(1, 5).join(','));
  g.set('__coins', () => world.coins);
  g.set('__plot_cost', () => plotCost(world));
  g.set('__bot_cost', () => botCost(world));
  g.set('__bots', () => world.bots.length);
  g.set('__buy_plot', (px: number, py: number) => farmAction([world.tick, -1, 9, px, py]) === 1);
  g.set('__buy_bot', () => farmAction([world.tick, -1, 10]) - 1);
  g.set('__log', (text: string) => {
    output.push(`[bot ${curBot}] ${text}`);
    if (output.length > MAX_OUTPUT) output.splice(0, output.length - MAX_OUTPUT);
  });

  await lua.doString(PRELUDE);
  await lua.doString('os, io, require, dofile, loadfile, package, debug = nil');
  const loadProgram = g.get('__load_program') as (src: string) => string;
  const spawn = g.get('__spawn') as (id: number) => void;
  const resume = g.get('__resume') as (id: number, res: number) => string;

  const syntaxError = loadProgram(source);
  const alive: boolean[] = [];
  const last: number[] = [];
  if (syntaxError) errors.push({ bot: -1, message: syntaxError });

  const kill = (bot: number, message: string): void => {
    alive[bot] = false;
    errors.push({ bot, message });
  };

  const stepOne = (): void => {
    if (!syntaxError) {
      for (let i = 0; i < world.bots.length; i++) {
        if (alive[i] === undefined) { spawn(i); alive[i] = true; last[i] = 0; }
        if (!alive[i] || world.bots[i]!.busyUntil > world.tick) continue;
        curBot = i;
        const out = resume(i, last[i]!);
        const c1 = out.indexOf('|');
        const head = out.slice(0, c1);
        if (head === 'done') { alive[i] = false; continue; }
        if (head === 'error') { kill(i, out.slice(c1 + 1)); continue; }
        const [, aS, bS] = out.split('|');
        const entry: LogEntry = [world.tick, i, Number(head)];
        if (aS) entry.push(Number(aS));
        if (bS) entry.push(Number(bS));
        try {
          last[i] = applyAction(world, entry);
          pending.push(entry);
        } catch (e) {
          kill(i, (e as Error).message);
        }
      }
      curBot = -1;
    }
    tickWorld(world);
  };

  return {
    world, pending, errors, output,
    step(ticks: number): void {
      if (closed) throw new Error('LuaRun is closed');
      for (let n = 0; n < ticks; n++) stepOne();
    },
    takeLog(): LogEntry[] { return pending.splice(0, pending.length); },
    close(): void {
      if (closed) return;
      closed = true;
      lua.global.close();
    },
  };
}

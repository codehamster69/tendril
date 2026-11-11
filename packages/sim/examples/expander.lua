-- Multi-bot farm that grows itself. Restart-safe: everything is re-read from the world each cycle.
local THIRST = { carrot = 20, wheat = 15, clover = 25, pumpkin = 40 }
local WHEAT_HUNGER = 20

local function walk_to(tx, ty)
  while true do
    local x, y = bot.pos()
    if x == tx and y == ty then return true end
    local dir
    if x < tx then dir = "east" elseif x > tx then dir = "west"
    elseif y < ty then dir = "south" else dir = "north" end
    if not bot.move(dir) then return false end
  end
end

local function carried()
  local n = 0
  for _, u in pairs(bot.load()) do n = n + u end
  return n
end

local function next_plot()
  local px = 1
  while world.owns(px * 8, 0) do px = px + 1 end
  return px, 0
end

local function expand()
  -- keep bots and plots roughly in step; plots first when equal
  if farm.bots() < #world.plots() then
    if market.coins() >= farm.bot_cost() then farm.buy_bot() end
  elseif market.coins() >= farm.plot_cost() then
    farm.buy_plot(next_plot())
  elseif market.coins() >= farm.bot_cost() then
    farm.buy_bot()
  end
end

local function fill_orders()
  local stock = market.stock()
  for _, o in ipairs(market.orders()) do
    if (stock[o.crop] or 0) >= o.qty then
      if market.deliver(o.id) > 0 then stock = market.stock() end
    end
  end
end

local function unload()
  if not walk_to(0, 0) then return end
  bot.deposit()
  fill_orders()
  for name, units in pairs(market.stock()) do
    -- keep a little wheat/clover back only if an order could use it; otherwise sell
    market.sell(name, units)
  end
  expand()
end

local function choose(s)
  if s.nitrogen < WHEAT_HUNGER then return "clover" end
  if s.fatigue >= 60 then return nil end
  return "wheat"
end

local function tile_list(plot)
  local tiles = {}
  local ox, oy = plot.px * 8, plot.py * 8
  for dy = 0, 7 do
    for i = 0, 7 do
      local dx = (dy % 2 == 0) and i or (7 - i)
      local x, y = ox + dx, oy + dy
      if not (x == 0 and y == 0) then tiles[#tiles + 1] = { x, y } end
    end
  end
  return tiles
end

while true do
  local plots = world.plots()
  local plot = plots[bot.id() % #plots + 1]
  for _, t in ipairs(tile_list(plot)) do
    if walk_to(t[1], t[2]) then
      local s = bot.scan()
      if s.crop and s.stage >= 3 then
        bot.harvest()
        s = bot.scan()
      end
      if not s.crop then
        local c = choose(s)
        if c then
          if s.moisture < THIRST[c] then bot.water() end
          if not s.tilled then bot.till() end
          bot.plant(c)
        end
      end
      if carried() >= 16 then unload() end
    end
  end
  unload()
end

-- One bot: snake over the first plot, farm carrots, deposit at the barn, sell.
local CROP = "carrot"

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

local function unload()
  if walk_to(0, 0) then
    bot.deposit()
    for name, units in pairs(market.stock()) do market.sell(name, units) end
  end
end

-- snake: row 0 east, row 1 west, ... skipping the barn tile (0, 0)
local tiles = {}
for y = 0, 7 do
  for i = 0, 7 do
    local x = (y % 2 == 0) and i or (7 - i)
    if not (x == 0 and y == 0) then tiles[#tiles + 1] = { x, y } end
  end
end

while true do
  for _, t in ipairs(tiles) do
    if walk_to(t[1], t[2]) then
      local s = bot.scan()
      if s.crop and s.stage >= 3 then bot.harvest(); s = bot.scan() end
      if not s.crop then
        if not s.tilled then bot.till() end
        bot.plant(CROP)
      end
      if carried() >= 16 then unload() end
    end
  end
  unload()
end

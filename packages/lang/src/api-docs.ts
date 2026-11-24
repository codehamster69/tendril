import { SILO_BIT, UNLOCKS, createWorld } from '@tendril/sim/src/index.ts';
import type { Setup } from '@tendril/sim/src/index.ts';
import { createRun } from './engine.ts';

/**
 * Worked examples for the reference: one entry per API name and keyword, with the rules and refusal conditions.
 * Every `demo` is run in the real engine by the site build (to show its output) and by `test/api-docs.test.ts`
 * (which also checks that nothing here can drift from the API list). Keep them short and self-contained.
 */
export interface ApiDoc {
  /** Rules, costs and the situations where the call is refused or does nothing. */
  rules?: string[];
  /** A small program that uses the call. Runs for up to `ticks` ticks (default 600). */
  demo: string;
  /** `start`: a brand-new farm. `saver`: 100 coins. `rich` (default): 5,000 coins and every research, silos on. */
  world?: 'start' | 'saver' | 'rich';
  ticks?: number;
}

const ALL_RESEARCH = (1 << UNLOCKS.length) - 1;
export const DEMO_WORLDS: Record<'start' | 'saver' | 'rich', Setup> = {
  start: {},
  /** 100 coins and nothing researched: for demos that buy research. */
  saver: { coins: 100 },
  rich: { coins: 5000, unlocks: ALL_RESEARCH, siloTick: 0 },
};
void SILO_BIT;

export interface DemoResult { lines: string[]; errors: string[]; ticks: number }
/** Run a demo exactly as the game would, and return what it printed. */
export function runDemo(doc: ApiDoc, seed = 7): DemoResult {
  const run = createRun(createWorld({ id: 'docs', seed }, DEMO_WORLDS[doc.world ?? 'rich']), doc.demo);
  run.step(doc.ticks ?? 600);
  const result = { lines: run.output.map((o) => o.text), errors: run.errors.map((e) => `${e.line}:${e.col} ${e.message}`), ticks: run.world.tick };
  run.close();
  return result;
}

const GROW = 'while not scan().ripe:\n    wait 10\n';
const SOIL = 'till\nplant carrot\nwater\n';

export const API_DOCS: Record<string, ApiDoc> = {
  // ---- actions ----
  move: {
    rules: [
      'The direction is one of `north`, `east`, `south` or `west`. North is up the screen, so it lowers y.',
      'A move only works onto a tile you own. Stepping off the edge of your land does nothing and returns `false`, but the attempt still takes the 2 ticks.',
      'Bots never block each other: any number can stand on one tile.',
      'Any other word is a runtime error in that bot, not a refused action.',
    ],
    demo: 'ok = move(east)\nsay "moved east:", ok, position()\nok = move(north)   # y = -1 is not part of the farm\nsay "moved north:", ok, position()',
  },
  till: {
    rules: [
      'Works on any owned tile that has no crop and no building. Tilled soil is what `plant` needs.',
      'Refused (returns `false`) on the barn, on a building, or when something is already growing.',
      'Tilling an already tilled empty tile succeeds and changes nothing, so it is safe to repeat.',
      'Harvesting a crop (other than a berry or apple) puts the tile back to bare soil, so till again before replanting.',
    ],
    demo: 'say "on the barn:", till()      # false: the barn cannot be tilled\nmove east\nsay "on grass:", till()         # true\nsay scan().tilled',
  },
  plant: {
    rules: [
      'Needs a researched crop, tilled soil, and a tile with no crop or building on it. Otherwise it returns `false`.',
      'Planting uses up a little of the tile\'s moisture (carrot 10, wheat 6, pumpkin 25). If the soil has enough moisture and nitrogen for that crop at the moment you plant, it grows at double speed.',
      'Crops that aren\'t researched are refused, not errors: check `unlocked(name)` or `unlock` it first. Carrot starts unlocked.',
      'An unknown crop name is a runtime error.',
    ],
    demo: 'move east\ntill\nsay "carrot:", plant(carrot)\nsay "again:", plant(carrot)   # false: already planted\nmove east\nsay "untilled:", plant(wheat)  # false: not tilled',
  },
  water: {
    rules: [
      'Adds 30 moisture to the tile under the bot, up to 100. It always works, even on bare ground or the barn.',
      'Rain adds moisture to every tile of the farm, so check `weather()` and skip watering while it rains.',
      'Moisture is spent when you plant (each crop drinks some) and refilled by `water` and by rain. A crop planted into soil that is too dry or too poor in nitrogen grows at normal speed instead of double.',
    ],
    demo: 'move east\nbefore = scan().moisture\nwater\nsay "moisture:", before, "->", scan().moisture',
  },
  harvest: {
    rules: [
      'On a ripe crop (stage 3) it takes the produce into the bot\'s hands and returns the units taken. On an unripe crop or bare ground it returns 0.',
      'Yield depends on the crop and on fatigue: tired soil gives less. Each hive on the four neighbouring tiles adds 25%.',
      'A bot carries 20 units, or 30 once the satchel is researched. If it can only carry part of the crop, it takes what fits.',
      'On a hive it takes ready honey instead. Berries and apples are perennial: they keep growing and ripen again, so you never replant them.',
      'Carried produce earns nothing until you `deposit` it at the barn (or a silo) and `sell` it.',
    ],
    demo: `move east\n${SOIL}${GROW}got = harvest()\nsay "harvested", got, "carrot, carrying", carried()\nsay "again:", harvest()      # 0: the tile is bare now`,
    ticks: 800,
  },
  deposit: {
    rules: [
      'Works only on the barn tile, or on a silo (needs silo rules). Anywhere else it does nothing and returns 0.',
      'Moves every carried crop and honey into barn stock and returns the number of units. Compost stays in the bot\'s hands: it is for `fertilize`.',
      'Stock is shared by every bot and by `sell` and `deliver`.',
    ],
    demo: `move east\n${SOIL}${GROW}harvest\nsay "away from the barn:", deposit()   # 0\ngo_to barn\nsay "at the barn:", deposit()\nsay stock().carrot`,
    ticks: 900,
  },
  wait: {
    rules: [
      '`wait n` keeps the bot idle for n ticks. n must be at least 1; zero or negative is a runtime error.',
      'A wait longer than 1,000 is split into several waits of at most 1,000, so a very long `wait` still works.',
      'Waiting is how a bot lets crops grow without burning thinking time. Prefer `wait` over empty loops.',
    ],
    demo: 'start = tick()\nwait 25\nsay "waited", tick() - start, "ticks"',
  },
  sell: {
    rules: [
      'Sells from barn stock, not from the bot\'s hands, so `deposit` first. It works only at the barn tile or on a silo.',
      '`sell item, all` sells everything of that item. With nothing in stock it returns 0 and does nothing.',
      '`sell item, n` sells exactly n units, and is refused (returns 0) if the barn holds fewer.',
      'Pays the whole coins for the units at today\'s price: `n * price / 100` rounded down, so on market days small sales can round down to 0. Check `price(item)`.',
      'Compost is not a sellable item.',
    ],
    demo: `move east\n${SOIL}${GROW}harvest\ngo_to barn\ndeposit\nsay "too many:", sell(carrot, 99)   # 0\nsay "sold:", sell(carrot, all)\nsay "coins:", coins()`,
    ticks: 900,
  },
  deliver: {
    rules: [
      'Works only at the barn tile. Pass an order record from `orders()` or just its id.',
      'Needs the full quantity in barn stock; partial deliveries aren\'t allowed. Refused (returns 0) if the stock is short, the order is gone, or you are not at the barn.',
      'Orders expire at their deadline and new ones appear over time. Read `deadline` against `tick()` before committing a crop to one.',
      'A delivered order takes its crops from stock and pays its `reward`: twice the base price per unit plus 10, so it beats selling.',
    ],
    demo: 'wait 250                    # contracts open over time\nlist = orders()\nsay "open orders:", len(list)\nif len(list) > 0:\n    order = list[0]\n    say "need", order.qty, order.crop, "for", order.reward, "coins"\n    say "delivered:", deliver(order)   # 0: the barn is empty',
    ticks: 400,
  },
  build: {
    rules: [
      'Builds on the tile under the bot. Kinds: `hive` (120 coins), `composter` (80) and `silo` (500 for the first, 2,000 for the second, and so on).',
      'Needs the research (`hive`, `composter`, `silo`), enough coins, and a bare tile: no crop, no tilled soil, no building, and not the barn. Otherwise it returns `false`.',
      'Silos also need silo rules to be on; before that `build silo` is refused.',
      'Anything else, like `build carrot`, is a runtime error.',
      'Take a building back with `clear`. A hive or composter refunds nothing, a silo refunds half its price.',
    ],
    demo: 'move east\nsay "hive:", build(hive)\nsay scan().building\nmove east\nsay "silo:", build(silo)\nsay "next silo costs", silo_cost()',
  },
  clear: {
    rules: [
      'Removes a crop, tilled soil or building from the tile under the bot. Returns `true` if something was removed, `false` on bare grass or on the barn.',
      'No produce and no refund come back, except a silo, which gives back half its price.',
      'It resets the tile to bare grass, so you can build there afterwards. Useful when a crop is going to waste.',
    ],
    demo: 'move east\ntill\nsay "tilled:", scan().tilled\nsay "cleared:", clear()\nsay "tilled:", scan().tilled\nsay "again:", clear()     # false: nothing left to remove',
  },
  compost: {
    rules: [
      'Works only on a composter, otherwise it does nothing and returns 0.',
      'Converts every full group of four carried crop units into one compost and returns how many compost it made. One or two crops left over stay in the bot\'s hands.',
      'Honey and compost are not crops and are never used up here.',
      'Compost is carried: it takes inventory space, and `deposit` leaves it in the bot\'s hands.',
    ],
    demo: `move east\nbuild composter\nmove east\n${SOIL}${GROW}harvest\nmove west\nsay "made:", compost()\nsay load().compost`,
    ticks: 900,
  },
  fertilize: {
    rules: [
      'Uses one carried compost on the tile under the bot: +25 nitrogen (max 100) and -20 fatigue (min 0). Returns `true`.',
      'Refused (returns `false`) with no compost in hand, on the barn, or on a building.',
      'Nitrogen is what crops with hunger need to grow fast, and fatigue lowers yield, so fertilize the tiles your crops have worn out.',
    ],
    demo: `move east\nsay "none in hand:", fertilize()\nbuild composter\nmove east\n${SOIL}${GROW}harvest\nmove west\ncompost\nmove east\nbefore = scan().nitrogen\nsay "fertilized:", fertilize()\nsay "nitrogen", before, "->", scan().nitrogen`,
    ticks: 1000,
  },

  // ---- farm actions ----
  buy_plot: {
    rules: [
      'Buys the 8×8 plot at plot coordinates (px, py). The barn plot is (0, 0); (1, 0) lies east of it, (0, -1) north of it.',
      'The plot must be next to a plot you own on one of its four sides, not owned already, and you must be able to pay `plot_cost()`.',
      'The price rises with the square of the plots owned: 150 for the first extra plot, then 600, 1,350, and so on.',
      'Refused (returns `false`, spends nothing) otherwise. It is instant and does not use the bot\'s turn.',
    ],
    demo: 'say "cost:", plot_cost()\nsay "bought east:", buy_plot(1, 0)\nsay "diagonal:", buy_plot(5, 5)     # false: not next to your land\nsay "again:", buy_plot(1, 0)         # false: already yours\nsay "plots:", len(plots())',
  },
  sell_plot: {
    rules: [
      'Sells the plot at plot coordinates (px, py), the same coordinates `buy_plot` uses. Pays half the price of your newest plot (rounded down) and returns the coins paid.',
      'It only works on an edge plot: one with at least one side that is not another owned plot, so selling can never dig a hole in the middle of the farm.',
      'The barn plot, (0, 0), can never be sold.',
      'No bot may be standing on the plot. Move them off first.',
      'The farm must stay connected: every other plot must still reach the barn plot through plots you own. Selling a plot that bridges two parts of the farm is refused.',
      'Returns 0 and changes nothing when refused, and prints the reason to the console. Anything built on a sold plot is lost, and silos on it get no refund. The farm must have silo rules switched on.',
    ],
    demo: 'buy_plot 1, 0\nbuy_plot 2, 0\nsay "middle plot:", sell_plot(1, 0)     # 0: (2, 0) would be cut off\nsay "barn plot:", sell_plot(0, 0)      # 0: the barn plot is permanent\nsay "edge plot:", sell_plot(2, 0)      # pays half of what it cost\nsay "plots left:", len(plots())',
  },
  buy_bot: {
    rules: [
      'Buys a new bot that starts at the barn and begins running your program from the top straight away. Returns its zero-based id.',
      'Returns `none` if you can\'t afford `bot_cost()`. The price rises with the square of the bots you own: 80, 320, 720, and so on.',
      'All bots run the same program. Use `my_id()` to make them do different jobs.',
    ],
    demo: 'if my_id() == 0:\n    new = buy_bot()\n    say "bought bot", new\n    say "next bot costs", bot_cost()\nelse:\n    say "hello from bot", my_id()',
  },
  unlock: {
    rules: [
      'Pays the research price once and keeps it for good. Returns `true`. Names: `wheat` 40, `clover` 60, `pumpkin` 250, `berry` 400, `apple` 900, `hive` 300, `composter` 200, `satchel` 500, and `silo` 1,200 when silo rules are on. Carrot is free.',
      'Refused (returns `false`) if you already have it, can\'t afford it, or it is `silo` before silo rules are on.',
      'An unknown name is a runtime error.',
    ],
    demo: 'say unlocked(wheat)\nsay "first time:", unlock(wheat)\nsay "second time:", unlock(wheat)   # false: you already own it\nsay "apple:", unlock(apple)             # false: 900 coins is too much\nsay unlocked(wheat), coins()',
    world: 'saver',
  },

  // ---- questions ----
  scan: {
    rules: ['Free. Always describes the tile under the bot, with soil values as of right now.', 'See the field table above for every field it returns.'],
    demo: 'move east\ntill\nplant carrot\ns = scan()\nsay "crop:", s.crop, "stage:", s.stage, "ripe:", s.ripe\nsay "moisture:", s.moisture, "nitrogen:", s.nitrogen',
  },
  scan_at: {
    rules: ['Free. Same record as `scan()`, for any tile you own, whether or not a bot is there.', 'Returns `none` for land you don\'t own, so check before reading a field.'],
    demo: 'say scan_at(1, 1).empty\nsay scan_at(40, 40)      # none: not your land\nt = scan_at(3, 3)\nif t:\n    say "tile (3, 3) is", t.empty',
  },
  position: {
    rules: ['Free. Returns the position of the bot that asks, as `{x, y}`. Tile coordinates, not plot coordinates: plot (1, 0) starts at x = 8.'],
    demo: 'move east\nmove east\np = position()\nsay p.x, p.y\nsay p',
  },
  my_id: {
    rules: ['Free. The first bot is 0, and each bought bot gets the next number. Ids are never reused.'],
    demo: 'say "I am bot", my_id()',
  },
  load: {
    rules: ['Free. A record of every item the bot carries, with all items present (zero when none), keyed by `carrot`, `wheat`, `clover`, `pumpkin`, `berry`, `apple`, `honey` and `compost`.'],
    demo: `move east\n${SOIL}${GROW}harvest\nl = load()\nsay l.carrot, l.wheat, l.compost`,
    ticks: 800,
  },
  carried: {
    rules: ['Free. Total units in this bot\'s hands, including compost. Compare with `capacity()` to know when to go to the barn.'],
    demo: `move east\n${SOIL}${GROW}harvest\nsay carried(), "of", capacity()`,
    ticks: 800,
  },
  capacity: {
    rules: ['Free. 20 units, or 30 once the `satchel` is researched. Harvests stop at this limit, so a full bot takes only what fits.'],
    demo: 'say capacity()\nunlock satchel\nsay capacity()',
    world: 'saver',
  },
  tick: {
    rules: ['Free. The farm\'s current tick, shared by every bot. Time passes only as bots act, so it is a good way to measure how long something took.'],
    demo: 'a = tick()\nmove east\nsay "move took", tick() - a, "ticks"',
  },
  owns: {
    rules: ['Free. `true` if the tile (x, y) belongs to your farm, in tile coordinates. Also works for tiles far away: unowned land simply gives `false`.'],
    demo: 'say owns(7, 7)     # the last tile of the barn plot\nsay owns(8, 0)     # the first tile of plot (1, 0)\nbuy_plot 1, 0\nsay owns(8, 0)',
  },
  plots: {
    rules: ['Free. A list of `{px, py}` plot coordinates, oldest first. The barn plot is always first. The same coordinates `buy_plot` and `sell_plot` take.'],
    demo: 'buy_plot 1, 0\nbuy_plot 1, 1\nfor each p in plots():\n    say p.px, p.py',
  },
  tiles: {
    rules: ['Free. Every tile you own as `{x, y}`, in plot order and then row by row. Tool for loops that sweep the whole farm.', 'It is a long list on a big farm (64 tiles per plot), so ask once and reuse it.'],
    demo: 'all_tiles = tiles()\nsay len(all_tiles), "tiles; first is", all_tiles[0]\nfor each t in tiles():\n    if t.x == 7 and t.y == 7:\n        say "found the corner"',
  },
  forecast: {
    rules: ['Free. A list of `{kind, start, end}` weather segments (`rain` or `frost`) that overlap the next n ticks. Empty means clear skies.', '`start` and `end` are absolute ticks, so compare them with `tick()`.'],
    demo: 'for each w in forecast(2000):\n    say w.kind, "from", w.start, "to", w.end',
    ticks: 10,
  },
  weather: {
    rules: ['Free. `"clear"`, `"rain"` or `"frost"` right now. Rain adds moisture to every tile, so skip `water` while it rains.', 'Frost stops carrots and pumpkins growing while it lasts, and kills one that is still at stage 0 when the frost starts. Wheat, clover, berries and apples are hardy and ignore it.'],
    demo: 'say weather()\nif weather() == "rain":\n    say "no need to water"\nelse:\n    say "watering is up to us"',
  },
  orders: {
    rules: ['Free. A list of open contracts, each `{id, crop, qty, reward, deadline}`. `crop` is a name; `deadline` is an absolute tick.', 'New contracts appear as time passes, only for crops you have researched, and expire at their deadline. Fulfil one with `deliver`.'],
    demo: 'wait 250\nfor each o in orders():\n    say "order", o.id, ":", o.qty, o.crop, "for", o.reward, "coins, due tick", o.deadline',
    ticks: 400,
  },
  stock: {
    rules: ['Free. A record of the barn\'s stock by item name, every item present. Only items already deposited count, not what bots carry.'],
    demo: 'say stock().carrot\nsay keys(stock())',
  },
  coins: {
    rules: ['Free. Your coin balance. Selling, delivering and selling plots add coins; buying, research and building spend them.'],
    demo: 'say coins()\nunlock wheat\nsay coins()',
    world: 'saver',
  },
  plot_cost: {
    rules: ['Free. The price of the next plot: 150 × n², where n is the number of plots you own. It is the same however many you buy at once, so budget for the rise.'],
    demo: 'say plot_cost()\nbuy_plot 1, 0\nsay plot_cost()',
  },
  bot_cost: {
    rules: ['Free. The price of the next bot: 80 × n², where n is the number of bots you own (80 for the second bot, 320 for the third).'],
    demo: 'if my_id() == 0:\n    say bot_cost()\n    buy_bot\n    say bot_cost()',
  },
  bots: {
    rules: ['Free. How many bots the farm has, including this one.'],
    demo: 'if my_id() == 0:\n    say bots()\n    buy_bot\n    say bots()',
  },
  unlocked: {
    rules: ['Free. `true` if the named research is unlocked. Crops, `hive`, `composter`, `satchel` and `silo` work. Carrot is always unlocked.'],
    demo: 'say unlocked(carrot)\nsay unlocked(wheat)\nsay unlocked(silo)',
    world: 'start',
    ticks: 10,
  },
  unlock_cost: {
    rules: ['Free. What the named research costs, even if you already own it. `silo` shows its price once silo rules are on.'],
    demo: 'say unlock_cost(wheat)\nsay unlock_cost(apple)',
  },
  price: {
    rules: ['Free. What the barn pays for one unit of an item. On a market day it is in hundredths of a coin (250 means 2.5 coins) and changes daily; on other days it is the base price in whole coins.', '`sell` pays `units × price ÷ 100`, using the same day\'s hundredths on market days, so compare prices before you hold produce back.'],
    demo: 'say "carrot:", price(carrot)\nsay "honey:", price(honey)\nsay "pumpkin:", price(pumpkin)',
  },
  goal: {
    rules: ['Free. The day\u2019s goal as a name: `wealth`, `festival`, `specialist`, `orders` or `inherited`. It is `wealth` when there is no brief, which includes Endless and older challenges.'],
    demo: 'say goal()',
  },
  quota: {
    rules: ['Free. On a festival day, how many units of the item are still to deposit. It is 0 for any other goal, for an item the festival does not ask for, and when there is no brief.'],
    demo: 'say quota(carrot)',
  },
  budget: {
    rules: ['Free. The challenge\u2019s tick budget, or 0 when there is none (Endless and older challenges).'],
    demo: 'say budget()',
  },
  twists: {
    rules: ['Free. The brief\u2019s twists as a list of names. The list is empty when there are none, and when there is no brief.'],
    demo: 'say len(twists())',
  },
  bot_cap: {
    rules: ['Free. The most bots this brief allows, or `none` when there is no limit.'],
    demo: 'say bot_cap()',
  },
  plot_cap: {
    rules: ['Free. The most plots this brief allows, or `none` when there is no limit.'],
    demo: 'say plot_cap()',
  },
  silo_cost: {
    rules: ['Free. The price of the next silo: 500 × n², where n counts the silos you will own (500, 2,000, 4,500…). It is 0 while silo rules are off.'],
    demo: 'say silo_cost()\nmove east\nbuild silo\nsay silo_cost()',
  },
  silos: {
    rules: ['Free. A list of `{x, y}` for every silo, in plot order then row order. Empty before you build one or while silo rules are off.'],
    demo: 'move east\nbuild silo\nsay silos()',
  },
  nearest_drop: {
    rules: ['Free. The `{x, y}` of the closest place this bot can drop off and sell: the barn or a silo, by distance. A tie goes to the barn.', 'It is computed from where the bot stands right now, so ask again after the bot moves.'],
    demo: 'move east\nmove east\nmove east\nbuild silo\nsay nearest_drop()    # the silo is closer\ngo_to nearest_drop()\ndeposit\nsay position()',
  },

  // ---- utilities ----
  go_to: {
    rules: ['Takes a position record like `barn` or `position()`, or `x, y`. Walks east or west first, then north or south, 2 ticks per tile.', 'Returns `true` on arrival, and `false` if a step is refused, for example by walking onto land you don\'t own. It stops where it is blocked.'],
    demo: 'say go_to(3, 2)\nsay position()\ngo_to barn\nsay position()\nsay "off the farm:", go_to(-5, 0)',
  },
  say: {
    rules: ['Writes one line to the console, with the bot and tick it came from. Values are joined by spaces; text in quotes can embed values with `{}` like `"coins: {coins()}"`.', 'It costs nothing and takes no time.'],
    demo: 'say "I have", coins(), "coins"\nsay "bot {my_id()} at {position()}"',
  },
  print: {
    rules: ['Exactly like `say`.'],
    demo: 'print "hello", my_id()',
  },
  len: {
    rules: ['Length of a list or text, or the number of keys in a record. Anything else is a runtime error.'],
    demo: 'say len([1, 2, 3])\nsay len("tendril")\nsay len({a: 1, b: 2})\nsay len(tiles())',
  },
  abs: { rules: ['Distance from zero. Whole numbers only.'], demo: 'say abs(-3)\nsay abs(3)' },
  min: { rules: ['Smallest of its arguments, or of one list. An empty list is a runtime error.'], demo: 'say min(2, 5)\nsay min([9, 4, 7])' },
  max: { rules: ['Largest of its arguments, or of one list. An empty list is a runtime error.'], demo: 'say max(2, 5)\nsay max([9, 4, 7])' },
  range: {
    rules: ['`range(n)` is 0 up to n minus one. `range(a, b)` runs from a to b minus one. The end is never included. An empty range is an empty list.'],
    demo: 'say range(4)\nsay range(2, 5)\nsay range(5, 2)\nfor each i in range(3):\n    say "round", i',
  },
  append: {
    rules: ['Adds a value to the end of a list, changing the list itself. It returns nothing, so write it as a command.', 'Lists are shared, not copied: if you pass the list to something else it sees the change.'],
    demo: 'xs = []\nappend xs, "a"\nappend xs, "b"\nsay xs',
  },
  pop: { rules: ['Removes and returns the last item. An empty list is a runtime error.'], demo: 'xs = [1, 2, 3]\nsay pop(xs)\nsay xs' },
  insert: { rules: ['`insert list, index, value` puts the value at that index and moves the rest along. Index 0 puts it first, `len(list)` puts it last.'], demo: 'xs = [1, 3]\ninsert xs, 1, 2\nsay xs' },
  remove: { rules: ['`remove list, index` takes out the item at that index and returns nothing. An index outside the list is a runtime error.'], demo: 'xs = [1, 2, 3]\nremove xs, 0\nsay xs' },
  contains: { rules: ['`true` if a list holds the value, a record has the key, or text contains the text. Same as the `in` operator.'], demo: 'say contains([1, 2, 3], 2)\nsay contains("tendril", "dri")\nsay 2 in [1, 2, 3]' },
  keys: { rules: ['A list of the keys of a record, in the order they were first written.'], demo: 'say keys({x: 1, y: 2})\nsay keys(load())' },
  sorted: { rules: ['A new list, smallest first. Works on all whole numbers or all text, not a mix. The original is left alone.'], demo: 'xs = [3, 1, 2]\nsay sorted(xs)\nsay xs' },
  reversed: { rules: ['A new list in the opposite order. The original is left alone.'], demo: 'say reversed([1, 2, 3])' },
  str: { rules: ['Turns any value into readable text, which is how you join a number to a sentence: `"coins: " + str(coins())`.'], demo: 'say "coins: " + str(coins())\nsay len(str(12345))' },
  int: { rules: ['Turns a text of digits into a whole number. Returns `none` for anything else, so test the result before using it.'], demo: 'say int("42") + 1\nsay int("forty-two")' },
  random: {
    rules: ['A number from 0 up to n minus one. It is seeded by the farm, so a replay gets the same numbers and the server can verify your run. n must be at least 1.', 'Each bot has its own sequence, so bots don\'t all roll the same number.'],
    demo: 'say random(10)\nsay random(10)\nsay random(1)    # always 0',
  },
  distance: { rules: ['Manhattan distance between two `{x, y}` records: steps east/west plus steps north/south. It is the number of moves a bot needs on open land.'], demo: 'say distance(barn, {x: 3, y: 2})\nsay distance(position(), barn)' },

  // ---- names ----
  north: { demo: 'move north' }, east: { demo: 'move east' }, south: { demo: 'move south' }, west: { demo: 'move east\nmove west' },
  carrot: { demo: 'plant carrot' }, wheat: { demo: 'say unlocked(wheat)' }, clover: { demo: 'say unlock_cost(clover)' },
  pumpkin: { demo: 'say price(pumpkin)' }, berry: { demo: 'say price(berry)' }, apple: { demo: 'say price(apple)' },
  honey: { demo: 'say stock().honey' }, hive: { demo: 'say unlock_cost(hive)' }, composter: { demo: 'say unlock_cost(composter)' },
  silo: { demo: 'say unlock_cost(silo)' }, satchel: { demo: 'say unlock_cost(satchel)' },
  barn: { demo: 'go_to barn\nsay distance(position(), barn)' },
  all: { demo: 'sell carrot, all' },
  shared: { demo: 'shared.ready = false\nif my_id() == 0:\n    shared.ready = true\nsay shared.ready' },
};

/** One-line uses for every keyword, shown in the reference and compiled by the tests. */
export const KEYWORD_DOCS: Record<string, string> = {
  if: 'if coins() > 100:\n    say "rich"',
  elif: 'x = 2\nif x == 1:\n    say "one"\nelif x == 2:\n    say "two"',
  else: 'if weather() == "rain":\n    say "wet"\nelse:\n    say "dry"',
  while: 'while not scan().ripe:\n    wait 10',
  repeat: 'repeat 3 times:\n    say "again"',
  forever: 'repeat forever:\n    wait 100',
  times: 'repeat 2 times:\n    say "hi"',
  for: 'for each tile in tiles():\n    pass',
  each: 'for each n in range(3):\n    say n',
  in: 'say 2 in [1, 2, 3]',
  from: 'for i from 0 to 4:\n    say i',
  to: 'for i from 1 to 3:\n    say i',
  step: 'for i from 0 to 10 step 5:\n    say i',
  define: 'define greet(name):\n    say "hi", name\ngreet("bot")',
  def: 'def twice(n):\n    return n * 2\nsay twice(4)',
  return: 'define double(n):\n    return n * 2\nsay double(4)',
  break: 'for each n in range(10):\n    if n == 3:\n        break\n    say n',
  continue: 'for each n in range(4):\n    if n == 1:\n        continue\n    say n',
  pass: 'if false:\n    pass',
  stop: 'say "once"\nstop\nsay "never printed"',
  and: 'say true and false',
  or: 'say true or false',
  not: 'say not false',
  is: 'say 3 is 3\nsay 3 is not 4',
  true: 'say true',
  false: 'say false',
  none: 'say none\nsay scan_at(99, 99) is none',
  set: 'set x to 1\nset x to x + 1\nsay x',
  tend: 'tend every tile:\n    when ripe: harvest\n    when empty: plant carrot',
  when: 'tend every tile:\n    when empty and dry: water\n    when ripe: harvest',
  every: 'tend every tile:\n    when empty: till',
  unless: 'tend every tile:\n    when empty: plant carrot unless tired, else wheat',
  region: 'tend region 0, 0 to 3, 3:\n    when empty: till',
  global: 'count = 0\ndefine bump():\n    global count\n    count = count + 1\nbump()\nsay count',
};

# L2: silo commands in Sprout

- `build silo` works through the existing `build` action (building 3, rules v5). Its error text now names the silo.
- `silo_cost()`: next silo price; 0 until silos are switched on (SILO_EPOCH or the Endless switch).
- `silos()`: silo positions in plot order, then row order (same order as `tiles()`); empty before rules v5.
- `nearest_drop()`: `{x, y}` of the barn or nearest silo by Manhattan distance (the `distance` builtin's metric). Ties go to the barn, then the earlier silo. With no silos it returns the barn.
- `silo` is a constant name in the API table, like `hive` and `composter`.
- Lesson 15, "Shorter trips", buys four plots in its starter (lesson setups cannot pre-place plots or bots), unlocks silo, builds one, and deposits at `nearest_drop()`.
- `sell_plot(x, y)` (op 16, farm-level): returns the coins paid, or 0 when the sale is refused. It is logged with bot -1 like `buy_plot`.
- Lesson 15 is not gated on silo research; it follows lesson 14 like the other lessons.

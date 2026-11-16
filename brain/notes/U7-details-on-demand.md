# U7: details on the island (tooltip, lenses, contract cards, stock chips)

Replaces the Inspectors panel (`inspectors.ts`, deleted) with `island-hud.ts` plus four modules.

Files: `tile-info.ts` (pure text/placement logic, tested), `tooltip.ts`, `lens.ts`, `order-cards.ts`, `stock-chips.ts`, `island-hud.ts/.css`. Small edits: `farm-overlay.ts` (growth lens), `farm-hud.ts` (Lens type + option), `farm-view.ts` (growth in lens lists, `marketMultipliers()`), `stage.ts` (Inspectors and Minimap menu entries removed), `stage.css` (minimap shown only on big farms), `main.ts` (mount line).

Decisions
- Hover: one ground lookup after the pointer rests 150 ms, no per-move scene work. Click or arrow key pins; pinned card adds `scan_at(x, y).moisture` style expressions. Esc or the X unpins.
- "Which bot is heading there": the snapshot has no destination, so the tooltip lists bots on the tile or within two tiles with their current op.
- Time to ripe is an upper bound (stages left x stage length); growth speed depends on soil and the snapshot has no sub-stage progress.
- Lens keys: 1 Soil (nitrogen), 2 Water (moisture), 3 Growth (new lens), 4 Value (price, only with a market). Same key again returns to natural. Fatigue stays in the lens select and the tooltip. The select (`#soil-overlay`) stays in step.
- Contract card deadline: position on the day when the scenario has a tick limit, else on the contract's own lifetime.
- Stock chips mount into `#game-hud`; chip nodes are reused, not rebuilt. Crew list, weather (forecast) and next plot/bot cost live beside them, so nothing the old panel showed is lost. Market prices show in each chip's hover title on market days.
- Minimap: corner widget only when the farm has more than 16 plots (`body.farm-large`).
- Left alone (shared files): the now-empty `#deck-farm` and `#forecast` containers in index.html.

Verification (cloud container, software GL)
- client unit tests 74 pass (new tile-info.test.ts, 6 tests); typecheck and build pass.
- Real browser: tooltip after 150 ms, click pins with Sprout expressions, keys 2/3/3 cycle lens and legend, order cards and stock chips appear while a farm runs, no page errors.
- Full Playwright suite: 36 failed, 37 passed, 2 skipped. The same 36 fail on the branch head without this change (verified: rating, view and integration specs run there; the rest match U1's e2e-failures list). Layout-moved specs are for U11.
- Perf meter (?perf=1&stress=1, headless software GL, so fps is meaningless): draw calls and triangles are scene-driven and unchanged by this task (base 288-328 calls, 178-184k tris; with U7 174 calls, 179k tris at sampling, varying with load stage); update size 202-217 KB vs 175-206 KB (sampling noise, protocol untouched). Hover sweep adds no draw calls.

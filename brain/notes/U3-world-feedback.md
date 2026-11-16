# U3: feedback in the world

Files changed
- New: `client/src/bot-colours.ts`, `feedback-core.ts` (pure planning), `world-feedback.ts` + `world-feedback.css` (DOM mount), `world-feedback.test.ts`.
- Edited: `farm-drones.ts` (palette, ground rings, plant and harvest pop), `farm-fx.ts` (`pop`), `farm-view.ts` (`project`, `botPosition`, bot hit test in `tap`, `tendril:bot` event; the drawing loop is untouched), `editor.ts` (`setSelectedBot`, `onBotMarkClick`, `revealLine` focus option, line tint from the bot colour), `main.ts` (one import, one mount), `farm-drones.test.ts`, `package.json` test list.

Decisions
- Palette: the Okabe-Ito colour-blind-safe eight, with blue and black lifted for the dark HUD. `BOT_COLORS` (debugger, console) now reads the same palette, so a bot has one colour everywhere. Bot ids repeat the palette after eight.
- Bot marker: one instanced flat ring on the ground under every drone (one draw call for the whole crew, 256 max). The halo and trail were already tinted.
- Floating numbers are DOM elements, pooled (30), reprojected each frame by a rAF that runs only while something is on screen. Harvest events carry no item, so the text comes from the bot's carried items between the last two snapshots. Sale coins use base prices (market price is not on the screen side); order coins use the reward from the previous snapshot.
- Merging: up to 4 events in one batch show one number each; more than 4 merge per item; more than 16 merge into one number per kind.
- Bubbles: error (BotDebug status), blocked (stopped at a breakpoint), waiting (current op is wait). At most 16, most urgent first. Real `<button>`s, so Tab reaches them. Click selects the bot, jumps the editor and shows the message for 6 s (Esc closes it).
- Pop: a short additive ring on the tile (220 ms, one instanced draw call) at plant and harvest. The crop meshes themselves are not scaled, because that would mean editing the batch rebuild in `farm-world.ts` which P4 is changing.
- Coin chip pulse: CSS class on the `#chip-coins` chip (220 ms). Everything is off under reduced motion; floats then only fade.
- Clicking a drone selects it (reach grows when zoomed out); clicking a tile clears the bot selection.

Open: "blocked" has no engine signal beyond breakpoints, so a bot stuck in a failing loop only shows as waiting or running.

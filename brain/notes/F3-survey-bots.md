# F3 land for sale and bots (client only, 2026-11-26)

Branch `claude/project-thread-8s7rt7`, from F2 (`claude/project-thread-i65ltf`, PR #139). No sim, rules or replay change.

## Files changed
- `packages/client/src/farm-scenery.ts`: buyable land. The glowing frontier bars are now a string line (thin bars at stake height), survey stakes and carrot flags (instanced, capped at 160), and a price board (post plus canvas text "N coins", "Ask the farmer" if no price) on the outer edge nearest the camera (`faceCamera`). `update(bounds, own, price)` takes the next plot price; `setDistance` is gone.
- `packages/client/src/farm-view.ts`: passes `plotPrice(own.count)` (sim's own price function, read-only) and calls `faceCamera` each frame.
- `packages/client/src/farm-drones.ts`: each bot has a colour band at its hull waist in its palette colour (brighter at night, driven by the same glow value as the lamp halo). The step trail is capped at 2.5 tiles and dimmed (its additive vine look stays).

## Checks
- `pnpm typecheck` clean; client `pnpm test` 172 pass, 0 fail (+ 6 pass in the drone/island tests); eslint clean on the three files.
- Real browser (Chromium, swiftshader, Vite build served locally): 1 plot, 1 bot, screenshots in `/mnt/project-files/workbench/F3/`: `night-desktop.png`, `zoom-day-desktop.png`, `bot-night-zoom.png`, `phone-day.png`. The board reads "150 coins" (matches the HUD's Plot 150).

## Decisions
- The board sits on the outer edge nearest the camera, not a fixed side, so it stays readable from any orbit.
- The price comes from the client via `plotPrice`, not a new snapshot field, so no sim or protocol change.
- Trail length is capped rather than removed; the existing ribbon code is reused.

## Not done / for a person
- Neighbour islands (F4) not built, as approved. Multi-plot and day/dawn/golden shots not captured yet.

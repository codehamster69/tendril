# F2 island body (client only, 2026-11-26)

Branch `claude/project-thread-i65ltf`, from F1 (PR #136). No sim, rules or replay change; golden hashes untouched.

## Files changed
- `packages/client/src/farm-island.ts` (new, pure geometry, no WebGL needed): `buildField` (owned tiles + 1.5 tile rim, chamfer distance, blur, craggy noise, grid at most ~110 cells a side), `buildBody` (top and underside share one contour, outside vertices snapped onto it), `buildRoots` (tapered bark tubes with rootlets), `buildMoss`, `rimBlades`, `rimProps`, `wallStones`, `cloudPuffs`, `rectOwnership`.
- `farm-scenery.ts`: `FarmIsland` rebuilt on the above. Body shader (grass lip, banded earth/clay/stone by depth scaled to the island depth, moss), instanced wall, blades, props (existing GLB models via the same lookup as the world), cloud sea. `update(bounds, ownership?)`, `refreshModels()` when GLBs arrive. Frontier line unchanged (F3 replaces it).
- `farm-wear.ts` (new): `Wear` counts bot steps onto tiles (jumps over 2 tiles and scrubs ignored); thin at 2, dirt at 6.
- `farm-world.ts`: `ownership()`, `wear`; worn untilled tiles draw `tile_path` in a darker warm tint with fewer or no blades; map zoom colours follow.
- `farm-view.ts`: passes the model lookup and ownership, feeds bot positions to wear, reset on scrub, `refreshModels` on asset change.
- `farm-island.test.ts` (new, in the `test` script): 13 tests (field shape, determinism, caps, props stay on the rim and survive growth, wall, wear).

## Checks
- `pnpm lint` clean; client `typecheck` clean; client `test`: 172 pass, 0 fail; `pnpm build` ok.
- e2e (Playwright, Chromium, swiftshader, CI=1): view, farm-hud, instruments, day-dial, app, integration, farm-recovers, farm-rests: 38 passed. `integration` "stopping inside a tick" failed twice under load in the full run (breakpoint timing, the known flaky kind) and passes alone (13 s).
- Real browser screenshots in `/mnt/project-files/workbench/F2/`: noon, evening, night, low side angle, desktop 1280x800 and phone 390x844, 1 plot (`*-game`, `*-side`) and 16 plots (`big-*`).
- Cost, from `renderInfo` at Close zoom: 1 plot 50 calls / 40k triangles; 16 plots 91 / 256k (incl. F1 ground); 100 plots (stress full) 255 / 224k. Island body 2k / 20k / 42k triangles; the island adds about 10 draw calls and rebuilds only when plots change.

## Decisions
- No world seed exists in the snapshot, so placement uses fixed world-space hashes. A bigger farm keeps rim props where they still fit.
- The 1.5 tile rim is narrow: props start 0.8 tiles from the owned edge and the wall sits on the edge itself.
- Wear is session-only and capped at 20,000 tiles.

## Not done / for a person
- Neighbour islands (F4) not built, as approved. The faint tile seams on meadow come from F1's slab and are untouched here.

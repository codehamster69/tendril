# Task H: whole-game chrome

Files: `packages/client/src/style.css`, `progression.css`, `reference.css`, `editor.ts` (theme colours only), `room.html`, `replay.html` styles. `index.html` needed no change (every id/class/ARIA hook kept).

## Decisions
- Evolved the teal/wheat palette: lantern gold `--lantern #FFC65A` (`--wheat` kept as alias so farm-hud.css and farm-market.css still resolve), tendril green `--tendril #4FD1B0` for eyebrows/meters/running state, deeper `--ink/--deep`, glass tokens (`--glass`, `--glass-strong`), blur on top bar, panels, status bar, toasts, update/rating cards.
- Primary button = lantern gold gradient; running = tendril green; focus ring lantern. Tabular numerals globally. System stacks only.
- `#farm-stage` background is a dark teal gradient (canvas draws the sky). `#stage-tools` is pointer-transparent except its children (canvas still pans under it) with 150 px right padding. `.farm-caption` is now bottom-left (note + plot/bot chip, stacked), leaving top-left (HUD) and bottom-right (minimap) free.
- Contrast: faint text `#5F8784` raised to `--faint #7FA9A5`; mist-2/sage checked against deep teal (>= 4.5:1).
- Editor theme: lantern keywords, mint strings, brighter line numbers (AA).
- Responsive: <=1100 px stacks panels with auto height (fixes the clipped/overlapping deck+editor on phones), grid column `minmax(0,1fr)` stops horizontal overflow; <=640 px: top bar reflows (logo+links, readouts card, scrollable mode tabs), static top bar.
- room.html / replay.html: same palette, glass bars, gold serif wordmark, rounded tiles, gold range accent.

## Checks
- `pnpm exec eslint packages/client/src/editor.ts`: clean. `pnpm --filter @tendril/client typecheck`: clean.
- e2e (temporary config with executablePath `/opt/pw-browsers/chromium`, removed afterwards): app, firstrun, instruments, view, account, arena, replay, room: all pass (incl. mobile no-horizontal-scroll). `rating.spec.ts:90` fails: after `page.reload()` `#btn-run-end` stays disabled (logic/boot, not styling; unverified whether pre-existing). `app.spec.ts:52` failed once, passed on rerun (timing flake).
- Screenshots: `brain/notes/farm-redesign-shots/{before,after}-{wide,mid,phone}.png` (DPR 2; wide 1400x900, mid 900x800, phone 390x844 full page).

## Open issues
- Overlay collisions owned by others: at 900 px the market card (task F) covers the mode note, and the tile-inspector hint (inside `#stage-tools`) can run under the minimap at wide widths. Suggest the HUD cap `#tile-inspector` width or place it above the note.
- Stage sizing at <=1100 px is `clamp(300px,56vh,520px)`; integration may want to retune with the final HUD.

## Requests
- Playwright config has no `executablePath` hook for this container (STATUS known item); a `PW_CHROMIUM` env option would help.

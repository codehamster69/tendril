# W5 site restyle

Scope: `packages/site` only. No client, sim or rules changes.

## Files changed
- `packages/site/src/styles/global.css`: workbench palette (soil base, straw text, carrot accent), dark by default with a light variant; Barlow Condensed for headings and labels, Atkinson body, JetBrains Mono. `.btn` is text with a carrot border that draws in on hover and focus (scale .94 to 1, 150 ms, opacity and transform). Primary is an underlined text action. Links are straw with a carrot underline.
- `packages/site/src/layouts/Base.astro`: font link, header, menu (border-only panel), current page marked by a carrot underline. Theme colour updated.
- `packages/site/src/pages/index.astro`: hero is a replay clip with one sentence. Three-card row and four-step row removed. Sections are one reading column; code samples are `lang/examples/starter.sprout` and `lang/examples/compost.sprout`.
- `packages/site/public/hero-replay.webm`: `handoff/sample-replay-clip.webm` cropped to 1280x640 to remove its footer bar, which showed "Daily #-17" and "localhost:5173".
- `packages/site/src/pages/leaderboard.astro`, `components/Portfolio.astro`, `layouts/Docs.astro`: emphasis fills replaced with underlines or borders. Data meters keep their fills.
- `packages/site/src/components/FarmDemo.astro`: deleted, no longer used.

## Decisions
- Dark default follows the game's palette. The light variant uses a straw base; its light-only values (`--leaf`, `--wheat`, `--line` and similar) were chosen for contrast and are not from the workbench tokens.
- Crop table kept: it is a table, not one of the removed rows.
- OG social cards still use the Bricolage font in `packages/site/og-fonts`. Swapping that needs a Barlow Condensed TTF; left for a follow-up.

## Checks
- `pnpm --filter @tendril/site build`: 25 pages built, exit 0.
- `pnpm --filter @tendril/site typecheck` (astro check): 0 errors, 0 warnings, 1 hint.
- Playwright, Chromium, before and after (baseline built from the untouched commit): home, docs, download, leaderboard, season-1 at 1280x800 and 390x844 (deviceScaleFactor 2). No page errors, no horizontal overflow. Screenshots in `/mnt/project-files/workbench/W5/`.
- Hover check on `/download/`: the carrot border reaches opacity 1 and scale 1 on hover.
- Not checked: API-backed parts (today's farm, leaderboard rows) render empty in the static preview, as before.

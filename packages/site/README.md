# @tendril/site

The website: landing page, downloads, docs, leaderboard. Astro, fully static, deployed with the rest of the
repo on Vercel (`pnpm build:web` puts the web game under `/play/` and the API under `/api/`).

- `pnpm dev:site` (root) or `pnpm --filter @tendril/site dev` / `build` / `typecheck`.
- Game facts are imported, never copied: crop/research tables from `@tendril/sim`, the Sprout reference from
  `@tendril/lang` (`API`, `KEYWORDS`), example programs from `packages/lang/examples/*.sprout`.
- `src/sprout-lang.ts` is the Sprout syntax highlighter, built from the language's keyword and built-in lists.
- The home page farm runs the real rules and interpreter on `src/data/grower.sprout`.
- `scripts/copy-renders.mjs` copies `assets/thumbs` then `assets/renders` into `public/art/` at build time; `src/data/art.ts`
  returns null for missing images so pages degrade without them.
- Installers: the browser asks GitHub for the latest release of `PUBLIC_RELEASES_REPO` (a public `owner/name`,
  set as a build env var) and matches assets by name (`src/data/downloads.ts`). The visitor's OS (and Mac CPU where
  the browser reports it) picks the main download button. With no release, buttons say "Coming soon" and
  "Play in browser" leads. Publishing a release needs no redeploy.
- `/leaderboard/` reads `/api/leaderboard` and `/api/daily/leaderboard` in the browser and shows an empty or
  unreachable state when there is no data.

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
- Installers: fill in `src/data/downloads.ts` (`url`, optional `size`/`sha256`) when a release exists. Until then,
  buttons say "Coming soon" and the main call to action is "Play in browser".
- `/leaderboard/` reads `/api/leaderboard` and `/api/daily/leaderboard` in the browser and shows an empty or
  unreachable state when there is no data.

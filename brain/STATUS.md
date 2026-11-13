# Status / takeover

Updated 2026-11-13 (final review before 0.2.0). Repo: codehamster69/tendril, `main` deploys the site, web game and API to https://tendril.hokora.xyz.

## Current phase
Everything in the viral launch plan is built and merged: A1-A2, B1-B7, C1-C6, D1-D3, E1 (rules v4 shared daily market, switches on by date at MARKET_EPOCH 2026-12-08), E2 (room race), F1-F5. D4 (0.2.0) is this release. Season 0 target: 1 Dec 2026.

## Verified in the final review (2026-11-13, cloud container)
- Gate: lint, typecheck, unit (sim 96, server 551, lang 44+1 skipped, client 13), production build, browser E2E 61 passed / 2 skipped, Electron smoke under xvfb (sandboxed app:// entry, real Sprout worker, 39 GLBs, navigation blocked).
- Real client build against the real local server (`pnpm dev:server`, dev auth): Endless ranked farm auto-syncs and appears verified on the leaderboard; daily and season runs submit and verify (with Brevity); Challenge a friend creates a duel; Join duel accepts a pasted link and rejects junk; duel panel compares, auto-follows and links the ghost race; room page ranks both farms; replay page and Export clip render; signed-out daily keeps the run local and offers sign in; a mocked market day (server and browser clock at 2026-12-10) plays and verifies under rules v4 with the market panel.
- Live site: 48 pages crawled, no broken links; /api/cron/housekeeping refuses calls without CRON_SECRET; Health watch run passes; daily post script works (prints only while DISCORD_WEBHOOK_URL is unset).
- F5: the Dependabot job holds major bumps for a person (label needs-human), as designed.

## Known items
- CI Playwright on GitHub runners is timing-flaky on five heavy specs (worker boot, live clock catch-up, golden path, clip export, 16-replay room); being hardened without retries in its own thread.
- Legacy grace (24 h late daily submits, 24 h replay delay) ends by itself: `POST /api/daily/submit` is only called by desktop 0.1.x, so each use stamps `arena_meta.legacy_submit_last`. After 31 Dec 2026 with 30 quiet days, or on 1 Mar 2027 regardless, `refreshLegacyGrace` (daily, and in the cron report as `legacyGrace`) stores `legacy_grace_ended` for good and logs a warning. Nothing to do by hand; to end it early, insert that key into `arena_meta`.
- The humans vs models board needs real model runs (API keys). The Hall of Fame counts models too.
- Discord: the daily post needs a DISCORD_WEBHOOK_URL repository secret to actually post.
- Running Playwright in these cloud containers needs the pre-installed Chromium (`/opt/pw-browsers/chromium-1243`) passed as executablePath; Electron must run as a non-root user.

## Release
Pushing a `v*` tag runs `release.yml`, which checks the tag matches `packages/client/package.json` and publishes installers. The monthly release workflow bumps and tags by itself when the client changed.

## Gate
Lint, typecheck, all unit tests, golden replay tests, production build, Playwright E2E without retries, Electron smoke. A pass obtained only on retry does not count.

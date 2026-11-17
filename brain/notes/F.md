# Task F: farm market

Files: `packages/client/src/farm-market.ts`, `farm-market.css` (imported from farm-market.ts), `farm-market.test.ts`, plus one extra own file `farm-market-format.ts` (pure formatting; needed because the client test runner is `node --test` with strip-types, which cannot import CSS or three-dependent modules).

Checks (real output): `pnpm exec eslint src/farm-market.ts src/farm-market-format.ts src/farm-market.test.ts` clean; `node --experimental-strip-types --test src/farm-market.test.ts`: tests 9, pass 9, fail 0; `tsc --noEmit` shows no errors in farm-market files.

Decisions
- Rules text and numbers come from sim `describeMarket` (rows, price, change, trend, share, "Market opens in N days"); format file only maps them to gauge position, arrows, countdown. No rules maths duplicated. describeMarket needs a date, so open state asks with MARKET_EPOCH and the soon state with a date `opensInDays` before it.
- Card is bottom-left of the stage (HUD tools top-left, minimap bottom-right), collapsible button with aria-expanded, collapsed by default at <= 640px. Arrow compares against base (no yesterday multipliers exist in ChallengeInfo.market). Shares shown per row when present. Countdown to next UTC midnight, updated once a second in `update`.
- `multipliers` is 0.5..2 per item id (index 0 = 1) or null (base prices or market not open yet): lens should disable on null.
- Stall: wood counter, teal awning, canvas-texture sign showing best crop and multiplier; `setStallAt(x, z)` creates it lazily; dispose frees geometry, materials, texture.
- Popups: pooled DOM in `.farm-pop-layer`, max 8 live, 90 ms gap, skipped off screen; positioned against `stage.clientWidth/Height`. Reduced motion uses a fade instead of rising.

Requests
- Integration: call `market.setPopupsHidden(lod === 2)` each frame (added method, spec says hidden at Map LOD but popup() has no LOD input). Stage element must be `position: relative`.
- Integration: pass `opensInDays` from `daysUntilMarket(date)` on pre-epoch dailies, and the market from `ChallengeInfo.market`.
- `packages/client/package.json` `test` script lists test files explicitly: add `src/farm-market.test.ts`.
- Item colours come from `CROP_COLORS` in fallback-models.ts (task G may change them; card reads them at render time, so call `setMarket` again if they change).

Open issues: no browser screenshot of the card or stall done (not run in a browser here).

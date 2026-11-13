# R3b: Portfolio server support

## Changed files
- `packages/server/src/players.ts`: `pinned` and `days` on the player page; `setPinned`. `packages/server/src/app.ts`: `PUT /players/me/pinned`.
- `packages/server/test/portfolio-pins.test.ts` (3 tests). `packages/site/src/scripts/portfolio.ts`: reads `days` for the garden, shows pin rank. `brain/CONTRACTS.md`: "Portfolio additions".

## Decisions
- No migration: pins are JSON in `arena_meta` (`pins:<userId>`). Not cascaded on user delete (orphan row, harmless). Validation repeats at read, so hidden or reopened entries vanish from `pinned`.
- Public = own + source_public + verified + challenge settled (incl. daily grace) + not moderation-hidden; same bar as `/entries/:id/source`. Owner sees the same filtered list.
- Rate limit reuses the 'follow' bucket (200/day); a new AttemptKind would need a type/limit change. Say if you want its own.
- `days` is 140 days (the garden is 20 weeks), plain date strings. Podium/rated levels still come from rating history (capped at 400 rows). Duel entries are excluded.
- portfolio.ts: garden bumps `days` to level 1; cap line hidden when `days` is present; `PinRef` gains rank/players, shown as "3rd of 41" in the pin header.

## Verification
lint clean; `pnpm typecheck` 0 errors (one pre-existing hint); server vitest 22 files / 597 passed; site build ok. Not exercised in a browser against the real server.

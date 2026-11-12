# E1b: market engine, rules v4 (2026-11-12)

Spec: `docs/SIM_SPEC.md` section 4 (marked implemented). Reference sim: `brain/notes/E1a-market-sim.mjs`; the sim tests compare the TypeScript port with it on 400 random days.

## Changed
- sim: `rules.ts` (RULES_VERSION 4, BASE_RULES_VERSION 3, SUPPORTED), `types.ts` (`Setup.prices`, `World.prices`), `world.ts` (`price`, floor sell and net worth, price validation), `hash.ts` (prices in hash and serialize, versions 3/4 by data), `arena.ts` (market helpers, `MARKET_EPOCH`, `challengeSetup(..., market)`, `sold` in `replayWithPar`, `replayStats`), `index.ts`.
- server: migration `007_market.sql` (`challenges.market`, `entries.sold`), `market.ts` (table computed lazily from stored rows and the day before's best entries), `arena.ts` (row version per day, table stored in the same INSERT as the row, `ensureMarket` CAS for a row without one, `marketOf`, `GET /challenges/:id` and replay carry `market`, duel `from`, submit compares with the row's version and says "This day uses rules version 4. Update Tendril."), `game.ts` (farms stay v3; `/daily` reports the day's version), `app.ts` (legacy submit passes the client's version), `validation.ts` (duel `from`).
- lang: `price(item)` (centicoins on a market world), verify function takes and checks the table, CLI plays market days and refuses unknown versions.
- client: `requireKnownRules` ("This day needs a newer Tendril. Update the app."), world builders pass the day's table, duel sends `from`, replay viewer uses the table. No price display (E1c).
- `scripts/daily-post.mjs`: the post that goes out on 8 Dec announces the market.

## Decisions
- Farms, seasons, non-copied duels stay rules v3. Row version, not the constant, decides. This keeps 0.1.x working everywhere except on market days.
- `price(item)` keeps its old answer (whole coins) on v3 worlds so old programs still verify; on a market world it is centicoins as specified. E1c docs must say so.
- The table is inserted together with the row (one atomic INSERT OR IGNORE), so the table and the par measured under it cannot disagree; `UPDATE ... WHERE market IS NULL` only covers a row that has none.
- Arrays are length 8, index = item id (index 0 = 0), same as `world.prices`. `entries.sold` stores 7 integers (items 1..7).

## Verification
sim 93 tests, lang 44, server 550 (see blockers), client unit 6, root lint and typecheck clean, build, E2E arena/duel/account (new tests: unknown rules refused, market day submitted as v4).

## Blockers / known failures on main
- `arena-attack.test.ts` F6 "the same log and program twice is a 409 and the verify function runs once" fails on main too (verify runs twice).
- E2E `account.spec.ts` "a farm far behind catches up with chunks sent back to back" times out here on main too (software GL).

## For E1c
`GET /challenges/:id` -> `market.prices` (centicoins, index = item id), `multipliers` (permille), `shares` (yesterday). `daysUntilMarket(date)`, `marketActive(date)`, `price(world, item)` from `@tendril/sim`.

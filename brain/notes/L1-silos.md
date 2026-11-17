# L1: silo rules and sellPlot (rules v5), 2026-11-17

Update 2026-11-17: Rohan moved SILO_EPOCH to 2026-11-17 (live now). v5 dailies carry the market table only from MARKET_EPOCH; `rulesHaveMarket` became `marketAllowed` + `marketFits`; plain duels are v5.

Brief: /mnt/project-files/redesign/briefs/L1-silo-rules.md plus `sell_plot` (Rohan approved both, same epoch). Spec: docs/SIM_SPEC.md section "Rules version 5".

## Changed files
- packages/sim: rules.ts (RULES_VERSION 5, MARKET_RULES_VERSION 4, SILO, SILO_BIT, SILO_BASE, SILO_RESEARCH, siloPrice, op 16 sellPlot), types.ts (World/Setup `siloTick`, snapshot `siloCost`/`plotRefund`), world.ts (silo build/clear/store, sellPlot, silosActive, siloCount, siloCost, plotRefund, canSellPlot), tiles.ts (removePlot), hash.ts (v5 serialize/deserialize, siloTick not hashed), snapshot.ts, arena.ts (SILO_EPOCH, siloActive, seasonRulesVersion, dailyRulesVersion 5, rulesHaveMarket, endlessSiloTick, withEndlessSilos, challengeSetup 5th arg), index.ts; test/silo.test.ts (new), test/market.test.ts (version numbers); scripts/silo-tuning.ts (new).
- packages/server: arena.ts (season version by date, market by rulesHaveMarket, replay passes version), game.ts (Endless stamp/strip, replay returns siloTick), validation.ts (op 16, build 3, unlock 9); tests in server/market/attack.
- packages/lang: verify.ts, arena-cli.ts (pass rulesVersion, rulesHaveMarket).
- packages/client (minimal, rules plumbing only): chunks.ts and real-sim.ts (Endless stamp), sim-worker.ts + sim-protocol.ts (`Scenario.siloTick`), challenge-setup.ts, arena.ts (known-rules check), replay-view.ts, view-codec.ts (resend plots after a sale; silo scalars), catalogue.ts (silo card, it threw on an unknown research name).

## Decisions
- **Switch is data (`World.siloTick`), not a date in the sim.** Same pattern as the v4 price table. Challenges get 0 from `challengeSetup(..., rulesVersion)`.
- **Endless farms do not change rules_version or checkpoint format.** The switch tick is derived from the farm's start time on both sides and never stored, and it is not hashed. Reason: bumping the stored version or hash would break every desktop build that is out there the moment the server deploys. Old builds cannot emit the new ops, so they agree with the new rules forever.
- **New ops fail with 0, never throw, on worlds without silos.** Brief: "before it, building a silo fails with result 0". A new client can send them on old days safely.
- **Delivery stays barn-only.** Orders are the barn's contracts; keeps order logic and UI unchanged.
- **Clearing a silo refunds half the newest silo price; spent drops by the full price.** Otherwise build/clear would raise net worth. Same rule for sellPlot. Silos lost with a sold plot leave `spent` with no coins back. Every loop loses (tests).
- **Fresh duels after the epoch stay v3**; duels from a v5 daily are v5. Seasons starting on or after 15 Dec are v5 with no market.
- **Tuning: SILO_BASE 500 (brief said 300 as a start), research 1200.** First silo on 9 plots pays back silo plus research in ~1800 ticks (aim was ~2000). 300/800 paid back in ~1150.

## Tuning table (`node --experimental-strip-types packages/sim/scripts/silo-tuning.ts`)
| plots | bots | silos | silo cost | coins/1000 | gain vs 0 | payback ticks (silos + research) |
|---|---|---|---|---|---|---|
| 4 | 2 | 0 | 0 | 1530 |  |  |
| 4 | 2 | 1 | 500 | 1962 | 432 | 3935 |
| 4 | 2 | 2 | 2500 | 2061 | 531 | 6968 |
| 4 | 2 | 4 | 15000 | 2169 | 639 | 25352 |
| 9 | 4 | 0 | 0 | 2538 |  |  |
| 9 | 4 | 1 | 500 | 3492 | 954 | 1782 |
| 9 | 4 | 2 | 2500 | 3852 | 1314 | 2816 |
| 9 | 4 | 4 | 15000 | 4230 | 1692 | 9574 |
| 9 | 4 | 9 (all) | 142500 | 4509 | 1971 | 72907 |
| 16 | 8 | 0 | 0 | 4266 |  |  |
| 16 | 8 | 1 | 500 | 6183 | 1917 | 887 |
| 16 | 8 | 2 | 2500 | 6912 | 2646 | 1398 |
| 16 | 8 | 4 | 15000 | 7632 | 3366 | 4813 |
| 16 | 8 | 16 (all) | 748000 | 8775 | 4509 | 166157 |
| 36 | 18 | 0 | 0 | 7488 |  |  |
| 36 | 18 | 1 | 500 | 11664 | 4176 | 407 |
| 36 | 18 | 2 | 2500 | 13140 | 5652 | 655 |
| 36 | 18 | 4 | 15000 | 15237 | 7749 | 2091 |
| 36 | 18 | 36 (all) | 8103000 | 19152 | 11664 | 694805 |

Square farms, barn in a corner, one wheat program for all, bots = plots / 2. The simple program sells wherever it unloads.

## For L2 (Sprout) and L3 (client)
- Sprout: `build silo` works through BUILDINGS (index 3); the error text "Build a hive or composter." needs the silo. Add `sell_plot px, py` (op 16, farm-level, result = coins), `silo_cost()`, `nearest_drop`. `research "silo"` works by name.
- Client: the catalogue now shows a silo card (picture prop_silo) even before 15 Dec, when buying it results 0. Hide or label it before the epoch. Snapshot carries `siloCost` and `plotRefund` on v5 worlds. Model `assets/export/prop_silo.glb` exists.

## Verification
sim 112 tests, server 618, lang 47, client unit 128, typecheck, lint, build: all pass. E2E not run here (CI runs it).
